# Status

| Phase | Name | State | Report |
|---|---|---|---|
| 0 | Foundation + Kuru feasibility spike | **COMPLETE WITH CAVEATS** (live-testnet spike blocked on testnet MON) | [PHASE-0-report](phases/PHASE-0-report.md) |
| 1 | Outcome market contracts | **Next**. Waiting on Nisarg's answers in the Phase 0 report | |
| 2 | Scheduler + settlement (CRE) | not started | |
| 3 | Strategy library + backtest | not started | |
| 4 | Converge Vault contracts | not started | |
| 5 | Keeper / market-maker | not started | |
| 6 | Envio indexer | not started | |
| 7 | Mobile app (Mera) | not started | |
| 8 | Partner liquidity API + SDK (nice to have) | not started | |
| 9 | Security hardening + mainnet beta | not started | |
| 10 | Submission, demo, distribution | not started | |

## Decisions in force

- ADR-001: hybrid venue. 15m rounds use an in-vault pm-AMM; 1h rounds get a fresh Kuru market each round with event-driven re-quotes.
- ADR-002: resolve with Chainlink Data Streams reports verified onchain, delivered by CRE, submission permissionless, void if missing. Push feeds are a sanity bound only.
- ADR-003: USDC (6 dp) collateral.

## Open blockers

1. Testnet MON for deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` (live Kuru spike).
2. Data Streams account and stream IDs (BTC, ETH, MON).
3. CRE account / early access (`cre workflow supported-chains`).
4. Kuru answers (see `docs/evidence/phase-0/kuru-spike.md`).
