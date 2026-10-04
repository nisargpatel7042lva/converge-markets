.PHONY: install check-all check-0 check-1 ts-check sol-check sol-static

install:
	pnpm install --frozen-lockfile

ts-check:
	pnpm lint
	pnpm format:check
	pnpm typecheck
	pnpm test

# Static analysis: forge lint (warnings are errors) + slither (fails on medium/high; config in
# contracts/slither.config.json; reviewed false positives are annotated inline with a reason).
sol-check:
	cd contracts && forge fmt --check && forge build && forge lint --deny warnings && forge test

sol-static:
	cd contracts && slither . --config-file slither.config.json

check-all: ts-check sol-check sol-static

# Phase 0: scaffold + docs present
check-0: check-all
	@test -f CLAUDE.md
	@test -f docs/STATUS.md
	@test -f docs/EXTERNAL.md
	@for f in docs/adr/ADR-001-market-venue.md docs/adr/ADR-002-oracle.md docs/adr/ADR-003-collateral.md docs/phases/PHASE-0-report.md docs/evidence/phase-0/kuru-spike.md; do test -f $$f || (echo "missing $$f"; exit 1); done
	@grep -q "^## PHASE PROTOCOL" CLAUDE.md
	@pnpm --filter @converge/spike report > /dev/null
	@echo "check-0 OK"

# Phase 1: build, unit + fuzz + invariant tests, coverage >= 95% on core contracts, slither,
# gas snapshot unchanged.
check-1: check-all
	cd contracts && forge test --match-path "test/invariant/*" -vv
	cd contracts && bash script/check-coverage.sh
	cd contracts && forge snapshot --no-match-contract MarketInvariants --check
	@test -f docs/security/phase-1-notes.md
	@echo "check-1 OK"
