# Threat model: the Converge Vault (Phase 4)

Scope: `ConvergeVault`, `ForwardVenue`, `QuoteMath`, `ReportLib` (contracts/src/vault/), on top of the Phase 1 markets. Design in `docs/adr/ADR-005-converge-vault.md` and `docs/adr/ADR-004-forward-priced-execution.md`. Every mitigation below names the tests that exercise it; test names are exact (`forge test --match-test <name>`). Unit tests are in `contracts/test/unit/` (`VaultFlows`, `VaultInventory`, `ForwardVenue`, `VaultFuzz`, `VaultE2E`), the stateful malicious-keeper suite is `contracts/test/invariant/VaultInvariants.t.sol` (256 runs, depth 100, `fail_on_revert = true`; path coverage in `docs/evidence/phase-4/invariant-path-coverage.md`), pricing parity is `contracts/test/QuoteMath.t.sol`, the mainnet fork is `contracts/test/fork/VaultFork.t.sol`.

## 1. Assets

| Asset | Where | Why it matters |
|---|---|---|
| LP collateral (USDC) | vault balance, split pairs inside `Market` contracts | the product |
| Share price and the LP claim | `totalSupply`, epoch accounting | fairness between entering and leaving LPs |
| Takers' escrow | `ForwardVenue` | users' funds in flight |
| Owner powers | `Ownable2Step` owner (Safe on mainnet) | parameters, venue, keeper |
| Price integrity | Data Streams reports | every mark and every fill price |

## 2. Actors and trust

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Owner (Safe) | parameters inside hard limits, venue replacement (2 day timelock), keeper/guardian/treasury, asset whitelist and sigma bands | cannot move funds: there is no withdrawal or transfer function |
| Guardian | pausing quoting | cannot resume, cannot touch funds or exits |
| Keeper | nothing beyond five bounded calls (`setSigma`, `splitForInventory`, `mergeInventory`, and, from ADR-006, `haltQuoting` / `unhaltQuoting`) | treated as fully malicious |
| Venue contract | pricing logic and escrow handling | the vault re-checks every fill; replacement is timelocked |
| Chainlink Data Streams DON | the price in a verified report | `ReportLib` only accepts reports that the real VerifierProxy verifies for the configured feed |
| USDC (Circle) | transfers | freeze/blacklist of the vault is out of our control |
| LPs, takers, executors, settlers | nothing | any of them may be an attacker (permissionless functions) |

## 3. Security properties we claim

- **P1** The keeper can not move value out of the vault.
- **P2** The worst-case loss of the positions the vault holds is capped per market and in total (1% and 8% at launch) through the venue, even if the venue or the keeper's sigma is hostile. The cap does not bound the rate across rounds: each market has its own ceiling, so a hostile venue or a colluding keeper and taker can take about 1% per market per round (up to 8% in a burst) until the breaker pauses quoting (R3). Realised loss stays on record per market.
- **P3** Nobody gains by timing deposits or redemptions (no NAV sniping): the epoch is priced at the epoch-end report, and fills are frozen between the epoch end and its settlement.
- **P4** Exits are never blocked: pause, breaker and a dead feed can not stop requests, claims, merges (the owner, the guardian and, while paused, anyone can merge) or redemption of resolved rounds. A dead keeper can not hold liquidity in pairs.
- **P5** The sum of what is owed to LPs is always held by the vault.
- **P6** Rounding always favours the vault.
- **P7** An executor of a venue order can not choose the price (stop-ship requirement of ADR-004).

## 4. Attack trees

### A. Keeper compromise (P1, P2)

