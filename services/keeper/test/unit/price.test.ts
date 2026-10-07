import { describe, expect, it } from "vitest";
import { PriceCfgSchema } from "../../src/config";
import { ReferencePrice } from "../../src/price/aggregator";
import { parseBinance, parseCoinbase } from "../../src/price/sources";

const cfg = PriceCfgSchema.parse({});
const mk = () => new ReferencePrice(cfg, ["binance", "coinbase"]);

describe("source parsers", () => {
  it("binance bookTicker -> mid", () => {
    const t = parseBinance(
      '{"u":1,"s":"ETHUSDT","b":"2697.47","B":"1","a":"2697.49","A":"2"}',
      () => 5,
    );
    expect(t?.source).toBe("binance");
    expect(t?.price).toBeCloseTo(2697.48, 8);
    expect(t?.tsMs).toBe(5);
  });
  it("binance rejects garbage and crossed books", () => {
    expect(parseBinance("nope")).toBeNull();
    expect(parseBinance('{"b":"3","a":"2"}')).toBeNull();
    expect(parseBinance('{"x":1}')).toBeNull();
  });
  it("coinbase ticker -> mid, falls back to the last price", () => {
    expect(
      parseCoinbase('{"type":"ticker","price":"10","best_bid":"9","best_ask":"11"}', () => 1)
        ?.price,
    ).toBe(10);
    expect(parseCoinbase('{"type":"ticker","price":"10.5"}', () => 1)?.price).toBe(10.5);
    expect(parseCoinbase('{"type":"subscriptions"}')).toBeNull();
    expect(parseCoinbase("[")).toBeNull();
  });
});

