# Phase 4 plan: the Converge Vault

Goal: an LP vault that holds collateral, provides two-sided liquidity to our outcome markets through **bounded** keeper actions and the **forward-priced venue of ADR-004** (accepted by Nisarg on 2026-10-05), values itself conservatively, and lets LPs enter and exit fairly. Security first: a compromised keeper must not be able to take funds.

## Orientation: facts this phase builds on

- **Phase 1:** `MarketFactory` (registry `getMarket(assetId, duration, start)`, `paused()`, `feeRecipient()`), `Market` (split/merge/redeem, `state`, `strike`, `endTime`, `claimable`, `redeemFeeBps`), `OutcomeToken` (decimals = collateral's, 6 for USDC), `DataStreamsResolver` (Data Streams v3 report verification, canonical report = the one whose window contains T).
- **Phase 3 (REPORT.md, ADR-004):** keeper-posted quotes with immediate fills lose to a latency sniper. Forward-priced execution (order at block *b*, executed once at *T_exec = t_order + delay* against the canonical report containing *T_exec*, no cancellation, limit price fixed at placement, taker-prepaid gas) removes it while the delay exceeds the information lead. The lead is unmeasured; the design has zero margin at 2 s.
- `config/strategy.default.json`: launch parameters (spread floor 0.05, depth L = 0.12·NAV, per-market cap 1%, total 8%, no-quote window 30 s, vol multiplier 1.1, delay 5 blocks).
- Testnet (Monad, chain 10143) has **no live Data Streams verifier**: the testnet E2E uses `MockStreamsVerifierProxy` and a test signer, clearly labelled. The deployer holds 10 testnet MON.

## Design (ADR-005 records it)

- **`ConvergeVault`**: ERC-20 shares; ERC-7540-style async requests (`requestDeposit`, `requestRedeem`), settled per **epoch** by anyone (`settleEpoch`); claims pay out afterwards; TVL cap at request time; performance fee over a high-water mark (10%, max 20%); owner (two-step), guardian (pause quoting only), keeper (bounded actions).
- **Two prices per epoch** (conservative NAV): deposits mint at the *upper* NAV, redemptions pay at the *lower* NAV. A mark is only ever a verified Data Streams price (never a keeper value); matched UP+DOWN pairs are worth exactly 1; unmarked or stale excess tokens are worth 0 (lower) or 1 (upper). A round trip loses the band, so nobody gains by timing flows.
- **`ForwardVenue`** (ADR-004): takers place orders (buy/sell UP/DOWN, shares, limit price, prepaid execution reward); anyone executes once at `T_exec` with a verified report; pricing is computed on chain by `QuoteMath` (fair value N(d2), spread = floor ∨ staleness term, inventory skew, a pm-AMM-depth ladder in z-space); the vault enforces its own risk bounds on every fill, independent of the venue.
- **Keeper powers (the whole attack surface):** `setSigma` within an owner-set band and step limit, `splitForInventory` / `mergeInventory` on factory markets of enabled assets within caps. Everything else is permissionless (`executeOrder`, `redeemResolved`, `settleEpoch`, `checkpoint`) or owner-only. No arbitrary call, no transfer to arbitrary addresses, no approvals.
- **Circuit breaker:** `checkpoint()` (anyone) snapshots the day's start NAV and pauses quoting automatically when the lower NAV falls more than the daily limit; claims and requests keep working.

## Deviations from the prompt (all consequences of the ADR-004 decision)

1. **No `KuruAdapter` / `PmAmmPool`.** The forward-priced venue replaces them; there is no resting order book to bound. Fork tests therefore run on a **Monad mainnet fork against the real USDC token** (6 dp ERC-20 behaviour) and the real `VerifierProxy` interface, instead of the Kuru deployment.
2. **No toxicity guard on chain.** Report-only pricing has no tick history; Phase 3 found the toxicity threshold nearly flat (REPORT H3).
3. **Ladder levels are spaced in z-space** (price = Φ(z), size = L_t·Δz, exactly pm-AMM depth) so the chain needs Φ but not Φ⁻¹. The TS library gets a mirror function and the two are cross-tested; the backtest used price-spaced levels (small difference, stated).
4. **NAV is two-sided** (lower for redemptions, upper for deposits) rather than one conservative number, so conservative valuation does not hand depositors a discount at redeemers' expense.

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| T1 | Vendored fixed-point math (Solady, pinned), `QuoteMath` (Φ, φ, d2, fair, spread, skew, ladder) + TS reference + golden-vector parity tests | 1, 2, 6 |
| T2 | `ConvergeVault` core: shares, epochs, requests, claims, TVL cap, fees, roles, ownership, pause | 1, 2, 6 |
| T3 | NAV, marks, inventory registry (bounded), breaker | 1, 2, 3, 6 |
| T4 | `ForwardVenue`: orders, escrow, verified-report execution, risk bounds, refunds | 1, 2, 3, 6 |
| T5 | Keeper-bounded actions, `redeemResolved` | 1, 3, 6 |
| T6 | Tests: unit + every revert and every keeper bound; malicious-keeper fuzz handler; invariants (≥ 256 runs, depth ≥ 100); mainnet-fork tests; hand-checked E2E | 1, 3 |
| T7 | Coverage ≥ 95% on vault, venue, QuoteMath; slither/forge lint zero HIGH/MEDIUM | 2, 4 |
| T8 | `docs/security/threat-model.md` with every mitigation mapped to a test | 6 |
| T9 | Testnet deploy, `deployments/testnet.json`, E2E with tx hashes in `docs/evidence/phase-4/` | 5 |
| T10 | Auditor-persona hostile review, fixes, report | 7 |

## Exit rule

Phase protocol: build/evaluate per task, then the evaluation loop (max 5 iterations), then the report and STOP.

## As built (changes after the first plan, found while building and by our own review)

1. **Settlement is bound to the epoch end.** The first plan let anyone settle at any time with a fresh report. That gives the settler a free option (wait until an exposed round is decided). Final rule: marks are the reports whose window contains the epoch end, the epoch must be settled inside `settleWindow` (default 600 s, always below one 15 minute round, epoch ends on the round grid), otherwise it expires with refunds and re-queued redemptions. Rounds that ended by the epoch end must be resolved first. See ADR-005 and threat-model C1 to C4.
2. **The breaker no longer needs a caller.** `venueFill` re-values the vault at most once a minute from the verified report it priced from (it can only lower the sizing NAV and trip the breaker). `checkpoint` stays permissionless.
3. **Breaker grief fix.** An omitted report uses the last verified mark; an ended-but-unresolved round is valued from the last mark rather than at zero.
4. **Gas measured** (ADR-004 asked for it): 395k per filled order with one registered market, 1.02M with 16.
5. Only Data Streams assets can be enabled in the vault (BTC, ETH). MON (push-feed resolution) is not tradable in the vault.
6. `DeployVault.s.sol` + `deploy-vault.sh`, `scripts/vault-e2e` (real wall-clock testnet run), `script/check-coverage-vault.sh`, `script/invariant-path-coverage-vault.sh`, `make check-4`.
