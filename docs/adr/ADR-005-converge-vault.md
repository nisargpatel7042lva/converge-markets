# ADR-005: The Converge Vault (shares, epochs, two-sided NAV, bounded keeper)

- Status: **Accepted** (Phase 4 design; implements ADR-004, which Nisarg accepted on 2026-10-05 with its Known limits unresolved)
- Date: 2026-10-05
- Evidence: `docs/security/threat-model.md`, `docs/phases/PHASE-4-report.md`, `docs/evidence/phase-4/`
- Amends: ADR-001 decisions 1 and 2 (no keeper-written mids, no Kuru leg in Phase 4)

## Context

The vault must hold LP collateral, make two-sided markets on our outcome markets, value itself conservatively, let LPs enter and leave fairly, and stay safe if the keeper key is stolen. ADR-004 fixed the venue (forward-priced two-step swaps). This ADR fixes everything around it.

## Decisions

### 1. Shares and flows: ERC-7540-style epochs

ERC-20 shares (same decimals as the collateral). `requestDeposit(assets)` and `requestRedeem(shares)` join the **current epoch** (900 s, aligned to the UTC 15 minute grid). `settleEpoch(epochId, reports)` (anyone) strikes one price for the whole epoch, `claimDeposit` / `claimRedeem` pay out. Not full ERC-7540 (no operators, no ERC-165, one requester per request, no cancellation); the request and claim semantics are the same.

**Settlement window.** An epoch settles within `settleWindow` (default 600 s, always shorter than a 15 minute round) of its end. Marks are the Data Streams reports whose window *contains the epoch's end time* (the canonical-report rule of ADR-002 and ADR-004), so the NAV is a function of the price at the epoch end and the settler chooses nothing. Epoch ends and round ends share one grid and the window is shorter than a round, so no round that was running at the epoch end can have ended inside the window: waiting reveals nothing. Rounds that had ended by the epoch end must already be resolved (anyone can resolve them); otherwise the settlement reverts. An epoch nobody settled in time **expires**: deposits are refundable, redemption requests are queued again, nothing is priced late.

### 2. Two prices per epoch (conservative NAV)

- **Lower NAV** pays redemptions, **upper NAV** mints deposits. Pairs (UP+DOWN) are worth exactly 1 (merge never fails). Excess tokens of an unresolved round are worth `Φ(d2)` computed from the verified mark, taking the extremes over {keeper sigma, owner sigmaMin, owner sigmaMax} and widening by `markBand` (5 points). Resolved rounds are exact, net of the redeem fee; invalid rounds pay half.
- Deposits mint rounded **down**, payouts round **down**: both in the vault's favour. A round trip loses the band, so timing flows gains nothing (`testFuzz_roundTripCannotProfit`).
- **Marks are never keeper values.** The keeper's sigma only affects quotes; the NAV uses the whole owner band. The only inputs are verified reports.
- Inflation protection: first deposit mints 1:1 with `DEAD_SHARES` (1000 raw) locked forever; minimum request above them.
- **Redemption liquidity.** Redemptions are filled pro rata to free collateral (balance minus unsettled deposits and unclaimed payouts); the rest is queued again at claim time. The keeper merges pairs to free liquidity.

### 3. Fee, cap, breaker

- Performance fee 10% (hard max 20%) above a per-share high-water mark on the **lower** price, paid in shares to the treasury at settlement. No management fee.
- TVL cap enforced at request time against the last settled upper NAV plus pending deposits; the owner can change it.
- **Circuit breaker** on the lower share price versus the UTC day's start. Evaluated at every settlement, at every `checkpoint(reports)` (anyone) and automatically from fills (at most once a minute, from the verified report the venue priced from; it can only lower the NAV used for sizing and trip the breaker). It pauses *quoting* (new orders, fills, splits). Requests, settlement, claims, merges and redemption of resolved rounds always work. An omitted report can not trip it (last verified mark is used, never zero); an ended-but-unresolved round is valued from the last mark.

### 4. Roles

OWNER (Ownable2Step; a Safe on mainnet): parameters inside hard limits, TVL cap, fee ≤ 20%, asset whitelist and sigma bands, keeper/guardian/treasury, venue replacement behind a 2 day timelock. GUARDIAN: pause quoting only. KEEPER: **three** functions, no other power:

| keeper function | bound |
|---|---|
| `setSigma(asset, σ)` | inside the owner band; ±20% per step while the previous value is fresh; at most once per 30 s |
| `splitForInventory(market, amount)` | factory-created market of an enabled Data Streams asset; state CREATED/OPEN and outside the no-quote window; per-market basis ≤ 30% and total ≤ 50% of the lower NAV; registry ≤ 16 markets; not while quoting is paused |
| `mergeInventory(market, amount)` | only complete pairs held, only registered markets |

All three are value-neutral for the NAV (a pair is always worth 1). `redeemResolved(market)`, `settleEpoch`, `checkpoint` and `executeOrder` are permissionless. There is no arbitrary call, no transfer to an address, no approval.

### 5. The venue boundary

`ForwardVenue` holds only takers' escrow. The vault accepts fills only from the venue address and **re-checks everything**: price bounds [0.02, 0.98], the exact per-market and total loss ceilings (closed-form rooms from `QuoteMath`, plus an exact post-trade loss check), free liquidity, fresh NAV and sigma, quoting not paused. A faulty or replaced venue is therefore capped at the configured ceilings (1% per market, 8% in total at launch).

### 6. Scope and deviations

Only **Data Streams assets** can be enabled (BTC, ETH): the venue needs a report for an exact second, which push-feed round proofs cannot give (MON is out of scope for the vault until it has a Data Streams feed). No Kuru adapter and no on-chain toxicity guard (ADR-004; Phase 3 found the toxicity threshold flat). Ladder levels are spaced in z-space so the chain needs Φ but not Φ⁻¹ (`QuoteMath`, parity-tested against `packages/strategy/src/onchain.ts`).

## Consequences

- The vault is one 38 KB contract (Monad allows 128 KB, `docs/EXTERNAL.md`).
- A fill walks the registry: **395k gas in the forge test with one registered market and 1.02M with 16** (`test_gas_executeOrder*`); **590,921 gas measured on Monad testnet** for the E2E fill with one registered market (tx `0xb39bb127...`, `docs/evidence/phase-4/testnet-e2e.md`). ADR-004 assumed 400k: the real figure is about 1.5x that with one market and will be higher with many. The executor reward (`minReward`, owner-set) must be set above gas price × ~1.2M gas; the testnet value (0.001 MON) is not a production value.
- NAV staleness (30 min) or sigma staleness (15 min) stops quoting; both recover with `checkpoint` and `setSigma`.
- The window-and-expiry rule means a Data Streams outage can delay LP flows (they roll over); it can not trap funds, and inventory made of pairs needs no mark.

## Known limits (see the threat model)

1. Report contiguity is a Chainlink guarantee we rely on (a duplicate valid report for the same second would let an executor choose).
2. A compromised keeper with a colluding taker can mis-price within the owner's sigma band; the loss is bounded per round by the loss ceilings and stopped by the breaker. Keep the band tight.
3. Requests made in the last seconds of an epoch know the price at the epoch end almost exactly; the 5-point band is what pays for that.
4. Collateral (USDC) freeze or blacklist of the vault address is outside our control.
