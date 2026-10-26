"""Async Python runtime adapter for the original QTTS Go gateway.

The checked-in Go gateway remains the reference implementation. This adapter is
used where a Go toolchain cannot be downloaded; it preserves the browser routes,
private-cookie exchange, 9-byte PCM framing, dual-worker scheduling, and diagnostics.
It does not turn mock synthesis into a model-quality verification.
"""
from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import statistics
import struct
import tempfile
import time
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse

from arena_protocol import (
    C_END, C_ERROR, C_PCM, C_POLICY, C_SEG, C_STATS, C_TEXT,
    F_END, F_ERR, F_PCM, F_STATS,
    SAMPLE_RATE, PROFILE_ID, Segment, Segmenter, SegCfg,
    active_profile, detect_lang, finite_number, frame, json_frame,
    load_profile, policy_for,
)

ROOT = Path(os.environ.get("QTTS_ROOT", Path(__file__).resolve().parents[1]))
STATE = Path(os.environ.get("QTTS_STATE", ROOT / "state"))
WEB = Path(os.environ.get("QTTS_WEB", ROOT / "web"))
MOCK = os.environ.get("QTTS_MOCK") == "1"
AUTO_OPEN = os.environ.get("QTTS_AUTO_OPEN") == "1"
ALLOW_LOOPBACK_HTTP = os.environ.get("QTTS_AUTOENTRY_ALLOW_LOOPBACK_HTTP") == "1"
COOKIE_SAMESITE = os.environ.get("QTTS_AUTOENTRY_SAMESITE", "strict").strip().lower()
if COOKIE_SAMESITE not in ("strict", "lax", "none"):
    COOKIE_SAMESITE = "strict"
PUBLIC_HOST = os.environ.get("QTTS_PUBLIC_HOST", "").strip().lower()
ACCESS_TOKEN = os.environ.get("QTTS_ACCESS_TOKEN", "")
LLM_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
LLM_BASE = os.environ.get("DEEPSEEK_BASE_URL", os.environ.get("DEEPSEEK_BASE", "https://api.deepseek.com")).rstrip("/")
LLM_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
try:
    LLM_MAX_TOKENS = int(os.environ.get("DEEPSEEK_MAX_TOKENS", "8192"))
except ValueError:
    LLM_MAX_TOKENS = 8192
if not 1 <= LLM_MAX_TOKENS <= 65536:
    LLM_MAX_TOKENS = 8192
if os.environ.get("QTTS_WORKER_URLS"):
    WORKER_URLS = [value.strip().rstrip("/") for value in os.environ["QTTS_WORKER_URLS"].split(",") if value.strip()]
else:
    WORKER_URLS = ["http://127.0.0.1:" + port.strip() for port in os.environ.get("QTTS_WORKER_PORTS", "7001,7002").split(",") if port.strip()]
ANALYST_URL = os.environ.get("QTTS_ANALYST_URL", "http://127.0.0.1:" + os.environ.get("QTTS_ANALYST_PORT", "7010")).rstrip("/")
TRAINING_URL = os.environ.get("QTTS_TRAINING_URL", "http://127.0.0.1:" + os.environ.get("QTTS_TRAINING_PORT", "7020")).rstrip("/")
try:
    FIRST_CHUNK_SIZE = int(os.environ.get("QTTS_FIRST_CHUNK_SIZE", "4"))
except ValueError:
    FIRST_CHUNK_SIZE = 4
if not 2 <= FIRST_CHUNK_SIZE <= 8:
    FIRST_CHUNK_SIZE = 4
COOKIE_NAME = "qtts_private_session"
GRANT_TTL = 600
SESSION_TTL = 8 * 3600
MAX_SPEAK_BYTES = 256 * 1024
try:
    MAX_PROXY_BYTES = int(os.environ.get("QTTS_MAX_UPLOAD_BYTES", str(128 * 1024 * 1024)))
except ValueError:
    MAX_PROXY_BYTES = 128 * 1024 * 1024
MAX_PROXY_BYTES = max(1024, min(MAX_PROXY_BYTES, 512 * 1024 * 1024))
SESSION_ID = re.compile(r"^[0-9a-f]{12,64}$")
ENTRY_SECRET = re.compile(r"^[A-Za-z0-9_-]{43}$")
DEFAULT_SYSTEM = """你是一个诚实、友善的语音对话助手。
说话要求：
1. 用自然、口语化的语言回答，使用用户所用的语言。
2. 不要使用任何markdown、列表、编号、表情符号、括号注释、代码或链接。
3. 句子要短，一句话尽量不超过25个字，用逗号和句号制造自然的停顿和换气点。
4. 数字、单位用口语读法写出来。
5. 先直接回答，再根据用户需要充分展开；用户要求详细说明时可以输出长文本，不预设200字上限。
6. 语气有温度，可以有轻微的语气词，但不要夸张。"""

app = FastAPI(title="QTTS original browser runtime", docs_url=None, redoc_url=None, openapi_url=None)
HTTP: httpx.AsyncClient | None = None
GRANTS: dict[str, float] = {}
BROWSER_SESSIONS: dict[str, float] = {}
WORKER_LOCKS = [asyncio.Lock() for _ in WORKER_URLS]
MONITOR_TASK: asyncio.Task | None = None


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def prune_entries() -> None:
    now = time.monotonic()
    for collection in (GRANTS, BROWSER_SESSIONS):
        for key, expiry in list(collection.items()):
            if expiry <= now:
                collection.pop(key, None)


