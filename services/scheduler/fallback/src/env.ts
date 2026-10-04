import { z } from "zod";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const EnvSchema = z.object({
  RPC_URL: z.string().url(),
  /** MarketFactory address. */
  FACTORY: address,
  /** SchedulerLens (one-call snapshot). */
  LENS: address,
  /** SchedulerReceiver address (leader flag). Required unless STANDALONE=true. */
  RECEIVER: address.optional(),
  /** Act without a leader flag (local tests only; never in production). */
  STANDALONE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Scheduler key: must hold CREATOR_ROLE on the factory. Never logged. */
  SCHEDULER_PRIVATE_KEY: hex32,
  SERIES_CONFIG: z.string().default("config/series.json"),
  LOOP_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  /** Ignore rounds starting before this unix time (scheduler go-live). */
  EPOCH: z.coerce.bigint().optional(),
  HEALTH_PORT: z.coerce.number().int().default(8080),
  /** Bind address for /health (default loopback; the endpoint is unauthenticated). */
  HEALTH_HOST: z.string().default("127.0.0.1"),
  /** /health turns 503 after this many consecutive bad ticks (failed/pending actions or late items). */
  UNHEALTHY_AFTER_BAD_TICKS: z.coerce.number().int().min(1).default(3),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  /** Alerts: Discord webhook URL or Telegram bot sendMessage URL. */
  ALERT_KIND: z.enum(["none", "discord", "telegram"]).default("none"),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** Data Streams evidence source. */
  STREAMS_SOURCE: z.enum(["none", "rest", "test-signer"]).default("none"),
  DATA_STREAMS_API_URL: z.string().url().optional(),
  DATA_STREAMS_API_KEY: z.string().optional(),
  DATA_STREAMS_API_SECRET: z.string().optional(),
  /** TEST-ONLY signer for MockStreamsVerifierProxy (testnet/local). Never logged. */
  STREAMS_TEST_SIGNER_KEY: hex32.optional(),
  /** TEST-ONLY price source for the test signer: JSON {feedIdHex: aggregatorAddress} read via RPC. */
  TEST_PRICE_FEEDS: z.string().optional(),
  TEST_PRICE_RPC_URL: z.string().url().optional(),
  /** Gas limit multiplier (Monad bills the limit, keep tight). */
  GAS_MULTIPLIER_PCT: z.coerce.number().int().min(100).max(300).default(120),
  MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(src);
  if (!env.RECEIVER && !env.STANDALONE) {
    throw new Error("RECEIVER is required (or STANDALONE=true for local tests)");
  }
  if (env.ALERT_KIND !== "none" && !env.ALERT_WEBHOOK_URL) {
    throw new Error("ALERT_WEBHOOK_URL required when ALERT_KIND is set");
  }
  if (env.ALERT_KIND === "telegram" && !env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID required for telegram alerts");
  }
  if (
    env.STREAMS_SOURCE === "rest" &&
    !(env.DATA_STREAMS_API_URL && env.DATA_STREAMS_API_KEY && env.DATA_STREAMS_API_SECRET)
  ) {
    throw new Error("DATA_STREAMS_API_URL/KEY/SECRET required for STREAMS_SOURCE=rest");
  }
  if (env.STREAMS_SOURCE === "test-signer" && !env.STREAMS_TEST_SIGNER_KEY) {
    throw new Error("STREAMS_TEST_SIGNER_KEY required for STREAMS_SOURCE=test-signer");
  }
  return env;
}
