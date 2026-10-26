#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tools"
DOWNLOADS="$TOOLS/downloads"
FFMPEG_NPM_VERSION="4.1.0"
mkdir -p "$DOWNLOADS" "$TOOLS/bin"

# This npm platform package contains the ELF binary itself, so installation does
# not depend on GitHub's release-assets redirect host.
if [[ ! -x "$TOOLS/bin/ffmpeg" ]]; then
  echo "Installing the npm-packaged Linux x64 FFmpeg $FFMPEG_NPM_VERSION"
  ARCHIVE="$(npm pack "@ffmpeg-installer/linux-x64@${FFMPEG_NPM_VERSION}" --pack-destination "$DOWNLOADS" --silent)"
  rm -rf "$TOOLS/ffmpeg-extract"
  mkdir -p "$TOOLS/ffmpeg-extract"
  tar -xzf "$DOWNLOADS/$ARCHIVE" -C "$TOOLS/ffmpeg-extract"
  if [[ ! -f "$TOOLS/ffmpeg-extract/package/ffmpeg" ]]; then
    echo "FFmpeg npm package did not contain its Linux binary" >&2
    exit 1
  fi
  cp "$TOOLS/ffmpeg-extract/package/ffmpeg" "$TOOLS/bin/ffmpeg"
  chmod 755 "$TOOLS/bin/ffmpeg"
  rm -rf "$TOOLS/ffmpeg-extract"
fi

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$ROOT/.venv/bin/python" -m pip install --disable-pip-version-check -r "$ROOT/qtts/requirements-runtime.txt"

cd "$ROOT"
"$ROOT/.venv/bin/python" -m py_compile qtts/py/*.py qtts/tools/*.py
"$TOOLS/bin/ffmpeg" -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:duration=0.05' -f null -

printf '\nQTTS browser runtime is ready.\n'
"$TOOLS/bin/ffmpeg" -version | sed -n '1p'
"$ROOT/.venv/bin/python" -c 'import numpy, scipy, fastapi, httpx, soundfile, librosa, noisereduce; print("Python audio/runtime dependencies verified")'
echo 'Preserved Go gateway source: qtts/go/gateway (a Go toolchain is not required for the Python protocol-compatible runtime).'
