import { EwmaVol } from "@converge/strategy";
import pino from "pino";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { WebhookAlerter } from "../../src/alerts";
import { makeClients, viemChainTx, type Clients } from "../../src/chain/clients";
import { TxManager } from "../../src/chain/tx";
import { KeeperFileSchema, type KeeperFile } from "../../src/config";
import { CostLedger } from "../../src/costs";
import { Keeper, type AssetRuntime, type Mode } from "../../src/keeper";
import { KillSwitch } from "../../src/killswitch";
import { Metrics } from "../../src/metrics";
import { ReferencePrice } from "../../src/price/aggregator";
import { makeReportSource } from "../../src/reports";
import { ASSET_ID, KEYS, TEST_FEED, TEST_LABEL, type Stack } from "./stack";

export type Rig = {
  keeper: Keeper;
  metrics: Metrics;
  clients: Clients;
  kill: KillSwitch;
  alerter: WebhookAlerter;
  ref: ReferencePrice;
  cfg: KeeperFile;
  /** One tick from each named source at the current wall-clock time. */
  tick: (price: number, sources?: readonly ("binance" | "coinbase")[]) => void;
  /** Keeps ticking (both sources) from `price()` every `everyMs`; returns control of the sources. */
  feed: (
    price: () => number,
    everyMs?: number,
  ) => {
    mute: (s: "binance" | "coinbase") => void;
    unmute: (s: "binance" | "coinbase") => void;
    stop: () => void;
  };
  killFile: string;
  stop: () => void;
};

export function testConfig(over: Record<string, unknown> = {}): KeeperFile {
  return KeeperFileSchema.parse({
    price: { staleMs: 1500, shockBps: 100, shockWindowMs: 3000 },
    risk: { hysteresisMs: 1500, maxHysteresisMs: 6000, warmupMs: 1500 },
    assets: [
      {
        label: TEST_LABEL,
        feedId: TEST_FEED,
        binance: "ETHUSDT",
        coinbase: "ETH-USD",
        vol: { priorAnnualVol: 0.6, minAnnualVol: 0.4, maxAnnualVol: 1.2, scale: 1.1 },
      },
    ],
    slowTickMs: 300,
    sigmaRefreshSec: 30,
    checkpointEverySec: 60,
    tx: { stuckMs: 3000, maxReplacements: 2, bumpPct: 25, pollMs: 80, haltFeeBoost: 3 },
    ...over,
  });
}

let seq = 0;

