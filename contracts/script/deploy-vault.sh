#!/usr/bin/env bash
# Deploys the Phase 4 vault + venue on top of the Phase 1/2 deployment and merges the addresses and
# tx hashes into deployments/<network>.json under "vault". Run `deploy.sh` first.
# Usage: NETWORK_NAME=testnet RPC_URL=https://testnet-rpc.monad.xyz bash contracts/script/deploy-vault.sh
# Keys are read from .env and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(cd .. && pwd)
NETWORK_NAME=${NETWORK_NAME:-testnet}
RPC_URL=${RPC_URL:-https://testnet-rpc.monad.xyz}
DEPLOYER_PRIVATE_KEY=$(grep '^DEPLOYER_PRIVATE_KEY=' "$ROOT/.env" | cut -d= -f2)
KEEPER_ADDRESS=$(cast wallet address --private-key "$(grep '^KEEPER_PRIVATE_KEY=' "$ROOT/.env" | cut -d= -f2)")
export DEPLOYER_PRIVATE_KEY KEEPER_ADDRESS NETWORK_NAME
# Monad bills the gas limit: keep the estimate multiplier tight.
forge script script/DeployVault.s.sol:DeployVault --rpc-url "$RPC_URL" --broadcast --slow \
  --gas-estimate-multiplier 115
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
python3 - "$ROOT/deployments/$NETWORK_NAME.json" "$ROOT/deployments/$NETWORK_NAME.vault.json" \
  "broadcast/DeployVault.s.sol/$CHAIN_ID/run-latest.json" <<'PY'
import json, sys, os
main, vault, run = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(main)); v = json.load(open(vault)); r = json.load(open(run))
v["transactions"] = [
    {"hash": t["hash"], "contractName": t.get("contractName"), "function": t.get("function"),
     "contractAddress": t.get("contractAddress")}
    for t in r["transactions"]
]
d["vault"] = v
json.dump(d, open(main, "w"), indent=2)
os.remove(vault)
print("merged the vault deployment into", main)
PY