```
steal or destroy LP value through the keeper key
├─ A1 call a function that sends funds out ...................... no such function (K1)
├─ A2 move tokens/collateral with ERC-20 calls ................... vault grants no allowance (K6)
├─ A3 split into / merge from a market that is not ours .......... factory registry check (K3)
├─ A4 split everything into pairs to lock liquidity ............. pair and inventory caps (K4); owner, guardian and (when paused) anyone can merge (K5, N13)
├─ A5 fill the registry with markets to make NAV loops expensive . registry <= 16 (G1)
├─ A6 set sigma to mis-price quotes and trade against it (colluding taker)
│    ├─ A6a leave the owner band ................................... band check (K2)
│    ├─ A6b jump sigma in one step or flap it ...................... step and rate limits (K2)
│    └─ A6c mis-price inside the band ................................ loss ceilings + breaker (K10); residual risk R3
├─ A7 move the NAV through sigma ............................................ NAV uses the whole band, not the keeper value (K8)
├─ A8 pause, unpause, change parameters, change venue ........ owner/guardian only (K7, O1-O4)
├─ A9 stop quoting by letting sigma go stale ...................... liveness only; recovers on the next setSigma; exits unaffected
└─ A10 halt quoting and never resume (denial of quotes), or clear a guardian/owner/breaker pause with `unhaltQuoting`
     ├─ the halt is a separate flag (`keeperHalt`): `unhaltQuoting` never touches `quotingPaused` (tests `test_halt_isIndependentOfThePause`, invariant handler `h_halt`)
     ├─ only the keeper can call either function (`test_halt_onlyTheKeeperMayHaltOrUnhalt`, invariant handler `h_haltAttack`)
     ├─ a halt blocks fills only: splits, merges, settlement, claims and every exit work (ADR-006)
     └─ the owner rotates the keeper (`setKeeper`) to end a hostile halt; residual: quotes are down until then (liveness, not funds)
```

### B. Oracle manipulation (P2, P3, P7)

```
make the vault trade or settle at a wrong price
├─ B1 forge a report ....................................... real VerifierProxy verification (V4, fork test)
├─ B2 report for the wrong feed or schema ................. feed id and version checks (V4, N5)
├─ B3 replay an old report .................................. window must contain T (V1, N2); fresh-mark age for the breaker (N5)
├─ B4 choose between two valid reports ..................... contiguous windows (Chainlink guarantee): residual R1
├─ B5 submit a stale/expired report ......................... expiry and age checks (V4, N5)
└─ B6 push-feed lag (BTC/ETH Chainlink pushes) ............. not used: the vault only supports Data Streams assets (ADR-005)
```

### C. NAV sniping (P3)

```
get shares cheaply or redeem dearly by choosing when the price is struck
├─ C1 request, then settle later after an outcome is known .... marks are the report AT the epoch end; window shorter than a round (N2); no fills between the end and the settlement (N2b)
├─ C2 settle only when the exposed round is going your way ... same: price fixed at T, no round can end in the window (N2)
├─ C3 settle with an ended-but-unresolved round valued at 0/1 . settlement reverts until it is resolved (N3)
├─ C4 let nobody settle so the stale epoch is priced late ..... expiry: refund/requeue, no late price (N2)
├─ C5 enter and leave around a mark ............................. deposits at the upper NAV, redemptions at the lower: round trip loses the band (N1)
├─ C6 donate tokens/collateral to move the price ............... costs the donor; inflation defense (N6)
└─ C7 act in the last seconds of an epoch with a price lead .... the 5-point band and the sigma spread absorb it: residual R4
```

### D. Griefing via many markets, orders or calls (P4)

```
├─ D1 many markets to blow up gas ............................... registry <= 16, assets <= 8, empty markets pruneable by anyone (G1, G6); worst case measured (G2)
├─ D2 many orders ............................................... orders are never iterated; the placer prepays the executor (V6)
├─ D3 trip the breaker with a report-less checkpoint .......... last verified mark, never zero (G3)
├─ D4 force epochs to expire by settling late ................... costs an epoch of delay, never funds (G4)
├─ D5 dust requests ................................................ minimum request (G5)
└─ D6 strand an order's escrow ................................... expiry always works (V3)
```

### E. Rounding (P6)

```
├─ E1 deposit rounding to zero shares ........................... refunded; dead shares (N6, N11)
├─ E2 claims summing above the settlement ..................... floor rounding everywhere (R1)
├─ E3 price rounding on tiny fills .............................. MIN_FILL, price bounds on amounts (V7)
└─ E4 on-chain math drift from the research code ............. golden-vector parity (R2) and exact room formulas (R3)
```

### F. Owner, venue replacement, external systems

```
├─ F1 owner key theft ............................................. no withdrawal function; parameters inside hard limits; venue behind 2 days (O1-O3)
├─ F2 malicious venue ............................................ vault re-checks every fill (V5)
├─ F3 fee-on-transfer collateral .................................. rejected (X1)
└─ F4 collateral freeze ............................................ out of scope: residual R5
```

## 5. Mitigation to test map

`file::name` below means `contracts/test/<file>` unless noted. "Attack" = `h_attack(seed % 16)` in `invariant/VaultInvariants.t.sol` (the fuzzer-driven keeper; any success is a recorded violation and fails `invariant_noViolation`).

