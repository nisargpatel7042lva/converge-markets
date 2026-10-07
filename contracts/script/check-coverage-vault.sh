#!/usr/bin/env bash
# Phase 4: fails unless line coverage >= MIN (default 95) for the vault, the venue and their
# libraries. The stateful fuzz (VaultInvariants) and the fork tests are excluded here (coverage
# instrumentation makes them very slow); the unit and fuzz suites alone must reach the threshold.
# Phase 8 adds the partner contracts to the gate. DeployPartnersTest is excluded only because the
# deploy script embeds three contracts and exceeds the code size limit when built unoptimized.
# Usage: bash script/check-coverage-vault.sh
set -euo pipefail
MIN=${MIN:-95}
SUMMARY=$(mktemp)
forge coverage --no-match-contract "VaultInvariants|PartnerCapInvariants|DeployPartnersTest|VaultForkTest" --no-match-coverage "(test|script)/" --report summary > "$SUMMARY"
cp "$SUMMARY" ../docs/evidence/phase-4/coverage-summary.txt
status=0
for f in src/vault/ConvergeVault.sol src/vault/ForwardVenue.sol src/vault/QuoteMath.sol src/vault/ReportLib.sol src/partners/PartnerRegistry.sol src/resolvers/ThresholdResolver.sol; do
  pct=$(grep -F "| $f " "$SUMMARY" | awk -F'|' '{print $3}' | sed -E 's/^ *([0-9.]+)%.*/\1/')
  if [ -z "$pct" ]; then echo "missing coverage row for $f"; status=1; continue; fi
  if awk "BEGIN{exit !($pct >= $MIN)}"; then echo "OK   $f lines ${pct}% (>= ${MIN}%)";
  else echo "FAIL $f lines ${pct}% (< ${MIN}%)"; status=1; fi
done
exit $status
