# Phase 2 report: Automated market scheduling and settlement

## Status: COMPLETE WITH CAVEATS

Markets for every configured series are created ahead, opened and resolved with no human involvement, by a CRE workflow (primary) or an identical TS fallback (Docker), selected by an onchain leader flag. The scheduler cannot change outcomes: it only relays evidence that each market's resolver verifies.

Caveats, all external access blockers:

- **Testnet soak BLOCKED** (0 testnet MON). A labelled local soak and a mainnet-fork dry run substitute for it, as the prompt allows.
- **CRE simulation and deploy BLOCKED** (no CRE account). The workflow builds to WASM with the official CLI and its logic runs end to end against the real receiver through a forwarder stand-in.
- **No live Data Streams** (no API key or feed IDs). BTC/ETH evidence is exercised only with the test signer.

## What was built

**Contracts** (`contracts/src/scheduler/`)

- `SchedulerReceiver.sol`, the CRE consumer:
  - `IReceiver` + ERC165;
  - forwarder and workflow-owner/ID checks (accepts 64-byte production metadata);
  - chain, staleness and future-skew replay guards;
  - an onchain **leader flag**;
  - a batch of idempotent actions (create, open, resolve, invalidate). Each action is try/caught; a gas reserve skips trailing actions instead of reverting.
- `SchedulerLens.sol`: a view contract returning every actionable slot, including the round-proof first-round search, in **one `eth_call`**.
- `script/Deploy.s.sol` now also deploys the receiver and lens (with the CREATOR grant).

**SDK** (`packages/sdk`)

- ABIs generated from Foundry (`scripts/gen-abi.mjs`, freshness-checked).
- UTC boundary math.
- A runtime-agnostic read layer: generators driven by a viem async driver or a CRE sync driver.
- The phase-aware first-round finder.
- The lens snapshot and the planner (pure, idempotent; settlement-first `prioritize`).
- Receiver report encoding.
- Evidence sources:
  - round proof;
  - a Data Streams REST client (HMAC auth per Chainlink docs; untested live);
  - a TEST signer.
- `config/series.json` schema: per-asset durations and lateness, create cap.

**Fallback** (`services/scheduler/fallback`)

- A long-lived executor with:
  - leader handling;
  - nonce manager, single broadcast, bounded receipt wait;
  - retries with backoff for reads;
  - pino JSON logs, a redacted-error `/health` endpoint (loopback, 503 on repeated failures);
  - Discord/Telegram alerts.
- `Dockerfile` (non-root, HEALTHCHECK), `docker-compose.yml`, root `.dockerignore`.
- Soak tooling (`src/soak/*`) and the mainnet-fork dry run.

**CRE** (`services/scheduler/cre`)

- `project.yaml`, `secrets.yaml`, `workflow.yaml`, staging and production configs.
- `scheduler/main.ts`:
  - cron `5,35 * * * * *`;
  - 2 EVM reads per run (quota 15);
  - Data Streams via HTTP capability with identical-consensus;
  - `writeReport` with a 9M gas limit, checking `receiverContractExecutionStatus`.

**Ops and evidence**

- `docs/ops/scheduler-runbook.md`.
- `docs/evidence/phase-2/*`.
- EXTERNAL.md Phase 2 rows, including the complete CRE quota table.

## How to verify it yourself

```bash
cd ~/converge
make check-2     # check-all + ABI freshness + 4 anvil integration suites + CRE build; ends "check-2 OK"
cd services/scheduler/fallback
npx vitest run test/integration/sixHours.test.ts   # writes docs/evidence/phase-2/anvil-6h-simulation.md
```

To repeat the local soak (about 2 h), run these from `services/scheduler/fallback`:

```bash
anvil --port 8547 --block-time 1 &
npx tsx src/soak/up.ts
npx tsx src/soak/mon-mirror.ts &
SCHEDULER_ENV_FILE=../../../.soak/scheduler.env docker compose -f docker-compose.yml up -d --build
# after >= 2 h
npx tsx src/soak/report.ts
```