### Keeper (K)

| ID | Mitigation | Code | Tests |
|---|---|---|---|
| K1 | The keeper's only mutators are five bounded functions (three strategy actions and the halt pair, ADR-006); owner/guardian/venue functions reject it | `onlyKeeper`, `onlyOwner`, `onlyVenue` | `unit/VaultInventory::test_ownerSetters_authAndZeroChecks`, `::test_setSigma_revertsForNonKeeperAndUnknownAsset`, `::test_split_revertsForNonKeeper`, `::test_venueFill_onlyVenue`, `invariant::invariant_keeperAndGuardianHoldNothing`, Attack picks 4-10, 14 |
| K2 | `setSigma`: owner band, ±20% step on a fresh value, 30 s rate limit | `setSigma` | `unit/VaultInventory::test_setSigma_bandStepAndRate`, `::test_setSigma_firstValueAndEvent`, Attack picks 0, 1 |
| K3 | Splits only on factory markets of an enabled Data Streams asset (`factory.getMarket(...) == market`) | `_checkMarket` | `unit/VaultInventory::test_split_rejectsForeignAndUnsupportedMarkets`, `::test_enableAsset_rules`, Attack picks 2, 3 |
| K4 | Per-market 30% and total 50% pair caps; registry of at most 16 markets; state and no-quote window | `splitForInventory` | `unit/VaultInventory::test_split_pairAndInventoryCaps`, `::test_split_registryIsBounded`, `::test_split_rejectsResolvedAndNoQuoteWindow`, `::test_split_revertsZeroAndPaused`, Attack pick 15 |
| K5 | Merge only complete pairs of registered markets, value-neutral | `mergeInventory` | `unit/VaultInventory::test_merge_reverts`, `::test_merge_worksWhilePaused`, `unit/VaultFuzz::testFuzz_splitAndMergeAreValueNeutral`, Attack pick 13 |
| K6 | The vault gives no allowance to anyone (it approves a market only for the exact split amount and resets it) | `splitForInventory` | `invariant::invariant_noStandingApprovals`, Attack picks 11, 12, `unit/VaultInventory::test_split_registersAndMovesCollateral` |
| K7 | Guardian can only pause; only the owner resumes; keeper can do neither | `pauseQuoting`, `resumeQuoting` | `unit/VaultInventory::test_pause_guardianAndOwnerOnly`, Attack picks 9, 10 |
| K8 | Sigma can not move the NAV: marks use {keeper sigma, sigmaMin, sigmaMax}; the band covers every sigma | `_upBand` | `unit/VaultFuzz::testFuzz_markBandCoversEverySigmaInTheBand`, `::testFuzz_sigmaCannotMoveHardValueOrNavBeyondTheBand` |
| K9 | A keeper action never changes the hard value (free collateral + complete pairs) | handler checks | `invariant::invariant_noViolation` (ghost checks in `h_setSigma`, `h_split`, `h_merge`) |
| K10 | Mis-pricing inside the band is bounded: per-market and total loss ceilings, exact post-fill check, auto-breaker | `venueFill`, `_ceiling`, `_autoCheckpoint` | `invariant::invariant_lossWithinConfiguredCaps`, `unit/ForwardVenue::test_exec_riskCeilingBindsTheFill`, `::test_vaultBounds_rejectBadFills`, `::test_autoCheckpoint_tripsTheBreakerFromFills`, `unit/VaultInventory::test_breaker_tripsOnDrawdownAndNeverBlocksExits` |

### Venue and execution (V)

