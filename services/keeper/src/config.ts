import { readFileSync } from "node:fs";
import { z } from "zod";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

/** Process environment. Secrets are read from here and never logged. */
export const EnvSchema = z.object({
  /** Comma separated, first is primary; the rest are failover (the same chain). */
  RPC_URLS: z.string().min(1),
  /** Optional WebSocket endpoint for new heads (HTTP polling is the fallback). */
  WS_URL: z.string().optional(),
  VAULT: address,
  VENUE: address,
  /** Keeper key (the vault's KEEPER role). Never logged. */
  KEEPER_PRIVATE_KEY: hex32,
  /** live: send transactions. dry-run: log intended actions only. paper: simulate fills locally. */
  MODE: z.enum(["live", "dry-run", "paper"]).default("dry-run"),
  /** Asset and price-source configuration (JSON, see config/keeper.testnet.json). */
  KEEPER_CONFIG: z.string().default("config/keeper.testnet.json"),
  /** Report source for order execution and settlement marks. */
  STREAMS_SOURCE: z.enum(["test-signer", "data-streams"]).default("test-signer"),
  /** TEST-ONLY signer for MockStreamsVerifierProxy (testnet/local). Never logged. */
  STREAMS_TEST_SIGNER_KEY: hex32.optional(),
  DATA_STREAMS_API_URL: z.string().url().optional(),
  DATA_STREAMS_API_KEY: z.string().optional(),
  DATA_STREAMS_API_SECRET: z.string().optional(),
  /** Chain used only to sanity-check the reference price (Chainlink push feed on Monad mainnet). */
  SANITY_RPC_URL: z.string().url().optional(),
  HTTP_PORT: z.coerce.number().int().default(9100),
  HTTP_HOST: z.string().default("127.0.0.1"),
  /** Bearer token for POST /kill and /unkill. Without it the endpoints are disabled. */
  KILL_TOKEN: z.string().min(16).optional(),
  /** Kill switch: while this file exists the keeper stays halted. */
  KILL_FILE: z.string().default("/tmp/converge-keeper.kill"),
  /** Kill switch: start killed. */
  KILL: bool.default("false"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  ALERT_KIND: z.enum(["none", "discord", "telegram"]).default("none"),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** Gas limit multiplier over the estimate (Monad bills the limit: keep it tight). */
  GAS_MULTIPLIER_PCT: z.coerce.number().int().min(100).max(300).default(115),
  /** Refuse to send above this max fee per gas (gwei). Halts may exceed it by `HALT_FEE_BOOST`. */
  MAX_FEE_GWEI: z.coerce.number().positive().default(300),
  /** Where status snapshots and cost ledgers are written (evidence). */
  OUT_DIR: z.string().default("/tmp/converge-keeper"),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(src);
  if (env.MODE === "live" && env.STREAMS_SOURCE === "test-signer" && !env.STREAMS_TEST_SIGNER_KEY) {
    throw new Error("STREAMS_TEST_SIGNER_KEY is required for STREAMS_SOURCE=test-signer");
  }
  if (env.STREAMS_SOURCE === "data-streams") {
    if (!env.DATA_STREAMS_API_URL || !env.DATA_STREAMS_API_KEY || !env.DATA_STREAMS_API_SECRET)
      throw new Error("DATA_STREAMS_API_URL/KEY/SECRET are required for data-streams");
  }
  if (env.ALERT_KIND !== "none" && !env.ALERT_WEBHOOK_URL)
    throw new Error("ALERT_WEBHOOK_URL is required when ALERT_KIND is set");
  if (env.ALERT_KIND === "telegram" && !env.TELEGRAM_CHAT_ID)
    throw new Error("TELEGRAM_CHAT_ID is required for telegram alerts");
  return env;
}

/** Thresholds of the price layer. */
export const PriceCfgSchema = z.object({
  /** A source with no tick for this long is dropped. */
  staleMs: z.number().int().positive().default(3_000),
  /** Fewer healthy sources than this: pull all quotes. */
  minSources: z.number().int().min(1).default(2),
  /** Healthy sources further than this from their median: divergence. */
  divergenceBps: z.number().positive().default(60),
  /** A move of the median larger than this inside the window is a shock. */
  shockBps: z.number().positive().default(100),
  shockWindowMs: z.number().int().positive().default(5_000),
  /** The reference price must stay within this of the on-chain Chainlink feed. */
  sanityBps: z.number().positive().default(200),
  /** A Chainlink answer older than this is ignored (and counted in a metric). */
  chainlinkMaxAgeMs: z
    .number()
    .int()
    .positive()
    .default(15 * 60_000),
});
export type PriceCfg = z.infer<typeof PriceCfgSchema>;

export const RiskCfgSchema = z.object({
  rpcErrorsToPull: z.number().int().min(1).default(5),
  maxBlockLagMs: z.number().int().positive().default(5_000),
  /** Pull when a market's worst-case loss reaches this share of its loss ceiling. */
  inventoryLossRatioCap: z.number().positive().max(1).default(0.9),
  /** While halted, quotes come back only once the loss is below this share of the ceiling (hysteresis). */
  inventoryResumeRatio: z.number().positive().max(1).default(0.75),
  /** Pull when the excess tokens of all markets are worth more than this share of the NAV. */
  excessNavFractionCap: z.number().positive().default(0.25),
  /** Quotes come back after the checks have been clean for this long (doubles after a flap). */
  hysteresisMs: z.number().int().positive().default(15_000),
  maxHysteresisMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  /** Alert when the lower share price is this far under the day's start (fraction). */
  drawdownAlert: z.number().positive().default(0.02),
});
export type RiskCfg = z.infer<typeof RiskCfgSchema>;

export const AssetCfgSchema = z.object({
  label: z.string().min(1), // "TEST/USD": assetId = keccak256(label)
  feedId: hex32,
  binance: z.string().min(1), // "ETHUSDT"
  coinbase: z.string().min(1), // "ETH-USD"
  /** Chainlink aggregator on the sanity chain (Monad mainnet ETH/USD proxy). */
  chainlink: address.optional(),
  /** Volatility estimator (packages/strategy EwmaVol). */
  vol: z
    .object({
      halfLifeSec: z.number().positive().default(1800),
      priorAnnualVol: z.number().positive().default(0.6),
      minAnnualVol: z.number().positive().default(0.4),
      maxAnnualVol: z.number().positive().default(1.2),
      scale: z.number().positive().default(1.1),
    })
    .default({}),
});
export type AssetCfg = z.infer<typeof AssetCfgSchema>;

export const KeeperFileSchema = z.object({
  price: PriceCfgSchema.default({}),
  risk: RiskCfgSchema.default({}),
  assets: z.array(AssetCfgSchema).min(1),
  /** After start the price sources get this long to connect before a missing price pulls quotes. */
  startupGraceMs: z.number().int().min(0).default(8_000),
  /** How often the slow duties (state read, planner) run. */
  slowTickMs: z.number().int().min(200).default(2_000),
  /** Refresh sigma at least this often (the vault needs it fresher than 15 minutes). */
  sigmaRefreshSec: z.number().int().positive().default(240),
  /** Move sigma when the estimate differs from the stored value by more than this fraction. */
  sigmaMoveFraction: z.number().positive().default(0.05),
  /** Pairs to hold per open market, as a share of the lower NAV (the vault caps it at 30%). */
  targetPairFraction: z.number().positive().max(0.3).default(0.05),
  /** Top up when the pairs fall below this share of the target. */
  topUpBelowFraction: z.number().positive().max(1).default(0.5),
  /** Do not split into a round with less than this left (seconds). */
  minSecondsLeftToSplit: z.number().int().default(120),
  /** Re-value the vault at least this often (seconds); the vault itself needs it fresher than 30 min. */
  checkpointEverySec: z.number().int().positive().default(300),
  /** Stuck-transaction handling. */
  tx: z
    .object({
      stuckMs: z.number().int().positive().default(4_000),
      maxReplacements: z.number().int().min(0).default(3),
      bumpPct: z.number().int().min(10).default(25),
      pollMs: z.number().int().positive().default(150),
      /** A halt may pay up to this multiple of the fee cap. */
      haltFeeBoost: z.number().positive().default(3),
    })
    .default({}),
  /** Paper/live: execute orders even when the simulation shows no fill (the taker is refunded). */
  executeUnfilled: z.boolean().default(true),
});
export type KeeperFile = z.infer<typeof KeeperFileSchema>;

export function loadKeeperFile(path: string): KeeperFile {
  return KeeperFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
