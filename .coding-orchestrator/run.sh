#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Market Trends — Controller worktree runner.
#
# Starts the Hono API (server/) and the Vite web app (web/) together. The web
# dev server proxies /api to the API, so opening the web URL is enough in dev.
#
# Ports are derived from this project's native defaults plus Controller's
# PORT_OFFSET, matching what setup.sh wrote into .env. Ctrl-C stops both
# processes.
# ─────────────────────────────────────────────────────────────────────────────
set -e

# ── ports (validate before arithmetic; Controller exports PORT_OFFSET) ────────
API_BASE_PORT="${MARKET_TRENDS_API_BASE_PORT:-8987}"
CLIENT_BASE_PORT="${MARKET_TRENDS_WEB_BASE_PORT:-5273}"
OFFSET="${PORT_OFFSET:-0}"

if ! [[ "$API_BASE_PORT" =~ ^[0-9]+$ ]]; then
  echo "API_BASE_PORT must be a number (got: $API_BASE_PORT)" >&2
  exit 1
fi
if ! [[ "$CLIENT_BASE_PORT" =~ ^[0-9]+$ ]]; then
  echo "CLIENT_BASE_PORT must be a number (got: $CLIENT_BASE_PORT)" >&2
  exit 1
fi
if ! [[ "$OFFSET" =~ ^[0-9]+$ ]]; then
  echo "PORT_OFFSET must be a number (got: $OFFSET)" >&2
  exit 1
fi

API_PORT=$((API_BASE_PORT + OFFSET))
WEB_PORT=$((CLIENT_BASE_PORT + OFFSET))

# ── reconcile with .env (source of truth, written by setup.sh) ────────────────
# The server calls loadEnv("../.env", { override: true }), so whatever PORT is
# in .env wins over anything we export. Read it back so our printed port, the
# VITE_API_URL proxy target, and the actual listening port always agree.
env_port() {
  [ -f .env ] || return 0
  grep -E "^\s*PORT\s*=" .env 2>/dev/null | head -n1 \
    | sed -E "s/^[^=]*=//; s/^\"|\"$//g; s/^'|'$//g; s/ #.*$//" | tr -d '[:space:]'
}
ENV_PORT="$(env_port)"
if [ -n "$ENV_PORT" ] && [ "$ENV_PORT" != "$API_PORT" ]; then
  echo "[run] note: .env PORT=$ENV_PORT overrides Controller API port $API_PORT."
  API_PORT="$ENV_PORT"
fi

# ── env for child processes ───────────────────────────────────────────────────
export PORT="$API_PORT"
export VITE_API_URL="http://localhost:$API_PORT"

# ── launch + cleanup ─────────────────────────────────────────────────────────
# Enable job control so each background job gets its own process group. We
# then kill the whole group on exit so `npm`'s children (`tsx watch`, `vite`)
# die with it instead of being orphaned. Portable to macOS bash 3.2 (no setsid).
set -m
pgids=()
cleanup() {
  trap '' INT TERM      # avoid re-entrant cleanup
  echo
  echo "[run] stopping dev servers …"
  for pgid in "${pgids[@]:-}"; do
    [ -n "$pgid" ] && kill -TERM -- "-$pgid" 2>/dev/null || true
  done
  sleep 1
  for pgid in "${pgids[@]:-}"; do
    [ -n "$pgid" ] && kill -KILL -- "-$pgid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT   # Ctrl-C → exit 130 → triggers EXIT cleanup
trap 'exit 143' TERM  # SIGTERM → exit 143 → triggers EXIT cleanup

echo "[run] API  → http://localhost:$API_PORT  (server/ npm run dev)"
echo "[run] web → http://localhost:$WEB_PORT  (web/ npm run dev -- --port $WEB_PORT)"

# API first so the web proxy has an upstream to hit.
( cd server && exec npm run dev ) & pgids+=("$!")
sleep 1
# Vite's server.port is hardcoded to 5273 in vite.config.ts, so override on the CLI.
( cd web && exec npm run dev -- --port "$WEB_PORT" ) & pgids+=("$!")

wait
