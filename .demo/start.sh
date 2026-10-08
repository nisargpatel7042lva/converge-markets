#!/usr/bin/env bash
# starts the local demo stack in the background; stop with .demo/stop.sh
cd "$(dirname "$0")/../services/keeper" || exit 1
export PATH="$HOME/.foundry/bin:$PATH"
DEMO_LOG=${DEMO_LOG:-0} setsid nohup pnpm exec tsx scripts/demo-stack.ts > ../../.demo/stack.log 2>&1 &
echo $! > ../../.demo/stack.pid