| ID | Mitigation | Tests |
|---|---|---|
| V1 | The report must contain the pricing time (`validFrom <= T <= observations`); the price is the report's, not the caller's or the call time's | `unit/ForwardVenue::test_exec_wrongWindowReportsRevert`, `::test_exec_laterCallSamePriceSameFill`, `::test_exec_timingRules`, `::test_exec_priceFollowsTheReport` |
| V2 | One execution per order; no replay; expiry after the lateness window | `::test_exec_cannotReplayOrExpireAfterwards`, `::test_exec_timingRules` |
| V3 | Escrow always comes back: unfilled, paused vault, expiry (even while paused) | `::test_exec_limitBelowAskLeavesOrderUnfilledAndRefunds`, `::test_exec_vaultPausedAfterPlacementRefunds`, `::test_expire_refundsAndPaysCaller`, `::test_expire_worksEvenWhenVaultIsPausedAndTokenOrderRefundsTokens`, `::test_exec_noFillInNoQuoteWindowOrAfterEnd`, `::test_exec_staleSigmaMeansNoQuote` |
| V4 | Forged, wrong-feed, wrong-version, expired, non-positive reports revert | `::test_exec_badReportsRevert`, `fork/VaultFork::test_fork_realVerifierRejectsForgedReports` |
| V5 | A faulty venue is capped by the vault: bounds on price, room, liquidity, freshness, pause; timelocked replacement | `::test_vaultBounds_rejectBadFills`, `::test_vaultBounds_pausedAndStaleNav`, `::test_vaultBounds_buyNeedsFreeLiquidityAndAccountsCash`, `::test_vaultBounds_pullFailuresRevert`, `unit/VaultInventory::test_venue_initialOnceThenTimelocked`, `::test_setInitialVenue_zeroAndFirstUse` |
| V6 | Placing costs the placer the prepaid reward; the venue never iterates orders; a rejecting executor can not wedge it | `::test_place_reverts`, `::test_place_buyEscrowsCollateralAndSellEscrowsTokens`, `::test_reward_rejectingExecutorReverts`, `::test_setMinReward_vaultOwnerOnly` |
| V7 | Dust fills are skipped; price bounds are checked on amounts | `::test_exec_riskCeilingBindsTheFill`, `::test_vaultBounds_rejectBadFills` |
| V8 | Gas measured: 395k (one market, forge), 0.93M (16 pair-only markets), 1.14M (16 markets with excess), 590,921 on testnet (one market) | `::test_gas_executeOrderIsMeasured`, `::test_gas_executeOrderWithSixteenRegisteredMarkets` |

### NAV, epochs, shares (N)

| ID | Mitigation | Tests |
|---|---|---|
| N1 | Two-sided NAV: deposits at the upper NAV, redemptions at the lower, rounding against the vault | `unit/VaultFuzz::testFuzz_roundTripCannotProfit`, `::testFuzz_flatNavRoundTripLosesOnlyRounding`, `unit/VaultInventory::test_nav_excessPricedFromReportWithBand`, `invariant::invariant_noViolation` (share price never falls from flows alone: `h_settle`) |
| N2 | Settlement uses the report at the epoch end, within a window shorter than a round, else the epoch expires; the window and epoch grid are validated | `unit/VaultFlows::test_settle_revertsOnUnknownDuplicateOrNonCanonicalReport`, `::test_settle_laterInTheWindowGivesTheSameShares`, `::test_settle_expiresAfterTheWindow_refundsAndRequeues`, `::test_settle_lastSecondOfTheWindowStillSettles`, `::test_settle_eachEpochHasItsOwnDisjointWindow`, `::test_settleWindow_mustBeShorterThanARound_andEpochsOnTheRoundGrid`, `::test_settle_revertsBeforeEpochEnds`, `::test_settle_revertsTwiceAndWhenEmpty` |
| N2b | **Fills are frozen** while the epoch that just ended has requests and can still be settled (audit F-01) | `unit/VaultAudit::test_audit_F01_fillsAreFrozenWhileAnEndedEpochAwaitsSettlement`, `::test_audit_F01_noFreezeWithoutRequests_orAfterTheWindow` |
| N3 | Ended rounds must be resolved first; resolved rounds are exact net of fee | `unit/VaultFlows::test_settle_endedButUnresolvedRoundBlocksUntilResolved`, `unit/VaultInventory::test_nav_resolvedMarketsAreExactNetOfFee`, `::test_redeemResolved_pairsAndWinningExcess`, `::test_redeemResolved_losingExcessPaysNothingAndInvalidPaysHalf` |
| N4 | A needed mark that is missing reverts | `unit/VaultInventory::test_nav_strictSettlementNeedsTheCanonicalMark`, `::test_nav_marksNeededEmptyWhenNoExcess`, `::test_nav_unopenedMarketIsHalfWithBand` |
| N5 | The breaker re-values from verified marks only; omitted reports and ended-unresolved rounds can not trip it | `unit/VaultInventory::test_breaker_omittedReportCannotTripIt`, `::test_breaker_roundEndedButUnresolvedDoesNotTripIt`, `::test_breaker_withinLimitAndNewDayResets`, `unit/ForwardVenue::test_autoCheckpoint_neverRaisesTheNav`, `::test_autoCheckpoint_ignoresAVenueMarkOlderThanAMinute` |
| N6 | First deposit and dead shares; donation does not zero a depositor | `unit/VaultFlows::test_firstDeposit_mintsOneToOneMinusDeadShares`, `::test_donationBeforeSecondDepositDoesNotZeroShares` |
| N7 | TVL cap at request time including pending deposits | `unit/VaultFlows::test_requestDeposit_enforcesTvlCapIncludingPending` |
| N8 | Performance fee: high-water mark, 20% cap, off switch | `unit/VaultFlows::test_fee_chargedOnGainsAboveHighWaterMark`, `::test_fee_noneBelowHighWaterMarkAndZeroWhenDisabled`, `::test_fee_capEnforced`, `unit/VaultE2E::test_e2e_downWins_lpGainsFiveFifty_feeOnTheGain` |
| N9 | Everything owed is held: claimable plus pending never exceeds the balance; claims never exceed the settlement | `invariant::invariant_sumOfClaimableAssetsBackedByBalance`, `unit/VaultFuzz::testFuzz_claimsNeverExceedSettlement`, `unit/VaultFlows::test_redeem_partialFillRequeuesRemainder` |
| N10 | Exits are never blocked | `unit/VaultFlows::test_redeem_neverBlockedByPauseOrBreaker`, `unit/VaultInventory::test_breaker_tripsOnDrawdownAndNeverBlocksExits`, `::test_merge_worksWhilePaused`, `invariant::invariant_noViolation` (`h_claim`: a reverting claim is a violation, with the vault paused in many runs) |
| N11 | An unpriceable deposit (NAV wiped) is refunded, not minted | `unit/VaultFlows::test_deposit_refundedWhenNavIsWiped` |
| N12 | End-to-end numbers derived by hand | `unit/VaultE2E::test_e2e_upWins_lpLosesFourFifty`, `::test_e2e_downWins_lpGainsFiveFifty_feeOnTheGain`, testnet run `docs/evidence/phase-4/testnet-e2e.md`, fork `fork/VaultFork::test_fork_lifecycleWithRealUsdc` |

