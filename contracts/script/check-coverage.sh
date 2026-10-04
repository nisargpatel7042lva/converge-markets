#!/usr/bin/env bash
# Fails unless line coverage >= MIN (default 95) for each core contract.
# Usage: bash script/check-coverage.sh [summary-file]
set -euo pipefail
MIN=${MIN:-95}
SUMMARY=${1:-}
if [ -z "$SUMMARY" ]; then
  SUMMARY=$(mktemp)
  forge coverage --no-match-coverage "(test|script)/" --report summary > "$SUMMARY"
fi
status=0
for f in src/Market.sol src/MarketFactory.sol src/OutcomeToken.sol; do
  pct=$(grep -F "| $f " "$SUMMARY" | awk -F'|' '{print $3}' | sed -E 's/^ *([0-9.]+)%.*/\1/')
  if [ -z "$pct" ]; then echo "missing coverage row for $f"; status=1; continue; fi
  if awk "BEGIN{exit !($pct >= $MIN)}"; then echo "OK   $f lines ${pct}% (>= ${MIN}%)";
  else echo "FAIL $f lines ${pct}% (< ${MIN}%)"; status=1; fi
done
exit $status
