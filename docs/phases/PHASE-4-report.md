# Phase 4 report: the Converge Vault

- **Status: COMPLETE WITH CAVEATS**

## What was built

- `contracts/src/vault/ConvergeVault.sol`: ERC-20 shares, ERC-7540-style requests settled per epoch (900 s, on the 15 minute grid), two-sided NAV (deposits at the upper NAV, redemptions at the lower), performance fee over a high-water mark (10%, max 20%), daily drawdown breaker that re-checks itself from fills, roles (two-step owner, guardian, keeper), bounded keeper (`setSigma`, `splitForInventory`, `mergeInventory`), venue replacement behind a 2 day timelock, permissionless `settleEpoch`, `checkpoint`, `redeemResolved`, `pruneEmpty`.
- `contracts/src/vault/ForwardVenue.sol`: ADR-004 two-step swaps. Orders priced once, from the Data Streams report whose window contains `placed + 2 s`, executed by anyone within 4 s, escrow always refundable.
- `contracts/src/vault/QuoteMath.sol` (+ `packages/strategy/src/onchain.ts` twin, 600 golden vectors) and `ReportLib.sol`.
- `docs/adr/ADR-005-converge-vault.md`, `docs/security/threat-model.md` (every mitigation mapped to a test; all 120 test names it cites exist), `docs/phases/PHASE-4-plan.md`, ADR-004 accepted.
- Deployment: `contracts/script/DeployVault.s.sol`, `deploy-vault.sh`, `deployments/testnet.json` (Monad testnet, chain 10143). Evidence driver `scripts/vault-e2e` (real wall-clock run).
- Tests and checks: `contracts/test/unit/{VaultFlows,VaultInventory,ForwardVenue,VaultFuzz,VaultE2E,VaultAudit}.t.sol`, `test/invariant/VaultInvariants.t.sol`, `test/QuoteMath.t.sol`, `test/fork/VaultFork.t.sol`, `script/check-coverage-vault.sh`, `script/invariant-path-coverage-vault.sh`, `make check-4`.

## How to verify yourself

