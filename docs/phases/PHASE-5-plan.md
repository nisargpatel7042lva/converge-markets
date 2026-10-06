# Phase 5 plan: the keeper

Goal (prompt): a reliable, observable, fail-safe service that keeps every eligible market quoted, pulls quotes instantly when things look wrong and can never do anything the vault would not allow.

## Orientation: what exists and what that means for "quoting"

- **Phase 4 changed what a quote is** (ADR-004/005). There are no resting orders to cancel and replace. The vault's ladder is computed **on chain at execution** from the vault's NAV, sigma and inventory plus the Data Streams report for the order's pricing time. A market is "quoted" when `vault.venueView(market).tradable` is true: registered (inventory split), sigma fresh (15 min), NAV fresh (30 min), not paused, not halted, no settlement pending.
- So the loop's job is to keep that state true and to **execute pending orders** (the taker places an order, anyone executes it within 4 s of its pricing time with the report for that second). That execution is the latency-critical, per-block work.
- The keeper's chain permissions are exactly three functions plus permissionless ones (`checkpoint`, `settleEpoch`, `redeemResolved`, `executeOrder`, `pruneEmpty`). It can not move funds. It also needs the **halt** (new in this phase, see ADR-006).

## Assumptions (stated, per protocol)

1. **Quote** = the ladder struck at execution; **quote age** (the prompt's metric) = for each pending order, the time between its pricing time and the block that included its execution, in blocks. Target p95 <= 2 blocks. Separately we export `tradable` uptime per market and an off-chain preview of the ladder (`packages/strategy/src/onchain.ts`, the same math as the contract) that is checked each block for crossed, off-grid and out-of-bounds levels (target 0).
2. **Pull-all** = `vault.haltQuoting(reason)` (keeper key, new `keeperHalt` flag, independent of the guardian pause and the breaker) plus the keeper stops executing orders. The keeper resumes by itself (`unhaltQuoting`) after the sources have been healthy for a hysteresis period. It can never clear the guardian pause or the breaker (owner only).
3. **Reference price**: Data Streams if access is verified (blocked: no key), otherwise the median of at least two exchange feeds (Binance, Coinbase WebSockets; verified reachable) sanity-checked against the on-chain Chainlink feed on Monad mainnet. A source stale beyond a threshold is dropped; fewer than two healthy sources => pull all. The Data Streams provider is implemented behind the same interface and tested with mocks only.
4. **Testnet**: the vault's TEST/USD asset is verified by `MockStreamsVerifierProxy`; the keeper signs the execution reports with the test signer from the median reference price (TEST-ONLY, labelled). Markets are created, opened and resolved by the Phase 2 fallback scheduler running in parallel (same test signer, same price).
5. **Cost**: Monad bills the gas limit, not gas used, so every transaction sets a tight limit (estimate x 1.15).
6. The testnet run needs MON: roughly 0.06 MON per executed order at about 102 gwei. Needs from Nisarg if the balance runs short.

## Deviations from the prompt (consequences of the Phase 4 architecture)

- No per-block cancel/replace diff of resting orders. The "diff" is between the desired state (sigma, inventory, checkpoint, settlements, due executions) and the vault's state; only the missing transactions are sent.
- "Kuru fork if applicable": not applicable (no Kuru leg in Phase 4).
- The indexer does not exist yet (Phase 6); the keeper reads the chain (events and views).

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| T1 | Vault: `haltQuoting` / `unhaltQuoting` (+ tests, invariants), ABI, redeploy, ADR-006 | 1, 3 |
| T2 | Package skeleton, config (zod), logging, metrics, health/ready server, alerts, kill switch | 1, 5 |
| T3 | Price layer: Binance + Coinbase WS, Chainlink sanity feed, source health, median, shock detector; report provider (test signer, Data Streams stub) | 1, 3 |
| T4 | Chain layer: block source (WS + HTTP fallback), nonce manager (replace stuck, gas cap), tx sender with latency metrics | 1, 5 |
| T5 | Planner (pure): vault state to actions; risk (pure): pull-all triggers; order tracker/executor; settlement and redeem duties | 1, 2, 3 |
| T6 | Modes: live, dry-run, paper | 1 |
| T7 | Unit tests (planner/diff, risk triggers, source health, nonce manager) | 1 |
| T8 | Integration on anvil with the Phase 4 contracts: scripted takers, quotes track fair value, fills accounted | 1 |
| T9 | Chaos tests: RPC kill, stale feed, 2% jump in one tick, fill flood: halt within 2 blocks and automatic recovery | 1, 3 |
| T10 | Dockerfile, docker-compose (keeper + Prometheus + Grafana provisioned dashboard), `docs/ops/keeper-runbook.md` | deliverable |
| T11 | Testnet run >= 2 h with scheduler + taker bot, metrics export, price-shock injection, costs | 2, 3, 4, 5 |
| T12 | Hostile review (SRE + trading-systems persona), fixes, report, STATUS | 6 |
