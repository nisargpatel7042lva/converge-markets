# Phase 9 report: harden everything, prepare the capped mainnet beta

**Status: BLOCKED for the launch; COMPLETE for the hardening and the tooling.** The contracts are hardened and
re-tested, the mainnet deployment, monitoring, runbook, launch checklist and canary tooling exist and were rehearsed on a
fork of Monad mainnet, and the whole product was run end to end on a local chain. **Nothing was deployed to mainnet
or testnet, and the 12-hour canary was not run**, because they need funds, a Safe, Chainlink credentials and alert
webhooks that only Nisarg can provide (questions at the end). One HIGH finding stays open by nature: the Data Streams
path has never run against a real signed report.

**Internally reviewed, not externally audited.** The beta is capped at 5,000 USDC; the cap rationale and the planned
external review are in [`docs/security/internal-audit.md`](../security/internal-audit.md) (sections 9 and 10).

## What was built

Contracts (`contracts/src`)

- `governance/OwnerTimelock.sol`: OpenZeppelin `TimelockController` with no admin; the Safe is the only proposer, executor and canceller. It is the owner of the vault, both resolvers and the partner registry and the admin of the factory and the scheduler receiver. The guardian still pauses instantly. (F9-01)
- `ConvergeVault`: a keeper split is bounded by free liquidity (**F9-18, found by the 10,000-run invariants**); `setKeeper` discards the old key's sigma and halts; `redeemResolved` waits while an epoch settlement is pending; dust excess (≤ 1,000 raw units) needs no mark; symmetric price bounds; bounded `setSigmaConfig`; one feed id per asset; plus the Phase 8 follow-ups (per-market fee sinks, dust-tolerant pruning).
- `ForwardVenue`: a fee-on-transfer collateral is refused at `placeOrder`. Both resolvers: `renounceOwnership` reverts. `PartnerRegistry` + `FeeSink`: per-market fee attribution.

Deployment and operations (`scripts/mainnet`, `ops/`, `docs/ops/`)

- `scripts/mainnet`: idempotent, resumable deployer; read-only `verify`; Safe batches (handover through the timelock, timelocked launch); explorer verification commands; `gen` (keeper config, app deployment JSON from the deployment record); `alert-test` (delivery proven per channel); `timelock-watch` (announces every scheduled owner action); `check-streams` (the live Data Streams acceptance test); `canary:trade`, `canary:report`.
- Monitoring: `ops/prometheus/prometheus.mainnet.yml`, `alerts.mainnet.yml`, `ops/blackbox/blackbox.yml` (app, status, indexer, scheduler probes), `ops/alertmanager/alertmanager.mainnet.tmpl.yml` + `render.sh` (Discord for all, Telegram for pages, an external heartbeat for the dead-man alert), Grafana dashboard `converge-mainnet.json`, `docker-compose.mainnet.yml`.
- App: the public status line (`apps/web/src/lib/status.ts`, `/api/status`, shown on `/stats`).
- Keeper: waits for a pending settlement before `redeemResolved`.
- Docs: [`docs/ops/runbook.md`](../ops/runbook.md), [`launch-checklist.md`](../ops/launch-checklist.md), [`mainnet-deploy.md`](../ops/mainnet-deploy.md), [`local-demo.md`](../ops/local-demo.md), [`docs/security/internal-audit.md`](../security/internal-audit.md), `docs/EXTERNAL.md` (Phase 9 section).
- The local demo: `.demo/start.sh` + `services/keeper/scripts/demo-{stack,bet,collect}.ts`.

## How to verify it yourself

