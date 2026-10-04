# Phase 0 plan: Foundation + Kuru feasibility spike

## Orient: assumptions

1. Repo lives at `~/converge` (fresh `git init`). No GitHub remote yet.
2. Toolchain: Node 24 (CI uses 22), pnpm 11.0.8, Foundry 1.8.4, solc 0.8.28 (satisfies `^0.8.24`).
3. No funded testnet wallet was provided. The spike creates throwaway deployer and keeper keys in the gitignored `.env`, and tries the live run only if they are funded.
4. Kuru, Chainlink, Mera, Envio and Safe facts are taken only from official docs or source and confirmed onchain where possible.
5. CLAUDE.md is written verbatim. Findings that contradict it go into ADRs and the report, not into CLAUDE.md.

## Tasks → acceptance criteria

| # | Task | AC |
|---|---|---|
| 1 | Write CLAUDE.md verbatim; create docs/ tree | 2 |
| 2 | pnpm workspaces, strict tsconfig, eslint + prettier, one trivial vitest per package | 1 |
| 3 | Foundry in `contracts/` with OZ v5.1.0 + forge-std, trivial test | 1 |
| 4 | Makefile (`check-all`, `check-0`), `.env.example`, `.gitignore`, GitHub Actions CI | 1 |
| 5 | Research spike → `docs/EXTERNAL.md` (Monad, Kuru, Chainlink feeds/Streams/CRE, Mera, stablecoins, Envio, Safe) with onchain checks | 3 |
| 6 | Kuru spike script (viem + official SDK ABIs): tokens, market, bid/ask, 20 cancel/replace, cost model | 4 |
| 7 | Run spike on live testnet, or on a fork plus a precise blocker list and questions for Kuru | 4 |
| 8 | Measure Chainlink push-feed cadence on mainnet | 5 (ADR-002) |
| 9 | ADR-001, ADR-002, ADR-003 | 5 |
| 10 | STATUS.md, evaluation loop, hostile review, report | 6 |

## Live todo

- [x] 1  - [x] 2  - [x] 3  - [x] 4  - [x] 5  - [x] 6
- [~] 7 fork run done; live run BLOCKED on testnet MON
- [x] 8  - [x] 9  - [x] 10
