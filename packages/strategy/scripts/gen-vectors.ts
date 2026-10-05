/**
 * Generates golden vectors for contracts/test/QuoteMath.t.sol from the TypeScript twin
 * (src/onchain.ts). Inputs are exact WAD integers; expectations are floating point and compared
 * with tolerances (prices on the tick grid are compared exactly). Deterministic (fixed seed).
 *   tsx scripts/gen-vectors.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normCdf,
  normPdf,
  onchainD2,
  onchainQuote,
  buyRoomOf,
  sellRoomOf,
  lossCeilingOf,
  type OnchainParams,
  type Pos,
} from "../src";

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "contracts",
  "test",
  "vectors",
);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20261006);
const u = (lo: number, hi: number) => lo + (hi - lo) * R();
const pick = <T>(xs: T[]) => xs[Math.floor(R() * xs.length)]!;
const WAD = 10n ** 18n;
const wad = (x: number): bigint => BigInt(Math.round(x * 1e9)) * 10n ** 9n; // 1e-9 resolution: exact in a double
const num = (w: bigint): number => Number(w) / 1e18;
const w = (x: number): string => wad(x).toString();

// ---- primitives
const cdf: { x: string; p: number }[] = [];
for (const x of [
  -40, -8, -5, -3, -2, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 1.96, 3, 5, 7, 7.1, 8, 20, 37, 38,
]) {
  cdf.push({ x: wad(x).toString(), p: w(normCdf(num(wad(x)))) });
}
for (let i = 0; i < 300; i++) {
  const x = u(-9, 9);
  cdf.push({ x: wad(x).toString(), p: w(normCdf(num(wad(x)))) });
}
const pdf = cdf.slice(0, 40).map((c) => ({ x: c.x, p: w(normPdf(num(BigInt(c.x)))) }));
const d2v: { spot: string; strike: string; sigma: string; tau: string; d2: string }[] = [];
for (let i = 0; i < 300; i++) {
  const strike = wad(u(1000, 90000));
  const spot = wad(num(strike) * Math.exp(u(-0.02, 0.02)));
  const sigma = wad(u(0.1, 2.5));
  const tau = Math.floor(u(1, 3600));
  d2v.push({
    spot: spot.toString(),
    strike: strike.toString(),
    sigma: sigma.toString(),
    tau: String(tau),
    d2: w(onchainD2(num(spot), num(strike), num(sigma), tau)),
  });
}

// ---- full quotes
const baseParams = (): OnchainParams => ({
  minHalfSpread: pick([0.01, 0.02, 0.03, 0.05]),
  maxHalfSpread: 0.2,
  volSpreadK: pick([0, 0.5, 1, 2]),
  stalenessSec: pick([1.5, 2.5, 4]),
  inventorySkewMax: pick([0.02, 0.05, 0.1]),
  inventorySkewK: pick([1, 2, 4]),
  noQuoteWindowSec: pick([30, 60, 120]),
  priceMin: 0.02,
  priceMax: 0.98,
  tick: pick([0.01, 0.005]),
  levels: pick([1, 2, 3, 4]),
  baseRangeTicks: pick([4, 6, 8, 14]),
  minRangeTicks: pick([1, 2, 3]),
  liquidityNavFraction: pick([0.03, 0.12, 0.5]),
  minLevelSize: pick([0, 0.5, 1]),
  perMarketMaxFraction: pick([0.01, 0.035, 0.05]),
  totalAtRiskMaxFraction: 0.4,
});
const PARAM_KEYS: (keyof OnchainParams)[] = [
  "minHalfSpread",
  "maxHalfSpread",
  "volSpreadK",
  "stalenessSec",
  "inventorySkewMax",
  "inventorySkewK",
  "noQuoteWindowSec",
  "priceMin",
  "priceMax",
  "tick",
  "levels",
  "baseRangeTicks",
  "minRangeTicks",
  "liquidityNavFraction",
  "minLevelSize",
  "perMarketMaxFraction",
  "totalAtRiskMaxFraction",
];
const paramWad = (p: OnchainParams) =>
  Object.fromEntries(
    PARAM_KEYS.map((k) => [
      k,
      k === "levels" || k === "noQuoteWindowSec" ? String(p[k]) : wad(p[k]).toString(),
    ]),
  );

type Case = Record<string, unknown>;
const quotes: Case[] = [];
let attempts = 0;
while (quotes.length < 600 && attempts++ < 20000) {
  const q = baseParams();
  const roundSec = pick([900, 3600]);
  const strike = wad(u(1000, 90000));
  const m = pick([0, 0, 0.0005, -0.0005, 0.002, -0.002, 0.006, -0.006, 0.02]);
  const spot = wad(num(strike) * Math.exp(m + u(-0.0003, 0.0003)));
  const sigma = wad(u(0.15, 1.5));
  const tau = Math.floor(u(q.noQuoteWindowSec - 5, roundSec));
  const nav = wad(u(500, 50000));
  const up = wad(u(0, 600)),
    down = wad(u(0, 600));
  const basis = wad(Math.max(num(up), num(down)) + u(0, 50));
  const cash = wad(u(-200, 200));
  const pos: Pos = { basis: num(basis), cash: num(cash), up: num(up), down: num(down) };
  const args = [num(spot), num(strike), num(sigma), tau, roundSec, num(nav), pos, q] as const;
  const a = onchainQuote(...args);
  // Skip cases where float and fixed point could legitimately round a price to different ticks.
  const eps = 4e-9;
  const stable = [1 - eps, 1 + eps].every((k) => {
    const b = onchainQuote(num(spot) * k, num(strike), num(sigma), tau, roundSec, num(nav), pos, q);
    return (
      JSON.stringify(b.bids.map((l) => l.price)) === JSON.stringify(a.bids.map((l) => l.price)) &&
      JSON.stringify(b.asks.map((l) => l.price)) === JSON.stringify(a.asks.map((l) => l.price))
    );
  });
  if (!stable) continue;
  quotes.push({
    spot: spot.toString(),
    strike: strike.toString(),
    sigma: sigma.toString(),
    tau: String(tau),
    roundSec: String(roundSec),
    nav: nav.toString(),
    pos: {
      basis: basis.toString(),
      cash: cash.toString(),
      up: up.toString(),
      down: down.toString(),
    },
    params: paramWad(q),
    quoting: a.quoting,
    fair: w(a.fair),
    half: w(a.halfSpread),
    skew: w(a.skew),
    bp: a.bids.map((l) => w(l.price)),
    bs: a.bids.map((l) => w(l.size)),
    ap: a.asks.map((l) => w(l.price)),
    as: a.asks.map((l) => w(l.size)),
  });
}

// ---- room functions
const rooms: Case[] = [];
for (let i = 0; i < 400; i++) {
  const up = wad(u(0, 500)),
    down = wad(u(0, 500));
  const basis = wad(Math.max(num(up), num(down)) + u(0, 40));
  const cash = wad(u(-150, 150));
  const nav = wad(u(1000, 40000));
  const other = wad(u(0, 300));
  const q = { perMarketMaxFraction: pick([0.01, 0.035, 0.05]), totalAtRiskMaxFraction: 0.4 };
  const pos: Pos = { basis: num(basis), cash: num(cash), up: num(up), down: num(down) };
  const ceiling = lossCeilingOf(pos, num(nav), num(other), q);
  const price = wad(u(0.02, 0.98));
  rooms.push({
    pos: {
      basis: basis.toString(),
      cash: cash.toString(),
      up: up.toString(),
      down: down.toString(),
    },
    nav: nav.toString(),
    other: other.toString(),
    perMax: wad(q.perMarketMaxFraction).toString(),
    totalMax: wad(q.totalAtRiskMaxFraction).toString(),
    price: price.toString(),
    ceiling: w(ceiling),
    sellUp: w(sellRoomOf(pos.basis, pos.cash, pos.up, pos.down, num(price), ceiling)),
    buyUp: w(buyRoomOf(pos.basis, pos.cash, pos.up, pos.down, num(price), ceiling)),
    sellDown: w(sellRoomOf(pos.basis, pos.cash, pos.down, pos.up, num(price), ceiling)),
    buyDown: w(buyRoomOf(pos.basis, pos.cash, pos.down, pos.up, num(price), ceiling)),
  });
}

const tanhv = Array.from({ length: 60 }, () => {
  const x = u(-6, 6);
  return { x: w(x), y: w(Math.tanh(num(wad(x)))) };
});
mkdirSync(OUT_DIR, { recursive: true });
const jsonl = (name: string, rows: unknown[]) =>
  writeFileSync(
    join(OUT_DIR, `${name}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
jsonl("cdf", cdf);
jsonl("pdf", pdf);
jsonl("d2", d2v);
jsonl("tanh", tanhv);
jsonl("quotes", quotes);
jsonl("rooms", rooms);
console.log(
  `wrote ${OUT_DIR}: ${cdf.length} cdf, ${pdf.length} pdf, ${d2v.length} d2, ${tanhv.length} tanh, ${quotes.length} quotes, ${rooms.length} rooms`,
);
void WAD;
