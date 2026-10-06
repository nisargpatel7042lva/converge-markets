import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocate,
  Limiter,
  loadAddresses,
  parseArgs,
  parseHeaders,
  percentile,
  rng,
  sample,
  summarize,
} from "../lib/common";

describe("percentile (nearest rank)", () => {
  it("matches hand-computed ranks", () => {
    const xs = [15, 20, 35, 40, 50];
    expect(percentile(xs, 50)).toBe(35); // ceil(0.5 * 5) = 3rd
    expect(percentile(xs, 95)).toBe(50); // ceil(4.75) = 5th
    expect(percentile(xs, 20)).toBe(15); // ceil(1.0) = 1st
    expect(percentile(xs, 21)).toBe(20);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
  it("does not mutate its input and is order independent", () => {
    const xs = [3, 1, 2];
    expect(percentile(xs, 100)).toBe(3);
    expect(xs).toEqual([3, 1, 2]);
  });
  it("summarize", () => {
    const s = summarize([1, 2, 3, 4]);
    expect([s.n, s.min, s.max, s.mean, s.p50]).toEqual([4, 1, 4, 2.5, 2]);
  });
});

describe("sampling", () => {
  it("is deterministic per seed, distinct, and bounded by the population", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = sample(items, 10, rng(5));
    const b = sample(items, 10, rng(5));
    const c = sample(items, 10, rng(6));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(10);
    expect(sample(items, 500, rng(1))).toHaveLength(50);
  });

  it("allocate: proportional, capped by pool size, leftovers redistributed, shortfall explicit", () => {
    const pools = [
      { name: "A", size: 3, weight: 10 },
      { name: "B", size: 100, weight: 10 },
      { name: "C", size: 100, weight: 10 },
    ];
    const m = allocate(60, pools);
    expect(m.get("A")).toBe(3); // capped
    expect(m.get("A")! + m.get("B")! + m.get("C")!).toBe(60); // the cap is made up elsewhere
    expect(m.get("B")).toBeGreaterThanOrEqual(28);
    // population smaller than the request: take everything
    const all = allocate(500, pools);
    expect([...all.values()].reduce((s, v) => s + v, 0)).toBe(203);
    expect(allocate(5, [{ name: "x", size: 0, weight: 1 }]).get("x")).toBe(0);
  });
});

describe("cli helpers", () => {
  it("parseArgs / parseHeaders", () => {
    const a = parseArgs(["--n", "200", "--aggregates", "--label", "local", "stray"]);
    expect(a.get("n")).toBe("200");
    expect(a.get("aggregates")).toBe(true);
    expect(a.get("label")).toBe("local");
    expect(parseHeaders("a=1, b=two=2")).toEqual({ a: "1", b: "two=2" });
    expect(parseHeaders(undefined)).toEqual({});
  });

  it("loadAddresses reads both the deployments file and the local addresses file", () => {
    const dep = loadAddresses(resolve(__dirname, "../../../deployments/testnet.json"));
    expect(dep.chainId).toBe(10143);
    expect(dep.vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(dep.venue).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const dir = mkdtempSync(join(tmpdir(), "addr-"));
    const p = join(dir, "a.json");
    writeFileSync(
      p,
      JSON.stringify({ chainId: 31337, factory: "0x1", vault: "0x2", venue: "0x3" }),
    );
    expect(loadAddresses(p)).toEqual({
      chainId: 31337,
      factory: "0x1",
      vault: "0x2",
      venue: "0x3",
    });
    writeFileSync(p, "{}");
    expect(() => loadAddresses(p)).toThrow(/unrecognised/);
  });
});

describe("Limiter", () => {
  it("never exceeds the concurrency", async () => {
    const l = new Limiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        l.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it("spaces calls to the requested rate", async () => {
    const l = new Limiter(10, 50); // 50 per second = 20 ms apart
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => l.run(async () => undefined)));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90); // 5 gaps of 20 ms, with timer slack
  });
});
