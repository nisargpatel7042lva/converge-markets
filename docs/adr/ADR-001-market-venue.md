# ADR-001: Market venue

- Status: **Accepted for 15m. Kuru (1h) leg pending one named answer from Kuru**: will they grant Converge mainnet market-creation rights?
- Date: 2026-10-04 (revised the same day after the hostile review)
- Evidence: `docs/evidence/phase-0/kuru-spike.md`, `kuru-spike-fork.json`, `kuru-cost-model.txt`, `monad-gas-estimates.txt`, `external-onchain-checks.txt`

## Context: what we measured

The vault must provide liquidity for 3 assets × (96 × 15m + 24 × 1h) = **360 rounds per day**. CLAUDE.md assumes re-quoting every block at about $0.0001 per post-and-cancel. Measured at 102 gwei, MON $0.0343, Monad billing the gas limit:

| Item | USD | Source |
|---|---|---|
| One post + one cancel on Kuru (half a 2-order cancel + avg single post = 529k gas) | **$0.00185 (~18.5x the $0.0001 claim)** | fork |
| One re-quote, atomic `batchUpdate` cancel 2 + post 2 (557k gas) | $0.00195 | fork |
| Same posts on **real Monad mainnet** gas schedule (`eth_estimateGas`): 2-post `batchUpdate` 462,674; single bid 250,101; single ask 316,004 gas | 12–21% below fork | `monad-gas-estimates.txt` |
| Full Kuru round lifecycle: outcome token, market, 2 deposits, first quote, teardown cancel, 2 withdraws | $0.0122 | fork |

Two findings change the picture:

1. **Kuru mainnet market creation is owner-gated.** `Router.deployProxy` on mainnet reverts `Unauthorized()` for anyone except the Kuru owner `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b`. Testnet is open. We cannot create one Kuru market per round on mainnet without Kuru's cooperation.
2. **A pure pm-AMM is not free.** Paradigm's paper (https://www.paradigm.xyz/2024/11/pm-amm) analyses zero-fee pools and states that for the dynamic pm-AMM (L_t = L·√(T−t)) "half the initial wealth is lost by the end" to arbitrage, with constant expected LVR over time. A 15m pool funded with V₀ is expected to lose about V₀/2 per round unless fees and uninformed flow cover it. At 288 rounds per day that dominates every gas number above. Example: $20 per pool gives about $10 × 288 = $2,880 per day of expected LVR before fees.

## Options and scoring

| | A. New Kuru market every round | B. Kuru 1h + pure pm-AMM 15m (first draft) | **D. Oracle-anchored in-vault pool for every round + Kuru 1h when allowed** |
|---|---|---|---|
| Mainnet feasible today | **No** (owner-gated) | Partly (15m only) | **Yes** for in-vault; Kuru leg needs Kuru |
| Kuru round lifecycle/day | 360 × $0.0122 = $4.38 | 72 × $0.0122 = $0.88 | 72 × $0.0122 = $0.88 |
| Quote upkeep/day | $2,526 every block; $101 every 10 s (6 markets) | Kuru $1,263 every block / $51 every 10 s; 15m $0 gas | In-vault: keeper writes fair mids for all live rounds in one tx. **Estimated** ~60k gas ≈ $0.0002 per update. Every block ≈ $46/day, every 2 s ≈ $9/day (to be measured in Phase 1/4). Kuru 1h: same as B |
| LVR / adverse selection | Bounded by re-quote cadence and toxicity guard | **15m: ~50% of pool value per round to arbitrage (paper)** | Bounded by update cadence (one block of staleness at most if updated every block), no-quote window and toxicity guard |
| Taker UX | 1 tx on Kuru | 1 tx (vault) / 1 tx (Kuru) | 1 tx against the vault; 1h also on Kuru |
| Kuru bounty | Strongest, if Kuru allows | Real, if Kuru allows | Real, if Kuru allows. Otherwise testnet-only Kuru demo |
| Complexity for Oct 13 | High (6 Kuru books, margin per round) | Medium-high | Medium: one vault pool type + one adapter |
| Venue risk | All inventory in Kuru MarginAccount (UUPS, owner pause) | 1h inventory only | 1h inventory only |

"Event-driven ≈ 1 re-quote per 20 s" in the first draft was a **guess**. A digital option's delta is large near the strike close to expiry, so fair value moves by 1 tick (0.001) almost every block in the final minutes. The real rate must come from the Phase 3 backtest on historical paths. Until then, use the range from 10 s to every block shown above.

## Decision

**Option D.**

1. **All rounds trade against an in-vault, oracle-anchored pool.** The keeper writes fair mid-prices (N(d2) from the strategy library) for every live round in a single batched transaction. The pool prices swaps as mid ± spread. Depth follows the pm-AMM schedule (liquidity ∝ √(T−t)) with the minimum concentration floor. So we keep pm-AMM's liquidity shape without its no-oracle LVR. Quotes go stale after N blocks without an update, and the no-quote window and toxicity guard apply.
2. **1h rounds are also listed on Kuru**, through an `IVenueAdapter`, **if Kuru grants mainnet creation rights** (allowlisting our factory or creating markets on request). The vault quotes them with event-driven `batchUpdate` under a hard per-round gas budget. On testnet (open creation) we build and demo the Kuru leg regardless.
3. Every venue sits behind `IVenueAdapter`, so a round type can move without touching vault accounting.

## Pending (the named answer)

- **Kuru:** will you allowlist Converge's MarketFactory (or another mechanism) to create up to 72 (1h) or 360 (all) UP/USDC markets per day on mainnet? If no: the Kuru leg ships on testnet only, the bounty submission rests on that, and mainnet runs in-vault only.

## Consequences and deviations

- **Deviation from CLAUDE.md:** "re-quoting every block" is only economic as a cheap in-vault state write, not as Kuru cancel/replace. Kuru-based per-block re-quoting would cost about $2.5k/day, roughly half the $5k launch TVL. Note that the two dominant makers on Kuru's MON-USDC market do re-quote almost every block (270 new orders in 100 blocks, `monad-gas-estimates.txt`). That pays off on a deep, high-volume pair, not on new outcome markets. CLAUDE.md is kept verbatim per the Phase 0 instruction. Nisarg should approve an amendment.
- "Monad lets you re-quote every block" becomes our published, measured claim: about $0.0002 per batched in-vault update (to be measured) vs $0.0019 per Kuru re-quote.
- Phase 3 must deliver: LVR and adverse-selection P&L per round for D at the chosen update cadence, and the fee and spread needed to keep LP returns positive (CLAUDE.md requires LP returns from spreads, not emissions).

## Revisit triggers

- Kuru's answer above.
- A live-testnet spike or real-Monad cancel gas differing by 30% or more from the fork.
- A Phase 1/4 measurement of the batched mid-update showing over 100k gas per update.