def valid_cookie(request: Request) -> bool:
    value = request.cookies.get(COOKIE_NAME, "")
    if not ENTRY_SECRET.fullmatch(value):
        return False
    prune_entries()
    return BROWSER_SESSIONS.get(digest(value), 0) > time.monotonic()


def bearer_valid(request: Request) -> bool:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return False
    token = header[7:]
    return bool(ACCESS_TOKEN) and hmac.compare_digest(token, ACCESS_TOKEN)


def same_origin(request: Request, required: bool = False) -> bool:
    if request.headers.get("sec-fetch-site", "") == "cross-site":
        return False
    origin = request.headers.get("origin")
    if not origin:
        return not required
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        return False
    origin_host = parsed.netloc.lower()
    request_host = request.headers.get("host", "").lower()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip().lower()
    allowed_hosts = {request_host, forwarded_host}
    if PUBLIC_HOST:
        allowed_hosts.add(PUBLIC_HOST)
    if origin_host not in allowed_hosts:
        return False
    if parsed.scheme == "https":
        return True
    host = parsed.hostname or ""
    return ALLOW_LOOPBACK_HTTP and (host == "localhost" or host in ("127.0.0.1", "::1"))


async def bounded_body(request: Request, limit: int) -> bytes:
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > limit:
        raise HTTPException(413, "request exceeds configured body limit")
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(413, "request exceeds configured body limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def require_auth(request: Request) -> None:
    if request.headers.get("authorization") is not None:
        if bearer_valid(request):
            return
        raise HTTPException(401, "unauthorized")
    unsafe = request.method not in ("GET", "HEAD")
    if valid_cookie(request) and same_origin(request, unsafe):
        return
    raise HTTPException(401, "unauthorized")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and not same_origin(request, False):
        return JSONResponse({"error": "cross-origin requests are not allowed"}, status_code=403)
    if request.method == "OPTIONS":
        response = Response(status_code=204)
    else:
        response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-DeepSeek-Key"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Vary"] = "Origin"
    return response


def set_session_cookie(response: Response, request: Request, value: str, max_age: int) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https" or request.headers.get("origin", "").startswith("https://")
    # None is opt-in for the embedded Arena preview; browsers require Secure.
    # Keep direct loopback HTTP usable by retaining Strict when TLS is absent.
    same_site = COOKIE_SAMESITE if COOKIE_SAMESITE != "none" or secure else "strict"
    secure = secure or same_site == "none"
    response.set_cookie(COOKIE_NAME, value, max_age=max_age, path="/", httponly=True, secure=secure, samesite=same_site)


def new_grant() -> str:
    prune_entries()
    if len(GRANTS) >= 8:
        raise HTTPException(429, "pending private entry limit reached")
    value = secrets.token_urlsafe(32)
    GRANTS[digest(value)] = time.monotonic() + GRANT_TTL
    return value


@app.post("/api/session/exchange")
async def exchange_session(request: Request):
    if not same_origin(request, True):
        raise HTTPException(403, "trusted same-origin HTTPS required")
    if request.url.query or request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(400, "JSON body required; no query parameters")
    raw = await bounded_body(request, 2048)
    if len(raw) > 2048:
        raise HTTPException(400, "invalid entry request")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "invalid entry request")
    if not isinstance(body, dict) or set(body) != {"grant"} or not isinstance(body["grant"], str) or not ENTRY_SECRET.fullmatch(body["grant"]):
        raise HTTPException(400, "invalid entry request")
    prune_entries()
    key = digest(body["grant"])
    if GRANTS.pop(key, None) is None:
        raise HTTPException(401, "entry expired or already used; open a new entry")
    if len(BROWSER_SESSIONS) >= 32:
        raise HTTPException(429, "browser session limit reached")
    old = request.cookies.get(COOKIE_NAME)
    if old:
        BROWSER_SESSIONS.pop(digest(old), None)
    value = secrets.token_urlsafe(32)
    BROWSER_SESSIONS[digest(value)] = time.monotonic() + SESSION_TTL
    response = JSONResponse({"ready": True, "expires_in": SESSION_TTL})
    set_session_cookie(response, request, value, SESSION_TTL)
    return response


@app.post("/api/session/issue")
async def issue_session(request: Request):
    if not bearer_valid(request):
        raise HTTPException(403, "notebook credential required")
    if request.url.query:
        raise HTTPException(400, "query parameters not accepted")
    return {"grant": new_grant(), "expires_in": GRANT_TTL}


@app.get("/api/session/status", dependencies=[Depends(require_auth)])
async def session_status():
    return {"ready": True}


@app.post("/api/session/logout", dependencies=[Depends(require_auth)])
async def logout_session(request: Request):
    if not same_origin(request, True):
        raise HTTPException(403, "same-origin required")
    value = request.cookies.get(COOKIE_NAME)
    if value:
        BROWSER_SESSIONS.pop(digest(value), None)
    response = JSONResponse({"ready": True})
    set_session_cookie(response, request, "", 0)
    return response


class WorkerState:
    def __init__(self, index: int, url: str):
        self.id = index
        self.url = url
        self.healthy = False
        self.health: dict = {}
        self.rtf = 0.0
        self.first_ms = 0.0
        self.last_error = ""
        self.busy = False
        self.served = 0
        self.failed = 0

    def update(self, health: dict) -> None:
        self.health = health
        self.healthy = bool(health.get("ready")) and not health.get("fatal_error")
        self.busy = bool(health.get("busy"))
        self.served = int(health.get("served") or 0)
        self.failed = int(health.get("failed") or 0)
        self.last_error = str(health.get("error") or "")
        rtf = finite_number(health.get("rtf_x"))
        if rtf > 0:
            self.rtf = rtf if self.rtf == 0 else self.rtf + 0.3 * (rtf - self.rtf)
        first = finite_number(health.get("first_chunk_ms"))
        if first > 0:
            self.first_ms = first

    def snapshot(self) -> dict:
        return {
            "id": self.id, "url": self.url, "healthy": self.healthy,
            "ready": bool(self.health.get("ready")), "busy": self.busy,
            "rtf_x": round(self.rtf, 4), "first_chunk_ms": round(self.first_ms, 2),
            "served": self.served, "failed": self.failed, "last_error": self.last_error,
            "worker": copy.deepcopy(self.health),
        }


