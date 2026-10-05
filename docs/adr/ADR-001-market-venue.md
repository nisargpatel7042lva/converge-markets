# ADR-001: Market venue

- Status: **Accepted for the in-vault pool. The Kuru (1h) leg is pending one named answer from Kuru**: will they grant Converge mainnet market-creation rights?
- Date: 2026-10-04 (revised twice the same day after hostile review)
- **Phase 3 update (2026-10-05):** the backtest quantified the adverse selection this ADR left open. With keeper-posted quotes and immediate fills (decisions 1 and 2 as written), the vault loses money to a trader whose price leads the vault's by about a second, whatever the parameters (`backtest/report/REPORT.md`, section 4). [ADR-004](ADR-004-forward-priced-execution.md) (Proposed) amends the execution model. This ADR is unchanged until Nisarg decides.
- Evidence: `docs/evidence/phase-0/kuru-spike.md`, `kuru-spike-fork.json`, `kuru-cost-model.txt`, `monad-gas-estimates.txt` (script: `scripts/spike/monad-gas-estimates.sh`), `external-onchain-checks.txt`

## Context: what we measured

The vault must provide liquidity for 3 assets × (96 × 15m + 24 × 1h) = **360 rounds/day**. CLAUDE.md assumes re-quoting every block at about $0.0001 per post-and-cancel.

All prices below use 102 gwei, MON at $0.0343, and the gas limit (Monad bills the limit). "Real Monad" means `eth_estimateGas` against mainnet Kuru MON-USDC, with cancels estimated at a historical block where the maker's orders were live.

USD in this table uses **gas limit = the raw `eth_estimateGas` value** for real-Monad figures. Under the spike's +15% headroom policy, multiply by 1.15: post + cancel ≈ $0.00155 (≈15.5x), re-quote ≈ $0.00223.

| Item | Real Monad gas | Fork gas used | USD (real Monad, limit = estimate) |
|---|---|---|---|
| Re-quote: `batchUpdate` cancel 2 + post 2 | **554,734** | 477k used / 556,879 billed limit (≈ equal to the Monad estimate) | **$0.00194** |
| `batchCancelOrders`, 1 order / 2 orders | 160,836 / 203,849 | 2 orders: 247,968 | $0.00056 / $0.00071 |
| Single post, bid / ask | 250,147 / 316,013 | 317,021 / 342,738 (Monad 8–21% lower) | $0.00088 / $0.00111 |
| **One post + one cancel** (½ of the 2-order cancel + mean single post = 385k) | 385k | 529k | **$0.00135 (~13.5x the $0.0001 claim); $0.00155 (~15.5x) with +15% headroom** |
| Full Kuru round lifecycle (token, market, approve, 2 deposits, first quote, teardown cancel, 2 withdraws) | n/a | fork, limit +15% | $0.0124 |

Two findings change the picture.

1. **Kuru mainnet market creation is owner-gated.**
   - `Router.deployProxy` on mainnet reverts with `Unauthorized()` for anyone except the Kuru owner `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b`.
   - Testnet is open.
2. **A pure pm-AMM is not free.**
   - Paradigm's paper (https://www.paradigm.xyz/2024/11/pm-amm) analyses zero-fee pools. For the dynamic pm-AMM (L_t = L·√(T−t)) it states "half the initial wealth is lost by the end", with constant expected LVR over time.
   - A pool funded with V₀ therefore expects to lose about V₀/2 per round to arbitrage, before fees and uninformed flow. At 288 rounds/day that loss dominates every gas number above.

## Options

| | A. New Kuru market every round | B. Kuru 1h + pure pm-AMM 15m | **D. Bounded, oracle-anchored in-vault pool for every round + Kuru 1h when allowed** |
|---|---|---|---|
| Mainnet feasible today | **No** (owner-gated) | Partly | **Yes** for the in-vault pool. The Kuru leg needs Kuru |
| Kuru round lifecycle/day | 360 × $0.0124 = $4.46 | 72 × $0.0124 = $0.89 | 72 × $0.0124 = $0.89 |
| Quote upkeep/day (6 live markets for A; 3 for the Kuru leg of B/D) | every block $2.5k; every 10 s $101 | Kuru: half of A. 15m: $0 gas | In-vault batched mid update: **estimated 67–107k gas** ($0.00023–0.00037), derivation below. Every block: $50–81/day (**1.0–1.6% of $5k TVL/day**). Every 2 s: $10–16 (0.2–0.3%/day). Every 10 s: $2–3.2. Plus the Kuru leg if enabled |
| LVR / adverse selection | Bounded by re-quote cadence and toxicity guard | **15m: about 50% of pool value per round** (paper) | Bounded by staleness of **at least 1 block plus keeper latency** (observe, compute, submit), plus same-block ordering risk. Large near expiry and near the strike, where a digital's delta is high. **Unquantified until Phase 3** |
| Kuru bounty | Strongest, if Kuru allows | Real, if Kuru allows | Real, if Kuru allows. Otherwise a testnet-only Kuru leg |
| Complexity for Oct 13 | High | Medium-high | Medium |
| Venue risk | All inventory in Kuru MarginAccount (UUPS, owner pause) | 1h only | 1h only |

