#!/usr/bin/env bash
# Real Monad (mainnet) gas schedule via eth_estimateGas: no signature, no funds, read-only.
# Cancels are estimated at the block where the maker's orders were live (historical state).
# Usage: bash scripts/spike/monad-gas-estimates.sh > docs/evidence/phase-0/monad-gas-estimates.txt
set -uo pipefail
M=${MONAD_MAINNET_RPC_URL:-https://rpc.monad.xyz}
R=0xd651346d7c789536ebf06dc72aE3C8502cd695CC          # Kuru Router (mainnet)
MK=0x065C9d28E428A0db40191a54d33d5b7c71a9C394         # Kuru MON-USDC (mainnet)
OC=$(cast keccak "OrderCreated(uint40,address,uint96,uint32,bool)")
BU='batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)'
echo "# run at $(date -u +%FT%TZ)"
echo "## Kuru mainnet Router owner: $(cast call $R 'owner()(address)' --rpc-url $M)"
echo "## deployProxy from 0x...dEaD (expect revert $(cast sig 'Unauthorized()') Unauthorized)"
cast estimate $R "deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96)" 0 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 10000 10000 13 10000 1000000000 0 0 100 --from 0x000000000000000000000000000000000000dEaD --rpc-url $M 2>&1 | tail -1
echo "## same call from the owner"
cast estimate $R "deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96)" 0 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 10000 10000 13 10000 1000000000 0 0 100 --from "$(cast call $R 'owner()(address)' --rpc-url $M)" --rpc-url $M 2>&1 | tail -1
echo "## MON-USDC params (pricePrecision,sizePrecision,base,baseDec,quote,quoteDec,tick,minSize,maxSize,taker,maker)"
cast call $MK "getMarketParams()(uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)" --rpc-url $M | tr '\n' ' '; echo
B=$(cast block-number --rpc-url $M)
TMP=$(mktemp)
cast logs --from-block $((B-60)) --to-block $B --address $MK $OC --rpc-url $M --json 2>/dev/null | python3 -c "
import json,sys
for l in json.load(sys.stdin):
    d=l['data'][2:]; print(int(l['blockNumber'],16), int(d[:64],16), '0x'+d[64+24:128])" > "$TMP"
echo "## maker activity: $(wc -l < "$TMP") OrderCreated events in blocks $((B-60))..$B; by owner:"
awk '{print $3}' "$TMP" | sort | uniq -c | sort -rn | head -3
# Find two orders by the same owner that are both live at the same historical block.
prev_blk=""; prev_id=""; prev_owner=""; found=0
while read -r blk id owner; do
  live=$(cast call $MK 's_orders(uint40)(address)' "$id" --block "$blk" --rpc-url $M 2>/dev/null | head -1)
  if [ "${live,,}" = "${owner,,}" ]; then
    if [ "$blk" = "$prev_blk" ] && [ "$owner" = "$prev_owner" ]; then
      echo "## estimates at block $blk as maker $owner (live ids $prev_id,$id); posts are post-only, min size, far from mid"
      echo "batchCancelOrders 1 order:              $(cast estimate $MK 'batchCancelOrders(uint40[])' "[$prev_id]" --from $owner --block $blk --rpc-url $M 2>&1 | tail -1)"
      echo "batchCancelOrders 2 orders:             $(cast estimate $MK 'batchCancelOrders(uint40[])' "[$prev_id,$id]" --from $owner --block $blk --rpc-url $M 2>&1 | tail -1)"
      echo "batchUpdate cancel 2 + post 2 (requote): $(cast estimate $MK "$BU" '[2000000]' '[2000000000000]' '[9000000]' '[2000000000000]' "[$prev_id,$id]" true --from $owner --block $blk --rpc-url $M 2>&1 | tail -1)"
      echo "batchUpdate post 2, no cancel:           $(cast estimate $MK "$BU" '[2000000]' '[2000000000000]' '[9000000]' '[2000000000000]' '[]' true --from $owner --block $blk --rpc-url $M 2>&1 | tail -1)"
      echo "addBuyOrder single:                      $(cast estimate $MK 'addBuyOrder(uint32,uint96,bool)' 2000000 2000000000000 true --from $owner --block $blk --rpc-url $M 2>&1 | tail -1)"
      echo "addSellOrder single:                     $(cast estimate $MK 'addSellOrder(uint32,uint96,bool)' 9000000 2000000000000 true --from $owner --block $blk --rpc-url $M 2>&1 | tail -1)"
      found=1; break
    fi
    prev_blk=$blk; prev_id=$id; prev_owner=$owner
  fi
done < "$TMP"
[ $found = 1 ] || echo "no two live orders by one maker found in window; rerun"
rm -f "$TMP"
