# make check-all, 2026-10-11

Command: `PATH=$HOME/.foundry/bin:$HOME/.local/bin:$PATH make check-all` (the shell needs Foundry and Slither on the PATH). Exit status: success (no make errors in the log). Selected lines from the full log:

```
pnpm lint
pnpm format:check
Checking formatting...
All matched files use Prettier code style!
pnpm typecheck
pnpm test
scripts/spike test:  Test Files  1 passed (1)
scripts/spike test:       Tests  3 passed (3)
packages/strategy test:  Test Files  9 passed (9)
packages/strategy test:       Tests  102 passed (102)
indexer test:  Test Files  8 passed (8)
indexer test:       Tests  100 passed (100)
packages/sdk test:  Test Files  10 passed (10)
packages/sdk test:       Tests  97 passed (97)
scripts/mainnet test:  Test Files  6 passed (6)
scripts/mainnet test:       Tests  55 passed (55)
apps/web test:  Test Files  2 passed (2)
apps/web test:       Tests  21 passed (21)
examples/partner-demo test:  Test Files  2 passed (2)
examples/partner-demo test:       Tests  9 passed (9)
scripts/reconcile test:  Test Files  1 passed (1)
scripts/reconcile test:       Tests  9 passed (9)
services/kuru test:  Test Files  1 passed (1)
services/kuru test:       Tests  9 passed (9)
services/scheduler/fallback test:  Test Files  2 passed (2)
services/scheduler/fallback test:       Tests  7 passed (7)
services/keeper test:  Test Files  7 passed (7)
services/keeper test:       Tests  110 passed (110)
backtest test:  Test Files  5 passed (5)
backtest test:       Tests  45 passed (45)
Ran 29 test suites in 20.88s (57.75s CPU time): 412 tests passed, 0 failed, 2 skipped (414 total tests)
INFO:Slither:. analyzed (55 contracts with 102 detectors), 113 result(s) found
```

Slither reports 113 informational and optimization results; the project's config (`contracts/slither.config.json`) fails the check only on medium or high severity, and none were reported.

## make check-10 (the Phase 10 gate = check-all + the document checks + required files)

Last lines of the run on 2026-10-11: `ledger: 44 rows; documents checked: 5; figures not in the ledger: 0`, `checked 99 links in 9 files (3 transactions, 8 addresses, 8 external)`, then **`check-10 OK`**, exit 0.

**Re-run after the afternoon fixes (2026-10-11):** `make check-10` again passed (`check-10 OK`, exit 0): lint, format, typecheck, every unit test, 412 contract tests, forge lint, Slither, the demo-script, thread and ledger checks, and 101 links. `deployments/kuru-testnet.json`, which the Kuru lister rewrites, was added to `.prettierignore` after it broke the format step.
