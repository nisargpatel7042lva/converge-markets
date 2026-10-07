# Partner demo: a Converge market on your page

A tiny Next.js page that embeds one Converge market with the vault's depth behind it. It is built **only with the public `@converge/sdk`** (plus react, next and viem): `pnpm check:sdk-only` fails if it imports anything else.

"Will ETH be at or above $3,200 at 20:00 UTC?" with live Yes/No prices and the dollars available at each, a demo account or a browser wallet, a buy button, a live fills list and a collect button after settlement.

## Run it

```sh
# 1. a partner creates the market (needs the Phase 8 deployment and an approved, bonded partner account)
pnpm --filter partner-demo create-market --asset TEST/USD --strike 3200 --in 1h
#    prints NEXT_PUBLIC_MARKET=0x…

# 2. point the page at the deployment and run it
export NEXT_PUBLIC_REGISTRY=0x… NEXT_PUBLIC_VAULT=0x… NEXT_PUBLIC_VENUE=0x… NEXT_PUBLIC_COLLATERAL=0x…
export NEXT_PUBLIC_MARKET=0x…        # from step 1
export NEXT_PUBLIC_SPOT_SYMBOL=ETHUSDT   # only for the indicative spot price shown to the trader
pnpm --filter partner-demo dev       # http://localhost:3100
```

The page reads its configuration at request time, so one build serves any deployment. On a chain other than Monad testnet also set `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_CHAIN_ID`. `NEXT_PUBLIC_INDEXER_URL` makes the fills list read from the Envio indexer instead of chain events.

The trader needs MON for gas and test dollars (the page has a "Get 100 test dollars" button on testnet; the demo account's address is shown on the page, fund it with MON).

## The whole journey as code

`lib/flow.ts` is the partner journey in one function (create, wait for quotes, trade, resolve, redeem) using only the SDK. `scripts/run-demo.ts` runs it on testnet and writes `docs/evidence/phase-8/testnet-demo.json`; the anvil end-to-end test runs the same function against the real contracts and keeper.

## Checks

```sh
pnpm --filter partner-demo typecheck
pnpm --filter partner-demo test            # view helpers, config, server render
pnpm --filter partner-demo check:sdk-only
pnpm --filter partner-demo build
```

Testnet only: the demo account's key is generated in the browser and kept in local storage. Do not use it with real funds.
