# Phase 1 hostile review log

The reviewer was an independent subagent (auditor + product reviewer) that did not write the code. It worked read-only and wrote proof-of-concept tests in a scratch copy.

## Iteration 1 (b4fe482): 0 CRITICAL, 0 HIGH, 3 MEDIUM, 7 LOW

| # | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | Round proofs from two aggregator phases are both "valid"; a boundary could be voided for one round and priced for the adjacent one (PoCs) | Fixed: current-phase-only proofs + `checkpoint()` stores terminal statuses; regression `test_adjacentRoundsAgreeAcrossPhaseMigration`; the PoCs now fail |
| M2 | MED | Data Streams verify bricks if Chainlink enables fees | Fixed: payable submit/open/resolve forward value, owner-set `parameterPayload`, refund recovery; tested against a fee-mode mock |
| M3 | MED | Invariants only checked upper bounds; Data Streams not exercised | Fixed: exact-payout + exit violation ghosts, Data Streams + fee markets in the handler; mutation-tested |
| L1 | LOW | Push-fee to recipient can block redeem | Fixed: pull via `claimFees` |
| L2 | LOW | Derived UNRESOLVABLE not stored/emitted | Fixed: `checkpoint` + `BoundaryUnresolvable` |
| L3 | LOW | Late evidence reverted instead of invalidating | Fixed: evidence submitted only while PENDING |
| L4 | LOW | Deploy script could run on mainnet | Fixed: chain-id guard (verified reverting on 143) |
| L5 | LOW | Lifecycle evidence wording; only the tie path shown | Fixed: wording + DOWN rehearsal; BLOCKED stated |
| L6 | LOW | No event when Data Streams finalizes | Fixed: `BoundarySettled` |
| L7 | LOW | Path coverage not reproducible | Fixed: `script/invariant-path-coverage.sh` |

## Iteration 2 (4e7f853): 0 CRITICAL, 0 HIGH, 0 MEDIUM, 5 LOW

| # | Finding | Disposition |
|---|---|---|
| L1 | ETH sent with a report is lost when the verifier charges no fee | Fixed: `FeeModeNotEnabled` revert + test |
| L2 | Overpayment change goes to the resolver, not the payer | Documented (security notes): owner-recoverable; pay the exact fee |
| L3 | Only native fees possible | Fixed: owner-only `approveFeeToken` + test |
| L4 | Handler index overflow silently skipped exit checks | Fixed: modulo indexing; `fail_on_revert = true` now passes |
| L5 | Phase-switch timing race in round proofs | Documented as a residual risk (security notes, Submitters row) |

The reviewer agreed the slither HIGH `reentrancy-eth` is a false positive while resolvers are trusted. That assumption is now stated in the static-analysis doc.

**Open: none above LOW** (L2, L5 documented). The iteration-2 LOW fixes were checked by the author and by `make check-1`, not by a third independent pass.
