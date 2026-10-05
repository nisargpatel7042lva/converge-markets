# Phase 3 hostile review log

Reviewer: an independent subagent in a quant-researcher persona (read-only; probes in scratch copies). Two passes. The reviewer's own probe scripts are not in the repo; the tests they motivated are.

## Iteration 1 (code at the first complete pipeline)

**Verdict: 0 CRITICAL, 3 HIGH, 6 MEDIUM, 6 LOW.** The reviewer independently rebuilt settlement and P&L from raw fills for three configurations and matched the simulator to 1e-13. Bar alignment, ms/µs handling, hash pinning, selection (no hold-out leakage in the search) and the strategy library were found sound. The problems were that the headline claims went beyond the evidence.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | HIGH | The proposed design's "profitable vs sniper" is true by construction at lead = delay; an executor that can choose the block lets a sniper win | **Addressed.** Timing-option sniper (`execWindowBlocks`) and a robustness table (leads 1/2/3 s, delay 8, timing-option rows) in REPORT section 4. ADR-004 specifies forced single-shot execution against the canonical report, no cancellation, prepaid gas, and a Known limits section. The verdict paragraph states the zero margin |
| H2 | HIGH | The sniper was added after seeing results and is calibrated to nothing measured; "fixed before any result" cannot be supported | **Addressed.** Wording removed; Method 2.4 says what was and was not pre-set; the verdict is stated as conditional on the lead and on Binance predicting Streams; a Binance-sniper limitation was added. Inherent: no Data Streams key |
| H3 | HIGH | "The fair-value model is well calibrated" is false in the BTC tails (3.1% predicted vs 6.3% observed) | **Fixed.** Tails table and log-loss-optimal multiplier in REPORT section 1; `vol.scale` (1.1) from pooled log loss on the training window only, applied to both designs; outcome-residual t-statistics reported |
| M1 | MED | The verdict mixes metrics (expected edge excludes informed gains, the realized CI includes them) | **Fixed.** The realized CI excludes per-day informed gains; the classification needs both CIs above zero |
| M2 | MED | The causality test has little power (+1 to +30 bar leaks pass) | **Fixed.** A per-block price-read tripwire (Proxy) and cutoffs at actual fill times; injected +1 and +30 bar leaks are caught by the new tests and were missed by the old one |
| M3 | MED | The hold-out is not an independent restart; days bootstrapped as independent; no CI on the expected edge | **Fixed.** Independent 30-day restart with fresh NAV; 5-day moving-block bootstrap; CI on the expected edge |
| M4 | MED | Equal noise volume under a 2 s fill; unmodelled costs; APY from an invented volume | **Documented** (Limitations 13 and 14; APY presented as a sensitivity) |
| M5 | MED | Chainlink basis sampled only at update instants; push staleness, not Streams | **Documented** (caveat added) |
| M6 | MED | The launch config is valid only for the unaccepted design; tighter caps than CLAUDE.md | **Documented** (REPORT section 6, STATUS, phase report) |
| LOW | | DOWN-side noise cost; pending orders dropped on any non-quoting block; stale total at-risk; identity only algebraic; 1 s bars; thin search | **Fixed or documented.** DOWN cost fixed; only due orders dropped; live total loss; independent reconstruction test; search ranges widened and budget raised to 96 |

## Iteration 2 (final code and report)

**Verdict: 0 CRITICAL, 1 HIGH, 7 MEDIUM, 6 LOW. No accounting or look-ahead bug.** The reviewer verified each iteration-1 fix (including injecting four look-aheads, all caught) and spot-checked 15+ report numbers against `results.json` (all matched). It judged `UNPROFITABLE as specified` supportable and robust.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| HIGH-1 | HIGH | "PROFITABLE" for the proposed design is window-selective: the training window is MARGINAL, realized is about 56% of expected over 90 days, and the hold-out CI's sign depends on the bootstrap method. One headline figure (+$6,817) was labeled "excluding informed gains" but includes $1,974 of them. Residual t-stats were shown only for the hold-out. The "(it is)" calibration claim remained | **Fixed in the report** (no re-run; the numbers were already in `results.json`). A table of class, realized t and residual t on training, hold-out and all 90 days (REPORT 3.2). The verdict paragraph now says "on the hold-out by the rule, but only on that window", reports the class on every window, labels the donated gains, and states that realized is about 56% of expected. The "(it is)" claim is removed. The training-window residual t below −2 is described as a drag, not noise |
| M-1 | MED | Stale text (limitation 5 said days are independent; "1-3¢" tails; ADR-004 "the model is fine") | **Fixed** |
| M-2 | MED | Claimed fixes without tests (DOWN-side taker dollars, live total loss, drop-only-due, informed fill gas, block bootstrap, total cap never binding) | **Fixed except one.** New tests: taker dollars reconstructed from raw fills, informed-order gas, the total at-risk cap binding, the block bootstrap. Each was mutation-checked (the injected mutation fails the new test). **Open (LOW): "drop only due orders when not quoting" has no test** |
| M-3 | MED | Two design-table rows are no-ops (the tuned baseline already has a 0.1 floor and a 600 s window); the d6 label said 0.5% | **Fixed in the report** (a note and a label override; the claim now rests on the 145-set search, which the reviewer verified) |
| M-4 | MED | The spec's pessimistic scenario is vacuous for the proposed design (latency = delay) | **Stated in the verdict paragraph**: both verdict scenarios are safe by construction; the pessimistic one only tests noise volume and tolerance |
| M-5 | MED | ADR-004 said "same canonical rule as ADR-002" but the rules differ (containment vs first at-or-after) | **Fixed.** ADR-004 specifies containment, an executor-cannot-choose acceptance test for Phase 4 (stop-ship), and a revisit trigger |
| M-6 | MED | Windows mixed without labels (hold-out vs 15-day sample; two APY figures) | **Fixed.** Labeled in the verdict paragraph and the summary |
| M-7 | MED | "No search, scenario or design choice read the hold-out" overstated | **Fixed.** Reworded to what is true: only the parameter search and the multiplier value were restricted to the training window |
| LOW | | DOWN fee terms inconsistent in two places (matters only for the 1%-fee row); sniper limited to one pending order (probe: not material); the report said `make check-3` checks the double run; config only for the unaccepted design; hold-out drawdown is end-of-day; basis jitter vs near-expiry sensitivity | **Documented, and the check-3 wording corrected.** The DOWN-side fee inconsistency is **not fixed**: it changes simulator numbers (the 1%-fee design-table row only), and fixing it would invalidate the two full runs. It is recorded here and affects no verdict |

**Exit:** no open CRITICAL or HIGH after the report fixes above.
