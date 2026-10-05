# ADR-004: Forward-priced execution (two-step swaps)

- Status: **Accepted by Nisarg on 2026-10-05** (Phase 4 venue design, choice (a)), **with the Known limits below unresolved**: the information lead is unmeasured and the design has zero margin at a 2 s lead. It amends ADR-001 decisions 1 and 2; the Kuru leg is out of Phase 4.
- Date: 2026-10-05
- Evidence: `backtest/report/REPORT.md` (sections 3, 4, 5), `backtest/report/results.json`, `docs/evidence/phase-3/`
- Supersedes: nothing yet. If accepted, it amends ADR-001 decision 1 and 2 (keeper-written mids and onchain band checks).

## Context

ADR-001 chose Option D: a keeper writes fair mids onchain, takers swap against the posted quotes immediately, and the adverse-selection P&L was left "unquantified until Phase 3". Phase 3 quantified it.

- **The fair-value model is usable but needs a tail correction.** It is well calibrated in the middle on 90 days of real BTC and ETH rounds and over-confident in the tails (REPORT section 1); the strategy carries a volatility multiplier for that, and a gap remains for BTC at the launch multiplier.
- **The venue is the problem.** Any maker that fills against a price that is even one second old loses to a trader who sees the current price. On a 15-minute digital the fair probability moves φ(d2)/√τ per √second of price movement, independent of volatility, so near the money and near expiry a one-second information gap makes a quote wrong by several cents, and takers will not pay several cents of spread.
- Against a bot that checks the book on every block with a one-second lead, **no parameter set in the search was profitable** with keeper-posted quotes and immediate fills (REPORT section 4). The bot is not exotic: anyone with a public price feed can run it. This is conditional on the lead and on Binance prices being predictive of Data Streams; neither is measured.
- **The fair-value model is calibrated in the middle but over-confident in the BTC tails** (REPORT section 1); the strategy carries a volatility multiplier for that.

## Options considered (all backtested on the same 90 days)

| Option | Result against a block-by-block sniper |
|---|---|
| A. Keep ADR-001 as is (keeper-posted, immediate fills), tuned | Loses money (REPORT section 4) |
| B. Wider spread floors, 1h-only, quote only mid-round, LP-side taker fee, much smaller depth | Does not change the sign |
| C. Swap-time oracle pricing, still immediate fills | Does not change the sign: the taker still acts on newer information than the price |
| D. **Forward-priced execution**: an order placed in block *b* is executed once, at block *b+n*, against the canonical report of that block, with the taker's limit price fixed at placement | Expected edge positive when n·400 ms exceeds the trader's information lead (REPORT heatmap H4); fails when it does not, or when execution timing is not forced (REPORT section 4) |

## Decision (proposed)

**Option D**, with n = 5 blocks (2 s) as the launch delay, which equals the specification's largest latency. **That is zero margin**; see "Known limits".

1. **Two-step swap.** The taker places an order (side, size, limit price) in block *b* and prepays its execution gas.
2. **Forced, single-shot execution.** At block *b+n* anyone may execute the order, **exactly once**, against the **canonical report** for that block: the report that **contains** the block's timestamp T, i.e. `validFrom <= T <= observationsTimestamp`, the same containment rule as ADR-002's resolution (which rejected "first report at or after T" as exploitable when report windows are not contiguous). The executor has no choice of block or report: **Phase 4 must test that an executor cannot pick a different valid report or a different block**, and a failure of that test is a stop-ship. If the limit price is not satisfied at that block the order expires unfilled; there is no resting order and **no cancellation**. If the executor could choose when to fire, or which report, a trader with a price lead could wait for a favourable moment and the delay would protect nothing (backtest: the *timing-option* rows, which lose money).
3. The vault prices each fill from that report with the Phase 3 quote functions; the keeper no longer writes mids, it only executes pending orders.
4. UX cost: a fill takes about 2 s. The app must say so (Phase 7).

## Known limits (from the Phase 3 hostile review)

- **The delay only neutralises a trader whose information lead is shorter than the delay.** At a 2 s lead (equal to the delay) the sniper's orders essentially never fill, which is why its measured edge is zero, but there is no margin: a 3 s lead breaks it (REPORT section 4, robustness table, and heatmap H4). The Binance-to-Streams lead is **unmeasured**; a delay of 8 blocks (3.2 s) buys more margin at the cost of fill time.
- **Profit against the sniper is a conditional result**, on a 1 s lead and on Binance being predictive of Streams. The simulation shows the sign for the as-specified design; it cannot say how large the sniper's edge would be in production.
- **Equal noise volume is assumed under a 2 s fill.** Any volume lost to the delay reduces the vault's income and is not modelled.
- **Griefing:** an order every block costs execution gas each time, hence the prepaid-gas requirement. The backtest charges gas only for orders that fill.

## Consequences

- **Gas:** onchain pricing (ln, √, Φ) and report verification per executed order are not measured yet. The backtest charges 400k gas per filled order (REPORT assumptions); Phase 4 must measure the real figure. If it is several times higher, revisit.
- **Oracle:** the design needs a low-latency source (Data Streams). Chainlink push feeds update every 30 s (BTC) to 50 s (ETH) at the median and cannot support it (REPORT section 1). The **Binance-to-Streams information lead is unmeasured** (no API key), so the delay is justified against the leads tested, not a measured one.
- **MON** resolves on push-feed round proofs (ADR-002) and is not covered by this analysis.
- **Kuru leg (ADR-001):** unchanged by this ADR. A resting order book has the same stale-quote problem for any maker that cannot cancel faster than the information arrives; evaluating it is Phase 4/5 work.
- The vault is not "re-quoting every block" in the keeper-write sense any more; pricing is computed per execution. CLAUDE.md's "every block" language is satisfied in the sense that the book is recomputed from a fresh report at each execution block.

## Revisit triggers

- A Phase 4 test shows the executor can choose among valid reports or blocks (the whole design depends on it not being able to).
- A Data Streams key shows the Binance-to-Streams lead exceeds 2 s.
- Measured onchain pricing gas makes per-order execution uneconomic.
- Users reject the 2 s fill (conversion data).
