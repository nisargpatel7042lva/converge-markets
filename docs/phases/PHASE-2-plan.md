# Phase 2 plan: Automated scheduling and settlement

## Orient: inputs and assumptions

- **Phase 1 interfaces.** Settlement uses `Market.open(bytes)` / `resolve(bytes)` / `invalidate()`. Evidence is either an abi-encoded `roundId` (ChainlinkRoundResolver) or a Data Streams `fullReport` (DataStreamsResolver). `createMarket` requires CREATOR_ROLE. Everything else is permissionless, and the resolvers verify all evidence. That satisfies spec item 5: the scheduler cannot change outcomes.
- **CRE writes through `KeystoneForwarder → IReceiver.onReport`** (docs: "Building Consumer Contracts"). It never sends EOA transactions. So Phase 2 adds one contract:
  - `SchedulerReceiver` holds CREATOR_ROLE, checks the forwarder plus the workflow owner/ID, rejects stale reports, and executes a batch of idempotent actions.
  - Each action is try/caught and emits an event.
  - It also stores the **leader flag** (CRE | FALLBACK) onchain, as the single source of truth both schedulers read.
- **Series (ADR-001/002):** BTC, ETH and MON × {15m, 1h}, 3 rounds ahead.
  - BTC/ETH resolve via Data Streams; MON via round proofs (ADR-002 fallback).
  - **Kuru venue setup is not done in Phase 2.** ADR-001's Kuru leg is pending mainnet creation rights, and the venue adapter is Phase 4. `config/series.json` carries `kuru.enabled=false`, with the hook documented.
- **Timing:** CRE's cron minimum is 30 s, so the workflow runs every 30 s. The ≤ 60 s resolve target needs the evidence to exist by then. Data Streams reports exist within about 1–2 s of T. For push feeds it depends on the feed cadence (MON about 30 s).
- **CRE access:** simulation needs `cre login` (a CRE account). If none is available, simulation and deployment are BLOCKED. The workflow is still built and compiled, and its planning logic is unit-tested.
- **Data Streams access:** none, so the real REST fetcher is implemented per the docs (HMAC auth, `/api/v1/reports?feedID&timestamp`) but cannot be run. Local and testnet runs use the labelled test-signer provider.
- **Testnet MON:** 0, so the testnet soak is BLOCKED. Per the prompt's fallback, there will be a ≥ 2 h real-time soak on a local chain with **clearly labelled mock feeds mirroring mainnet Chainlink prices**, plus a **mainnet-fork dry run** that proves real-feed round finding.

## Tasks → acceptance criteria

| # | Task | AC |
|---|---|---|
| 1 | `config/series.json` + zod schema | 1 |
| 2 | `SchedulerReceiver.sol` (IReceiver + ERC165, forwarder/workflow checks, staleness, leader flag, batch actions) + Foundry tests | 1, 6 |
| 3 | `packages/sdk`: ABIs generated from Foundry `out/`, boundary math, round finder (phases, gaps), planner (pure: state snapshot → actions), evidence providers (round proof, Data Streams REST, test signer) | 1 |
| 4 | Unit tests: boundaries (UTC, month/year/leap edges), round finding (gaps, phase changes), planner idempotency | 1 |
| 5 | `services/scheduler/fallback`: long-lived executor (viem), /health, pino logs, retry with backoff, webhook alerts, leader logic, Dockerfile + compose | 1, 3, 5 |
| 6 | `services/scheduler/cre`: CRE TS workflow (cron 30 s → read state → plan → evidence → `writeReport`), project.yaml, workflow.yaml, configs | 4 |
| 7 | Integration: anvil + mock aggregators + test signer, 6 h simulated, 0 missed create/open/resolve | 1, 2 |
| 8 | Soak ≥ 2 h (local real-time chain, labelled mainnet-mirrored mock feeds) + mainnet-fork dry run; max resolve delay | 3 |
| 9 | CRE simulate (or a precise blocker) → `docs/evidence/phase-2/cre-simulation.md` | 4 |
| 10 | `docs/ops/scheduler-runbook.md` | 5 |
| 11 | `make check-2`, evaluation loop, hostile review, report | 1–6 |
