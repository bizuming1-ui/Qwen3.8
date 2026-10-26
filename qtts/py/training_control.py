"""Small authenticated-by-locality control file protocol for GPU handoff.

Only a fixed pause/resume action is accepted.  No command, path, PID, or shell
text crosses this boundary.  Writes are atomic and every request has a nonce so
an old acknowledgement cannot complete a newer operation.
"""
from __future__ import annotations

import re
import time
import uuid
from pathlib import Path

from qtts_common import read_json, write_json_atomic

JOB = re.compile(r"[0-9a-f]{12,32}\Z")
NONCE = re.compile(r"[0-9a-f]{32}\Z")


def request(state, job, action):
    if action not in ("pause", "resume") or not isinstance(job, str) or not JOB.fullmatch(job):
        raise ValueError("invalid training control request")
    nonce = uuid.uuid4().hex
    value = {"schema": 1, "job": job, "action": action, "nonce": nonce, "created": time.time()}
    write_json_atomic(Path(state) / "training-control.json", value)
    return nonce


def read_request(state):
    value = read_json(Path(state) / "training-control.json", {})
    if not isinstance(value, dict) or set(value) != {"schema", "job", "action", "nonce", "created"}:
        return None
    if value.get("schema") != 1 or value.get("action") not in ("pause", "resume"):
        return None
    if not isinstance(value.get("job"), str) or not JOB.fullmatch(value["job"]):
        return None
    if not isinstance(value.get("nonce"), str) or not NONCE.fullmatch(value["nonce"]):
        return None
    if not isinstance(value.get("created"), (int, float)) or isinstance(value.get("created"), bool):
        return None
    return value


def acknowledge(state, job, nonce, status, **extra):
    if not JOB.fullmatch(job) or not NONCE.fullmatch(nonce):
        raise ValueError("invalid training control acknowledgement")
    value = {"schema": 1, "job": job, "nonce": nonce, "status": status, "created": time.time(), **extra}
    write_json_atomic(Path(state) / "training-control-ack.json", value)


def read_ack(state, job, nonce):
    value = read_json(Path(state) / "training-control-ack.json", {})
    if not isinstance(value, dict) or value.get("schema") != 1:
        return None
    if value.get("job") != job or value.get("nonce") != nonce:
        return None
    if value.get("status") not in ("paused", "resumed", "error"):
        return None
    return value
