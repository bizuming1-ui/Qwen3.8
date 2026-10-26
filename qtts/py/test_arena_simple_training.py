"""Dependency-light regressions for the simple training orchestration contracts.

These tests do not load a model or claim GPU/quality acceptance.  The HTTP and
real two-T4 tests remain separate environment-specific checks.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from resource_limits import UploadRejected
from simple_preparation import SR, join_transcript, make_windows
from training_control import acknowledge, read_ack, read_request, request
from training_job import admit


class SimplePreparationTests(unittest.TestCase):
    def test_complete_transcript_has_no_artificial_segment_labels(self):
        clips = [
            {"f": 0, "start": 0, "end": 1, "text": "你好"},
            {"f": 0, "start": 1, "end": 2, "text": "世界"},
            {"f": 1, "start": 0, "end": 1, "text": "hello"},
            {"f": 1, "start": 1, "end": 2, "text": "world"},
        ]
        self.assertEqual(join_transcript(clips), "你好世界hello world")
        self.assertNotIn("segment", join_transcript(clips).lower())

    def test_long_recording_is_bounded_and_reports_actual_coverage(self):
        # Twenty separated phrases produce more than the immutable 16-row store
        # budget.  The policy must cover the time span and say that not every
        # source second became an optimizer row.
        t = np.arange(SR * 80) / SR
        audio = (0.2 * np.sin(2 * np.pi * (173 + 0.07 * t) * t) +
                 0.003 * np.random.default_rng(4).standard_normal(t.size)).astype(np.float32)
        clips = []
        for index in range(20):
            start = index * 4.0
            clips.append({"f": 0, "start": start, "end": start + 2.0,
                          "text": f"第{index}句", "logprob": -0.1})
        selected, report = make_windows([("long.wav", audio)], clips)
        self.assertEqual(len(selected), 16)
        self.assertEqual(report["selection_policy"], "even-time-coverage")
        self.assertGreater(report["source_seconds"], report["selected_audio_seconds"])
        self.assertFalse(report["all_source_seconds_used_as_optimizer_rows"])
        self.assertTrue(all(row["seconds"] <= 16.02 for row in selected))
        self.assertEqual(join_transcript(clips), "".join(f"第{i}句" for i in range(20)))

    def test_short_single_window_is_explicitly_marked(self):
        audio = (0.2 * np.sin(2 * np.pi * 200 * np.arange(SR * 3) / SR)).astype(np.float32)
        clips = [{"f": 0, "start": 0.2, "end": 2.5, "text": "短参考", "logprob": -0.1}]
        selected, report = make_windows([("short.wav", audio)], clips)
        self.assertEqual(len(selected), 1)
        self.assertEqual(report["selected_window_count"], 1)
        self.assertTrue(report["transcript_is_asr_not_human_verified"])


class AdmissionAndControlTests(unittest.TestCase):
    def test_single_sample_requires_explicit_simple_mode(self):
        meta = {"schema": 2, "state": "audio_codes_prepared",
                "engine": {"kind": "qwen3_tts_tokenizer_12hz"},
                "checks": {"tokenization_executed": True}}
        with self.assertRaises(UploadRejected):
            admit(meta, [{}], True, True)
        self.assertIsNone(admit(meta, [{}], True, True, allow_single=True))

    def test_control_nonce_prevents_stale_acknowledgement(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            nonce = request(state, "a" * 32, "pause")
            current = read_request(state)
            self.assertEqual(current["nonce"], nonce)
            acknowledge(state, "a" * 32, nonce, "paused", inference_paused=True)
            self.assertEqual(read_ack(state, "a" * 32, nonce)["status"], "paused")
            self.assertIsNone(read_ack(state, "b" * 32, nonce))
            with self.assertRaises(ValueError):
                request(state, "a" * 32, "shell-command")


if __name__ == "__main__":
    unittest.main()
