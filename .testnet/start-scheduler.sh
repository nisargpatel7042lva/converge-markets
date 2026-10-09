#!/usr/bin/env bash
cd "$(dirname "$0")/../services/keeper" || exit 1
export PATH="$HOME/.foundry/bin:$PATH"
RPC_URL=https://rpc-testnet.monadinfra.com setsid nohup pnpm exec tsx scripts/testnet-scheduler.ts > ../../.testnet/scheduler.log 2>&1 &
echo $! > ../../.testnet/scheduler.pid
