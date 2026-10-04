# Converge Markets

## Product (one paragraph)
Converge Markets is an onchain liquidity layer for prediction markets on Monad. Liquidity providers deposit stablecoins once into the Converge Vault. The vault automatically makes two-sided markets in every outcome market we list, re-quoting every block and narrowing its range as each market approaches expiry (pm-AMM style dynamic liquidity with a minimum concentration floor). Wedge product: 15-minute and 1-hour UP/DOWN markets on BTC, ETH and MON, resolved trustlessly by Chainlink, traded from a mobile-first app where the account is a Mera passkey (no seed phrase, no extension, no custody backend). Expansion: a liquidity API so other Monad apps can launch markets with instant depth. LP returns must come from spreads, never from token emissions.

## Why this wins / why Monad
- Prior Monad betting apps died from empty pools (Kizzy's own post-mortem). We sell the missing liquidity layer.
- Monad: 400ms blocks, ~800ms finality, and very cheap post/cancel (Monad claims about $0.0001 per post-and-cancel), so an onchain vault can re-quote every block. On most chains that is uneconomic. We must MEASURE and publish this number.

## Hackathon targets (design must satisfy these honestly)
- Track 01 Onchain Finance & Trading (main track) and Grand Champion.
- Kuru "Bring New Assets and Markets to Kuru": a new class of tradable markets on Kuru's spot order book plus the infrastructure to make them viable.
- Chainlink "Best workflow with CRE": a CRE workflow used as the orchestration layer (market creation and settlement).
- Monad Foundation "Best Mera-Powered UX": Mera is the ENTIRE account layer.
- Envio "Best Use of Envio": HyperIndex/HyperSync powering a core feature, not a toy dashboard.
Judges are mostly VCs (Paradigm, Electric, Dragonfly, Castle Island, Pantera, Galaxy...). They judge it as a company: real users, real money, clear economics.

## Architecture (monorepo, pnpm workspaces)
- contracts/          Foundry. OutcomeToken, Market, MarketFactory, ConvergeVault, venue adapters.
- packages/strategy/  Pure TS pricing + quoting math, shared by backtest and keeper.
- packages/sdk/       TS SDK (viem) for contracts, Kuru and indexer.
- services/scheduler/ Chainlink CRE workflow + TS fallback keeper for create/open/resolve.
- services/keeper/    Market-maker keeper service.
- indexer/            Envio HyperIndex.
- apps/web/           Next.js mobile-first PWA with Mera.
- backtest/           Backtest harness and reports (uses packages/strategy).
- deployments/        testnet.json, mainnet.json (addresses and block numbers).
- docs/               STATUS.md, EXTERNAL.md, adr/, phases/, evidence/, security/, ops/.

## Core math (reference; verify against sources before relying on it)
- Fair probability for UP (digital option): p = N(d2), d2 = (ln(S/K) - 0.5*sigma^2*tau) / (sigma*sqrt(tau)), where S is the spot, K the strike (price at round open), tau the time left in years, sigma the annualized vol (EWMA estimate). DOWN = 1 - p.
- Dynamic liquidity: liquidity scales down as expiry approaches, per Paradigm's pm-AMM research (https://www.paradigm.xyz/2024/11/pm-amm). Verify the exact schedule in the paper and cite it in code comments.
- Quotes: half-spread = max(minHalfSpread, volComponent) + inventorySkew + toxicityWidening. The minimum concentration floor means the vault never narrows below a set number of price ticks.
- No-quote window: stop quoting the final N seconds of each round. Toxicity guard: pull quotes when the reference price moves more than X within a short window.

## Default risk parameters (tunable, to be set by the Phase 3 backtest)
- Launch TVL cap: 5,000 USD. Per-market max notional: 5% of NAV. Total at-risk max: 40% of NAV.
- Daily NAV drawdown circuit breaker: 5% (auto-pauses quoting, never withdrawals).
- Price bounds for quotes: [0.02, 0.98]. No-quote window: final 60s (to be tuned).

## Engineering rules
- Solidity ^0.8.24, Foundry, OpenZeppelin v5. Custom errors, NatSpec, events for everything the indexer needs, checks-effects-interactions, ReentrancyGuard, SafeERC20. v1 contracts are immutable (no proxies): pausable, capped, migratable by redeploying.
- Roles: OWNER = Safe multisig on mainnet, GUARDIAN = can pause only, KEEPER = bounded strategy actions only, CREATOR = market creation.
- Users can ALWAYS exit: pause must never block merge, redeem or withdrawal claims.
- TypeScript strict, viem, zod-validated env, pino logs, vitest. No `any` in exported types.
- Secrets never committed. Keep .env.example current. Never print private keys.
- Every external dependency (addresses, ABIs, packages, endpoints) must be VERIFIED from official docs or source and recorded in docs/EXTERNAL.md with source URL and date. NEVER invent an address, ABI, package name or API shape. If something cannot be verified, put it behind an interface, mark it BLOCKED in EXTERNAL.md and in the phase report, and continue with the rest.
- Make targets: `make check-all` runs every lint, build, test and static analysis. Each phase adds `make check-N`.

## PHASE PROTOCOL (mandatory for every phase)
1. ORIENT: read CLAUDE.md, docs/STATUS.md, all docs/adr/*, and the previous phase report. List assumptions.
2. PLAN: write docs/phases/PHASE-N-plan.md: a task list where every task maps to one or more acceptance criteria from the phase prompt. Keep a live todo list.
3. RESEARCH: verify every external dependency the phase touches (see Engineering rules). Update docs/EXTERNAL.md.
4. BUILD-EVALUATE LOOP, per task: implement, run the relevant check, read failures, fix, repeat until green. Commit in small logical commits.
5. PHASE EVALUATION LOOP (max 5 iterations):
   a. Run `make check-N` and `make check-all`. Save outputs to docs/evidence/phase-N/.
   b. Walk every acceptance criterion. For each, record PASS/FAIL with the exact command and an output excerpt as evidence. A criterion without run evidence is FAIL.
   c. Hostile review: spawn a subagent (or do a separate clean pass if subagents are unavailable) acting as a senior auditor and product reviewer who did not write the code. It lists issues as CRITICAL/HIGH/MEDIUM/LOW, covering correctness, security, missing tests, UX and deviations from the spec.
   d. Fix every CRITICAL and HIGH, and any MEDIUM that is cheap. Re-run a to c.
   e. Exit the loop when all criteria PASS and there are no open CRITICAL/HIGH findings, or after 5 iterations.
6. INTEGRITY RULES: never weaken, skip, or delete tests or assertions to get green. Never mock the thing under test. Never claim something works without running it. No TODO/FIXME in shipped code paths unless listed in the report. If you are stuck, say so plainly.
7. REPORT: write docs/phases/PHASE-N-report.md using the template below, update docs/STATUS.md, commit "phase N: <summary>", then PRINT the report and STOP. Do not start the next phase. Wait for Nisarg.

## PHASE REPORT TEMPLATE
- Status: COMPLETE | COMPLETE WITH CAVEATS | BLOCKED | FAILED
- What was built (bullets, with file paths)
- How to verify it yourself (copy-paste commands, expected output)
- Acceptance criteria table: criterion | PASS/FAIL | evidence file
- Test summary: counts, coverage, static analysis results
- Hostile review findings: fixed vs open (with severity)
- Deviations from the spec and ADRs written
- Known issues and risks (be specific, no rounding up)
- Needs from Nisarg: keys, funds, accounts, decisions (numbered questions)
- Readiness for the next phase: yes/no and why