Needs anvil, Docker, Bun and the CRE CLI (`~/.cre/bin`). On WSL, `DOCKER_CONFIG` must point at a `{}` config for public pulls (see the runbook).

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-2` passes (unit + integration) | PASS | `docs/evidence/phase-2/check-2.txt` |
| 2 | Anvil 6 h simulation: 0 missed create/open/resolve | PASS. 56/56 created ahead (≥ 794 s), opened and resolved; 0 late, missed or failed. MON feed jittered 20–90 s. Max resolve: Data Streams 32 s, round proof 61 s | `anvil-6h-simulation.md` |
| 3 | Testnet soak ≥ 2 h, 0 missed, max resolve ≤ 60 s | **BLOCKED on testnet MON.** Substitute: local real-time soak with labelled mainnet-mirrored feeds, fallback in Docker. **Continuous 3.0 h: 26/26, 0 missed, max resolve 43 s, p95 38 s.** A 2 h 23 m host freeze afterwards is analysed separately (0 stuck markets). Mainnet-fork dry run with real Chainlink data: the SDK's proofs were accepted by the resolver at all 72 boundaries | `soak-local.md`, `soak-logs/`, `mainnet-fork-dry-run.md` |
| 4 | CRE workflow runs in simulation end to end; deployment status documented | **BLOCKED (no CRE account).** The build to WASM passes in `check-2`. Shared logic runs end to end through `SchedulerReceiver` with a forwarder stand-in on the real cron schedule and gas limit: 12/12 resolved, ≤ 2 EVM reads per run, max resolve 38 s, 0 failed or skipped | `cre-simulation.md`, `cre-path-integration.md` |
| 5 | Runbook: start/stop, leader switch, stuck market, oracle outage | PASS | `docs/ops/scheduler-runbook.md` |
| 6 | No open CRITICAL/HIGH in hostile review | _see below_ | `docs/evidence/phase-2/hostile-review.md` |

## Test summary

- **Solidity:** 157 tests (unit, fuzz, invariants), all passing. SchedulerReceiver has 17 tests; SchedulerLens has 5, including a 256-run fuzz checking that every lens proof is the unique one the resolver accepts. `forge lint --deny warnings` is clean. Slither reports 0 HIGH/MEDIUM unsuppressed.
- **TypeScript:**
  - SDK: 26 unit tests (boundaries and month/leap/DST edges, round finding with gaps and phases through both drivers, planner idempotency, prioritize, HMAC vs node:crypto, test signer, report encoding).
  - Fallback: 7 unit tests.
- **Integration (anvil):**
  - 6 h simulation;
  - CRE path with read counting and lens-vs-multicall cross-checks (240 checks);
  - leader switch;
  - outage recovery (3 h outage, longer than the 2 h lookback).

## Hostile review findings

Full log: `docs/evidence/phase-2/hostile-review.md`.

**Iteration 1** found 3 HIGH, 8 MEDIUM, 9 LOW. All three HIGHs were on the CRE path, and the workflow would have failed in production:

- **H1:** about 100 EVM reads per run against a 15-read quota. Fixed with `SchedulerLens` (2 reads).
- **H2:** a 12-create batch exceeded the 5M gas limit. Fixed with settlement first, ≤ 4 creates, a gas-reserve skip, and a 9M limit.
- **H3:** the cron ran at the boundary, so the ≤ 60 s target was impossible. Fixed with `:05/:35`, a 20 s window and per-action fault isolation.

The MEDIUMs and LOWs are fixed except L2 (one boundary's evidence is verified twice; gas only) and L7 (CRE reads don't pin a block).

**Iteration 2:** _pending_.

## Deviations from the spec, and ADRs

1. **`open(roundId)` / `resolve(roundId)` → `open(bytes)` / `resolve(bytes)`** (Phase 1). The scheduler submits round IDs (MON) or Data Streams reports (BTC/ETH), per ADR-002.
2. **New contracts.** CRE writes only through `KeystoneForwarder → IReceiver`, so a `SchedulerReceiver` was needed. CRE's 15-read quota forced a `SchedulerLens`.
3. **MON is 1h only** (per-asset durations), as ADR-002 requires while MON resolves via push-feed round proofs.
4. **SLA wording.** ≤ 60 s is met for Data Streams assets (measured 32–43 s). For round-proof assets (MON), resolution is bounded by the feed's first update after T (gaps up to about 90 s on mainnet; void after `maxOracleDelay` = 120 s), so MON lateness alerts use 150 s. Max MON resolve measured: 61 s (simulation), 43 s (soak).
5. **ADR-002 change:** the finalization window is set to **20 s** (it was "about 2 minutes"). Under the containment rule the window is defense in depth only.
6. **No Kuru venue setup** (`kuru.enabled=false`). ADR-001's Kuru leg is pending mainnet creation rights, and the venue adapter is Phase 4.
7. **Soak substitute:** a local chain with mock feeds instead of testnet, as the prompt's fallback allows.

## Known issues and risks

- **CRE never executed on the real platform.** DON consensus behaviour (e.g. a split 404/200 on Data Streams at T+5) is handled by retrying next run, which could push a Data Streams resolve to about T+65 s in that case. This is unmeasured.
- **Monad gas schedule.** The receiver's 750k per-action gas reserve was sized on the EVM schedule. Monad's repriced cold access could make a create cost more; the gas-reserve skip degrades gracefully, but needs measuring on testnet.
- **Data Streams REST client** is implemented from the docs and tested against node:crypto, but has never hit the real API. Feed IDs are zero (blocked).
- **Advisory view race** (seen in the soak): `priceAt`'s derived UNRESOLVABLE can flip back to PENDING when a late round arrives. It is benign and self-heals, and is now classified `waiting`.
- **Host suspend** stops the fallback entirely. Production needs an always-on host, plus the CRE leader. The passive side alerts on lateness, but the fallback and CRE are on different infrastructure only once CRE is deployed.
- **No external audit** of `SchedulerReceiver` or `SchedulerLens`.

## Needs from Nisarg

1. **Testnet MON** (about 2 MON to `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1`) for the testnet lifecycle, the real-gas measurement and the testnet soak.
2. **A CRE account** (`cre login` / `CRE_API_KEY`) to simulate and deploy, plus a funded `CRE_ETH_PRIVATE_KEY`.
3. **Chainlink Data Streams access:** API key and secret, and the BTC/ETH (and ideally MON) feed IDs.
4. **Alert channel:** a Discord or Telegram webhook URL for the fallback.
5. **A GitHub remote.**
6. Still open: Kuru mainnet creation rights; the product-claim amendment from Phase 0.

## Readiness for the next phase

**Yes for Phase 3** (strategy library and backtest). It is independent of the scheduler. The scheduler's interfaces (series config, lens snapshot) are stable for the vault and keeper phases.
