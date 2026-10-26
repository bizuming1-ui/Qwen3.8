#!/usr/bin/env python3
"""Reproducibly repack the reviewed QTTS assets into the user's one-cell Notebook.

The Notebook is parsed as AST data, never executed.  Arena-only adapters and the
derived kaggle-source.js file are deliberately not embedded (the latter would
recursively contain the Notebook itself).
"""
from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import json
import pprint
import shutil
import zlib
from pathlib import Path, PurePosixPath

from import_qtts import notebook_source, packed_assets

NEW_SHARED_ASSETS = (
    "go/gateway/training_proxy_test.go",
    "py/simple_preparation.py",
    "py/training_control.py",
    "py/training_service.py",
)
EXCLUDED = {"ASSET-MANIFEST.json", "web/kaggle-source.js"}


def asset_bytes(root: Path, name: str) -> bytes:
    path = root.joinpath(*PurePosixPath(name).parts)
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"missing or unsafe shared asset: {name}")
    return path.read_bytes()


def pack(notebook: Path, root: Path, *, backup: Path | None = None) -> str:
    original = notebook.read_bytes()
    source = notebook_source(notebook)
    old_assets = packed_assets(source)
    names = list(old_assets)
    for name in NEW_SHARED_ASSETS:
        if name not in names:
            names.append(name)
    # Keep the original resource set and add only explicitly reviewed shared files.
    for name in names:
        if name in EXCLUDED or name.startswith(("arena_", "py/arena_")):
            raise ValueError(f"arena-only asset cannot be packed: {name}")
    assets = {}
    for name in names:
        raw = asset_bytes(root, name)
        assets[name] = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                        "data": base64.b64encode(zlib.compress(raw, 9)).decode("ascii")}
    tree = ast.parse(source)
    assignment = next((node for node in tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == "FILES" for target in node.targets)), None)
    if assignment is None or not hasattr(assignment, "end_lineno"):
        raise ValueError("FILES assignment location unavailable")
    lines = source.splitlines(keepends=True)
    rendered = "FILES = " + pprint.pformat(assets, width=100, sort_dicts=False) + "\n"
    source = "".join(lines[:assignment.lineno - 1]) + rendered + "".join(lines[assignment.end_lineno:])
    if "os.environ.setdefault('QTTS_TTS_ENGINE','hybrid')" not in source:
        source = source.replace(
            "QTTS_MOCK='0',QTTS_NO_RUST='1',PYTHONUNBUFFERED='1')",
            "QTTS_MOCK='0',QTTS_NO_RUST='1',PYTHONUNBUFFERED='1')\n   os.environ.setdefault('QTTS_TTS_ENGINE','hybrid');os.environ.setdefault('QTTS_TRAINING_ENABLED','1')",
            1,
        )
    source = source.replace("ports={7001,7002,7010,7860}", "ports={7001,7002,7010,7020,7860}", 1)
    source = source.replace(
        "configured=[os.environ.get('QTTS_GATEWAY_PORT','7860'),os.environ.get('QTTS_ANALYST_PORT','7010')]",
        "configured=[os.environ.get('QTTS_GATEWAY_PORT','7860'),os.environ.get('QTTS_ANALYST_PORT','7010'),os.environ.get('QTTS_TRAINING_PORT','7020')]",
        1,
    )
    source = source.replace(
        "Kaggle TTS one-cell paste-and-run candidate, re-packed from the user's SHA-verified 70-asset upload.",
        "Kaggle TTS one-cell paste-and-run candidate with audited simple real-training orchestration.",
        1,
    )
    source = source.replace(
        "The new hybrid mode is an unvalidated experiment; runtime/model/audio quality must still be checked and auditioned in Kaggle.",
        "The simple training flow prepares complete ASR text internally, then runs real CPU encoding and two-rank LoRA only after strict hardware/model gates; MOCK and optimizer receipts are not quality verification.",
        1,
    )
    ast.parse(source)
    document = json.loads(original)
    document["cells"][0]["source"] = source.splitlines(keepends=True)
    document["cells"][0]["outputs"] = []
    document["cells"][0]["execution_count"] = None
    if backup is not None:
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            backup.write_bytes(original)
    temporary = notebook.with_suffix(notebook.suffix + ".packing")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    temporary.replace(notebook)
    manifest = {
        "schema": 1,
        "source_notebook": str(notebook),
        "source_notebook_sha256": hashlib.sha256(notebook.read_bytes()).hexdigest(),
        "asset_count": len(assets),
        "assets": {name: {"bytes": meta["bytes"], "sha256": meta["sha256"]} for name, meta in sorted(assets.items())},
        "verification": "AST repack from reviewed working-tree assets; derived browser source and Arena adapters are intentionally external.",
    }
    (root / "ASSET-MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # This is a derived browser convenience asset, not a recursive Notebook resource.
    (root / "web" / "kaggle-source.js").write_text(
        "window.QTTS_KAGGLE_SOURCE = " + json.dumps(source, ensure_ascii=False) + ";\n", encoding="utf-8")
    # A plain-text companion is convenient for users who prefer downloading or
    # selecting the complete cell instead of using the browser clipboard API.
    notebook.with_suffix(".py").write_text(source, encoding="utf-8")
    return source


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notebook", type=Path, default=Path("kaggle/working/voice_cloning.ipynb"))
    parser.add_argument("--root", type=Path, default=Path("qtts"))
    parser.add_argument("--backup", type=Path, default=Path("/tmp/voice_cloning.before-simple-training.ipynb"))
    args = parser.parse_args()
    source = pack(args.notebook, args.root, backup=args.backup)
    print(f"packed {len(packed_assets(source))} shared assets; Notebook source {len(source)} bytes; browser copy asset regenerated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
