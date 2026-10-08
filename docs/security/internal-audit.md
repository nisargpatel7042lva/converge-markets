# Internal audit: Converge Markets, Phase 9

**Status: internally reviewed, not externally audited.** Nobody outside this project has read this
code. The launch is therefore capped at **5,000 USDC** of vault deposits, and the cap is not to be raised
until the external review below has happened and its findings are closed.

## 1. Scope, method, and what "internal" means here

In scope: everything under `contracts/src` (the vault, venue, markets, factory, resolvers, scheduler receiver and lens,
partner registry, fee sinks, owner timelock) and the deployment tooling in `scripts/mainnet` that sets their parameters.
Out of scope: the TypeScript services (keeper, scheduler, indexer, app) except where they act as a security control
(the keeper's halt logic, the app's region block). Their tests are listed in the phase report.

Method, in the order it was done:

1. **Authors' tests** (Phases 1 to 8): unit, fuzz, invariant, fork. Counted in section 3.
2. **Static analysis**: `forge lint --deny warnings`, Slither (fails the build on medium or high), Aderyn 0.6.8. Triage in section 5.
3. **Extended invariant campaign**: all three invariant suites at **10,000 runs x depth 100 (1,000,000 calls each)**. Two campaigns passed; a third, run on a byte-different build of the same code, **found a real bug** (F9-18) that the first two did not. So 10,000 runs is a sample, not a proof: the final campaign (after the F9-18 fix) is `docs/evidence/phase-9/invariants-10000.txt`, and the failing one is kept in `check-9-first-run.txt`.
4. **Mainnet-fork tests** against the real USDC, the real VerifierProxy, the real Chainlink feeds and the real Safe contracts. `docs/evidence/phase-9/fork-tests.txt`.
5. **Two manual reviews by fresh reviewers** (separate agents that had not written the code): the first against the checklist in section 4, reading every contract and the deploy scripts in full (17 findings, section 6); the second a hostile whole-system pass (contracts, deploy tooling, runbook, alerts, status line) after the fixes (section 6b). Both are the same kind of reviewer as the author, which is why the external review is required before the cap is raised: neither found the F9-18 bug before the invariants did.
6. **A deployment rehearsal** on a local fork of Monad mainnet (`scripts/mainnet`, section 7).

What was **not** done: formal verification, an economic audit by someone who trades, a review of the CRE workflow
on Chainlink's infrastructure, or any test of the Data Streams path against a real signed report (no Chainlink
account yet; see risk A1).

## 2. Verdict

| Class | Count | State |
| --- | --- | --- |
| CRITICAL | 0 | none found |
| HIGH | 3 | F9-01 (instant owner powers): **fixed** with the owner timelock. F9-18 (a keeper split could lock collateral owed to depositors and claimants; found by the extended invariant campaign): **fixed**, bounded by free liquidity. F9-02 (the Data Streams path has never run against a real report): **open, gated**: `check-streams` blocks the launch until it passes. It cannot be closed without Chainlink credentials |
| MEDIUM | 5 | F9-03, F9-04, F9-06 fixed in code; F9-05 accepted (fee manager) with a detector; F9-07 resolved by the mainnet deploy tooling |
| LOW / INFO | 10 | 3 fixed (F9-09, F9-10, F9-11), 2 partly fixed (F9-12, F9-15), 5 accepted (F9-08, F9-13, F9-14, F9-16, F9-17) |
| Second review (hostile, whole system, section 6b) | 4 HIGH, 8 MEDIUM, 10 LOW | the 4 HIGH: one was F9-18 (fixed), H2 heartbeat (fixed), H3 status line (fixed), H4 timelock-watch (hardened, partly accepted). Dispositions in 6b |

Nothing is "accepted" silently: every accepted risk is in section 8 with the reason and the thing that would change the decision.

## 3. Evidence

