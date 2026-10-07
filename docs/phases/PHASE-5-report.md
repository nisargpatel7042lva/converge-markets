# Phase 5 report: the keeper

**Status: COMPLETE WITH CAVEATS (acceptance criteria 2 and 3 are not met as written).** The keeper is built, tested (106 keeper tests, 3 rounds of hostile review, no open CRITICAL or HIGH finding) and was run against Monad testnet, but the 2 hour live run did not happen (testnet MON ran out after about 30 minutes of running) and the two latency targets (pull-all within 2 blocks, p95 quote age within 2 blocks) are met on anvil and **not** on Monad testnet, where a transaction takes 0.5 to 1.5 s to be included.

## What was built

- **`services/keeper/`** (TypeScript, viem, pino, prom-client, zod), 3,700 lines of source:
  - `src/price/` reference price: median of Binance and Coinbase WebSocket feeds, per-source staleness (Coinbase publishes on trades: measured gaps up to 7.4 s), divergence, shock detector with hold, Chainlink sanity check, history for the price at a past second. Fewer than 2 healthy sources halts.
  - `src/risk.ts` pull-all triggers (price, divergence, shock, Chainlink mismatch, RPC errors, block lag, inventory above 90 % of a ceiling with hysteresis, kill switch) and the `HaltController` (hysteresis, flap guard, warm-up before any unhalt).
  - `src/planner.ts` pure planner: the diff between what the vault should look like and what it is, as prioritised actions (`executeOrder`, `settleEpoch`, `resolve`, `redeemResolved`, `setSigma`, `checkpoint`, `splitForInventory`, `mergeInventory`, `pruneEmpty`, `expireOrder`), each idempotent by key.
  - `src/chain/` block source (WebSocket with HTTP polling fallback), nonce manager, transaction manager (local signing, gas-limit margin, fee caps, stuck-transaction replacement and cancellation, a halt that replaces whatever is stuck at the lowest nonce), RPC client with Multicall3 batching, a 10 calls/s limiter and an urgent lane.
  - `src/keeper.ts` orchestrator: fast path per block and per price tick, slow path every 2 s, live / dry-run / paper modes, projected-fill check before an execution, quote-age and per-stage latency instrumentation, cost ledger.
  - `src/server.ts` `/health` (own heartbeat, not RPC), `/ready`, `/status`, `/metrics`, authenticated `POST /kill` and `/unkill`; `src/killswitch.ts` env, file and HTTP (persisted); `src/alerts.ts` Discord/Telegram webhook; `src/metrics.ts` about 45 Prometheus series.
- **Vault**: `keeperHalt` (`haltQuoting` / `unhaltQuoting`, keeper-only, independent of the guardian pause and the breaker), tests and invariant handlers, ADR-006; **redeployed to Monad testnet** (v3, `deployments/testnet.json`, earlier versions archived).
- **Packaging**: `services/keeper/Dockerfile`, `docker-compose.yml` (keeper, Prometheus, Alertmanager, Grafana with the provisioned dashboard `ops/grafana/dashboards/converge-keeper.json`), `ops/prometheus/{prometheus,alerts}.yml` (14 rules, validated with `promtool`), `ops/alertmanager/alertmanager.yml` (validated with `amtool`), `docs/ops/keeper-runbook.md`.
- **Live-run harness** `scripts/keeper-live/`: a price relay (real Binance/Coinbase data plus injected shocks, stale feeds), a round and taker driver, a metrics collector, `analyze.ts` that produces the evidence tables.
- **Docs**: ADR-006 (with an addendum of what testnet and review changed), threat-model section 6 and rows A10/K1, EXTERNAL.md Phase 5 rows (RPC limit 15 calls/s measured, Multicall3, Binance and Coinbase stream formats, Monad bills the gas limit).

## How to verify it yourself