```
make check-4                       # everything below, needs network for the fork tests
cd contracts && forge test --no-match-contract "VaultInvariants|MarketInvariants|VaultFork"   # 301+ tests, seconds
cd contracts && forge test --match-contract VaultInvariants                                    # malicious keeper, 256 runs x depth 100
cd contracts && forge test --match-contract VaultForkTest --rpc-url https://rpc.monad.xyz      # real USDC + real VerifierProxy
cat docs/evidence/phase-4/testnet-e2e.md                                                       # tx hashes
```

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-4` passes (unit, fuzz, invariants, fork, coverage, static analysis) | **PASS** | `docs/evidence/phase-4/check-4.txt` (exit 0; 304 forge tests pass, 1 skipped locally, the 3 fork tests pass in the same run with `--rpc-url`) |
| 2 | Line coverage >= 95% on the vault and adapters | **PASS** | ConvergeVault 98.92%, ForwardVenue 100%, QuoteMath 100%, ReportLib 100% (`coverage-summary.txt`). There is no Kuru adapter (deviation 1) |
| 3 | Malicious-keeper suite shows no extraction | **PASS** | `VaultInvariants`: 256 runs x depth 100, 0 reverts, 16 attack kinds (`h_attack`), every path reached (`invariant-path-coverage.md`). A longer pre-audit run (3,000 x 150, 450,000 calls) also passed (`invariant-long-run.txt`). 25 mutants killed (`mutation-checks.md`) |
| 4 | Zero unresolved HIGH/MEDIUM static findings | **PASS** | slither: 0 High, 0 Medium (`slither.txt`); `forge lint --deny warnings` clean; every `disable` reviewed with a reason |
| 5 | Testnet E2E with tx hashes | **PASS** | `docs/evidence/phase-4/testnet-e2e.md` (final code). The pre-audit run is kept in `v1-pre-audit/`. TEST-ONLY prices, see Deviations |
| 6 | Threat model written, every mitigation maps to a test | **PASS** | `docs/security/threat-model.md` section 5 |
| 7 | Auditor-persona review: no open CRITICAL/HIGH | **PASS WITH CAVEAT** | `hostile-review.md`: 0 CRITICAL; HIGH F-01 fixed; HIGH F-02 fixed in parts (realised loss, breaker baseline) and its remaining part (a colluding keeper and taker inside the sigma band) can not be removed on chain, so it is documented as residual risk R3. No second review pass on the fixes |

## Test summary

- Forge: 304 pass, 1 skipped locally (the fork suite, which needs `--rpc-url`; 3 pass). Vault-side: VaultFlows 31, VaultInventory 36, ForwardVenue 39, VaultFuzz 6, VaultE2E 2, VaultAudit 10, QuoteMath 16, 7 invariants, 3 fork.
- TypeScript: strategy 102 (twin parity included), backtest 45, unchanged.
- Hand-checked E2E: deposit 1,000 -> 10 UP bought at 0.55 (5.50 USDC) -> UP wins -> LP receives 995.499004 (`VaultE2E.t.sol`, the fork test and the testnet run all agree).
- Gas (ADR-004 asked): filled order **590,921 on Monad testnet** with one registered market (forge: 395k); 16 registered markets all holding excess: fill 1.14M, `settleEpoch` 726k (forge).

## Hostile review: fixed vs open

Full table in `docs/evidence/phase-4/hostile-review.md`. Fixed: F-01 (HIGH, fills frozen between the epoch end and settlement), F-02b/c (HIGH parts), F-03, F-04, F-06, F-07, F-08, F-12, F-13, F-14, F-15 and part of F-10. **Open:** F-02a (HIGH root cause, residual R3), F-05 (MEDIUM, owner has no parameter timelock: needs a TimelockController behind the Safe), F-09 and F-11 (LOW, accepted).

## Deviations and ADRs

1. **No Kuru adapter / PmAmmPool; no on-chain toxicity guard.** Replaced by ADR-004's forward-priced venue (Nisarg's choice). Fork tests use real USDC and the real VerifierProxy on a Monad mainnet fork instead of Kuru.
2. **NAV is two-sided** (lower and upper) and unmarked excess is worth 1/2 plus or minus a band, not `min(bid, keeper fair value)`: there is no resting book and no keeper-written fair value to trust.
3. **Settlement is bound to the epoch end** (marks = the report containing the epoch end, 10 minute window, otherwise the epoch expires) and **fills are frozen** until the epoch is settled. The first design allowed free timing options; found and corrected in our own review and again by the auditor.
4. **Only Data Streams assets** (BTC, ETH) can trade in the vault; MON (push-feed resolution) can not.
5. **Testnet E2E uses a mock verifier** (`MockStreamsVerifierProxy`) with a test signer: prices are TEST-ONLY. The contracts and accounting are the production code.
6. ADRs: ADR-004 accepted, ADR-005 written.

## Known issues and risks (no rounding up)

- **R3 (HIGH, residual):** a stolen keeper plus a colluding taker can take about 1% per market per round inside the sigma band, up to the 8% cap in a burst before the first automatic re-valuation (at most one minute); the breaker then pauses quoting. The audit measured 0.99% of NAV in one market in one round. The only lever is the band and the keeper key policy.
- **Owner has no parameter timelock** (only the venue has 2 days). Mainnet owner must be a TimelockController behind the Safe.
- **Information lead still unmeasured** (no Data Streams key); ADR-004 has zero margin at 2 s.
- **Executor reward** (0.001 MON on testnet) is far below the gas cost at about 102 gwei: it must be set from the gas price (about 0.1 to 0.2 MON per order) before any real executor runs. The executor can still decide to skip an order for up to 4 s after its pricing time.
- Report contiguity (no two valid reports for the same second) is a Chainlink guarantee we rely on (R1).
- A Data Streams outage makes epochs expire (requests roll over) and stops quoting; funds and exits are unaffected.
- Testnet E2E needed resumes after RPC drops in the pre-audit run; the taker's ephemeral key is not stored, so a resumed run skips the taker's own redeem (the vault's numbers are unaffected).
- Dust: 1,000 raw dead shares stay locked forever (0.001 USDC).

## Needs from Nisarg

1. **Data Streams API key + secret and feed IDs (BTC, ETH, MON)**: to measure the Binance-to-Streams lead (decides whether the 2 s delay is enough) and to replace the mock verifier.
2. **Decision on the mainnet owner**: a TimelockController (suggested 2 days) behind the Safe, and who holds the Safe.
3. **Keeper key policy and sigma bands** per asset (the testnet band is 0.4 to 1.2); the keeper must not hold funds.
4. **Executor reward** per order once gas price is known; whether a protocol-run bot executes orders at launch.
5. **MON in the vault**: it needs a Data Streams feed first; confirm MON stays out of the vault for the hackathon.
6. Still open from earlier phases: CRE account, Kuru creation rights, Envio token, alert webhook.

## Readiness for Phase 5

**Yes.** The keeper in Phase 5 needs exactly the surface that exists: `setSigma` within the band, `splitForInventory` / `mergeInventory`, `settleEpoch` (with the canonical report at the epoch end and resolving ended rounds first, see `settlementPlan`), `checkpoint`, `redeemResolved`, and an order executor (`executeOrder` within 4 s of `placed + 2 s`). It must settle promptly: trading is frozen between an epoch end and its settlement.
