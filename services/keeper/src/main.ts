import { assetIdOf } from "@converge/sdk";
import { EwmaVol } from "@converge/strategy";
import pino from "pino";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { convergeVaultAbi } from "@converge/sdk";
import { WebhookAlerter } from "./alerts";
import { makeClients, viemChainTx } from "./chain/clients";
import { TxManager } from "./chain/tx";
import { loadEnv, loadKeeperFile } from "./config";
import { CostLedger } from "./costs";
import { Keeper, type AssetRuntime } from "./keeper";
import { KillSwitch } from "./killswitch";
import { Metrics } from "./metrics";
import { ReferencePrice } from "./price/aggregator";
import { ChainlinkSanity } from "./price/chainlink";
import {
  BINANCE_URL,
  COINBASE_URL,
  WsPriceSource,
  coinbaseSubscribe,
  parseBinance,
  parseCoinbase,
} from "./price/sources";
import { makeReportSource } from "./reports";
import { startServer } from "./server";

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadKeeperFile(env.KEEPER_CONFIG);
  const log = pino({
    level: env.LOG_LEVEL,
    redact: ["*.KEEPER_PRIVATE_KEY", "*.STREAMS_TEST_SIGNER_KEY"],
  });
  const metrics = new Metrics();
  const rpcUrls = env.RPC_URLS.split(",").map((s) => s.trim());
  const chainId = await createPublicClient({ transport: http(rpcUrls[0]) }).getChainId();
  const clients = makeClients({ rpcUrls, keeperKey: env.KEEPER_PRIVATE_KEY as Hex, chainId });
  mkdirSync(env.OUT_DIR, { recursive: true });

  const alerter = new WebhookAlerter(
    env.ALERT_KIND,
    env.ALERT_WEBHOOK_URL,
    env.TELEGRAM_CHAT_ID,
    log,
    5 * 60_000,
    fetch,
    Date.now,
    (key) => metrics.alerts.inc({ key }),
  );
  const kill = new KillSwitch(env.KILL, env.KILL_FILE);

  const vault = env.VAULT as Address;
  const [factory, usdc] = await Promise.all([
    clients.pub.readContract({
      address: vault,
      abi: convergeVaultAbi,
      functionName: "factory",
    }) as Promise<Address>,
    clients.pub.readContract({
      address: vault,
      abi: convergeVaultAbi,
      functionName: "asset",
    }) as Promise<Address>,
  ]);

  const names = ["binance", "coinbase"] as const;
  const assets: AssetRuntime[] = cfg.assets.map((a) => ({
    cfg: a,
    assetId: assetIdOf(a.label),
    feedId: a.feedId as Hex,
    ref: new ReferencePrice(cfg.price, names),
    vol: new EwmaVol(a.vol),
  }));
  const refs = new Map(assets.map((a) => [a.feedId.toLowerCase(), a.ref]));

  const live = env.MODE === "live";
  const tx = live
    ? new TxManager(viemChainTx(clients), {
        gasMultiplierPct: env.GAS_MULTIPLIER_PCT,
        maxFeePerGasWei: BigInt(Math.round(env.MAX_FEE_GWEI * 1e9)),
        haltFeeBoost: cfg.tx.haltFeeBoost,
        stuckMs: cfg.tx.stuckMs,
        maxReplacements: cfg.tx.maxReplacements,
        bumpPct: cfg.tx.bumpPct,
        pollMs: cfg.tx.pollMs,
      })
    : null;

  let keeperRef: Keeper | null = null;
  const keeper = new Keeper({
    mode: env.MODE,
    cfg,
    log,
    metrics,
    alerter,
    kill,
    clients,
    addrs: { vault, venue: env.VENUE as Address, factory, usdc },
    assets,
    reports: makeReportSource(env, refs, () => keeperRef?.chainOffsetMs() ?? 0),
    tx,
    ledger: new CostLedger(resolve(env.OUT_DIR, "costs.jsonl")),
    wsUrl: env.WS_URL,
  });

  keeperRef = keeper;
  // price sources, one pair per asset
  const sources: { stop(): void }[] = [];
  for (const a of assets) {
    const onTick = (t: Parameters<Keeper["onTick"]>[1]) => keeper.onTick(a.cfg.label, t);
    const b = new WsPriceSource({
      name: "binance",
      url: BINANCE_URL(a.cfg.binance),
      parse: parseBinance,
      onTick,
      log,
    });
    const c = new WsPriceSource({
      name: "coinbase",
      url: COINBASE_URL,
      subscribe: coinbaseSubscribe(a.cfg.coinbase),
      parse: parseCoinbase,
      onTick,
      log,
    });
    b.start();
    c.start();
    sources.push(b, c);
    if (env.SANITY_RPC_URL && a.cfg.chainlink) {
      const cl = new ChainlinkSanity(
        env.SANITY_RPC_URL,
        a.cfg.chainlink as Address,
        (p, at) => a.ref.setChainlink(p, at),
        log,
      );
      cl.start();
      sources.push(cl);
    }
  }

  const server = startServer(env.HTTP_PORT, env.HTTP_HOST, {
    status: () => keeper.status(),
    metrics,
    kill,
    killToken: env.KILL_TOKEN,
    onKill: (on) => log.warn({ on }, "HTTP kill switch"),
  });

  await keeper.start();
  log.info(
    { chainId, keeper: clients.account.address, vault, venue: env.VENUE, mode: env.MODE },
    "ready",
  );

  const shutdown = () => {
    log.info("stopping");
    keeper.stop();
    for (const s of sources) s.stop();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("unhandledRejection", (e) => {
    metrics.errors.inc({ kind: "unhandled_rejection" });
    log.error({ err: String(e).slice(0, 300) }, "UNHANDLED REJECTION");
  });
  process.on("uncaughtException", (e) => {
    metrics.errors.inc({ kind: "uncaught_exception" });
    log.fatal({ err: String(e).slice(0, 300) }, "UNCAUGHT EXCEPTION");
    process.exit(1);
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
