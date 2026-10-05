import { clamp, normInv } from "./math";

/**
 * Dynamic pm-AMM liquidity schedule.
 *
 * Source: Paradigm, "pm-AMM: A Uniform AMM for Prediction Markets" (Nov 2024),
 * https://www.paradigm.xyz/2024/11/pm-amm, section "Dynamic pm-AMM", subsection "Constant LVR":
 *   - liquidity is withdrawn as L_t = L·√(T − t), which makes the pool's expected LVR constant
 *     over the remaining time;
 *   - the dynamic invariant is (y−x)·Φ((y−x)/(L√(T−t))) + L√(T−t)·φ((y−x)/(L√(T−t))) − y = 0;
 *   - at price P the reserve difference satisfies y* − x* = L_t·Φ⁻¹(P), and pool value is
 *     V(P, t) = L_t·φ(Φ⁻¹(P)).
 * We keep the paper's liquidity curve and its reserve geometry, but anchor the price to the
 * oracle (ADR-001, Option D) instead of letting arbitrage move it.
 */

/** L_t / L = √(τ/T), in [0, 1]. τ = seconds to expiry, T = round length in seconds. */
export function liquidityScale(tauSec: number, roundSec: number): number {
  if (!(roundSec > 0)) throw new RangeError("roundSec must be > 0");
  return Math.sqrt(clamp(tauSec / roundSec, 0, 1));
}

/**
 * Shares (outcome tokens) a pm-AMM with liquidity `lt` trades to move its price between two
 * probabilities, from y* − x* = L_t·Φ⁻¹(P): exactly L_t·|Φ⁻¹(p1) − Φ⁻¹(p0)|.
 */
export function pmAmmShares(p0: number, p1: number, lt: number): number {
  if (!(lt >= 0)) throw new RangeError("lt must be >= 0");
  return lt * Math.abs(normInv(p1) - normInv(p0));
}

/**
 * Ladder range in ticks: narrows with √(τ/T) as the round ages ("narrowing its range as each
 * market approaches expiry", CLAUDE.md) but never below the concentration floor `minRangeTicks`.
 */
export function rangeTicks(
  tauSec: number,
  roundSec: number,
  baseRangeTicks: number,
  minRangeTicks: number,
): number {
  return Math.max(minRangeTicks, baseRangeTicks * liquidityScale(tauSec, roundSec));
}
