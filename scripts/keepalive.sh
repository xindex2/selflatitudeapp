#!/usr/bin/env bash
# Keeps the Companion API running on hosts that have no process manager
# (shared cPanel without "Setup Node.js App"). Harmless if it is already running.
#
# cPanel -> Cron Jobs, every five minutes:
#   */5 * * * * /home/USER/selflatitudeapp/scripts/keepalive.sh >/dev/null 2>&1
#
# Cron runs with a minimal PATH, so set NODE_BIN below if `node` is not found.
set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR" || exit 1

# Load PORT (and anything else) from the server environment file.
if [ -f server/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./server/.env
  set +a
fi
PORT="${PORT:-5111}"
LOG_DIR="${HOME}/logs"
LOG_FILE="${LOG_DIR}/companion.log"

# Find node: an explicit path, then nvm, then PATH.
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && [ -s "${HOME}/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 && NODE_BIN="$(command -v node || true)"
fi
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "$(date -u +%FT%TZ) keepalive: node not found. Set NODE_BIN in this script." >&2
  exit 1
fi

# Already answering? Nothing to do.
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  exit 0
fi

if [ ! -f server/dist/index.js ]; then
  echo "$(date -u +%FT%TZ) keepalive: server/dist/index.js is missing. Run 'npm run build'." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
echo "$(date -u +%FT%TZ) keepalive: starting the Companion on port ${PORT}" >> "$LOG_FILE"
nohup "$NODE_BIN" server/dist/index.js >> "$LOG_FILE" 2>&1 &

# Give it a moment and report whether it came up.
sleep 5
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) keepalive: started" >> "$LOG_FILE"
else
  echo "$(date -u +%FT%TZ) keepalive: it did not come up - see the lines above" >> "$LOG_FILE"
fi
