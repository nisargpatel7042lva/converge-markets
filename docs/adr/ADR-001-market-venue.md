# ADR-001: Market venue

- Status: **Accepted (provisional)**. Re-check once the live-testnet spike numbers exist (one named input below).
- Date: 2026-10-04
- Evidence: `docs/evidence/phase-0/kuru-spike.md`, `kuru-spike-fork.json`, `kuru-cost-model.txt`

## Context

The vault has to provide two-sided liquidity for 3 assets × (96 × 15m + 24 × 1h) = **360 rounds per day**. CLAUDE.md assumes we "re-quote every block" because Monad claims about $0.0001 per post-and-cancel. We were told to measure that claim. The spike shows it **does not hold on Kuru**:

| Measured (fork, Ethereum gas schedule, 102 gwei, MON $0.0343) | USD |
|---|---|
| Create one Kuru market (`deployProxy`, gas limit 1.40M) | $0.0049 |
| Full per-round setup (outcome token + market + 2 margin deposits + first bid/ask) | $0.0094 |
| One re-quote (atomic `batchUpdate`: cancel 2, post 2; 557k gas limit) | **$0.0019** |
| One post + one cancel, unbatched | ~$0.0018 (about 18x Monad's $0.0001 claim) |

Creating markets is cheap. **Re-quoting is the cost driver.**

## Options and scoring

Assumptions: 6 markets live at once (one UP market per asset × duration; DOWN is synthetic through mint/merge). Re-quote cost from the spike. pm-AMM swaps price themselves from the curve and time-to-expiry, so they need **no keeper transactions to keep quotes current**.

| | A. New Kuru market every round | B. Hybrid: Kuru for 1h+, in-vault pm-AMM for 15m | C. pm-AMM for everything, Kuru only for longer-dated |
|---|---|---|---|
| Kuru markets created/day | 360 | 72 | ~0 in the wedge (we list no longer-dated markets yet) |
| Setup cost/day | $3.40 | $0.68 | ~$0 |
| Keeper re-quote cost/day, every block | $2,526 | $1,263 (3 Kuru markets) | $0 |
| …every 10 s | $101 | $51 | $0 |
| …event-driven (move ≥ 1 tick, max every 30 s, assumed ≈ 1 per 20 s) | ~$50 | ~$25 | $0 |
| UX latency for a taker | 1 tx (Kuru market order), about 1 block | 15m: 1 tx against the vault. 1h: 1 tx on Kuru | 1 tx against the vault |
| Price quality | Depends on keeper cadence. Stale between re-quotes, so toxic flow risk | 15m: continuous curve but LVR (bounded by pm-AMM design). 1h: keeper | Continuous curve, LVR |
| Kuru bounty eligibility | Strongest (every round is a new Kuru market) | **Real**: 72 new Kuru markets per day and a vault that makes them viable | Weak to none in the wedge |
| Complexity for Oct 13 | High: per-round margin deposit/withdraw, order-id tracking, re-quote loop for 6 books, upgradeable venue in the vault's trust path for all flow | Medium-high: two venue adapters, but each is smaller | Lowest |
| Venue risk | All LP inventory sits in Kuru MarginAccount (UUPS, owner can pause) | Only 1h inventory | None |

## Decision

**Option B, hybrid.**

1. **15-minute rounds trade against an in-vault pm-AMM pool.** No re-quote transactions. Liquidity decays toward expiry per the pm-AMM schedule (to be verified against the paper in Phase 3), with the minimum concentration floor.
2. **1-hour rounds get a fresh Kuru UP/USDC market each round** (72 per day, about $0.68 per day to create). The vault quotes them through a Kuru venue adapter using **event-driven re-quotes**: post a ladder with `batchUpdate`, and re-quote only when fair value moves at least 1 tick or the toxicity guard fires. Hard budget: a per-market re-quote gas cap per round, enforced by the keeper and tracked in metrics.
3. Both venues sit behind one `IVenueAdapter` interface, so a single round type can move venues without touching the vault.

## Why not A

The economics fail at our launch size. At the $5,000 TVL cap, re-quoting every block costs about $2.5k per day (about 50% of TVL per day). Even every 10 s costs about $100 per day (2% per day), which LPs would have to recover through spread on day-one volume we don't have. It also puts all LP inventory inside an upgradeable third-party margin account.

## Why not C

It is the cheapest, but it gives up the Kuru bounty and the "new class of markets on Kuru" story. B keeps both at a known, bounded cost.

## Consequences and deviations

- **Deviation from CLAUDE.md:** the line "re-quoting every block" does not hold on Kuru at today's gas. Under B, the 15m product needs no re-quotes at all, and the Kuru side re-quotes on events. We will publish the measured numbers (the CLAUDE.md requirement to "MEASURE and publish this number" is met by this ADR). CLAUDE.md is left verbatim per the Phase 0 instruction. Nisarg should approve wording for an amendment.
- The keeper (Phase 5) becomes much simpler for 15m markets and is budgeted for 1h markets.
- Kuru markets are UP-only. DOWN exposure comes from mint (UP+DOWN) and selling UP, or from the vault's pm-AMM.

## Revisit triggers (the named input)

- **Live-testnet spike (needs about 2 testnet MON):** if real Monad gas for a `batchUpdate` re-quote is at least 30% different from the fork, recompute the table. If a re-quote drops below about $0.0003, put Option A back on the table for 15m.
- Kuru's answers to the questions in `kuru-spike.md` (especially listing policy and bounty eligibility of expiring markets).
