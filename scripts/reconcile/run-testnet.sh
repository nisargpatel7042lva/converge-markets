#!/usr/bin/env bash
# REAL Monad testnet evidence with a LOCAL indexer (no HyperSync, no ENVIO_API_TOKEN, not hosted):
#   rate-limited RPC proxy (<= PROXY_RPS requests/s in total to the public testnet RPC)
#   -> Envio HyperIndex with an `rpc:` data source for chain 10143 from the deploy block
#   -> Postgres + Hasura in Docker -> timed backfill -> reconcile against the chain -> latency -> lag.
# Everything that touches the public RPC goes through the proxy, which records the request volume.
# Only processes started here are stopped here (PIDs / process groups recorded, nothing killed by name).
#
# Usage: bash scripts/reconcile/run-testnet.sh   (env: PROXY_RPS=6 LAG_SECONDS=120 UPSTREAM=https://testnet-rpc.monad.xyz)
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
PROXY_RPS=${PROXY_RPS:-6}
LAG_SECONDS=${LAG_SECONDS:-120}
UPSTREAM=${UPSTREAM:-https://testnet-rpc.monad.xyz}
PROXY_PORT=${PROXY_PORT:-8612}
PROXY="http://127.0.0.1:${PROXY_PORT}"
LOCAL="$ROOT/.local-indexer"
EVIDENCE="$ROOT/docs/evidence/phase-6"
HASURA="http://localhost:8080/v1/graphql"
SECRET="x-hasura-admin-secret=testing"
mkdir -p "$LOCAL" "$EVIDENCE"
if [ -n "${DOCKER_CONFIG_DIR:-}" ]; then export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"; fi

PROXY_PID=""
ENVIO_PID=""
cleanup() {
  if [ -n "$ENVIO_PID" ]; then kill -- "-$ENVIO_PID" 2>/dev/null; fi
  (cd "$LOCAL/testnet-project" 2>/dev/null && pnpm exec envio stop >/dev/null 2>&1)
  if [ -n "$PROXY_PID" ]; then kill -- "-$PROXY_PID" 2>/dev/null; sleep 1; fi
  echo "exit" >> "$LOCAL/run-testnet.done"
}
trap cleanup EXIT
for p in "$PROXY_PORT" 8080 5433 9898; do
  if (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is already in use: stop the other process first"; exit 1; fi
done

echo "== 1. rate-limited RPC proxy ($PROXY_RPS rps -> $UPSTREAM)"
(cd scripts/reconcile && exec setsid pnpm exec tsx rpc-proxy.ts --upstream "$UPSTREAM" --port "$PROXY_PORT" --rps "$PROXY_RPS" --stats "$EVIDENCE/rpc-usage-testnet.json" > "$LOCAL/rpc-proxy.log" 2>&1) &
PROXY_PID=$!
for i in $(seq 1 40); do (echo > "/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null && break; sleep 0.5; done

echo "== 2. indexer project for chain 10143 (rpc source, from the deploy block)"
FACTORY_FROM_BLOCK=${FACTORY_FROM_BLOCK:-} VAULT_FROM_BLOCK=${VAULT_FROM_BLOCK:-} END_BLOCK=${END_BLOCK:-} ROLLBACK=${ROLLBACK:-} MAX_BLOCK_RANGE=100 POLL_MS=${POLL_MS:-500} node indexer/scripts/local-project.mjs deployments/testnet.json "$PROXY" "$LOCAL/testnet-project" || exit 1

echo "== 3. envio dev (backfill timing)"
START_MS=$(date +%s%3N)
(cd "$LOCAL/testnet-project" && ENVIO_TUI=false LOG_STRATEGY=console-raw exec setsid pnpm exec envio dev -r > "$LOCAL/envio-testnet.log" 2>&1) &
ENVIO_PID=$!
READY=""
for i in $(seq 1 7200); do
  OUT=$(curl -s -m 2 -X POST "$HASURA" -H 'content-type: application/json' -H "x-hasura-admin-secret: testing" -d '{"query":"{ _meta { isReady progressBlock sourceBlock eventsProcessed startBlock } }"}' 2>/dev/null)
  if echo "$OUT" | grep -q '"isReady":true'; then READY="$OUT"; break; fi
  if [ $((i % 60)) = 0 ]; then echo "  waiting ($((i / 2)) s): $OUT"; fi
  sleep 0.5
done
END_MS=$(date +%s%3N)
if [ -z "$READY" ]; then echo "indexer never became ready"; tail -30 "$LOCAL/envio-testnet.log"; exit 1; fi
echo "ready: $READY"
python3 - "$READY" "$START_MS" "$END_MS" "$LOCAL" "$EVIDENCE" "$ROOT" <<'PY'
import json, sys, re
ready, s, e, local, ev, root = sys.argv[1:7]
m = json.loads(ready)["data"]["_meta"][0]
dep = json.load(open(f"{root}/deployments/testnet.json"))
log = open(f"{local}/envio-testnet.log").read()
def ts(pat):
    r = re.search(r"\[(\d\d):(\d\d):(\d\d\.\d+)\].*?" + pat, log)
    return (int(r.group(1))*3600 + int(r.group(2))*60 + float(r.group(3))) if r else None
t0 = ts("Initializing the indexer storage"); t1 = ts("Ready\\. Fully indexed")
rec = {
  "label": "testnet-rpc",
  "note": "REAL Monad testnet data (chain 10143), LOCAL indexer (Envio HyperIndex 3.14.0) with an RPC data source behind a rate-limited proxy (PROXY_RPS, see rpc-usage-testnet.json), Postgres + Hasura in Docker. NOT HyperSync, NOT the hosted Envio service.",
  "fromBlock": m["startBlock"], "toBlock": m["progressBlock"], "blocks": m["progressBlock"] - m["startBlock"] + 1,
  "eventsProcessed": m["eventsProcessed"],
  "wallClockLaunchToReadySeconds": round((int(e) - int(s)) / 1000, 1),
  "storageInitToReadySeconds": round(t1 - t0, 1) if t0 is not None and t1 is not None else None,
}
json.dump(rec, open(f"{ev}/backfill-testnet-rpc.json", "w"), indent=2)
open(f"{ev}/backfill-testnet-rpc.md", "w").write(
  "# Full backfill from the deploy block on Monad testnet (LOCAL indexer, RPC source)\n\n"
  + f"- {rec['note']}\n"
  + f"- Range: block {rec['fromBlock']} to {rec['toBlock']} ({rec['blocks']} blocks), {rec['eventsProcessed']} events processed by handlers\n"
  + f"- Wall clock from launching `envio dev -r` to `_meta.isReady = true`: **{rec['wallClockLaunchToReadySeconds']} s** (includes codegen, handler type check, Hasura metadata, index creation)\n"
  + f"- Indexer log: storage initialised to `Ready. Fully indexed for queries.`: **{rec['storageInitToReadySeconds']} s**\n"
  + "- Request volume and peak rate: `rpc-usage-testnet.json`.\n"
  + "- This is NOT the HyperSync / hosted backfill (BLOCKED: needs the Envio hosted deployment).\n")
print(json.dumps(rec))
PY

echo "== 4. reconcile against the chain (all real entities, up to 200+)"
pnpm --filter @converge/reconcile exec tsx reconcile.ts --addresses "$ROOT/deployments/testnet.json" --rpc "$PROXY" --indexer "$HASURA" --headers "$SECRET" --n 250 --aggregates --allow-small --log-chunk 100 --rps 5 --concurrency 3 --label testnet-rpc | tee "$EVIDENCE/reconcile-testnet-rpc.txt"
RECON=${PIPESTATUS[0]}

echo "== 5. latency (local Hasura serving the real testnet data)"
pnpm --filter @converge/reconcile exec tsx latency.ts --indexer "$HASURA" --headers "$SECRET" --n 200 --concurrency 10 --label testnet-rpc-local-hasura | tee "$EVIDENCE/latency-testnet-rpc.txt"
LAT=${PIPESTATUS[0]}

if [ "${LAG_SECONDS}" != "0" ]; then
echo "== 6. lag against the live testnet head (${LAG_SECONDS}s, head read every 5 s through the proxy)"
pnpm --filter @converge/reconcile exec tsx lag.ts --indexer "$HASURA" --headers "$SECRET" --rpc "$PROXY" --rpc-interval 5000 --duration "$LAG_SECONDS" --interval 1000 --label testnet-rpc | tee "$EVIDENCE/lag-testnet-rpc.txt"
LAG=${PIPESTATUS[0]}

else
  LAG="skipped (END_BLOCK-bounded run: the indexer stops at END_BLOCK, so the lag to the live head is not meaningful)"
fi

echo "reconcile=$RECON latency=$LAT lag=$LAG"
sleep 6
# the exit code is the verdict: a failed reconcile, latency or lag check is not hidden
case "$LAG" in skipped*) LAG_OK=0 ;; *) LAG_OK=$LAG ;; esac
[ "$RECON" = 0 ] && [ "$LAT" = 0 ] && [ "$LAG_OK" = 0 ]
