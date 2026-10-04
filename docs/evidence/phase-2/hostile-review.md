# Phase 2 hostile review log

The protocol, step 5c: an independent reviewer who did not write the code, read-only, with probes and test runs in scratch copies. This log condenses each review and records how every finding was handled.

## Iteration 1 (at 6dd01a7)

**Verdict: 3 HIGH open, all on the CRE path. AC6 FAIL.** The fallback path was judged sound.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | HIGH | The CRE workflow made about 100 `callContract` reads per run (leader, assets, 48 × `getMarket`, state/priceAt/proposal per market, plus about 20 per MON binary search), against CRE's **15 EVM reads per execution**. EXTERNAL.md also omitted the limit. | **Fixed.** `SchedulerLens` returns the whole snapshot, including the first-round search, in one `eth_call`, so a run makes 2 reads (leader + lens). `crePath` counts reads (≤ 15) and cross-checks the lens plan against the multi-call reader at every step. The full CRE quota table is in EXTERNAL.md. |
| H2 | HIGH | 12 creates via `onReport` used 6.48M gas (probe), against a 5M `gasLimit`. At bootstrap every run reverted, so CRE never started. The test hid this with a 15M gas limit. | **Fixed.** `prioritize` puts settlement first, creates are capped at 4 per report, the receiver stops under a 750k reserve (`ActionsSkipped`), `gasLimit` is 9M, and `crePath` uses 9M. Test: `test_oversizedBatchDegradesWithinGasLimit`. |
| H3 | HIGH | The cron ran at T, before the Data Streams report existed, and a 404/200 split threw and aborted the whole run. Resolve landed around T+90 on CRE. | **Fixed.** Cron is `5,35 * * * * *`; the node-mode fetch never throws; consensus errors are caught per action; the finalization window is 20 s (ADR-002 updated). CRE-path max resolve is 38 s, assuming instant writes (see M-c). |
| M1 | MED | `receiverContractExecutionStatus` was ignored. | Fixed: the workflow throws on a receiver revert. |
| M2 | MED | No automatic recovery past the 2 h lookback while CRE leads. | Fixed: the lens omits settled slots, so each read covers the deep lookback (26 h). `recovery.test.ts` runs a 3 h outage. |
| M3 | MED | Fallback: retried `writeContract`, no stuck-transaction handling, 180 s receipt waits. | Fixed: nonce manager, single broadcast (no blind resend), 60 s bounded wait that yields `pending` plus an alert. The manual replacement procedure is in the runbook (added in iteration 2). |
| M4 | MED | `/health` stayed green while every action failed. | Fixed: a `consecutiveBad` counter; 503 after `UNHEALTHY_AFTER_BAD_TICKS`. |
| M5 | MED | Possible secret leak through error messages and an unauthenticated `/health` on all interfaces. | Fixed: `shortMessage` plus URL redaction; health bound to 127.0.0.1 by default. |
| M6 | MED | No `.dockerignore`, so `.env` could be baked into the image. | Fixed: the root `.dockerignore` excludes `**/.env`, `node_modules` and `.soak`. |
| M7 | MED | The 6 h simulation was happy-path only. | Fixed: MON feed jitter of 20–90 s, a recovery test (3 h outage), and a leader-switch test. Test-signer reports still use `validFrom == observationsTimestamp == T`; realistic report windows are covered only by resolver unit tests (Phase 1). |
| M8 | MED | MON 15m contradicted ADR-002. | Fixed: per-asset durations; MON is 1h only. |
| L1 | LOW | Receiver hardening (monotonic or future time, workflowId 0, `maxReportAge` 0, no deploy script). | Fixed: `StaleReport`/`FutureReport`, `InvalidMaxReportAge`, and `Deploy.s.sol` deploys the receiver and lens with the CREATOR grant. A workflowId of 0 is still allowed on testnet (see L-d). |
| L2 | LOW | One boundary's evidence is verified twice (resolve of round n, open of round n+1). | **Open.** Gas only. |
| L3 | LOW | CREATE was planned when `startTime == now`. | Fixed: `>`; tested in `planner.test.ts`. |
| L4 | LOW | Alert gaps (unbounded dedupe map, failures never alerted directly). | Fixed: the map is pruned and failed or pending actions alert. |
| L5 | LOW | The fallback acted standalone when `RECEIVER` was unset. | Fixed: `RECEIVER` is required unless `STANDALONE=true`. |
| L6 | LOW | All-zero `streamsFeedId` was accepted. | Fixed: `liveFeedId` rejects zero IDs for live sources. |
| L7 | LOW | CRE `callContract` doesn't pin a block. | **Open.** Both reads target the latest block; the risk is benign, since a read across two blocks only means the actions are re-planned. |
| L8 | LOW | Runbook nits. | Fixed. |
| L9 | LOW | "3 rounds ahead" was not asserted. | **Partly addressed.** The test asserts that every round was created before its start, and the evidence table records each lead time (minimum 794 s). It does not assert "3 ahead" exactly. |

