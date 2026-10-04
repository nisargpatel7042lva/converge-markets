# Scheduler runbook

The scheduler keeps markets created 3 rounds ahead, opens them at start and resolves them at expiry. It never chooses outcomes: it only relays oracle evidence that each market's resolver verifies onchain.

## Components

| Component | Where | Role |
|---|---|---|
| **CRE workflow** | `services/scheduler/cre/scheduler` | Primary orchestrator. Runs at second :05 and :35 of every minute (the CRE cron minimum is 30 s; the 5 s offset lands just after each boundary). Reads state with 2 EVM reads (leader + `SchedulerLens`; the CRE quota is 15) and delivers one DON-signed report per run (settlement first, ≤ 4 creates, 9M gas) to `SchedulerReceiver` through the Chainlink KeystoneForwarder. |
| **Fallback service** | `services/scheduler/fallback` | The same planner in a long-lived Node process (Docker). It sends transactions from an EOA that holds `CREATOR_ROLE`. |
| **`SchedulerReceiver`** | `contracts/src/scheduler/SchedulerReceiver.sol` | Onchain end of the CRE path. Holds `CREATOR_ROLE` and the **leader flag** (`leader()`: 0 = CRE, 1 = FALLBACK). It skips (never reverts) trailing actions when gas runs low (`ActionsSkipped`); they are retried on the next run. |
| **`SchedulerLens`** | `contracts/src/scheduler/SchedulerLens.sol` | View-only. Returns every actionable slot, including MON round proofs, in one `eth_call`. Used by both schedulers. |

The leader flag decides which scheduler acts:

- The receiver ignores CRE reports while FALLBACK leads (it emits `ReportIgnored`).
- The fallback stays passive while CRE leads, and only alerts when actions are late.

`open`, `resolve` and `invalidate` are permissionless and idempotent, so if both schedulers ever act at once the result is wasted gas, never a wrong state.

## Health signals

- **Fallback `/health`** (`HEALTH_HOST:HEALTH_PORT`, loopback by default because it is unauthenticated) returns 200 only if:
  - the last tick succeeded within 3 loop intervals; and
  - fewer than `UNHEALTHY_AFTER_BAD_TICKS` (3) consecutive ticks had failed or pending actions, or late items while passive (i.e. CRE late).

  Otherwise it returns 503. The Docker `HEALTHCHECK` uses it. The JSON body includes `leader`, `lateCount`, `consecutiveBad` and `lastError` (redacted).
- **Fallback logs** are pino JSON:
  - `event: "tick"` once per loop, with planned, waiting, late and missed counts;
  - `event: "action"` for each action, with `status`, `delaySeconds` and `tx`.
- **Alerts** (Discord or Telegram webhook, deduplicated per item for 15 minutes) fire on:
  - a late open, resolve or invalidate (more than `lateAfterSeconds` = 60 s past due);
  - a create less than one round before start;
  - a Data Streams proposal still finalizing 6 minutes after the boundary;
  - a round that started without a market;
  - a failed tick;
  - **any failed action, or a tx without a receipt within 60 s** (`pending`; it is never re-sent blindly).
- **Onchain:** `SchedulerReceiver` emits `ReportProcessed(scheduledTime, actions, failed)` and `ActionExecuted(kind, asset, duration, start, ok, errorSelector)`; markets emit `Opened`, `Resolved` and `Invalidated`; resolvers emit `BoundaryProven`, `BoundaryUnresolvable` and `BoundarySettled`.

## Start and stop

### Fallback (Docker)

```bash
cp services/scheduler/fallback/.env.example services/scheduler/fallback/.env   # fill it; never commit
docker compose -f services/scheduler/fallback/docker-compose.yml up -d --build
docker compose -f services/scheduler/fallback/docker-compose.yml logs -f --tail 100
docker compose -f services/scheduler/fallback/docker-compose.yml down
```

- Required env: `RPC_URL`, `FACTORY`, `LENS`, `RECEIVER` (startup fails without it unless `STANDALONE=true`, which is for local tests only) and `SCHEDULER_PRIVATE_KEY`. Set `EPOCH` to the go-live unix time, so rounds from before go-live aren't reported as missed.
- Secrets in `.env`: the scheduler key, the Data Streams API key and secret (`STREAMS_SOURCE=rest`), and the alert webhook URL (it embeds a token). The repo `.dockerignore` keeps `.env` out of images.
- **WSL:** if `docker compose build` fails with `docker-credential-desktop.exe: not found`, run it with `DOCKER_CONFIG` pointing at a directory containing `{}` as `config.json`. That skips the Windows credential helper for public image pulls.

### CRE workflow

```bash
cd services/scheduler/cre
cre login                      # or export CRE_API_KEY=...
cre workflow simulate scheduler -T staging-settings --non-interactive --trigger-index 0   # dry run
cre workflow deploy scheduler -T production-settings
cre workflow pause scheduler -T production-settings     # stop
cre workflow activate scheduler -T production-settings  # resume
```

After the first deploy, register the workflow on the receiver (admin / Safe):

```solidity
SchedulerReceiver.setWorkflow(workflowOwner, workflowId);
```

## Leader switch

Requires `OPERATOR_ROLE` on `SchedulerReceiver`.

