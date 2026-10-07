import type { MarketView, Quotes } from "@converge/sdk";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config";
import {
  cents,
  chanceYes,
  countdown,
  formatEnd,
  formatPrice,
  question,
  sideCard,
  statusLine,
  winText,
} from "../lib/view";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000; // 2026-10-08 12:00 UTC
const END_TODAY = Date.UTC(2026, 9, 8, 20, 0, 0) / 1000;
const END_LATER = Date.UTC(2026, 9, 10, 20, 0, 0) / 1000;

const quotes = (over: Partial<Quotes> = {}): Quotes => ({
  quoting: true,
  fair: 0.57,
  up: {
    ask: { price: 0.6, priceWad: 6n * 10n ** 17n, size: 50_000_000n },
    bid: { price: 0.54, priceWad: 54n * 10n ** 16n, size: 50_000_000n },
  },
  down: {
    ask: { price: 0.46, priceWad: 46n * 10n ** 16n, size: 20_000_000n },
    bid: { price: 0.4, priceWad: 4n * 10n ** 17n, size: 20_000_000n },
  },
  ladder: { bids: [], asks: [] },
  at: NOW,
  spot: 3150,
  ...over,
});

describe("headline", () => {
  it("asks the question a partner would ask", () => {
    expect(question("ETH", 3200, END_TODAY, NOW)).toBe(
      "Will ETH be at or above $3,200 at 20:00 UTC?",
    );
    expect(question("ETH", 3200.5, END_LATER, NOW)).toBe(
      "Will ETH be at or above $3,201 at Oct 10, 20:00 UTC?",
    );
    expect(formatPrice(0.031542)).toBe("$0.0315");
    expect(formatPrice(12.345)).toBe("$12.35");
    expect(formatEnd(END_TODAY, NOW)).toBe("20:00 UTC");
  });

  it("counts down in the largest sensible units", () => {
    expect(countdown(3 * 3600 + 12 * 60 + 9)).toBe("3h 12m");
    expect(countdown(4 * 60 + 5)).toBe("4m 05s");
    expect(countdown(12)).toBe("12s");
    expect(countdown(-4)).toBe("0s");
  });
});

describe("prices and depth", () => {
  it("shows cents and the dollars behind each side", () => {
    expect(cents(0.6)).toBe("60¢");
    expect(sideCard(quotes(), "UP")).toEqual({
      label: "Yes",
      price: "60¢",
      depth: "$30 available", // 50 shares at 0.60
      enabled: true,
    });
    expect(sideCard(quotes(), "DOWN").depth).toBe("$9 available");
  });

  it("disables a side that has no depth and shows nothing when the vault is not quoting", () => {
    const none = quotes({
      quoting: false,
      up: { ask: null, bid: null },
      down: { ask: null, bid: null },
    });
    expect(sideCard(none, "UP")).toMatchObject({ enabled: false, price: "–" });
    expect(sideCard(null, "DOWN")).toMatchObject({ enabled: false });
    expect(chanceYes(none)).toBeNull();
    expect(chanceYes(quotes())).toBe(57);
  });

  it("says what a winning bet pays after the fee", () => {
    expect(winText(5, 0.5, 50)).toBe("Win $9.95 if you are right (profit $4.95)");
    expect(winText(0, 0.5, 50)).toBe("");
    expect(winText(5, 0, 50)).toBe("");
  });
});

describe("status line", () => {
  const view = (phase: MarketView["phase"], over: Partial<MarketView> = {}) =>
    ({ phase, endTime: END_TODAY, ...over }) as MarketView;
  it("follows the market through its life", () => {
    expect(statusLine(view({ phase: "LIVE", endsIn: 28_800, closing: false }), NOW)).toBe(
      "Ends in 8h 00m",
    );
    expect(statusLine(view({ phase: "LIVE", endsIn: 40, closing: true }), END_TODAY - 40)).toBe(
      "Closing: 40s left",
    );
    expect(statusLine(view({ phase: "RESOLVING" }), NOW)).toContain("oracle");
    expect(statusLine(view({ phase: "SETTLED", outcome: "UP" }), NOW)).toBe(
      "Settled: YES (above) won",
    );
    expect(statusLine(view({ phase: "SETTLED", outcome: "DOWN" }), NOW)).toBe(
      "Settled: NO (below) won",
    );
    expect(statusLine(view({ phase: "SETTLED", outcome: "INVALID" }), NOW)).toContain("50¢");
  });
});

describe("config", () => {
  const env = {
    NEXT_PUBLIC_REGISTRY: "0x0000000000000000000000000000000000000001",
    NEXT_PUBLIC_VAULT: "0x0000000000000000000000000000000000000002",
    NEXT_PUBLIC_VENUE: "0x0000000000000000000000000000000000000003",
    NEXT_PUBLIC_COLLATERAL: "0x0000000000000000000000000000000000000004",
  };
  it("defaults to Monad testnet and needs the four addresses", () => {
    const cfg = readConfig(env);
    expect(cfg.chainId).toBe(10143);
    expect(cfg.market).toBeNull();
    expect(cfg.spotSymbol).toBe("ETHUSDT");
    expect(() => readConfig({})).toThrow(/NEXT_PUBLIC_REGISTRY/);
    expect(readConfig({ ...env, NEXT_PUBLIC_SPOT_FIXED: "3150" }).spotFixed).toBe(3150);
    expect(readConfig({ ...env, NEXT_PUBLIC_CHAIN_ID: "31337" }).chainName).toBe("chain 31337");
  });
});
