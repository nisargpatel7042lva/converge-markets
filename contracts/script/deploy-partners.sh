#!/usr/bin/env bash
# Deploys Phase 8: vault v4 (accepts partner markets), a new venue and the PartnerRegistry, on top of
# the Phase 1/2 deployment, and merges them into deployments/<network>.json:
#   "vault"   -> the new vault (the previous one is archived as "vault_v3_pre_partners")
#   "partners" -> the registry and the demo terms
# Usage:  NETWORK_NAME=testnet RPC_URL=https://testnet-rpc.monad.xyz bash contracts/script/deploy-partners.sh
#         DRY_RUN=1 ...   simulates only (prints the gas and the MON it would cost, sends nothing)
# Keys are read from .env and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(cd .. && pwd)
NETWORK_NAME=${NETWORK_NAME:-testnet}
RPC_URL=${RPC_URL:-https://testnet-rpc.monad.xyz}
env_val() { grep "^$1=" "$ROOT/.env" | cut -d= -f2; }
DEPLOYER_PRIVATE_KEY=$(env_val DEPLOYER_PRIVATE_KEY)
KEEPER_ADDRESS=$(cast wallet address --private-key "$(env_val KEEPER_PRIVATE_KEY)")
PARTNER_ADDRESS=$(cast wallet address --private-key "$(env_val PARTNER_PRIVATE_KEY)")
export DEPLOYER_PRIVATE_KEY KEEPER_ADDRESS PARTNER_ADDRESS NETWORK_NAME
if [ "${DRY_RUN:-0}" = "1" ]; then
  forge script script/DeployPartners.s.sol:DeployPartners --rpc-url "$RPC_URL" --gas-estimate-multiplier 115
  # the simulation writes the addresses of contracts that were never deployed: remove them
  rm -f "$ROOT/deployments/$NETWORK_NAME.partners.json"
  exit 0
fi
# Monad bills the gas limit: keep the estimate multiplier tight.
forge script script/DeployPartners.s.sol:DeployPartners --rpc-url "$RPC_URL" --broadcast --slow \
  --gas-estimate-multiplier 115
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
python3 - "$ROOT/deployments/$NETWORK_NAME.json" "$ROOT/deployments/$NETWORK_NAME.partners.json" \
  "broadcast/DeployPartners.s.sol/$CHAIN_ID/run-latest.json" <<'PY'
import json, sys, os
main, part, run = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(main)); p = json.load(open(part)); r = json.load(open(run))
txs = [{"hash": t["hash"], "contractName": t.get("contractName"), "function": t.get("function"),
        "contractAddress": t.get("contractAddress")} for t in r["transactions"]]
if "vault_v3_pre_partners" not in d:
    d["vault_v3_pre_partners"] = d["vault"]
new_vault = {k: p[k] for k in ("chainId", "deployBlock", "vault", "forwardVenue", "vaultKeeper",
                               "epochLength", "tvlCap", "execDelaySeconds", "maxLatenessSeconds")}
new_vault["vaultOwnerGuardianTreasury"] = p["ownerGuardianTreasury"]
new_vault["transactions"] = txs
d["vault"] = new_vault
d["partners"] = {k: p[k] for k in ("deployBlock", "partnerRegistry", "thresholdResolverImplementation",
                                   "demoPartner", "minBond", "globalExposureCap", "demoPartnerCap",
                                   "redeemFeeBps")}
json.dump(d, open(main, "w"), indent=2)
os.remove(part)
print("merged the Phase 8 deployment into", main)
PY
