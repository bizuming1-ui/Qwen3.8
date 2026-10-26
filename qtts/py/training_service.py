"""Persistent simple-training API and real CPU + two-T4 orchestration.

The service deliberately has no GPU lease of its own.  It prepares references via
Analyst, encodes with the reviewed CPU CLI, asks supervisor for an exclusive GPU
handoff, runs the existing two-rank controller, publishes checked artifacts, and
restores inference.  MOCK can exercise preparation but can never report training.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile as FormUploadFile
from starlette.exceptions import HTTPException as FormError

from access_control import auth_directory, gateway_headers
from qtts_common import read_json, write_json_atomic
from resource_limits import BodyBudgetMiddleware, UploadLimits, UploadRejected, read_upload
from training_control import read_ack, request as control_request

ROOT = Path(os.environ.get("QTTS_ROOT", Path(__file__).resolve().parents[1]))
STATE = Path(os.environ.get("QTTS_STATE", ROOT / "state"))
ANALYST_URL = os.environ.get("QTTS_ANALYST_URL", "http://127.0.0.1:" + os.environ.get("QTTS_ANALYST_PORT", "7010")).rstrip("/")
GATEWAY_PORT = int(os.environ.get("QTTS_GATEWAY_PORT", "7860"))
GATEWAY_URL = os.environ.get("QTTS_GATEWAY_URL", "http://127.0.0.1:" + str(GATEWAY_PORT)).rstrip("/")
MOCK = os.environ.get("QTTS_MOCK", "0") == "1"
LIMITS = UploadLimits.from_env()
JOB_DIR = STATE / "simple_training"
JOB_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
JOB_LOCK = threading.RLock()
JOBS: dict[str, dict] = {}
PROCESSES: dict[str, subprocess.Popen] = {}
MAX_LOG = 120
NAME_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,64}$")


class StageFailure(RuntimeError):
    def __init__(self, stage, message, *, recoverable=True):
        super().__init__(message)
        self.stage = stage
        self.recoverable = recoverable


def _public(job):
    return {key: value for key, value in job.items() if not key.startswith("_")}


def _save(job):
    JOB_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_json_atomic(JOB_DIR / (job["id"] + ".json"), _public(job))


def _update(job, **fields):
    with JOB_LOCK:
        job.update(fields)
        job["updated"] = time.time()
        _save(job)


def _log(job, message):
    with JOB_LOCK:
        entries = list(job.get("log", []))
        entries.append("[%s] %s" % (time.strftime("%H:%M:%S"), str(message)[:300]))
        job["log"] = entries[-MAX_LOG:]
        job["updated"] = time.time()
        _save(job)


def _error_text(error):
    if isinstance(error, UploadRejected):
        return str(error)[:500]
    text = str(error).strip()
    return (text or "operation failed; inspect the local training receipt")[:500]


def _fail(job, stage, error, *, recoverable=True):
    _update(job, state="error", stage=stage, error=_error_text(error), error_code=stage,
            training_required=stage == "real_training_required", recoverable=bool(recoverable),
            quality_verified=False, inference_reload_verified=bool(job.get("inference_reload_verified", False)))
    _log(job, "FAILED: " + _error_text(error))


def _load_jobs():
    for path in JOB_DIR.glob("*.json"):
        if path.is_symlink() or not path.is_file():
            continue
        value = read_json(path, {})
        if not isinstance(value, dict) or not re.fullmatch(r"[0-9a-f]{32}", value.get("id", "")):
            continue
        if value.get("state") == "running":
            value.update(state="error", stage="service_restarted",
                         error="training service restarted; inspect the saved run before retrying",
                         recoverable=bool(value.get("run_id")))
        JOBS[value["id"]] = value


_load_jobs()


def _gpu_inventory():
    if MOCK:
        return {"count": 0, "names": [], "mode": "mock", "dual_t4": False}
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=uuid,name,memory.total", "--format=csv,noheader"],
                                capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return {"count": 0, "names": [], "dual_t4": False, "error": "nvidia-smi unavailable"}
    rows = [row.strip() for row in result.stdout.splitlines() if row.strip()]
    names = [row.split(",")[1].strip() if len(row.split(",")) > 1 else "unknown" for row in rows]
    return {"count": len(rows) if result.returncode == 0 else 0, "names": names,
            "dual_t4": result.returncode == 0 and len(rows) == 2 and all("T4" in name for name in names),
            "query_returncode": result.returncode}


def _base_directory():
    configured = os.environ.get("QTTS_BASE_MODEL_DIR") or os.environ.get("QTTS_MODEL", "")
    if not configured:
        return None
    path = Path(configured)
    return path.absolute() if path.is_absolute() and path.is_dir() else None


def preflight(*, deep=False):
    gpu = _gpu_inventory()
    base = _base_directory()
    dependencies = {name: importlib.util.find_spec(name) is not None for name in ("torch", "qwen_tts", "safetensors")}
    reasons = []
    if MOCK:
        reasons.append("browser_mock_is_not_real_training")
    if not gpu.get("dual_t4"):
        reasons.append("exactly_two_physical_T4_GPUs_required")
    if base is None:
        reasons.append("materialized_local_Base1.7B_required")
    if not all(dependencies.values()):
        reasons.append("torch_qwen_tts_safetensors_dependencies_required")
    report = {
        "status": "mock" if MOCK else "ready" if not reasons else "blocked",
        "can_train": not reasons,
        "mode": "mock" if MOCK else "real",
        "cpu": {"encoder": "qwen3_tts_tokenizer_12hz", "offline": True, "threads": 2},
        "gpu": gpu,
        "base": {"materialized": base is not None, "model": base.name if base else None,
                 "base_model_sha256": os.environ.get("QTTS_BASE_SHA256") or None},
        "dependencies": dependencies,
        "reasons": reasons,
        "quality_verified": False,
        "training_verified": False,
    }
    if deep and base is not None and all(dependencies.values()):
        try:
            from training_job import base_fingerprint
            from training_codes import model_fingerprint
            base_hash = base_fingerprint(base)
            tokenizer_hash = model_fingerprint(base / "speech_tokenizer")
            pinned = os.environ.get("QTTS_BASE_SHA256")
            if pinned and pinned != base_hash:
                raise UploadRejected("pinned Base model hash does not match the local materialization", 409)
            report["base"].update(base_model_sha256=base_hash, tokenizer_tree_sha256=tokenizer_hash,
                                  tokenizer_materialized=True)
            report["_base_directory"] = str(base)
        except Exception as error:
            report["can_train"] = False
            report["status"] = "blocked"
            report["reasons"].append("base_or_tokenizer_fingerprint_failed")
            report["fingerprint_error"] = _error_text(error)
    elif deep:
        report["can_train"] = False
    report["can_train"] = bool(report["can_train"] and report.get("tokenizer_materialized"))
    if not deep:
        # A shallow probe never claims readiness solely from environment flags.
        report["can_train"] = False if not MOCK else False
        if not report["reasons"]:
            report["status"] = "fingerprint_required"
            report["reasons"] = ["run_training_preflight_to_fingerprint_local_models"]
    return report


def _env(*, cpu=False):
    env = dict(os.environ)
    for key in ("QTTS_GPU_LEASE_FD", "QTTS_GPU_LEASE_NONCE", "QTTS_CODES_LEASE_FD", "QTTS_ACCESS_TOKEN",
                "DEEPSEEK_API_KEY", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_USERNAME", "KAGGLE_KEY"):
        env.pop(key, None)
    env.update(QTTS_ROOT=str(ROOT), QTTS_STATE=str(STATE), HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
               PYTHONUNBUFFERED="1", QTTS_TRAINING_SUPERVISED="1")
    if cpu:
        env.update(CUDA_VISIBLE_DEVICES="", OMP_NUM_THREADS="2", MKL_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2")
    return env


def _terminate(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _last_json(path):
    try:
        raw = path.read_bytes()[-262144:]
    except OSError:
        return {}
    for line in reversed(raw.splitlines()):
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                return value
        except (ValueError, UnicodeError):
            continue
    return {}


def _rank_progress(run_id):
    result = []
    root = STATE / "training_runs" / run_id
    for rank in (0, 1):
        path = root / ("rank%d.log" % rank)
        latest = {"rank": rank, "progress_observed": False}
        try:
            raw = path.read_bytes()[-65536:]
            for line in raw.splitlines()[-128:]:
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(row, dict) and row.get("rank") == rank and ("loss" in row or "loss_mean" in row):
                    latest.update({key: row[key] for key in ("epoch", "loss", "loss_mean", "optimizer_steps", "micro_step", "elapsed_s") if key in row})
                    latest["progress_observed"] = True
        except OSError:
            pass
        result.append(latest)
    return result


def _run_command(job, command, *, stage, timeout, env, run_id=None, epochs=1):
    log_path = STATE / "logs" / ("simple-training-%s-%s.log" % (job["id"], stage))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = None
    started = time.monotonic()
    try:
        with open(log_path, "ab") as output:
            process = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            with JOB_LOCK:
                PROCESSES[job["id"]] = process
            while True:
                if process.poll() is not None:
                    break
                if time.monotonic() - started > timeout:
                    raise StageFailure(stage, "%s exceeded its %ss deadline" % (stage, timeout))
                if run_id:
                    ranks = _rank_progress(run_id)
                    observed = [row for row in ranks if row.get("progress_observed")]
                    if observed:
                        epoch = max(float(row.get("epoch", 0)) for row in observed)
                        pct = min(84.0, 60.0 + 24.0 * (epoch + 1) / max(1, epochs))
                        _update(job, pct=round(pct, 1), ranks=ranks)
                time.sleep(1.0)
        receipt = _last_json(log_path)
        if process.returncode != 0 and receipt.get("status") in ("ok", "completed"):
            raise StageFailure(stage, "process exit code disagrees with its terminal receipt")
        return receipt
    except StageFailure:
        if process is not None:
            _terminate(process)
        raise
    except Exception as error:
        if process is not None:
            _terminate(process)
        raise StageFailure(stage, _error_text(error)) from error
    finally:
        with JOB_LOCK:
            PROCESSES.pop(job["id"], None)
        if process is not None and process.poll() is None:
            _terminate(process)


def _gateway_headers(url):
    return gateway_headers(url, STATE, GATEWAY_PORT)


def _wait_analyst(job, blobs, name, language):
    files = [( "files", (filename, data, "application/octet-stream")) for filename, data in blobs]
    data = {"name": name, "language": language, "voice_rights_confirmed": "1", "single_speaker_confirmed": "1"}
    try:
        response = requests.post(ANALYST_URL + "/simple-training/prepare", files=files, data=data, timeout=180)
    except requests.RequestException as error:
        raise StageFailure("reference_preparation", "Analyst is unavailable: " + _error_text(error)) from error
    if response.status_code != 200:
        raise StageFailure("reference_preparation", "reference preparation was rejected: " + response.text[:300])
    try:
        analyst_id = response.json()["job"]
    except (ValueError, KeyError, TypeError) as error:
        raise StageFailure("reference_preparation", "Analyst returned no preparation job") from error
    _update(job, analyst_job=analyst_id)
    while True:
        try:
            response = requests.get(ANALYST_URL + "/jobs/" + analyst_id, timeout=60)
            current = response.json()
        except (requests.RequestException, ValueError) as error:
            raise StageFailure("reference_preparation", "could not read Analyst progress: " + _error_text(error)) from error
        if response.status_code != 200:
            raise StageFailure("reference_preparation", "Analyst preparation job disappeared")
        pct = float(current.get("pct", 0) or 0)
        _update(job, pct=round(5 + pct * .30, 1), stage=current.get("stage", "reference_preparation"),
                analyst_progress=current.get("log", [])[-10:])
        if current.get("state") == "done":
            preparation = current.get("simple_training")
            if not isinstance(preparation, dict) or not isinstance(preparation.get("dataset"), dict):
                raise StageFailure("reference_preparation", "preparation completed without an immutable dataset receipt")
            return current, preparation
        if current.get("state") != "running":
            raise StageFailure("reference_preparation", current.get("error", "reference preparation failed"))
        time.sleep(1.0)


def _handoff(job, action, timeout=180):
    nonce = control_request(STATE, job["id"], action)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        receipt = read_ack(STATE, job["id"], nonce)
        if receipt:
            if receipt.get("status") == "error":
                raise StageFailure("gpu_handoff", receipt.get("error", "supervisor rejected GPU handoff"))
            expected = "paused" if action == "pause" else "resumed"
            if receipt.get("status") == expected:
                return receipt
        time.sleep(.5)
    raise StageFailure("gpu_handoff", "supervisor did not acknowledge %s before the deadline" % action)


def _wait_workers(job, timeout=1800):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            response = requests.get(GATEWAY_URL + "/api/health", headers=_gateway_headers(GATEWAY_URL + "/api/health"), timeout=15)
            value = response.json()
            if response.status_code == 200 and int(value.get("workers_healthy", 0)) >= 2:
                return value
        except (requests.RequestException, ValueError, TypeError):
            pass
        time.sleep(2)
    raise StageFailure("restore_inference", "workers did not become ready after training; trained artifacts are retained")


def _activate(job):
    profile = job.get("profile")
    if not profile:
        raise StageFailure("publish", "no trained profile is available for activation")
    url = GATEWAY_URL + "/api/profiles/activate"
    try:
        response = requests.post(url, json={"id": profile}, headers=_gateway_headers(url), timeout=900)
        value = response.json()
    except (requests.RequestException, ValueError) as error:
        raise StageFailure("activate", "trained profile activation failed: " + _error_text(error)) from error
    if response.status_code != 200 or not isinstance(value, dict) or value.get("active") != profile:
        raise StageFailure("activate", "trained profile was not loaded by both workers; previous active voice was retained")
    _update(job, inference_reload_verified=True, activation=value)
    # This flag means only a real worker load receipt, never acoustic quality.
    path = STATE / "profiles" / profile / "profile.json"
    current = read_json(path, {})
    if isinstance(current, dict) and current.get("id") == profile:
        current["inference_reload_verified"] = True
        current["quality_verified"] = False
        current["training_activation"] = {"run_id": job.get("run_id"), "workers_confirmed": True}
        write_json_atomic(path, current)
    return value


def _publish(job):
    from trained_profiles import TrainedArtifacts
    run_id = job.get("run_id")
    if not run_id:
        raise StageFailure("publish", "no completed run id is available")
    store = TrainedArtifacts(STATE)
    try:
        description = store.describe(run_id)
        language = {"auto": "Auto", "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean"}.get(job.get("language", "Auto").lower(), job.get("language", "Auto"))
        result = store.publish(run_id, description["adapter_manifest_sha256"], job["name"], True,
                               full_ref_text=job.get("full_ref_text", ""),
                               language=language,
                               source_profile_id=job.get("reference_profile"))
    except Exception as error:
        raise StageFailure("publish", _error_text(error)) from error
    _update(job, profile=result["profile_id"], adapter_manifest_sha256=result["adapter_manifest_sha256"],
            publish=result)
    return result


def _restore_and_activate(job):
    if job.get("gpu_paused"):
        _handoff(job, "resume")
        _update(job, gpu_paused=False, stage="restore_inference", pct=92)
    _wait_workers(job)
    _activate(job)


def _run(job, blobs):
    paused = False
    try:
        report = preflight(deep=True)
        base_directory = report.pop("_base_directory", None)
        _update(job, state="running", stage="preflight", pct=1, preflight=report)
        if not report.get("can_train") and not MOCK:
            raise StageFailure("preflight", "; ".join(report.get("reasons", ["training prerequisites failed"])))
        _update(job, stage="reference_preparation", pct=5)
        current, preparation = _wait_analyst(job, blobs, job["name"], job.get("language", "auto"))
        dataset = preparation["dataset"]
        _update(job, reference_profile=current.get("profile"), full_ref_text=preparation.get("full_ref_text", current.get("full_ref_text", "")),
                dataset_id=dataset["id"], dataset_manifest_sha256=dataset["manifest_sha256"],
                library_id=preparation.get("library_id"), allow_single_sample=bool(preparation.get("allow_single_sample")),
                windows=preparation.get("windows"), transcript_verified=False, stage="cpu_acoustic_encoding", pct=38)
        _log(job, "完整参考文本与内部训练快照已保存；尚未开始真实训练")
        if MOCK:
            raise StageFailure("real_training_required", "浏览器模拟器使用 MOCK：参考准备已完成，但没有 CPU 声学码、双 T4 或真实训练。请在 Kaggle 双 T4 运行。", recoverable=True)
        if not base_directory:
            raise StageFailure("preflight", "local Base directory was not retained for training")
        base = Path(base_directory)
        encode_command = [sys.executable, str(ROOT / "tools" / "encode_training.py"), "encode",
                          "--state", str(STATE), "--id", dataset["id"], "--manifest-sha256", dataset["manifest_sha256"],
                          "--model-dir", str(base / "speech_tokenizer"), "--model-sha256", report["base"]["tokenizer_tree_sha256"],
                          "--timeout", str(int(os.environ.get("QTTS_ENCODE_TIMEOUT", "3600")))]
        encoded = _run_command(job, encode_command, stage="cpu_acoustic_encoding", timeout=3660, env=_env(cpu=True))
        if encoded.get("status") != "ok":
            raise StageFailure("cpu_acoustic_encoding", encoded.get("reason", "CPU acoustic encoding did not complete"))
        codes = encoded.get("result", {})
        _update(job, codes_id=codes.get("id"), codes_manifest_sha256=codes.get("manifest_sha256"),
                codes=codes, stage="gpu_handoff", pct=55)
        _log(job, "CPU acoustic codes verified; requesting exclusive dual-GPU handoff")
        _handoff(job, "pause")
        paused = True
        _update(job, gpu_paused=True, stage="dual_t4_training", pct=60)
        run_id = uuid.uuid4().hex
        _update(job, run_id=run_id, training_options={"epochs": 2, "accumulation": 4, "max_sequence": 1024,
                    "lora_rank": 8, "lora_alpha": 16, "learning_rate": 2e-5, "seed": 42})
        command = [sys.executable, str(ROOT / "tools" / "train_tts.py"), "train", "--state", str(STATE),
                   "--id", codes["id"], "--manifest-sha256", codes["manifest_sha256"], "--model-dir", str(base),
                   "--model-sha256", report["base"]["base_model_sha256"], "--confirm-data-reviewed",
                   "--ack-experimental-training", "--run-id", run_id, "--epochs", "2", "--accumulation", "4",
                   "--max-sequence", "1024", "--lora-rank", "8", "--lora-alpha", "16", "--lr", "2e-5",
                   "--seed", "42", "--timeout", str(int(os.environ.get("QTTS_TRAIN_TIMEOUT", "21600")))]
        if job.get("allow_single_sample"):
            command.append("--allow-single-sample")
        trained = _run_command(job, command, stage="dual_t4_training", timeout=21720, env=_env(), run_id=run_id, epochs=2)
        if trained.get("status") != "completed" or trained.get("rank_exit_codes") != [0, 0]:
            raise StageFailure("dual_t4_training", trained.get("reason", "two-rank training did not complete; inspect rank receipts"))
        _update(job, training_completed=True, optimizer_execution_observed=True, training_receipt=trained,
                stage="publish", pct=87)
        _publish(job)
        _update(job, stage="restore_inference", pct=92)
        _handoff(job, "resume")
        paused = False
        _update(job, gpu_paused=False)
        _wait_workers(job)
        _update(job, stage="activate", pct=97)
        _activate(job)
        _update(job, state="done", stage="done", pct=100, error=None, error_code=None, training_required=False,
                recoverable=False, quality_verified=False, training_verified=True, inference_paused=False)
        _log(job, "真实双 rank 训练、adapter 发布与双 worker 加载均已完成；音色/音质仍需试听与测量")
    except Exception as error:
        _fail(job, getattr(error, "stage", job.get("stage", "failed")), error,
              recoverable=getattr(error, "recoverable", True))
    finally:
        if paused:
            try:
                _handoff(job, "resume", timeout=180)
                _update(job, gpu_paused=False, inference_paused=False)
            except Exception as resume_error:
                _update(job, gpu_paused=True, inference_paused=True,
                        resume_error=_error_text(resume_error), recoverable=True)
                _log(job, "训练已停止，但推理恢复未确认；请查看恢复回执")
        with JOB_LOCK:
            process = PROCESSES.pop(job["id"], None)
        if process is not None:
            _terminate(process)


def _new_job(name, language, blobs):
    with JOB_LOCK:
        for value in JOBS.values():
            if value.get("state") == "running":
                raise UploadRejected("another simple training job is still running", 429)
        while len(JOBS) >= LIMITS.jobs:
            old = next((key for key, value in JOBS.items() if value.get("state") in ("done", "error", "cancelled")), None)
            if old is None:
                raise UploadRejected("training job record capacity reached", 429)
            JOBS.pop(old, None)
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "name": name, "language": language, "state": "running", "stage": "queued", "pct": 0,
               "created": time.time(), "updated": time.time(), "log": [], "profile": None, "run_id": None,
               "error_code": None, "training_required": False,
               "quality_verified": False, "training_verified": False, "training_completed": False,
               "inference_reload_verified": False, "gpu_paused": False, "recoverable": True}
        JOBS[job_id] = job
        _save(job)
    thread = threading.Thread(target=_run, args=(job, blobs), daemon=True, name="simple-training-" + job_id)
    try:
        thread.start()
    except BaseException:
        with JOB_LOCK:
            JOBS.pop(job_id, None)
        raise
    return job


app = FastAPI(title="qtts-real-training-service", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(BodyBudgetMiddleware, maximum=LIMITS.request_bytes)


@app.exception_handler(UploadRejected)
async def rejected(request, error):
    return JSONResponse({"error": str(error)}, status_code=error.code)


@app.get("/health")
async def health():
    with JOB_LOCK:
        active = next((_public(job) for job in JOBS.values() if job.get("state") == "running"), None)
    return {"ok": True, "service": "real-training", "mock": MOCK, "active": active,
            "quality_verified": False, "training_verified": False}


@app.get("/preflight")
async def training_preflight():
    return preflight(deep=False)


@app.get("/jobs")
async def jobs():
    with JOB_LOCK:
        return {"jobs": sorted((_public(job) for job in JOBS.values()), key=lambda job: job.get("created", 0), reverse=True)}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        return _public(job) if job else JSONResponse({"error": "no such training job"}, status_code=404)


@app.post("/jobs")
async def create_job(request: Request):
    try:
        async with request.form(max_files=LIMITS.files, max_fields=8) as form:
            files = form.getlist("files")
            if not files or not all(isinstance(file, FormUploadFile) for file in files):
                raise UploadRejected("upload at least one reference recording", 400)
            name = form.get("name", "my-voice")
            language = form.get("language", "auto")
            if not isinstance(name, str) or not NAME_RE.fullmatch(name.strip()):
                raise UploadRejected("voice name is empty or contains control characters", 400)
            if not isinstance(language, str) or not NAME_RE.fullmatch(language.strip()):
                raise UploadRejected("language is invalid", 400)
            if form.get("voice_rights_confirmed") != "1" or form.get("single_speaker_confirmed") != "1":
                raise UploadRejected("clicking start must confirm voice rights and one speaker", 400)
            blobs = []
            total = 0
            for file in files:
                data = await read_upload(file, LIMITS, LIMITS.request_bytes - total)
                total += len(data)
                filename = Path((file.filename or "audio").replace("\\", "/")).name[:128]
                blobs.append((filename or "audio", data))
        job = _new_job(name.strip(), language.strip(), blobs)
        return {"job": job["id"], "operation": "real_training_task_created"}
    except FormError as error:
        raise UploadRejected("multipart limits exceeded or malformed form", 413 if "Too many" in str(error.detail) else 400) from None


@app.post("/jobs/{job_id}/retry-activation")
async def retry_activation(job_id: str):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return JSONResponse({"error": "no such training job"}, status_code=404)
        if job.get("state") == "running":
            raise UploadRejected("training job is still running", 409)
        if not job.get("profile"):
            raise UploadRejected("no published trained profile is available for activation retry", 409)
        job["state"] = "running"
        job["stage"] = "restore_inference"
        job["error"] = None
        job["error_code"] = None
        job["training_required"] = False
        _save(job)
    def retry():
        try:
            _restore_and_activate(job)
            _update(job, state="done", stage="done", pct=100, quality_verified=False, training_verified=True,
                    recoverable=False, inference_paused=False)
        except Exception as error:
            _fail(job, getattr(error, "stage", "activate"), error)
    threading.Thread(target=retry, daemon=True, name="training-activation-" + job_id).start()
    return {"job": job_id, "operation": "activation_retry"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("QTTS_TRAINING_PORT", "7020")), log_level="warning", access_log=False)