WORKERS = [WorkerState(index, url) for index, url in enumerate(WORKER_URLS)]


def aggregate_rtf() -> float:
    total = sum((worker.rtf if worker.rtf > 0 else 0.9) for worker in WORKERS if worker.healthy)
    return total or 0.9


async def refresh_workers() -> None:
    if HTTP is None:
        return
    async def refresh(worker: WorkerState):
        try:
            response = await HTTP.get(worker.url + "/health", timeout=1.5)
            response.raise_for_status()
            worker.update(response.json())
        except Exception as error:
            worker.healthy = False
            worker.last_error = str(error)[:240]
    await asyncio.gather(*(refresh(worker) for worker in WORKERS), return_exceptions=True)


async def monitor_workers() -> None:
    while True:
        await refresh_workers()
        await asyncio.sleep(1.5)


@app.on_event("startup")
async def startup() -> None:
    global HTTP, MONITOR_TASK
    STATE.mkdir(parents=True, exist_ok=True)
    HTTP = httpx.AsyncClient(
        timeout=httpx.Timeout(900.0, connect=6.0),
        limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        follow_redirects=False,
    )
    MONITOR_TASK = asyncio.create_task(monitor_workers())


@app.on_event("shutdown")
async def shutdown() -> None:
    if MONITOR_TASK:
        MONITOR_TASK.cancel()
    if HTTP:
        await HTTP.aclose()


def worker_snapshots() -> list[dict]:
    return [worker.snapshot() for worker in WORKERS]


@app.get("/api/health", dependencies=[Depends(require_auth)])
async def health():
    await refresh_workers()
    snapshots = worker_snapshots()
    return {
        "ok": True, "workers_total": len(snapshots),
        "workers_healthy": sum(bool(worker["healthy"]) for worker in snapshots),
        "workers": snapshots, "agg_rtf": aggregate_rtf(), "policy": policy_for(aggregate_rtf()),
        "llm_key_set": bool(LLM_KEY), "llm_model": LLM_MODEL,
        "active_profile": active_profile(STATE), "mock": MOCK,
        "runtime_adapter": "python-async-go-compatible", "quality_verified": False,
    }


@app.get("/api/workers", dependencies=[Depends(require_auth)])
async def workers():
    await refresh_workers()
    return worker_snapshots()


@app.get("/api/preflight", dependencies=[Depends(require_auth)])
async def preflight():
    path = STATE / "backend_probe.json"
    if not path.exists():
        return {"status": "not_run", "model_loaded": False, "inference_verified": False, "training_verified": False, "performance_verified": False}
    try:
        if path.stat().st_size > 256 * 1024:
            raise ValueError("oversized")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("not an object")
        return value
    except (OSError, ValueError):
        raise HTTPException(500, "invalid or unavailable probe report")


@app.get("/api/profiles", dependencies=[Depends(require_auth)])
async def profiles():
    output = []
    directory = STATE / "profiles"
    if directory.is_dir():
        for child in directory.iterdir():
            path = child / "profile.json"
            if not child.is_dir() or not path.is_file():
                continue
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    output.append(value)
            except (OSError, ValueError):
                continue
    output.sort(key=lambda value: str(value.get("created", "")), reverse=True)
    return {"profiles": output, "active": active_profile(STATE)}


@app.post("/api/profiles/activate", dependencies=[Depends(require_auth)])
async def activate_profile(request: Request):
    body = await request.json()
    profile_id = body.get("id", "") if isinstance(body, dict) else ""
    if not isinstance(profile_id, str) or not profile_id:
        raise HTTPException(400, "id required")
    try:
        profile = load_profile(STATE, profile_id, MOCK)
    except FileNotFoundError:
        raise HTTPException(404, f"profile {profile_id!r} not found")
    except (ValueError, OSError) as error:
        raise HTTPException(400, str(error))
    if not WORKERS:
        raise HTTPException(503, "no workers configured")

    async def activate(worker: WorkerState):
        try:
            response = await HTTP.post(worker.url + "/profile/load", json={"profile": profile_id}, timeout=900)
            receipt = response.json()
            if response.status_code != 200 or receipt.get("ok") is not True:
                return {"ok": False, "error": "worker did not confirm profile load", "status": response.status_code}
            return receipt
        except Exception as error:
            return {"ok": False, "error": str(error)[:300]}

    receipts = await asyncio.gather(*(activate(worker) for worker in WORKERS))
    for receipt in receipts:
        if receipt.get("ok") is not True or (profile["voice_binding"] and receipt.get("voice_binding") != profile["voice_binding"]) or (profile["voice_binding"] and receipt.get("voice_conditioning") != profile["voice_conditioning"]):
            return JSONResponse({"error": "voice activation failed; previous active voice retained", "workers": receipts}, status_code=503)
    try:
        current = load_profile(STATE, profile_id, MOCK)
        if current["voice_binding"] != profile["voice_binding"]:
            raise ValueError("reference changed")
    except (ValueError, OSError):
        raise HTTPException(503, "reference changed during activation; retry new session")
    STATE.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=STATE, prefix=".active-", delete=False, encoding="utf-8") as stream:
            temporary = stream.name
            json.dump({"id": profile_id}, stream)
        os.replace(temporary, STATE / "active.json")
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return {"active": profile_id, "workers": receipts}


