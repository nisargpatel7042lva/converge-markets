/**
 * TypeScript twin of `contracts/src/vault/QuoteMath.sol` (the on-chain pricing of the forward-priced
 * venue, ADR-004). Same algorithm, in floating point; golden vectors generated from this file are
 * checked against the Solidity in `contracts/test/QuoteMath.t.sol`.
 *
 * Differences from `generateQuotes` (see docs/phases/PHASE-4-plan.md): no toxicity guard; the
 * ladder is spaced in z-space (price = Φ(z), size = L_t·Δz); risk room is computed from token
 * balances, a premium accumulator and a collateral basis.
 */
import { clamp, normCdf, normPdf } from "./math";
import { SECONDS_PER_YEAR } from "./prob";

export type OnchainParams = {
  minHalfSpread: number;
  maxHalfSpread: number;
  volSpreadK: number;
  stalenessSec: number;
  inventorySkewMax: number;
  inventorySkewK: number;
  noQuoteWindowSec: number;
  priceMin: number;
  priceMax: number;
  tick: number;
  levels: number;
  baseRangeTicks: number;
  minRangeTicks: number;
  liquidityNavFraction: number;
  minLevelSize: number;
  perMarketMaxFraction: number;
  totalAtRiskMaxFraction: number;
};

/** basis: collateral split minus merged; cash: premium received minus paid; up/down: balances. */
export type Pos = { basis: number; cash: number; up: number; down: number };
export type OnchainLevel = { price: number; size: number };
export type OnchainQuote = {
  quoting: boolean;
  fair: number;
  halfSpread: number;
  skew: number;
  bids: OnchainLevel[];
  asks: OnchainLevel[];
};

const D2_MAX = 100;
const MIN_STD = 1e-12;
const PHI_FLOOR = 1e-6;
const DZ_MAX = 1;
const PROB_MIN = 1e-6;
const PROB_MAX = 1 - 1e-6;

export function onchainD2(spot: number, strike: number, sigma: number, tauSec: number): number {
  const m = Math.log(spot / strike);
  const std = sigma * Math.sqrt(tauSec / SECONDS_PER_YEAR);
  if (std < MIN_STD) return m >= 0 ? D2_MAX : -D2_MAX;
  return clamp((m - 0.5 * std * std) / std, -D2_MAX, D2_MAX);
}

export function lossOf(p: Pos): number {
  return Math.max(0, p.basis - p.cash - Math.min(p.up, p.down));
}

export function lossCeilingOf(
  p: Pos,
  nav: number,
  otherAtRisk: number,
  q: Pick<OnchainParams, "perMarketMaxFraction" | "totalAtRiskMaxFraction">,
): number {
  const perMarket = q.perMarketMaxFraction * nav;
  const totalRoom = Math.max(0, q.totalAtRiskMaxFraction * nav - otherAtRisk);
  return Math.max(Math.min(perMarket, totalRoom), lossOf(p));
}

/** Shares of a token the vault can still SELL (own balance `own`, opposite token `other`). */
export function sellRoomOf(
  basis: number,
  cash: number,
  own: number,
  other: number,
  price: number,
  ceiling: number,
): number {
  if (price >= 1 || own === 0) return 0;
  const num = ceiling - basis + cash + own;
  const bound = num > 0 ? num / (1 - price) : 0;
  const free = own > other ? own - other : 0;
  return Math.min(own, Math.max(bound, free));
}

/** Shares of a token the vault can still BUY. */
export function buyRoomOf(
  basis: number,
  cash: number,
  own: number,
  other: number,
  price: number,
  ceiling: number,
): number {
  if (price === 0) return 0;
  const num = ceiling - basis + cash + other;
  const bound = num > 0 ? num / price : 0;
  const free = other > own ? other - own : 0;
  return Math.max(bound, free);
}

export function onchainQuote(
  spot: number,
  strike: number,
  sigma: number,
  tauSec: number,
  roundSec: number,
  nav: number,
  pos: Pos,
  q: OnchainParams,
): OnchainQuote {
  const out: OnchainQuote = { quoting: false, fair: 0, halfSpread: 0, skew: 0, bids: [], asks: [] };
  if (!(spot > 0 && strike > 0 && nav > 0 && roundSec > 0) || tauSec <= q.noQuoteWindowSec)
    return out;
  const x = onchainD2(spot, strike, sigma, tauSec);
  const p0 = normCdf(x);
  const phi = normPdf(x);
  out.fair = clamp(p0, PROB_MIN, PROB_MAX);

  const stale = q.volSpreadK * phi * Math.sqrt(q.stalenessSec / tauSec);
  const h = Math.max(q.minHalfSpread, stale);
  out.halfSpread = clamp(h, q.minHalfSpread, q.maxHalfSpread);

  const ref = 2 * q.perMarketMaxFraction * nav;
  const f = ref === 0 ? 0 : -(pos.up - pos.down) / ref;
  const lim = 0.8 * out.halfSpread;
  out.skew = clamp(q.inventorySkewMax * Math.tanh(q.inventorySkewK * f), -lim, lim);
  const center = out.fair + out.skew;

  const ratio = Math.min(tauSec / roundSec, 1);
  const root = Math.sqrt(ratio);
  const spanTicks = Math.max(q.minRangeTicks, q.baseRangeTicks * root);
  const stepTicks = q.levels > 1 ? Math.max(1, Math.ceil(spanTicks / (q.levels - 1) - 1e-9)) : 1;
  const band = stepTicks * q.tick;
  const dz = Math.min(band / Math.max(phi, PHI_FLOOR), DZ_MAX);
  const lt = q.liquidityNavFraction * nav * root;
  const levelSize = lt * dz;
  if (levelSize < Math.max(q.minLevelSize, 1e-18)) return out;
  out.quoting = true;

  for (let j = 0; j < q.levels; j++) {
    const raw = center - out.halfSpread - (p0 - normCdf(x - j * dz));
    if (raw <= 0) break;
    const price = Math.floor(raw / q.tick + 1e-9) * q.tick;
    if (price < q.priceMin) break;
    if (price > q.priceMax) continue;
    const lastB = out.bids[out.bids.length - 1];
    if (lastB && lastB.price === price) lastB.size += levelSize;
    else out.bids.push({ price, size: levelSize });
  }
  for (let j = 0; j < q.levels; j++) {
    const raw = center + out.halfSpread + (normCdf(x + j * dz) - p0);
    if (raw <= 0) continue;
    const price = Math.ceil(raw / q.tick - 1e-9) * q.tick;
    if (price > q.priceMax) break;
    if (price < q.priceMin) continue;
    const lastA = out.asks[out.asks.length - 1];
    if (lastA && lastA.price === price) lastA.size += levelSize;
    else out.asks.push({ price, size: levelSize });
  }
  return out;
}
