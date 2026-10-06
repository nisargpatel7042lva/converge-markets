import { normCdf, onchainD2, type OnchainParams } from "@converge/strategy";
import type { MarketInfo, VaultState } from "./chain/vault";
import { MARKET_STATE } from "./chain/vault";
import type { InventoryView } from "./risk";

const U = 1e6; // asset units per dollar

const pairs = (m: MarketInfo) => Math.min(Number(m.upBal), Number(m.downBal)) / U;
const excess = (m: MarketInfo) => (Number(m.upBal) - Number(m.downBal)) / U; // + = UP heavy

/** Worst-case loss of a registered market, in dollars (the vault's own definition). */
export function lossUsd(m: MarketInfo): number {
  return Math.max(0, (Number(m.basis) - Number(m.cash)) / U - pairs(m));
}

/**
 * How much of the vault's own limits the inventory uses. The vault will refuse fills beyond its
 * ceilings; the keeper pulls its quotes earlier (at `inventoryLossRatioCap` of them) so it never
 * runs into the wall.
 */
export function inventoryView(s: VaultState): InventoryView | null {
  const nav = Number(s.navLower) / U;
  if (nav <= 0) return null;
  const perCap = s.params.perMarketMaxFraction * nav;
  const totalCap = s.params.totalAtRiskMaxFraction * nav;
  let maxLoss = 0;
  let total = 0;
  let exc = 0;
  for (const m of s.markets) {
    if (!m.registered) continue;
    const l = lossUsd(m);
    maxLoss = Math.max(maxLoss, l);
    total += l;
    if (m.state === MARKET_STATE.OPEN) exc += Math.abs(excess(m));
  }
  return {
    maxLossRatio: perCap > 0 ? maxLoss / perCap : 0,
    totalLossRatio: totalCap > 0 ? total / totalCap : 0,
    excessNavFraction: exc / nav,
  };
}

/** Fair probability of UP now: Phi(d2). */
export function fairUp(spot: number, strike: number, sigma: number, tauSec: number): number {
  if (!(spot > 0 && strike > 0 && sigma > 0)) return 0.5;
  if (tauSec <= 0) return spot >= strike ? 1 : 0;
  return normCdf(onchainD2(spot, strike, sigma, tauSec));
}

/**
 * Profit and loss of one market in dollars: premium collected minus collateral put in, plus what
 * the tokens held are worth. Open round: pairs at 1, the spare side at its fair probability.
 * Resolved: exact (the winner pays 1 less the redeem fee). Invalid: half.
 */
export function marketPnl(m: MarketInfo, fairUpNow: number | null): number {
  const base = (Number(m.cash) - Number(m.basis)) / U;
  const p = pairs(m);
  const e = excess(m);
  const fee = m.redeemFeeBps / 10_000;
  switch (m.state) {
    case MARKET_STATE.RESOLVED_UP:
      return base + p + (e > 0 ? e * (1 - fee) : 0);
    case MARKET_STATE.RESOLVED_DOWN:
      return base + p + (e < 0 ? -e * (1 - fee) : 0);
    case MARKET_STATE.INVALID:
      return base + p + (Math.abs(e) / 2) * (1 - fee);
    default: {
      const f = fairUpNow ?? 0.5;
      return base + p + (e > 0 ? e * f : -e * (1 - f));
    }
  }
}

export type PnlSnapshot = { realized: number; unrealized: number; perMarket: Map<string, number> };

/**
 * Accumulates realized P&L: a round's P&L becomes realized once it has resolved (the last value
 * seen while it was still registered is final), then stays counted after redeemResolved removes
 * it from the registry. Unrealized is the rest, marked at fair.
 */
export class PnlTracker {
  private readonly settled = new Map<string, number>();
  private readonly lastSeen = new Map<string, { pnl: number; resolved: boolean }>();

  update(s: VaultState, fair: (m: MarketInfo) => number | null): PnlSnapshot {
    const present = new Set<string>();
    const perMarket = new Map<string, number>();
    let unrealized = 0;
    for (const m of s.markets) {
      if (!m.registered) continue;
      const key = m.address.toLowerCase();
      present.add(key);
      const resolved =
        m.state === MARKET_STATE.RESOLVED_UP ||
        m.state === MARKET_STATE.RESOLVED_DOWN ||
        m.state === MARKET_STATE.INVALID;
      const pnl = marketPnl(m, fair(m));
      perMarket.set(key, pnl);
      this.lastSeen.set(key, { pnl, resolved });
      if (resolved) this.settled.set(key, pnl);
      else unrealized += pnl;
    }
    // a registered round that left the registry after resolving keeps its final P&L
    for (const [key, v] of this.lastSeen) {
      if (!present.has(key) && v.resolved) this.settled.set(key, v.pnl);
    }
    let realized = 0;
    for (const v of this.settled.values()) realized += v;
    return { realized, unrealized, perMarket };
  }
}

/** Parameters of the venue's ladder check in the spirit of the on-chain bounds. */
export function ladderViolations(
  q: { quoting: boolean; fair: number; bids: { price: number }[]; asks: { price: number }[] },
  p: Pick<OnchainParams, "priceMin" | "priceMax" | "tick">,
): string[] {
  const out: string[] = [];
  if (!q.quoting) return out;
  const eps = 1e-9;
  const onGrid = (x: number) => Math.abs(x / p.tick - Math.round(x / p.tick)) < 1e-6;
  const bb = q.bids[0]?.price;
  const ba = q.asks[0]?.price;
  if (bb !== undefined && ba !== undefined && bb >= ba - eps) out.push("CROSSED");
  if (bb !== undefined && bb > q.fair + eps) out.push("BID_ABOVE_FAIR");
  if (ba !== undefined && ba < q.fair - eps) out.push("ASK_BELOW_FAIR");
  for (const l of [...q.bids, ...q.asks]) {
    if (l.price < p.priceMin - eps || l.price > p.priceMax + eps) out.push("OUT_OF_BOUNDS");
    if (!onGrid(l.price)) out.push("OFF_GRID");
  }
  for (let i = 1; i < q.bids.length; i++)
    if ((q.bids[i] as { price: number }).price >= (q.bids[i - 1] as { price: number }).price)
      out.push("BIDS_NOT_DESCENDING");
  for (let i = 1; i < q.asks.length; i++)
    if ((q.asks[i] as { price: number }).price <= (q.asks[i - 1] as { price: number }).price)
      out.push("ASKS_NOT_ASCENDING");
  return [...new Set(out)];
}
