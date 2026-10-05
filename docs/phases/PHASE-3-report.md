# Phase 3 report: quoting strategy library and economic backtest

## Status: COMPLETE WITH CAVEATS

**Verdict (details and numbers in `backtest/report/REPORT.md`, first lines):**

- **UNPROFITABLE as specified** (ADR-001 Option D: keeper-posted quotes, immediate fills). On the 30-day hold-out (an independent restart), with the best parameters the search found, expected net edge is **−$88/day** against a block-by-block latency sniper with a 1 s information lead, and +$1.4/day under the specification's pessimistic flow. 0 of 145 parameter sets screened for this design had a positive expected edge under the sniper (best −$107/day).
- **PROFITABLE UNDER PESSIMISTIC ASSUMPTIONS on the hold-out, with one design change** (forward-priced execution, ADR-004, **Proposed, not accepted**; MARGINAL on the training window under the pessimistic flow, and realized P&L is about 56% of the expected edge over 90 days): expected +$49.6/day (pessimistic flow) and +$215/day (sniper) on the hold-out; realized P&L excluding informed gains +$1,175 / +$6,817 with 95% block-bootstrap CIs [+$247, +$2,174] / [+$1,732, +$9,340] on a $5,000 vault.
- **That is not robust, and the report says so up front:** the sniper's edge is zero only while its lead does not exceed the 2 s delay. At a 3 s lead the proposed design makes −$145/day, and if execution timing is not forced (a sniper that picks its block) −$108/day even at a 1 s lead. The information lead is **unmeasured**: it needs a Chainlink Data Streams key.

Per the prompt, because the verdict for the specified design is UNPROFITABLE, the phase stops at the report with concrete design changes and backtest evidence for each (REPORT section 4).

## What was built

