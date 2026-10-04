import { readFileSync } from "node:fs";
import {
  DataStreamsRestSource,
  parseSeriesConfig,
  TestSignerStreamsSource,
  type StreamsReportSource,
} from "@converge/sdk";
import pino from "pino";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebhookAlerter } from "./alerts";
import { loadEnv } from "./env";
import { startHealthServer, type HealthState } from "./health";
import { chainlinkMirror } from "./prices";
import { Scheduler } from "./scheduler";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, base: { svc: "scheduler-fallback" } });
  const config = parseSeriesConfig(JSON.parse(readFileSync(env.SERIES_CONFIG, "utf8")));
  const transport = http(env.RPC_URL, { timeout: 20_000 });
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const chain = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  } as const;
  const account = privateKeyToAccount(env.SCHEDULER_PRIVATE_KEY as Hex);
  const walletClient = createWalletClient({ account, chain, transport });

  let streams: StreamsReportSource | null = null;
  if (env.STREAMS_SOURCE === "rest") {
    streams = new DataStreamsRestSource(
      env.DATA_STREAMS_API_URL!,
      env.DATA_STREAMS_API_KEY!,
      env.DATA_STREAMS_API_SECRET!,
    );
  } else if (env.STREAMS_SOURCE === "test-signer") {
    const feeds = JSON.parse(env.TEST_PRICE_FEEDS ?? "{}") as Record<string, Address>;
    const mirror = chainlinkMirror(
      env.TEST_PRICE_RPC_URL ?? env.RPC_URL,
      Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k.toLowerCase(), v])),
    );
    const signer = privateKeyToAccount(env.STREAMS_TEST_SIGNER_KEY as Hex);
    streams = {
      reportAt: (feedId, ts) =>
        new TestSignerStreamsSource(signer, mirror(feedId)).reportAt(feedId, ts),
    };
    log.warn("STREAMS_SOURCE=test-signer: TEST-ONLY reports (MockStreamsVerifierProxy)");
  }

  const alerter = new WebhookAlerter(
    env.ALERT_KIND,
    env.ALERT_WEBHOOK_URL,
    env.TELEGRAM_CHAT_ID,
    log,
  );
  const scheduler = new Scheduler({
    publicClient,
    walletClient,
    factory: env.FACTORY as Address,
    ...(env.RECEIVER ? { receiver: env.RECEIVER as Address } : {}),
    config,
    streams,
    alerter,
    log,
    gasMultiplierPct: env.GAS_MULTIPLIER_PCT,
    maxRetries: env.MAX_RETRIES,
    ...(env.EPOCH === undefined ? {} : { epoch: env.EPOCH }),
  });

  const health: HealthState = {
    startedAt: Date.now(),
    lastTickAt: null,
    lastTickOk: false,
    lastError: null,
    ticks: 0,
    leader: null,
    lateCount: 0,
    intervalMs: env.LOOP_INTERVAL_MS,
  };
  const server = startHealthServer(env.HEALTH_PORT, () => health);
  log.info(
    { chainId, scheduler: account.address, factory: env.FACTORY, receiver: env.RECEIVER ?? null },
    "started",
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
    server.close();
    log.info("stopping");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    const t0 = Date.now();
    try {
      const r = await scheduler.tick({ deep: health.ticks % env.DEEP_SWEEP_EVERY === 0 });
      health.lastTickOk = true;
      health.lastError = null;
      health.leader = r.leader;
      health.lateCount = r.late.length;
    } catch (e) {
      health.lastTickOk = false;
      health.lastError = e instanceof Error ? e.message : String(e);
      log.error({ err: health.lastError }, "tick failed");
      await alerter.alert("tick-failed", `tick failed: ${health.lastError}`);
    }
    health.ticks += 1;
    health.lastTickAt = Date.now();
    const wait = Math.max(0, env.LOOP_INTERVAL_MS - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