```bash
export PATH=$HOME/.foundry/bin:$PATH
make check-5                     # check-all, forge build, keeper unit + integration + chaos, files present
pnpm --filter @converge/keeper test            # 91 unit tests
pnpm --filter @converge/keeper test:integration  # 6 (anvil, real contracts)
pnpm --filter @converge/keeper test:chaos        # 9 (RPC kill, stale feed, 2 % jump, divergence, flood, restart/kill, halt retry, wallet reserve, 150 ms RTT)
docker run --rm --entrypoint promtool -v $PWD/ops/prometheus:/p:ro prom/prometheus:v2.55.1 check rules /p/alerts.yml
cat docs/evidence/phase-5/README.md docs/evidence/phase-5/costs.md
```

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-5` passes (unit, integration, chaos) | **PASS** (`make check-5` OK: check-all, 91 unit, 6 integration, 9 chaos) | `docs/evidence/phase-5/check-5.txt` |
| 2 | Testnet run of at least 2 h in live mode: every eligible market quoted, 0 crossed or out-of-bounds quotes, p95 quote age <= 2 blocks, metrics exports in `docs/evidence/phase-5/` | **FAIL / not completed.** About 31 minutes of live running over two runs (28 min + 3 min), then MON ran out. In those: every eligible market was tradable in 94.3 % of the samples (the rest: start-up and one pull-all), 0 violations, 3 orders executed. Quote age was 9, 10 and 6 blocks (n = 3): **not <= 2**, the floor on Monad testnet is about 3 blocks (inclusion about 1.1 s) | `run-a-oldcode/run-summary.md`, `run-b-final-code/keeper.log`, `README.md` |
| 3 | Injected price shock on testnet leads to pull-all within <= 2 blocks, logs with block numbers | **PARTIAL.** Anvil: PASS (chaos tests, within 2 blocks, also with 150 ms RTT added). Testnet: shock 2026-10-06 15:49:38.837 UTC, detected +0.11 s, `haltQuoting` mined at block 68724942, **4 blocks (0.88 s) after detection, 1.0 s from the shock**: not <= 2 | `README.md` table, `run-b-final-code/keeper.log`, `costs.jsonl` |
| 4 | Cost per re-quote and per day recorded in `costs.md` | **PASS** (checkpoint, resolve and redeem per round not measured, stated) | `docs/evidence/phase-5/costs.md` |
| 5 | No unhandled promise rejections or crashes during the run | **PASS for the runs made** (0 in run A and B; the one rejection seen during set-up, an empty block from the WebSocket, was fixed and is in `setup-run/`). Not shown over 2 hours | `run-*/run-summary.md` |
| 6 | Hostile review (SRE + trading-systems) has no open CRITICAL or HIGH | **PASS** after three rounds: round 1 found 0 CRITICAL, 6 HIGH, 15 MEDIUM; round 2 found 3 new HIGH-level items and residuals; round 3 found no new CRITICAL or HIGH. All HIGH fixed with tests | below |

## Test summary

- Keeper: **91 unit** (planner diff, risk triggers, source health, nonce manager, tx manager incl. stuck-nonce wedge, cancellation, halt supersede, kill switch, server, alerts, cost ledger, WebSocket reconnect, block fallback, rate limiter), **6 integration** (anvil with the Phase 4 contracts: quotes track fair value, fills accounted on chain, dry-run and paper send nothing), **9 chaos** (anvil, 0.4 s blocks: RPC endpoint dies and all endpoints die, stale feed, source divergence and Chainlink mismatch, 2 % jump in one tick, flood of fills, HTTP kill across a restart, restart without price does not unhalt, reverting halt backs off, wallet reserve, pull within 2 blocks with 150 ms RTT).
- The rest of the repo: contracts, strategy (102), sdk (29), backtest (45), scheduler (7): unchanged and green under `make check-all`.
- Static analysis: eslint, prettier, tsc strict on every package; `promtool check rules/config`, `amtool check-config`, `docker compose config`.
- No coverage gate for the keeper (the safety-critical modules are covered by the chaos tests; a line-coverage figure was not measured).

## Hostile review

Round 1 (SRE + trading-systems reviewer, subagent): **0 CRITICAL, 6 HIGH**, 15 MEDIUM, LOW list. HIGH, all fixed: (H1) a stuck lower nonce wedged every later transaction including the halt; (H2) the halt path made several RPC calls through a shared rate limiter; (H3) an HTTP kill and the shock history did not survive a restart, and the start-up grace let a restart unhalt before there was any price; (H4) a failing halt was retried on every tick and nothing reserved gas for a halt; (H5) an unhalt in flight blocked a halt; (H6) Prometheus alerts went nowhere and a dead keeper was invisible. MEDIUM fixed: kill blocked exits, `/health` tied to RPC health, quote-age survivorship bias, unbounded metric labels, `fast()` re-entrancy, volatility ignored shocks, alert delivery, clock offset, secrets in error output and a mainnet guard for the test signer. The testnet found one more bug the reviewer could not: the supersede fee set the node's priority-fee oracle, which then made every later fee exceed the cap (found by a chaos test, fixed).

Bugs found by the chaos and integration suites while fixing the above (not by the reviewer), all fixed: a pre-warming step that took and released a nonce raced with real sends and left a hole that wedged four transactions behind it; an order whose simulation or execution reverted was dropped from tracking and stayed open on chain for ever (the flood test); the urgent RPC lane throttled receipt polling when no limit was configured.

Round 2: no CRITICAL; new HIGH-level: unhalt also superseded transactions in flight, a nonce-too-low race in the supersede path, `/unkill` removing an operator's kill file; plus reserve accounting and fee fallbacks. All fixed with tests. Round 3: all items FIXED, no new CRITICAL or HIGH.

**Open (MEDIUM or LOW, accepted):** M6 a quiet Coinbase halves the shock sensitivity of the median (the divergence check still catches it); M7 two keepers with the same key are not prevented (documented in the runbook); M8 the block-socket reopen does not close the old viem client; M11 the projected-fill guard only covers executions this keeper makes (the vault's ceilings are the bound); M13 settlement with the test signer needs the in-memory price history around an epoch end (testnet only); in-flight transactions are not reserved against the wallet floor (a burst can dip into the reserve before the next balance read); a refused receipt read in the supersede check is not caught; if an operator removes the kill file while an HTTP kill is in effect, only memory holds it.

## Deviations from the spec and decisions

- **No per-block cancel/replace of resting orders**: there are none (ADR-004/005). "Quote" is the vault's tradable state; the loop keeps it true and executes due orders. "Cost per re-quote" is the cost of a `setSigma` refresh (0.0054 MON) plus, per trade, an execution (0.068 MON).
- **ADR-006**: the vault's `keeperHalt` flag, so pull-all and automatic recovery work without the owner.
- **Rounds were created, opened and traded by our own driver** (`scripts/keeper-live`), not by the Phase 2 scheduler as the plan said: the driver lets us control the price of the strike and inject faults. The scheduler is unchanged.
- **Quote age** is defined as blocks between the first block at or after an order's pricing second and the block that executed it. Orders the keeper never executed are counted as `expired` (`keeper_orders_total`), not as ages.
- **Multicall3, a 10 calls/s limiter, an urgent lane and local signing**: forced by the measured 15 calls/s per IP limit of the public testnet endpoint.
- The `QuoteAgeHigh` alert is at 8 blocks, not 2: the Monad floor is 4 to 6 and the venue allows 10.

## Known issues and risks (no rounding up)

1. **The 2 hour run is missing.** 31 minutes of live running is not a soak; the tradable coverage of 94.3 % is from run A only, with an earlier version of the keeper.
2. **Latency on Monad is above the targets.** Pull-all takes about 1.0 s from the shock, 4 blocks by head numbering. An order executes 4 to 6 blocks after its second; run A's orders (9 and 10 blocks) were one block from expiring (`maxLateness` 4 s = 10 blocks). The fast path was then reordered and the simulation parallelised (run B's 6 blocks has both); pre-warming of fees and nonce was added after run B and **has not been measured on testnet**. If testnet shows misses, raise `maxLateness` (owner, up to 10) or accept expiry (the taker is refunded).
3. **Economics**: 0.068 MON per executed order against a testnet reward of 0.001 MON. The reward must be sized above the gas on mainnet or only the keeper executes, at a loss on small trades.
4. **A dead keeper does not pull quotes**; they stay live until sigma is stale (15 min) or the guardian pauses. `KeeperDown` pages a human. A dead-man guardian is not built.
5. **Prices are TEST-ONLY** (test signer, keeper's own median). The real Binance-to-Streams lead is unmeasured (needs the Data Streams key).
6. **The public RPC (15 calls/s per IP)** is the keeper's only chain access in these runs; one other process on the same address caused an RPC-error pull-all once (and the keeper recovered by itself).
7. On-chain and TypeScript fair values differed by 0.003 at times (`mirror_mismatch`, 3 samples): they are read at different instants; not investigated further.
8. Two earlier testnet vault deployments are archived in `deployments/testnet.json` (`vault_v1_pre_audit`, `vault_v2_pre_halt`); only v3 has `keeperHalt`.

## Needs from Nisarg

1. **Testnet MON for the 2 hour run**: about 4 MON to the deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` (it ends this phase with 0.28 MON, the keeper with 0.04). I will then run it (`scripts/keeper-live`) and fill criteria 2 and 3 on testnet; say if you want a different order cadence.
2. Chainlink Data Streams API key and secret (replaces the test signer and measures the lead).
3. A dedicated RPC endpoint (or a second one): the public testnet endpoint allows 15 calls/s per IP.
4. Decision: raise the venue's `maxLateness` from 4 s toward 10 s (more room for the 1 s inclusion) or keep 4 s and accept some expiries.
5. Decision: executor reward on mainnet sized above the gas of an execution (about 0.07 MON at 100 gwei), or the keeper stays the only executor.
6. Decision: build the dead-man guardian (a process or Chainlink Automation job that pauses when the keeper's heartbeat stops)?
7. Discord or Telegram webhook for alerts (`ops/alertmanager/webhook_url`, and `ALERT_WEBHOOK_URL` for the in-process alerts).
8. Older items still open: CRE account, Kuru creation rights, Envio token, owner as a timelock behind a Safe, keeper key custody and sigma bands.

## Readiness for the next phase

**Yes for Phase 6 (indexer)**, which does not depend on the missing run and has been started in parallel. **No for a mainnet beta** until the 2 hour run, real Data Streams prices and the dead-man answer exist.
