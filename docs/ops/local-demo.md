# The whole product, running locally

`.demo/start.sh` brings up the complete system on your machine, with test money: a local chain (anvil, 1 s
blocks), the real contracts (factory, resolvers, vault, venue), a funded vault (1,000 test USDC), the real keeper
(quotes, executes orders, halts on bad prices), a scheduler that creates, opens and resolves 15-minute rounds on the
chain clock, and the real app (production build) with a test-money faucet. The price is flat at 3,000 and each
round ends a little above or below at random. It is **not** a deployment and says nothing about profitability: it
shows that every part works together.

```bash
cd ~/converge
.demo/start.sh            # about a minute; logs in .demo/stack.log  (DEMO_LOG=1 .demo/start.sh also logs the keeper)
# open http://localhost:3100 in a phone-sized window
.demo/stop.sh
```

What to do in the app: create an account (a passkey), tap to add money (the faucet), place a bet on the running
round, watch it fill within a couple of seconds, wait for the round to end (up to 15 minutes; the log says
"resolved"), collect. The Vault page shows the LP side (deposit requests settle at the epoch end).

Without a browser, the same loop from the command line:

```bash
cd services/keeper
pnpm exec tsx scripts/demo-bet.ts UP 5      # a 5 USDC bet on UP through the venue, waits for the keeper's fill
pnpm exec tsx scripts/demo-collect.ts       # redeems every resolved round the demo taker holds
curl -s localhost:3100/api/status           # the public status line, as the stats page shows it
```

The automated version of the browser flow is `cd apps/web && pnpm exec playwright test` (10 tests: first trade
in seconds, a paused market, an unfilled bet cancelled for a refund, settlement and collecting, the LP deposit, the
region block). On this machine it needs the user-space browser libraries: `export
LD_LIBRARY_PATH=$HOME/.local/pwlibs/root/usr/lib/x86_64-linux-gnu`.

Why this is local and not on a public chain: a deployment needs funds and inputs that only Nisarg can provide (see
the Phase 9 report): MON for gas (the deployer holds 0 on mainnet and 0.26 on testnet, a testnet deployment needs
about 2.2 MON and mainnet about 3.8), a Safe, the Data Streams stream ids and API credentials, and the alert webhooks.
Once they exist, `docs/ops/mainnet-deploy.md` is the deployment, rehearsed on a fork of mainnet.
