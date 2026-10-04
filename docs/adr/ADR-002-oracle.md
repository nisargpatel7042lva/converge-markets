# ADR-002: Oracle and round resolution

- Status: **Accepted, pending one named answer**: confirmation that Data Streams for BTC/USD, ETH/USD and MON/USD are available to our Chainlink account on Monad.
- Date: 2026-10-04
- Evidence: `docs/evidence/phase-0/chainlink-cadence.txt`, `external-onchain-checks.txt`, `docs/EXTERNAL.md` (Chainlink section)

## Question

Can Chainlink **push** feeds on Monad resolve 15m (and 1h) rounds precisely, i.e. give a trustworthy price *at* each round boundary?

## Data (Monad mainnet, standard proxies, last 40 rounds read onchain 2026-10-04)

| Feed | Heartbeat | Deviation | Update gap min / median / max | Gaps > 15 min |
|---|---|---|---|---|
| BTC/USD 0xc1d4…0546 | 3600 s | 0.02% | 10 s / 170 s / 1,061 s | 1 of 39 |
| ETH/USD 0x1B14…0A04 | 3600 s | 0.05% | 20 s / 311 s / **3,607 s** | **7 of 39** |
| MON/USD 0xBcD7…22fb | 3600 s | 0.02% | 29 s / 30 s / 90 s | 0 |

Testnet has only BTC and ETH, with a 24h heartbeat and 0.5% deviation, and **no MON/USD**.

## Analysis

- A round settles on "price at boundary T". With a push feed that means "last update at or before T". For ETH that value was more than 15 minutes old in 18% of the intervals we sampled, and up to 60 minutes old. **A 15m round could open and close on the same stale round**, which forces a tie or resolves on data from before the round started.
- Even when fresh, a push feed only moves after a 0.02–0.05% deviation. A typical 15m BTC move is about 0.1–0.2%, so the deviation band is a material share of the outcome. Outcomes near the strike would be decided by the feed's update timing, not the market.
- Settling on "first update after T" invites timing games: the result is not known until an arbitrary later time, and it is still deviation-gated.
- MON/USD is close to fine on cadence (about 30 s), but it is still deviation-gated. BTC and ETH, our headline assets, are not fine.

**Conclusion: push feeds cannot resolve 15m rounds precisely.** They are not reliable for 1h ETH rounds either (60-minute gaps happen).

## Decision

1. **Resolve every round (15m and 1h) with a Chainlink Data Streams report verified onchain** through the Monad mainnet VerifierProxy `0xEd813D895457907399E41D36Ec0bE103E32148c8`. The Market contract accepts a report for the round's feed ID whose `observationsTimestamp` is the first one at or after the boundary T (within a tolerance window, e.g. T to T + 10 s). The strike uses the same rule at open.
2. **Delivery:** the Chainlink CRE workflow (Phase 2) fetches the report at each boundary and submits it. CRE supports Monad as a write target (KeystoneForwarder `0x76c9…5E62`). Submission is also **permissionless**: anyone can post a valid verified report, so CRE downtime cannot stall settlement.
3. **Fallback and safety:** if no valid report arrives within a grace period (e.g. 30 minutes after T), the round is **voided** and users redeem at cost (merge-equivalent). The push feed is used only as a sanity bound (reject a report deviating more than X% from the push feed). It is never the resolution source.
4. **Testnet:** Data Streams has no live verifier on Monad testnet (the documented address has no code after re-genesis). Testnet uses a `MockStreamsVerifier` behind the same `IStreamsVerifier` interface, signed by a test key. This is clearly labelled in the UI. Mainnet beta uses the real verifier.

## Pending (the named answer)

- **Nisarg:** sign up for Data Streams (https://app.chain.link) and confirm (a) stream IDs for BTC/USD, ETH/USD and MON/USD, (b) report schema version (v3 crypto expected), and (c) access to the REST/WebSocket API. If **MON/USD is not available as a stream**, launch MON at 1h only, resolved by the MON push feed with strict staleness checks (its 30 s cadence makes that acceptable), and drop MON 15m at launch.

## Consequences

- Phase 1 contracts depend on an `IStreamsVerifier` interface rather than a feed address.
- Report verification costs fees (LINK or native, per the verifier's fee manager), billed per settlement. Measure in Phase 2.
- Strong CRE-bounty fit: CRE is the orchestration layer for open and settle.