- **`packages/strategy`** (pure TS, no I/O): `normCdf/normInv` (1e-16 accuracy), `fairProbUp` (digital option, clamped, stable at tiny τ), time-aware EWMA volatility (identical at 1 s and 1 m sampling) with a fat-tail `scale`, rolling price range for the toxicity guard, the dynamic pm-AMM liquidity schedule (Paradigm, section "Dynamic pm-AMM / Constant LVR", formulas checked against the paper's TeX and cross-tested numerically), `generateQuotes` (half-spread = floor ∨ staleness term + toxicity widening, tanh inventory skew, no-quote window, bounds, per-market and total at-risk caps, concentration floor, DOWN by complement), `shouldRepost`, risk functions (exposure, at-risk, loss ceiling, exact room formulas, drawdown breaker), parameter validation. Files: `packages/strategy/src/*.ts`.
- **`backtest/`**: verified Binance data layer, a causal sample-and-hold simulator (`src/sim.ts`), taker flow (Poisson noise with price elasticity; informed arrivals; a block-by-block sniper), two venue designs, posted vs swap-time pricing, forward-priced execution, gas models, exact PnL decomposition, parameter search with a train/hold-out split, 7 sensitivity grids, curves, charts, and the report generator (`src/pipeline/*`, `src/cli.ts`).
- **Data:** 91 days (2026-07-05 to 2026-10-03) of 1 s BTC/ETH Binance spot klines, every archive checked against Binance's SHA-256 and pinned in `backtest/data/manifest.json` (273 files). Chainlink push-feed history on Monad (155k BTC, 78k ETH rounds) used for the basis and cadence (`backtest/data/chainlink-basis.json`). **MON excluded** from the economics (no spot, no 1 s history); reported for context.
- **`config/strategy.default.json`**: launch parameters (for the proposed design only), with provenance; rationale in REPORT section 6, generated from the sweeps.
- **Docs:** `docs/phases/PHASE-3-plan.md`, `docs/adr/ADR-004-forward-priced-execution.md` (Proposed), an addendum on ADR-001, `docs/EXTERNAL.md` Phase 3 rows, `docs/evidence/phase-3/*`.

## How to verify it yourself

```bash
cd ~/converge
pnpm --filter @converge/backtest backtest:data    # download + verify Binance archives (about 370 MB)
make check-3                                      # all gates; ends "check-3 OK"
pnpm backtest                                     # about 70 min; rewrites backtest/report/* and config/strategy.default.json
```

Running `pnpm backtest` twice produces byte-identical `results.json`, `tuning.json`, `REPORT.md` and `config/strategy.default.json` (`docs/evidence/phase-3/determinism.txt`).

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-3` passes, ≥ 95% coverage on `packages/strategy` | **PASS.** 93 property and unit tests (fast-check); coverage 100% statements/lines/functions, 98.7% branches (gate 95%); also 162 forge tests, 41 backtest tests, slither and lint clean | `docs/evidence/phase-3/check-3.txt`, `strategy-coverage.txt` |
| 2 | `pnpm backtest` regenerates the report deterministically (two runs, identical JSON) | **PASS.** sha256 of results, tuning, report and config identical across two full runs | `docs/evidence/phase-3/determinism.txt`, `backtest-run1.log`, `backtest-run2.log` |
| 3 | Report has data sources, every assumption, base case, pessimistic case, sensitivity heatmaps, explicit Limitations | **PASS** (sections 1, 2, 3, 4, 5, 7; 14 limitations) | `backtest/report/REPORT.md` |
| 4 | `config/strategy.default.json` exists with a rationale | **PASS** (rationale: REPORT section 6, computed from the sweeps; valid for the Proposed design only) | `config/strategy.default.json` |
| 5 | Verdict line at the top of REPORT.md with numbers | **PASS** (UNPROFITABLE as specified; PROFITABLE UNDER PESSIMISTIC ASSUMPTIONS for the proposed design; not-robust caveat in the same paragraph) | `backtest/report/REPORT.md` |
| 6 | Quant hostile review: no open CRITICAL/HIGH | **PASS** after two iterations (see "Hostile review") | `docs/evidence/phase-3/hostile-review.md` |

## Test summary

- `packages/strategy`: 93 tests (fast-check properties: probabilities monotone in S and (where it holds) in τ, bounds, never crossed, never through fair value, sizes shrink toward expiry, concentration floor, room formulas exact); coverage 100 / 98.7 / 100 / 100 (statements / branches / functions / lines).
- `backtest`: 45 tests (iteration 2 added mutation-checked tests): P&L decomposition exact and independently reconstructed from raw fills, determinism, a per-block price-read tripwire and fill-time cutoffs (injected +1 and +30 bar look-aheads are caught; the earlier cutoff test missed all three), settlement rule, redeem and LP fees, elasticity, gas, single-shot vs timing-option execution, verdict rule, data layer (zip, µs/ms klines, bar alignment, forward-fill).
- Static analysis: forge lint and slither unchanged (no contract changes this phase).

## Hostile review

Two passes by an independent quant-reviewer subagent. **Iteration 1: 0 CRITICAL, 3 HIGH, 6 MEDIUM, 6 LOW; the code had no accounting or look-ahead bug (P&L independently reconstructed to 1e-13), but headline claims went beyond the evidence.** All were addressed: the proposed design's single-shot execution rule and robustness table (H1), honest method and conditional verdict (H2), tail calibration with a train-window volatility multiplier (H3), verdict CIs on the same metric as the expected edge with block bootstrap and an independent hold-out restart (M1, M3), a causality tripwire with demonstrated power (M2), and wording or modelling fixes for the rest. **Iteration 2: 0 CRITICAL, 1 HIGH, 7 MEDIUM, 6 LOW; no accounting or look-ahead bug.** The HIGH was that "PROFITABLE" for the proposed design is window-selective (MARGINAL on the training window, realized about 56% of expected over 90 days) and one figure was mislabeled; fixed in the report (a per-window table, a corrected verdict paragraph). The MEDIUMs were stale text, claimed fixes without tests (new mutation-checked tests added), no-op design-table rows, an ADR-004 canonical-report rule (now containment, with an executor-cannot-choose acceptance test for Phase 4), and hold-out wording. **Open, documented:** one untested order-dropping path (LOW) and a DOWN-side fee inconsistency that only affects the 1%-fee design-table row (fixing it would invalidate both full runs). No open CRITICAL or HIGH. Log: `docs/evidence/phase-3/hostile-review.md`.

## Deviations from the spec and ADRs written

1. **A sniper scenario and a second venue design were added** beyond the specified flow model, because the specified Poisson-arrival informed flow understates what a stale-quote vault faces. They were developed after exploring training-window results (the report says so).
2. **ADR-004 (Proposed)** changes ADR-001's execution model; ADR-001 carries an addendum and is otherwise unchanged until Nisarg decides.
3. **MON excluded** from the economic backtest (no 1 s history, different resolver).
4. **`vol.scale`** added to the strategy's volatility config (fat-tail multiplier, 1.1 from training-window calibration).
5. **Block grid offset 100 ms, sample-and-hold 1 s prices** (no interpolation), so sub-250 ms leads are not resolved.
6. **Risk caps tuned tighter** than CLAUDE.md defaults (per-market 1%, total 8%), which the spec allows.

## Known issues and risks

- **The information lead is unmeasured.** Everything about the sniper depends on how far a trader's price leads the vault's. Data Streams access is needed to measure the Binance-to-Streams lead; without it the 2 s delay is justified only against leads tested.
- **The proposed design has zero margin at a 2 s lead** and loses at 3 s; execution must be forced single-shot against the canonical report with no cancellation (ADR-004), or it loses.
- **Taker flow is synthetic**: volume, size and elasticity are assumptions. The report gives break-evens and sensitivities, not forecasts. APY figures are sensitivities.
- **One quiet regime** (BTC realized vol 28%, ETH 41%; ADR-002 assumed about 50%), 90 days, two assets, one 30-day hold-out.
- **Costs not modelled in the proposed design**: Data Streams verification fees, keeper infrastructure, griefing and failed-execution gas (hence taker-prepaid gas), onchain pricing gas (assumed 400k per fill, unmeasured), volume lost to a 2 s fill.
- **Outcome residual**: the 15-minute markets lose to outcome luck over the 90 days in the proposed design (REPORT section 3.4); its t-statistic is reported, and the fair-value tails are mildly over-confident even after the multiplier.
- The Binance sniper may overstate production adverse selection (a print absent from Streams is no edge) or understate it (a better feed).

## Needs from Nisarg

1. **A decision on the venue design before Phase 4.** ADR-001 as written (keeper-posted quotes, immediate fills) is unprofitable against latency snipers; ADR-004 proposes forward-priced execution. Phase 4's vault core (async epoch shares, NAV, fees, roles, bounded keeper actions, circuit breaker) is the same either way; the venue module and the threat model differ. **Options:** (a) accept ADR-004 (Recommended); (b) keep ADR-001 and accept the sniper risk, capping TVL and depth; (c) both, behind a venue interface.
2. **A Chainlink Data Streams API key and secret** (https://chain.link/data-streams) and the BTC/ETH feed IDs, to measure the Binance-to-Streams lead and verify the 2 s delay. Put them in `services/scheduler/fallback/.env` as `DATA_STREAMS_API_KEY` and `DATA_STREAMS_API_SECRET`. No key was found on disk when this was checked.
3. **A CRE account** (https://app.chain.link/cre) for the scheduler deploy.
4. **Kuru mainnet market-creation rights** (a person-to-person ask) and the product-claim amendment from Phase 0.
5. The testnet wallet now holds 10 MON, which unblocks the earlier-phase testnet items (Kuru spike, Phase 1 lifecycle, Phase 2 soak). I have not run them; say if you want them done before or alongside Phase 4.

## Readiness for the next phase

**Yes for the design-independent core of Phase 4, but the venue module should wait for decision 1.** The shares, epochs, NAV, fee, role and circuit-breaker logic, and the bounded keeper actions on whitelisted factory markets, do not depend on it. The Kuru adapter and pm-AMM pool in the Phase 4 prompt assume keeper-posted quotes, which this phase found unprofitable against snipers.
