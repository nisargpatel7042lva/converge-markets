# Invariant run path coverage and mutation checks

## Path coverage

Reproduce with `bash contracts/script/invariant-path-coverage.sh`. It sets `INVARIANT_PATH_LOG=true` so `afterInvariant` logs each run's counters, then summarizes them.

Run on 2026-10-04 with 256 runs at depth 100 (258 runs were logged). The handler covers 6 markets: BTC round-proof (15m ×2, 1h ×1, one with a 1% fee) and ETH Data Streams (15m ×2).

| Lifecycle path | runs with >= 1 (of 257) | mean per run |
|---|---|---|
| open | 255 | 3.05 |
| resolve (UP/DOWN) | 172 | 1.14 |
| invalidate | 87 | 0.57 |
| redeem | 95 | 0.55 |

(Re-measured after the iteration-2 fixes, with `fail_on_revert = true`.)

## Mutation checks

The invariants must catch real bugs, not pass vacuously. Each mutation was applied to `src/Market.sol`, the suite was run, and the source was restored.

| Mutation | Caught by | Result |
|---|---|---|
| Winners short-paid by 1 unit (`payout = upBal - 1` when UP wins) | `invariant_exitsAlwaysWorkAndPayExactly` | FAIL: `redeem paid wrong amount` |
| `merge` reverts when the market is INVALID | `invariant_exitsAlwaysWorkAndPayExactly` | FAIL: `merge reverted for a holder` |
