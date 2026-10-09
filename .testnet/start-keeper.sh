#!/usr/bin/env bash
# relay (real Binance/Coinbase ETH streams) + the live keeper against Monad testnet.
# testnet-rpc.monad.xyz first (its WebSocket works; the Foundation endpoint's WebSocket fails at once and
# made the keeper retry in a tight loop, so it went blind), the Foundation endpoint as the fail-over.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.foundry/bin:$PATH"
mkdir -p .testnet
# the price relay (scripts/keeper-live/src/relay.ts) is started once, separately, and kept running
curl -sf -m 2 http://127.0.0.1:9203/price >/dev/null || { (cd scripts/keeper-live && setsid nohup node_modules/.bin/tsx src/relay.ts > ../../.testnet/relay.log 2>&1 &); sleep 4; }
export RPC_URLS="https://testnet-rpc.monad.xyz,https://rpc-testnet.monadinfra.com"
export WS_URL="wss://testnet-rpc.monad.xyz"
OUT_DIR="$PWD/.testnet" MODE=live setsid nohup bash scripts/keeper-live/run-keeper.sh > .testnet/keeper.out 2>&1 &
echo started
