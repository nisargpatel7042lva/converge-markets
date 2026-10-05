import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, ParamError, validateParams, type StrategyParams } from "../src";

const bad = (over: Partial<StrategyParams>) => ({ ...DEFAULT_PARAMS, ...over });

describe("validateParams", () => {
  it("accepts the defaults and returns them", () => {
    expect(validateParams(DEFAULT_PARAMS)).toBe(DEFAULT_PARAMS);
  });

  it.each<[string, Partial<StrategyParams>]>([
    ["tick", { tick: 0 }],
    ["minHalfSpread", { minHalfSpread: 0 }],
    ["maxHalfSpread", { maxHalfSpread: 0.001 }],
    ["volSpreadK", { volSpreadK: -1 }],
    ["stalenessSec", { stalenessSec: 0 }],
    ["inventorySkewMax", { inventorySkewMax: -0.1 }],
    ["inventorySkewK", { inventorySkewK: -1 }],
    ["toxicityPullBps", { toxicityPullBps: 0 }],
    ["toxicityWindowSec", { toxicityWindowSec: 0 }],
    ["toxicityWidenMax", { toxicityWidenMax: -1 }],
    ["noQuoteWindowSec", { noQuoteWindowSec: -1 }],
    ["priceMin", { priceMin: 0 }],
    ["priceMax", { priceMax: 1 }],
    ["priceMin>=priceMax", { priceMin: 0.6, priceMax: 0.5 }],
    ["levels", { levels: 0 }],
    ["levels integer", { levels: 2.5 }],
    ["baseRangeTicks", { baseRangeTicks: -1 }],
    ["minRangeTicks", { minRangeTicks: -1 }],
    ["liquidityNavFraction", { liquidityNavFraction: 0 }],
    ["minLevelSize", { minLevelSize: -1 }],
    ["perMarketMaxFraction", { perMarketMaxFraction: 0 }],
    ["perMarketMaxFraction>1", { perMarketMaxFraction: 1.5 }],
    ["totalAtRiskMaxFraction", { totalAtRiskMaxFraction: 0.01 }],
    ["drawdownBreakerFraction", { drawdownBreakerFraction: 0 }],
    ["vol.halfLifeSec", { vol: { ...DEFAULT_PARAMS.vol, halfLifeSec: 0 } }],
    ["vol.priorAnnualVol", { vol: { ...DEFAULT_PARAMS.vol, priorAnnualVol: 0 } }],
    ["vol.scale", { vol: { ...DEFAULT_PARAMS.vol, scale: 0 } }],
    ["vol clamp", { vol: { ...DEFAULT_PARAMS.vol, minAnnualVol: 5, maxAnnualVol: 1 } }],
    ["refreshTicks", { refreshTicks: -1 }],
    ["maxQuoteAgeBlocks", { maxQuoteAgeBlocks: 0 }],
    ["NaN", { tick: NaN }],
  ])("rejects an invalid %s", (_name, over) => {
    expect(() => validateParams(bad(over))).toThrow(ParamError);
  });
});
