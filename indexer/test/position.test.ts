import { describe, expect, it } from "vitest";
import {
  addBalance,
  addEscrow,
  applyBuyFill,
  applyMerge,
  applyRedeem,
  applySellFill,
  applySplit,
  costBasis,
  emptyState,
  held,
  moveCost,
  positionValue,
  proportionalCost,
  releaseEscrow,
  unrealizedPnl,
  type PositionState,
} from "../src/lib/position";

const WAD = 10n ** 18n;

describe("proportionalCost", () => {
  it("floors, never exceeds the total, handles degenerate inputs", () => {
    expect(proportionalCost(1000n, 300n, 100n)).toBe(333n); // 333.33 -> 333
    expect(proportionalCost(1000n, 300n, 300n)).toBe(1000n);
    expect(proportionalCost(1000n, 300n, 999n)).toBe(1000n); // amount above holding: all cost, no more
    expect(proportionalCost(1000n, 0n, 5n)).toBe(0n);
    expect(proportionalCost(0n, 100n, 5n)).toBe(0n);
    expect(proportionalCost(1000n, 300n, 0n)).toBe(0n);
  });
});

describe("split / merge", () => {
  it("allocates a split 50/50 (UP takes the odd unit) and merges at zero PnL", () => {
    let s = applySplit(emptyState(), 101n);
    s = addBalance(addBalance(s, "up", 101n), "down", 101n);
    expect([s.upCost, s.downCost, s.totalIn]).toEqual([51n, 50n, 101n]);
    s = applyMerge(s, 101n); // the whole pair back for exactly what it cost
    expect(s.realizedPnl).toBe(0n);
    expect(costBasis(s)).toBe(0n);
    expect(s.totalOut).toBe(101n);
  });

  it("a partial merge removes cost in proportion and books proceeds - removed cost", () => {
    // 10 USDC split, then 4 UP sold elsewhere (zero cost transfer out is not modelled): merge 5 pairs
    let s = applySplit(emptyState(), 10_000_000n);
    s = addBalance(addBalance(s, "up", 10_000_000n), "down", 10_000_000n);
    s = applyMerge(s, 5_000_000n);
    expect(s.upCost).toBe(2_500_000n);
    expect(s.downCost).toBe(2_500_000n);
    expect(s.realizedPnl).toBe(0n);
  });
});

describe("fills", () => {
  it("hand-checked buy then partial sell (Phase 4 E2E style numbers)", () => {
    // Buy 10 UP for 5.50 USDC. The Transfer (vault -> taker) adds the balance, the Fill adds the cost.
    let s = addBalance(emptyState(), "up", 10_000_000n);
    s = applyBuyFill(s, "up", 5_500_000n);
    expect(s.upCost).toBe(5_500_000n);
    expect(s.totalIn).toBe(5_500_000n);
    // Place a sell order for 4 UP: tokens leave the wallet into escrow.
    s = addBalance(s, "up", -4_000_000n);
    s = addEscrow(s, "up", 4_000_000n);
    expect(held(s, "up")).toBe(10_000_000n); // still economically held
    // The fill sells all 4 for 2.40 USDC: removed cost = 5.5 * 4/10 = 2.2
    s = applySellFill(s, "up", 4_000_000n, 2_400_000n);
    expect(s.realizedPnl).toBe(200_000n); // +0.20 USDC
    expect(s.upCost).toBe(3_300_000n);
    expect(s.upEscrowed).toBe(0n);
    expect(s.tradeCount).toBe(2);
    // Held 6 UP at 0.55 = 3.30: unrealized at 0.60 is +0.30
    expect(unrealizedPnl(s, { kind: "live", upPriceWad: (60n * WAD) / 100n })).toBe(300_000n);
  });

  it("a partially filled sell releases only the unfilled remainder on OrderExecuted", () => {
    let s = addBalance(emptyState(), "down", 8n);
    s = applyBuyFill(s, "down", 4n);
    s = addBalance(addEscrow(s, "down", 8n), "down", -8n);
    s = applySellFill(s, "down", 3n, 2n); // 3 of 8 filled
    expect(s.downEscrowed).toBe(5n);
    s = releaseEscrow(s, "down", 5n); // refund of the rest (OrderExecuted: shares - filled)
    s = addBalance(s, "down", 5n); // refund Transfer
    expect(s.downEscrowed).toBe(0n);
    expect(held(s, "down")).toBe(5n);
    expect(s.downCost).toBe(4n - 1n); // removed floor(4*3/8) = 1
  });
});

