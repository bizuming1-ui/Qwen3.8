#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "$ROOT/.venv/bin/python" || ! -f "$ROOT/qtts/py/arena_gateway.py" || ! -x "$ROOT/.tools/bin/ffmpeg" ]]; then
  echo "QTTS runtime is not installed. Run: npm run qtts:setup" >&2
  exit 1
fi

export PATH="$ROOT/.tools/bin:$PATH"
export QTTS_ROOT="$ROOT/qtts"
export QTTS_STATE="${QTTS_STATE:-$ROOT/qtts/state}"
export QTTS_BIND="${QTTS_BIND:-0.0.0.0}"
export QTTS_GATEWAY_PORT="${PORT:-${QTTS_GATEWAY_PORT:-3000}}"
export QTTS_WORKER_PORTS="${QTTS_WORKER_PORTS:-7001,7002}"
export QTTS_ANALYST_PORT="${QTTS_ANALYST_PORT:-7010}"
export QTTS_MOCK="${QTTS_MOCK:-1}"
export QTTS_MOCK_SPEED="${QTTS_MOCK_SPEED:-3.0}"
export QTTS_NO_RUST="${QTTS_NO_RUST:-1}"
export QTTS_AUTO_OPEN="${QTTS_AUTO_OPEN:-1}"
export QTTS_AUTOENTRY_ALLOW_LOOPBACK_HTTP="${QTTS_AUTOENTRY_ALLOW_LOOPBACK_HTTP:-1}"
# The preview is embedded on a different top-level origin. Keep the session
# HttpOnly, but allow its Secure cookie in that iframe; production stays Strict.
export QTTS_AUTOENTRY_SAMESITE="${QTTS_AUTOENTRY_SAMESITE:-none}"
if [[ -n "${E2B_SANDBOX_ID:-}" ]]; then
  # The proxy may forward a loopback Host while retaining the public Origin.
  # Pin the exact preview host instead of accepting arbitrary cross-origin hosts.
  export QTTS_PUBLIC_HOST="${QTTS_PUBLIC_HOST:-${QTTS_GATEWAY_PORT}-${E2B_SANDBOX_ID}.e2b.app}"
fi
export PYTHONUNBUFFERED=1

mkdir -p "$QTTS_STATE"
echo "Starting QTTS on 0.0.0.0:$QTTS_GATEWAY_PORT (mock=$QTTS_MOCK, auto-open=$QTTS_AUTO_OPEN)"
exec "$ROOT/.venv/bin/python" "$ROOT/qtts/py/arena_supervisor.py"
