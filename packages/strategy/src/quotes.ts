import { clamp, normInv, normPdf } from "./math";
import type { StrategyParams } from "./params";
import { d2, fairProbUp, SECONDS_PER_YEAR } from "./prob";
import { liquidityScale, rangeTicks } from "./liquidity";
import { buyRoom, lossCeiling, sellRoom, type Position, type RiskLimits } from "./risk";

export type QuoteStatus =
  "quoting" | "no-quote-window" | "toxic" | "breaker" | "no-liquidity" | "invalid";

/** Everything `generateQuotes` needs about one market at one instant. */
export type MarketState = {
  /** Spot price as seen by the vault (already delayed by the vault's own latency). */
  spot: number;
  strike: number;
  /** Seconds to expiry. */
  tauSec: number;
  /** Full round length in seconds (900 or 3600): the T of the pm-AMM schedule. */
  roundSec: number;
  /** Annualized volatility estimate. */
  sigma: number;
  position: Position;
  /** Vault NAV in collateral units (USD). */
  nav: number;
  /** Sum of worst-case losses of every other market. */
  otherAtRisk: number;
  /** Price range over the toxicity window, in bps (see RollingRange). */
  recentRangeBps: number;
  breakerTripped: boolean;
};

export type Level = { price: number; size: number };
export type Book = { bids: Level[]; asks: Level[] };

export type QuoteSet = {
  status: QuoteStatus;
  fair: number;
  center: number;
  halfSpread: number;
  skew: number;
  /** UP token book. Bids are descending, asks ascending, strictly separated. */
  up: Book;
  /** DOWN token book, derived by complement: DOWN bid = 1 − UP ask, DOWN ask = 1 − UP bid. */
  down: Book;
};

const EMPTY: Book = { bids: [], asks: [] };

function emptySet(status: QuoteStatus, fair = NaN): QuoteSet {
  return { status, fair, center: fair, halfSpread: 0, skew: 0, up: EMPTY, down: EMPTY };
}

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;
const floorTick = (x: number, tick: number) => round9(Math.floor(x / tick + 1e-9) * tick);
const ceilTick = (x: number, tick: number) => round9(Math.ceil(x / tick - 1e-9) * tick);
const floorSize = (x: number) => Math.floor(x * 1e6) / 1e6;

/** Half-spread: max(floor, volatility component) plus toxicity widening, capped. */
export function halfSpread(state: MarketState, p: StrategyParams): number {
  const tauYears = state.tauSec / SECONDS_PER_YEAR;
  const x = d2({ spot: state.spot, strike: state.strike, sigma: state.sigma, tauYears });
  // Staleness risk in probability terms: probability moves φ(d2)/√τ per √second (see prob.ts),
  // so a quote that is `stalenessSec` old is off by about φ(d2)·√(stalenessSec/τ).
  const stale =
    Number.isFinite(x) && state.tauSec > 0
      ? p.volSpreadK * normPdf(x) * Math.sqrt(p.stalenessSec / state.tauSec)
      : 0;
  let h = Math.max(p.minHalfSpread, stale);
  const start = 0.5 * p.toxicityPullBps;
  if (state.recentRangeBps > start) {
    const w = clamp((state.recentRangeBps - start) / (p.toxicityPullBps - start), 0, 1);
    h += p.toxicityWidenMax * w;
  }
  return clamp(h, p.minHalfSpread, p.maxHalfSpread);
}

/** Inventory skew: shifts the quote centre toward flattening the position (positive = up). */
export function inventorySkew(pos: Position, nav: number, p: StrategyParams, h: number): number {
  // Shares at which the per-market loss limit would be reached if sold near 0.5.
  const refShares = 2 * p.perMarketMaxFraction * nav || 1;
  const f = pos.shortUp / refShares;
  return clamp(p.inventorySkewMax * Math.tanh(p.inventorySkewK * f), -0.8 * h, 0.8 * h);
}

/**
 * Bid/ask ladder for one market.
 *
 * Guarantees (property-tested): prices lie in [priceMin, priceMax] on the tick grid; the best bid
 * is strictly below the best ask; every bid ≤ fair − 0.2·h and every ask ≥ fair + 0.2·h, so the
 * vault never quotes through its own fair value; sizes are non-negative, shrink with √(τ/T)
 * (pm-AMM), and never let a fill push the market's worst-case loss past its limit.
 *
 * DOWN is quoted by complement from the same ladder, so UP and DOWN can never be arbitraged
 * against each other.
 */
