# Status

| Phase | Name | State | Report |
|---|---|---|---|
| 0 | Foundation + Kuru feasibility spike | **COMPLETE WITH CAVEATS** (live-testnet spike blocked on testnet MON) | [PHASE-0-report](phases/PHASE-0-report.md) |
| 1 | Outcome market contracts | **COMPLETE WITH CAVEATS** (testnet lifecycle blocked on testnet MON) | [PHASE-1-report](phases/PHASE-1-report.md) |
| 2 | Scheduler + settlement (CRE) | **COMPLETE WITH CAVEATS** (testnet soak blocked on testnet MON; CRE simulation/deploy blocked on CRE account; CRE DON latency unmeasured) | [PHASE-2-report](phases/PHASE-2-report.md) |
| 3 | Strategy library + backtest | **COMPLETE WITH CAVEATS.** Verdict: UNPROFITABLE as specified (keeper-posted quotes lose to latency snipers); PROFITABLE UNDER PESSIMISTIC ASSUMPTIONS with forward-priced execution (ADR-004, Proposed), not robust to leads above the delay; the lead is unmeasured | [PHASE-3-report](phases/PHASE-3-report.md), [REPORT](../backtest/report/REPORT.md) |
| 4 | Converge Vault contracts | **COMPLETE WITH CAVEATS.** Vault + forward-priced venue built and deployed on Monad testnet, E2E with tx hashes. Residual risks stated plainly: a colluding keeper and taker can take about 1% per market per round inside the sigma band until the breaker trips (R3); owner changes have no timelock (needs a TimelockController behind the Safe); the Binance-to-Streams lead is still unmeasured | [PHASE-4-report](phases/PHASE-4-report.md), [threat model](security/threat-model.md) |
| 5 | Keeper / market-maker | **COMPLETE WITH CAVEATS.** Keeper built, 106 tests, 3 review rounds, vault v3 with `keeperHalt` on testnet. NOT met: the 2 h live run (testnet MON ran out after about 31 minutes) and the 2-block latency targets (Monad inclusion is 0.5 to 1.5 s: pull-all took 4 blocks, quote age is 4 to 6 blocks) | [PHASE-5-report](phases/PHASE-5-report.md), [costs](evidence/phase-5/costs.md) |
| 6 | Envio indexer | **COMPLETE WITH CAVEATS.** Indexer, SDK helpers, reconcile tooling built; real-testnet and local runs with a LOCAL indexer. Hosted deployment and HyperSync backfill BLOCKED (no `ENVIO_API_TOKEN`); lag on testnet not measured; reconcile does not recompute PnL/cost from chain | [PHASE-6-report](phases/PHASE-6-report.md) |
| 7 | Consumer app (Mera) | **COMPLETE WITH CAVEATS.** `apps/web` (Next 16, Mera only), 10 e2e tests on a local chain with the real contracts and keeper (first trade 4.9 s), Lighthouse >= 93/100/100 on 9 pages, deployed on Vercel (https://converge-markets-app.vercel.app; blocks India by design). NOT done: a run on Monad testnet from a phone (no live rounds, keeper or relayer funds). Decisions flagged: gas (ADR-007), region list, legal review | [PHASE-7-report](phases/PHASE-7-report.md) |
| 8 | Liquidity-as-a-service for partner apps | **COMPLETE WITH CAVEATS.** `PartnerRegistry` + `ThresholdResolver` + vault v4 (per-partner, global and NAV-fraction caps enforced by the vault), publish-ready SDK, keeper/indexer support, `examples/partner-demo`, `docs/partners.md`; 377 contract tests, hostile review 2 rounds (3 HIGH fixed, none open). Demonstrated end to end on a LOCAL chain (quotes 1 block after creation). **The testnet deployment and demo are BLOCKED on funds (about 2.2 MON for the contracts; the deployer holds 0.26).** Open MEDIUMs: a direct `Market.claimFees` diverts a partner fee share; a dust token pins a slot. | [PHASE-8-report](phases/PHASE-8-report.md) |
| 9 | Security hardening + mainnet beta | not started | |
| 10 | Submission, demo, distribution | not started | |

## Decisions in force

- ADR-001: every round trades against an oracle-anchored in-vault pool (pm-AMM depth schedule, keeper-written mids). 1h rounds are also listed on Kuru once Kuru grants mainnet creation rights; testnet leg regardless.
- ADR-002: resolve with Chainlink Data Streams reports verified onchain (canonical = the report whose window contains T, 20 s finalization window), delivered by CRE plus a fallback submitter, void = 0.5 USDC per token. MON resolves via push-feed round proofs (current phase only), 1h only, SLA ≤ ~150 s.
- Scheduler: onchain leader flag on `SchedulerReceiver` (CRE = 0, FALLBACK = 1); both paths read state through `SchedulerLens` in one call.
- ADR-003: USDC (6 dp) collateral.
- ADR-004 (**Accepted** 2026-10-05, Known limits unresolved): forward-priced two-step execution replacing keeper-posted quotes with immediate fills.
- ADR-005 (**Accepted**): the vault. ERC-7540-style epochs priced at the Data Streams report AT the epoch end inside a 10 minute window (else the epoch expires), fills frozen between the epoch end and its settlement, two-sided NAV, keeper limited to `setSigma` / `splitForInventory` / `mergeInventory`, venue behind a 2 day timelock, breaker that re-checks itself from fills.

## Open blockers

0. **Testnet MON (about 8 MON now: 5 for the Phase 5/7 runs + 3 for the Phase 8 deployment and demo) to the deployer** `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1`: the Phase 5 2 h run, a live testnet demo of the app (relayer key, keeper, rounds).

1. Testnet MON for deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` (live Kuru spike, testnet lifecycle, testnet soak, Monad gas measurement).
2. Data Streams API key/secret and feed IDs (BTC, ETH, MON).
3. CRE account (`cre login` / `CRE_API_KEY`) plus a funded `CRE_ETH_PRIVATE_KEY`: simulate, measure DON latency, deploy.
4. Kuru: mainnet `deployProxy` is owner-gated. Need creation rights (question #1 in `docs/evidence/phase-0/kuru-spike.md`).
5. Envio HyperSync API token.
6. Alert webhook (Discord or Telegram) for the fallback scheduler.
7. Chainlink Data Streams key and secret: measures the Binance-to-Streams lead that decides whether ADR-004's 2 s delay is enough (Phase 3).

Repo: https://github.com/nisargpatel7042lva/converge-markets (CI green on `main`).