```bash
# CRE -> FALLBACK (CRE down, unfunded, or misbehaving)
cast send $RECEIVER "setLeader(uint8)" 1 --rpc-url $RPC_URL --private-key <operator key>
# FALLBACK -> CRE
cast send $RECEIVER "setLeader(uint8)" 0 --rpc-url $RPC_URL --private-key <operator key>
cast call $RECEIVER "leader()(uint8)" --rpc-url $RPC_URL   # verify
```

Both schedulers read the flag on every run, so the switch takes effect on the fallback's next tick (≤ 10 s) and CRE's next run (≤ 30 s).

To switch to the fallback:

1. Start the fallback container *before* flipping the flag.
2. Confirm `/health` is 200.
3. Flip the flag.
4. Watch for `acting: true` in the tick logs.

To switch back to CRE, flip the flag, then confirm `ReportProcessed` events resume.

## Stuck market

**Symptom:** a late alert repeats for one market, or a market stays CREATED/OPEN past its boundary.

1. **Find the market and what it waits on:**

   ```bash
   cast call $FACTORY "getMarket(bytes32,uint64,uint64)(address)" $ASSET_ID $DURATION $START --rpc-url $RPC_URL
   cast call $MARKET "state()(uint8)" --rpc-url $RPC_URL   # 0 CREATED, 1 OPEN, 2 UP, 3 DOWN, 4 INVALID
   cast call $RESOLVER "priceAt(bytes32,uint64)(uint8,int256)" $ASSET_ID $BOUNDARY --rpc-url $RPC_URL   # 0 PENDING, 1 FINAL, 2 UNRESOLVABLE
   ```

2. **If FINAL or UNRESOLVABLE:** anyone can push it through. This needs no role:

   ```bash
   cast send $MARKET "open(bytes)" 0x --rpc-url $RPC_URL --private-key <any funded key>
   cast send $MARKET "resolve(bytes)" 0x --rpc-url $RPC_URL --private-key <any funded key>
   cast send $MARKET "invalidate()" --rpc-url $RPC_URL --private-key <any funded key>
   ```

3. **If PENDING with a round-proof resolver (MON):** the fallback logs the finder result in the `reason` field:
   - `not-yet`: the feed hasn't updated since T. Wait; after `maxOracleDelay` the boundary becomes UNRESOLVABLE and the market can be invalidated.
   - `first-of-phase`: an aggregator migration happened at the boundary. It voids after `livenessGrace` (1 day), or earlier if the feed is stale.
   - `missing-round`: the feed is broken. Escalate to Chainlink, and the market voids after `livenessGrace`.
4. **If PENDING with Data Streams (BTC/ETH):**
   - Check Data Streams API access and credentials (secrets in the CRE Vault, or env for the fallback).
   - A proposal finalizes `finalizationWindow` after it is first made.
   - With no proposal by T + grace (30 min), the boundary becomes UNRESOLVABLE and both rounds touching it void (ADR-002).
5. Nothing in this runbook can set a price. If a market is "wrong", that is an oracle incident (next section), not a scheduler fix.

## Oracle outage

- **Chainlink push feed stale or down (MON):**
  - Proofs return `not-yet`, then the boundary goes UNRESOLVABLE (no round within `maxOracleDelay` = 120 s).
  - The scheduler invalidates the affected markets (each UP/DOWN token redeems for 0.5).
  - **Pause new creation** if the outage persists, so new markets aren't created only to be voided. The guardian runs this:

    ```bash
    cast send $FACTORY "pause()" --rpc-url $RPC_URL --private-key <guardian>
    ```

  - Pause never blocks merge, redeem or settlement. Unpause (admin) when the feed recovers.
- **Data Streams outage (BTC/ETH):**
  - REST returns errors, or 404 for the boundary timestamp. Both schedulers retry every loop.
  - If no report lands by T + 30 min, the rounds void.
  - As with push feeds, pause creation for a prolonged outage.
- **Verifier changes** (Chainlink enables an onchain fee manager): `submit` starts reverting. The owner sets `DataStreamsResolver.setParameterPayload(...)` per Chainlink's fee docs, and submitters attach the fee (see `docs/security/phase-1-notes.md`).
- **RPC outage:** both schedulers retry with backoff (the fallback uses `MAX_RETRIES` per call), and `/health` turns 503. Point `RPC_URL` at another provider from `docs/EXTERNAL.md` and restart.
- **After any outage:** check for "round started without a market" alerts. Those rounds can't be recovered, but the scheduler resumes creating rounds 3 ahead.

## Keys and roles

| Key / role | Holder | Notes |
|---|---|---|
| `MarketFactory` `CREATOR_ROLE` | `SchedulerReceiver` (CRE path) and the fallback EOA | Revoke the fallback EOA if it is compromised; it can only create markets, never settle them wrongly. |
| `SchedulerReceiver` `OPERATOR_ROLE` | Ops | Leader switch only. |
| `SchedulerReceiver` `DEFAULT_ADMIN_ROLE` | Safe | `setWorkflow`, `setMaxReportAge`. |
| Fallback EOA | Ops | Keep it funded with MON for gas. Its key is in the fallback `.env`, alongside the Data Streams credentials and the webhook URL. |
