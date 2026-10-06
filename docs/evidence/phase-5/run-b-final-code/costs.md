# Phase 5: what the keeper costs on Monad (testnet, measured)

Window 2026-10-06T15:48:14.669Z to 2026-10-06T15:51:05.276Z (0.05 h). Every transaction the keeper sent is a line of `costs.jsonl`. Monad bills the gas **limit** (the keeper's limit is the estimate plus 15 %), at the effective gas price: mean 102.0 gwei. 1 MON = 1e18 wei; MON has no price on testnet, so USD figures below take MON at an explicit, labelled assumption.

| Kind | Count | Avg gas limit | Avg cost (MON) | Total (MON) | p95 inclusion (ms) |
|---|---|---|---|---|---|
| executeOrder | 1 | 707408 | 0.07216 | 0.0722 | 1102 |
| setSigma | 5 | 52019 | 0.00531 | 0.0265 | 2436 |
| haltQuoting | 1 | 100000 | 0.01020 | 0.0102 | 496 |
| unhaltQuoting | 1 | 100000 | 0.01020 | 0.0102 | 907 |

Total over the window: 0.1191 MON, 8 transactions. Extrapolated per day: **60.31 MON** for this one TEST/USD series at 15-minute rounds.
