import { describe, expect, it } from "vitest";
import { RiskCfgSchema } from "../../src/config";
import type { PriceSnapshot } from "../../src/price/aggregator";
import { HaltController, evaluateRisk, type RiskInputs } from "../../src/risk";

const cfg = RiskCfgSchema.parse({});
const okPrice: PriceSnapshot = {
  tsMs: 0,
  price: 3000,
  healthy: true,
  reasons: [],
  sources: [],
  shockBps: 0,
  divergenceBps: 0,
  chainlinkBps: null,
};
const base = (over: Partial<RiskInputs> = {}): RiskInputs => ({
  nowMs: 0,
  prices: [okPrice],
  rpc: { consecutiveErrors: 0 },
  blockLagMs: 400,
  inventory: { maxLossRatio: 0.1, totalLossRatio: 0.1, excessNavFraction: 0.01 },
  killed: false,
  ...over,
});

describe("evaluateRisk", () => {
  it("is quiet when everything is healthy", () => {
    expect(evaluateRisk(base(), cfg)).toEqual({ pull: false, reasons: [] });
  });

  it("maps each price alarm to its own reason", () => {
    const bad = (reasons: PriceSnapshot["reasons"]): PriceSnapshot => ({
      ...okPrice,
      healthy: false,
      reasons,
    });
    const r = evaluateRisk(
      base({ prices: [bad(["SHOCK", "DIVERGENCE", "FEW_SOURCES", "CHAINLINK_MISMATCH"])] }),
      cfg,
    );
    expect(r.pull).toBe(true);
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        "PRICE_UNHEALTHY",
        "PRICE_SHOCK",
        "SOURCE_DIVERGENCE",
        "FEW_SOURCES",
        "CHAINLINK_MISMATCH",
      ]),
    );
    expect(evaluateRisk(base({ prices: [bad(["NO_PRICE"])] }), cfg).reasons).toContain(
      "FEW_SOURCES",
    );
  });

  it("pulls on any one unhealthy asset", () => {
    const bad: PriceSnapshot = { ...okPrice, healthy: false, reasons: ["SHOCK"] };
    expect(evaluateRisk(base({ prices: [okPrice, bad] }), cfg).pull).toBe(true);
  });

  it("pulls on RPC errors, block lag, the kill switch", () => {
    expect(evaluateRisk(base({ rpc: { consecutiveErrors: 5 } }), cfg).reasons).toEqual([
      "RPC_ERRORS",
    ]);
    expect(evaluateRisk(base({ rpc: { consecutiveErrors: 4 } }), cfg).pull).toBe(false);
    expect(evaluateRisk(base({ blockLagMs: 5001 }), cfg).reasons).toEqual(["BLOCK_LAG"]);
    expect(evaluateRisk(base({ blockLagMs: 5000 }), cfg).pull).toBe(false);
    expect(evaluateRisk(base({ killed: true }), cfg).reasons).toEqual(["KILL_SWITCH"]);
  });

  it("pulls when inventory gets too large, per market or in total, or too lopsided", () => {
    const inv = (a: number, b: number, c: number) => ({
      maxLossRatio: a,
      totalLossRatio: b,
      excessNavFraction: c,
    });
    expect(evaluateRisk(base({ inventory: inv(0.9, 0, 0) }), cfg).reasons).toEqual([
      "INVENTORY_LOSS",
    ]);
    expect(evaluateRisk(base({ inventory: inv(0, 0.95, 0) }), cfg).reasons).toEqual([
      "INVENTORY_LOSS",
    ]);
    expect(evaluateRisk(base({ inventory: inv(0, 0, 0.25) }), cfg).reasons).toEqual([
      "INVENTORY_EXCESS",
    ]);
    expect(evaluateRisk(base({ inventory: inv(0.89, 0.89, 0.24) }), cfg).pull).toBe(false);
    expect(evaluateRisk(base({ inventory: null }), cfg).pull).toBe(false); // not read yet
  });
});

describe("HaltController", () => {
  const pull = { pull: true, reasons: ["PRICE_SHOCK" as const] };
  const clean = { pull: false, reasons: [] };
  const live = { keeperHalt: false, quotingPaused: false };
  const halted = { keeperHalt: true, quotingPaused: false };

  it("halts at once on a pull and does not repeat while halted", () => {
    const c = new HaltController(cfg);
    expect(c.decide(pull, live, 0)).toEqual({ kind: "halt", reasons: ["PRICE_SHOCK"] });
    expect(c.decide(pull, halted, 100)).toEqual({ kind: "none" });
  });

  it("unhalts only after the risk was clean for the hysteresis", () => {
    const c = new HaltController(cfg);
    expect(c.decide(clean, halted, 0)).toEqual({ kind: "none" });
    expect(c.decide(clean, halted, cfg.hysteresisMs - 1)).toEqual({ kind: "none" });
    expect(c.decide(clean, halted, cfg.hysteresisMs)).toEqual({ kind: "unhalt" });
  });

  it("restarts the clock when the risk comes back", () => {
    const c = new HaltController(cfg);
    c.decide(clean, halted, 0);
    c.decide(pull, halted, 10_000); // alarm again: the clean period starts over
    expect(c.decide(clean, halted, 20_000)).toEqual({ kind: "none" });
    expect(c.decide(clean, halted, 20_000 + cfg.hysteresisMs)).toEqual({ kind: "unhalt" });
  });

  it("doubles the wait after a flap and caps it", () => {
    const c = new HaltController(cfg);
    let t = 0;
    const round = () => {
      c.decide(clean, halted, t); // clean period starts
      t += c.currentHysteresisMs;
      const d = c.decide(clean, halted, t);
      expect(d.kind).toBe("unhalt");
      t += 1000; // quotes are back, then the alarm returns soon after
      c.decide(pull, live, t);
    };
    round();
    const first = c.currentHysteresisMs;
    round();
    expect(c.currentHysteresisMs).toBe(first * 2);
    for (let i = 0; i < 10; i++) round();
    expect(c.currentHysteresisMs).toBe(cfg.maxHysteresisMs);
  });

  it("never touches a vault paused by the guardian or the breaker", () => {
    const c = new HaltController(cfg);
    const pausedHalted = { keeperHalt: true, quotingPaused: true };
    expect(c.decide(clean, pausedHalted, 0)).toEqual({ kind: "none" });
    expect(c.decide(clean, pausedHalted, 10 * cfg.hysteresisMs)).toEqual({ kind: "none" });
  });

  it("keeps a killed keeper halted: the kill switch is a pull", () => {
    const c = new HaltController(cfg);
    const killed = evaluateRisk(base({ killed: true }), cfg);
    expect(c.decide(killed, halted, 0)).toEqual({ kind: "none" });
    expect(c.decide(killed, live, 0)).toEqual({ kind: "halt", reasons: ["KILL_SWITCH"] });
  });
});
