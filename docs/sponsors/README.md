# Sponsor tracks: where to look and what is real

Honest status as of 2026-10-09. "Live" means it ran on Monad testnet (10143) and left transactions you can open.

## Kuru: Bring New Assets and Markets to Kuru

**What:** every 15-minute Converge round's UP token (a fully collateralised binary outcome token that converges to 0 or 1) is listed as its own market on Kuru's order book, seeded and quoted around the vault's fair value, and torn down and redeemed at the end of the round.

- Code: `services/kuru/` (lister, quoter, taker demo, evidence report), app panel `apps/web/src/components/kuru-panel.tsx`.
- Doc and measured costs: [`docs/kuru/INTEGRATION.md`](../kuru/INTEGRATION.md). Evidence with explorer links: [`docs/evidence/kuru/rounds.md`](../evidence/kuru/rounds.md), [`taker-fill.json`](../evidence/kuru/taker-fill.json).
- Status: **live on testnet**, one full round (list, 18 quotes, a separate-wallet taker fill both ways, teardown, redeem).
- Gap: the maker is our own wallet (testnet), Kuru mainnet creation rights are unverified.

## Envio: Best Use of Envio

**What:** Envio HyperIndex is the read side of the product. The app's earn page (vault value, 7d/30d APY, NAV chart), the stats page (volume, trades, daily stats) and My bets (positions and realised PnL, including finished markets from earlier days) read the indexer; the chain is the fallback, never the other way round for history.

- Code: `indexer/` (schema, handlers for markets, trades, positions with average-cost PnL, vault NAV/APY, partners; 82 tests), typed client `packages/sdk/src/indexer.ts`, query documents `indexer/QUERIES.md`, reconciliation against the chain `scripts/reconcile/`.
- Local run against the live testnet deployment: `bash scripts/indexer/run-local-testnet.sh` (no token; Postgres and Hasura in Docker; read-only GraphQL on `:8081`). Config is generated from `deployments/testnet.json` by `pnpm --filter @converge/indexer gen:config`.
- Status: indexer built and tested; **running locally on testnet** (the sync from the vault deploy block is slow on the public RPC, about 22 blocks/s). **Not hosted on Envio Cloud**: that needs the owner's Envio login and the GitHub app (steps in `docs/ops/indexer-runbook.md`). HyperSync (fast backfill) is what Cloud uses.

## Monad Foundation: Best Mera-Powered UX

**What:** Mera is the whole account layer. No seed phrase, no extension, no custody backend: the account is a passkey (WebAuthn PRF), the PRF bytes are the key, and the key exists only inside a one-confirmation signing session that zeroes it.

- Code: `apps/web/src/lib/account.ts` (create, restore on a new device, one signing session per confirmation), `apps/web/src/lib/derive.ts` (the exported phrase gives the same address in MetaMask or Rabby), `apps/web/scripts/check-deps.mjs` (the build fails if another wallet SDK appears).
- UX: start with Face ID, the account is shown as a handle (`calm-otter-47`), a test-money button funds it, a bet is one tap on Up or Down plus one passkey confirmation (approval and order share the prompt), winnings are collected in one tap, and the recovery phrase can be exported after a passkey prompt.
- Proof: the Playwright e2e uses Chromium's virtual authenticator with PRF, so the real Mera flow runs end to end with no test-only account (`apps/web/e2e`, `docs/phases/PHASE-7-report.md`).
- Gap: not tested on a real phone in this repo; the public deployment needs HTTPS and the owner's decision to redeploy.

## Chainlink: Best workflow with CRE

**What:** a CRE workflow is the orchestration layer: on a cron it reads the factory through a lens contract, plans create, open and resolve actions, fetches Data Streams evidence and writes one report to `SchedulerReceiver` through the Keystone forwarder. A TypeScript fallback keeper does the same job if the DON is down.

- Code: `services/scheduler/cre/scheduler/main.ts` (builds to WASM with the official CLI in `check-2`), shared planner `packages/sdk/src/planner.ts`, receiver `contracts/src/SchedulerReceiver.sol`, fallback `services/scheduler/fallback`.
- Testnet simulation is prepared: `scripts/cre/simulate-testnet.sh`, config `services/scheduler/cre/scheduler/config.testnet.json` (real testnet factory, receiver, lens), a Data Streams stand-in `services/keeper/scripts/cre-streams-shim.ts` (signed by the test signer the mock verifier trusts).
- Status: **blocked on a CRE login**: `cre workflow simulate` refuses without `cre login` or `CRE_API_KEY`. Until then the evidence is the WASM build, the integration test through the real receiver with a forwarder stand-in, and a 3 h soak (`docs/evidence/phase-2/`). The testnet currently runs the TypeScript scheduler (`services/keeper/scripts/testnet-scheduler.ts`).

## Track 01 Onchain Finance and Grand Champion

The vault (ERC-7540-style epochs, two-sided NAV, loss ceilings, keeper limited to bounded actions), the forward-priced venue, the hardening in Phase 9 (internal audit, timelock, runbook) and the measured Monad cost of re-quoting are in `docs/phases/` and `docs/security/`. Mainnet launch is blocked on the owner (Safe, funds, audit decision), not on code.