## Iteration 2 (at 1f957d8)

**Verdict: 0 CRITICAL, 0 HIGH. All three iteration-1 HIGHs are fixed.** Four MEDIUM and seven LOW findings.

The reviewer passed everything:
- forge: 157 tests;
- the integration suites: 3 of 3 runs at HEAD.

One earlier `make check-2` failed under host load: the timestamp ordering issue in L-a.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M-a | MED | The lens response size could exceed CRE limits at go-live or recovery. CRE passed no epoch, and the lens returned every missing slot over 26 h: 272 slots, about 96 KB. | **Mitigated.** `epoch` is in the CRE config. Missed slots are reported only within `missedLookback` (= the 2 h recent lookback). The response is capped at 256 slots with a `truncated` flag: the fallback alerts on it and counts it as a bad tick; CRE only logs it, because a workflow has no alert channel. Estimated go-live worst case for today's config: about 37 slots × 352 B ≈ 13 KB. Steady state is about 25 slots ≈ 9 KB. The documented 5 KB limit applies to the read **request** payload (EXTERNAL.md). Whether a read **response** counts against the 25 KB consensus observation limit is not documented, so this stays open until CRE simulation is possible (blocked: no account). `epoch` in the committed CRE configs is 0 and must be set at deploy. |
| M-b | MED | `TooManySlots`, or any revert inside the lens (for example one deprecated feed), stopped scheduling for every asset on both paths. | **Fixed in two steps.** Iteration 2: per-call try/catch, truncation instead of revert, and the fallback falls back to the multi-call reader if the lens fails. Iteration 3 found gaps in that isolation (M-1 below), now closed: each slot's oracle evaluation runs in a gas-capped self-call. |
| M-c | MED | The ≤ 60 s CRE resolve assumes instant DON writes. With write latency ≥ ~10 s, the Data Streams proposal is not FINAL by the :35 run, so resolve slips to about T+65–70. | **Open, documented** (report: SLA and known issues). Mitigations once CRE is live: measure write latency in simulation; shorten the window; or let the fallback push FINAL boundaries regardless of leader (permissionless and idempotent). |
| M-d | MED | Evidence and report disagreed on the MON resolve (61 vs 32 vs 71 s), because the simulation start depended on the wall clock. AC6 cited a missing file. MON's real SLA was not stated in the AC table. | **Fixed.** The integration suites start at a fixed, hour-aligned timestamp, so runs are deterministic. The report quotes the regenerated numbers and states MON's SLA as ≤ ~150 s. This file exists. |
| L-a | LOW | `sixHours` was flaky under load ("timestamp lower than previous block"). | Fixed: time never moves backwards (`t = max(t, latest + 1)`), in all three suites. |
| L-b | LOW | `/health` stayed 200 while acting and late (evidence never arrives). | Fixed: "acting and late beyond 3× threshold" and "oracle error" both count as bad ticks. |
| L-c | LOW | `NotUnresolvable` classified as `waiting`. | Reviewed and judged safe; L-b covers the persistent case. No change. |
| L-d | LOW | The testnet deploy uses the Mock forwarder with workflowId 0, so anyone can drive the receiver (liveness and create-spam only; outcomes cannot change). | **Open, testnet only.** The production deploy must use the real KeystoneForwarder and a non-zero workflowId (report: known issues). |
| L-e | LOW | The 750k per-action gas reserve was not measured on Monad's gas schedule. | **Open.** It degrades gracefully. Measure on testnet (blocked on MON). |
| L-f | LOW | A MON derived-UNRESOLVABLE invalidation is possible only at T+120, but its `dueAt` is T, so lateness can flap on the CRE path. | **Open.** Health can flap only if the 150 s threshold is crossed 3× (450 s) while acting; a passive side only alerts. Proper fix: `dueAt = T + maxOracleDelay` (needs the resolver parameter in the lens). |
| L-g | LOW | The soak write-up omitted a 111 s stall and the +4.6 min chain-time drift. | Fixed: disclosed in `soak-local.md`. |

