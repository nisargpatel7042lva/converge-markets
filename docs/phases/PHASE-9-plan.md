# Phase 9 plan: harden everything, prepare a capped mainnet beta

Goal (prompt): internal security review and hardening (A), a conservative mainnet deployment with monitoring and a runbook (B), a >= 12 h canary with real money and a launch checklist (C). Real money is involved from here: be conservative and explicit.

## Orientation: what is true on 2026-10-08, and what that means

- **Nothing on mainnet may be broadcast in this phase.** The deployer `0xe368…4dd1` and the keeper `0x6E50…9AF4` hold **0 MON on Monad mainnet** (chain 143, gas price 102 gwei). No Safe address, no seed amount, no Chainlink credentials and no alert webhook exist yet. The prompt itself says Nisarg seeds the vault and decides ("ask; don't assume"), that the owner is a Safe, and that nothing is announced publicly. Parts B2 (deploy and verify), C (canary) and the alert test on "every channel" therefore cannot be completed by me; I prepare them so that they are one reviewed command each, rehearse the deployment on a **local fork of mainnet**, and list exactly what is needed.
- **The oracle path has never run against a real Data Streams report.** The VerifierProxy on Monad mainnet exists (`0xEd81…48c8`, `s_feeManager() = 0x0`), but there is no Chainlink account, so no stream ids, no API key and no real signed report. Everything the vault does with prices (NAV, settlement, fills) depends on that parser. Tests use a signing stand-in with the report layout from Chainlink's docs. This is the single largest residual risk and is a launch blocker, not something a test can close.
- **There is no Kuru adapter in this repo** (ADR-004/005 replaced it; Kuru creation rights are owner-gated and unavailable). The prompt's "Kuru adapter's approvals" and "real Kuru addresses" items are N/A; the audit doc says so and lists the Kuru-less external surface instead (USDC, VerifierProxy, Chainlink push feeds, the CRE forwarder).
- Fork tests exist (`contracts/test/fork/VaultFork.t.sol`) but **skip on the default chain**, so `make check-all` never ran them; `check-9` runs them against a Monad mainnet RPC.
- Phase 8 left two open MEDIUM findings that need a contract change and therefore a redeploy that has not happened on mainnet yet: a direct `Market.claimFees` diverts a partner's fees, and a dust token pins a vault slot. They are fixed here, before any mainnet deployment, rather than shipped.
- Vault v4 is the version that would be deployed (the partner registry is part of it). Whether partners go live in the beta is a decision for Nisarg; the deploy script can leave the registry out.

## Assumptions

1. Beta scope: the vault and the core 15 min / 1 h rounds on assets that have **real Data Streams feeds** (BTC, ETH; MON only if a stream exists), TVL cap 5,000 USD (the CLAUDE.md default, until Nisarg gives a number), per-market loss ceilings as in `config/strategy.default.json`.
2. The owner is a Safe on Monad (the Safe v1.4.1 singleton and factory are verified on chain, `docs/EXTERNAL.md`). Ownership moves with `Ownable2Step` (deployer proposes, the Safe accepts), roles on `MarketFactory` with grant-then-renounce, all checked by a read-only verification script.
3. Public RPCs are rate limited (15 calls/s per IP on testnet; mainnet endpoints listed in EXTERNAL.md); a production keeper needs a paid RPC.

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| A1 | slither (clean), aderyn (triage every finding), extended invariant runs >= 10,000 runs on Market, Vault and Partner suites; evidence saved | 1, 2 |
| A2 | Fix the two Phase 8 MEDIUMs: per-market fee sink (fee attribution), dust-tolerant prune; new tests | 2, 6 |
| A3 | Reentrancy via token hooks: a hook-token test across vault, market, venue and registry | 2 |
| A4 | `docs/security/internal-audit.md`: the checklist (access control, oracle, rounding, reentrancy, DoS, griefing, front-running, keeper compromise, Kuru N/A, pause semantics, deploy parameters), each item with code references, tests and a verdict; findings resolved or accepted with reasons; "internally reviewed, not externally audited", the planned external review, TVL cap rationale | 2 |
| A5 | Mainnet-fork tests of the full system with the real USDC, VerifierProxy, Chainlink feeds and Safe; wired into `check-9` | 1 |
| B1 | Idempotent mainnet deploy script (`DeployMainnet.s.sol`) with Safe handover and a read-only `VerifyMainnet.s.sol`; rehearsed end to end on a local fork of mainnet; refuses to run without the Safe and real feed ids | 3 |
| B2 | `deployments/mainnet.json` writer and explorer verification steps (executed by Nisarg once funded) | 3 |
| B3 | Monitoring: Grafana dashboards (extend Phase 5), uptime checks for app, indexer, keeper and scheduler, alert routing, an alert test tool that fires on every configured channel, a public status line on the stats page | 5 |
| B4 | `docs/ops/runbook.md` (incident response and who does what), mainnet configs for indexer, scheduler, keeper and the app | 3 |
| C1 | Canary tooling: a scripted second-wallet trader, a monitor and a report generator that computes missed rounds, failed claims and vault PnL; rehearsed on a short local run; `docs/ops/launch-checklist.md` | 4 |
| Z | `make check-9`, hostile review (external-auditor persona, whole system), report, STATUS, memory | 1, 6 |

Not doable here, reported as BLOCKED with the exact requirement: mainnet deployment and explorer verification (funds, Safe, feed ids), the 12 h canary with real money (seed amount, funded wallets, phone trades), the alert tests on external channels (webhooks), the hosted indexer (Envio token), CRE (account).


## Outcome (written at the end of the phase)

Done: A1 to A5 (with the extended invariants finding F9-18), B1 as a TypeScript tool with an owner timelock instead of `DeployMainnet.s.sol`, B3, B4, C1 (tooling), Z. Not doable here and reported BLOCKED: the mainnet deployment and explorer verification, the 12 h canary, the alert tests on real channels, the hosted indexer and the CRE workflow. See [PHASE-9-report](PHASE-9-report.md).
