import { describe, expect, it } from "vitest";
import {
  baselineFor,
  dayOf,
  performance,
  SECONDS_PER_YEAR,
  windowPerformance,
} from "../src/lib/apy";
import {
  addEscrowShares,
  addShares,
  applyDepositClaim,
  applyRedeemClaim,
  emptyLp,
  lpHeld,
  lpUnrealized,
  moveLpCost,
} from "../src/lib/lp";

const WAD = 10n ** 18n;

describe("performance / APY", () => {
  it("doubling over exactly one year is 100% APY and 100% return", () => {
    const p = performance(
      { ppsWad: 2n * WAD, timestamp: SECONDS_PER_YEAR },
      { ppsWad: WAD, timestamp: 0 },
    );
    expect(p?.periodReturn).toBeCloseTo(1, 12);
    expect(p?.apy).toBeCloseTo(1, 12);
    expect(p?.elapsedSeconds).toBe(SECONDS_PER_YEAR);
  });

  it("compounds: +1% over 7 days annualises to 1.01^(365/7) - 1", () => {
    const week = 7 * 86_400;
    const p = performance(
      { ppsWad: (WAD * 101n) / 100n, timestamp: week },
      { ppsWad: WAD, timestamp: 0 },
    );
    expect(p?.periodReturn).toBeCloseTo(0.01, 12);
    expect(p?.apy).toBeCloseTo(Math.pow(1.01, 365 / 7) - 1, 9);
  });

  it("flat price is 0, a loss is negative, bad inputs are undefined", () => {
    expect(performance({ ppsWad: WAD, timestamp: 10 }, { ppsWad: WAD, timestamp: 0 })?.apy).toBe(0);
    expect(
      performance({ ppsWad: WAD / 2n, timestamp: 86_400 }, { ppsWad: WAD, timestamp: 0 })!
        .periodReturn,
    ).toBeCloseTo(-0.5, 12);
    expect(
      performance({ ppsWad: WAD, timestamp: 0 }, { ppsWad: WAD, timestamp: 0 }),
    ).toBeUndefined();
    expect(
      performance({ ppsWad: 0n, timestamp: 5 }, { ppsWad: WAD, timestamp: 0 }),
    ).toBeUndefined();
    expect(
      performance({ ppsWad: WAD, timestamp: 5 }, { ppsWad: 0n, timestamp: 0 }),
    ).toBeUndefined();
    // a one-second +50% jump would annualise to infinity: no value rather than Infinity
    expect(
      performance({ ppsWad: 2n * WAD, timestamp: 1 }, { ppsWad: WAD, timestamp: 0 }),
    ).toBeUndefined();
  });

  it("baseline = the last observation at or before now - window; none when history is too short", () => {
    const d = 86_400;
    const obs = [
      { ppsWad: 1n * WAD, timestamp: 0 },
      { ppsWad: 2n * WAD, timestamp: 3 * d },
      { ppsWad: 3n * WAD, timestamp: 6 * d },
      { ppsWad: 4n * WAD, timestamp: 9 * d },
    ];
    expect(baselineFor(obs, 10 * d, 7 * d)?.ppsWad).toBe(2n * WAD); // target day 3: exactly 3d counts
    expect(baselineFor(obs, 10 * d, 11 * d)).toBeUndefined();
    expect(
      windowPerformance(obs, { ppsWad: 5n * WAD, timestamp: 10 * d }, 7 * d)?.periodReturn,
    ).toBeCloseTo(1.5, 12);
  });

  it("dayOf buckets by UTC day", () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(86_399)).toBe(0);
    expect(dayOf(86_400)).toBe(1);
  });
});

describe("LP accounting", () => {
  it("deposit, partial redeem, realized and unrealized PnL (hand-checked)", () => {
    // Deposit 1000 USDC (1000e6) for 1000e6 shares.
    let s = applyDepositClaim(emptyLp(), 1_000_000_000n);
    s = addShares(s, 1_000_000_000n);
    // Request redeem of 400 shares: they move into custody (escrow).
    s = addEscrowShares(addShares(s, -400_000_000n), 400_000_000n);
    expect(lpHeld(s)).toBe(1_000_000_000n);
    // Settled at pps 1.10: 400 shares burned for 440 USDC.
    s = applyRedeemClaim(s, 400_000_000n, 440_000_000n);
    expect(s.realizedPnl).toBe(40_000_000n);
    expect(s.costBasis).toBe(600_000_000n);
    expect(s.escrowedShares).toBe(0n);
    expect(s.totalWithdrawn).toBe(440_000_000n);
    // The 600 shares left are worth 660 at 1.10: +60 unrealized
    expect(lpUnrealized(s, (11n * WAD) / 10n)).toBe(60_000_000n);
  });

  it("a requeued remainder stays in escrow", () => {
    let s = applyDepositClaim(emptyLp(), 1000n);
    s = addShares(s, 1000n);
    s = addEscrowShares(addShares(s, -1000n), 1000n);
    s = applyRedeemClaim(s, 250n, 300n); // 250 of 1000 shares filled, 750 requeued
    expect(s.escrowedShares).toBe(750n);
    expect(s.costBasis).toBe(750n);
    expect(s.realizedPnl).toBe(50n);
  });

  it("share transfers carry cost between ordinary LPs", () => {
    let a = applyDepositClaim(emptyLp(), 1000n);
    a = addShares(a, 1000n);
    let b = emptyLp();
    [a, b] = moveLpCost(a, b, 250n);
    a = addShares(a, -250n);
    b = addShares(b, 250n);
    expect([a.costBasis, b.costBasis]).toEqual([750n, 250n]);
  });
});