describe("ReferencePrice", () => {
  it("is the median of two healthy sources and healthy", () => {
    const p = mk();
    p.ingest({ source: "binance", price: 3000, tsMs: 1000 });
    p.ingest({ source: "coinbase", price: 3002, tsMs: 1100 });
    const s = p.snapshot(1200);
    expect(s.price).toBe(3001);
    expect(s.healthy).toBe(true);
    expect(s.reasons).toEqual([]);
    expect(s.sources.map((x) => x.healthy)).toEqual([true, true]);
  });

  it("drops a stale source and pulls when fewer than two remain", () => {
    const p = mk();
    p.ingest({ source: "binance", price: 3000, tsMs: 1000 });
    p.ingest({ source: "coinbase", price: 3000, tsMs: 1000 });
    p.ingest({ source: "binance", price: 3000, tsMs: 4500 }); // coinbase silent for 3.5 s
    const s = p.snapshot(4500);
    expect(s.sources.find((x) => x.name === "coinbase")?.healthy).toBe(false);
    expect(s.price).toBe(3000);
    expect(s.healthy).toBe(false);
    expect(s.reasons).toContain("FEW_SOURCES");
  });

  it("has no price and is unhealthy with nothing", () => {
    const s = mk().snapshot(10);
    expect(s.price).toBeNull();
    expect(s.healthy).toBe(false);
    expect(s.reasons).toContain("NO_PRICE");
  });

  it("flags divergence between sources", () => {
    const p = mk();
    p.ingest({ source: "binance", price: 3000, tsMs: 1000 });
    p.ingest({ source: "coinbase", price: 3030, tsMs: 1000 }); // 100 bps apart: 50 bps from the median
    expect(p.snapshot(1000).reasons).not.toContain("DIVERGENCE"); // below 60
    const q = mk();
    q.ingest({ source: "binance", price: 3000, tsMs: 1000 });
    q.ingest({ source: "coinbase", price: 3060, tsMs: 1000 }); // 200 bps apart: 100 from the median
    const s = q.snapshot(1000);
    expect(s.reasons).toContain("DIVERGENCE");
    expect(s.healthy).toBe(false);
  });

  it("flags a 2% jump in one tick as a shock and holds it", () => {
    const p = mk();
    for (let t = 0; t < 5000; t += 500) {
      p.ingest({ source: "binance", price: 3000, tsMs: t });
      p.ingest({ source: "coinbase", price: 3000, tsMs: t });
    }
    expect(p.snapshot(4500).healthy).toBe(true);
    p.ingest({ source: "binance", price: 3060, tsMs: 5000 }); // +2%
    p.ingest({ source: "coinbase", price: 3060, tsMs: 5000 });
    const s = p.snapshot(5000);
    expect(s.reasons).toContain("SHOCK");
    expect(s.shockBps).toBeGreaterThan(190);
    // still reported after the move has left the 5 s window, until the hold passes
    for (let t = 5500; t <= 12_000; t += 500) {
      p.ingest({ source: "binance", price: 3060, tsMs: t });
      p.ingest({ source: "coinbase", price: 3060, tsMs: t });
    }
    expect(p.snapshot(12_000).reasons).toContain("SHOCK");
    for (let t = 12_500; t <= 16_000; t += 500) {
      p.ingest({ source: "binance", price: 3060, tsMs: t });
      p.ingest({ source: "coinbase", price: 3060, tsMs: t });
    }
    expect(p.snapshot(16_000).healthy).toBe(true);
  });

  it("checks the median against Chainlink and ignores an old answer", () => {
    const p = mk();
    p.ingest({ source: "binance", price: 3000, tsMs: 1000 });
    p.ingest({ source: "coinbase", price: 3000, tsMs: 1000 });
    p.setChainlink(3010, 0);
    expect(p.snapshot(1000).chainlinkBps).toBeCloseTo(33.3, 0);
    expect(p.snapshot(1000).healthy).toBe(true);
    p.setChainlink(3100, 0); // 3.3% away
    expect(p.snapshot(1000).reasons).toContain("CHAINLINK_MISMATCH");
    // an answer older than the limit is not used
    p.ingest({ source: "binance", price: 3000, tsMs: 20 * 60_000 });
    p.ingest({ source: "coinbase", price: 3000, tsMs: 20 * 60_000 });
    const s = p.snapshot(20 * 60_000);
    expect(s.chainlinkBps).toBeNull();
    expect(s.healthy).toBe(true);
  });

  it("answers the price at a past time and refuses a stale sample", () => {
    const p = mk();
    p.ingest({ source: "binance", price: 3000, tsMs: 1000 });
    p.ingest({ source: "coinbase", price: 3000, tsMs: 1000 });
    p.ingest({ source: "binance", price: 3010, tsMs: 2000 });
    p.ingest({ source: "coinbase", price: 3010, tsMs: 2000 });
    expect(p.priceAt(1500)).toBe(3000);
    expect(p.priceAt(2000)).toBe(3010);
    expect(p.priceAt(500)).toBeNull(); // before the first sample
    expect(p.priceAt(2000 + 7000)).toBeNull(); // newest sample too old for that time
  });

  it("ignores out-of-order and invalid ticks", () => {
    const p = mk();
    p.ingest({ source: "binance", price: 3000, tsMs: 2000 });
    p.ingest({ source: "binance", price: 1, tsMs: 1000 });
    p.ingest({ source: "binance", price: Number.NaN, tsMs: 3000 });
    p.ingest({ source: "binance", price: -5, tsMs: 3000 });
    expect(p.snapshot(2000).price).toBe(3000);
  });
});

describe("per-source staleness", () => {
  it("a trade-driven source gets its own, longer window", () => {
    const ref = new ReferencePrice(
      PriceCfgSchema.parse({ staleMs: 3000, staleMsBySource: { coinbase: 12000 } }),
      ["binance", "coinbase"],
    );
    ref.ingest({ source: "binance", price: 3000, tsMs: 100_000 });
    ref.ingest({ source: "coinbase", price: 3000, tsMs: 100_000 });
    expect(ref.snapshot(104_000).healthy).toBe(false); // binance quiet for 4 s: stale
    ref.ingest({ source: "binance", price: 3000, tsMs: 104_000 });
    expect(ref.snapshot(108_000).healthy).toBe(false); // binance 4 s again
    ref.ingest({ source: "binance", price: 3000, tsMs: 108_000 });
    const s = ref.snapshot(110_000); // coinbase is 10 s old: still inside its 12 s window
    expect(s.healthy).toBe(true);
    expect(s.sources.find((x) => x.name === "coinbase")?.healthy).toBe(true);
    ref.ingest({ source: "binance", price: 3000, tsMs: 113_000 });
    expect(ref.snapshot(113_500).healthy).toBe(false); // coinbase 13.5 s: now stale
  });
});
