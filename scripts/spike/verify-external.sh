#!/usr/bin/env bash
# Re-runs the onchain checks behind docs/EXTERNAL.md. Read-only (eth_call / eth_getCode / eth_estimateGas).
# Usage: bash scripts/spike/verify-external.sh > docs/evidence/phase-0/external-onchain-checks.txt
set -uo pipefail
M=${MONAD_MAINNET_RPC_URL:-https://rpc.monad.xyz}
T=${MONAD_TESTNET_RPC_URL:-https://testnet-rpc.monad.xyz}
codesize() { local c; c=$(cast code "$1" --rpc-url "$2"); echo $(( (${#c} - 2) / 2 )); }
echo "# run at $(date -u +%FT%TZ)"
echo "mainnet chain-id: $(cast chain-id --rpc-url $M)   testnet chain-id: $(cast chain-id --rpc-url $T)"
echo "mainnet base-fee: $(cast base-fee --rpc-url $M)   testnet base-fee: $(cast base-fee --rpc-url $T)"
echo "## tokens"
for a in 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A; do
  echo "mainnet $a $(cast call $a 'symbol()(string)' --rpc-url $M) decimals=$(cast call $a 'decimals()(uint8)' --rpc-url $M)"; done
for a in 0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570 0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541; do
  echo "testnet $a $(cast call $a 'symbol()(string)' --rpc-url $T) decimals=$(cast call $a 'decimals()(uint8)' --rpc-url $T)"; done
echo "## code sizes (bytes)"
for a in 0xd651346d7c789536ebf06dc72aE3C8502cd695CC 0x41675C099F32341bf84BFc5382aF534df5C7461a 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 0xEd813D895457907399E41D36Ec0bE103E32148c8 0x76c9cf548b4179F8901cda1f8623568b58215E62 0x9eF6468C5f37b976E57d52054c693269479A784d; do
  echo "mainnet $a $(codesize $a $M)"; done
for a in 0x7EFbE105Ca7415dE98F96622173458ac1c054630 0xd029C2D98ff85D8F64799017fE00a59B1159CE02 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 0xB9F79d863261869B234c481D1f9A7af84AeAd192 0xC539169910DE08D237Df0d73BcDa9074c787A4a1; do
  echo "testnet $a $(codesize $a $T)"; done
echo "## chainlink feeds (description, decimals, latestRoundData)"
for f in 0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546 0x1B1414782B859871781bA3E4B0979b9ca57A0A04 0xBcD78f76005B7515837af6b50c7C52BCf73822fb; do
  echo "mainnet $f $(cast call $f 'description()(string)' --rpc-url $M) dec=$(cast call $f 'decimals()(uint8)' --rpc-url $M) $(cast call $f 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url $M | tr '\n' ' ')"; done
for f in 0x12C0F44368a02081ce58a936d1C1F606BB301715 0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31; do
  echo "testnet $f $(cast call $f 'description()(string)' --rpc-url $T) $(cast call $f 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url $T | tr '\n' ' ')"; done
echo "now=$(date +%s)"
echo "## Kuru deployProxy permissionless check: eth_estimateGas from an unprivileged, unfunded EOA (WMON/USDC, fresh params)"
cast estimate 0x7EFbE105Ca7415dE98F96622173458ac1c054630 \
  "deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96)" \
  0 0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541 0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570 10000 10000 13 10000 1000000000 0 0 100 \
  --from 0x000000000000000000000000000000000000dEaD --rpc-url $T
