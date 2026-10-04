# Phase 0 report: Foundation + Kuru feasibility spike

## Status: COMPLETE WITH CAVEATS

All six acceptance criteria pass with run evidence. Caveats:

- The Kuru spike ran on a fork of Monad testnet, not live testnet, because there is no testnet MON. AC4 allows a precise blocker list instead.
- Two decisions are pending one named external answer each:
  - ADR-001's Kuru leg needs mainnet market-creation rights from Kuru.
  - ADR-002 needs Data Streams to be live on Monad.

Two Phase 0 findings contradict assumptions in CLAUDE.md (see Deviations).

## What was built

- `CLAUDE.md`: verbatim product context, rules and Phase Protocol.
- **Monorepo:**
  - `package.json` and `pnpm-workspace.yaml`: pnpm 11.0.8 workspaces (packages, services, scripts, indexer, apps, backtest).
  - `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`.
  - `eslint.config.mjs` (`no-explicit-any` = error) and `.prettierrc.json`.
  - One trivial vitest per package under `packages/*`, `services/*`, `indexer`, `apps/web` and `backtest`.
- **Contracts:** `contracts/` is Foundry 1.8.4 with solc 0.8.28, OpenZeppelin v5.1.0 and forge-std vendored in `lib/`. It contains `src/Version.sol` with a test, plus `script/spike/SpikeToken.sol` (test-only).
- **Build tooling:**
  - `Makefile`: `check-all` runs eslint, prettier, tsc and vitest, then forge fmt, build, lint (deny warnings) and test. `check-0` adds the Phase 0 doc checks.
  - `.github/workflows/ci.yml`: Node 24, pnpm from `packageManager`, Foundry pinned to v1.8.4.
  - `.env.example`, `.gitignore`.
- **Research and evidence:**
  - `docs/EXTERNAL.md`: every Phase 0 dependency, with source URL, date and VERIFIED/BLOCKED status. Most items are checked onchain.
  - `scripts/spike/verify-external.sh`: re-runs every onchain check.
  - `scripts/spike/chainlink-cadence.py`: measures push-feed update gaps.
- **Kuru spike:**
  - `scripts/spike/src/kuru-spike.ts`: viem with official SDK ABIs, asserted order tracking, teardown.
  - `scripts/spike/src/cost-model.ts` with tests, and `report.ts`.
  - Results: `docs/evidence/phase-0/kuru-spike.md`.
- **ADRs:**
  - `docs/adr/ADR-001-market-venue.md`: oracle-anchored in-vault pool for all rounds, plus Kuru for 1h once Kuru grants creation rights.
  - `ADR-002-oracle.md`: Data Streams with a canonical-report rule, CRE delivery and a void rule.
  - `ADR-003-collateral.md`: USDC.
- `docs/STATUS.md` and `docs/phases/PHASE-0-plan.md`.

## How to verify it yourself

```bash
cd ~/converge
pnpm install --frozen-lockfile
make check-0                                   # expect: ... "check-0 OK"
pnpm --filter @converge/spike report           # expect: the ADR-001 cost table
bash scripts/spike/verify-external.sh          # expect: chain ids 143/10143, USDC/AUSD 6dp, feed descriptions, mainnet deployProxy revert 0x82b42900
python3 scripts/spike/chainlink-cadence.py 40  # expect: ETH max gap ~3600 s, MON median ~30 s (live values drift)
```

