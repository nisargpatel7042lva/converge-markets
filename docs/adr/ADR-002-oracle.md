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

### 2. Canonical report rule (no cherry-picking)

- Many valid signed reports exist around T, so "any report in a window" lets the first submitter pick the outcome. Instead, the **canonical report is the valid report with the smallest `observationsTimestamp` ≥ T** (and ≤ T + tolerance, e.g. 10 s).
- The contract can't know whether an earlier qualifying report exists. So a proposal is not final until a **finalization delay** has passed (e.g. 2 minutes).
- During that delay anyone may replace it with a valid report whose `observationsTimestamp` is **strictly earlier but still ≥ T**.
- If two valid reports share the canonical timestamp, the one with the lower `keccak256(fullReport)` wins. That is deterministic, and the submitter cannot shape it because both reports are DON-signed.
- Settlement finalizes after the delay. The strike for round n+1 of the same asset and duration is round n's settlement price (same T), so trading opens only once the strike is final.

### 3. Delivery

- **Primary:** the Chainlink CRE workflow (Phase 2) fetches the report at each boundary and submits it. CRE supports Monad as a write target (KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62`).
- **Secondary:** a TS fallback submitter in `services/scheduler`, independent of CRE, holding its own Data Streams credentials.
- **Incentive:** submission is permissionless onchain. A fixed settlement reward is paid from fees to the submitter of the finalized report, so third parties with Streams access have a reason to submit. Reports can only be fetched with API credentials, so in practice permissionless submission is a backstop, not the main path.

### 4. Void rule

- If no valid report finalizes within a grace period (e.g. 30 minutes after T), the round is **voided**.
- Void payout is fixed per token: **each UP and each DOWN token redeems for 0.5 USDC**, so one complete pair = 1 USDC. This works for holders of a single side.
- Void is the only outcome a griefer can force (by stopping both submitters), and it is neutral to all holders.

### 5. Sanity bound

A report deviating more than X% (Phase 1 parameter) from the push feed at T is rejected. Push feeds are never the resolution source.

### 6. Testnet

There is no Data Streams verifier with code on Monad testnet. Testnet uses a `MockStreamsVerifier` behind the same `IStreamsVerifier` interface, signed by a test key, and labelled as such in the UI.

## Pending (the named answer)

Nisarg: sign up for Data Streams (https://app.chain.link) and confirm:

- (a) stream IDs for BTC/USD, ETH/USD and MON/USD;
- (b) report schema (v3 crypto expected);
- (c) API/WebSocket access;
- (d) **whether verification is live on Monad mainnet.** Onchain, the VerifierProxy (`typeAndVersion` "VerifierProxy 2.0.0") has `s_feeManager() = 0x0` and `s_accessController() = 0x0`. Either verification is free/ungated, or it is not wired up for live streams yet.

If **MON/USD is not available as a stream**: launch MON at 1h only, resolved by the MON push feed with the strict rule "last update at or before T, aged under 60 s, else void". This is acceptable only because of its observed ~30 s cadence, and note its "new" risk category. Drop MON 15m at launch. If **(d) is "not live"**, mainnet launch waits on Chainlink, or launches 1h BTC/MON on push feeds under the same strict rule (ETH excluded given its 60-minute gaps).

## Consequences

- Phase 1 contracts depend on an `IStreamsVerifier` interface and implement the canonical-report rule, finalization delay, void payout and settlement reward.
- Verification fees (if any) are measured in Phase 2.
- Strong fit for the CRE bounty: CRE is the orchestration layer for open and settle.