| Check | Result | Where |
| --- | --- | --- |
| Solidity tests (unit, fuzz, invariants at 256 runs) | 412 passed, 0 failed (2 fork tests skipped without an RPC; the 8 fork tests run in `make check-9`) — `docs/evidence/phase-9/check-9.txt` | `make check-9` |
| Extended invariants, 10,000 runs x depth 100, 3 suites (Market 5 properties, Vault 7, PartnerCap 3) | 15 properties pass, 3 suites x 1,000,000 calls (the earlier campaign on pre-F9-18 code is kept as `invariants-10000-before-F9-18.txt`) |  `docs/evidence/phase-9/` |
| Mainnet-fork tests (8) | pass | `fork-tests.txt` |
| `forge lint --deny warnings`, `forge fmt --check` | clean | `check-9.txt` |
| Slither (run before `OwnerTimelock.sol`, a thin wrapper of OpenZeppelin's audited `TimelockController`, was added; re-run in `check-9`) | 0 high, 0 medium; 48 low (`calls-loop`), 33 low (`timestamp`), 6+4 low (reentrancy benign/events), others informational. All triaged below | `slither-summary.txt`, `slither.txt` |
| Aderyn 0.6.8 | 4 high-class patterns, 16 low-class; every high triaged below | `aderyn-report.md` |
| Fee-on-transfer, hook and native-reward reentrancy tests; review-fix regression tests | 11 + 10 | `ReentrancyHooks.t.sol`, `ReviewFixes.t.sol`, `OwnerTimelock.t.sol` |
| Deployment rehearsal on a mainnet fork (deploy, verify, handover, timelock delay, resume, crash-resume, idempotent re-run) | pass | `scripts/mainnet/test/fork`, `mainnet-rehearsal.json` |

## 4. The review checklist

Each row: what was examined, the verdict, where it is enforced, and the tests that pin it. "Verified by reading" means the reviewer traced the code and a test exists for the claim; where only one of the two exists it says so.

### 4.1 Access control

**Verdict: OK, with F9-01 (fixed by the timelock) and F9-12 (fixed).**

| Role | Can | Cannot | Enforced by |
| --- | --- | --- | --- |
| Owner (the OwnerTimelock, driven by the Safe) | Parameters inside hard limits, keeper and guardian rotation, TVL cap, fee, treasury, venue replacement (separate 2-day timelock), resume quoting | Take funds (no function exists), skip the delay | `Ownable2Step`, `renounceOwnership` reverts on the vault, registry and both resolvers; `OwnerTimelock` has no admin |
| Guardian | `pauseQuoting`, factory `pause`, registry `pause`, `merge` | Resume, change anything | `onlyGuardianOrOwner`, role checks |
| Keeper | `setSigma` (owner's band, 20 % per step, 30 s apart), `splitForInventory`, `mergeInventory`, `haltQuoting`, `unhaltQuoting` | Move funds, approve, pause or resume, change a parameter | `onlyKeeper`; `invariant_keeperAndGuardianHoldNothing`, `invariant_noStandingApprovals` |
| Creator | `MarketFactory.createMarket` on the grid | Choose an outcome | `CREATOR_ROLE`; resolvers verify oracle evidence |
| Scheduler receiver | Forward oracle-verified evidence, create markets | Anything outside its `onReport` | forwarder address and workflow id checks |
| Anyone | `settleEpoch`, `checkpoint`, `redeemResolved`, `pruneEmpty`, `executeOrder`, `expireOrder`, `open`, `resolve`, `invalidate`, claims | Anything that moves value to themselves beyond their own claim | permissionless by design, each re-checks its inputs |

Clones: every initializer runs in the same transaction as the clone (`MarketFactory`, `PartnerRegistry`); the
implementations lock themselves (market and token factory = `0xdead`, `FeeSink.registry` = `0xdead`, threshold resolver
start = max). Tests: `unit/VaultInventory`, `unit/MarketFactory`, `unit/PartnerRegistry`, `unit/ReviewFixes`.

### 4.2 Oracle handling (staleness, phase changes, rounds, reports)

**Verdict: OK in code; the assumptions about the real Data Streams reports are open (F9-02), and a decimals mismatch is a
deploy-time risk (F9-13).**

- Data Streams: version 3 checked before and after verification, feed id after verification, price > 0, `expiresAt >= now` (`ReportLib.verify`); the pricing time must be inside `[validFrom, observations]`; marks older than 10 s are not fresh; resolver: first proposal wins, a lower hash may replace it inside the finalization window, UNRESOLVABLE after the grace period.
- Chainlink rounds (MON, and any round-resolved asset): phase changes and first-round proofs, `maxOracleDelay`, non-positive answers, `latestRoundData` guarded by a liveness grace of 1 day.
- A report is routed to its asset by feed id; one feed can serve only one asset (F9-11, fixed).
- Tests: `unit/DataStreamsResolver`, `unit/ChainlinkRoundResolver`, `unit/ForwardVenue::test_exec_*`, `fork/VaultFork::test_fork_realVerifierRejectsForgedReports`, `fork/MainnetSystem::test_fork_roundProofsOnRealFeeds`, `::test_fork_realChainlinkFeedsAreWhatTheDocsSay`.
- Not verified: windows are contiguous; `validFrom`/`observations` semantics; 18 decimals; `verify` callable from the vault, the venue and the resolver. The VerifierProxy has **no access controller and no fee manager today** (`cast call`, 2026-10-08), which resolves two of the four assumptions as of today; `scripts/mainnet verify` fails if either changes. The rest is what `scripts/mainnet check-streams` tests against a real report.

### 4.3 Rounding directions

**Verdict: OK.** Floor in the vault's favour everywhere a payout is computed (share mint, redeem payout, partial-fill burn, claim split, fee share); upper valuations round up, lower valuations round down; asks round up to the tick and bids down; a buyer's premium is the ceiling and a seller's the floor; `MIN_FILL = 1000` blocks dust fills. Tests: `unit/VaultFuzz::testFuzz_roundTripCannotProfit`, `::testFuzz_flatNavRoundTripLosesOnlyRounding`, `::testFuzz_claimsNeverExceedSettlement`, `unit/VaultE2E` (hand-derived numbers), `QuoteMath.t.sol` (600 golden vectors, rooms exact against the loss function).

### 4.4 Reentrancy, including token hooks

**Verdict: OK.** Every value-moving entry point is `nonReentrant`; effects before interactions (the venue marks an order DONE before any external call, the vault accounts before transferring); the native reward is the last call of `executeOrder` and `expireOrder`. USDC (Circle FiatToken) and the outcome tokens have no transfer hooks. `ReentrancyHooks.t.sol` runs the whole system on an ERC-777-style token and a reward receiver that re-enter every function (11 tests), plus cross-contract solvency tests. Assumption: the collateral stays hook-free.

### 4.5 Denial of service through unbounded loops

**Verdict: OK.** Loops are bounded by constants: 16 markets and 8 assets in the vault, 4 ladder levels, 64 partners and 8 live markets per partner in the registry, a gas-reserve guard in the scheduler receiver. Worst cases are measured and tested (`settleEpoch` 726k gas, `executeOrder` 1.14M with 16 markets holding excess). The venue never iterates orders. Griefing that remains: F9-08 (a 1-wei redeem request each epoch) accepted; F9-14 (slot pinned by about 0.001 USDC of dust for up to 7 days) accepted.

### 4.6 Griefing on `settleEpoch` and `resolve`

**Verdict: OK after fixes.**

- `settleEpoch`: late settlement only expires the epoch (refund, requeue); nobody can make it settle wrongly. A dust donation to a registered market used to make a settlement need a mark or a resolution: **fixed (F9-06)**, an excess of at most `DUST_TOKENS` (1,000 raw units, under a thousandth of a dollar) is ignored in the plan and the valuation. Test `ReviewFixes::test_dustExcessNeedsNoMarkToSettle`.
- `resolve`: permissionless and idempotent; the first-proposal-wins rule and the finalization window prevent a late spoof from replacing a better proposal. An unresolvable boundary becomes INVALID after the grace period and pays half.
- A partner market ending inside the settlement window let a requester choose between the mark and the outcome: **fixed (F9-03)**: `redeemResolved` is deferred while a settlement is pending, so both are valued from the same mark. Test `ReviewFixes::test_redeemResolved_isDeferredWhileAnEpochSettlementIsPending`; the keeper waits instead of sending the transaction (`planner.test.ts`).

### 4.7 Front-running of epoch settlement

**Verdict: OK for core rounds.** Marks are pinned to the epoch-end report; fills are frozen between the epoch end and its settlement; a request at the last second buys at the upper NAV and redeems at the lower NAV (the two-sided NAV: a 5-point band on the exposed tokens, which are at most about 16 % of NAV at the launch limits, is the price, accepted R4). The partner-market hole is F9-03, fixed.

### 4.8 Keeper compromise

**Verdict: OK on funds; rotation fixed (F9-04).** A stolen key can set sigma inside the owner's band, split and merge within the caps, and halt. It cannot move funds. With a colluding taker the loss per burst is bounded by the ceilings (1 % of NAV per market, 8 % in total), then the 5 % daily breaker pauses. At the 5,000 USDC cap that is about 50 USDC per market, 400 in total. A keeper split is now bounded by the vault's *free* liquidity (balance minus pending deposits minus unclaimed payouts): before F9-18 it was bounded only by NAV fractions, so a keeper could lock collateral owed to claimants. Rotation (`setKeeper`) now discards the old key's sigma and halts quoting until the new key acts. Test `ReviewFixes::test_setKeeper_discardsOldSigmaAndHaltsUntilTheNewKeyActs`. Because the owner is timelocked, the pause (guardian, instant) is the first response; see the runbook.

### 4.9 The Kuru adapter's approvals

**Verdict: not applicable, and the approval surface is small.** There is no Kuru adapter in this repository (`grep -ri kuru contracts/src` finds nothing; Kuru market creation is owner-gated, ADR-001, and the product uses the vault's own forward-priced venue). The approvals that do exist:

| From | To | Amount | Residual |
| --- | --- | --- | --- |
| Vault | a market clone | exactly the split amount, then reset to 0 | 0 |
| Venue | the vault | exactly the ladder level's amount | 0 by construction |
| Users | vault / venue / market / registry | their choice | `from` is always `msg.sender`, so an infinite approval cannot be used by a third party |
| `DataStreamsResolver.approveFeeToken` | an arbitrary spender | owner-only, nothing held, unused today | n/a |

The test-only open-mint token in `contracts/script/spike` must never be deployed; the mainnet tool deploys only the contracts it lists.

### 4.10 Pause semantics: exits are always open

**Verdict: confirmed.** `requestRedeem`, `settleEpoch` and `claimRedeem` have no pause check; `Market.merge`, `redeem`, `resolve`, `invalidate` have none; the factory and registry pause block only `split`; `expireOrder` has no pause or halt check, so escrow always comes back. Void, suspend and inactive status gate only allocation, quoting and fills. Caveat, stated plainly: **a payout needs a settled epoch**, and settlement needs a canonical Data Streams report and every ended round resolved. If the oracle or the keeper is down, requests roll over (they stay safe) until the oracle is back or the round turns INVALID after 30 minutes (F9-06 narrows the cases). Tests: `unit/VaultFlows::test_redeem_neverBlockedByPauseOrBreaker`, `unit/VaultInventory::test_merge_worksWhilePaused`, `invariant_noViolation` (a reverting claim with the vault paused is a violation), `invariant_sumOfClaimableAssetsBackedByBalance`, `ReviewFixes::test_split_cannotUseCollateralOwedToPendingDepositsOrClaims`.

### 4.11 Constructor and initializer parameters used by the deploy scripts

**Verdict: OK for the mainnet tool; the old Foundry scripts are testnet-only and refuse mainnet** (F9-07). The mainnet parameters are in `scripts/mainnet/src/constants.ts` and `config/strategy.default.json`, and `scripts/mainnet verify` re-reads each from the chain.

| Parameter | Value | Why |
| --- | --- | --- |
| Collateral | USDC `0x7547…B603` (6 dp) | the real one; the factory refuses anything else in `verify` |
| Verifier | `0xEd81…48c8` | fee manager and access controller must be zero |
| Epoch length / min request / TVL cap | 900 s / 10 USDC / 5,000 USDC | 15-minute rounds align with the epoch; the cap is the beta limit |
| Quote parameters | `config/strategy.default.json` (half-spread 0.05 to 0.2, 2 levels, price bounds 0.02/0.98, 1 % per market, 8 % total) | from the backtest; symmetric bounds are now enforced (F9-09) |
| Sigma bands | BTC 0.3 to 1.0, ETH 0.4 to 1.3 | the keeper's estimate is clamped to the band (a test pins this) |
| Venue | execution delay 2 s, lateness 4 s, min reward 0.001 MON | the delay has zero margin against an information lead that is unmeasured (R2); the reward is below the worst-case gas of a fill (F9-15, accepted: the keeper subsidises about 0.003 USD per order at MON 0.025 USD) |
| Resolver | finalization window 120 s, grace 30 min | long enough for an honest re-submission, short enough to settle inside the 10-minute window |
| Owner / admin | `OwnerTimelock` (24 h), the Safe proposes and executes | F9-01 |
| Guardian / keeper / scheduler | three separate keys, none the deployer | refused by the deployer if equal |

## 5. Static analysis triage

**Slither** (fails on medium or high; none): the low and informational classes are `calls-loop` (every loop is bounded by a constant, 4.5), `timestamp` (the protocol is time-based by design: epochs, rounds, windows), `reentrancy-benign` and `reentrancy-events` (event emission after an external call to a trusted, `nonReentrant`-guarded contract; annotated inline), `cyclomatic-complexity` (the vault's settlement and valuation), `assembly` (reading the feed id from a payload; `Clones`), `low-level-calls` (the native reward transfer, checked), `naming-convention`, `unindexed-event-address`, `cache-array-length` (gas only).

**Aderyn 0.6.8:**

| Id | Finding | Disposition |
| --- | --- | --- |
| H-1 | Contract locks Ether without a withdraw function (`Market`, `ChainlinkRoundResolver`, `ThresholdResolver`) | False positive. `payable` is part of `IPriceResolver.submit`; `Market` forwards `msg.value` to the resolver and reverts with `UnexpectedValue` otherwise; the round and threshold resolvers reject any value. No path keeps ether. |
| H-2 | ETH transferred without address checks (`ForwardVenue.executeOrder`, `expireOrder`) | By design: the executor reward goes to `msg.sender`, the caller who did the work. It is the last call, after all state changes, and a rejecting caller only reverts its own transaction (`test_reward_rejectingExecutorReverts`). |
| H-3 | Reentrancy: state change after external call | Reviewed instance by instance: every function is `nonReentrant` and the external calls are to our own clones, USDC, or the verifier; see 4.4 and the `ReentrancyHooks` tests. |
| H-4 | Weak randomness (`block.timestamp % epochLength`, `% 1 days`) | The modulo is epoch and day alignment, not randomness. Nothing is chosen at random. |
| L-1..L-16 | Centralization, costly operations in loops, literals, PUSH0, state change without event, unspecific pragma, unused error (`QuoteMath.BadParams`), … | Style and gas. The centralisation finding is the real one and is F9-01. PUSH0 is supported on Monad. `BadParams` is an unused error left in a library; harmless. |

## 6. Findings register (manual review, 17 findings)

Severity is the reviewer's, adjusted where this project's context changes it. "Fixed" means the code changed and a test pins it.

| Id | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| **F9-01** | HIGH | A single instant-acting owner could widen the sigma band, replace the keeper, loosen the risk parameters and run the mis-pricing attack (R3), without the 2-day venue timelock | **Fixed by design.** Every owner action goes through `OwnerTimelock` (24 h default, 1 h minimum on mainnet), the Safe is the only proposer/executor/canceller and there is no admin. The guardian keeps instant pause. `timelock-watch` announces every scheduled action to Discord and Telegram. Rehearsed on a mainnet fork: the Safe cannot call the owner functions directly, a scheduled call cannot run one minute early, runs after the delay, the guardian pauses instantly, and `timelock-watch` reports each operation (`rehearsal.test.ts`). The protection is only as good as the people reading the announcements (H4). Residual: a fully compromised Safe still bounds its loss by the 5,000 USDC cap and the 24 h exit window. |
| **F9-02** | HIGH | The Data Streams path has never run against a real signed report: windows contiguous, semantics of `validFrom`/`observations`, 18 decimals, `verify` callable from three contracts | **Open, gated.** The VerifierProxy has no access controller and no fee manager today (checked, and checked again by `verify`). `scripts/mainnet check-streams` tests the rest on live reports (windows, containment, scale, `eth_call` of the real proxy as vault, venue and resolver); it needs Chainlink API credentials and blocks the launch (checklist C). If reports turn out to be point-windows with gaps, the design does not work as built (orders could not execute, epochs would expire, boundaries would go INVALID): that outcome is a redesign, not a patch. |
| F9-03 | MEDIUM | A partner market ending inside the settlement window lets a requester pick the better of mark and outcome via `redeemResolved` before `settleEpoch` | **Fixed.** `redeemResolved` reverts `SettlementPending` while a settlement is pending; the keeper waits. The partner programme is also off for the launch. |
| F9-04 | MEDIUM | `setKeeper` left the old keeper's sigma live for 15 minutes and constrained the new key to ±20 % steps | **Fixed.** `setKeeper` zeroes every asset's sigma and halts quoting; the new key sets fresh values and unhalts (the keeper does it itself). |
| F9-05 | MEDIUM | If Chainlink enables the verifier's fee manager, the vault and venue (which forward no value) can no longer verify | **Accepted.** Fixing it means making three entry points payable and funding a fee token: a larger change to code that is otherwise settled. Detector: `scripts/mainnet verify` fails when the fee manager is non-zero, and the runbook has the response (pause, redeploy; funds stay safe, LPs exit on pairs-only epochs). The decision to revisit: when Chainlink announces fees for Monad. |
| F9-06 | MEDIUM | A one-unit donation to a registered market created an "excess" that made settlement depend on a mark and a resolution; payout liveness depends on credentialed reports | **Fixed for the donation** (dust threshold in plan and valuation). **Accepted for the rest**: payout liveness depends on the keeper's Data Streams credentials and on resolution; documented in 4.10 and the runbook. |
| F9-07 | MEDIUM | No mainnet deploy script; the Foundry scripts carry testnet parameters (mock USDC, mock verifier, deployer owns everything) | **Resolved.** `scripts/mainnet` (idempotent, rehearsed on a fork); the Foundry scripts still refuse mainnet. |
| F9-08 | LOW | A 1-wei redeem request each epoch freezes fills until someone settles | **Accepted.** Costs the requester an epoch of waiting and the keeper about 0.07 MON per settlement; not worth an on-chain minimum that could trap a dust holder (exits must always work). |
| F9-09 | LOW | Asymmetric `priceMin`/`priceMax` made DOWN orders revert instead of skipping | **Fixed.** `priceMin + priceMax == 1` is enforced. |
| F9-10 | LOW | `setSigmaConfig` truncating casts and no upper bounds | **Fixed.** `maxAge` ≤ 1 h, `navMaxAge` in [60 s, 2 h]. |
| F9-11 | LOW | Two assets could share one feed id; the second would be unsettleable | **Fixed.** `assetOfFeed` mapping; `enableAsset` reverts `FeedAlreadyUsed`. |
| F9-12 | LOW | Admin hygiene: resolvers could renounce ownership; factory and receiver admin transfer is one-step | **Partly fixed.** Both resolvers revert `renounceOwnership`. The admin of the factory and the receiver is the timelock (a typo cannot hand it to a wrong address without a 24 h delay and a visible operation); `AccessControlDefaultAdminRules` was not adopted. |
| F9-13 | LOW | Irreversible oracle configuration; price decimals unchecked | **Accepted with a gate.** Feed ids are checked at deploy (no placeholder, v3 prefix) and `check-streams` compares the live price to an exchange price, which catches an 8-decimal stream. |
| F9-14 | LOW | About 0.001 USDC of dust pins a registered market's slot until it ends | **Accepted.** Only delays replacement; partner programme off. |
| F9-15 | LOW | Venue escrow not checked for fee-on-transfer; `minReward` far below worst-case gas | **Fixed** the first (`FeeOnTransfer`, tested with a token that starts charging a fee). **Accepted** the second: about 0.003 USD per order at the current MON price, paid by the keeper; revisit if the MON price falls or the order count rises. |
| F9-16 | LOW/INFO | The executor has a 4 s option; nothing enforces `stalenessSec >= maxLateness`; the 2 s delay has zero margin and the information lead is unmeasured | **Accepted (R2, R12).** The launch value `stalenessSec = 4` equals the lateness and `verify` compares the on-chain parameters to the config. Revisit when the lead is measured with real Data Streams. |
| F9-17 | INFO | TVL cap is soft (stale NAV, donations); `lastMark` can be poisoned by a malicious venue (accepted F-09); a reverting Chainlink feed blocks round resolution until the 1-day liveness grace; the `MarketCreated` event shape is the same in the factory and the registry (the indexer filters by emitter) | **Accepted.** |
| **F9-18** | HIGH | `splitForInventory` was bounded by NAV fractions only, not by free liquidity: a keeper could lock USDC reserved for pending deposits and unclaimed payouts into market pairs, leaving `claimRedeem`/`claimDeposit` unable to pay until a merge. Found by the 10,000-run `invariant_sumOfClaimableAssetsBackedByBalance` (deficit 2,277 raw units), missed by the manual review and by two earlier campaigns | **Fixed.** `amount <= _freeLiquidity()` or `InsufficientLiquidity`; the invariant handler now also asserts a refusal only happens when the liquidity really is owed. Regression test `ReviewFixes::test_split_cannotUseCollateralOwedToPendingDepositsOrClaims`; the keeper planner already respected the bound, so only a buggy or hostile keeper could hit it. |

## 6b. Second review: hostile, whole system (after the fixes)

| Id | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| H1 | HIGH | The same as F9-18 (and the failing campaign) | **Fixed** (F9-18) |
| H2 | HIGH | The Watchdog dead-man alert went to a null receiver, so a dead monitoring host paged nobody | **Fixed.** Routed to an external heartbeat webhook (`heartbeat_url` secret); proven against a real Alertmanager (`alerts.test.ts`). Needs an external heartbeat service (checklist E) |
| H3 | HIGH | The public status line could say "ok" with an unsettled epoch, a stale valuation or volatility, a stuck older round, or no series configured | **Fixed.** The previous epoch, `navUpdatedAt`, per-asset `sigmaUpdatedAt`, rounds stuck unresolved in the last 4 slots and the empty-series case are now checked and unit-tested; "now" follows the chain clock if it is ahead |
| H4 | HIGH | `timelock-watch` was unsupervised, could be wedged by an oversized message, and LPs are not told | **Hardened:** messages are cut to what Discord and Telegram accept (the operation id survives), delivery is retried and never stops the watch. **Accepted:** running it under a supervisor (systemd or Docker `restart: always`) is a checklist item, and there is no in-app "pending owner action" line yet; the signers and the on-call are told, LPs are told by Nisarg (runbook 3.8) |
| M1 | MED | Runbook: factory pause also blocks `createMarket` and needs the 24 h unpause; "pausing is cheap" was wrong; double 24 h for rotate + resume | **Fixed** in the runbook (real cost stated; operations are chained with a predecessor) |
| M2 | MED | One fixed launch salt: a second resume would collide | **Fixed.** `LAUNCH_LABEL` selects a fresh salt per resume |
| M3 | MED | `verify` skipped deployer checks when the deployer address was unknown; no upper bound on the timelock delay; `OwnerTimelock` missing from the explorer list | **Fixed:** the deployer comes from the state file as a fallback; the delay is limited to 1 h (mainnet) to 7 days; `OwnerTimelock` is in the explorer commands. **Accepted:** no on-chain bytecode comparison against the artifacts (the explorer verification is the check) |
| M4 | MED | The audited tree is not what git holds | **Fixed by process:** everything is committed and tagged before the launch; the checklist builds from the tag. See the report |
| M5 | MED | `check-streams` samples only 45 s and runs after the irreversible feed ids are written; same id for two assets only caught late | **Partly fixed:** duplicate ids are rejected before deploying (`validateConfig`). **Accepted:** the live check cannot run before deployment without credentials; the checklist requires the ids to be tested with the API **before** `deploy` (section C order), and `SAMPLE_SECONDS` can be raised |
| M6 | MED | The canary could pass a dead vault | **Fixed in part:** it now requires at least 5 orders that actually filled. **Accepted:** halted time, `EpochExpired` and a PnL floor are reported (PnL) or watched by alerts, not pass/fail |
| M7 | MED | Manual fallbacks need credentials only the keeper holds | **Documented** (runbook 3.16): a second credential holder is a launch prerequisite |
| M8 | MED | Alert gaps (guardian and scheduler balance, TVL near cap, `NavBelowSeed` naming, status pages while paused) | **Partly fixed** (rename, silence note, KeeperHalted wording). **Accepted:** no independent chain exporter for balances yet; the daily `verify` and the canary report are the stand-in |
| LOW | | Deployer re-run after launch fails loudly; Safe batch import not exercised in the Safe web app; `ChainlinkRoundResolver` lint-suppression end marker; treasury not role-checked; keeper env secrets in `docker inspect`; `setKeeper` to a typo | **Accepted / noted.** The lint marker and the typo case are cosmetic or operator discipline; the Safe web-app import is a checklist item (dry-run the three batch files on a throwaway Safe before the real one) |

## 7. The deployment as a security control

`scripts/mainnet` refuses, before sending anything: placeholder or malformed Data Streams ids; a Safe with no code, fewer than 2 owners, threshold below 2, or in which the deployer is a signer; two roles on one address; a role equal to the deployer; a TVL cap of zero or above 100,000 USDC; a timelock delay shorter than 1 hour on mainnet. After deploying, `verify` reads the chain and fails on: wrong owner or admin, a role still held by the deployer, parameters different from the config, a different feed id, a VerifierProxy with a fee manager or an access controller, a missing or short timelock delay, an admin on the timelock. The rehearsal on a fork proves the sequence including the crash-resume and an idempotent re-run **before the handover**; a re-run after the handover or the launch is not a supported way to converge (it would try owner actions as the deployer and fail loudly).

## 8. Accepted risks, stated plainly

| Id | Risk | Why accepted | What would change it |
| --- | --- | --- | --- |
| A1 | The Data Streams assumptions (F9-02) are not yet tested on real reports | The check exists and blocks the launch | A failed `check-streams` |
| A2 | The 2 s execution delay may be shorter than a trader's information lead (R2); the backtest verdict is that the strategy is unprofitable as specified and profitable only under pessimistic assumptions | The loss is bounded by the ceilings and the cap; the canary measures it | The measured lead, or a negative canary PnL beyond the loss ceilings |
| A3 | USDC issuer risk: Circle can pause or blacklist the vault (R5) | Nothing in this system can prevent it | The cap is the mitigation |
| A4 | Single hot key per role; the keeper key sits on a server | Bounded to 1 %/8 % and the breaker; the key cannot move funds | A larger cap |
| A5 | The Safe is the whole of governance; its signers are people | Timelock gives LPs 24 h; threshold ≥ 2 on separate hardware | A larger cap |
| A6 | F9-05 verifier fees; F9-06 payout liveness depends on credentialed reports; F9-08/14 dust griefing | See the register | Chainlink fee announcement; a second reporter |
| A7 | MON rounds exist but have no liquidity (no stream, no second price source) | The app lists BTC and ETH only | A MON Data Streams stream |

## 9. TVL cap rationale (5,000 USDC)

The cap is sized against what can go wrong with no external review, not against demand:

- The worst case that needs only a stolen keeper is about 8 % of NAV before the breaker, 400 USDC at the cap.
- The worst case for a hostile owner, even with the timelock, is the whole cap; 5,000 USDC is an amount the project can lose and explain.
- It is large enough to quote ladders at the launch limits (1 % of NAV per market is 50 USDC; with minimum level size and a 12 % liquidity fraction the ladders are thin but real) and to give a canary meaningful numbers, and small enough that a single bug does not harm many people.
- The cap is enforced on chain (`setTvlCap`, checked at request time including pending deposits, soft by design: F9-17) and is the first thing a reviewer should challenge.

It is raised only by a timelocked `setTvlCap`, after (a) the external review, (b) its findings closed, (c) a canary on the final code with real Data Streams reports, and (d) a second reviewer on the change.

## 10. Planned external review

Not done yet. The plan, for Nisarg to confirm or replace:

1. **First choice: an automated + expert scan from the hackathon prize pool** (for example an ack3 scan, or the equivalent offered by the sponsor), scoped to `contracts/src` at the tagged mainnet commit. Cost and timing are theirs.
2. **Before raising the cap above 5,000 USDC: a manual audit** by a named firm or an independent reviewer with prior work on ERC-7540-style vaults and Chainlink Data Streams, with the economic model (`docs/adr/ADR-004`, `ADR-005`, `backtest/report/REPORT.md`) in scope. 
3. Findings are tracked in this file's register with the same ids scheme (`X-nn`), fixed or accepted with a reason, and the cap decision is made after.

Until (1) has happened, the product copy must say what the beta is: capped, unaudited, can lose money.

## 11. Reproduce

```bash
make check-9                                                          # everything below
cd contracts && forge test                                            # unit, fuzz, 256-run invariants
cd contracts && FOUNDRY_INVARIANT_RUNS=10000 FOUNDRY_INVARIANT_DEPTH=100 forge test --match-path "test/invariant/*"
cd contracts && forge test --match-path "test/fork/*" --rpc-url https://rpc.monad.xyz
cd contracts && forge lint --deny warnings && slither . --config-file slither.config.json
pnpm --filter @converge/mainnet test && pnpm --filter @converge/mainnet test:fork && pnpm --filter @converge/mainnet test:alerts
```
