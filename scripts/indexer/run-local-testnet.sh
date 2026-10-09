#!/usr/bin/env bash
# A LOCAL Envio HyperIndex for the live Monad testnet deployment, left running for the app to read:
#   rate-limited RPC proxy -> Envio (rpc data source, no HyperSync token) -> Postgres + Hasura (Docker)
#   -> read-only GraphQL proxy on :8081 (the URL for NEXT_PUBLIC_INDEXER_URL).
# Stop with:  bash scripts/indexer/run-local-testnet.sh stop   (kills only the PIDs recorded here)
# Env: PROXY_RPS (default 6: the public testnet RPC allows about 15 req/s per IP and the keeper uses some)
#      FACTORY_FROM_BLOCK / VAULT_FROM_BLOCK to start later than the deploy block and sync faster.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
LOCAL="$ROOT/.local-indexer"
PIDS="$LOCAL/testnet-pids"
mkdir -p "$LOCAL"
if [ "${1:-}" = "stop" ]; then
  (cd "$LOCAL/testnet-project" 2>/dev/null && pnpm exec envio stop >/dev/null 2>&1)
  if [ -f "$PIDS" ]; then while read -r p; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null; done < "$PIDS"; rm -f "$PIDS"; fi
  echo stopped; exit 0
fi
UPSTREAM=${UPSTREAM:-https://rpc-testnet.monadinfra.com}
PROXY_PORT=${PROXY_PORT:-8612}
: > "$PIDS"
(cd scripts/reconcile && exec setsid pnpm exec tsx rpc-proxy.ts --upstream "$UPSTREAM" --port "$PROXY_PORT" --rps "${PROXY_RPS:-6}" --stats "$LOCAL/rpc-usage-testnet.json" > "$LOCAL/rpc-proxy.log" 2>&1) &
echo $! >> "$PIDS"
for i in $(seq 1 40); do (echo > "/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null && break; sleep 0.5; done
MAX_BLOCK_RANGE=100 POLL_MS=${POLL_MS:-500} node indexer/scripts/local-project.mjs deployments/testnet.json "http://127.0.0.1:$PROXY_PORT" "$LOCAL/testnet-project" || exit 1
(cd "$LOCAL/testnet-project" && ENVIO_TUI=false LOG_STRATEGY=console-raw exec setsid pnpm exec envio dev -r > "$LOCAL/envio-testnet.log" 2>&1) &
echo $! >> "$PIDS"
(exec setsid node scripts/indexer/gql-proxy.mjs 8081 > "$LOCAL/gql-proxy.log" 2>&1) &
echo $! >> "$PIDS"
echo "started; progress: curl -s -X POST localhost:8081 -H 'content-type: application/json' -d '{\"query\":\"{ _meta { isReady progressBlock sourceBlock eventsProcessed } }\"}'"
