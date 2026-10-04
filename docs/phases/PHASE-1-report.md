# Phase 1 report: Outcome market core contracts

## Status: COMPLETE WITH CAVEATS

Six of the seven acceptance criteria pass with run evidence. **AC5, the live testnet lifecycle, is BLOCKED.** The deployer has 0 testnet MON. The deploy and lifecycle scripts ran end to end on an anvil fork of Monad testnet (UP/tie and DOWN cases), and those tx hashes exist only on the local fork.

## What was built

All Solidity is in `contracts/` (solc 0.8.28, OpenZeppelin v5.1.0, immutable contracts, no proxies).

**Core contracts**
- `src/OutcomeToken.sol`: EIP-1167 clone ERC-20. Only its Market can mint or burn. Decimals equal the collateral's. Names look like "BTC UP 2026-10-01 14:15 UTC" / "cBTC-UP-2610011415".
- `src/Market.sol`: one round per clone.
  - `split` and `merge`. Merge is never pausable.
  - `open(bytes)` / `resolve(bytes)` take optional resolver evidence and are payable for oracle fees.
  - Ties go UP.
  - `invalidate`: INVALID pays 0.5 per token.
  - `redeem`, with a fee snapshotted at creation (≤ 1%) that the recipient pulls via `claimFees`.
  - Fee-on-transfer collateral is rejected.
  - All boundary reads go through `checkpoint`.
- `src/MarketFactory.sol`:
  - Roles: ADMIN, CREATOR, GUARDIAN.
  - Registry (asset, duration, start) → market, with deterministic clones; duplicates revert.
  - An asset's resolver is fixed once set.
  - The guardian's pause stops only creation and `split`.
  - Redeem fee capped at 1%, default 0.
  - `MarketCreated` carries the full params struct.