Replaying the fork spike needs `anvil --fork-url https://testnet-rpc.monad.xyz --port 8546` and a funded fork account. The steps are in `kuru-spike.md`.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm install && make check-all` passes; CI workflow valid | PASS | `docs/evidence/phase-0/check-all.txt`, `check-0.txt`, `clean-clone-check-all.txt` (fresh `git clone` + `make install` + `make check-all`, exit 0), `actionlint.txt` (0 errors). CI has not run on GitHub because there is no remote yet (Needs #1) |
| 2 | CLAUDE.md exact | PASS | First commit `e6bfc46` contains CLAUDE.md and it is unchanged since (`git log --follow CLAUDE.md` shows one commit). Prettier ignores `*.md` |
| 3 | EXTERNAL.md covers every item, each VERIFIED+URL or BLOCKED+reason | PASS | `docs/EXTERNAL.md`, `external-onchain-checks.txt`, `monad-gas-estimates.txt` |
| 4 | Kuru spike on testnet with numbers, OR precise blockers + Kuru questions | PASS (blocker path + fork numbers) | `kuru-spike.md`, `kuru-spike-fork.json`, `kuru-cost-model.txt`, `monad-gas-estimates.txt` |
| 5 | ADR-001/002/003 with clear decision or one named pending answer | PASS | `docs/adr/*` (ADR-001: Kuru mainnet creation rights; ADR-002: Data Streams live on Monad; ADR-003: decided) |
| 6 | STATUS shows Phase 0 complete and next phase | PASS | `docs/STATUS.md` |

## Test summary

- TypeScript: 8 workspace packages, 10 vitest tests, all passing. The `@converge/spike` cost model has 3 real tests; the other packages each have one wiring test.
- Solidity: 1 forge test passing.
- Static analysis: `forge lint --deny warnings` is clean. eslint is clean with `no-explicit-any` as an error. `tsc --strict` is clean.
- Coverage: not meaningful in Phase 0 (no product code yet).
- Slither is deferred to Phase 9.

## Hostile review findings

The review was done by a separate subagent acting as auditor and product reviewer. It raised 27 findings (1 CRITICAL, 4 HIGH, 11 MEDIUM, 11 LOW).

**Fixed:**

- **CRITICAL:** Kuru mainnet `deployProxy` is owner-gated, but I had claimed it was permissionless on "both" networks. Verified the revert myself. EXTERNAL.md, the spike write-up and ADR-001 are corrected, and this is now Kuru question #1.
- **HIGH: ADR-002 report cherry-picking.** Added the canonical-report rule (smallest `observationsTimestamp` ≥ T), a finalization delay with replacement, and a deterministic tie-break.
- **HIGH: ADR-002 void/griefing.** Defined void payout (0.5 USDC per token), a settlement reward, a secondary submitter independent of CRE, and strike = previous settlement.
- **HIGH: ADR-001 ignored pm-AMM LVR.** Read the paper: a dynamic pm-AMM loses about half its initial wealth by expiry with no fees. Changed the decision from "pure pm-AMM for 15m" to an oracle-anchored in-vault pool.
- **HIGH: report missing.** This file.
- **MEDIUM:**
  - Post+cancel arithmetic: one method, $0.00185, about 18.5x.
  - Setup cost now counts 2 deposits plus teardown ($0.0122 per round).
  - Real-Monad post gas measured via `eth_estimateGas`.
  - The event-driven re-quote rate is now labelled a guess.
  - Cadence numbers synced.
  - VerifierProxy fee manager and access controller are 0x0; recorded and added to the pending answer.
  - The MON push fallback rule is specified, with the "new" risk category noted.
  - CI hardened: Node 24 before pnpm, `engines >=22.13`, Foundry pinned, actionlint output saved.
  - `forge lint` added to `check-all`.
  - Event names now come from the ABI (`OrdersCanceled` etc.).
  - The spike asserts order counts on every step.
- **LOW:**
  - Token deploys go through `send()`, so headroom and status checks apply.
  - Bids floor and asks ceil to the tick.
  - Fork costs repriced at 102 gwei.
  - Wrong EOA fixed.
  - The "1.7% higher" comparison is caveated.
  - Full SVR addresses listed.
  - Envio token requirement recorded (HTTP 401) and added to `.env.example`.
  - Volatility and staleness stats corrected.
  - ADR-003: freeze risk added; the MON-USDC argument downgraded.
  - Housekeeping: contracts README, spike build step documented, check-0 now checks report/CLAUDE.md/cost model, spike loads only the deployer key.

**Open:**

- MEDIUM: cancel/re-quote gas on the real Monad schedule is not measured (no live order IDs could be referenced). It will be measured in the live-testnet run.
- LOW: the `MON_USD` default is hardcoded in the spike (Phase 0 tooling only; overridable by env).
- LOW: CI is unproven on GitHub until a remote exists.

The second review iteration found no new CRITICAL or HIGH issues (`docs/evidence/phase-0/review-iteration-2.md`).

## Deviations from the spec, and ADRs written

1. **"Re-quoting every block" (CLAUDE.md product paragraph):** not economic as Kuru cancel/replace. It costs about $0.0019 per re-quote, about $2.5k/day for 6 markets, roughly 50% of launch TVL per day. ADR-001 keeps per-block re-quoting only as a cheap batched in-vault state write (**estimated** about $0.0002 per update, to be measured in Phase 1/4). Measured fact to publish: on Kuru, one post plus one cancel is about **$0.00185, about 18.5x** Monad's $0.0001 figure.
2. **"pm-AMM style dynamic liquidity":** kept as the **depth schedule** (liquidity ∝ √(T−t) plus floor), but prices are anchored to the keeper's oracle mid. A pure no-oracle pm-AMM gives LPs an expected loss of about 50% per round (Paradigm).
3. **Kuru "new market every round":** impossible on mainnet without Kuru's cooperation (owner-gated).
4. CLAUDE.md is untouched, per the instruction to keep it exact. The amendments above need Nisarg's approval.
5. Commits carry no AI attribution trailer, per the standing preference recorded for this user.
6. An extra workspace, `scripts/spike`, was added. It is not in the CLAUDE.md layout.

ADRs written: ADR-001 (market venue), ADR-002 (oracle), ADR-003 (collateral).

## Known issues and risks

- **Kuru dependency (highest):**
  - Mainnet market creation is gated.
  - Kuru contracts are UUPS-upgradeable and owner-pausable.
  - The Kuru docs disagree with the deployed ABI.
  - If Kuru says no, the Kuru bounty case rests on testnet only.
- **Data Streams on Monad unconfirmed:** the verifier exists but has no fee manager or access controller. There is no testnet verifier, so testnet will use a mock verifier.
- **No testnet MON/USD push feed**, so MON is mainnet-only for the sanity bound.
- **Fork gas ≠ Monad gas:** posts measured 8–21% cheaper on the real schedule; cancels are unknown. Latency is unmeasured.
- **The in-vault batched mid update (~$0.0002) is an estimate.** If it costs over 100k gas per update, ADR-001 must be revisited.
- **Toxic flow:** the economics of LPs against informed flow are unproven until the Phase 3 backtest. The ~1 re-quote/20 s figure is a guess.
- **USDC issuer freeze risk** for the vault.
- **Keys:** two throwaway testnet keys live only in `~/converge/.env` (mode 600, gitignored, never printed or committed; `git log -p` checked). They must never hold mainnet funds.
- **Toolchain:** the local `pnpm` is a wrapper at `~/.local/bin/pnpm`, because corepack's pnpm shim crashed on this machine. CI uses `pnpm/action-setup`.

## Needs from Nisarg

1. **GitHub:** create the repo (name?) and give the remote. Should I push `main` so CI runs? Nothing has been pushed yet.
2. **Testnet MON:** send about 2 MON to `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` (deployer) and about 1 MON to `0x6E5008e79b3F6bcF314467C8B325B3784a9e9AF4` (keeper). Or give me your funded testnet wallets instead. Then I'll run the live spike (latency, real cancel gas).
3. **Kuru mentors:** please send the questions in `docs/evidence/phase-0/kuru-spike.md`. **#1 (mainnet market-creation rights for our factory) decides ADR-001's Kuru leg.**
4. **Chainlink:** sign up for Data Streams and confirm stream IDs for BTC/ETH/MON-USD, API access, and whether verification is live on Monad mainnet (ADR-002). Also, do you have CRE early access? I need `cre workflow supported-chains` output for your org.
5. **Envio:** an API token for HyperSync (`ENVIO_API_TOKEN`).
6. **Decision:** approve the amended product claim. That is: "re-quote every block" means a batched in-vault oracle-mid update, not Kuru cancel/replace, and pm-AMM is used for the depth schedule, not pricing. Or tell me to keep pure pm-AMM despite the LVR finding.
7. **Decision:** is the void payout of 0.5 USDC per UP/DOWN token acceptable product-wise?
8. **Decision:** if MON/USD is not a Data Streams stream, do you accept MON 1h-only on the push feed with the strict 60 s freshness rule?

## Readiness for the next phase

**Yes for Phase 1 (outcome market contracts).** Phase 1 depends on the interfaces (`IStreamsVerifier`, `IVenueAdapter`), the USDC collateral, and the ADR-002 settlement rules, all of which are now decided. A mock verifier is acceptable on testnet. Kuru's answer affects Phase 4/5 (venue adapter, keeper), not Phase 1. Answers to #4 and #6 should arrive before Phase 2 (CRE settlement) and Phase 3 (strategy) respectively.
