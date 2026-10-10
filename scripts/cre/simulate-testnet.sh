#!/usr/bin/env bash
# Runs the real Chainlink CRE scheduler workflow in `cre workflow simulate` against Monad testnet:
# the workflow reads the live factory through the SchedulerLens, plans create/open/resolve actions, fetches
# Data Streams evidence from the local testnet shim and builds the report for SchedulerReceiver.
#
#   cre login                          # or: export CRE_API_KEY=... (never commit it)
#   bash scripts/cre/simulate-testnet.sh            # dry simulation: prints the report it would send
#   BROADCAST=1 CRE_ETH_PRIVATE_KEY=0x... bash scripts/cre/simulate-testnet.sh   # also writes it on chain
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
if [ -z "${CRE_API_KEY:-}" ]; then cre whoami >/dev/null 2>&1 || { echo "not logged in: run cre login (or set CRE_API_KEY)"; exit 1; }; fi
export MONAD_TESTNET_RPC_URL=${MONAD_TESTNET_RPC_URL:-https://rpc-testnet.monadinfra.com}
export DATA_STREAMS_API_KEY=${DATA_STREAMS_API_KEY:-testnet-shim}
export DATA_STREAMS_API_SECRET=${DATA_STREAMS_API_SECRET:-testnet-shim}
OUT="$ROOT/docs/evidence/cre"; mkdir -p "$OUT"
(cd services/keeper && exec setsid pnpm exec tsx scripts/cre-streams-shim.ts 9311 > "$OUT/streams-shim.log" 2>&1) &
SHIM=$!
trap 'kill -- -$SHIM 2>/dev/null || kill $SHIM 2>/dev/null' EXIT
for i in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/9311) 2>/dev/null && break; sleep 0.5; done
FLAGS=(--target staging-settings --config config.testnet.json --non-interactive --trigger-index 0)
[ "${BROADCAST:-}" = "1" ] && FLAGS+=(--broadcast)
cd services/scheduler/cre
cre workflow simulate scheduler "${FLAGS[@]}" 2>&1 | tee "$OUT/simulate-testnet.txt"
