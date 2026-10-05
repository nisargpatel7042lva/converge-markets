import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, SOURCES, loadSeries, readManifest, windowDays } from "./binance";
import type { PriceSeries } from "./series";

/** Binary cache of the derived close-price series, keyed by the manifest's pinned hashes. */
export function loadSeriesCached(label: string): PriceSeries {
  const src = SOURCES[label];
  if (!src) throw new Error(`unknown asset ${label}`);
  const manifest = readManifest();
  if (!manifest) throw new Error("data/manifest.json missing; run `pnpm backtest:data`");
  const prefix = `${src.symbol}-${src.interval}-`;
  const digest = createHash("sha256")
    .update(JSON.stringify(windowDays().map((d) => manifest.files[`${prefix}${d}`]?.sha256 ?? "")))
    .digest("hex");
  const dir = join(DATA_ROOT, "cache");
  const bin = join(dir, `${src.symbol}-${src.interval}.f64`);
  const meta = join(dir, `${src.symbol}-${src.interval}.json`);
  if (existsSync(bin) && existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8")) as {
      digest: string;
      t0: number;
      stepSec: number;
    };
    if (m.digest === digest) {
      const buf = readFileSync(bin);
      const px = new Float64Array(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      return { label, t0: m.t0, stepSec: m.stepSec, px };
    }
  }
  const { series } = loadSeries(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(bin, Buffer.from(series.px.buffer, series.px.byteOffset, series.px.byteLength));
  writeFileSync(meta, JSON.stringify({ digest, t0: series.t0, stepSec: series.stepSec }));
  return series;
}
