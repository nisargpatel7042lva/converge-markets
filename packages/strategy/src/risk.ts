/**
 * Position and risk functions. A market position is expressed in the UP token only (DOWN is the
 * complement): `cash` is premium received minus premium paid, `shortUp` is shares sold minus
 * shares bought (negative = long UP). Settlement P&L is cash − shortUp if UP wins, cash if DOWN
 * wins (an INVALID market pays 0.5 per token, handled by the caller).
 */
export type Position = { cash: number; shortUp: number };

export type RiskLimits = {
  /** Max loss allowed in one market, as a fraction of NAV (CLAUDE.md default 5%). */
  perMarketMaxFraction: number;
  /** Max loss allowed across all markets, as a fraction of NAV (default 40%). */
  totalAtRiskMaxFraction: number;
};

export function pnlIfUp(pos: Position): number {
  return pos.cash - pos.shortUp;
}

export function pnlIfDown(pos: Position): number {
  return pos.cash;
}

/** Worst-case loss of a market position, in collateral (0 when the position can't lose). */
export function maxLoss(pos: Position): number {
  return Math.max(0, -Math.min(pnlIfUp(pos), pnlIfDown(pos)));
}

/** Net exposure of a market in shares (positive = short UP / long DOWN). */
export function marketExposure(pos: Position): number {
  return pos.shortUp;
}

/** Total at-risk: the sum of worst-case losses across markets. */
export function totalAtRisk(positions: readonly Position[]): number {
  let sum = 0;
  for (const p of positions) sum += maxLoss(p);
  return sum;
}

/**
 * The loss ceiling for one market given NAV and the other markets' at-risk: the tighter of the
 * per-market and the total limit, but never below the market's current loss (so a position
 * already over its limit can reduce risk yet never add any).
 */
export function lossCeiling(
  pos: Position,
  nav: number,
  otherAtRisk: number,
  limits: RiskLimits,
): number {
  const perMarket = limits.perMarketMaxFraction * nav;
  const totalRoom = limits.totalAtRiskMaxFraction * nav - otherAtRisk;
  return Math.max(Math.min(perMarket, totalRoom), maxLoss(pos));
}

/**
 * Shares the vault can still sell at `price` (UP) before the market's worst-case loss would
 * exceed `ceiling`. Selling u at price a gives loss max(s+u, 0) − (c + a·u); on its rising branch
 * the bound is u ≤ (ceiling + c − s)/(1 − a).
 */
export function sellRoom(pos: Position, price: number, ceiling: number): number {
  if (!(price < 1)) return 0;
  return Math.max(0, (ceiling + pos.cash - pos.shortUp) / (1 - price));
}

/**
 * Shares the vault can still buy at `price`: buying u gives loss max(s−u, 0) − (c − b·u), whose
 * rising branch (after the short is covered) bounds u ≤ (ceiling + c)/b.
 */
export function buyRoom(pos: Position, price: number, ceiling: number): number {
  if (!(price > 0)) return 0;
  return Math.max(0, (ceiling + pos.cash) / price);
}

/** Applies a fill to a position. `side` is from the vault's view: "sell" = sells UP shares. */
export function applyFill(
  pos: Position,
  side: "sell" | "buy",
  price: number,
  shares: number,
): Position {
  return side === "sell"
    ? { cash: pos.cash + price * shares, shortUp: pos.shortUp + shares }
    : { cash: pos.cash - price * shares, shortUp: pos.shortUp - shares };
}

export type BreakerState = { tripped: boolean; drawdown: number };

/**
 * Daily NAV drawdown circuit breaker (CLAUDE.md: 5%). It only ever pauses quoting; withdrawals
 * and merge/redeem are unaffected. `dayStartNav` is NAV at the start of the UTC day.
 */
export function drawdownBreaker(
  dayStartNav: number,
  nav: number,
  limitFraction: number,
): BreakerState {
  if (!(dayStartNav > 0)) return { tripped: true, drawdown: 1 };
  const drawdown = Math.max(0, (dayStartNav - nav) / dayStartNav);
  return { tripped: drawdown >= limitFraction, drawdown };
}