| N13 | Merging is open to keeper, owner, guardian and, while paused, anyone (audit F-04) | `unit/VaultAudit::test_audit_F04_mergeCanNeverBeKeptHostage` |
| N14 | Realised loss stays on record per market (flatten-and-resplit does not restore room) and the total at-risk cap counts other markets (audit F-02b, F-07) | `unit/ForwardVenue::test_audit_F02_realisedLossSurvivesFlatteningAndResplit`, `::test_audit_F07_totalAtRiskCapLimitsTheSecondMarket` |
| N15 | The breaker baseline survives `resumeQuoting` (audit F-02c) | `unit/VaultInventory::test_breaker_tripsOnDrawdownAndNeverBlocksExits` |
| N16 | Losing excess is worth 0, an invalid round pays half (audit F-07) | `unit/VaultAudit::test_audit_F07_losingExcessIsWorthNothingOnceResolved`, `::test_audit_F07_invalidRoundPaysHalfOnTheExcess` |
| V9 | An order can only be executed within `maxLateness` (at most 10 s, 4 s deployed) of its pricing time (audit F-03) | `unit/ForwardVenue::test_audit_F03_executionAfterTheLatenessWindowReverts`, `unit/VaultAudit::test_audit_spreadFloorAndLatenessCap` |

### Griefing (G), rounding and parity (R), owner and external (O, X)

