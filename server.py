#!/usr/bin/env python3
"""Small, dependency-free local server for the Qwen3.8 Voice Lab workspace.

The server saves notebook source and .ipynb files into this repository. Its
"run" feature is deliberately a static preflight simulator; it never executes
uploaded Python code.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent
WEB_ROOT = PROJECT_ROOT / "web"
NOTEBOOK_DIR = PROJECT_ROOT / "notebooks"
EXPERIMENT_DIR = PROJECT_ROOT / "experiments"
MAX_CODE_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 12 * 1024 * 1024
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
CELL_MARKER_PATTERN = re.compile(r"^\s*#\s*%%(?:\s*\[([A-Za-z]+)\])?.*$")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "Notebook name must be a string.")
    name = value.strip()
    if not NAME_PATTERN.fullmatch(name):
        raise ApiError(
            400,
            "Use 1–80 ASCII letters, numbers, hyphens, or underscores; start with a letter or number.",
        )
    return name


def _source_lines(source: str) -> list[str]:
    return source.splitlines(keepends=True) if source else []


def _markdown_source(source: str) -> str:
    """Undo the conventional comment-prefix used by Jupytext markdown cells."""
    lines = source.splitlines(keepends=True)
    result: list[str] = []
    for line in lines:
        ending = ""
        body = line
        if body.endswith("\r\n"):
            body, ending = body[:-2], "\r\n"
        elif body.endswith(("\n", "\r")):
            body, ending = body[:-1], body[-1:]
        if body.startswith("# "):
            body = body[2:]
        elif body == "#":
            body = ""
        result.append(body + ending)
    return "".join(result)


def parse_code_cells(code: str) -> list[dict[str, Any]]:
    """Split Jupytext-style # %% markers into nbformat cells."""
    lines = code.splitlines(keepends=True)
    markers: list[tuple[int, re.Match[str]]] = []
    for index, line in enumerate(lines):
        match = CELL_MARKER_PATTERN.match(line.rstrip("\r\n"))
        if match:
            markers.append((index, match))

    def make_cell(cell_type: str, source: str) -> dict[str, Any] | None:
        if not source.strip():
            return None
        if cell_type == "markdown":
            return {
                "cell_type": "markdown",
                "id": uuid.uuid4().hex[:8],
                "metadata": {},
                "source": _source_lines(_markdown_source(source)),
            }
        if cell_type == "raw":
            return {"cell_type": "raw", "id": uuid.uuid4().hex[:8], "metadata": {}, "source": _source_lines(source)}
        return {
            "cell_type": "code",
            "id": uuid.uuid4().hex[:8],
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": _source_lines(source),
        }

    if not markers:
        return [make_cell("code", code)] if code.strip() else []  # type: ignore[list-item]

    cells: list[dict[str, Any]] = []
    current: list[str] = []
    current_type = "code"
    for index, line in enumerate(lines):
        match = CELL_MARKER_PATTERN.match(line.rstrip("\r\n"))
        if match:
            cell = make_cell(current_type, "".join(current))
            if cell is not None:
                cells.append(cell)
            current = []
            marker_type = (match.group(1) or "code").lower()
            current_type = marker_type if marker_type in {"code", "markdown", "raw"} else "code"
            continue
        current.append(line)
    cell = make_cell(current_type, "".join(current))
    if cell is not None:
        cells.append(cell)
    return cells


