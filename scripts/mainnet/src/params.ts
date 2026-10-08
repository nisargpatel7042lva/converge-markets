/** config/strategy.default.json -> the vault's on-chain QuoteMath.Params (WAD). One source of truth. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");

export interface OnchainParams {
  minHalfSpread: bigint;
  maxHalfSpread: bigint;
  volSpreadK: bigint;
  stalenessSec: bigint;
  inventorySkewMax: bigint;
  inventorySkewK: bigint;
  noQuoteWindowSec: bigint;
  priceMin: bigint;
  priceMax: bigint;
  tick: bigint;
  levels: bigint;
  baseRangeTicks: bigint;
  minRangeTicks: bigint;
  liquidityNavFraction: bigint;
  minLevelSize: bigint;
  perMarketMaxFraction: bigint;
  totalAtRiskMaxFraction: bigint;
}

/** A decimal as WAD without float error (9 digits of precision is far finer than any parameter). */
export const wad = (x: number): bigint => BigInt(Math.round(x * 1e9)) * 1_000_000_000n;

export function loadLaunchParams(
  path = resolve(repoRoot, "config/strategy.default.json"),
): OnchainParams {
  const p = (JSON.parse(readFileSync(path, "utf8")) as { params: Record<string, number> }).params;
  const need = (k: string): number => {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`strategy.default.json: ${k} is missing`);
    return v;
  };
  return {
    minHalfSpread: wad(need("minHalfSpread")),
    maxHalfSpread: wad(need("maxHalfSpread")),
    volSpreadK: wad(need("volSpreadK")),
    stalenessSec: wad(need("stalenessSec")),
    inventorySkewMax: wad(need("inventorySkewMax")),
    inventorySkewK: wad(need("inventorySkewK")),
    noQuoteWindowSec: BigInt(need("noQuoteWindowSec")),
    priceMin: wad(need("priceMin")),
    priceMax: wad(need("priceMax")),
    tick: wad(need("tick")),
    levels: BigInt(need("levels")),
    baseRangeTicks: wad(need("baseRangeTicks")),
    minRangeTicks: wad(need("minRangeTicks")),
    liquidityNavFraction: wad(need("liquidityNavFraction")),
    minLevelSize: BigInt(need("minLevelSize")),
    perMarketMaxFraction: wad(need("perMarketMaxFraction")),
    totalAtRiskMaxFraction: wad(need("totalAtRiskMaxFraction")),
  };
}
