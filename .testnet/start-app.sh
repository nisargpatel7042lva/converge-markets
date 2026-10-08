#!/usr/bin/env bash
# the real app (production build) against the Monad testnet deployment, served on http://localhost:3200
cd "$(dirname "$0")/../apps/web" || exit 1
export PATH="$HOME/.foundry/bin:$PATH"
export NODE_ENV=production NEXT_DIST_DIR=.next-testnet NEXT_PUBLIC_APP_ENV=production
export NEXT_PUBLIC_FAUCET_ENABLED=1 FAUCET_ENABLED=1
export DRIP_PRIVATE_KEY=$(grep "^DEPLOYER_PRIVATE_KEY=" ../../.env | cut -d= -f2)
export DRIP_RPC_URL=$(grep "^MONAD_TESTNET_RPC_URL=" ../../.env | cut -d= -f2)
pnpm exec next build > ../../.testnet/app-build.log 2>&1 || { echo "build failed"; exit 1; }
setsid nohup pnpm exec next start -p 3200 -H 0.0.0.0 > ../../.testnet/app.log 2>&1 &
echo $! > ../../.testnet/app.pid
