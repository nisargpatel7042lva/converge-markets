# ADR-002: Oracle and round resolution

- Status: **Accepted, pending one named answer**: confirmation that Chainlink Data Streams verification is live on Monad mainnet with BTC/USD, ETH/USD and MON/USD streams available to our account.
- Date: 2026-10-04 (revised after the hostile review)
- Evidence: `docs/evidence/phase-0/chainlink-cadence.txt`, `external-onchain-checks.txt`, `docs/EXTERNAL.md` (Chainlink)

## Question

Can Chainlink **push** feeds on Monad resolve 15m (and 1h) rounds precisely, i.e. give a trustworthy price *at* each round boundary?

## Data (Monad mainnet standard proxies, last 40 rounds read onchain 2026-10-04)

| Feed | Heartbeat | Deviation | Update gap min / median / max | Gaps > 15 min | Directory risk category |
|---|---|---|---|---|---|
| BTC/USD 0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546 | 3600 s | 0.02% | 10 / 170 / 1,061 s | 1 of 39 | low |
| ETH/USD 0x1B1414782B859871781bA3E4B0979b9ca57A0A04 | 3600 s | 0.05% | 20 / 311 / **3,607 s** | **7 of 39** (≈34% of the 24,653 s window was more than 15 min after the last update) | low |
| MON/USD 0xBcD78f76005B7515837af6b50c7C52BCf73822fb | 3600 s | 0.02% | 29 / 30 / 90 s | 0 | **new** |

Testnet has only BTC and ETH (24h heartbeat, 0.5% deviation). **No testnet MON/USD.**

## Analysis

- With a push feed, "price at boundary T" means "last update at or before T". For ETH that value was more than 15 minutes old for about a third of the sampled time, and up to 60 minutes old. A 15m round could open and close on the same stale round.
- Even when fresh, a push feed only moves after a 0.02–0.05% deviation. BTC 15m volatility is about 50% / √(35,040) ≈ **0.27%** (1σ at ~50% annualised vol), so the deviation band covers a material share of outcomes near the strike. Those outcomes would be decided by feed-update timing.
- "First update after T" is deviation-gated and its timing is arbitrary.

**Conclusion: push feeds cannot resolve 15m rounds precisely, and are unreliable for ETH 1h rounds.**

## Decision

### 1. Source

Every round (15m and 1h) resolves with a **Chainlink Data Streams report verified onchain** through the Monad mainnet VerifierProxy `0xEd813D895457907399E41D36Ec0bE103E32148c8`.

### 2. Boundary prices and the canonical report rule

The contract keeps **one boundary-price record P(asset, T) per aligned UTC boundary T**. A round [T_start, T_end) opens with strike K = P(T_start) and settles on P(T_end). Round n+1's strike is round n's settlement record, so there is a single source of truth and nothing to re-fetch. The first round of a series bootstraps from P(T₀) like any other boundary.

Rules for P(T):

- **Exact match preferred.** A report with `observationsTimestamp == T` is canonical. Otherwise the canonical report is the one with the smallest `observationsTimestamp` in (T, T + tolerance], e.g. 10 s.
- **Proposals.** The first valid proposal starts a finalization window of fixed length (e.g. 2 minutes) **anchored to the first proposal and never restarted**. During the window, anyone may replace the current proposal with a valid report that has
  - a strictly earlier `observationsTimestamp` (still ≥ T), or
  - an equal `observationsTimestamp` and a lower `keccak256(reportData)`. The hash covers `reportData` only, not signatures, so the submitter can't grind it.
- **Bounded griefing.** Because the window never restarts, replacement spam can't delay finalization.
- **Finality.** P(T) is final at first-proposal + window. Trading in the round that starts at T opens only then. With the 60 s no-quote window at the end, a 15m round therefore trades for about **12 of its 15 minutes**.

Single-source fallback rule (round-proof mode, used where Data Streams is unavailable):

