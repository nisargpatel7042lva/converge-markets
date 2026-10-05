import { deflateRawSync } from "node:zlib";
import type { PriceSeries } from "../src/data/series";
import { Rng } from "../src/rng";

/** A random-walk 1 s price series starting at `t0` (unix seconds), annual vol `sigma`. */
export function synthSeries(
  label: string,
  t0: number,
  seconds: number,
  sigma: number,
  seed: number,
): PriceSeries {
  const r = new Rng(seed);
  const px = new Float64Array(seconds + 1);
  px[0] = 100;
  const sd = sigma / Math.sqrt(365.25 * 86_400);
  for (let i = 1; i <= seconds; i++) px[i] = px[i - 1]! * Math.exp(sd * r.normal());
  return { label, t0, stepSec: 1, px };
}

/** Builds a minimal valid single-entry ZIP (deflate) for tests. */
export function makeZip(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = 30 + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}