**Resolvers** (`src/interfaces/IPriceResolver.sol`: `submit`, `checkpoint`, `priceAt`, `supportsAsset`)
- `src/resolvers/DataStreamsResolver.sol` (primary, ADR-002):
  - Verifies the v3 report through the VerifierProxy (interface copied from Chainlink's docs).
  - The canonical report is the one whose window contains T.
  - Fixed finalization window from the first proposal, with a `keccak256(reportData)` tie-break.
  - Grace period → UNRESOLVABLE.
  - Optional fee mode: `parameterPayload`, forwarded value, `approveFeeToken`, refund recovery.
- `src/resolvers/ChainlinkRoundResolver.sol` (alternative, MON fallback):
  - Proves the first round at or after T in the proxy's current phase, with a same-phase predecessor before T.
  - `maxOracleDelay` and `livenessGrace` handling.
  - Terminal statuses are checkpointed permanently.

**Libraries**
- `src/libraries/Series.sol`: aligned 15m/1h UTC boundaries.
- `src/libraries/MarketNaming.sol`: civil-date formatting for token names.

**Tests**
- Mocks:
  - `test/mocks/MockAggregator.sol`: phases, gaps, stale data, missing rounds.
  - `test/mocks/MockStreamsVerifierProxy.sol`: ECDSA test signer and fee mode.
  - `test/mocks/MockERC20.sol`: 6 and 18 dp, plus a fee-on-transfer token.
- Unit, fuzz and invariant suites: `test/unit/*`, `test/invariant/*`.

**Scripts and gates**
- `script/Deploy.s.sol` and `script/deploy.sh`: testnet only (chain-id guard). They write `deployments/<net>.json` with addresses, block and tx hashes, and support Sourcify verification with `VERIFY=1`.
- `script/lifecycle.sh`: create → split → open → resolve → redeem, writing every tx hash.
- `script/check-coverage.sh` and `script/invariant-path-coverage.sh`.
- `Makefile` target `check-1`. CI installs slither 0.11.6, and `check-all` now includes slither.

**Docs**
- `docs/security/phase-1-notes.md`, `docs/security/phase-1-static-analysis.md`.
- `docs/evidence/phase-1/*`.
- ADR-002 refined: containment rule, current-phase proofs, checkpoint.

## How to verify it yourself

```bash
cd ~/converge
make check-1                                    # ends with "check-1 OK"
cd contracts && bash script/check-coverage.sh   # 3 x "OK ... lines 100.00%"
bash script/invariant-path-coverage.sh          # table of lifecycle paths reached per run
slither . --config-file slither.config.json; echo $?   # 14 low/info results, exit 0
```

Slither must be installed for `check-1` (`uv tool install slither-analyzer==0.11.6`).

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-1` runs build, tests, fuzz, invariants, coverage, slither | PASS | `docs/evidence/phase-1/check-1.txt` (ends "check-1 OK") |
| 2 | Line coverage ≥ 95% on Market, MarketFactory, OutcomeToken | PASS (100% / 100% / 100%; also 100% lines and branches on every `src` file) | `check-1.txt` (`check-coverage.sh` output) |
| 3 | Invariants pass at ≥ 256 runs and depth ≥ 100 | PASS (256 × 100, `fail_on_revert = true`; lifecycle paths reached in most runs; two mutations caught) | `invariant-path-coverage.md`, `check-1.txt` |
| 4 | Static analysis: 0 unresolved HIGH/MEDIUM | PASS. Fixed: `nonReentrant` on submit, explicit init. Each false positive (including a slither HIGH `reentrancy-eth`) is annotated inline and justified. CI gate verified failing on an injected MEDIUM | `docs/security/phase-1-static-analysis.md`, `slither.txt` |
| 5 | Testnet lifecycle with real tx hashes | **BLOCKED**. 0 testnet MON. Anvil-fork rehearsals: tie→UP (paid 100e6) and DOWN (paid 60e6) | `docs/evidence/phase-1/lifecycle.md` and the two rehearsal files |
| 6 | Security notes: trust assumptions, pause preserves exits | PASS | `docs/security/phase-1-notes.md` |
| 7 | No open CRITICAL/HIGH in hostile review | PASS. Iteration 1: 0 C / 0 H / 3 M / 7 L, all fixed. Iteration 2: 0 C / 0 H / 0 M / 5 L, 3 fixed and 2 documented | `docs/evidence/phase-1/hostile-review.md` |

## Test summary

- **Solidity:** 135 tests (134 unit/fuzz + 1 invariant suite with 5 invariants), all passing.
  - Fuzz: 256 runs, fixed seed.
  - Invariants: 256 runs × depth 100 over 6 markets (round-proof and Data Streams, 15m and 1h, one with a 1% fee).
- **Coverage:** 100% lines, statements, branches and functions on all 7 source files.
- **Static analysis:** slither 0.11.6 reports 0 HIGH/MEDIUM unsuppressed and 14 LOW/info, all triaged. `forge lint --deny warnings` is clean.
- **Gas:** the snapshot is committed (`contracts/.gas-snapshot`, excluding invariant and fuzz runs). Examples from the lifecycle: `createMarket` ≈ 1.1M gas including two token clones; `split` ≈ 120k on a warm market.
- **TypeScript:** unchanged from Phase 0, all green inside `check-all`.

## Hostile review findings

Full log: `docs/evidence/phase-1/hostile-review.md`.

**Fixed:**
- **M1:** cross-phase double proofs, and a boundary that could be both voided and priced. Fixed with current-phase proofs plus `checkpoint`; the reviewer's PoCs now fail.
- **M2:** Data Streams would brick if Chainlink enabled fees. Fixed with payable forwarding, `parameterPayload`, `approveFeeToken` and refund recovery.
- **M3:** the invariants couldn't catch underpayment or blocked exits. Fixed with exact-payout and violation ghosts plus Data Streams markets in the handler; mutation-tested.
- **LOWs:**
  - pull-based fees, checkpoint events, late evidence no longer reverting, and the deploy chain-id guard;
  - honest lifecycle evidence and reproducible coverage;
  - no lost ETH without fee mode, and the handler index overflow.

**Open (LOW, documented in the security notes):**
- Overpayment change goes to the resolver, recoverable by the owner but not the payer.
- Phase-switch timing race in round-proof mode.

## Deviations from the spec, and ADRs written

1. **`open(bytes)` / `resolve(bytes)` instead of `open(roundId)` / `resolve(roundId)`.** The bytes are resolver evidence (an abi-encoded roundId for round-proof mode, a signed report for Data Streams), as the spec allows ("behind the same interface"). Data Streams is the primary resolver per ADR-002.
2. **Durations are 15m and 1h only.** Lifecycle markets are 15 minutes, not "a few minutes". The factory deliberately enforces the product's series.
3. **Testnet uses an open-mint `tUSDC` and `MockStreamsVerifierProxy` (a test signer).** There is no testnet Data Streams verifier, and testnet push feeds have a 24h heartbeat. Both are labelled and guarded to testnet chain ids.
4. **Fees are pulled (`claimFees`), not pushed**, a review fix.
5. **ADR-002 was refined, not replaced:**
   - containment rule from Chainlink's report-timestamp docs;
   - current-phase-only round proofs;
   - `checkpoint` for permanent statuses;
   - the push sanity bound stays off.

## Known issues and risks

- **The Data Streams verify path has never run against the real Monad VerifierProxy** (no account or report yet). Fee-mode encoding is unverified. If Chainlink adds an access controller that excludes us, every boundary voids. These all need Phase 2 testing with a real report.
- **The report's `expiresAt` is not checked.** Whether the real verifier rejects expired reports is unknown.
- **Void incentive:** losers gain from INVALID if every submitter stalls. Two submitters plus monitoring are planned for Phase 2/9.
- **Phase-switch timing race** in round-proof mode (MON fallback only).
- **USDC freeze risk** on market contracts (ADR-003).
- **No external audit.** This is internal review only, and not production-grade for meaningful TVL.
- **Local toolchain:** slither is installed via `uv`, at `~/.local/bin`.

## Needs from Nisarg

1. **Testnet MON:** about 2 MON to `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1`, to complete AC5 and the Phase 2 testnet soak.
2. **Chainlink Data Streams access** (stream IDs, API keys, and whether verification is live on Monad). Without it, Phase 2 can only run the Data Streams path against the mock signer, and BTC/ETH settlement stays unproven on real reports.
3. **CRE access:** a `cre login` account or API key for Phase 2's workflow deployment.
4. **GitHub remote**, so CI runs.
5. Still open from Phase 0: Kuru mainnet market-creation rights, the Envio token, and the product-claim amendment.

## Readiness for the next phase

**Yes for Phase 2.** The scheduler needs only the factory and market interfaces and the resolver evidence formats, all of which are now stable. Without testnet MON or Data Streams access, Phase 2's testnet soak and real-report path will be BLOCKED the same way, with anvil and mock evidence in their place.
