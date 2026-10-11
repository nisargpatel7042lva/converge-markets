import { createRequire } from "node:module";
import type { Abi, Address } from "viem";

const require = createRequire(import.meta.url);
const sdkAbi = (name: string): Abi =>
  (require(`@kuru-labs/kuru-sdk/abi/${name}.json`) as { abi: Abi }).abi;

/** Kuru's ABIs come from its own SDK package (0.0.95): nothing here is hand-written. */
export const routerAbi = sdkAbi("Router");
export const orderBookAbi = sdkAbi("OrderBook");
export const marginAbi = sdkAbi("MarginAccount");

/** Kuru testnet (https://docs.kuru.io/contracts/Contract-addresses, verified in docs/EXTERNAL.md). */
export const KURU_TESTNET = {
  chainId: 10143,
  router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address,
  marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address,
} as const;

/**
 * One parameter set for every outcome market. Prices live in [0.02, 0.98] of a dollar:
 * `calculatePrecisions(0.5, 1, 1, 1, 20)` from the Kuru SDK gives price precision 1e4 and a tick of
 * 10 (0.001), size precision 1e4, minimum size 1 token, maximum 100,000 tokens. Fees are 0/0 and the
 * Kuru AMM spread is 100 bps (the minimum is 10, in multiples of 10).
 */
export const MARKET_PARAMS = {
  pricePrecision: 10_000n,
  sizePrecision: 10_000n,
  tickSize: 10n,
  minSize: 10_000n,
  maxSize: 1_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
  ammSpreadBps: 100n,
} as const;

export const PRICE_MIN = 0.02;
export const PRICE_MAX = 0.98;

/**
 * Price in Kuru's integer unit (price / pricePrecision dollars). Bids round DOWN and asks UP to the tick,
 * so rounding can only widen a quote, never tighten it. Integer math: 0.57 * 1e4 never floors to 5699.
 */
export function toTicks(price: number, side: "bid" | "ask"): number {
  const clamped = Math.min(PRICE_MAX, Math.max(PRICE_MIN, price));
  const num = BigInt(Math.round(clamped * 1e9)) * MARKET_PARAMS.pricePrecision;
  const den = 1_000_000_000n * MARKET_PARAMS.tickSize;
  const ticks = side === "bid" ? num / den : (num + den - 1n) / den;
  return Number(ticks * MARKET_PARAMS.tickSize);
}

export const fromTicks = (t: bigint | number): number =>
  Number(t) / Number(MARKET_PARAMS.pricePrecision);

/** `tokens` whole outcome tokens in Kuru's size unit. */
export const sizeUnits = (tokens: number): bigint =>
  BigInt(Math.round(tokens * 1e4)) * (MARKET_PARAMS.sizePrecision / 10_000n);

export type Quote = { bid: number; ask: number; bidTicks: number; askTicks: number };

/**
 * A two-sided quote around the fair probability: `half` dollars each side, kept inside the market's price
 * band and never crossed. Returns null when the round is effectively decided (fair outside the band) so
 * the maker pulls out instead of quoting a price nobody should take.
 */
export function buildQuote(fair: number, half = 0.04): Quote | null {
  if (!(fair > PRICE_MIN + half && fair < PRICE_MAX - half)) return null;
  const bidTicks = toTicks(fair - half, "bid");
  const askTicks = toTicks(fair + half, "ask");
  if (bidTicks >= askTicks) return null;
  return { bid: fromTicks(bidTicks), ask: fromTicks(askTicks), bidTicks, askTicks };
}

export type RequotePolicy = { moveThreshold: number; maxAgeSec: number; minGapSec: number };
export const DEFAULT_POLICY: RequotePolicy = { moveThreshold: 0.06, maxAgeSec: 240, minGapSec: 30 };

/**
 * `bestBidAsk()` reports a price as ticks scaled by an undocumented factor that CHANGED between Kuru market
 * implementations: 1e10 over the 1e4 price precision (so 1e14 per dollar) on the market of 2026-10-09, and 1e18 per
 * dollar on a market created on 2026-10-11 (4.48e17 for a 0.448 bid). Quotes always sit between 0.02 and 0.98, so only
 * one of the two readings can be a real price; take that one. An empty book reports the largest uint for the bid and 0
 * for the ask: those are "no quote", not prices.
 */
export function fromBookPrice(v: bigint): number | null {
  if (v === 0n || v >= 2n ** 255n) return null;
  for (const scale of [1e14, 1e18]) {
    const p = Number(v) / scale;
    if (p > 0.005 && p < 1.5) return p;
  }
  return null;
}

/**
 * Whether to spend gas on a new quote. A re-quote costs about 0.56 M gas (Monad bills the gas limit), so it
 * happens when the fair value has moved enough to matter or the quote has grown old, not every block.
 */
export function needsRequote(
  last: { fair: number; at: number } | null,
  fair: number,
  now: number,
  p: RequotePolicy = DEFAULT_POLICY,
): boolean {
  if (!last) return true;
  if (now - last.at < p.minGapSec) return false;
  return Math.abs(fair - last.fair) >= p.moveThreshold || now - last.at >= p.maxAgeSec;
}