The event-driven Kuru re-quote rate (the first draft's "≈ 1 per 20 s") is a **guess**. Phase 3 derives it from historical paths.

### Gas derivation for the in-vault mid update (estimate, Monad pricing)

- Fixed costs:
  - base: 21,000
  - calldata for 6 mids: about 3,200
  - KEEPER role check (one cold storage page): 8,100
  - one event per round: about 6 × 1,500 = 9,000
- Per-round state writes, if all live-round mids sit in one contiguous packed array (one 128-slot page): 8,100 + 6 × 2,900 = 25,500. Total about **67k**.
- If each round lives in its own mapping entry (6 cold pages): 6 × (8,100 + 2,900) = 66,000. Total about **107k**.
- Phase 1/4 must measure the real figure, and the storage layout should keep live mids in one page.

## Decision

**Option D.**

1. **All rounds trade against an in-vault, oracle-anchored pool.** The keeper writes fair mids (N(d2) from `packages/strategy`) for all live rounds in one batched transaction. Swaps price at mid ± spread. Depth follows the pm-AMM schedule (liquidity ∝ √(T−t)) with the minimum concentration floor. Quotes go stale after N blocks, and the no-quote window and toxicity guard apply.
2. **The keeper is bounded onchain** (CLAUDE.md: "KEEPER = bounded strategy actions only").
   - **The reference is a verified Data Streams report attached to the update.** Push feeds can't serve: BTC's push price is under 60 s old only about 25% of the time, and ETH's about 9% (`chainlink-cadence.txt`).
   - The keeper's batched update carries one report per asset (`verifyBulk`). The contract computes N(d2) from the report price, the round strike and a governance-bounded σ, and accepts the keeper mid only inside a band around it, within [0.02, 0.98].
   - **If the keeper's mid falls outside the band, that round stops quoting.** It is never clamped, because a clamped mid is a stale quote near expiry, where a digital's fair value can swing from 0.3 to 0.7 in seconds.
   - Per-round and total notional caps (5% and 40% of NAV) bound the worst case from a compromised keeper key.
   - Alternative to evaluate in Phase 4: move the band check to swap time with a taker-attached report, so the keeper writes nothing onchain between trades.
   - **Gas caveat:** the 67–107k derivation above excludes report verification (unmeasured, needs a real signed report), onchain ln/√/N(d2) for each round, and calldata for the reports. Realistic per-update gas may be 2–3x, which puts every-2 s upkeep near 0.5–1% of TVL/day at $5k. **Phase 4 must measure this before committing to a cadence.** The swap-time check above exists to avoid this cost.
3. **Default cadence is set by a TVL budget, not dollars.** Upkeep must stay under a governance cap (proposed 0.2% of NAV/day, i.e. about every 2 s at $5k TVL). The keeper also refreshes immediately when fair value moves by at least 1 tick. Phase 3 picks the cap from the backtest.
4. **1h rounds are also listed on Kuru** through an `IVenueAdapter`, if Kuru grants mainnet creation rights. The vault quotes them with event-driven `batchUpdate` under a hard per-round gas budget, and **cancels all resting orders before T** so nothing rests through settlement. On testnet, where creation is open, we build and demo this leg regardless.

## Pending (the named answer)

- **Kuru:** will you allowlist Converge's MarketFactory, or create markets on request, for up to 72 (1h) or 360 (all) expiring UP/USDC markets/day on mainnet? If not, the Kuru leg ships on testnet only.

## Consequences and deviations

- **Deviation from CLAUDE.md: "re-quoting every block".**
  - Kuru cancel/replace every block costs about $2.5k/day, roughly 50% of launch TVL per day.
  - Even a batched in-vault update every block is about 1.0–1.6% of TVL/day at $5k (it shrinks relative to TVL as TVL grows).
  - So "every block" is a capability, not the default. The default is the TVL-budgeted cadence plus event-driven refresh.
  - The measured fact we publish: **Kuru post + cancel ≈ $0.00135–0.00155 (≈13.5–15.5x Monad's figure, limit = estimate or +15%); full re-quote ≈ $0.0019–0.0022.**
  - For context, the two dominant makers on Kuru MON-USDC post about 200–270 orders per 60–100 blocks, i.e. they re-quote nearly every block. That pays on a deep pair.
- **Deviation from CLAUDE.md: "pm-AMM style dynamic liquidity".** The pm-AMM schedule is kept for depth. Prices are oracle-anchored, because a no-oracle pm-AMM loses about 50% per round.
- CLAUDE.md is kept verbatim per the Phase 0 instruction. Nisarg approves the amendments.
- Phase 3 must deliver, for Option D: adverse-selection P&L per round at the chosen cadence, the spread needed for positive LP returns from spreads alone, and the Kuru re-quote rate.

## Revisit triggers

- Kuru's answer.
- A measured in-vault mid update above 120k gas.
- Phase 3 showing adverse selection that can't be covered by a spread that still attracts takers.
