#!/usr/bin/env bash
# Runs the relay, the keeper and the scheduler. If any of them stops, the container stops (and the host restarts it).
# Secrets come from the host's environment and are never printed:
#   KEEPER_PRIVATE_KEY, STREAMS_TEST_SIGNER_KEY, and SCHEDULER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY).
set -euo pipefail
cd /app
: "${KEEPER_PRIVATE_KEY:?KEEPER_PRIVATE_KEY is required}"
: "${STREAMS_TEST_SIGNER_KEY:?STREAMS_TEST_SIGNER_KEY is required}"
if [ "${RUN_SCHEDULER:-1}" = "1" ] && [ -z "${SCHEDULER_PRIVATE_KEY:-}${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "SCHEDULER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is required unless RUN_SCHEDULER=0" >&2
  exit 1
fi
export VAULT="$(node -p "require('./deployments/testnet.json').vault.vault")"
export VENUE="$(node -p "require('./deployments/testnet.json').vault.forwardVenue")"
export BINANCE_WS_URL="ws://127.0.0.1:9201/{symbol}" COINBASE_WS_URL="ws://127.0.0.1:9202/{symbol}"
export KILL_TOKEN="${KILL_TOKEN:-$(node -p "require('crypto').randomBytes(16).toString('hex')")}"

pids=()
stop() { kill "${pids[@]}" 2>/dev/null || true; }
trap stop EXIT

(cd scripts/keeper-live && exec node_modules/.bin/tsx src/relay.ts) & pids+=($!)
for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:9203/price?asset=ETH" >/dev/null 2>&1 \
    || node -e "fetch('http://127.0.0.1:9203/price?asset=ETH').then(r=>r.json()).then(j=>process.exit(j.price?0:1)).catch(()=>process.exit(1))" && break
  sleep 1
done
(cd services/keeper && exec node_modules/.bin/tsx src/main.ts) & pids+=($!)
if [ "${RUN_SCHEDULER:-1}" = "1" ]; then
  (cd services/keeper && exec node_modules/.bin/tsx scripts/testnet-scheduler.ts) & pids+=($!)
fi
echo "converge testnet backend up: relay, keeper$([ "${RUN_SCHEDULER:-1}" = "1" ] && echo ", scheduler")"
wait -n
echo "a process stopped: shutting down so the host restarts the container" >&2
exit 1