- P(T) = the answer of the **first** push-feed round with `updatedAt ≥ T`, proven by supplying that roundId. The contract checks that the previous round in the same phase has `updatedAt < T`.
- If none arrives within `maxOracleDelay`, P(T) is unresolvable.
- This is deterministic (no cherry-picking), but inherits the push-feed staleness above. It is acceptable only for MON (about 30 s cadence).

Both modes sit behind one `IPriceResolver` interface.

### 3. Delivery

- **Primary:** the Chainlink CRE workflow (Phase 2) fetches the report at each boundary and submits it. CRE supports Monad as a write target (KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62`).
- **Secondary:** a TS fallback submitter in `services/scheduler`, independent of CRE, with its own Data Streams credentials.
- **Incentive:** submission is permissionless onchain. A fixed settlement reward goes to whoever submitted the finalized report, **funded by a protocol fee in basis points on vault swaps** (a Phase 4 parameter; 0 until the vault exists, during which the team's submitters run unpaid). Reports need API credentials to fetch, so permissionless submission is a backstop, not the main path.

### 4. Void (INVALID) rule

- If P(T) is not final by T + grace (e.g. 30 minutes), **every round touching T is voided**: the one ending at T and the one starting at T. The series resumes at the next boundary whose P finalizes, so voids don't cascade.
- Void payout is fixed per token: **each UP and each DOWN redeems for 0.5 collateral**, so a complete pair = 1.
- **A void is not neutral.** Once the price path is known, 0.5/0.5 moves value from would-be winners to would-be losers, so losers gain from forcing a void. Mitigations:
  - two independent submitters plus the reward make non-submission costly;
  - the sanity bound (below) can never cause a void;
  - Phase 9 monitors the void rate.
  - The residual risk is accepted and documented in `docs/security/`.

### 5. Sanity bound

A report deviating more than X% from the push feed is rejected **only when the push price is fresh** (age < N s at T). A stale push feed disables the check rather than rejecting a valid report, because ETH's push feed can be 60 minutes stale and a stale bound could otherwise force voids. Push feeds are never the resolution source in Data Streams mode.

### 6. Testnet

There is no Data Streams verifier with code on Monad testnet. Testnet uses a `MockStreamsVerifier` behind the same `IStreamsVerifier` interface, signed by a test key, and labelled as such in the UI.

## Pending (the named answer)

Nisarg: sign up for Data Streams (https://app.chain.link) and confirm:

- (a) stream IDs for BTC/USD, ETH/USD and MON/USD;
- (b) report schema (v3 crypto expected);
- (c) API/WebSocket access;
- (d) **whether verification is live on Monad mainnet.** Onchain, the VerifierProxy (`typeAndVersion` "VerifierProxy 2.0.0") has `s_feeManager() = 0x0` and `s_accessController() = 0x0`. Either verification is free/ungated, or it is not wired up for live streams yet.

If **MON/USD is not available as a stream**: launch MON at 1h only, resolved by the MON push feed in round-proof mode (first round with `updatedAt ≥ T`, `maxOracleDelay` 120 s). This is acceptable only because of its observed ~30 s cadence (max gap seen 90 s), and note its "new" risk category. With a 60 s cap instead, about 2% of boundaries would void, from gaps of 61, 61 and 90 s in 1,470 s. Drop MON 15m at launch. If **(d) is "not live"**, mainnet launch waits on Chainlink, or launches 1h BTC/MON on push feeds under the same strict rule (ETH excluded given its 60-minute gaps).

## Consequences

- Phase 1 contracts resolve through an `IPriceResolver` interface, with two implementations: Data Streams (canonical-report rule, fixed finalization window) and Chainlink round-proof. They also implement the INVALID payout. The settlement reward is wired in Phase 4.
- Verification fees (if any) are measured in Phase 2.
- Strong fit for the CRE bounty: CRE is the orchestration layer for open and settle.
