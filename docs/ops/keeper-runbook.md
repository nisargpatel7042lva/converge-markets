# Keeper runbook

The keeper (`services/keeper`) runs the vault's market making: it keeps every eligible market
tradable, executes taker orders within a block or two of their pricing second, refreshes sigma and
the vault's valuation, settles epochs, resolves ended rounds and redeems them, and pulls every
quote the moment its checks fail. Design: `docs/adr/ADR-006-keeper.md` (and ADR-004/005 for the
venue and vault it drives). Threat model: `docs/security/threat-model.md`.

## What it is allowed to do

The keeper holds one key, the vault's `KEEPER` role. On chain that role can only call
`setSigma` (inside the owner's band, ±20 % per step, at most every 30 s), `splitForInventory`,
`mergeInventory`, `haltQuoting` and `unhaltQuoting`. The vault re-checks loss ceilings, price
bounds and liquidity on every fill, so a buggy or compromised keeper cannot take funds: the worst
it can do is stop quoting (the owner rotates the key). Everything else it sends (`executeOrder`,
`expireOrder`, `settleEpoch`, `resolve`, `redeemResolved`, `checkpoint`) is permissionless.

## Modes

| `MODE`    | Sends transactions | What it does                                                                                         |
| --------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `live`    | yes                | Everything.                                                                                          |
| `dry-run` | no                 | Reads the chain and the prices, logs `would …` for every action, tracks a local halt flag.            |
| `paper`   | no                 | As dry-run, and simulates every due order against the live book (counts fills and premium, `/status`). |

Start a new deployment in `dry-run`, then `paper`, then `live`.

## Configuration

Environment (`services/keeper/.env.example` lists all of it; the file is never committed):

| Variable                       | Meaning                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `RPC_URLS`                     | Comma separated HTTP endpoints (first is primary, the rest fail over). Required.         |
| `WS_URL`                       | WebSocket endpoint for new heads. Without it (or when it goes silent) the keeper polls.  |
| `VAULT`, `VENUE`               | Addresses from `deployments/<network>.json`.                                              |
| `KEEPER_PRIVATE_KEY`           | The vault's keeper key. Never logged.                                                    |
| `MODE`                         | `live`, `dry-run` (default) or `paper`.                                                   |
| `STREAMS_SOURCE`               | `data-streams` (needs the API credentials) or `test-signer` (testnet only, see below).   |
| `KILL_TOKEN`                   | Bearer token (≥16 chars) for `POST /kill` and `/unkill`. Unset: the endpoints are off.   |
| `KILL`, `KILL_FILE`            | Start killed / a file whose existence keeps the keeper killed.                           |
| `ALERT_KIND`, `ALERT_WEBHOOK_URL`, `TELEGRAM_CHAT_ID` | `discord` or `telegram` alerts (5 min de-duplication per key).        |
| `MAX_RPS`                      | Cap on JSON-RPC calls per second (default 10; the Monad public endpoints answer 429 above 15 **per IP**, so nothing else may share the address). |
| `MAX_FEE_GWEI`, `GAS_MULTIPLIER_PCT` | Fee ceiling for ordinary transactions (a halt may pay 3× it) and the gas-limit margin (Monad bills the limit, so keep it near 115). |
| `SANITY_RPC_URL`               | Optional mainnet RPC for the Chainlink sanity check of the reference price.               |

Thresholds live in `config/keeper.<network>.json` (the schema and defaults are in
`services/keeper/src/config.ts`): price staleness (per source), divergence, shock, inventory caps,
halt hysteresis, sigma/checkpoint cadences, transaction replacement.

### Test-only price reports

Monad testnet has no Data Streams verifier. The testnet deployment uses
`MockStreamsVerifierProxy`, and with `STREAMS_SOURCE=test-signer` the keeper signs the reports
itself (`STREAMS_TEST_SIGNER_KEY`) from its own reference price at the requested second. Every
artifact produced this way is labelled TEST-ONLY. On mainnet use `data-streams`; the keeper then
needs `DATA_STREAMS_API_URL/KEY/SECRET`.

## Run it

Docker (keeper + Prometheus + Grafana):

```bash
cp services/keeper/.env.example services/keeper/.env      # fill it
printf '%s' "$(openssl rand -hex 16)" > ops/grafana/admin_password
docker compose up -d --build
```

Grafana is on `127.0.0.1:3000` (user `admin`, the dashboard "Converge keeper" is provisioned),
Prometheus on `127.0.0.1:9090`, the keeper on `127.0.0.1:9100`. Ports can be moved with
`KEEPER_PORT`, `PROMETHEUS_PORT`, `GRAFANA_PORT`. Without Docker:

```bash
pnpm install --frozen-lockfile
cd services/keeper && MODE=dry-run node_modules/.bin/tsx src/main.ts
```

## Endpoints (`HTTP_HOST:HTTP_PORT`, default 127.0.0.1:9100)

| Endpoint        | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `GET /health`   | Liveness: 200 while the loop ticks (503 after 5 missed ticks).                                |
| `GET /ready`    | 200 when the keeper can quote now; otherwise 503 with the reasons (`halted`, `price-unhealthy`, `rpc-errors`, `no-state`, `killed`, `vault-paused`). |
| `GET /status`   | JSON: mode, block, prices and sources, risk state, inventory, pending orders, paper counters. |
| `GET /metrics`  | Prometheus.                                                                                   |
| `POST /kill`, `POST /unkill` | Kill switch (`Authorization: Bearer $KILL_TOKEN`).                             |

## Kill switch

Any one of three is enough, clearing one does not clear the others:

```bash
curl -X POST -H "Authorization: Bearer $KILL_TOKEN" http://127.0.0.1:9100/kill     # HTTP
touch "$KILL_FILE"                                                                  # file (default /tmp/converge-keeper.kill; in Docker /var/lib/converge-keeper/KILL)
KILL=true                                                                           # env, at start
```

A killed keeper pulls every quote (`haltQuoting`) and stays halted until all three are clear.
It still answers `/health` and `/metrics`. To stop everything at the vault level (not just the
keeper), the guardian calls `pauseQuoting` on the vault; only the owner can resume that.

## What pulls the quotes

The keeper sends `haltQuoting` (one transaction, priority fee boosted, no simulation delay) within
a block or two when any of these holds, then keeps checking:

| Reason                          | Trigger (defaults)                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `FEW_SOURCES` / `PRICE_UNHEALTHY` / `NO_PRICE` | fewer than 2 fresh sources (Binance 3 s, Coinbase 12 s) |
| `PRICE_SHOCK`                   | the median moved more than 100 bps inside 5 s (held 10 s)                               |
| `SOURCE_DIVERGENCE`             | a source is more than 60 bps from the median                                            |
| `CHAINLINK_MISMATCH`            | the median is more than 200 bps from the onchain Chainlink feed (when configured)        |
| `RPC_ERRORS`, `BLOCK_LAG`       | 5 consecutive RPC failures; no new block for 5 s                                        |
| `INVENTORY_LOSS`, `INVENTORY_EXCESS` | a market's worst-case loss reaches 90 % of its ceiling (or the next fill would); excess tokens exceed 25 % of the NAV |
| `KILL_SWITCH`                   | any kill switch                                                                         |

It calls `unhaltQuoting` only after the checks have been clean for 15 s (inventory must be back
under 75 % of the ceiling). Each flap doubles the wait, up to 5 minutes, and a long calm resets it.
A halt that could not be sent (RPC down) stays wanted and is retried until it goes through. The
keeper never touches `quotingPaused` (guardian, owner, or the 5 %/day breaker): that is not its to
clear.

## Alerts

Sent to the Discord or Telegram webhook, de-duplicated per key for 5 minutes: `halt:<reason>`,
`halt-failed`, `unhalt`, `drawdown` (lower share price beyond `risk.drawdownAlert`, 2 %, under its
peak), `violation:<kind>` (a crossed, off-grid or out-of-bounds ladder), `low-balance`,
`fee-cap` / `tx-timeout` (a transaction was not sent or not mined), `no-epoch-price:<id>` (an
epoch will expire for lack of a price). Prometheus rules (`ops/prometheus/alerts.yml`) cover keeper down, halted > 2 min,
loop stalled, p95 quote age > 2 blocks, any quote violation, low wallet.

## Metrics worth watching

`keeper_halted`, `keeper_quote_age_blocks` (p95 ≤ 2),
`keeper_halt_latency_blocks`, `keeper_tx_inclusion_ms`, `keeper_fills_total{outcome}`,
`keeper_inventory_tokens`, `keeper_market_loss_ratio` / `keeper_total_loss_ratio`,
`keeper_pnl_realized_usd` / `keeper_pnl_unrealized_usd`, `keeper_rpc_requests_total{method}`,
`keeper_wallet_balance_mon`, `keeper_errors_total{kind}`, `keeper_quote_violations_total` (must stay 0).

## Cost

Monad bills the gas **limit**. The keeper estimates and adds 15 %. The cost ledger
(`$OUT_DIR/costs.jsonl`, one line per transaction) and `docs/evidence/phase-5/costs.md` give the
cost per re-quote and per day.

## Failure playbook

| Symptom                                          | Check / action                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `/ready` 503 `halted`                            | `/status` → `risk.reasons`. The keeper resumes by itself after the hysteresis. If the reason is `KILL_SWITCH`, clear it. |
| Repeated `RPC_ERRORS` and "requests limited to 15/sec" | Something else shares the IP, or `MAX_RPS` is too high. Use a dedicated endpoint; add a second URL to `RPC_URLS`. |
| `FEW_SOURCES` for long                           | An exchange stream is down or blocked from the host; `keeper_source_age_ms`. The keeper stays halted (by design). |
| `haltQuoting failed` alert                       | The key has no MON or the RPC refused. Fund the keeper; if it cannot be fixed fast, the guardian pauses the vault. |
| Wallet below 0.5 MON                             | Top up `keeper` address. Each executed order costs about 0.06 MON at 100 gwei.                         |
| Keeper key suspected compromised                 | Guardian `pauseQuoting`, owner `setKeeper(new)`, then restart with the new key. |
| Process crashed                                  | `restart: unless-stopped` brings it back; it rebuilds its state from the chain (orders by id, nonce from the pending count) and halts first if the checks fail. |
| Stuck transaction                                | Automatic: same nonce, fee bumped 25 %, up to 3 replacements (`keeper_tx_sent_total{result}`).       |

## Before pointing it at mainnet

Needs from the owner (see `docs/STATUS.md`): Data Streams credentials (replaces the test signer),
the owner as a timelock behind a Safe, keeper key custody, the sigma band, a dedicated RPC, and
the executor reward sized above the gas of an execution (testnet uses 0.001 MON).
