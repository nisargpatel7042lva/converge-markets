import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nextSide, readLog, tradable } from "../../src/canary/trader";

describe("canary trader decisions", () => {
  it("trades a round only once it has been open a little and while enough time is left", () => {
    expect(tradable(1000 + 44, 1000, 900)).toBe(false);
    expect(tradable(1000 + 45, 1000, 900)).toBe(true);
    expect(tradable(1000 + 900 - 240, 1000, 900)).toBe(true);
    expect(tradable(1000 + 900 - 239, 1000, 900)).toBe(false);
    expect(tradable(1000 + 10, 1000, 3600)).toBe(false);
  });

  it("alternates the side so the canary is not a one-way bet", () => {
    expect([0, 1, 2, 3].map(nextSide)).toEqual(["UP", "DOWN", "UP", "DOWN"]);
  });
});

describe("canary trade log", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "canary-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("merges later lines into earlier ones by order id (append-only evidence)", () => {
    const f = resolve(dir, "t.jsonl");
    const w = (o: object) => appendFileSync(f, JSON.stringify(o) + "\n");
    w({
      orderId: "7",
      market: "0xm",
      series: "BTC/USD",
      side: "UP",
      placedAt: 100,
      status: "open",
    });
    w({ orderId: "7", status: "executed", filledShares: "1000000", redeem: "pending" });
    w({ orderId: "7", redeem: "ok", payoutUsdc: "995000" });
    w({
      orderId: "8",
      market: "0xn",
      series: "ETH/USD",
      side: "DOWN",
      placedAt: 200,
      status: "open",
    });
    const log = readLog(f);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      orderId: "7",
      status: "executed",
      redeem: "ok",
      payoutUsdc: "995000",
      market: "0xm",
    });
    expect(log[1]).toMatchObject({ orderId: "8", status: "open" });
    expect(readLog(resolve(dir, "missing.jsonl"))).toEqual([]);
  });
});
