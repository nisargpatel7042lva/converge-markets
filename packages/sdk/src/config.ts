import { keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";

/** Schema of config/series.json (network-agnostic; addresses come from deployments/*.json). */
export const SeriesConfigSchema = z.object({
  /** Keep markets created this many rounds ahead. */
  lookaheadRounds: z.number().int().min(1).max(12),
  /** Every run checks markets that started within this window. */
  recentLookbackSeconds: z.number().int().positive(),
  /** Periodic deep sweep window (covers the longest resolver liveness grace). */
  deepLookbackSeconds: z.number().int().positive(),
  /** An action still pending this long after it became due is "late" (alert). */
  lateAfterSeconds: z.number().int().positive(),
  durations: z.array(z.union([z.literal(900), z.literal(3600)])).min(1),
  assets: z
    .array(
      z.object({
        /** Asset label, e.g. "BTC/USD"; assetId = keccak256(label). */
        label: z.string().min(1),
        /** Short name used in token names (MarketFactory asset label). */
        symbol: z.string().min(1),
        resolver: z.enum(["streams", "round"]),
        /** Data Streams feed id (streams assets only). */
        streamsFeedId: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional(),
      }),
    )
    .min(1),
  kuru: z.object({
    enabled: z.boolean(),
    reason: z.string(),
  }),
});

export type SeriesConfig = z.infer<typeof SeriesConfigSchema>;
export type AssetConfig = SeriesConfig["assets"][number];

export function assetIdOf(label: string): Hex {
  return keccak256(stringToHex(label));
}

export function parseSeriesConfig(json: unknown): SeriesConfig {
  const cfg = SeriesConfigSchema.parse(json);
  for (const a of cfg.assets) {
    if (a.resolver === "streams" && !a.streamsFeedId) {
      throw new Error(`asset ${a.label}: streams resolver needs streamsFeedId`);
    }
  }
  return cfg;
}
