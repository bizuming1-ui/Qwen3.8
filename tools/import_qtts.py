#!/usr/bin/env python3
"""Safely unpack the user's SHA-verified QTTS Kaggle launcher.

The notebook is parsed as Python AST data only. No notebook statement is executed.
Every asset is checked against its declared byte count and SHA-256 before writing.
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import zlib


def notebook_source(path: Path) -> str:
    document = json.loads(path.read_text(encoding="utf-8"))
    cells = document.get("cells")
    if not isinstance(cells, list) or not cells:
        raise ValueError("notebook has no cells")
    source = cells[0].get("source", "")
    return "".join(source) if isinstance(source, list) else str(source)


def packed_assets(source: str) -> dict:
    tree = ast.parse(source)
    assignment = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "FILES" for target in node.targets)
        ),
        None,
    )
    if assignment is None:
        raise ValueError("FILES assignment was not found")
    value = ast.literal_eval(assignment.value)
    if not isinstance(value, dict):
        raise ValueError("FILES is not a dictionary")
    return value


def decode_asset(name: str, metadata: dict) -> bytes:
    if not isinstance(metadata, dict) or not {"bytes", "sha256", "data"} <= set(metadata):
        raise ValueError(f"invalid metadata for {name}")
    compressed = base64.b64decode(metadata["data"], validate=True)
    try:
        raw = zlib.decompress(compressed)
    except zlib.error:
        raw = compressed
    if len(raw) != metadata["bytes"]:
        raise ValueError(f"byte count mismatch for {name}")
    if hashlib.sha256(raw).hexdigest() != metadata["sha256"]:
        raise ValueError(f"SHA-256 mismatch for {name}")
    return raw


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".import-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notebook", type=Path, default=Path("kaggle/working/voice_cloning.ipynb"))
    parser.add_argument("--destination", type=Path, default=Path("qtts"))
    parser.add_argument("--force", action="store_true", help="replace locally modified destination assets")
    parser.add_argument("--verify-only", action="store_true", help="verify existing files without writing assets")
    args = parser.parse_args()

    notebook_bytes = args.notebook.read_bytes()
    assets = packed_assets(notebook_source(args.notebook))
    decoded = {}
    for name, metadata in assets.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or not name:
            raise ValueError(f"unsafe asset path: {name}")
        decoded[name] = decode_asset(name, metadata)

    for name, content in decoded.items():
        destination = args.destination.joinpath(*PurePosixPath(name).parts)
        if args.verify_only:
            if not destination.is_file() or destination.read_bytes() != content:
                raise ValueError(f"destination differs from verified source: {destination}")
            continue
        if destination.exists() and destination.read_bytes() != content and not args.force:
            raise FileExistsError(f"refusing to overwrite modified asset without --force: {destination}")
        if not destination.exists() or destination.read_bytes() != content:
            atomic_write(destination, content)

    manifest = {
        "schema": 1,
        "source_notebook": str(args.notebook),
        "source_notebook_sha256": hashlib.sha256(notebook_bytes).hexdigest(),
        "asset_count": len(decoded),
        "assets": {
            name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            for name, content in sorted(decoded.items())
        },
        "verification": "All assets decoded without executing the notebook and passed byte-count/SHA-256 checks.",
    }
    if not args.verify_only:
        atomic_write(args.destination / "ASSET-MANIFEST.json", (json.dumps(manifest, indent=2) + "\n").encode())
    action = "Verified" if args.verify_only else "Imported"
    print(f"{action} {len(decoded)} SHA-verified QTTS assets in {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
