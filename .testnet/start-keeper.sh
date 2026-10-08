#!/usr/bin/env bash
# relay (real Binance/Coinbase ETH streams) + the live keeper against Monad testnet
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.foundry/bin:$PATH"
(cd scripts/keeper-live && setsid nohup node_modules/.bin/tsx src/relay.ts > ../../.testnet/relay.log 2>&1 & echo $! > ../../.testnet/relay.pid)
sleep 4
OUT_DIR="$PWD/.testnet" MODE=live setsid nohup bash scripts/keeper-live/run-keeper.sh > .testnet/keeper.out 2>&1 &
echo $! > .testnet/keeper.pid
