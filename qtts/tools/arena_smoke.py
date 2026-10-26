#!/usr/bin/env python3
"""End-to-end smoke test for the original QTTS browser runtime.

Run against a live MOCK stack (default http://127.0.0.1:3000). The generated
reference is synthetic and tests data flow only; it is not a speaker/model/quality
certificate. No access token, grant, cookie, audio, or transcript is written to the
JSON report.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

import numpy as np
import requests
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("QTTS_STATE", ROOT / "state"))
ENTRY = re.compile(r"qtts-entry=([A-Za-z0-9_-]{43})")
LONG_TEXT = (
    "你好呀，今天过得怎么样？我刚刚想了一件有意思的事情，就是人为什么会在说话的时候换气。"
    "其实呢，这和我们的节奏有关……你说对不对？\n\n好了，我们继续聊吧。先从最简单的开始，慢慢来，不着急。"
    "等你准备好了，我们再往下深入，一步一步把事情讲清楚。"
)


class Smoke:
    def __init__(self, url: str):
        self.url = url.rstrip("/")
        self.http = requests.Session()
        self.results: list[dict] = []
        self.profile = ""
        self.library = ""
        self.demo = False

    def check(self, name: str, condition, detail=""):
        ok = bool(condition)
        row = {"name": name, "ok": ok, "detail": str(detail)[:500]}
        self.results.append(row)
        print(f"[{'PASS' if ok else 'FAIL'}] {name} {row['detail']}", flush=True)
        if not ok:
            raise RuntimeError(name)
        return row

    def request(self, method: str, path: str, expected=200, **kwargs) -> requests.Response:
        response = self.http.request(method, self.url + path, timeout=kwargs.pop("timeout", 900), **kwargs)
        allowed = {expected} if isinstance(expected, int) else set(expected)
        if response.status_code not in allowed:
            raise RuntimeError(f"{method} {path}: HTTP {response.status_code}: {response.text[:800]}")
        return response

    def json(self, method: str, path: str, expected=200, **kwargs):
        return self.request(method, path, expected, **kwargs).json()

    def connect(self):
        response = self.http.get(self.url + "/", timeout=15)
        self.check("original index is served", response.status_code == 200)
        match = ENTRY.search(response.text)
        self.demo = response.headers.get("x-qtts-demo") == "1"
        if self.demo:
            self.check("demo index has no private grant", match is None)
            self.check("demo index selects direct console", "window.QTTS_DEMO_OPEN=1" in response.text and "app.js?demo=direct" in response.text and "kaggle-source.js?rev=" in response.text)
            self.check("demo index has no inline access key", "window.location.hash=\"qtts-entry=" not in response.text and "Bearer " not in response.text)
            self.http.headers.update({"X-QTTS-Demo": "1"})
            self.check("demo session needs no cookie or key", self.json("GET", "/api/session/status").get("ready") is True and not self.http.cookies)
            self.check("demo mode remains explicitly marked", self.demo)
        else:
            self.check("private grant is injected for the sandbox", match is not None)
            if match:
                bootstrap = f'<script>window.location.hash="qtts-entry={match.group(1)}";</script>'
                self.check("index differs only by the private-entry adapter", response.text.replace(bootstrap, "", 1) == (ROOT / "web" / "index.html").read_text())
                grant = match.group(1)
                exchange = self.http.post(self.url + "/api/session/exchange", json={"grant": grant}, headers={"Origin": self.url}, timeout=15)
                self.check("one-use grant exchanges for an HttpOnly session", exchange.status_code == 200 and self.http.cookies.get("qtts_private_session"))
                reused = requests.post(self.url + "/api/session/exchange", json={"grant": grant}, headers={"Origin": self.url}, timeout=15)
                self.check("used grant cannot be replayed", reused.status_code == 401)
        self.http.headers.update({"Origin": self.url})
        for asset in ("app.js", "recorder.js", "diagnostic-trace.js"):
            served = self.http.get(self.url + "/" + asset, timeout=15)
            self.check(f"original {asset} is byte-identical", served.status_code == 200 and served.content == (ROOT / "web" / asset).read_bytes())
        anonymous = requests.get(self.url + "/api/profiles", timeout=15)
        self.check("private API rejects anonymous access", anonymous.status_code == 401)
        if self.demo:
            bad = requests.get(self.url + "/api/profiles", headers={"Origin": self.url, "Authorization": "Bearer invalid"}, timeout=15)
        else:
            bad = self.http.get(self.url + "/api/profiles", headers={"Authorization": "Bearer invalid"}, timeout=15)
        self.check("invalid Bearer is not rescued by a valid cookie", bad.status_code == 401)
        cross = requests.get(self.url + "/api/profiles", headers={"Origin": "https://invalid.example"}, timeout=15)
        self.check("cross-origin access is rejected", cross.status_code == 403)

    def wait_job(self, job_id: str) -> dict:
        for _ in range(360):
            job = self.json("GET", "/api/prep/jobs/" + job_id)
            if job.get("state") != "running":
                return job
            time.sleep(0.5)
        raise RuntimeError("voice build did not finish within 180 seconds")

    @staticmethod
    def make_audio(directory: Path, ffmpeg: str) -> tuple[Path, Path, Path]:
        sr = 24000
        t = np.arange(sr * 6) / sr
        f0 = 145 + 18 * np.sin(2 * np.pi * 0.55 * t) + 7 * np.sin(2 * np.pi * 1.7 * t)
        phase = 2 * np.pi * np.cumsum(f0) / sr
        audio = 0.24 * np.sin(phase) + 0.11 * np.sin(2 * phase) + 0.055 * np.sin(3 * phase) + 0.025 * np.sin(4 * phase)
        audio *= 0.7 + 0.2 * np.sin(2 * np.pi * 1.1 * t) + 0.08 * np.sin(2 * np.pi * 3.3 * t)
        audio += 0.002 * np.random.default_rng(4).standard_normal(len(t))
        audio[:1200] *= np.linspace(0, 1, 1200)
        audio[-1200:] *= np.linspace(1, 0, 1200)
        wav = directory / "synthetic-reference.wav"
        ogg = directory / "synthetic-reference.ogg"
        extra = directory / "delete-me.wav"
        sf.write(wav, audio.astype("float32"), sr, subtype="PCM_16")
        sf.write(extra, (0.12 * np.sin(2 * np.pi * 210 * np.arange(sr * 2) / sr)).astype("float32"), sr, subtype="PCM_16")
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "libvorbis", str(ogg)], check=True)
        return wav, ogg, extra

    def direct_profile_lifecycle(self, wav: Path):
        with wav.open("rb") as stream:
            result = self.json("POST", "/api/prep/profiles", data={
                "name": "smoke-disposable-profile", "language": "zh",
                "ref_text": "这是临时合成测试音频，不是实际说话人。", "anchor_seconds": "16", "calibrate": "0",
            }, files=[("files", (wav.name, stream, "audio/wav"))])
        job = self.wait_job(result["job"])
        self.check("direct multipart profile build completes", job.get("state") == "done" and job.get("profile"), job.get("error", ""))
        profile_id = job["profile"]
        deleted = self.json("DELETE", "/api/prep/profiles/" + profile_id)
        self.check("independent profile deletion", deleted.get("ok") is True)

    def library_lifecycle(self, wav: Path, ogg: Path, extra: Path):
        library = self.json("POST", "/api/prep/libraries", json={"name": f"smoke-synthetic-library-{time.time_ns()}", "language": "zh"})["library"]
        self.library = library["id"]
        handles = []
        try:
            files = []
            for path in (wav, ogg, extra):
                stream = path.open("rb")
                handles.append(stream)
                files.append(("files", (path.name, stream, "audio/ogg" if path.suffix == ".ogg" else "audio/wav")))
            library = self.json("POST", f"/api/prep/libraries/{self.library}/samples", data={"revision": str(library["revision"])}, files=files)["library"]
        finally:
            for handle in handles:
                handle.close()
        self.check("WAV and compressed OGG samples are stored", len(library["samples"]) == 3)
        extra_id = next(sample["id"] for sample in library["samples"] if sample["name"] == extra.name)
        library = self.json("DELETE", f"/api/prep/libraries/{self.library}/samples/{extra_id}", json={"revision": library["revision"]})["library"]
        self.check("raw sample deletion updates the library revision", len(library["samples"]) == 2)
        selected = [sample["id"] for sample in library["samples"]]
        launched = self.json("POST", f"/api/prep/libraries/{self.library}/process", json={
            "revision": library["revision"], "sample_ids": selected, "ref_text": "", "anchor_seconds": 16, "calibrate": False,
        })
        job = self.wait_job(launched["job"])
        self.check("library decode, ASR, anchor and worker-load pipeline", job.get("state") == "done" and job.get("profile"), job.get("error", ""))
        self.profile = job["profile"]
        activation = self.json("POST", "/api/profiles/activate", json={"id": self.profile})
        self.check("profile activation is confirmed by both workers", len(activation.get("workers", [])) == 2 and all(row.get("ok") for row in activation["workers"]))
        library = self.json("GET", f"/api/prep/libraries/{self.library}")["library"]
        self.check("library reaches reference_prepared, not a training claim", library.get("state") == "reference_prepared" and library.get("training_verified") is False)
        self.training_checks(library, wav, ogg)

    def training_checks(self, library: dict, wav: Path, ogg: Path):
        wav_id = next(sample["id"] for sample in library["samples"] if sample["name"] == wav.name)
        ogg_id = next(sample["id"] for sample in library["samples"] if sample["name"] == ogg.name)
        body = {
            "library_id": self.library, "revision": library["revision"],
            "samples": [{"id": wav_id, "text": "合成测试音频的独立训练输入转写。"}],
            "reference_sample_id": wav_id, "voice_rights_confirmed": True, "single_speaker_confirmed": True,
        }
        dataset = self.json("POST", "/api/prep/training-data", json=body)["dataset"]
        self.check("strict PCM16 mono 24kHz training snapshot", dataset.get("sample_count") == 1 and dataset.get("integrity_verified_now") is True and dataset.get("state") == "input_snapshot_ready")
        verified = self.json("POST", f"/api/prep/training-data/{dataset['id']}/verify", json={"manifest_sha256": dataset["manifest_sha256"]})["dataset"]
        self.check("pinned manifest and per-file training verification", verified.get("integrity_verified_now") is True)
        rejected = self.request("POST", "/api/prep/training-data", expected=400, json={**body, "samples": [{"id": ogg_id, "text": "不应自动转码。"}], "reference_sample_id": ogg_id})
        self.check("compressed audio is not silently transcoded for training", "no automatic conversion" in rejected.json().get("error", ""))
        deleted = self.json("DELETE", f"/api/prep/training-data/{dataset['id']}", json={"manifest_sha256": dataset["manifest_sha256"]})
        self.check("training snapshot deletion preserves source library", deleted.get("source_library_deleted") is False)

    def profile_controls(self):
        profile = next(row for row in self.json("GET", "/api/profiles")["profiles"] if row["id"] == self.profile)
        saved = self.json("POST", f"/api/prep/profiles/{self.profile}/text", json={"ref_text": profile["ref_text"]})
        self.check("reference text save and binding reload", saved.get("reference_saved") is True and all(row.get("ok") for row in saved.get("workers", [])))
        if len(profile.get("candidates", [])) > 1:
            self.json("POST", f"/api/prep/profiles/{self.profile}/candidate", json={"index": 1})
            self.json("POST", f"/api/prep/profiles/{self.profile}/candidate", json={"index": 0})
            self.check("candidate anchor switch and restoration", True)
        consistency = self.json("POST", "/api/prep/consistency", json={"profile": self.profile})
        self.check("consistency output remains unverified in MOCK", consistency.get("quality_verified") is not True)
        calibration = self.json("POST", f"/api/prep/profiles/{self.profile}/calibrate", expected=(200, 422, 503))
        self.check("calibration never fabricates a quality pass", calibration.get("quality_verified") is False)

    def speak(self, text: str, policy="legacy-stream", mode="read", telemetry=False) -> dict:
        response = self.http.post(self.url + "/api/speak", json={
            "profile": self.profile, "mode": mode, "text": text, "quality_policy": policy, "test_seed": 42,
        }, stream=True, timeout=(10, 900))
        if response.status_code != 200:
            raise RuntimeError(f"speak HTTP {response.status_code}: {response.text[:500]}")
        session_id = response.headers.get("X-Session-Id", "")
        if telemetry:
            received = self.request("POST", "/api/telemetry", expected=204, json={
                "session": session_id, "played_s": 0, "buffered_s": 1, "state": "buffering",
                "urgency": 0, "underruns": 1, "first_played_ms": 123,
            })
            self.check("browser telemetry is accepted during streaming", received.status_code == 204)
        buffer = bytearray()
        result = {"session": session_id, "segments": {}, "stats": {}, "errors": [], "texts": [], "order": [], "pcm": 0, "end": None, "policy": None}
        for chunk in response.iter_content(None):
            buffer.extend(chunk)
            while len(buffer) >= 9:
                kind, segment, length = struct.unpack("<BII", buffer[:9])
                if len(buffer) < 9 + length:
                    break
                payload = bytes(buffer[9:9 + length])
                del buffer[:9 + length]
                if kind == 1:
                    result["order"].append(segment)
                    result["pcm"] += len(payload)
                elif kind == 2:
                    result["segments"][segment] = json.loads(payload)
                elif kind == 3:
                    result["texts"].append(json.loads(payload)["t"])
                elif kind == 4:
                    result["stats"][segment] = json.loads(payload)
                elif kind == 5:
                    result["end"] = json.loads(payload)
                elif kind == 6:
                    result["errors"].append(json.loads(payload))
                elif kind == 7:
                    result["policy"] = json.loads(payload)
        self.check("binary stream has no truncated trailing frame", not buffer)
        return result

    def synthesis_checks(self):
        result = self.speak(LONG_TEXT, telemetry=True)
        self.check("ordered PCM across multiple segments", result["pcm"] > 0 and result["order"] == sorted(result["order"]) and len(result["segments"]) >= 3)
        self.check("both MOCK workers participate", {row.get("gpu") for row in result["stats"].values()} == {0, 1})
        self.check("no synthesis error frames or worker anomalies", not result["errors"] and all(not row.get("anomalies") for row in result["stats"].values()))
        self.check("terminal summary is complete and explicitly unverified", result["end"] and result["end"].get("generation_completed") is True and result["end"].get("quality_verified") is False)
        report = self.json("POST", "/api/report", json={
            "session": result["session"], "report_sequence": 1, "phase": "playback_completed",
            "first_played_ms": 123, "speaker_heard": True, "request_mode": "chat",
        })
        self.check("browser diagnostic report merges", report.get("merged") is True)
        runs = self.json("GET", "/api/metrics")["runs"]
        run = next(row for row in reversed(runs) if row.get("session") == result["session"])
        self.check("client cannot claim physical hearing or server mode", run["client"].get("speaker_heard") is False and run["client"].get("client_untrusted") is True and run.get("request_mode") == "read")
        for policy in ("sentence-linear", "sentence-agc", "sentence-agc-headroom", "windowed-linear"):
            row = self.speak("逐句检查不同音频质量策略。", policy=policy)
            self.check(f"audio policy {policy}", row["pcm"] > 0 and row["end"] and not row["errors"])

    def diagnostic_checks(self, llm_key_set: bool):
        pair = self.json("POST", "/api/prep/diagnostics/pair", json={"profile": self.profile, "text": "双 Worker 协议对照短测。", "language": "Chinese"})
        self.check("pair test does not certify MOCK as physical GPUs", pair.get("observed_pair_valid") is False and pair.get("physical_identity_verified") is False and pair.get("speaker_identity_verified") is False)
        local = self.json("GET", "/api/prep/diagnostics/snapshot")
        gateway = self.json("GET", "/api/diagnostics")
        self.check("local and gateway diagnostic exports are available", isinstance(local, dict) and gateway.get("schema") == "qtts-diagnostics-v1")
        self.check("diagnostic export preserves honest verification labels", gateway.get("quality_verified") is False and gateway.get("training_verified") is False and gateway.get("physical_speaker_output_verified") is False)
        if not llm_key_set:
            chat = self.speak("你好", mode="chat")
            self.check("chat without DeepSeek key returns an explicit LLM error", any(row.get("stage") == "llm" and "DEEPSEEK_API_KEY" in row.get("error", "") for row in chat["errors"]) and chat["end"])

    def cleanup_checks(self):
        library = self.json("POST", "/api/prep/libraries", json={"name": f"smoke-delete-library-{time.time_ns()}", "language": "auto"})["library"]
        self.json("DELETE", f"/api/prep/libraries/{library['id']}", json={"revision": library["revision"]})
        self.request("GET", f"/api/prep/libraries/{library['id']}", expected=404)
        self.check("whole library deletion", True)
        preflight = self.json("GET", "/api/preflight")
        self.check("real backend probe is not fabricated", preflight.get("model_loaded") is False and preflight.get("inference_verified") is False)

    def run(self):
        ffmpeg = shutil.which("ffmpeg") or str(ROOT.parent / ".tools" / "bin" / "ffmpeg")
        with tempfile.TemporaryDirectory(prefix="qtts-smoke-") as temporary:
            wav, ogg, extra = self.make_audio(Path(temporary), ffmpeg)
            self.connect()
            health = self.json("GET", "/api/health")
            self.check("two healthy MOCK workers", health.get("mock") is True and health.get("workers_healthy") == 2)
            self.direct_profile_lifecycle(wav)
            self.library_lifecycle(wav, ogg, extra)
            self.profile_controls()
            self.synthesis_checks()
            self.diagnostic_checks(bool(health.get("llm_key_set")))
            self.cleanup_checks()
        self.json("POST", "/api/session/logout")
        if self.demo:
            self.request("GET", "/api/session/status", expected=200)
            self.check("demo logout never creates a password lock", True)
        else:
            self.request("GET", "/api/session/status", expected=401)
            self.check("logout invalidates the server-side browser session", True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("QTTS_TEST_URL", "http://127.0.0.1:3000"))
    parser.add_argument("--report", type=Path, default=STATE / "arena-smoke.json")
    args = parser.parse_args()
    smoke = Smoke(args.url)
    exit_code = 0
    try:
        smoke.run()
    except Exception as error:
        exit_code = 1
        smoke.results.append({"name": "fatal", "ok": False, "detail": f"{type(error).__name__}: {error}"})
        print(f"[FAIL] fatal: {type(error).__name__}: {error}", file=sys.stderr)
    report = {
        "schema": "qtts-arena-smoke-v1", "mock_only": True,
        "model_inference_verified": False, "physical_gpu_identity_verified": False,
        "speaker_quality_verified": False, "training_executed": False,
        "passed": sum(row["ok"] for row in smoke.results), "total": len(smoke.results),
        "checks": smoke.results,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"\n{report['passed']}/{report['total']} checks passed; report: {args.report}")
    print("MOCK data-path validation only; no real model, speaker quality, physical GPU, or training acceptance is claimed.")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
