# Phase 3 plan: quoting strategy library and economic backtest

Goal: prove or disprove that the vault earns money from spreads with zero incentives, and choose launch parameters. A losing result is a pivot signal and gets reported as such.

## Orientation: facts this phase builds on

- **Venue (ADR-001, Option D):** every round trades against an in-vault, oracle-anchored pool. The keeper publishes quotes onchain; takers trade against the *posted* quotes. Depth follows the pm-AMM schedule `L_t = L·√(T−t)`. Quotes can be stale by at least one block plus keeper latency, and the ADR explicitly leaves the adverse-selection P&L "unquantified until Phase 3".
- **Resolution (Phase 1 `Market.sol`):** strike = price at the round start boundary; `UP` iff `endPrice >= strike` (ties go UP); `INVALID` pays 0.5.
- **Oracle (ADR-002):** BTC/ETH resolve on Chainlink Data Streams reports, MON on push-feed round proofs (1h only).
- **Gas (ADR-001):** the batched in-vault mid update is estimated at 67–107k gas, realistically 2–3x. Monad bills the gas limit. This is a real cost line.
- **Risk defaults (CLAUDE.md):** TVL cap 5,000 USD, per-market max notional 5% of NAV, total at-risk 40%, daily drawdown breaker 5%, quote bounds [0.02, 0.98], no-quote window final 60 s.
- **Decisions already in force:** USDC collateral (ADR-003), 400 ms blocks.

## Assumptions (each is listed in the report's model section and swept where it matters)

1. Taker flow is synthetic: noise volume is **unknown** until we have users. The report therefore states break-even noise volume, not only a P&L.
2. Binance spot 1 s klines (BTCUSDT, ETHUSDT) proxy Chainlink BTC/USD and ETH/USD. The basis is measured against Chainlink push-feed rounds where practical.
3. MON has no Binance spot market. Only USDⓈ-M perpetual 1 m klines exist, so MON is a supplementary, lower-confidence run and is excluded from the verdict.
4. The price path inside one second is linear (no sub-second jitter), so informed edge at latencies under 1 s is understated. Base and pessimistic cases use latency of 1 s or more.
5. Rounds open some seconds after the boundary (measured Phase 2 open delay), but the strike is the boundary price.
6. The vault only ever sees data older than `latencyMs`; informed traders see the current price.

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| T1 | `packages/strategy`: normal CDF/PDF/inverse, `fairProbUp`, time-aware EWMA vol, pm-AMM liquidity schedule (cited), `generateQuotes`, risk functions, params and validation | 1 |
| T2 | Property tests (fast-check) and unit tests, coverage ≥ 95% on the package | 1 |
| T3 | Data: Binance 1 s klines, ≥ 60 days, SHA-256 verified against Binance's published checksums, cached; Chainlink basis check; MON 1 m perp (supplementary) | 3 |
| T4 | Engine: synthetic rounds exactly as production, noise and informed flow, posted-quote venue with latency and gas, the same `generateQuotes` code the keeper will run, metrics and PnL decomposition | 2, 3 |
| T5 | Sweeps (informed share, latency, min spread, no-quote window, toxicity threshold) with heatmaps, TVL/APY table, base, pessimistic and sniper cases | 3 |
| T6 | `pnpm backtest`: one command, fixed seeds, deterministic JSON, charts (PNG), `REPORT.md` with verdict line and a Limitations section | 2, 3, 5 |
| T7 | Launch parameter selection that survives the pessimistic case, `config/strategy.default.json` with rationale | 4 |
| T8 | `make check-3`, evaluation loop, quant-reviewer hostile review (look-ahead, fills, survivorship, leaks), report, STATUS | 1, 6 |

## Exit rule

If the verdict is UNPROFITABLE, stop after the report and propose concrete design changes, each with backtest evidence.
