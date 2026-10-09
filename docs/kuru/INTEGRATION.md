# Converge on Kuru: a new class of asset on Kuru's order book

Sponsor track: **Kuru, "Bring New Assets and Markets to Kuru"**.

## What this adds to Kuru

Every Converge round (a 15-minute "will ETH finish above its opening price?" market) has an **UP token**: an ordinary ERC-20 that pays 1 collateral if the round ends at or above its strike, and 0 otherwise. The DOWN token is the other side. Such tokens are a new kind of asset for a spot order book:

- they are born every 15 minutes and die every 15 minutes (a new Kuru market per round);
- their fair price is not a random walk: it is a digital option, `p = N(d2)`, that converges to 0 or 1 as the round ends;
- they are fully collateralised (1 UP + 1 DOWN = 1 collateral, always redeemable), so a maker can mint inventory and an arbitrageur can always close a mispricing.

`services/kuru` is the infrastructure that makes this viable on Kuru:

| piece | what it does |
|---|---|
| **Lister** (`src/lister.ts`, `src/main.ts`) | For each live round creates the Kuru market for the UP token through `Router.deployProxy` (permissionless). Idempotent: the market address is a pure function of its parameters (`Router.computeAddress`), so a restart never creates a duplicate. |
| **Seeder** | Splits collateral into UP + DOWN on the Converge round, deposits UP and collateral into Kuru's margin account. |
| **Quoter** | Quotes both sides of the book around the same fair probability the Converge vault uses (`@converge/strategy` `fairProbUp`, the vault's on-chain volatility, the relay price). One atomic `batchUpdate` cancels the old quote and posts the new one. Post-only, tick-aligned (bids round down, asks round up), inside [0.02, 0.98]; it pulls its quotes when the round is nearly decided. |
| **Teardown** | At the end of the round: cancel, withdraw the margin, and after resolution redeem the winning tokens. |
| **App panel** (`apps/web/src/components/kuru-panel.tsx`) | "Also on Kuru" on the market page: the Kuru market is found with `computeAddress`, no registry; shows Kuru's best bid and ask next to the vault's price. |
| **Taker demo** (`src/taker.ts`) | A separate wallet buys the UP token from the book and sells it back. |

Market parameters (`src/kuru.ts`, `MARKET_PARAMS`): price precision 1e4, size precision 1e4, tick 10 (0.1 cent), 0 taker and maker fees, AMM spread 100 bps, quote asset = the round's collateral.

## Evidence (Monad testnet, live)

Everything below was run for real on Monad testnet (chain 10143). Hashes and links: [`docs/evidence/kuru/rounds.md`](../evidence/kuru/rounds.md) (generated from `deployments/kuru-testnet.json`), fill: [`docs/evidence/kuru/taker-fill.json`](../evidence/kuru/taker-fill.json).

- Kuru market for the 13:45Z round's UP token: `0x75525B25c504F7a2D78F2847F7A06Bed1631eE33`.
- 18 two-sided quotes in 11 minutes, one pulled when the fair value left the quoting band (the final tx shows the cancel), then withdrawn and the winning tokens redeemed.
- Taker (a different wallet, `0x4569B1b73b37eA1948335767A4243142D7015118`) bought 2.2002 UP for $2.00 (average 0.909 against a 0.828 / 0.909 book) and sold it back for $1.82: the round-trip cost is the quoted spread, as it should be.

## Cost on Monad (measured, not estimated)

Monad bills the gas limit, at about 102 gwei on testnet today.

| operation | gas limit | cost |
|---|---:|---:|
| create the Kuru market (`deployProxy`) | 1.46 M | about 0.15 MON |
| split + approvals + both margin deposits | 0.86 M | about 0.09 MON |
| one cancel-and-replace two-sided quote (`batchUpdate`) | 0.60 M | about 0.062 MON |
| teardown (cancel, withdraw, redeem) | 0.69 M | about 0.07 MON |
| a full round with 18 quotes | 14.2 M | about 1.45 MON |

The first run quoted too eagerly (every 3-cent move). The shipped policy re-quotes when the fair value moves 6 cents or the quote is 4 minutes old, never more than once per 30 seconds (`DEFAULT_POLICY`, unit-tested in `test/quote.test.ts`), which cuts the number of re-quotes (not yet re-measured over a full live round).

## Honest limits

- This is **testnet**. The maker is our own wallet, so the book shows that the pipeline works, not organic demand.
- On testnet the oracle is a signed test report, not Chainlink Data Streams (the Kuru side does not depend on it).
- Kuru's book is spot: a taker pays the spread, and the quote does not know about toxic flow beyond the re-quote policy. The Converge vault has the stronger risk engine (`docs/security/internal-audit.md`); this lister is the thin, permissionless way to put the same price on Kuru.
- Mainnet needs a funded maker and Kuru mainnet addresses (`docs/EXTERNAL.md`).

## Run it

```bash
pnpm --filter @converge/kuru test                       # quote maths: ticks, bands, re-quote policy
pnpm --filter @converge/kuru lister -- --rounds 2       # list, seed, quote, tear down 2 rounds (needs the maker key in .env)
pnpm --filter @converge/kuru taker -- --usd 2           # buy and sell back on the live book
pnpm --filter @converge/kuru report                     # regenerate docs/evidence/kuru/rounds.md
```
