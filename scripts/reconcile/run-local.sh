#!/usr/bin/env bash
# LOCAL end-to-end indexer run (no HyperSync, no token, no public RPC, not hosted):
#   anvil -> deploy the stack + scripted history -> Envio (RPC data source) + Postgres + Hasura in
#   Docker -> backfill (timed) -> reconcile >= 200 entities -> GraphQL latency -> live lag.
# Evidence is written to docs/evidence/phase-6/. Only processes started here are stopped here
# (PIDs recorded, never killed by name).
#
# Usage: bash scripts/reconcile/run-local.sh [ROUNDS=14] [LIVE_SECONDS=120]
# Needs: foundry (anvil), docker, pnpm, `forge build` already run in contracts/.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
ROUNDS=${ROUNDS:-14}
LIVE_SECONDS=${LIVE_SECONDS:-120}
PORT=${PORT:-8611}
RPC="http://127.0.0.1:${PORT}"
LOCAL="$ROOT/.local-indexer"
EVIDENCE="$ROOT/docs/evidence/phase-6"
export PATH="$HOME/.foundry/bin:$PATH"
mkdir -p "$LOCAL" "$EVIDENCE"
HASURA="http://localhost:8080/v1/graphql"
SECRET="x-hasura-admin-secret=testing"

# Docker: a throwaway config dir when the default credential helper fails (the user's ~/.docker is untouched).
if [ -n "${DOCKER_CONFIG_DIR:-}" ]; then export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"; fi

ANVIL_PID=""
ENVIO_PID=""
cleanup() {
  if [ -n "$ENVIO_PID" ]; then kill "$ENVIO_PID" 2>/dev/null; fi
  (cd "$LOCAL/project" 2>/dev/null && pnpm exec envio stop >/dev/null 2>&1)
  if [ -n "$ANVIL_PID" ]; then kill "$ANVIL_PID" 2>/dev/null; fi
}
trap cleanup EXIT

echo "== 1. anvil on $RPC"
anvil --port "$PORT" --silent --code-size-limit 131072 > "$LOCAL/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" > "$LOCAL/anvil.pid"
for i in $(seq 1 30); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

echo "== 2. deploy + scripted history ($ROUNDS rounds)"
ROUNDS=$ROUNDS LOCAL_RPC=$RPC pnpm --filter @converge/reconcile local:activity || exit 1
LOCAL_RPC=$RPC pnpm --filter @converge/reconcile exec tsx local-stats.ts | tee "$EVIDENCE/local-event-counts.txt"

echo "== 3. local indexer project"
node indexer/scripts/local-project.mjs "$LOCAL/addresses.json" "$RPC" "$LOCAL/project" || exit 1

echo "== 4. envio dev (backfill timing)"
START_MS=$(date +%s%3N)
(cd "$LOCAL/project" && ENVIO_TUI=false LOG_STRATEGY=console-raw pnpm exec envio dev -r > "$LOCAL/envio-dev.log" 2>&1) &
ENVIO_PID=$!
echo "$ENVIO_PID" > "$LOCAL/envio-dev.pid"
READY=""
for i in $(seq 1 600); do
  OUT=$(curl -s -m 2 -X POST "$HASURA" -H 'content-type: application/json' -H "x-hasura-admin-secret: testing" -d '{"query":"{ _meta { isReady progressBlock sourceBlock eventsProcessed } }"}' 2>/dev/null)
  if echo "$OUT" | grep -q '"isReady":true'; then READY="$OUT"; break; fi
  sleep 0.5
done
END_MS=$(date +%s%3N)
if [ -z "$READY" ]; then echo "indexer never became ready"; tail -30 "$LOCAL/envio-dev.log"; exit 1; fi
echo "ready: $READY"
python3 - "$READY" "$START_MS" "$END_MS" "$LOCAL" "$EVIDENCE" <<'PY'
import json, sys, re
ready, s, e, local, ev = sys.argv[1:6]
m = json.loads(ready)["data"]["_meta"][0]
addr = json.load(open(f"{local}/addresses.json"))
log = open(f"{local}/envio-dev.log").read()
def ts(pat):
    r = re.search(r"\[(\d\d):(\d\d):(\d\d\.\d+)\].*?" + pat, log)
    return (int(r.group(1))*3600 + int(r.group(2))*60 + float(r.group(3))) if r else None
