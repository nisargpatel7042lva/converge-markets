.PHONY: install check-all check-0 check-1 check-2 check-3 check-4 check-5 ts-check sol-check sol-static

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
	cd contracts && forge snapshot --no-match-contract "MarketInvariants|VaultInvariants|VaultForkTest" --no-match-test testFuzz --check
	@test -f docs/security/phase-1-notes.md
	@echo "check-1 OK"

# Phase 2: everything in check-all, plus ABI freshness, the anvil integration suites (6 h simulated
# fallback run, CRE path through SchedulerReceiver, leader switch) and the CRE workflow build.
# Needs anvil, bun and the CRE CLI (~/.cre/bin) locally; `cre workflow build` needs no login.
check-2: check-all
	cd contracts && forge build
	pnpm --filter @converge/sdk check:abi
	cd services/scheduler/fallback && pnpm exec vitest run test/integration
	cd services/scheduler/cre/scheduler && bun install --frozen-lockfile && bun x tsc -p tsconfig.json
	cd services/scheduler/cre && MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz cre workflow build scheduler -T staging-settings
	@test -f docs/ops/scheduler-runbook.md
	@echo "check-2 OK"

# Phase 3: everything in check-all, plus >= 95% coverage on packages/strategy (thresholds enforced in
# its vitest config), the backtest tests (accounting identity, causality, determinism), the pinned
# data check, a worker-pool determinism check, and the report artifacts. Needs the Binance archives
# (`pnpm --filter @converge/backtest backtest:data`); the full report takes about an hour to regenerate.
check-3: check-all
	cd packages/strategy && pnpm exec vitest run --coverage
	cd backtest && pnpm exec vitest run
	pnpm --filter @converge/backtest verify-data
	pnpm --filter @converge/backtest determinism
	@test -f backtest/report/REPORT.md && test -f backtest/report/results.json && test -f config/strategy.default.json
	@head -5 backtest/report/REPORT.md | grep -q "VERDICT"
	@test -s docs/evidence/phase-3/determinism.txt
	@echo "check-3 OK"

# Phase 4: everything in check-all (unit + fuzz + the malicious-keeper invariant suite at 256 runs x
# depth 100, forge lint, slither), plus: the strategy twin parity (in ts-check), invariant path
# coverage, >= 95% line coverage on the vault, venue and QuoteMath, and the fork tests on a Monad
# mainnet fork (real USDC and the real VerifierProxy; needs network).
check-4: check-all
	cd contracts && rm -f ../docs/evidence/phase-4/invariant-paths.log && forge test --match-contract VaultInvariants
	cd contracts && bash script/invariant-path-coverage-vault.sh
	cd contracts && bash script/check-coverage-vault.sh
	cd contracts && forge test --match-contract VaultForkTest --rpc-url $${MONAD_MAINNET_RPC_URL:-https://rpc.monad.xyz}
	@test -f docs/security/threat-model.md && test -f docs/adr/ADR-005-converge-vault.md
	@grep -q '"vault"' deployments/testnet.json
	@test -s docs/evidence/phase-4/testnet-e2e.md
	@echo "check-4 OK"

check-5: check-all
	# the keeper's anvil tests deploy the contracts from contracts/out, test mocks included
	cd contracts && forge build
	pnpm --filter @converge/keeper typecheck
	pnpm --filter @converge/keeper test
	pnpm --filter @converge/keeper test:integration
	pnpm --filter @converge/keeper test:chaos
	@test -f docs/adr/ADR-006-keeper.md && test -f docs/ops/keeper-runbook.md
	@test -f services/keeper/Dockerfile && test -f docker-compose.yml
	@echo "check-5 OK"