export function makeRig(
  stack: Stack,
  o: { mode?: Mode; cfg?: KeeperFile; rpcUrls?: string[]; log?: boolean; killFile?: string } = {},
): Rig {
  const mode = o.mode ?? "live";
  const cfg = o.cfg ?? testConfig();
  const log = pino({ level: o.log ? "info" : "silent" });
  const metrics = new Metrics();
  const clients = makeClients({
    rpcUrls: o.rpcUrls ?? [stack.url],
    keeperKey: KEYS.keeper,
    chainId: stack.chain.id,
    timeoutMs: 2_000,
  });
  const killFile = o.killFile ?? join(tmpdir(), `keeper-kill-${process.pid}-${++seq}`);
  const kill = new KillSwitch(false, killFile);
  const alerter = new WebhookAlerter(
    "none",
    undefined,
    undefined,
    log,
    1_000,
    fetch,
    Date.now,
    (key) => metrics.alerts.inc({ key }),
  );
  const ref = new ReferencePrice(cfg.price, ["binance", "coinbase"]);
  const a = cfg.assets[0]!;
  const asset: AssetRuntime = {
    cfg: a,
    assetId: ASSET_ID,
    feedId: TEST_FEED,
    ref,
    vol: new EwmaVol(a.vol),
  };
  const refs = new Map([[TEST_FEED.toLowerCase(), ref]]);
  let keeperRef: Keeper | null = null;
  const tx =
    mode === "live"
      ? new TxManager(viemChainTx(clients, 1_000_000_000n), {
          gasMultiplierPct: 120,
          maxFeePerGasWei: 100_000_000_000n,
          haltFeeBoost: cfg.tx.haltFeeBoost,
          stuckMs: cfg.tx.stuckMs,
          maxReplacements: cfg.tx.maxReplacements,
          bumpPct: cfg.tx.bumpPct,
          pollMs: cfg.tx.pollMs,
        })
      : null;
  const keeper = new Keeper({
    mode,
    cfg,
    log,
    metrics,
    alerter,
    kill,
    clients,
    addrs: {
      vault: stack.addrs.vault,
      venue: stack.addrs.venue,
      factory: stack.addrs.factory,
      usdc: stack.addrs.usdc,
    },
    assets: [asset],
    reports: makeReportSource(
      {
        STREAMS_SOURCE: "test-signer",
        STREAMS_TEST_SIGNER_KEY: KEYS.signer,
        DATA_STREAMS_API_URL: undefined,
        DATA_STREAMS_API_KEY: undefined,
        DATA_STREAMS_API_SECRET: undefined,
      },
      refs,
      () => keeperRef?.chainOffsetMs() ?? 0,
    ),
    tx,
    ledger: new CostLedger(join(tmpdir(), `keeper-costs-${process.pid}-${seq}.jsonl`)),
    venue: { execDelay: 2, maxLateness: 4 },
  });
  keeperRef = keeper;

  const tick = (
    price: number,
    sources: readonly ("binance" | "coinbase")[] = ["binance", "coinbase"],
  ) => {
    for (const s of sources) keeper.onTick(TEST_LABEL, { source: s, price, tsMs: Date.now() });
  };
  const feed: Rig["feed"] = (price, everyMs = 100) => {
    const muted = new Set<string>();
    const timer = setInterval(() => {
      const p = price();
      for (const s of ["binance", "coinbase"] as const)
        if (!muted.has(s)) keeper.onTick(TEST_LABEL, { source: s, price: p, tsMs: Date.now() });
    }, everyMs);
    return {
      mute: (s) => void muted.add(s),
      unmute: (s) => void muted.delete(s),
      stop: () => clearInterval(timer),
    };
  };
  return {
    keeper,
    metrics,
    clients,
    kill,
    alerter,
    ref,
    cfg,
    tick,
    feed,
    killFile,
    stop: () => keeper.stop(),
  };
}

/** p-quantile of a Prometheus histogram from its buckets (upper bound of the bucket holding it). */
export async function histQuantile(
  m: Metrics,
  name: string,
  q: number,
): Promise<{ count: number; value: number }> {
  const all = await m.registry.getMetricsAsJSON();
  const h = all.find((x) => x.name === name);
  if (!h) return { count: 0, value: Number.NaN };
  const values = (
    h.values as { metricName?: string; labels: Record<string, string | number>; value: number }[]
  ).filter((v) => v.metricName?.endsWith("_bucket"));
  const count =
    (h.values as { metricName?: string; value: number }[]).find((v) =>
      v.metricName?.endsWith("_count"),
    )?.value ?? 0;
  if (count === 0) return { count: 0, value: Number.NaN };
  const buckets = new Map<number, number>();
  for (const v of values) {
    const le = Number(v.labels.le === "+Inf" ? Number.POSITIVE_INFINITY : v.labels.le);
    buckets.set(le, (buckets.get(le) ?? 0) + v.value);
  }
  for (const le of [...buckets.keys()].sort((a, b) => a - b)) {
    if ((buckets.get(le) as number) >= q * count) return { count, value: le };
  }
  return { count, value: Number.POSITIVE_INFINITY };
}

export async function counter(
  m: Metrics,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const all = await m.registry.getMetricsAsJSON();
  const c = all.find((x) => x.name === name);
  if (!c) return 0;
  return (c.values as { labels: Record<string, string | number>; value: number }[])
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((a, v) => a + v.value, 0);
}

export async function waitFor<T>(
  fn: () => Promise<T | null | false | undefined> | T | null | false | undefined,
  timeoutMs: number,
  what: string,
  everyMs = 100,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const addr = (a: Address) => a;
