#!/usr/bin/env bash
# Sums the per-run path counters written by VaultInvariants.afterInvariant and fails when a
# required path was never reached. Usage: bash script/invariant-path-coverage-vault.sh
set -euo pipefail
LOG="../docs/evidence/phase-4/invariant-paths.log"
OUT="../docs/evidence/phase-4/invariant-path-coverage.md"
python3 - "$LOG" "$OUT" <<'PY'
import re, sys, collections
log, out = sys.argv[1], sys.argv[2]
t = collections.Counter(); runs = 0
for line in open(log):
    runs += 1
    for k, v in re.findall(r'(\w+)=(\d+)', line):
        t[k] += int(v)
need = ["deposits","redeems","settles","claims","splits","merges","sigma","orders","filled","unfilled",
        "resolved","redeemResolved","attacks","pauses","partial"]
lines = ["# Vault invariant path coverage", "", f"Runs logged: {runs}", "", "| path | calls |", "|---|---|"]
missing = []
for k in sorted(t):
    lines.append(f"| {k} | {t[k]} |")
for k in need:
    if t[k] == 0: missing.append(k)
lines += ["", "Missing required paths: " + (", ".join(missing) if missing else "none")]
open(out, "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
if missing or t["execfail"] != 0:
    sys.exit(1)
PY