| ID | Mitigation | Tests |
|---|---|---|
| G1 | At most 16 registered markets and 8 assets | `unit/VaultInventory::test_split_registryIsBounded`, `::test_enableAsset_limitsAssetCount`, `invariant::invariant_registryBounded` |
| G2 | Worst-case gas of the registry walk is measured | `unit/ForwardVenue::test_gas_executeOrderWithSixteenRegisteredMarkets` |
| G3 | A report-less checkpoint can not trip the breaker | `unit/VaultInventory::test_breaker_omittedReportCannotTripIt` |
| G4 | A late settler can only expire an epoch (refund/requeue), never move funds | `unit/VaultFlows::test_settle_expiresAfterTheWindow_refundsAndRequeues` |
| G6 | Empty registered markets are dropped (`redeemResolved`, `pruneEmpty`), so a taker can not burn registry slots (audit F-06) | `unit/VaultAudit::test_audit_F06_pruneEmptyFreesTheSlot`, `unit/VaultInventory::test_redeemResolved_reverts` |
| G5 | Minimum request | `unit/VaultFlows::test_requestDeposit_revertsBelowMinimum` |
| R1 | Floor rounding, in the vault's favour, everywhere | `unit/VaultFuzz::testFuzz_flatNavRoundTripLosesOnlyRounding`, `::testFuzz_claimsNeverExceedSettlement`, `unit/VaultE2E::test_e2e_upWins_lpLosesFourFifty` (995,499,004 derived by hand) |
| R2 | On-chain pricing equals the research code on 600 golden vectors | `QuoteMath.t.sol::test_normCdf_matchesTypescript`, `::test_d2_matchesTypescript`, `::test_quote_matchesTypescript`, `::test_rooms_matchTypescript`, `::test_normPdf_matchesTypescript`, `::test_tanh_matchesTypescriptAndSaturates`; `packages/strategy/test/onchain.test.ts` |
| R3 | The risk-room formulas are exact against the loss function | `QuoteMath.t.sol::testFuzz_rooms_areExactAgainstTheLossFunction`, `::testFuzz_quoteInvariants`, `::test_quote_skewLeansAgainstInventory` |
| O1 | Two-step ownership, no renouncing (audit F-12) | `unit/VaultInventory::test_ownership_isTwoStep`, `unit/VaultAudit::test_audit_F12_ownershipCanNotBeRenounced` |
| O2 | Hard limits on parameters | `unit/VaultInventory::test_quoteParams_hardLimits`, `::test_riskAndSigmaConfig_validation`, `::test_enableAsset_bandValidationAndSetBand`, `unit/VaultFlows::test_constructor_revertsOnBadConfig`, `::test_fee_capEnforced` |
| O3 | Venue replacement is timelocked (2 days) and cancellable | `unit/VaultInventory::test_venue_initialOnceThenTimelocked` |
| O4 | No function lets the owner take funds | structural (the ABI has none); `invariant::invariant_keeperAndGuardianHoldNothing` covers the roles it fuzzes |
| X1 | Fee-on-transfer collateral is rejected | `unit/VaultFlows::test_requestDeposit_rejectsFeeOnTransferAsset`, `unit/ForwardVenue::test_vaultBounds_pullFailuresRevert` |
| X2 | The real USDC contract and the real VerifierProxy | `fork/VaultFork::test_fork_realUsdcFacts`, `::test_fork_lifecycleWithRealUsdc`, `::test_fork_realVerifierRejectsForgedReports` |

## 6. Valuation and its manipulation analysis (spec item 3)

`lower NAV = free collateral + Σ markets (pairs + lower value of the excess)`, `upper NAV` likewise with the upper value.

- **Free collateral** is the balance minus unsettled deposits and unclaimed payouts.
- **Pairs** are exactly 1 each (merge always works, even paused and after resolution).
- **Excess tokens of an unresolved round** are valued at `Φ(d2)` from the verified report at the epoch end, evaluated at the keeper's sigma and at the owner's two band edges, then widened by `markBand` (default 0.05). The lower value takes the smallest, the upper the largest. DOWN excess is the complement.
- **Resolved rounds** are exact: the winning excess pays 1 minus the redeem fee (lower value rounds against the vault), losers 0. **Invalid rounds** pay half.
- **A round not yet opened** is worth ½ ± band per token.
- This replaces the prompt's `min(best bid, keeper fair value)` rule: with ADR-004 there is no resting book and no keeper-written fair value to trust.

Who can move it, and by how much:

| Lever | Who | Effect |
|---|---|---|
| Report price | Chainlink DON only (verified) | the intended input |
| Sigma | keeper, inside the owner band | none on the NAV (the band edges are always included); `testFuzz_markBandCoversEverySigmaInTheBand` shows the band contains the fair value for every sigma in the band |
| Which report | nobody: the report whose window contains the epoch end | none (C1, C2) |
| Settlement time | anyone, inside a window shorter than a round | none (`test_settle_laterInTheWindowGivesTheSameShares`) |
| Donations | anyone | raise the NAV at the donor's cost |
| Resolution status | anyone (permissionless) | only to unblock settlement, never to change a price |

## 7. Residual risks (accepted, stated plainly)

