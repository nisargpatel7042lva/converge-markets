#!/usr/bin/env bash
# Deploys Phase 1 contracts and records addresses + block + tx hashes in deployments/<network>.json.
# Usage: NETWORK_NAME=testnet RPC_URL=https://testnet-rpc.monad.xyz bash contracts/script/deploy.sh
# Keys are read from .env (DEPLOYER_PRIVATE_KEY, STREAMS_TEST_SIGNER_KEY) and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(cd .. && pwd)
NETWORK_NAME=${NETWORK_NAME:-testnet}
RPC_URL=${RPC_URL:-https://testnet-rpc.monad.xyz}
DEPLOYER_PRIVATE_KEY=$(grep '^DEPLOYER_PRIVATE_KEY=' "$ROOT/.env" | cut -d= -f2)
STREAMS_TEST_SIGNER=$(cast wallet address --private-key "$(grep '^STREAMS_TEST_SIGNER_KEY=' "$ROOT/.env" | cut -d= -f2)")
export DEPLOYER_PRIVATE_KEY STREAMS_TEST_SIGNER NETWORK_NAME
EXTRA=()
if [ "${VERIFY:-0}" = "1" ]; then
  # MonadVision (Sourcify) per https://docs.monad.xyz/guides/verify-smart-contract/foundry
  EXTRA+=(--verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/)
fi
# Monad bills the gas limit: keep the estimate multiplier tight.
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast --slow \
  --gas-estimate-multiplier 115 "${EXTRA[@]}"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
python3 - "$ROOT/deployments/$NETWORK_NAME.json" "broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json" <<'PY'
import json, sys
out, run = sys.argv[1], sys.argv[2]
d = json.load(open(out)); r = json.load(open(run))
d["transactions"] = [
    {"hash": t["hash"], "contractName": t.get("contractName"), "function": t.get("function"),
     "contractAddress": t.get("contractAddress")}
    for t in r["transactions"]
]
json.dump(d, open(out, "w"), indent=2)
print("recorded", len(d["transactions"]), "tx hashes in", out)
PY
