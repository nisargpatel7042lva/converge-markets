# Phase 1 security notes: outcome market core

Scope: `contracts/src/` (Market, MarketFactory, OutcomeToken, ChainlinkRoundResolver, DataStreamsResolver, Series, MarketNaming). This is an internal review only. An external audit is still required before meaningful TVL.

## Trust assumptions

| Actor / dependency | Can do | Cannot do | Mitigation |
|---|---|---|---|
| **DEFAULT_ADMIN** on MarketFactory (Safe multisig on mainnet) | Register assets (resolver + label); enable/disable assets; set redeem fee for *future* markets (≤ 1%) and the fee recipient; grant/revoke roles; unpause | Change an asset's resolver once set (`AssetResolverFixed`); change any existing market's params, resolver or fee (snapshotted at creation); touch user funds | Safe multisig; fee hard-capped at 100 bps in code |
| **CREATOR** | Create markets for enabled assets at aligned future boundaries (15m/1h) | Create duplicates (`MarketExists`); create past markets (`StartInPast`); influence prices | The scheduler key (Phase 2) |
| **GUARDIAN** | Pause the factory: blocks `createMarket` and `Market.split` | Unpause; block merge, open, resolve, invalidate or redeem | Only admin unpauses |
| **Resolver owner** (Ownable2Step) | Configure an asset's feed / Data Streams feed ID **once** | Re-point a configured asset; set or alter any boundary price | Set-once config; 2-step ownership transfer |
| **Chainlink push feed** (round-proof mode) | Determines P(T) = first round with `updatedAt ≥ T` | — | Proof requires a same-phase predecessor with `updatedAt < T`, so there is exactly one valid proof per boundary. Too-late first round, no round since T after `maxOracleDelay`, or no proof within `livenessGrace` all make the boundary UNRESOLVABLE → INVALID (0.5/0.5). A compromised or wrong feed decides outcomes. This trust is inherent to Chainlink. |
| **Chainlink Data Streams** (VerifierProxy) | Signs reports; the report whose window contains T is canonical | — | DON signature verified onchain; feed ID and window containment checked; fixed 2-minute finalization window anchored to the first proposal with a lower-hash tie-break; no proposal within `grace` → UNRESOLVABLE. A compromised DON decides outcomes, which is inherent. |
| **Submitters** (anyone) | Submit proofs or reports; trigger open, resolve and invalidate | Choose between prices: the round proof is unique, and the Data Streams containment rule plus deterministic tie-break remove choice | Permissionless liveness |
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
| RESOLVED_UP / RESOLVED_DOWN | `redeem` → winners 1:1 (minus the market's snapshotted fee, ≤ 1%); `merge` still pays 1:1 per pair |
| INVALID | `redeem` → 0.5 per UP and per DOWN (floor of the total); `merge` → 1 per pair |
| Never resolves | Impossible by construction: every boundary becomes FINAL or UNRESOLVABLE by T + `livenessGrace` (round proof, 1 day) or T + `grace` (Data Streams, 30 min), after which anyone can `invalidate` |

## Solvency invariants (tested)

These are in `test/invariant/MarketInvariants.t.sol` (256 runs × depth 100; path coverage in `docs/evidence/phase-1/invariant-path-coverage.md`):

- Before resolution: collateral held == UP supply == DOWN supply.
- After resolution: collateral held ≥ outstanding claims (UP supply, DOWN supply, or (UP+DOWN)/2).
- Market balance == ghost deposits − ghost withdrawals (no untracked movement).
- No actor withdraws more than they deposited plus the outcome tokens they received. Total withdrawn ≤ total deposited.

Rounding: the INVALID payout floors (u+d)/2 per redeemer, so at most 1 base unit of dust per redeemer stays in the market (`test_redeem_invalidPaysHalf`). That is never an overpayment.

## Known limitations / residual risks

1. **Void incentive (ADR-002 §4).** Once the price path is known, holders of the losing side gain from INVALID (0.5). They can only cause it by preventing *every* submitter from proving within the delay or grace, which is not a contract bug. Monitoring comes in Phase 9.
2. **Round-proof mode at an aggregator phase change.** If the first qualifying round opens a new phase, it cannot be proven (`FirstRoundOfPhase`), so the boundary goes UNRESOLVABLE after `livenessGrace`. This is documented and rare.
3. **Push-feed staleness.** ETH/BTC push feeds have multi-minute gaps (Phase 0 evidence). Round-proof mode is intended for MON only (ADR-002); BTC/ETH use Data Streams.
4. **Data Streams on Monad unconfirmed.** The VerifierProxy has no fee manager or access controller (ADR-002 pending answer). The `verify` call path is implemented from the documented interface but has **never run against the real verifier**. Phase 2 must test it with a real report.
5. **Report expiry.** `expiresAt` is not checked by the resolver. Whether the real VerifierProxy rejects expired reports is unverified. Submission happens within minutes, so impact is low; revisit in Phase 2.
6. Contracts are immutable (no proxies) per CLAUDE.md. Fixes ship by redeploying a new factory.
