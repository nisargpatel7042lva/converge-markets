/**
 * Binance public market data (https://data.binance.vision), daily kline archives.
 *
 * Every archive is verified against the SHA-256 that Binance publishes next to it (`.CHECKSUM`),
 * and the hashes are pinned in `data/manifest.json` so a rerun on any machine uses byte-identical
 * inputs. Terms: Binance Data Collection (https://www.binance.com/en/terms); the archives are
 * public and free to download. We store only derived close-price series in the repo-ignored cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PriceSeries } from "./series";
import { unzipFirst } from "./zip";

export const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
export const BASE_URL = "https://data.binance.vision/data";

export type AssetSource = {
  label: "BTC/USD" | "ETH/USD" | "MON/USD";
  symbol: string;
  /** spot or USD-M futures archive path segment. */
  venue: "spot" | "futures/um";
  interval: "1s" | "1m";
  stepSec: 1 | 60;
};

export const SOURCES: Record<string, AssetSource> = {
  "BTC/USD": { label: "BTC/USD", symbol: "BTCUSDT", venue: "spot", interval: "1s", stepSec: 1 },
  "ETH/USD": { label: "ETH/USD", symbol: "ETHUSDT", venue: "spot", interval: "1s", stepSec: 1 },
  // MON has no Binance spot market; the USD-M perpetual at 1 m is the only history available.
  "MON/USD": {
    label: "MON/USD",
    symbol: "MONUSDT",
    venue: "futures/um",
    interval: "1m",
    stepSec: 60,
  },
};

/** Evaluation window (inclusive, UTC dates) and one warm-up day for the volatility estimator. */
export const WINDOW = { start: "2026-07-06", end: "2026-10-03", warmupDays: 1 } as const;

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function days(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  for (let d = startIso; d <= endIso; d = addDays(d, 1)) out.push(d);
  return out;
}

export function epochSec(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 1000;
}

export function archiveUrl(src: AssetSource, day: string): string {
  return `${BASE_URL}/${src.venue}/daily/klines/${src.symbol}/${src.interval}/${src.symbol}-${src.interval}-${day}.zip`;
}

export type ManifestEntry = { sha256: string; bytes: number; rows: number };
export type Manifest = {
  source: string;
  window: { start: string; end: string; warmupDays: number };
  files: Record<string, ManifestEntry>;
};

const MANIFEST_PATH = join(DATA_ROOT, "manifest.json");

export function readManifest(): Manifest | null {
  return existsSync(MANIFEST_PATH)
    ? (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest)
    : null;
}

export function writeManifest(m: Manifest): void {
  const sorted: Manifest = { ...m, files: Object.fromEntries(Object.entries(m.files).sort()) };
  writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 1) + "\n");
}

async function fetchBuf(url: string, tries = 5): Promise<Buffer> {
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(`download failed: ${url}: ${String(err)}`);
}

function rawPath(src: AssetSource, day: string): string {
  return join(DATA_ROOT, "raw", `${src.symbol}-${src.interval}-${day}.zip`);
}

/** Parses a kline CSV into [openTimeSec, open, close] triples. Timestamps are ms or µs. */
export function parseKlines(csv: string): { openSec: number; open: number; close: number }[] {
  const out: { openSec: number; open: number; close: number }[] = [];
  let pos = 0;
  while (pos < csv.length) {
    let eol = csv.indexOf("\n", pos);
    if (eol < 0) eol = csv.length;
    if (eol > pos) {
      const c1 = csv.indexOf(",", pos);
      const c2 = csv.indexOf(",", c1 + 1);
      const c3 = csv.indexOf(",", c2 + 1);
      const c4 = csv.indexOf(",", c3 + 1);
      const c5 = csv.indexOf(",", c4 + 1);
      const t = Number(csv.slice(pos, c1));
      if (Number.isFinite(t) && t > 0) {
        // Spot archives switched from ms to µs on 2025-01-01.
        const sec = t > 1e14 ? t / 1e6 : t > 1e11 ? t / 1e3 : t;
        out.push({
          openSec: Math.floor(sec),
          open: Number(csv.slice(c1 + 1, c2)),
          close: Number(csv.slice(c4 + 1, c5)),
        });
      }
    }
    pos = eol + 1;
  }
  return out;
}

