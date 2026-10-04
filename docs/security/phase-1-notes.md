# Phase 1 security notes: outcome market core

Scope: `contracts/src/` (Market, MarketFactory, OutcomeToken, ChainlinkRoundResolver, DataStreamsResolver, Series, MarketNaming). This is an internal review only. An external audit is still required before meaningful TVL.

## Trust assumptions

| Actor / dependency | Can do | Cannot do | Mitigation |
|---|---|---|---|
| **DEFAULT_ADMIN** on MarketFactory (Safe multisig on mainnet) | Register assets (resolver + label); enable/disable assets; set redeem fee for *future* markets (≤ 1%) and the fee recipient; grant/revoke roles; unpause | Change an asset's resolver once set (`AssetResolverFixed`); change any existing market's params, resolver or fee (snapshotted at creation); touch user funds | Safe multisig; fee hard-capped at 100 bps in code |
| **CREATOR** | Create markets for enabled assets at aligned future boundaries (15m/1h) | Create duplicates (`MarketExists`); create past markets (`StartInPast`); influence prices | The scheduler key (Phase 2) |
| **GUARDIAN** | Pause the factory: blocks `createMarket` and `Market.split` | Unpause; block merge, open, resolve, invalidate or redeem | Only admin unpauses |
| **Resolver owner** (Ownable2Step) | Configure an asset's feed / Data Streams feed ID **once** | Re-point a configured asset; set or alter any boundary price | Set-once config; 2-step ownership transfer |
| **Chainlink push feed** (round-proof mode) | Determines P(T) = first round with `updatedAt ≥ T` **in the proxy's current phase** | — | Only current-phase rounds are accepted (`NotCurrentPhase`). During an aggregator migration the old phase can keep transmitting, which would otherwise give two valid "first rounds" (fixed after review M1). The predecessor must be in the same phase with `updatedAt < T`. The first proof stored is permanent. Too-late first round, no round since T after `maxOracleDelay`, or no proof within `livenessGrace` → UNRESOLVABLE; `checkpoint` stores it permanently, so adjacent rounds can never disagree. A migration to a still-empty phase voids conservatively. A compromised feed decides outcomes, which is inherent. |
| **Chainlink Data Streams** (VerifierProxy) | Signs reports; the report whose window contains T is canonical | — | DON signature verified onchain; feed ID and window containment checked; fixed 2-minute finalization window anchored to the first proposal with a lower-hash tie-break; no proposal within `grace` → UNRESOLVABLE. If Chainlink enables an onchain fee manager, the owner sets `parameterPayload` and submitters forward `msg.value` (`Market.open/resolve` are payable), so settlement keeps working (review M2). Native change refunded to the resolver is recoverable by the owner. A compromised DON decides outcomes, which is inherent. |
| **Submitters** (anyone) | Submit proofs or reports; trigger open, resolve, invalidate and `checkpoint` | Choose between prices: current-phase round proofs are unique, and the Data Streams containment rule plus deterministic tie-break remove choice | Permissionless liveness. Evidence passed after a boundary is terminal is ignored rather than reverting. **Residual race at an aggregator phase switch** (review iteration 2, L5): before the proxy switches only the old phase's first round can be proven, and after it only the new phase's. A submitter who waits around a switch within minutes of T can therefore pick between the two. This is narrow (it needs a migration near a boundary and no prompt keeper proof), it is mitigated by the scheduler proving immediately, and it is documented rather than fixed in v1 |
| **MockStreamsVerifierProxy** (TESTNET ONLY) | Whoever holds `STREAMS_TEST_SIGNER_KEY` sets every TEST price | — | Lives in `test/mocks/`. Only `script/Deploy.s.sol` (testnet) deploys it. **Never deploy to mainnet**; the Phase 9 checklist must assert this |
| **Collateral token** (USDC, ADR-003) | Issuer can freeze/blacklist addresses, including a Market | — | Accepted risk (ADR-003). Fee-on-transfer collateral is rejected at `split` |

## How pause preserves exits

`MarketFactory.pause()` (GUARDIAN) sets `paused()`. It is checked in exactly two places:

1. `MarketFactory.createMarket`, via `whenNotPaused`;
2. `Market.split`, via `IMarketFactoryView(factory).paused()`.

No other function reads it. **`merge`, `open`, `resolve`, `invalidate`, `redeem` and `claimable` work in every pause state.** Tests:

- `test_merge_worksWhilePaused`
- `test_redeem_worksWhilePaused`
- `test_pause_blocksCreation_onlyGuardian_unpauseOnlyAdmin`
- the invariant handler toggles pause randomly, and all invariants hold across it.

Exit guarantees by state:

| State | Exit |
|---|---|
| CREATED / OPEN | `merge` a complete pair → 1:1 collateral at any time |
| RESOLVED_UP / RESOLVED_DOWN | `redeem` → winners 1:1 (minus the market's snapshotted fee, ≤ 1%). Fees accrue in the market and are pulled with `claimFees`, so a blacklisted or broken fee recipient can never block redemptions (review L1). `merge` still pays 1:1 per pair |
| INVALID | `redeem` → 0.5 per UP and per DOWN (floor of the total); `merge` → 1 per pair |
| Never resolves | Impossible by construction: every boundary becomes FINAL or UNRESOLVABLE by T + `livenessGrace` (round proof, 1 day) or T + `grace` (Data Streams, 30 min), after which anyone can `invalidate` |

## Solvency invariants (tested)

These are in `test/invariant/MarketInvariants.t.sol` (256 runs × depth 100). The markets cover round-proof and Data Streams resolvers, 15m and 1h, and one with a 1% fee. Path coverage and mutation checks are in `docs/evidence/phase-1/invariant-path-coverage.md`.

- **Exits always work and pay exactly** (lower bound): merge and redeem never revert for an eligible holder, and redeem pays exactly the state-dependent entitlement minus fee. Mutation-tested: a short-paying redeem and a merge blocked when INVALID are both caught.

- Before resolution: collateral held == UP supply == DOWN supply.
- After resolution: collateral held ≥ outstanding claims (UP supply, DOWN supply, or (UP+DOWN)/2) + unclaimed fees.
- Market balance == ghost deposits − ghost withdrawals (no untracked movement).
- No actor withdraws more than they deposited plus the outcome tokens they received. Total withdrawn + fees claimed ≤ total deposited. The fee recipient receives exactly the fees claimed.

Rounding: the INVALID payout floors (u+d)/2 per redeemer, so at most 1 base unit of dust per redeemer stays in the market (`test_redeem_invalidPaysHalf`). That is never an overpayment.

## Known limitations / residual risks

1. **Void incentive (ADR-002 §4).** Once the price path is known, holders of the losing side gain from INVALID (0.5). They can only cause it by preventing *every* submitter from proving within the delay or grace, which is not a contract bug. Monitoring comes in Phase 9.
2. **Round-proof mode at an aggregator phase change.** If the first qualifying round opens a new phase, it cannot be proven (`FirstRoundOfPhase`), so the boundary goes UNRESOLVABLE after `livenessGrace`. This is documented and rare.
3. **Push-feed staleness.** ETH/BTC push feeds have multi-minute gaps (Phase 0 evidence). Round-proof mode is intended for MON only (ADR-002); BTC/ETH use Data Streams.
4. **Data Streams on Monad unconfirmed.** The VerifierProxy has no fee manager or access controller today (ADR-002 pending answer). The `verify` call path is implemented from the documented interface but has **never run against the real verifier**. Fee-mode support is tested only against a mock that requires value and a parameter payload; the exact fee-token encoding Chainlink would require is unverified. Phase 2 must test with a real report. If Chainlink adds an **access controller** that excludes us, verification reverts, boundaries void at T + grace, and recovery means a new resolver plus a new assetId (the factory forbids re-pointing an asset).
5. **Advisory views.** `priceAt` is a view and can show a derived UNRESOLVABLE that later reads PENDING if a late round arrives (round-proof mode). Markets act only through `checkpoint`, which stores terminal statuses permanently, so this never affects outcomes. Indexers should use the `BoundaryUnresolvable` / `BoundarySettled` / `BoundaryProven` events.
6. **Report expiry.** `expiresAt` is not checked by the resolver. Whether the real VerifierProxy rejects expired reports is unverified. Submission happens within minutes, so impact is low; revisit in Phase 2.
7. Contracts are immutable (no proxies) per CLAUDE.md. Fixes ship by redeploying a new factory.
8. **Fee-mode value handling.** `submit` rejects value unless fee mode is on (`parameterPayload` set), so ETH can't be lost to a verifier that charges nothing. In fee mode, overpayment change refunded by the fee manager lands in the resolver and is recoverable only by the owner (`withdrawNative`), not by the payer. Submitters should send the exact quoted fee. LINK-style fees are supported via owner-only `approveFeeToken` with LINK held by the resolver. Both fee paths are tested only against mocks.
