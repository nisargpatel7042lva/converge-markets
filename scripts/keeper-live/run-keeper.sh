#!/usr/bin/env bash
# Starts the keeper against Monad testnet from the repo .env + deployments/testnet.json, with the
# exchange streams going through the local relay (scripts/keeper-live/src/relay.ts).
# Usage: MODE=live bash scripts/keeper-live/run-keeper.sh    (logs to $OUT_DIR/keeper.log)
# Secrets are read from .env and never printed.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
val() { grep "^$1=" .env | cut -d= -f2; }
export KEEPER_PRIVATE_KEY=$(val KEEPER_PRIVATE_KEY)
export STREAMS_TEST_SIGNER_KEY=$(val STREAMS_TEST_SIGNER_KEY)
export RPC_URLS=${RPC_URLS:-$(val MONAD_TESTNET_RPC_URL)}
export WS_URL=${WS_URL:-wss://testnet-rpc.monad.xyz}
export VAULT=$(python3 -c "import json;print(json.load(open('deployments/testnet.json'))['vault']['vault'])")
export VENUE=$(python3 -c "import json;print(json.load(open('deployments/testnet.json'))['vault']['forwardVenue'])")
export BINANCE_WS_URL=${BINANCE_WS_URL:-ws://127.0.0.1:9201}
export COINBASE_WS_URL=${COINBASE_WS_URL:-ws://127.0.0.1:9202}
export MODE=${MODE:-live}
export OUT_DIR=${OUT_DIR:-$ROOT/docs/evidence/phase-5}
export KILL_FILE=${KILL_FILE:-/tmp/converge-keeper.kill}
export HTTP_PORT=${HTTP_PORT:-9100}
export KILL_TOKEN=${KILL_TOKEN:-$(python3 -c "import secrets;print(secrets.token_hex(16))")}
export KEEPER_CONFIG=${KEEPER_CONFIG:-$ROOT/config/keeper.testnet.json}
mkdir -p "$OUT_DIR"
cd services/keeper
exec node_modules/.bin/tsx src/main.ts >> "$OUT_DIR/keeper.log" 2>&1
