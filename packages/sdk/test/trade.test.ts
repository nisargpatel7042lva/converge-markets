import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { forwardVenueAbi } from "../src/abi/generated";
import { WAD } from "../src/indexer-math";
import {
  ESCROW_SLACK,
  MAX_LIMIT_WAD,
  askFromLadder,
  formatUnits6,
  limitFor,
  parseUnits6,
  placeOrderTx,
  planBuy,
  priceToWad,
  roundPhase,
} from "../src/trade";

const MARKET = "0x00000000000000000000000000000000000000aa" as const;
const VENUE = "0x00000000000000000000000000000000000000bb" as const;

describe("amounts", () => {
  it("parses and formats collateral units", () => {
    expect(parseUnits6("12.5")).toBe(12_500_000n);
    expect(parseUnits6("0.000001")).toBe(1n);
    expect(parseUnits6(3)).toBe(3_000_000n);
    expect(() => parseUnits6("1.2345678")).toThrow();
    expect(() => parseUnits6("-1")).toThrow();
    expect(() => parseUnits6("abc")).toThrow();
    expect(formatUnits6(12_500_000n)).toBe("12.50");
    expect(formatUnits6(-1_234_567n, 4)).toBe("-1.2345");
    expect(formatUnits6(5n, 6)).toBe("0.000005");
  });
});

describe("limit and sizing", () => {
  it("never limits above 0.99 and never below the displayed price", () => {
    expect(limitFor(priceToWad(0.5), 100)).toBe(505_000_000_000_000_000n);
    expect(limitFor(priceToWad(0.985), 500)).toBe(MAX_LIMIT_WAD);
    expect(limitFor(priceToWad(0.995), 0)).toBe(priceToWad(0.995)); // above the cap: the price itself
    expect(() => limitFor(priceToWad(0.5), -1)).toThrow();
  });

  it("sizes shares so that the escrow never exceeds the budget", () => {
    for (const budget of [1_000_000n, 5_000_000n, 7_777_777n, 123_456_789n, 10n]) {
      for (const price of [0.05, 0.3, 0.5, 0.77, 0.97]) {
        for (const slip of [0, 50, 300]) {
          let p;
          try {
            p = planBuy({ side: "UP", budget, priceWad: priceToWad(price), slippageBps: slip });
          } catch {
            continue; // too small to buy a share
          }
          expect(p.escrow).toBeLessThanOrEqual(budget);
          expect(p.shares).toBeGreaterThan(0n);
          // one more share would not fit
          const more = ((p.shares + 1n) * p.limitWad + WAD - 1n) / WAD + ESCROW_SLACK;
          expect(more).toBeGreaterThan(budget);
        }
      }
    }
  });

  it("says what you win and lose", () => {
    const p = planBuy({
      side: "DOWN",
      budget: 5_000_000n,
      priceWad: priceToWad(0.5),
      slippageBps: 0,
      redeemFeeBps: 100,
    });
    expect(p.kind).toBe("BUY_DOWN");
    // 9.99 shares at 0.50: cost 4.995, pays 9.99 minus 1 % fee
    expect(p.shares).toBe(9_999_992n);
    expect(p.lossIfWrong).toBe(p.expectedCost);
    expect(p.payoutIfRight).toBe(p.shares - p.shares / 100n);
    expect(p.profitIfRight).toBe(p.payoutIfRight - p.expectedCost);
    expect(() =>
      planBuy({ side: "UP", budget: 3n, priceWad: priceToWad(0.5), slippageBps: 0 }),
    ).toThrow("too small");
  });
});

describe("ladder", () => {
  const ladder = {
    quoting: true,
    bids: [{ price: 480_000_000_000_000_000n, size: 5_000_000n }],
    asks: [{ price: 520_000_000_000_000_000n, size: 7_000_000n }],
  };
  it("reads the UP ask and the DOWN price (1 - best UP bid)", () => {
    expect(askFromLadder("UP", ladder)).toEqual({
      priceWad: 520_000_000_000_000_000n,
      sizeShares: 7_000_000n,
    });
    expect(askFromLadder("DOWN", ladder)).toEqual({
      priceWad: 520_000_000_000_000_000n,
      sizeShares: 5_000_000n,
    });
    expect(askFromLadder("UP", { ...ladder, quoting: false })).toBeNull();
    expect(askFromLadder("UP", { ...ladder, asks: [] })).toBeNull();
  });
});

describe("transactions", () => {
  it("encodes placeOrder with the reward as value", () => {
    const tx = placeOrderTx({
      venue: VENUE,
      market: MARKET,
      plan: { kind: "BUY_DOWN", shares: 3_000_000n, limitWad: 600_000_000_000_000_000n },
      reward: 10n ** 15n,
    });
    expect(tx.to).toBe(VENUE);
    expect(tx.value).toBe(10n ** 15n);
    const d = decodeFunctionData({ abi: forwardVenueAbi, data: tx.data });
    expect(d.functionName).toBe("placeOrder");
    expect((d.args as unknown as unknown[])[0]).toMatch(
      /^0x00000000000000000000000000000000000000[aA][aA]$/,
    );
    expect((d.args as unknown as unknown[]).slice(1)).toEqual([
      2,
      3_000_000n,
      600_000_000_000_000_000n,
    ]);
  });
});

describe("round phases", () => {
  it("maps the state and the clock", () => {
    const r = { start: 1000, end: 1900 };
    expect(roundPhase({ ...r, state: 0, now: 900 })).toEqual({ phase: "UPCOMING", startsIn: 100 });
    expect(roundPhase({ ...r, state: 1, now: 1500 })).toEqual({
      phase: "LIVE",
      endsIn: 400,
      closing: false,
    });
    expect(roundPhase({ ...r, state: 1, now: 1850 })).toEqual({
      phase: "LIVE",
      endsIn: 50,
      closing: true,
    });
    expect(roundPhase({ ...r, state: 1, now: 1950 })).toEqual({ phase: "RESOLVING" });
    expect(roundPhase({ ...r, state: 2, now: 2000 })).toEqual({ phase: "SETTLED", outcome: "UP" });
    expect(roundPhase({ ...r, state: 3, now: 2000 })).toEqual({
      phase: "SETTLED",
      outcome: "DOWN",
    });
    expect(roundPhase({ ...r, state: 4, now: 2000 })).toEqual({
      phase: "SETTLED",
      outcome: "INVALID",
    });
  });
});
