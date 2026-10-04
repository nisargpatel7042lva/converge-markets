.PHONY: install check-all check-0 ts-check sol-check

install:
	pnpm install --frozen-lockfile

ts-check:
	pnpm lint
	pnpm format:check
	pnpm typecheck
	pnpm test

sol-check:
	cd contracts && forge fmt --check && forge build && forge test

check-all: ts-check sol-check

# Phase 0: scaffold + docs present
check-0: check-all
	@test -f CLAUDE.md
	@test -f docs/STATUS.md
	@test -f docs/EXTERNAL.md
	@for f in docs/adr/ADR-001-market-venue.md docs/adr/ADR-002-oracle.md docs/adr/ADR-003-collateral.md; do test -f $$f || (echo "missing $$f"; exit 1); done
	@echo "check-0 OK"
