"""Run the preserved QTTS supervisor with the Python gateway adapter.

Only the gateway child command is replaced. Worker, analyst, watchdog, ownership,
profile re-arming, and shutdown behavior continue to come from supervisor.py.
"""
from __future__ import annotations

import os
import supervisor as original


_original_build_procs = original.build_procs


def build_procs_with_adapter() -> list[original.Proc]:
    processes = _original_build_procs()
    gateway = next(process for process in processes if process.name == "gateway")
    gateway.cmd = [
        original.PY, "-m", "uvicorn", "arena_gateway:app",
        "--app-dir", str(original.ROOT / "py"),
        "--host", os.environ.get("QTTS_BIND", "127.0.0.1"),
        "--port", str(original.GATEWAY_PORT), "--log-level", "warning",
    ]
    gateway.env = {key: value for key, value in gateway.env.items() if key != "QTTS_BIND"}
    return processes


original.build_procs = build_procs_with_adapter


if __name__ == "__main__":
    raise SystemExit(original.main())