- **R1 Report contiguity.** If two valid reports for the same second existed, an executor could pick one. We rely on Chainlink's documented contiguous, non-overlapping windows (the same assumption as ADR-002). `test_exec_overlappingReports_isTheDocumentedTrustAssumption` pins the behaviour so the assumption is explicit.
- **R2 Information lead.** ADR-004's protection holds only while the delay exceeds a trader's information lead; the lead is unmeasured (no Data Streams key) and the design has zero margin at 2 s.
- **R3 Mis-pricing inside the sigma band.** A stolen keeper plus a colluding taker can buy mis-priced shares up to the loss ceilings each round (launch: 1% per market, 8% total in a burst; the audit measured 0.99% of NAV in one market in one round) until the breaker (5% daily, evaluated automatically from fills at most once a minute) pauses quoting; the owner can resume only after the next UTC day or by raising the limit. Keep the band tight (suggested ±35% around a measured volatility). This is the keeper's one economic lever and the main reason the keeper must not be a hot key with funds.
- **R4 Last-second requests.** A request made in the last seconds of an epoch knows the epoch-end price almost exactly. The band (5 points on exposed tokens, which are at most about 16% of NAV at launch limits) is the price of that; it is not zero.
- **R5 Collateral issuer.** Circle can freeze the vault's address; nothing in this system can prevent that.
- **R6 Test verifier on testnet.** Testnet prices are signed by a test key (`MockStreamsVerifierProxy`); mainnet uses the real VerifierProxy (fork test).
- **R7 Gas of fills.** 590,921 gas measured on Monad testnet with one registered market (395k in the forge test; 1.14M with 16 markets holding excess including the automatic re-valuation; `settleEpoch` 726k in the same case); the executor reward must be set from the gas price, the testnet value is not a production value.
- **R8 Liveness.** A Data Streams outage can make epochs expire (requests roll over) and stops quoting; funds and exits are unaffected, and inventory made of complete pairs needs no mark.
- **R9 Coverage of the venue by assets.** Only Data Streams assets can be enabled; MON (push-feed resolution) is not tradable in the vault.
- **R10 Owner has no parameter timelock.** Only venue replacement is delayed (2 days). A compromised owner could widen the sigma band, raise the risk limits within the hard limits and rotate the keeper, then run R3. Mitigation is operational: the owner must be a `TimelockController` behind the Safe on mainnet (Phase 9). Spread floor (0.02) and hard limits are in the contract.
- **R11 Venue-supplied marks.** The venue passes the report price it priced from; the vault stores it as the last known mark used by the breaker and the automatic re-valuation (which can only lower the sizing NAV). A hostile venue could poison that mark; the venue is already trusted to its caps and replacement is timelocked.
- **R12 The executor's option.** Up to `maxLateness` (4 s deployed, 10 s maximum) after the pricing time the executor may decide whether to execute: a small option worth the price drift in those seconds.

## 6. Keeper service (Phase 5)

The service in `services/keeper` holds one key (the keeper role above) and a test-only report signer on testnet. What a bug or an intrusion there can do is bounded by section 4A: it cannot move funds. The service-level risks and what stops them:

| Risk | Mitigation | Evidence |
|---|---|---|
| Bad price in (one feed wrong, stale, jumped) pulls or mis-prices quotes | median of at least 2 sources, staleness per source, divergence and shock triggers, Chainlink sanity; fewer than 2 healthy sources halts | `services/keeper/test/unit/price.test.ts`, `risk.test.ts`; chaos tests (stale feed, 2% jump) |
| RPC outage leaves quotes live | 5 consecutive failures halt; a halt that could not be sent stays wanted and is retried; a rate limiter keeps the keeper under the public endpoint's cap | chaos test "RPC killed mid-run" |
| Inventory runs past the vault's ceiling | pull at 90% of the ceiling, projected-fill check before each execution, resume only under 75% | chaos test "floods of fills" |
| Flapping halt/unhalt costs gas and exposes quotes | hysteresis, doubling flap guard | `risk.test.ts` |
| Keeper key leaks | key is the keeper role only; never logged (pino redaction); `.env` is not committed; rotate with `setKeeper` | runbook |
| Kill switch abused | HTTP endpoint needs a bearer token (constant-time compare), is off without a token, binds to localhost by default | `test/unit/ops.test.ts` |
| Test signer used on mainnet | `STREAMS_SOURCE=test-signer` is testnet only; mainnet verifier would reject it (real VerifierProxy rejects forged reports, fork test) | `VaultFork.t.sol` |
| Process crash with open exposure | restart rebuilds state from the chain; halts first if checks fail | runbook |
