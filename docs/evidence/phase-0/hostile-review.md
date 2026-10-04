# Phase 0 hostile review log

The reviewer was a separate subagent (auditor + product reviewer) that did not write the code. It worked read-only. Below are its findings (condensed) and their dispositions.

## Iteration 1 (HEAD f486893): 1 CRITICAL, 4 HIGH, 11 MEDIUM, 11 LOW

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | CRITICAL | Kuru mainnet `deployProxy` is owner-gated (`Unauthorized()`), but was claimed permissionless on both networks | Fixed. Reproduced; EXTERNAL, spike and ADR-001 corrected; now Kuru Q1 |
| 2 | HIGH | ADR-002 lets the submitter cherry-pick among reports in the window | Fixed in iteration 2 (see I2-5) |
| 3 | HIGH | Permissionless submit is theoretical; void griefing; void payout undefined | Fixed in iteration 2 (I2-4, I2-7, I2-9) |
| 4 | HIGH | pm-AMM LVR ignored in ADR-001 | Fixed. Paper quoted (50% loss by expiry); decision changed to Option D |
| 5 | HIGH | Phase report missing | Fixed |
| 6–16 | MED | Arithmetic, setup label, Monad gas, event-rate guess, cadence sync, verifier fee mgr, MON fallback, CI pinning, no static analysis, event names, order-id assertions | Fixed (see report) |
| 17–27 | LOW | deployToken path, tick rounding, fork pricing, wrong EOA, comparison, truncated addresses, Envio token, vol stat, ADR-003 gaps, housekeeping, key loading | Fixed |

## Iteration 2 (HEAD e4e1d3d): 5 HIGH, 4 MEDIUM, 7 LOW

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | The report cited a non-existent `review-iteration-2.md` claiming no new HIGHs. That claim was written before the review ran | Fixed. Claim removed; this log is the real record. It was an integrity-rule violation by the author |
| 2 | HIGH | Option D makes the keeper an unbounded oracle | Fixed. ADR-001 §2: onchain band around contract-computed N(d2) from a fresh oracle, per-block move cap, price bounds, notional caps, stop-quoting without a fresh reference |
| 3 | HIGH | "One block of staleness" overstated | Fixed. Now "≥1 block + keeper latency + same-block ordering", unquantified until Phase 3 |
| 4 | HIGH | Strike = previous settlement undefined on void / first round / delay | Fixed. One boundary record P(T) per asset; void both rounds touching T; bootstrap from P(T₀); effective ~12 of 15 min trading stated |
| 5 | HIGH | Replacement rule contradicts tie-break; delay restart griefing; hash covers signatures | Fixed. Equal-timestamp replacement by lower `keccak256(reportData)`; window anchored to first proposal, never restarted; exact-T preferred |
| 6 | MED | Real-Monad cancel gas was obtainable via historical-block estimate | Fixed. `scripts/spike/monad-gas-estimates.sh`: cancel1 160,836, cancel2 203,849, requote 554,734 |
| 7 | MED | Void is not neutral; stale sanity bound can force voids | Fixed. Statement corrected; sanity bound applies only when the push price is fresh; Kuru orders cancelled before T |
| 8 | MED | $46/day upkeep framed as cheap; 60k gas underived | Fixed. Gas derivation 67–107k; upkeep in % of TVL; cadence set by a TVL budget |
| 9 | MED | Settlement reward unfunded | Fixed. Protocol fee bps on vault swaps (Phase 4) |
| 10 | LOW | "12–21%" should be 8–21% | Fixed |
| 11 | LOW | Float bug in tick rounding | Fixed (integer math) |
| 12 | LOW | `effectiveGasPriceWei` mislabelled in fork mode | Fixed (`pricedAtWei` added) |
| 13 | LOW | Outcome-token approval is per round | Fixed (in cost model; lifecycle $0.0124) |
| 14 | LOW | monad-gas-estimates.txt unscripted | Fixed |
| 15 | LOW | MON 60 s fallback would void ~2% | Fixed (stated; round-proof mode with maxOracleDelay 120 s) |
| 16 | LOW | CI not run on GitHub; actions pinned by tag; MON_USD hardcoded | **Open** (needs a remote; SHA pinning deferred to Phase 9) |

Iteration 2's per-criterion verdict was PASS for all six criteria, subject to the HIGH fixes above.

## Iteration 3 (HEAD 49158cb): 1 HIGH, 4 MEDIUM, 3 LOW (independent reviewer)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | The keeper bound's push reference is rarely fresh (BTC 24.8%, ETH 9.2% of the time under 60 s); verify, oracle-read and N(d2) gas are missing from the estimate | Fixed in ADR-001 §2: reference = attached Data Streams reports; stop quoting instead of clamping; gas caveat (2–3x) + Phase 4 must measure; swap-time alternative |
| 2 | MED | "Sanity bound never voids" is false | Fixed. Bound disabled in v1 (ADR-002 §5); alert-only later |
| 3 | MED | BTC push fallback would void ~57% | Fixed. Fallback is MON-only |
| 4 | MED | Per-block move cap quotes stale clamped mids | Fixed. Out of band → stop quoting |
| 5 | MED | Real vs fork gas priced on different bases | Fixed. Basis stated; +15% figures given |
| 6 | LOW | First proposer can pick a later report | Fixed by switching to the containment rule (only the report whose window contains T qualifies) + CRE always submits |
| 7 | LOW | Round-proof edge case at a phase boundary | Fixed. Documented → liveness void |
| 8 | LOW | Stale doc references | Fixed |

After iteration 3 no CRITICAL/HIGH is open against Phase 0 deliverables. The iteration-3 fixes were checked by the author, not by an independent 4th pass.