describe("redeem", () => {
  it("winner redeems at 1:1 net of fee, loser side is written off", () => {
    // 10 UP bought at 5.5, 4 DOWN bought at 1.6; UP wins, 1% fee on the payout.
    let s = addBalance(emptyState(), "up", 10_000_000n);
    s = applyBuyFill(s, "up", 5_500_000n);
    s = addBalance(s, "down", 4_000_000n);
    s = applyBuyFill(s, "down", 1_600_000n);
    const payoutGross = 10_000_000n;
    const net = payoutGross - (payoutGross * 100n) / 10_000n;
    s = applyRedeem(s, 10_000_000n, 4_000_000n, net);
    expect(s.realizedPnl).toBe(net - 7_100_000n); // 9.9 - 7.1 = +2.8
    expect(costBasis(s)).toBe(0n);
  });

  it("an INVALID market pays half a token: modelled by the contract's payout figure", () => {
    let s = addBalance(emptyState(), "up", 10n);
    s = applyBuyFill(s, "up", 6n);
    s = applyRedeem(s, 10n, 0n, 5n);
    expect(s.realizedPnl).toBe(-1n);
  });
});

describe("transfers", () => {
  it("cost travels with tokens between ordinary holders", () => {
    let a = addBalance(emptyState(), "up", 10n);
    a = applyBuyFill(a, "up", 6n);
    let b = emptyState();
    [a, b] = moveCost(a, b, "up", 5n);
    a = addBalance(a, "up", -5n);
    b = addBalance(b, "up", 5n);
    expect(a.upCost).toBe(3n);
    expect(b.upCost).toBe(3n);
    expect(held(a, "up")).toBe(5n);
    expect(held(b, "up")).toBe(5n);
  });

  it("a balance is NOT clamped: an indexing gap shows up as a negative number the reconciliation reports", () => {
    expect(addBalance(emptyState(), "up", -5n).upBalance).toBe(-5n);
  });
});

describe("valuation", () => {
  it("resolved markets value held tokens exactly", () => {
    const s: PositionState = { ...emptyState(), upBalance: 7n, downBalance: 3n, upEscrowed: 1n };
    expect(positionValue(s, { kind: "resolved", outcome: "UP" })).toBe(8n);
    expect(positionValue(s, { kind: "resolved", outcome: "DOWN" })).toBe(3n);
    expect(positionValue(s, { kind: "resolved", outcome: "INVALID" })).toBe(5n); // (8 + 3) / 2 floored
  });
});

/** Deterministic PRNG so the property test is reproducible. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("conservation property", () => {
  it("costBasis == totalIn - totalOut + realizedPnl after any sequence of ops (no rounding leak)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      let s = emptyState();
      for (let i = 0; i < 60; i++) {
        const op = Math.floor(r() * 6);
        const amt = BigInt(1 + Math.floor(r() * 9_999));
        const k = r() < 0.5 ? ("up" as const) : ("down" as const);
        if (op === 0) {
          s = addBalance(addBalance(applySplit(s, amt), "up", amt), "down", amt);
        } else if (op === 1) {
          const m = amt < held(s, "up") && amt < held(s, "down") ? amt : 0n;
          if (m > 0n) {
            s = applyMerge(s, m);
            s = addBalance(addBalance(s, "up", -m), "down", -m);
          }
        } else if (op === 2) {
          s = addBalance(applyBuyFill(s, k, amt), k, amt);
        } else if (op === 3) {
          const have = k === "up" ? s.upBalance : s.downBalance;
          const sz = have > 0n ? 1n + (amt % have) : 0n;
          if (sz > 0n) {
            s = addEscrow(addBalance(s, k, -sz), k, sz);
            s = applySellFill(s, k, sz, amt);
          }
        } else if (op === 4) {
          const u = s.upBalance;
          const d = s.downBalance;
          s = applyRedeem(s, u, d, (amt * (u + d)) / 10_000n);
          s = addBalance(addBalance(s, "up", -u), "down", -d);
        }
        expect(costBasis(s)).toBe(s.totalIn - s.totalOut + s.realizedPnl);
        expect(s.upCost >= 0n && s.downCost >= 0n).toBe(true);
        expect(held(s, "up") >= 0n && held(s, "down") >= 0n).toBe(true);
      }
    }
  });
});
