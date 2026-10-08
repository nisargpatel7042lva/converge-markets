/**
 * Generators: every consumer of the mainnet deployment (keeper, indexer, app, monitoring) is derived
 * from deployments/mainnet.json and config/, never typed by hand, so an address cannot drift.
 * Outputs go to deployments/generated/<network>/ (git-ignored: they are derived files).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, type Address } from "viem";
import { MAINNET_CHAIN_ID, SIGMA_BANDS, USDC, VENUE_MIN_REWARD } from "./constants";
import { loadLaunchParams, repoRoot } from "./params";
import type { Deployment } from "./state";

/** Mainnet price venues per asset: verified 2026-10-08 (docs/EXTERNAL.md, Phase 9 section). */
export const EXCHANGE_SYMBOLS: Record<
  string,
  { binance: string; coinbase: string; chainlink: Address; name: string }
> = {
  "BTC/USD": {
    binance: "BTCUSDT",
    coinbase: "BTC-USD",
    chainlink: "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546",
    name: "BTC",
  },
  "ETH/USD": {
    binance: "ETHUSDT",
    coinbase: "ETH-USD",
    chainlink: "0x1B1414782B859871781bA3E4B0979b9ca57A0A04",
    name: "ETH",
  },
};

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const EXPLORER = "https://monadvision.com";

const readJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(resolve(repoRoot, rel), "utf8")) as T;
const wadToNumber = (x: bigint): number => Number(x) / 1e18;

export interface KeeperAssetOut {
  label: string;
  feedId: string;
  binance: string;
  coinbase: string;
  chainlink: Address;
  vol: {
    halfLifeSec: number;
    priorAnnualVol: number;
    minAnnualVol: number;
    maxAnnualVol: number;
    scale: number;
  };
}

/** The keeper's file: thresholds from config/keeper.mainnet.base.json, assets from the deployment. */
export function keeperConfig(d: Deployment): Record<string, unknown> {
  const base = readJson<Record<string, unknown>>("config/keeper.mainnet.base.json");
  const sp = readJson<{
    params: { vol: { halfLifeSec: number; priorAnnualVol: number; scale: number } };
  }>("config/strategy.default.json");
  const assets: KeeperAssetOut[] = [];
  for (const [label, a] of Object.entries(d.assets ?? {})) {
    if (a.kind !== "streams") continue; // only Data Streams assets can be quoted (the venue prices from a signed report)
    const ex = EXCHANGE_SYMBOLS[label];
    const band = SIGMA_BANDS[label];
    if (!ex || !band || !a.feedId)
      throw new Error(`${label}: no price venues or sigma band configured`);
    assets.push({
      label,
      feedId: a.feedId,
      binance: ex.binance,
      coinbase: ex.coinbase,
      chainlink: getAddress(ex.chainlink),
      // the estimate is clamped to the vault's owner-set band, or setSigma would revert and sigma would go stale
      vol: {
        halfLifeSec: sp.params.vol.halfLifeSec,
        priorAnnualVol: Math.min(
          Math.max(sp.params.vol.priorAnnualVol, wadToNumber(band.min)),
          wadToNumber(band.max),
        ),
        minAnnualVol: wadToNumber(band.min),
        maxAnnualVol: wadToNumber(band.max),
        scale: sp.params.vol.scale,
      },
    });
  }
  if (assets.length === 0) throw new Error("the deployment has no Data Streams asset to quote");
  return { ...base, assets };
}

/** NEXT_PUBLIC_DEPLOYMENT_JSON for the app: only the assets that have liquidity are listed. */
export function appDeployment(d: Deployment, rpcUrl: string): Record<string, unknown> {
  if (!d.marketFactory || !d.vault) throw new Error("deployment is incomplete");
  const series = Object.entries(d.assets ?? {})
    .filter(([, a]) => a.kind === "streams")
    .map(([label, a]) => {
      const ex = EXCHANGE_SYMBOLS[label];
      if (!ex) throw new Error(`${label}: no exchange symbols`);
      return {
        label,
        assetId: a.assetId,
        name: ex.name,
        pair: label,
        symbol: ex.name,
        binance: ex.binance,
        coinbase: ex.coinbase,
        durations: readJson<{ durations: number[] }>("config/series.json").durations,
        decimals: ex.name === "BTC" ? 0 : 2,
      };
    });
  return {
    name: "Monad",
    network: "mainnet",
    chainId: d.chainId,
    rpcUrl,
    explorerUrl: EXPLORER,
    multicall3: MULTICALL3,
    nativeSymbol: "MON",
    usdc: USDC,
    factory: d.marketFactory,
    vault: d.vault.vault,
    venue: d.vault.forwardVenue,
    minRewardWei: VENUE_MIN_REWARD.toString(),
    deployBlock: d.vault.deployBlock,
    testnet: false,
    series,
  };
}

/** The launch parameters, as the report and the runbook quote them (so docs cannot drift from config). */
export function launchSummary(d: Deployment) {
  const p = loadLaunchParams();
  return {
    tvlCapUsdc: Number(BigInt(d.vault?.tvlCap ?? "0")) / 1e6,
    perMarketMaxFraction: wadToNumber(p.perMarketMaxFraction),
    totalAtRiskMaxFraction: wadToNumber(p.totalAtRiskMaxFraction),
    epochLengthSec: d.vault?.epochLength,
  };
}

export function writeGenerated(network: string, name: string, content: string): string {
  const f = resolve(repoRoot, "deployments/generated", network, name);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
}

export function assertMainnet(d: Deployment): void {
  if (d.chainId !== MAINNET_CHAIN_ID) throw new Error(`deployment is for chain ${d.chainId}`);
}