t0 = ts("Initializing the indexer storage"); t1 = ts("Ready\\. Fully indexed")
rec = {
  "label": "local",
  "note": "LOCAL: anvil chain 31337, Envio HyperIndex 3.14.0 with an RPC data source (no HyperSync), Postgres + Hasura in Docker, mock prices. NOT HyperSync, NOT hosted.",
  "fromBlock": addr["factoryBlock"], "toBlock": m["progressBlock"], "blocks": m["progressBlock"] - addr["factoryBlock"] + 1,
  "eventsProcessed": m["eventsProcessed"], "contractEventsOnChainIncludingUnindexed": None,
  "wallClockLaunchToReadySeconds": round((int(e) - int(s)) / 1000, 2),
  "storageInitToReadySeconds": round(t1 - t0, 2) if t0 is not None and t1 is not None else None,
  "txs": addr["txCount"], "markets": len(addr["markets"]),
}
json.dump(rec, open(f"{ev}/backfill-local.json", "w"), indent=2)
open(f"{ev}/backfill-local.md", "w").write(
  "# Full backfill from the deploy block (LOCAL)\n\n"
  + f"- {rec['note']}\n"
  + f"- Range: block {rec['fromBlock']} to {rec['toBlock']} ({rec['blocks']} blocks), {rec['eventsProcessed']} events processed by handlers, {rec['markets']} markets, {rec['txs']} transactions\n"
  + f"- Wall clock from launching `envio dev -r` to `_meta.isReady = true`: **{rec['wallClockLaunchToReadySeconds']} s** (includes codegen, TypeScript check of the handlers, Hasura metadata, index creation)\n"
  + f"- Indexer log: storage initialised to `Ready. Fully indexed for queries.`: **{rec['storageInitToReadySeconds']} s**\n"
  + "- The HyperSync (hosted / testnet) backfill time is NOT measured: it needs the Envio hosted deployment (see the Phase 6 report, BLOCKED).\n")
print(json.dumps(rec))
PY

echo "== 5. reconcile (>= 200 entities)"
pnpm --filter @converge/reconcile exec tsx reconcile.ts --addresses "$LOCAL/addresses.json" --rpc "$RPC" --indexer "$HASURA" --headers "$SECRET" --n 200 --aggregates --label local | tee "$EVIDENCE/reconcile-local.txt"
RECON=${PIPESTATUS[0]}

echo "== 6. latency"
pnpm --filter @converge/reconcile exec tsx latency.ts --indexer "$HASURA" --headers "$SECRET" --n 200 --concurrency 10 --label local | tee "$EVIDENCE/latency-local.txt"
LAT=${PIPESTATUS[0]}

echo "== 7. live lag (${LIVE_SECONDS}s of continuous load)"
LOCAL_RPC=$RPC pnpm --filter @converge/reconcile exec tsx local-live.ts --duration "$LIVE_SECONDS" --rate 4 > "$LOCAL/live.log" 2>&1 &
LIVE_PID=$!
sleep 4
pnpm --filter @converge/reconcile exec tsx lag.ts --indexer "$HASURA" --headers "$SECRET" --rpc "$RPC" --duration $((LIVE_SECONDS - 6)) --interval 500 --label local | tee "$EVIDENCE/lag-local.txt"
LAG=${PIPESTATUS[0]}
wait "$LIVE_PID"
cat "$LOCAL/live.log"

echo "== 8. reconcile again after the live load (indexer was following live)"
pnpm --filter @converge/reconcile exec tsx reconcile.ts --addresses "$LOCAL/addresses.json" --rpc "$RPC" --indexer "$HASURA" --headers "$SECRET" --n 200 --seed 2 --aggregates --label local-after-live | tee "$EVIDENCE/reconcile-local-after-live.txt"
RECON2=${PIPESTATUS[0]}

echo "reconcile=$RECON latency=$LAT lag=$LAG reconcile-after-live=$RECON2"
[ "$RECON" = 0 ] && [ "$LAT" = 0 ] && [ "$LAG" = 0 ] && [ "$RECON2" = 0 ]
