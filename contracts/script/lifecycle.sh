#!/usr/bin/env bash
# Phase 1 lifecycle on a deployed network: create a 15m TEST market at the next boundary, split,
# open (signed test report), wait, resolve, redeem. Writes docs/evidence/phase-1/lifecycle-<net>.md
# with every tx hash. Prices: the latest Chainlink ETH/USD (Monad mainnet) answer at the moment
# the script reaches each boundary (not a historical lookup), signed by the TEST-ONLY streams
# signer (MockStreamsVerifierProxy).
# Optional: END_PRICE_DELTA_BPS (rehearsal only) shifts the end price to exercise UP/DOWN when
# the real price did not move; it is printed in the evidence when used.
# Usage: NETWORK_NAME=testnet RPC_URL=https://testnet-rpc.monad.xyz bash contracts/script/lifecycle.sh
# Optional: WARP=1 (local anvil only: jump time instead of sleeping).
set -euo pipefail
cd "$(dirname "$0")/../.."
NETWORK_NAME=${NETWORK_NAME:-testnet}
RPC_URL=${RPC_URL:-https://testnet-rpc.monad.xyz}
PRICE_RPC=${PRICE_RPC:-https://rpc.monad.xyz}
ETH_USD=0x1B1414782B859871781bA3E4B0979b9ca57A0A04 # Chainlink ETH/USD, Monad mainnet
DEP=deployments/$NETWORK_NAME.json
OUT=docs/evidence/phase-1/lifecycle-$NETWORK_NAME.md
PK=$(grep '^DEPLOYER_PRIVATE_KEY=' .env | cut -d= -f2)
SK=$(grep '^STREAMS_TEST_SIGNER_KEY=' .env | cut -d= -f2)
j() { python3 -c "import json;print(json.load(open('$DEP'))['$1'])"; }
FACTORY=$(j marketFactory); TUSDC=$(j collateral_tUSDC); STREAMS=$(j dataStreamsResolver)
ASSET=$(j assetTEST); FEED_ID=$(j testFeedId); WINDOW=$(j finalizationWindow)
ME=$(cast wallet address --private-key "$PK")
GAS="--gas-limit"

log() { echo "$*" | tee -a "$OUT"; }
now() { cast block --rpc-url "$RPC_URL" latest -f timestamp; }
wait_until() { # $1 = unix ts
  local t=$1
  if [ "${WARP:-0}" = "1" ]; then
    cast rpc evm_setNextBlockTimestamp "$t" --rpc-url "$RPC_URL" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
  else
    while [ "$(now)" -lt "$t" ]; do sleep 5; done
  fi
}
send() { # label, to, sig, args... ; logs the tx hash
  local label=$1 to=$2; shift 2
  local gas; gas=$(cast estimate "$to" "$@" --from "$ME" --rpc-url "$RPC_URL")
  gas=$(( gas * 115 / 100 )) # Monad bills the limit
  local out; out=$(cast send "$to" "$@" --private-key "$PK" --rpc-url "$RPC_URL" $GAS "$gas" --json)
  local h; h=$(echo "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['transactionHash'])")
  local st; st=$(echo "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(int(d['status'],16))")
  local bn; bn=$(echo "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(int(d['blockNumber'],16))")
  log "| $label | \`$h\` | $bn | $([ "$st" = 1 ] && echo ok || echo REVERTED) |"
  [ "$st" = 1 ]
}
report() { # boundary ts [delta bps] -> signed payload hex (window [t, t], price = ETH/USD * 1e10)
  local t=$1 delta=${2:-0}
  local px; px=$(cast call $ETH_USD "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$PRICE_RPC" | sed -n 2p | awk '{print $1}')
  local px18; px18=$(python3 -c "print($px * 10**10 * (10000 + $delta) // 10000)")
  local data; data=$(cast abi-encode "f(bytes32,uint32,uint32,uint192,uint192,uint32,int192,int192,int192)" \
    "$FEED_ID" "$t" "$t" 0 0 $((t + 86400)) "$px18" "$px18" "$px18")
  local sig; sig=$(cast wallet sign --private-key "$SK" "$(cast keccak "$data")")
  echo "PRICE=$px18" >&2
  cast abi-encode "f(bytes32[3],bytes,bytes)" "[0x0000000000000000000000000000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000000000000000000000000000]" "$data" "$sig"
}

mkdir -p "$(dirname "$OUT")"
NOW=$(now)
START=$(( (NOW / 900 + 1) * 900 )); [ $((START - NOW)) -lt 30 ] && START=$((START + 900))
END=$((START + 900))
{
  echo "# Phase 1 testnet lifecycle ($NETWORK_NAME)"
  echo
  echo "- chain id: $(cast chain-id --rpc-url "$RPC_URL"), run at $(date -u +%FT%TZ)"
  echo "- factory \`$FACTORY\`, collateral tUSDC \`$TUSDC\`, resolver DataStreamsResolver \`$STREAMS\` (MockStreamsVerifierProxy, TEST-ONLY signer)"
  echo "- market: TEST/USD 15m, start $START ($(date -u -d @$START +%FT%TZ)), end $END"
  echo "- prices: latest Chainlink ETH/USD (Monad mainnet) answer when the script reached each boundary, x1e10 to 18 dp, signed by the test signer"
  [ "${END_PRICE_DELTA_BPS:-0}" != "0" ] && echo "- **rehearsal nudge:** end price shifted by ${END_PRICE_DELTA_BPS} bps to exercise the non-tie path"
  echo
  echo "| step | tx hash | block | status |"
  echo "|---|---|---|---|"
} > "$OUT"

send "createMarket(TEST, 15m, $START)" "$FACTORY" "createMarket(bytes32,uint64,uint64)" "$ASSET" 900 "$START"
MARKET=$(cast call "$FACTORY" "getMarket(bytes32,uint64,uint64)(address)" "$ASSET" 900 "$START" --rpc-url "$RPC_URL")
UP=$(cast call "$MARKET" "up()(address)" --rpc-url "$RPC_URL"); DOWN=$(cast call "$MARKET" "down()(address)" --rpc-url "$RPC_URL")
send "tUSDC.mint(100)" "$TUSDC" "mint(address,uint256)" "$ME" 100000000
send "tUSDC.approve(market)" "$TUSDC" "approve(address,uint256)" "$MARKET" 100000000
send "split(100 tUSDC)" "$MARKET" "split(uint256)" 100000000
send "transfer 40 DOWN away (so redeem shows a real payout split)" "$DOWN" "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 40000000

wait_until $((START + 2))
P1=$(report "$START" 2>/tmp/px1); PX1=$(cut -d= -f2 /tmp/px1)
send "open(signed report @start, price $PX1)" "$MARKET" "open(bytes)" "$P1"
wait_until $(( $(now) + WINDOW + 2 ))
send "open() after finalization window" "$MARKET" "open(bytes)" 0x
STRIKE=$(cast call "$MARKET" "strike()(int256)" --rpc-url "$RPC_URL" | awk '{print $1}')

wait_until $((END + 2))
P2=$(report "$END" "${END_PRICE_DELTA_BPS:-0}" 2>/tmp/px2); PX2=$(cut -d= -f2 /tmp/px2)
send "resolve(signed report @end, price $PX2)" "$MARKET" "resolve(bytes)" "$P2"
wait_until $(( $(now) + WINDOW + 2 ))
send "resolve() after finalization window" "$MARKET" "resolve(bytes)" 0x
STATE=$(cast call "$MARKET" "state()(uint8)" --rpc-url "$RPC_URL")
BAL0=$(cast call "$TUSDC" "balanceOf(address)(uint256)" "$ME" --rpc-url "$RPC_URL" | awk '{print $1}')
send "redeem()" "$MARKET" "redeem()"
BAL1=$(cast call "$TUSDC" "balanceOf(address)(uint256)" "$ME" --rpc-url "$RPC_URL" | awk '{print $1}')
NAMES=("CREATED" "OPEN" "RESOLVED_UP" "RESOLVED_DOWN" "INVALID")
{
  echo
  echo "## Result"
  echo
  echo "- market \`$MARKET\`, UP \`$UP\` ($(cast call "$UP" 'name()(string)' --rpc-url "$RPC_URL")), DOWN \`$DOWN\`"
  echo "- strike $STRIKE, end price $PX2, state ${NAMES[$STATE]} (tie goes UP)"
  echo "- holder had 100 UP + 60 DOWN; redeem paid $(( (BAL1 - BAL0) )) base units (expected 100e6 if UP, 60e6 if DOWN)"
  echo "- market collateral left: $(cast call "$TUSDC" "balanceOf(address)(uint256)" "$MARKET" --rpc-url "$RPC_URL" | awk '{print $1}') (equals the winning claims still outstanding: 0 if UP won, 40e6 for the DOWN at 0xdEaD if DOWN won)"
} >> "$OUT"
echo "wrote $OUT"
