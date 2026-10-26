"""Dependency-light regressions for real-training diagnostics and provider pinning.

These tests use controlled stand-ins for CUDA/model work.  They verify control
contracts only; they are not evidence of model execution, training, or quality.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

from resource_limits import UploadRejected
from training_codes import qwen_package_version
from training_job import rank_error_type


def load_training_service(state):
    """Load an isolated service instance without touching the repository state."""
    name = "_training_service_test_" + uuid.uuid4().hex
    path = Path(__file__).with_name("training_service.py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    with patch.dict(os.environ, {"QTTS_STATE": str(state), "QTTS_ROOT": str(path.parents[1]), "QTTS_MOCK": "0"}):
        spec.loader.exec_module(module)
    return module


class ProviderAndFailureReceiptTests(unittest.TestCase):
    def test_hf_distribution_is_the_primary_provider_version(self):
        calls = []
        def version(name):
            calls.append(name)
            return "0.1.1.post1" if name == "qwen-tts-hf" else None
        with patch("qwen_compat.installed_version", side_effect=version):
            self.assertEqual(qwen_package_version(), "0.1.1.post1")
        self.assertEqual(calls, ["qwen-tts-hf"])

    def test_legacy_provider_fallback_and_missing_metadata_are_explicit(self):
        with patch("qwen_compat.installed_version", side_effect=lambda name: "legacy-version" if name == "qwen-tts" else None):
            self.assertEqual(qwen_package_version(), "legacy-version")
        with patch("qwen_compat.installed_version", return_value=None):
            with self.assertRaises(UploadRejected) as caught:
                qwen_package_version()
        self.assertEqual(caught.exception.code, 503)
        self.assertIn("no encoding executed", str(caught.exception))

    def test_rank_failure_receipt_exposes_only_a_safe_exception_type(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rank0.log"
            path.write_text("private traceback text\n" + json.dumps({"status": "failed", "error_type": "PackageNotFoundError"}) + "\n", encoding="utf-8")
            self.assertEqual(rank_error_type(path), "PackageNotFoundError")
            path.write_text(json.dumps({"status": "failed", "error_type": "unsafe path /secret"}) + "\n", encoding="utf-8")
            self.assertIsNone(rank_error_type(path))

    def test_blank_exception_and_process_receipt_remain_diagnosable(self):
        with tempfile.TemporaryDirectory() as directory:
            service = load_training_service(Path(directory))
            self.assertIn("RuntimeError", service._error_text(RuntimeError()))
            reason = service._receipt_reason({"reason": "operation failed", "error_type": "PackageNotFoundError", "process_returncode": 2}, "fallback")
            self.assertIn("type=PackageNotFoundError", reason)
            self.assertIn("exit=2", reason)
            ranked = service._receipt_reason({"error_types": {"0": "RuntimeError", "1": "ValueError"}}, "rank failure")
            self.assertIn("0=RuntimeError", ranked)
            self.assertIn("1=ValueError", ranked)


class PreflightContractTests(unittest.TestCase):
    def test_deep_preflight_reports_real_substeps_and_hf_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            base.mkdir()
            service = load_training_service(root / "state")
            steps = []
            provider_calls = []
            def provider(name):
                provider_calls.append(name)
                return "0.1.1.post1" if name == "qwen-tts-hf" else None
            with patch.object(service, "_gpu_inventory", return_value={"count": 2, "names": ["Tesla T4", "Tesla T4"], "dual_t4": True}), \
                 patch.object(service, "_base_directory", return_value=base), \
                 patch.object(service.importlib.util, "find_spec", return_value=object()), \
                 patch("qwen_compat.installed_version", side_effect=provider), \
                 patch("training_job.base_fingerprint", return_value="a" * 64), \
                 patch("training_codes.model_fingerprint", return_value="b" * 64), \
                 patch.dict(os.environ, {"QTTS_BASE_SHA256": "a" * 64}):
                report = service.preflight(deep=True, progress=steps.append)
            self.assertTrue(report["can_train"])
            self.assertEqual(report["provider"], {"distribution": "qwen-tts-hf", "version": "0.1.1.post1"})
            self.assertEqual(report["base"]["base_model_sha256"], "a" * 64)
            self.assertEqual(report["base"]["tokenizer_tree_sha256"], "b" * 64)
            self.assertEqual(steps, ["hardware_inventory", "dependency_check", "base_fingerprint", "tokenizer_fingerprint", "complete"])
            self.assertEqual(provider_calls, ["qwen-tts-hf"])
            self.assertFalse(report["training_verified"])
            self.assertFalse(report["quality_verified"])

    def test_empty_blocked_reason_cannot_create_a_blank_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            service = load_training_service(Path(directory))
            job = {"id": "a" * 32, "state": "running", "stage": "queued", "pct": 0, "log": []}
            with patch.object(service, "preflight", return_value={"can_train": False, "reasons": [], "base": {}}):
                service._run(job, [])
            self.assertEqual(job["state"], "error")
            self.assertEqual(job["stage"], "preflight")
            self.assertEqual(job["error"], "training prerequisites failed")
            self.assertTrue(job["error"].strip())
            self.assertFalse(job["optimizer_execution_observed"])

    def test_mock_still_stops_before_encoding_or_optimizer(self):
        with tempfile.TemporaryDirectory() as directory:
            service = load_training_service(Path(directory))
            service.MOCK = True
            job = {"id": "b" * 32, "name": "mock-only", "language": "auto",
                   "state": "running", "stage": "queued", "pct": 0, "log": []}
            current = {"profile": "reference-only", "full_ref_text": "complete transcript"}
            preparation = {"dataset": {"id": "dataset", "manifest_sha256": "manifest"},
                           "full_ref_text": "complete transcript", "windows": []}
            with patch.object(service, "preflight", return_value={"can_train": False, "reasons": ["browser_mock_is_not_real_training"], "base": {}}), \
                 patch.object(service, "_wait_analyst", return_value=(current, preparation)), \
                 patch.object(service, "_run_command") as command:
                service._run(job, [])
            command.assert_not_called()
            self.assertEqual(job["state"], "error")
            self.assertEqual(job["error_code"], "real_training_required")
            self.assertFalse(job.get("training_completed", False))
            self.assertFalse(job["optimizer_execution_observed"])
            self.assertEqual(job["full_ref_text"], "complete transcript")


if __name__ == "__main__":
    unittest.main()
