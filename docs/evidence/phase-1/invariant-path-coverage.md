# Invariant run path coverage

Measured on 2026-10-04 by temporarily logging the handler's counters in `afterInvariant` to a file. The logging was reverted afterwards because it needs `fs_permissions`. One line per run, 256 runs, depth 100.

| Lifecycle path reached | runs with ≥1 occurrence (of 258 logged) | mean per run |
|---|---|---|
| open (strike set) | 250 | 2.07 |
| resolve (UP/DOWN) | 191 | 0.99 |
| invalidate (INVALID) | 71 | 0.40 |
| redeem | 101 | 0.55 |

The post-resolution invariants (`invariant_solventAfterResolution` and the per-actor extraction bound) are therefore exercised in most runs, not vacuously true.

Handler design notes:

- Only action selectors are targeted.
- `warp` publishes a feed round 0–59 s after each crossed 15-minute boundary and skips about 1 in 7 boundaries (stale feed), which drives INVALID.