@app.api_route("/api/prep/{path:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"], dependencies=[Depends(require_auth)])
async def analyst_proxy(path: str, request: Request):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_PROXY_BYTES:
        raise HTTPException(413, "upload exceeds configured request limit")
    body = await bounded_body(request, MAX_PROXY_BYTES)
    headers = {}
    for name in ("content-type", "accept"):
        if name in request.headers:
            headers[name] = request.headers[name]
    try:
        response = await HTTP.request(
            request.method, ANALYST_URL + "/" + path,
            params=request.query_params, content=body, headers=headers,
            timeout=900,
        )
    except Exception:
        raise HTTPException(502, "analyst service unavailable or request interrupted")
    response_headers = {}
    for name in ("content-type", "cache-control", "content-disposition", "x-content-type-options"):
        if name in response.headers:
            response_headers[name] = response.headers[name]
    return Response(response.content, response.status_code, response_headers)


@app.api_route("/api/training/{path:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"], dependencies=[Depends(require_auth)])
async def training_proxy(path: str, request: Request):
    """Proxy only the fixed local training service; never forward browser credentials."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_PROXY_BYTES:
        raise HTTPException(413, "upload exceeds configured request limit")
    body = await bounded_body(request, MAX_PROXY_BYTES)
    headers = {}
    for name in ("content-type", "accept"):
        if name in request.headers:
            headers[name] = request.headers[name]
    try:
        response = await HTTP.request(request.method, TRAINING_URL + "/" + path,
                                      params=request.query_params, content=body, headers=headers, timeout=900)
    except Exception:
        raise HTTPException(502, "training service unavailable or request interrupted")
    response_headers = {}
    for name in ("content-type", "cache-control", "content-disposition", "x-content-type-options"):
        if name in response.headers:
            response_headers[name] = response.headers[name]
    return Response(response.content, response.status_code, response_headers)


DIAGNOSTIC_FIELDS = set("""request_mode content_source source_build_id source_build_match source_build_attested acoustic_text_verified
session id segment segments chars audio_s wall_s overall_rtf_x timeline_ms per_gpu client diagnostic_segments diagnostic_segments_total diagnostic_segments_truncated
gpu gpu0 gpu1 gen_s gen_ms rtf rtf_x first_chunk_ms model_first_chunk_ms first_chunk_ms_mean gain_db_mean gain_db dsp_ms max_gain_db seed speech_samples chunks chunk_size queue_ms lock_wait_ms profile_prepare_ms worker_wall_ms queue_wait_ms dispatch_queue_ms worker_roundtrip_ms attempts lead_ms model_stages prepare_ms token_decode_ms codec_window_frames reference_codes_decoded prefill_ms decode_ms first_decode_ms codec_ms model_ms quality_verified reference_pcm_splicing extra_breath_requested extra_breath_available output_target_dbfs voice_binding cancelled failed
available observer_failed raw_pretrim emitted_pcm_including_pause_tail observer_cpu_ms samples sample_rate frame_samples frames active_frames nonfinite_samples rms_dbfs peak dc_offset clip_fraction envelope_p10_dbfs envelope_p50_dbfs envelope_p90_dbfs envelope_spread_db max_active_jump_db active_jumps_ge6db max_sample_step spectral_frames high_band_fraction_mean spectral_flatness_mean noise_clue_frame_fraction measured hiss_verified naturalness_verified speaker_identity_verified analysis_clamped_samples
llm_request_start llm_response_headers llm_first_token llm_done read_text_ready first_segment first_dispatch first_seg_worker_audio first_audio_sent all_audio_sent stream_interrupted generation_completed llm_error error_count llm_delta_count
phase clock_origin report_sequence response_headers_ms event engine dtype rt voice_conditioning model_output_mode first_byte_ms first_pcm_ms first_played_ms play_command_ms first_consumed_ms generation_received_ms playback_completed_ms end_to_end_click_completed_ms ui_initialization_ms underruns gaps_ms min_buffer_s played_s buffered_s pending_samples end_acknowledged stream_epoch audio_context_state base_latency_s output_latency_s speaker_heard client_untrusted audio_bytes text_deltas text_chars received_segments stats_frames end_received has_error events elapsed_ms at_ms pcm text_delta segment_received stats headers request network_end worklet_first_consumed playback_drained cancelled_event superseded_event error_event generation_error
quality_policy codec_policy soft_limited_samples soft_limited_fraction soft_limiter_peak_reduction_db linear_peak_limited""".split())
ENUMS = {"generation_received", "playing", "playback_completed", "cancelled", "superseded", "error", "interrupted", "running", "suspended", "closed", "browser_request_start", "server_request_start"}


def diagnostic_clean(value, key: str = "", depth: int = 0):
    if depth > 9:
        return None
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        return number if math.isfinite(number) and abs(number) <= 1e15 else None
    if isinstance(value, str):
        if key in ("session", "id", "voice_binding", "source_build_id") and SESSION_ID.fullmatch(value):
            return value
        if key in ("phase", "audio_context_state", "clock_origin") and value in ENUMS:
            return value
        if key == "request_mode" and value in ("read", "chat"):
            return value
        if key == "content_source" and value in ("user_text", "llm_output"):
            return value
        if key == "engine" and value in ("mock", "faster-qwen3-tts", "qwen-adapter-buffered", "hybrid"):
            return value
        if key == "dtype" and value in ("mock", "fp16", "bf16", "fp32"):
            return value
        if key == "quality_policy" and value in ("sentence-linear", "legacy-stream", "sentence-agc", "sentence-agc-headroom", "windowed-linear"):
            return value
        if key == "codec_policy" and value in ("sentence", "windowed", "adapter-native", "generated-only-25-left-optional-right"):
            return value
        if key == "rt" and value in ("numpy-causal-v1", "numpy-sentence-linear-v1", "mock"):
            return value
        if key == "voice_conditioning" and value in ("mock", "trained-speaker-vector", "speaker-vector-only", "icl-generated-only-codec"):
            return value
        if key == "model_output_mode" and value in ("sentence-buffered", "acoustic-streaming", "profile-dependent"):
            return value
        if key == "event" and value in ("request", "headers", "pcm", "text_delta", "segment_received", "stats", "network_end", "worklet_first_consumed", "playback_drained", "cancelled_event", "superseded_event", "interrupted_event", "error_event"):
            return value
        return None
    if isinstance(value, dict):
        return {str(k): diagnostic_clean(v, str(k), depth + 1) for k, v in value.items() if str(k) in DIAGNOSTIC_FIELDS}
    if isinstance(value, (list, tuple)):
        return [diagnostic_clean(item, key, depth + 1) for item in value[-64:]]
    return None


def diagnostic_map(value: dict) -> dict:
    cleaned = diagnostic_clean(value)
    return cleaned if isinstance(cleaned, dict) else {}


class Metrics:
    def __init__(self):
        self.runs: list[dict] = []
        self.sessions: dict[str, SpeechSession] = {}
        self.total = 0

    def register(self, session):
        self.sessions[session.id] = session

    def unregister(self, session_id: str):
        self.sessions.pop(session_id, None)

    def record(self, run: dict):
        session = self.sessions.get(str(run.get("session", "")))
        if session and session.report_sequence() >= finite_number(run.get("client", {}).get("report_sequence") if isinstance(run.get("client"), dict) else 0):
            run["client"] = copy.deepcopy(session.client_report)
        self.runs.append(run)
        self.runs = self.runs[-100:]
        self.total += 1

    def merge_client(self, report: dict) -> bool:
        session_id = report.get("session", "")
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            return False
        safe = diagnostic_map(report)
        for key in ("request_mode", "content_source", "source_build_id", "source_build_match", "source_build_attested", "acoustic_text_verified", "reference_pcm_splicing", "diagnostic_segments", "diagnostics", "timeline_ms", "per_gpu"):
            safe.pop(key, None)
        safe.update(quality_verified=False, client_untrusted=True, speaker_heard=False)
        sequence = finite_number(safe.get("report_sequence"))
        for run in reversed(self.runs):
            if run.get("session") == session_id:
                old = run.get("client", {})
                if isinstance(old, dict) and finite_number(old.get("report_sequence")) > sequence:
                    return True
                run["client"] = safe
                return True
        session = self.sessions.get(session_id)
        if session:
            if session.report_sequence() <= sequence:
                session.client_report = safe
            return True
        return False

    def snapshot(self) -> dict:
        stages: dict[str, list[float]] = {}
        for run in self.runs:
            for key, value in run.get("timeline_ms", {}).items():
                number = finite_number(value, -1)
                if number >= 0:
                    stages.setdefault(key, []).append(number)
        return {
            "total_runs": self.total, "runs": copy.deepcopy(self.runs),
            "stage_median_ms": {key: statistics.median(values) for key, values in stages.items()},
            "active_sessions": len(self.sessions),
        }

    def diagnostics(self) -> dict:
        active = [session.diagnostic_entry() for session in list(self.sessions.values())[:8]]
        return {
            "schema": "qtts-diagnostics-v1", "total_runs": self.total,
            "runs": [diagnostic_map(run) for run in self.runs[-8:]],
            "active": active, "quality_verified": False, "training_verified": False,
            "clock_origin": "server_request_start", "client_clock_origin": "browser_request_start",
            "physical_speaker_output_verified": False,
        }


METRICS = Metrics()


@app.get("/api/metrics", dependencies=[Depends(require_auth)])
async def metrics():
    return METRICS.snapshot()


@app.get("/api/diagnostics", dependencies=[Depends(require_auth)])
async def diagnostics():
    return METRICS.diagnostics()


@app.post("/api/report", dependencies=[Depends(require_auth)])
async def report(request: Request):
    body = await request.json()
    return {"merged": METRICS.merge_client(body) if isinstance(body, dict) else False}


def retain_segments(rows: list[dict]) -> list[dict]:
    return rows if len(rows) <= 32 else rows[:8] + rows[-24:]


class SegmentJob:
    def __init__(self, session: "SpeechSession", segment: Segment, worker_id: int):
        self.session = session
        self.segment = segment
        self.worker_id = worker_id
        self.queue: asyncio.Queue = asyncio.Queue()
        self.stats: dict | None = None
        self.error = ""
        self.task = asyncio.create_task(self.run())

    async def run(self):
        session = self.session
        worker = WORKERS[self.worker_id]
        session.mark("first_dispatch")
        body = {
            "request_mode": session.mode, "quality_policy": session.quality_policy,
            "diagnostic_session": session.id, "diagnostic_segment": self.segment.index,
            "voice_conditioning": session.profile.get("voice_conditioning", ""),
            "voice_binding": session.profile.get("voice_binding", ""),
            "profile": session.profile["id"], "text": self.segment.text,
            "language": session.language, "chunk_size": FIRST_CHUNK_SIZE if self.segment.index == 0 else 8,
            "lead_pause_ms": self.segment.pause_ms, "breath": self.segment.breath,
            "seed": session.seed,
        }
        started = time.monotonic()
        try:
            async with WORKER_LOCKS[self.worker_id]:
                async with HTTP.stream("POST", worker.url + "/synth", json=body, timeout=900) as response:
                    if response.status_code != 200:
                        self.error = f"worker http {response.status_code}: {(await response.aread())[:400].decode(errors='replace')}"
                        return
                    buffer = bytearray()
                    received_end = False
                    async for chunk in response.aiter_bytes():
                        buffer.extend(chunk)
                        while len(buffer) >= 5:
                            kind, length = struct.unpack("<BI", buffer[:5])
                            if length > 64 * 1024 * 1024:
                                raise ValueError("worker frame exceeds budget")
                            if len(buffer) < 5 + length:
                                break
                            payload = bytes(buffer[5:5 + length])
                            del buffer[:5 + length]
                            if kind == F_PCM:
                                if not self.stats or not self.stats.get("first_gateway_pcm"):
                                    session.mark("first_seg_worker_audio")
                                await self.queue.put(("pcm", payload))
                            elif kind == F_STATS:
                                value = json.loads(payload)
                                if isinstance(value, dict):
                                    self.stats = value
                                    self.stats["worker_roundtrip_ms"] = round((time.monotonic() - started) * 1000, 2)
                                    rtf = finite_number(value.get("rtf_x"))
                                    if rtf > 0:
                                        worker.rtf = rtf if worker.rtf == 0 else worker.rtf + 0.3 * (rtf - worker.rtf)
                            elif kind == F_ERR:
                                value = json.loads(payload)
                                self.error = str(value.get("error", "worker error")) if isinstance(value, dict) else "worker error"
                            elif kind == F_END:
                                received_end = True
                    if buffer:
                        self.error = self.error or "worker stream ended with a truncated frame"
                    elif not received_end and not self.error and self.stats is None:
                        # The preserved worker terminates after F_STATS; F_END is
                        # optional and is not required by the Go scheduler either.
                        self.error = "worker stream ended before stats or terminal frame"
        except asyncio.CancelledError:
            self.error = "cancelled"
            raise
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"[:500]
            worker.last_error = self.error
        finally:
            await self.queue.put(("done", None))


class SpeechSession:
    def __init__(self, body: dict, profile: dict):
        self.id = secrets.token_hex(6)
        self.mode = "read" if body.get("mode") == "read" else "chat"
        self.profile = profile
        self.language = body.get("language") or "Auto"
        if self.language.lower() == "auto":
            self.language = detect_lang(str(body.get("text", "")))
        self.seed = int(body.get("test_seed") if body.get("test_seed") is not None else secrets.randbelow(1 << 30))
        self.quality_policy = body.get("quality_policy") or "legacy-stream"
        self.segmenter = Segmenter(SegCfg.for_profile(profile, self.mode), self.seed)
        self.started = time.monotonic()
        self.timeline: dict[str, float] = {}
        self.jobs: list[SegmentJob] = []
        self.texts: asyncio.Queue[str] = asyncio.Queue()
        self.all_submitted = False
        self.llm_error = ""
        self.chars = 0
        self.delta_count = 0
        self.segment_stats: list[dict] = []
        self.underruns = 0
        self.first_played = 0.0
        self.client_report: dict = {}
        self.producer: asyncio.Task | None = None

    def mark(self, name: str) -> None:
        if name not in self.timeline:
            self.timeline[name] = round((time.monotonic() - self.started) * 1000, 3)

    def report_sequence(self) -> float:
        return finite_number(self.client_report.get("report_sequence"))

    def submit(self, segment: Segment) -> None:
        worker_id = len(self.jobs) % max(1, len(WORKERS))
        self.jobs.append(SegmentJob(self, segment, worker_id))
        self.mark("first_segment")

    def feed(self, text: str) -> None:
        for segment in self.segmenter.feed(text):
            self.submit(segment)

    def push_text(self, text: str) -> None:
        self.chars += len(text)
        self.delta_count += 1
        self.texts.put_nowait(text)

    def start_read(self, text: str) -> None:
        self.mark("read_text_ready")
        self.chars = len(text)
        self.feed(text)
        for segment in self.segmenter.flush():
            self.submit(segment)
        self.all_submitted = True

    def start_chat(self, body: dict, key: str) -> None:
        self.producer = asyncio.create_task(self.produce_chat(body, key))

    async def produce_chat(self, body: dict, key: str) -> None:
        try:
            if not key:
                raise ValueError("DEEPSEEK_API_KEY is not set (set it in Kaggle secrets / env, or paste it in the UI)")
            messages = [{"role": "system", "content": body.get("system") or DEFAULT_SYSTEM}]
            messages.extend({"role": message["role"], "content": message["content"]} for message in (body.get("history") or []))
            messages.append({"role": "user", "content": body["text"]})
            payload = {"model": LLM_MODEL, "messages": messages, "stream": True, "temperature": 0.7, "max_tokens": LLM_MAX_TOKENS}
            self.mark("llm_request_start")
            headers = {"Authorization": "Bearer " + key, "Accept": "text/event-stream"}
            async with HTTP.stream("POST", LLM_BASE + "/chat/completions", json=payload, headers=headers, timeout=90) as response:
                self.mark("llm_response_headers")
                if response.status_code != 200:
                    content = (await response.aread())[:800].decode(errors="replace").strip()
                    raise ValueError(f"llm http {response.status_code}: {content}")
                finished = False
                done_marker = False
                first = True
                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        done_marker = True
                        break
                    try:
                        event = json.loads(data)
                    except ValueError:
                        raise ValueError("invalid LLM stream JSON")
                    if event.get("error"):
                        raise ValueError("LLM stream reported an error")
                    for choice in event.get("choices") or []:
                        delta = (choice.get("delta") or {}).get("content") or ""
                        if delta:
                            if first:
                                self.mark("llm_first_token")
                                first = False
                            self.push_text(delta)
                            self.feed(delta)
                        reason = choice.get("finish_reason")
                        if reason:
                            if reason != "stop":
                                raise ValueError(f"LLM output incomplete (finish_reason={reason})")
                            finished = True
                if not finished and not done_marker and not self.llm_error:
                    self.llm_error = "LLM stream ended before completion"
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.llm_error = str(error)[:800]
        finally:
            for segment in self.segmenter.flush():
                self.submit(segment)
            self.mark("llm_done")
            self.all_submitted = True

    def telemetry(self, body: dict) -> None:
        self.underruns = max(self.underruns, int(finite_number(body.get("underruns"))))
        first = finite_number(body.get("first_played_ms"))
        if first > 0 and not self.first_played:
            self.first_played = first

    def diagnostic_entry(self) -> dict:
        return diagnostic_map({
            "request_mode": self.mode, "content_source": "user_text" if self.mode == "read" else "llm_output",
            "source_build_id": runtime_source_id(), "source_build_attested": False, "acoustic_text_verified": False,
            "session": self.id, "timeline_ms": self.timeline, "chars": self.chars,
            "segments": len(self.jobs), "llm_delta_count": self.delta_count,
            "client": self.client_report, "diagnostic_segments": retain_segments(self.segment_stats),
            "diagnostic_segments_total": len(self.segment_stats), "diagnostic_segments_truncated": len(self.segment_stats) > 32,
        })

    def summary(self, sent_samples: int, errors: list[str], completed: bool) -> dict:
        per_gpu: dict[str, dict] = {}
        anomalies = []
        for stats in self.segment_stats:
            name = f"gpu{stats.get('gpu')}"
            row = per_gpu.setdefault(name, {"segments": 0, "audio_s": 0.0, "gen_s": 0.0, "gain_sum": 0.0, "first_sum": 0.0})
            row["segments"] += 1
            row["audio_s"] += finite_number(stats.get("audio_s"))
            row["gen_s"] += finite_number(stats.get("gen_ms")) / 1000
            row["gain_sum"] += finite_number(stats.get("gain_db"))
            row["first_sum"] += finite_number(stats.get("first_chunk_ms"))
            anomalies.extend(str(value) for value in stats.get("anomalies") or [])
        for row in per_gpu.values():
            if row["gen_s"] > 0:
                row["rtf_x"] = round(row["audio_s"] / row["gen_s"], 3)
                row["rtf"] = round(row["gen_s"] / row["audio_s"], 4) if row["audio_s"] else None
            if row["segments"]:
                row["gain_db_mean"] = round(row.pop("gain_sum") / row["segments"], 2)
                row["first_chunk_ms_mean"] = round(row.pop("first_sum") / row["segments"])
        audio = sent_samples / SAMPLE_RATE
        wall = time.monotonic() - self.started
        return {
            "request_mode": self.mode, "content_source": "user_text" if self.mode == "read" else "llm_output",
            "source_build_id": runtime_source_id(), "source_build_attested": False, "acoustic_text_verified": False,
            "session": self.id, "at": datetime.now(timezone.utc).isoformat(), "chars": self.chars,
            "segments": len(self.jobs), "audio_s": round(audio, 2), "wall_s": round(wall, 2),
            "overall_rtf_x": round(audio / max(wall, 0.001), 2),
            "diagnostic_segments": retain_segments(self.segment_stats),
            "diagnostic_segments_total": len(self.segment_stats), "diagnostic_segments_truncated": len(self.segment_stats) > 32,
            "client": copy.deepcopy(self.client_report), "llm_delta_count": self.delta_count,
            "llm_error": bool(self.llm_error), "error_count": len(errors),
            "timeline_ms": dict(self.timeline), "per_gpu": per_gpu, "anomalies": anomalies,
            "errors": errors, "underruns": self.underruns, "client_first_played_ms": self.first_played,
            "profile": self.profile["id"], "policy": policy_for(aggregate_rtf(), self.underruns),
            "generation_completed": completed, "stream_interrupted": not completed,
            "quality_verified": False,
        }

    async def stream(self):
        current = 0
        sent_samples = 0
        errors: list[str] = []
        completed = False
        llm_error_sent = False
        current_started = False
        final_pass = False
        policy_sent = time.monotonic()
        try:
            yield json_frame(C_POLICY, 0, policy_for(aggregate_rtf(), self.underruns))
            while True:
                while not self.texts.empty():
                    yield json_frame(C_TEXT, 0, {"t": self.texts.get_nowait()})
                if self.llm_error and not llm_error_sent:
                    llm_error_sent = True
                    errors.append(self.llm_error)
                    yield json_frame(C_ERROR, 0, {"error": self.llm_error, "stage": "llm"})
                if current >= len(self.jobs):
                    current_started = False
                    if self.all_submitted:
                        if final_pass and self.texts.empty():
                            break
                        final_pass = True
                        await asyncio.sleep(0.02)
                        continue
                    await asyncio.sleep(0.04)
                    continue
                job = self.jobs[current]
                if not current_started:
                    current_started = True
                    if time.monotonic() - policy_sent > 0.7:
                        policy_sent = time.monotonic()
                        yield json_frame(C_POLICY, 0, policy_for(aggregate_rtf(), self.underruns))
                    yield json_frame(C_SEG, current, job.segment.as_dict())
                try:
                    kind, payload = await asyncio.wait_for(job.queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                if kind == "pcm":
                    sent_samples += len(payload) // 2
                    self.mark("first_audio_sent")
                    yield frame(C_PCM, current, payload)
                    continue
                if job.error and job.error != "cancelled":
                    message = f"seg {current}: {job.error}"
                    errors.append(message)
                    yield json_frame(C_ERROR, current, {"error": job.error, "stage": "tts"})
                if job.stats:
                    self.segment_stats.append(job.stats)
                    yield json_frame(C_STATS, current, job.stats)
                current += 1
                current_started = False
                final_pass = False
            self.mark("all_audio_sent")
            completed = True
            run = self.summary(sent_samples, errors, True)
            METRICS.record(run)
            yield json_frame(C_END, 0, run)
        finally:
            if not completed:
                METRICS.record(self.summary(sent_samples, errors, False))
            if self.producer:
                self.producer.cancel()
            for job in self.jobs:
                job.task.cancel()
            METRICS.unregister(self.id)


_SOURCE_ID = ""


def runtime_source_id() -> str:
    global _SOURCE_ID
    if not _SOURCE_ID:
        hasher = hashlib.sha256()
        for path in (Path(__file__), ROOT / "py" / "worker.py", ROOT / "py" / "analyst.py"):
            try:
                hasher.update(path.read_bytes())
            except OSError:
                pass
        _SOURCE_ID = hasher.hexdigest()
    return _SOURCE_ID


def validate_speak(body: dict) -> None:
    if not isinstance(body, dict):
        raise HTTPException(400, "JSON object required")
    if not isinstance(body.get("text"), str) or not body["text"].strip():
        raise HTTPException(400, "text is empty")
    if len(body["text"]) > 20000:
        raise HTTPException(400, "text exceeds 20000 characters")
    if body.get("mode") not in (None, "read", "chat"):
        raise HTTPException(400, "unsupported request mode")
    if body.get("language") is not None and not isinstance(body.get("language"), str):
        raise HTTPException(400, "invalid language")
    if body.get("system") is not None and (not isinstance(body.get("system"), str) or len(body["system"]) > 12000):
        raise HTTPException(400, "invalid system prompt")
    if body.get("quality_policy") not in (None, "", "legacy-stream", "sentence-linear", "sentence-agc", "sentence-agc-headroom", "windowed-linear"):
        raise HTTPException(400, "unsupported quality policy or test seed")
    seed = body.get("test_seed")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647):
        raise HTTPException(400, "unsupported quality policy or test seed")
    history = body.get("history") or []
    if not isinstance(history, list) or len(history) > 16:
        raise HTTPException(400, "invalid chat history")
    for message in history:
        if not isinstance(message, dict) or message.get("role") not in ("user", "assistant") or not isinstance(message.get("content"), str) or len(message["content"]) > 12000:
            raise HTTPException(400, "invalid chat history")


@app.post("/api/speak", dependencies=[Depends(require_auth)])
async def speak(request: Request):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_SPEAK_BYTES:
        raise HTTPException(413, "request too large")
    raw = await bounded_body(request, MAX_SPEAK_BYTES)
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "invalid JSON")
    validate_speak(body)
    body["text"] = body["text"].strip()
    profile_id = body.get("profile") or active_profile(STATE)
    if not profile_id:
        raise HTTPException(400, "no voice profile selected: create one in the Voice Lab first")
    if not isinstance(profile_id, str) or not PROFILE_ID.fullmatch(profile_id):
        raise HTTPException(400, "invalid profile id")
    try:
        profile = load_profile(STATE, profile_id, MOCK)
    except (OSError, ValueError) as error:
        raise HTTPException(400, str(error))
    session = SpeechSession(body, profile)
    METRICS.register(session)
    if session.mode == "read":
        session.start_read(body["text"])
    else:
        session.start_chat(body, request.headers.get("x-deepseek-key") or LLM_KEY)
    return StreamingResponse(
        session.stream(), media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store", "X-Accel-Buffering": "no",
            "X-Session-Id": session.id, "Access-Control-Expose-Headers": "X-Session-Id",
        },
    )


@app.post("/api/telemetry", dependencies=[Depends(require_auth)])
async def telemetry(request: Request):
    body = await request.json()
    session = METRICS.sessions.get(str(body.get("session", ""))) if isinstance(body, dict) else None
    if not session:
        raise HTTPException(404, "no such session")
    session.telemetry(body)
    return Response(status_code=204)


def index_content(request: Request) -> str:
    content = (WEB / "index.html").read_text(encoding="utf-8")
    if AUTO_OPEN and not valid_cookie(request):
        try:
            grant = new_grant()
        except HTTPException:
            return content
        bootstrap = f'<script>window.location.hash="qtts-entry={grant}";</script>'
        content = content.replace('<script src="app.js"></script>', bootstrap + '<script src="app.js"></script>', 1)
    return content


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
async def index(request: Request):
    return HTMLResponse(index_content(request), headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@app.get("/{asset}", include_in_schema=False)
async def static_asset(asset: str):
    if asset not in ("app.js", "recorder.js", "diagnostic-trace.js", "kaggle-source.js"):
        raise HTTPException(404, "not found")
    return FileResponse(WEB / asset, headers={"Cache-Control": "no-cache", "Referrer-Policy": "no-referrer"})
