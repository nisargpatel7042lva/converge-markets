# Phase 5: what the keeper costs on Monad (testnet, measured)

Window 2026-10-06T15:17:23.044Z to 2026-10-06T15:45:36.511Z (0.47 h). Every transaction the keeper sent is a line of `costs.jsonl`. Monad bills the gas **limit** (the keeper's limit is the estimate plus 15 %), at the effective gas price: mean 102.0 gwei. 1 MON = 1e18 wei; MON has no price on testnet, so USD figures below take MON at an explicit, labelled assumption.

| Kind | Count | Avg gas limit | Avg cost (MON) | Total (MON) | p95 inclusion (ms) |
|---|---|---|---|---|---|
| executeOrder | 2 | 603535 | 0.06156 | 0.1231 | 1430 |
| splitForInventory | 1 | 529188 | 0.05398 | 0.0540 | 1364 |
| setSigma | 6 | 51920 | 0.00530 | 0.0318 | 1815 |
| settleEpoch | 1 | 300484 | 0.03065 | 0.0306 | 2302 |
| mergeInventory | 1 | 247549 | 0.02525 | 0.0252 | 997 |
| haltQuoting | 1 | 100000 | 0.01020 | 0.0102 | 1850 |
| unhaltQuoting | 1 | 100000 | 0.01020 | 0.0102 | 1598 |

Total over the window: 0.2852 MON, 13 transactions. Extrapolated per day: **14.55 MON** for this one TEST/USD series at 15-minute rounds.
