# Status

| Phase | Name | State | Report |
|---|---|---|---|
| 0 | Foundation + Kuru feasibility spike | **COMPLETE WITH CAVEATS** (live-testnet spike blocked on testnet MON) | [PHASE-0-report](phases/PHASE-0-report.md) |
| 1 | Outcome market contracts | **COMPLETE WITH CAVEATS** (testnet lifecycle blocked on testnet MON) | [PHASE-1-report](phases/PHASE-1-report.md) |
| 2 | Scheduler + settlement (CRE) | **Next** (in progress) | |
| 3 | Strategy library + backtest | not started | |
| 4 | Converge Vault contracts | not started | |
| 5 | Keeper / market-maker | not started | |
| 6 | Envio indexer | not started | |
| 7 | Mobile app (Mera) | not started | |
| 8 | Partner liquidity API + SDK (nice to have) | not started | |
| 9 | Security hardening + mainnet beta | not started | |
| 10 | Submission, demo, distribution | not started | |

## Decisions in force

- ADR-001: every round trades against an oracle-anchored in-vault pool (pm-AMM depth schedule, keeper-written mids). 1h rounds are also listed on Kuru once Kuru grants mainnet creation rights; testnet leg regardless.
- ADR-002: resolve with Chainlink Data Streams reports verified onchain (canonical = earliest report at or after T, finalization delay), delivered by CRE plus a fallback submitter, void = 0.5 USDC per token. Push feeds are a sanity bound only.
- ADR-003: USDC (6 dp) collateral.

## Open blockers

1. Testnet MON for deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` (live Kuru spike).
2. Data Streams account and stream IDs (BTC, ETH, MON).
3. CRE account / early access (`cre workflow supported-chains`).
4. Kuru: mainnet `deployProxy` is owner-gated. Need creation rights (question #1 in `docs/evidence/phase-0/kuru-spike.md`).
5. Envio HyperSync API token.
6. GitHub remote (CI has not run on GitHub yet).
