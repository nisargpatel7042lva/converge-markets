import { describe, expect, it } from "vitest";
import { buildQuote, DEFAULT_POLICY, fromTicks, needsRequote, toTicks } from "../src/kuru";

describe("toTicks", () => {
  it("rounds bids down and asks up onto the 10-unit grid", () => {
    expect(toTicks(0.5, "bid")).toBe(5000);
    expect(toTicks(0.50011, "bid")).toBe(5000);
    expect(toTicks(0.50011, "ask")).toBe(5010);
  });
  it("round-trips a grid price", () => {
    expect(fromTicks(toTicks(0.37, "bid"))).toBeCloseTo(0.37, 6);
  });
});

describe("buildQuote", () => {
  it("quotes around fair with the bid below and the ask above", () => {
    const q = buildQuote(0.5)!;
    expect(q.bid).toBeLessThan(0.5);
    expect(q.ask).toBeGreaterThan(0.5);
    expect(q.bid).toBeGreaterThanOrEqual(0.02);
    expect(q.ask).toBeLessThanOrEqual(0.98);
  });
  it("does not quote once the round is nearly decided", () => {
    expect(buildQuote(0.995)).toBeNull();
    expect(buildQuote(0.003)).toBeNull();
  });
  it("never crosses", () => {
    for (let f = 0.03; f < 0.97; f += 0.01) {
      const q = buildQuote(f);
      if (q) expect(q.bidTicks).toBeLessThan(q.askTicks);
    }
  });
});

describe("needsRequote", () => {
  const last = { fair: 0.5, bid: 0.46, ask: 0.54, at: 1000 };
  it("quotes when there is no quote yet", () => {
    expect(needsRequote(null, 0.5, 1000, DEFAULT_POLICY)).toBe(true);
  });
  it("holds inside the minimum gap even on a big move", () => {
    expect(needsRequote(last, 0.7, 1010, DEFAULT_POLICY)).toBe(false);
  });
  it("holds on small moves", () => {
    expect(needsRequote(last, 0.51, 1040, DEFAULT_POLICY)).toBe(false);
  });
  it("re-quotes on a big move or an old quote", () => {
    expect(needsRequote(last, 0.58, 1040, DEFAULT_POLICY)).toBe(true);
    expect(needsRequote(last, 0.5, 1000 + DEFAULT_POLICY.maxAgeSec + 1, DEFAULT_POLICY)).toBe(true);
  });
});
