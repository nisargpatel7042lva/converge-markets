import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateParams, type StrategyParams } from "@converge/strategy";

const FILE = join(__dirname, "..", "..", "config", "strategy.default.json");

describe("config/strategy.default.json", () => {
  it("exists, validates with the keeper's own validator, and records its provenance", () => {
    expect(existsSync(FILE)).toBe(true);
    const cfg = JSON.parse(readFileSync(FILE, "utf8")) as {
      version: number;
      design: { quoteMode: string; execDelayBlocks: number; blockMs: number };
      params: StrategyParams;
      provenance: { report: string; dataManifestSha256: string; seed: number };
    };
    expect(cfg.version).toBe(1);
    expect(() => validateParams(cfg.params)).not.toThrow();
    expect(cfg.design.quoteMode).toBe("swapTime");
    expect(cfg.design.execDelayBlocks).toBeGreaterThan(0);
    expect(cfg.provenance.dataManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    // risk defaults from CLAUDE.md must hold or be tighter
    expect(cfg.params.perMarketMaxFraction).toBeLessThanOrEqual(0.05);
    expect(cfg.params.totalAtRiskMaxFraction).toBeLessThanOrEqual(0.4);
    expect(cfg.params.drawdownBreakerFraction).toBeLessThanOrEqual(0.05);
    expect(cfg.params.priceMin).toBeGreaterThanOrEqual(0.02);
    expect(cfg.params.priceMax).toBeLessThanOrEqual(0.98);
  });
});