export function generateQuotes(state: MarketState, p: StrategyParams): QuoteSet {
  const finite =
    Number.isFinite(state.spot) &&
    state.spot > 0 &&
    Number.isFinite(state.strike) &&
    state.strike > 0 &&
    Number.isFinite(state.sigma) &&
    state.sigma >= 0 &&
    Number.isFinite(state.tauSec) &&
    Number.isFinite(state.nav) &&
    state.nav > 0 &&
    Number.isFinite(state.position.cash) &&
    Number.isFinite(state.position.shortUp) &&
    Number.isFinite(state.otherAtRisk) &&
    Number.isFinite(state.recentRangeBps);
  if (!finite) return emptySet("invalid");
  const tauYears = Math.max(0, state.tauSec) / SECONDS_PER_YEAR;
  const fair = fairProbUp(state.spot, state.strike, state.sigma, tauYears);
  if (state.breakerTripped) return emptySet("breaker", fair);
  if (state.tauSec <= p.noQuoteWindowSec) return emptySet("no-quote-window", fair);
  if (state.recentRangeBps >= p.toxicityPullBps) return emptySet("toxic", fair);

  const h = halfSpread(state, p);
  const skew = inventorySkew(state.position, state.nav, p, h);
  const center = fair + skew;

  const span = rangeTicks(state.tauSec, state.roundSec, p.baseRangeTicks, p.minRangeTicks);
  const stepTicks = p.levels > 1 ? Math.max(1, Math.ceil(span / (p.levels - 1) - 1e-9)) : 1;
  const lt = p.liquidityNavFraction * state.nav * liquidityScale(state.tauSec, state.roundSec);

  const limits: RiskLimits = {
    perMarketMaxFraction: p.perMarketMaxFraction,
    totalAtRiskMaxFraction: p.totalAtRiskMaxFraction,
  };
  const ceiling = lossCeiling(state.position, state.nav, state.otherAtRisk, limits);

  const anchor = clamp(fair, p.priceMin, p.priceMax);
  const band = stepTicks * p.tick;
  const bounded = (x: number) => clamp(x, p.priceMin, p.priceMax);
  const bids: Level[] = [];
  const asks: Level[] = [];

  // Depth of level j is the pm-AMM reserve change over the j-th band of width `band` away from
  // fair value (independent of the half-spread, so widening the spread near expiry never adds
  // depth): shares = L_t · |Φ⁻¹(p_far) − Φ⁻¹(p_near)|. Bids: the vault buys UP.
  let pos = state.position;
  for (let j = 0; j < p.levels; j++) {
    const price = floorTick(center - h - j * band, p.tick);
    if (price < p.priceMin) break;
    if (price > p.priceMax) continue; // fair value above the quote bounds: deeper levels may fit
    const base =
      lt *
      Math.abs(normInv(bounded(anchor - j * band)) - normInv(bounded(anchor - (j + 1) * band)));
    const size = floorSize(Math.min(base, buyRoom(pos, price, ceiling)));
    if (size >= Math.max(p.minLevelSize, 1e-6)) {
      bids.push({ price, size });
      pos = { cash: pos.cash - price * size, shortUp: pos.shortUp - size };
    }
  }
  // Asks: the vault sells UP.
  pos = state.position;
  for (let j = 0; j < p.levels; j++) {
    const price = ceilTick(center + h + j * band, p.tick);
    if (price > p.priceMax) break;
    if (price < p.priceMin) continue; // fair value below the quote bounds: deeper levels may fit
    const base =
      lt *
      Math.abs(normInv(bounded(anchor + (j + 1) * band)) - normInv(bounded(anchor + j * band)));
    const size = floorSize(Math.min(base, sellRoom(pos, price, ceiling)));
    if (size >= Math.max(p.minLevelSize, 1e-6)) {
      asks.push({ price, size });
      pos = { cash: pos.cash + price * size, shortUp: pos.shortUp + size };
    }
  }
  if (bids.length === 0 && asks.length === 0) {
    return { ...emptySet("no-liquidity", fair), center, halfSpread: h, skew };
  }
  const down: Book = {
    bids: asks.map((a) => ({ price: round9(1 - a.price), size: a.size })).reverse(),
    asks: bids.map((b) => ({ price: round9(1 - b.price), size: b.size })).reverse(),
  };
  return { status: "quoting", fair, center, halfSpread: h, skew, up: { bids, asks }, down };
}

/** What the keeper last posted onchain. */
export type PostedQuote = { status: QuoteStatus; bestBid: number | null; bestAsk: number | null };

export function summarize(q: QuoteSet): PostedQuote {
  return {
    status: q.status,
    bestBid: q.up.bids[0]?.price ?? null,
    bestAsk: q.up.asks[0]?.price ?? null,
  };
}

/**
 * Keeper posting rule: publish the new quote set when none exists, when quoting starts or stops,
 * when the best bid or ask moved by at least `refreshTicks`, or when the posted quote is
 * `maxQuoteAgeBlocks` old. Every post costs gas, so staying quiet while quotes are still good is
 * how the vault keeps upkeep under its TVL budget (ADR-001 decision 3).
 */
export function shouldRepost(
  prev: PostedQuote | null,
  next: QuoteSet,
  ageBlocks: number,
  p: StrategyParams,
): boolean {
  if (prev === null) return true;
  if (prev.status !== next.status) return true;
  if (ageBlocks >= p.maxQuoteAgeBlocks) return true;
  const n = summarize(next);
  const moved = (a: number | null, b: number | null) =>
    a === null || b === null ? a !== b : Math.abs(a - b) >= p.refreshTicks * p.tick - 1e-9;
  return moved(prev.bestBid, n.bestBid) || moved(prev.bestAsk, n.bestAsk);
}