The reviewer also noted that commit 1f957d8's message did not match its content (it adds the report). That history was already published, so it was left unrewritten and the mismatch is recorded here.

## Iteration 3 (uncommitted fix diff on bdfa273)

**Verdict: 0 CRITICAL, 0 HIGH.** The lens is advisory: resolvers verify every proof onchain, so a misreported slot costs only liveness or gas.

The reviewer confirmed:
- forge: 160 tests;
- SDK: 27 tests.

Probes confirmed M-1 and M-2.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M-1 | MED | Per-slot isolation had gaps. A gas-burning feed consumed 63/64 of the gas and reverted the whole snapshot. An out-of-range enum or short return data reverted while decoding in the `try` success branch. The fallback's multi-call reader had no isolation at all. | **Fixed.** Each slot's oracle evaluation is the external `oracleView`, called via `this.oracleView{gas: ORACLE_GAS = 1.5M}`; a revert, out-of-gas or decode failure inside lands in `catch`, which records `STATUS_ORACLE_ERROR`. The multi-call reader calls `priceAt`/`proposal` with `allowRevert` and range-checks the status. Tests: `test_gasBurningFeedIsIsolated` (an infinite-loop feed etched in), `test_malformedResolverReturnIsIsolated` (status 7), and the SDK `snapshot.test.ts` (both readers). Residual: each broken slot burns up to 1.5M gas of the `eth_call`. |
| M-2 | MED | Truncation filled slots in config order, so later assets (including their upcoming creates) were starved, and `/health` stayed green. | **Fixed.** Pass 1 returns upcoming missing markets for every series; pass 2 serves past slots newest-first, round-robin across series. `truncated` counts as a bad tick. `test_truncatesAndBoundsMissed` asserts creates come first and a 128/128 split between the two assets. |
| M-3 | MED | The lens-failure path used the deep multi-call sweep (about 1000 sequential `eth_call`s, flooding missed alerts) with no retry and no isolation, and was untested. | **Fixed.** On lens failure the reader uses the recent window only (bounding calls and missed reports), with `withRetry` and isolation (M-1), and counts the tick as bad. Integration test: `leader.test.ts` "keeps scheduling through the multi-call reader when the lens fails" checks that a broken lens address gives the same plan and missed set as the real lens at the same chain state, plus the alert and the bad tick. |
| L-1 | LOW | Coverage gaps: the lens→multi-call path, the 254 mapping, a vacuous `test_feedRevertIsIsolated`, and which slots survive truncation. | Fixed (the tests above). `test_feedRevertIsIsolated` now asserts that the BTC slot is present. |
| L-2 | LOW | `FIXED_START` (2027-01-15) would be in the past after that date, because anvil starts at wall-clock time. | Fixed: anvil is spawned with `--timestamp FIXED_START - 3600`. Note: under heavy load the monotonic clamp can still shift a `crePath` step off :05/:35, which affects only that step's measured delay. |
| L-3 | LOW | Doc overclaims: "both paths alert" on truncation; AC2 "identical runs" not in evidence; M-b "Fixed"; AC6 PASS before this iteration was logged. | Fixed: wording corrected (CRE logs only); the AC2 claim is cited to this log: two runs were diffed, before and again after the L-2 anvil change, each time with an identical summary and identical final states. Creation lead times vary by 1–3 s and the numbers changed once, with the anvil start (now Data Streams 31 s, MON 71 s).; M-b re-dispositioned; AC6 is now based on this iteration. |
| L-4 | LOW | Config edge cases (lookback overflow, `lookahead = 0`) reverted the lens. A passive fallback goes 503 on oracle errors. | Fixed and documented. The config schema bounds lookbacks (recent ≤ 7 d, deep ≤ 30 d) and `lookaheadRounds ≥ 1` was already enforced; the lens loop no longer underflows at 0. The runbook documents that a passive 503 on oracle errors is intended. |

## Exit

After iteration 3: **0 open CRITICAL/HIGH.** The open MEDIUMs (M-a residual, M-c) both need a CRE account to measure, and they are listed in the phase report.