/** Downloads (if absent), verifies against Binance's checksum and the pinned manifest. */
export async function ensureArchive(
  src: AssetSource,
  day: string,
  manifest: Manifest,
  opts: { verifyOnly?: boolean } = {},
): Promise<Buffer> {
  const path = rawPath(src, day);
  const key = `${src.symbol}-${src.interval}-${day}`;
  let buf: Buffer;
  if (existsSync(path)) {
    buf = readFileSync(path);
  } else {
    if (opts.verifyOnly) throw new Error(`missing archive ${key}; run \`pnpm backtest:data\``);
    mkdirSync(dirname(path), { recursive: true });
    buf = await fetchBuf(archiveUrl(src, day));
    writeFileSync(path, buf);
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  const pinned = manifest.files[key];
  if (pinned) {
    if (pinned.sha256 !== sha) throw new Error(`${key}: sha256 ${sha} != pinned ${pinned.sha256}`);
  } else {
    if (opts.verifyOnly) throw new Error(`${key} is not in the manifest`);
    const published = (await fetchBuf(`${archiveUrl(src, day)}.CHECKSUM`))
      .toString("utf8")
      .split(/\s+/)[0];
    if (published !== sha)
      throw new Error(`${key}: sha256 ${sha} != Binance CHECKSUM ${published}`);
    const rows = parseKlines(unzipFirst(buf).data.toString("utf8")).length;
    manifest.files[key] = { sha256: sha, bytes: buf.length, rows };
  }
  return buf;
}

export type SeriesStats = {
  label: string;
  firstDay: string;
  lastDay: string;
  days: number;
  samples: number;
  missingSamples: number;
  missingPct: number;
  longestGapSec: number;
};

/** Builds the price series for a window, forward-filling samples with no trades. */
export function buildSeries(
  src: AssetSource,
  dayList: string[],
  buffers: Buffer[],
): { series: PriceSeries; stats: SeriesStats } {
  const t0 = epochSec(dayList[0]!);
  const n = (dayList.length * 86_400) / src.stepSec + 1;
  const px = new Float64Array(n).fill(NaN);
  for (const buf of buffers) {
    for (const k of parseKlines(unzipFirst(buf).data.toString("utf8"))) {
      // The bar opening at o closes at o + step: that close is the price at time o + step.
      const idx = (k.openSec + src.stepSec - t0) / src.stepSec;
      if (idx >= 0 && idx < n) px[idx] = k.close;
      if (idx === 1 && Number.isNaN(px[0]!)) px[0] = k.open; // the first bar's open is the price at t0
    }
  }
  let missing = 0;
  let longest = 0;
  let run = 0;
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(px[i]!)) {
      missing++;
      run++;
      longest = Math.max(longest, run);
      if (!Number.isNaN(last)) px[i] = last;
    } else {
      run = 0;
      last = px[i]!;
    }
  }
  // Leading gap: back-fill from the first observed price.
  const first = px.find((v) => !Number.isNaN(v));
  if (first === undefined) throw new Error(`${src.symbol}: no data`);
  for (let i = 0; i < n && Number.isNaN(px[i]!); i++) px[i] = first;
  return {
    series: { label: src.label, t0, stepSec: src.stepSec, px },
    stats: {
      label: src.label,
      firstDay: dayList[0]!,
      lastDay: dayList[dayList.length - 1]!,
      days: dayList.length,
      samples: n,
      missingSamples: missing,
      missingPct: (100 * missing) / n,
      longestGapSec: longest * src.stepSec,
    },
  };
}

/** Day list for an asset: the evaluation window plus the warm-up day(s) before it. */
export function windowDays(): string[] {
  return days(addDays(WINDOW.start, -WINDOW.warmupDays), WINDOW.end);
}

/** Loads a series from the verified archives (no network; use `downloadAll` first). */
export function loadSeries(label: string): { series: PriceSeries; stats: SeriesStats } {
  const src = SOURCES[label];
  if (!src) throw new Error(`unknown asset ${label}`);
  const manifest = readManifest();
  if (!manifest) throw new Error("data/manifest.json missing; run `pnpm backtest:data`");
  const list = windowDays();
  const buffers = list.map((d) => {
    const key = `${src.symbol}-${src.interval}-${d}`;
    const pinned = manifest.files[key];
    if (!pinned) throw new Error(`${key} not in manifest; run \`pnpm backtest:data\``);
    const path = rawPath(src, d);
    if (!existsSync(path)) throw new Error(`missing ${path}; run \`pnpm backtest:data\``);
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== pinned.sha256) throw new Error(`${key}: sha256 mismatch against manifest`);
    return buf;
  });
  return buildSeries(src, list, buffers);
}

/** Downloads and verifies every archive for the given assets, updating the manifest. */
export async function downloadAll(labels: string[], concurrency = 6): Promise<void> {
  const manifest: Manifest = readManifest() ?? {
    source: "https://data.binance.vision (Binance Data Collection)",
    window: { ...WINDOW },
    files: {},
  };
  const jobs: (() => Promise<void>)[] = [];
  for (const label of labels) {
    const src = SOURCES[label]!;
    for (const day of windowDays()) {
      jobs.push(async () => void (await ensureArchive(src, day, manifest)));
    }
  }
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      await j();
      if (++done % 20 === 0) console.log(`  ${done}/${jobs.length} archives`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  manifest.window = { ...WINDOW };
  writeManifest(manifest);
}