```bash
make check-9                                  # about 25 min; needs network, docker, anvil. Expected last line: "check-9 OK"
cd ~/converge && .demo/start.sh               # the whole product locally, then open http://localhost:3100 (docs/ops/local-demo.md)
cd apps/web && LD_LIBRARY_PATH=$HOME/.local/pwlibs/root/usr/lib/x86_64-linux-gnu pnpm exec playwright test   # 10 tests
pnpm --filter @converge/mainnet test:fork     # the mainnet deployment rehearsal on a fork of mainnet
```

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-all` passes including mainnet-fork tests and extended invariants | **PASS** as `make check-9` (= `check-all` + 8 fork tests + 3 suites at 10,000 runs x depth 100 + the mainnet tooling suites). The first full run **found a real bug** (F9-18); fixed, and the final run is clean | `check-9.txt` (exit 0), `invariants-10000.txt`, `fork-tests.txt`, `check-9-first-run.txt` (the failing run, kept) |
| 2 | Internal audit complete; findings resolved or accepted with reasons | **PASS with one open HIGH.** 18 findings in the first review and the invariants, 22 in the second; every one fixed or accepted with a reason. F9-02 (Data Streams never run on a real report) is **neither fixed nor accepted**: it is a launch gate | `docs/security/internal-audit.md` |
| 3 | Mainnet contracts deployed and verified; addresses in `deployments/mainnet.json`; owner is the Safe | **FAIL (BLOCKED).** Not deployed. The deployment is rehearsed end to end on a fork of mainnet (real USDC, VerifierProxy, Safe factory): 38 transactions, 37.09 M gas limit, **about 3.78 MON** at 102 gwei; handover through a 2-of-3 Safe and a 24 h timelock, crash-resume and an idempotent re-run proven | `mainnet-rehearsal.json`, `scripts/mainnet/test/fork` |
| 4 | Canary of at least 12 h with 0 missed rounds and 0 failed claims; PnL reported honestly | **FAIL (BLOCKED).** Not run. The tooling (trader, report with computed verdict, tests) exists. The product loop was demonstrated for real on a local chain: a bet filled in 1 s, the round resolved from an oracle report, the winner collected 8.83 USDC | `docs/evidence/phase-9/canary/` (empty by design), `local-demo.md` |
| 5 | Alerts tested: a test alert on every channel | **PARTIAL.** Delivery proven against a real Alertmanager container with mock Discord and Telegram endpoints and the heartbeat (page alerts reach Discord and Telegram, warnings Discord only, the Watchdog the heartbeat only, a dead channel is reported FAILED). **Not done on the real channels:** no webhooks exist | `scripts/mainnet/test/alerts`, `blackbox-probes.txt` |
| 6 | Hostile review: no open CRITICAL or HIGH | **FAIL (one HIGH open).** Two reviews by fresh reviewers; every CRITICAL/HIGH they found was fixed except F9-02. Honest note: neither reviewer found F9-18; the invariants did | audit sections 6 and 6b |

## Test summary

- Solidity: **412 passed, 0 failed** (2 fork tests skipped without an RPC) in the default run; **8 fork tests pass** against Monad mainnet (real USDC, VerifierProxy, Chainlink feeds, Safe); **3 invariant suites, 15 properties, 10,000 runs x depth 100 = 1,000,000 calls each, all pass** after the F9-18 fix (a campaign before the fix passed twice and a third found the bug: 10,000 runs is a sample, not a proof). `forge lint --deny warnings`, `forge fmt --check` clean.
- Slither: 0 high, 0 medium. Aderyn 0.6.8: 4 high-class patterns (all triaged as false positives or by design) and 16 low-class. (Both ran before `OwnerTimelock.sol`, a thin wrapper of OpenZeppelin's, was added; slither runs again inside `check-9` and passes its medium/high gate.)
- TypeScript: `scripts/mainnet` 55 unit + 6 fork-rehearsal + 8 alert-delivery tests; keeper 109; web 21 (status line 13); SDK 97; indexer 100; strategy 102; backtest 45; reconcile 9; demo 9; scheduler 7. ESLint, Prettier, tsc strict clean.
- End to end on a local chain: Playwright **10/10** (the first run of the day had two timing flakes, both green on rerun and on isolated rerun; I did not find the cause), plus the persistent demo stack.
- Monitoring configs: `promtool` (rules and config), `amtool`, a throwaway Grafana loading the new dashboard (all 30 PromQL expressions parse), blackbox probes exercised against a stub server.

## Hostile review findings

| Round | Found | Fixed | Open |
|---|---|---|---|
| Manual review (17) + the invariants (1) | 3 HIGH, 6 MEDIUM, 9 LOW/INFO | all HIGH except F9-02; MEDIUM F9-03/04/06/07 fixed, F9-05 accepted with a detector | **F9-02 HIGH (gated)** |
| Hostile whole-system review (22) | 4 HIGH, 8 MEDIUM, 10 LOW | HIGH: F9-18, heartbeat, status line fixed; timelock-watch hardened | accepted: timelock-watch supervision is a checklist item, no in-app pending-owner-action line; MEDIUM: no bytecode comparison in `verify`, no independent balance exporter, canary does not fail on halted time (all in audit 6b) |

## Deviations from the prompt and the plan

- **Deploy script in TypeScript, not Foundry** (`scripts/mainnet`, not `DeployMainnet.s.sol`): it needs the Safe handover, the timelock, idempotent state, a read-only verifier and generators, which are awkward in Forge scripts. The old Foundry scripts still refuse mainnet. Same intent, different tool.
- **Owner = Safe behind a 24 h `OwnerTimelock`**, not the Safe alone: the earlier threat model (R10/F-05) required it and the review rated its absence HIGH. Consequence: resuming quoting after a pause takes a day (stated in the runbook). The guardian pauses instantly.
- **Kuru adapter items are N/A** (there is no Kuru adapter; ADR-001/004/005). The approvals that do exist are listed in the audit (4.9).
- **MON markets are not listed in the app** (no Data Streams stream for MON, and the keeper has only two sources, one of which, Binance, does not list MON).
- **Partner programme off for the beta** (recommended; Nisarg decides).
- **No ADR written**; the decisions are in the audit and the deploy guide. The owner-timelock choice would deserve ADR-009 if Nisarg wants it recorded as one.

## Known issues and risks (no rounding up)

1. **F9-02 (HIGH, open): the Data Streams path has never run against a real signed report.** Window contiguity, 18 decimals, and the three contracts calling `verify` are assumptions. Today the proxy has no fee manager and no access controller (checked live). If real reports have gaps, the design does not work as built. `check-streams` tests this and is the first gate.
2. **The strategy's profitability is unproven.** The Phase 3 backtest said unprofitable as specified and profitable only under pessimistic assumptions; the information lead is unmeasured. The loss is bounded (1 % per market, 8 % total, 5 % daily breaker, 5,000 USDC cap), not zero.
3. **The extended invariants are a sample.** They found a real solvency bug that two earlier identical-size campaigns and two manual reviews missed. Others may remain.
4. **The Safe is the whole of governance**; its signers are people. The timelock gives LPs 24 h only if someone reads the announcements (`timelock-watch` must be supervised).
5. **Payout liveness depends on the keeper's Data Streams credentials** (a second holder is a launch prerequisite). USDC issuer risk is accepted.
6. **Not done:** deployment, explorer verification, the live alert tests, the indexer on mainnet, the CRE workflow, the 12 h canary, a dry import of the Safe batch files in the Safe web app, and an independent bytecode comparison.
7. **Local end-to-end is local.** It uses a flat synthetic price, test money, a test signer, a mock verifier and a faucet; it proves the parts work together, not that mainnet or Data Streams do.

## Needs from Nisarg (numbered)

1. **Funds:** at least 6 MON to a fresh **deployer** key, about 2 MON each to the keeper and scheduler keys, 0.5 to the guardian, 1 to a Safe signer; USDC for the seed.
2. **A Safe on Monad** (address, threshold 2 or more, signers on hardware wallets, not the deployer).
3. **Four distinct keys** (deployer, guardian, keeper, scheduler), created on clean machines.
4. **Chainlink:** Data Streams stream ids for BTC/USD and ETH/USD on Monad and API key + secret (and a second holder); a CRE account if the CRE should lead.
5. **The seed amount** for the vault (I did not assume one), and confirmation of the TVL cap (5,000 USDC default).
6. **Alert channels:** a Discord webhook, a Telegram bot token + chat id, an external heartbeat URL; a paid RPC; an Envio token for the hosted indexer.
7. **Decisions:** partner programme at launch (recommended off); the 24 h timelock delay (or another value); whether to record ADR-009; the external review (ack3 scan from the prize pool, then a named audit before raising the cap); who is on call and the second person who can read a Safe transaction.
8. **Say "go"** after the checklist is ticked; nothing here announces anything.

## Readiness for the next phase

**No, not for the launch.** The next step is Nisarg's inputs above, then in this order: run `check-streams` on the real stream ids (pre-deployment mode), deploy with `docs/ops/mainnet-deploy.md`, work through `docs/ops/launch-checklist.md`, run the canary for 12 hours, read the report. Phase 10 (submission, demo, distribution) can start on the strength of the local end-to-end and the hardened code, but it must say plainly that the mainnet beta has not launched.
