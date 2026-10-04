#!/usr/bin/env bash
# Reproduces docs/evidence/phase-1/invariant-path-coverage.md: runs the invariant suite with
# per-run lifecycle counters logged, then summarizes how many runs reached each path.
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=../docs/evidence/phase-1/invariant-paths.log
rm -f "$LOG"; touch "$LOG"
INVARIANT_PATH_LOG=true forge test --match-contract MarketInvariants > /dev/null
python3 - "$LOG" <<'PY'
import sys, statistics as st
rows = [list(map(int, l.split())) for l in open(sys.argv[1]) if l.strip()]
print(f"| Lifecycle path | runs with >= 1 (of {len(rows)}) | mean per run |")
print("|---|---|---|")
for i, n in enumerate(["open", "resolve (UP/DOWN)", "invalidate", "redeem"]):
    xs = [r[i] for r in rows]
    print(f"| {n} | {sum(x > 0 for x in xs)} | {st.mean(xs):.2f} |")
PY
rm -f "$LOG"
