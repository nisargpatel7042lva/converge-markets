import { describe, expect, it } from "vitest";
import {
  PnlTracker,
  fairUp,
  inventoryView,
  ladderViolations,
  lossUsd,
  marketPnl,
} from "../../src/inventory";
import { MKT, USDC, market, state } from "./fixtures";

describe("lossUsd / inventoryView", () => {
  it("matches the vault's worst-case loss: basis - cash - min(up, down)", () => {
    // sold 10 UP at 0.55: basis 100, cash 5.5, UP 90, DOWN 100 -> 100 - 5.5 - 90 = 4.5
    const m = market({ basis: USDC(100), cash: USDC(5.5), upBal: USDC(90), downBal: USDC(100) });
    expect(lossUsd(m)).toBeCloseTo(4.5, 9);
    expect(lossUsd(market({ basis: USDC(10), cash: USDC(20), upBal: 0n, downBal: 0n }))).toBe(0);
  });

  it("measures the loss against the per-market and total ceilings and the lopsidedness", () => {
    // NAV 1000: per-market ceiling 10, total 80
    const s = state({
      markets: [
        market({
          address: MKT(1),
          basis: USDC(100),
          cash: USDC(5.5),
          upBal: USDC(90),
          downBal: USDC(100),
        }),
        market({
          address: MKT(2),
          basis: USDC(100),
          cash: USDC(10),
          upBal: USDC(95),
          downBal: USDC(100),
        }),
      ],
    });
    const v = inventoryView(s);
    expect(v?.maxLossRatio).toBeCloseTo(0.45, 6);
    expect(v?.totalLossRatio).toBeCloseTo((4.5 + 0) / 80, 6);
    expect(v?.excessNavFraction).toBeCloseTo(15 / 1000, 9);
  });

  it("returns null without a NAV and ignores unregistered rounds", () => {
    expect(inventoryView(state({ navLower: 0n }))).toBeNull();
    const s = state({
      markets: [market({ registered: false, basis: USDC(100), upBal: 0n, downBal: 0n })],
    });
    expect(inventoryView(s)?.maxLossRatio).toBe(0);
  });
});

describe("fairUp / marketPnl", () => {
  it("is 1/2 at the money and decided after the end", () => {
    expect(fairUp(3000, 3000, 0.6, 600)).toBeCloseTo(0.4995, 3);
    expect(fairUp(3100, 3000, 0.6, 0)).toBe(1);
    expect(fairUp(2900, 3000, 0.6, 0)).toBe(0);
    expect(fairUp(0, 3000, 0.6, 100)).toBe(0.5);
  });

  const sold = { basis: USDC(100), cash: USDC(5.5), upBal: USDC(90), downBal: USDC(100) };
  it("marks an open round: pairs at 1, the spare side at fair", () => {
    // 90 pairs + 10 spare DOWN at fair DOWN 0.5 -> 5.5 - 100 + 90 + 5 = 0.5
    expect(marketPnl(market(sold), 0.5)).toBeCloseTo(0.5, 9);
    // UP very likely: the spare DOWN is nearly worthless -> -4.5
    expect(marketPnl(market(sold), 0.999)).toBeCloseTo(-4.49, 2);
  });

  it("is exact after resolution", () => {
    expect(marketPnl(market({ ...sold, state: 2 }), null)).toBeCloseTo(-4.5, 9); // UP won
    expect(marketPnl(market({ ...sold, state: 3 }), null)).toBeCloseTo(5.5, 9); // DOWN won
    expect(marketPnl(market({ ...sold, state: 4 }), null)).toBeCloseTo(0.5, 9); // invalid: spare pays half
    expect(marketPnl(market({ ...sold, state: 3, redeemFeeBps: 100 }), null)).toBeCloseTo(5.4, 9); // 1% fee on the 10
  });
});

describe("PnlTracker", () => {
  const sold = { basis: USDC(100), cash: USDC(5.5), upBal: USDC(90), downBal: USDC(100) };
  it("keeps a resolved round's P&L after it leaves the registry", () => {
    const t = new PnlTracker();
    let r = t.update(state({ markets: [market(sold)] }), () => 0.5);
    expect(r.realized).toBe(0);
    expect(r.unrealized).toBeCloseTo(0.5, 9);
    r = t.update(state({ markets: [market({ ...sold, state: 2 })] }), () => null); // UP won, not yet redeemed
    expect(r.realized).toBeCloseTo(-4.5, 9);
    expect(r.unrealized).toBe(0);
    r = t.update(state({ markets: [] }), () => null); // redeemResolved removed it
    expect(r.realized).toBeCloseTo(-4.5, 9);
    r = t.update(state({ markets: [market({ address: MKT(2), ...sold })] }), () => 0.5);
    expect(r.realized).toBeCloseTo(-4.5, 9);
    expect(r.unrealized).toBeCloseTo(0.5, 9);
  });

  it("does not realize a round that merely disappeared while open", () => {
    const t = new PnlTracker();
    t.update(state({ markets: [market(sold)] }), () => 0.5);
    expect(t.update(state({ markets: [] }), () => null).realized).toBe(0);
  });
});

describe("ladderViolations", () => {
  const p = { priceMin: 0.02, priceMax: 0.98, tick: 0.01 };
  const q = (bids: number[], asks: number[], fair = 0.5, quoting = true) => ({
    quoting,
    fair,
    bids: bids.map((price) => ({ price })),
    asks: asks.map((price) => ({ price })),
  });

  it("accepts a normal ladder and an unquoted market", () => {
    expect(ladderViolations(q([0.44, 0.43], [0.55, 0.56]), p)).toEqual([]);
    expect(ladderViolations(q([0.9], [0.1], 0.5, false), p)).toEqual([]);
  });

  it("flags each kind of defect", () => {
    expect(ladderViolations(q([0.55], [0.55]), p)).toContain("CROSSED");
    expect(ladderViolations(q([0.6], [0.7], 0.5), p)).toContain("BID_ABOVE_FAIR");
    expect(ladderViolations(q([0.3], [0.4], 0.5), p)).toContain("ASK_BELOW_FAIR");
    expect(ladderViolations(q([0.01], [0.55]), p)).toContain("OUT_OF_BOUNDS");
    expect(ladderViolations(q([0.44], [0.99]), p)).toContain("OUT_OF_BOUNDS");
    expect(ladderViolations(q([0.445], [0.55]), p)).toContain("OFF_GRID");
    expect(ladderViolations(q([0.43, 0.44], [0.55]), p)).toContain("BIDS_NOT_DESCENDING");
    expect(ladderViolations(q([0.44], [0.56, 0.55]), p)).toContain("ASKS_NOT_ASCENDING");
  });
});