def _atomic_write_text(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(contents, encoding="utf-8", newline="")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _read_metadata(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_notebook(payload: Any, notebook_dir: Path = NOTEBOOK_DIR) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object.")
    name = validate_name(payload.get("name"))
    code = payload.get("code")
    if not isinstance(code, str):
        raise ApiError(400, "Notebook code must be a string.")
    if not code.strip():
        raise ApiError(400, "Paste some notebook code before saving.")
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise ApiError(413, "Notebook code is larger than the 8 MB project-save limit.")

    title = payload.get("title", name)
    if not isinstance(title, str):
        title = name
    title = title.strip()[:120] or name
    description = payload.get("description", "")
    if not isinstance(description, str):
        description = ""
    description = description.strip()[:500]
    runtime = payload.get("runtime", "Local CPU · simulated")
    if not isinstance(runtime, str):
        runtime = "Local CPU · simulated"
    runtime = runtime.strip()[:80]

    saved_at = utc_now()
    notebook = {
        "cells": parse_code_cells(code),
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
            "qwen_voice_lab": {"saved_at": saved_at, "runtime_label": runtime},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    metadata = {
        "name": name,
        "title": title,
        "description": description,
        "runtime": runtime,
        "saved_at": saved_at,
        "source_file": f"notebooks/{name}.py",
        "notebook_file": f"notebooks/{name}.ipynb",
    }

    notebook_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(notebook_dir / f"{name}.py", code)
    _atomic_write_text(notebook_dir / f"{name}.ipynb", json.dumps(notebook, ensure_ascii=False, indent=2) + "\n")
    _atomic_write_text(notebook_dir / f"{name}.meta.json", json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    return metadata


def list_notebooks(notebook_dir: Path = NOTEBOOK_DIR) -> list[dict[str, Any]]:
    if not notebook_dir.exists():
        return []
    result: list[dict[str, Any]] = []
    for source_path in notebook_dir.glob("*.py"):
        metadata = _read_metadata(notebook_dir / f"{source_path.stem}.meta.json")
        try:
            updated_at = datetime.fromtimestamp(source_path.stat().st_mtime, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            size_bytes = source_path.stat().st_size
        except OSError:
            updated_at, size_bytes = "", 0
        result.append(
            {
                "name": source_path.stem,
                "title": metadata.get("title", source_path.stem),
                "description": metadata.get("description", ""),
                "runtime": metadata.get("runtime", ""),
                "saved_at": metadata.get("saved_at", updated_at),
                "source_file": f"notebooks/{source_path.name}",
                "notebook_file": f"notebooks/{source_path.stem}.ipynb",
                "size_bytes": size_bytes,
            }
        )
    return sorted(result, key=lambda item: item.get("saved_at", ""), reverse=True)


def load_notebook(name: str, notebook_dir: Path = NOTEBOOK_DIR) -> dict[str, Any]:
    safe_name = validate_name(name)
    source_path = notebook_dir / f"{safe_name}.py"
    if not source_path.is_file():
        raise ApiError(404, "Notebook not found in this project.")
    metadata = _read_metadata(notebook_dir / f"{safe_name}.meta.json")
    try:
        code = source_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ApiError(500, f"Could not read notebook: {error}") from error
    return {**metadata, "name": safe_name, "code": code}


def _clean_checks(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    for item in value[:16]:
        if not isinstance(item, dict):
            continue
        label = item.get("label", "Check")
        detail = item.get("detail", "")
        status = item.get("status", "info")
        if not isinstance(label, str) or not isinstance(detail, str) or not isinstance(status, str):
            continue
        if status not in {"ok", "warning", "info"}:
            status = "info"
        result.append({"label": label[:100], "detail": detail[:400], "status": status})
    return result


def save_experiment(payload: Any, experiment_dir: Path = EXPERIMENT_DIR) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object.")
    notebook_name = validate_name(payload.get("notebook_name"))
    checks = _clean_checks(payload.get("checks"))
    config = payload.get("config", {})
    if not isinstance(config, dict):
        config = {}
    safe_config: dict[str, str | int | float | bool | None] = {}
    for key in ("runtime", "epochs", "batch_size", "sample_rate"):
        value = config.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            safe_config[key] = value
    code_stats = payload.get("code_stats", {})
    if not isinstance(code_stats, dict):
        code_stats = {}
    safe_stats = {
        key: max(0, min(int(code_stats.get(key, 0)), 10_000_000))
        for key in ("characters", "lines", "cells")
        if isinstance(code_stats.get(key, 0), (int, float))
    }
    created_at = utc_now()
    run_id = uuid.uuid4().hex[:8]
    record = {
        "id": run_id,
        "notebook_name": notebook_name,
        "created_at": created_at,
        "mode": "static_preflight_simulation",
        "status": "simulated",
        "config": safe_config,
        "code_stats": safe_stats,
        "checks": checks,
        "note": "Static preview only. No Python code, model training, Kaggle kernel, or GPU was executed.",
    }
    filename = f"{notebook_name}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{run_id}.json"
    experiment_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(experiment_dir / filename, json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    return record


def list_experiments(experiment_dir: Path = EXPERIMENT_DIR, limit: int = 30) -> list[dict[str, Any]]:
    if not experiment_dir.exists():
        return []
    records: list[dict[str, Any]] = []
    for path in experiment_dir.glob("*.json"):
        record = _read_metadata(path)
        if record.get("mode") == "static_preflight_simulation":
            records.append(record)
    records.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return records[: max(1, min(limit, 100))]


class WorkspaceHandler(BaseHTTPRequestHandler):
    server_version = "Qwen38VoiceLab/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}", flush=True)

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, value: Any) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _read_json(self) -> Any:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(400, "Invalid Content-Length.") from error
        if length <= 0:
            raise ApiError(400, "Request body is empty.")
        if length > MAX_REQUEST_BYTES:
            raise ApiError(413, "Request body is larger than the 12 MB limit.")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError(400, "Request body must be valid UTF-8 JSON.") from error

    def _api_call(self, function: Any, *args: Any, **kwargs: Any) -> None:
        try:
            self._send_json(200, function(*args, **kwargs))
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})
        except (OSError, ValueError, TypeError) as error:
            self._send_json(500, {"error": f"Project storage error: {error}"})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path == "/api/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "Qwen3.8 Voice Lab",
                    "python": sys.version.split()[0],
                    "persistence": "project files",
                    "notebook_directory": "notebooks/",
                    "experiment_directory": "experiments/",
                },
            )
            return
        if path == "/api/notebooks":
            self._api_call(list_notebooks)
            return
        if path.startswith("/api/notebooks/"):
            name = path.removeprefix("/api/notebooks/")
            self._api_call(load_notebook, name)
            return
        if path == "/api/experiments":
            query = parse_qs(parsed.query)
            try:
                limit = int(query.get("limit", ["30"])[0])
            except ValueError:
                limit = 30
            self._api_call(list_experiments, EXPERIMENT_DIR, limit)
            return
        static_paths = {
            "/": WEB_ROOT / "index.html",
            "/index.html": WEB_ROOT / "index.html",
            "/app.js": WEB_ROOT / "app.js",
            "/styles.css": WEB_ROOT / "styles.css",
            "/favicon.svg": WEB_ROOT / "favicon.svg",
        }
        static_path = static_paths.get(path)
        if static_path is None or not static_path.is_file():
            self._send_json(404, {"error": "Not found."})
            return
        content_type = mimetypes.guess_type(static_path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "image/svg+xml"}:
            content_type += "; charset=utf-8"
        try:
            self._send_bytes(200, static_path.read_bytes(), content_type)
        except OSError as error:
            self._send_json(500, {"error": f"Could not read workspace asset: {error}"})

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(urlsplit(self.path).path)
        try:
            payload = self._read_json()
            if path == "/api/notebooks":
                self._api_call(save_notebook, payload)
            elif path == "/api/experiments":
                self._api_call(save_experiment, payload)
            else:
                self._send_json(404, {"error": "Not found."})
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), WorkspaceHandler)
    print(f"Qwen3.8 Voice Lab running on http://{host}:{port}", flush=True)
    print("Notebook files will be saved in ./notebooks/ and preview records in ./experiments/.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
