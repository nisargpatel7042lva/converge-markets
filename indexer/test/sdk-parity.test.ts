/**
 * The hosted indexer cannot import from packages/sdk, so the pure math exists twice (indexer/src/lib
 * and packages/sdk/src/indexer-math.ts). This test pins both copies to the same results.
 */
import { describe, expect, it } from "vitest";
import {
  lpUnrealizedPnl,
  navPerformance,
  positionValue as sdkValue,
  unrealizedPnl as sdkUnrealized,
  windowPerformance as sdkWindow,
} from "../../packages/sdk/src/indexer-math";
import { performance, windowPerformance } from "../src/lib/apy";
import { lpUnrealized } from "../src/lib/lp";
import { emptyState, positionValue, unrealizedPnl } from "../src/lib/position";

const WAD = 10n ** 18n;

describe("indexer lib == SDK math", () => {
  it("performance / navPerformance agree on a grid of inputs", () => {
    for (const num of [1n, 99n, 100n, 101n, 150n, 1000n]) {
      for (const dt of [1, 60, 3600, 86_400, 7 * 86_400, 400 * 86_400]) {
        const now = { ppsWad: (num * WAD) / 100n, timestamp: dt };
        const then = { ppsWad: WAD, timestamp: 0 };
        expect(navPerformance(now, then)).toEqual(performance(now, then));
      }
    }
  });

  it("window baselines agree", () => {
    const d = 86_400;
    const obs = [0, 2, 5, 8, 12].map((k, i) => ({
      ppsWad: BigInt(100 + i * 3) * 10n ** 16n,
      timestamp: k * d,
    }));
    const now = { ppsWad: 120n * 10n ** 16n, timestamp: 14 * d };
    for (const w of [1, 7, 30])
      expect(sdkWindow(obs, now, w * d)).toEqual(windowPerformance(obs, now, w * d));
  });

  it("position valuation and unrealized PnL agree", () => {
    const s = {
      ...emptyState(),
      upBalance: 7n,
      downBalance: 3n,
      upEscrowed: 1n,
      upCost: 5n,
      downCost: 2n,
    };
    for (const v of [
      { kind: "live", upPriceWad: (37n * WAD) / 100n },
      { kind: "resolved", outcome: "UP" },
      { kind: "resolved", outcome: "DOWN" },
      { kind: "resolved", outcome: "INVALID" },
    ] as const) {
      expect(sdkValue(s, v)).toBe(positionValue(s, v));
      expect(sdkUnrealized(s, v)).toBe(unrealizedPnl(s, v));
    }
  });

  it("LP unrealized PnL agrees", () => {
    const lp = {
      shares: 600n,
      escrowedShares: 40n,
      costBasis: 500n,
      realizedPnl: 0n,
      totalDeposited: 0n,
      totalWithdrawn: 0n,
    };
    expect(lpUnrealizedPnl(lp, (13n * WAD) / 10n)).toBe(lpUnrealized(lp, (13n * WAD) / 10n));
  });
});
