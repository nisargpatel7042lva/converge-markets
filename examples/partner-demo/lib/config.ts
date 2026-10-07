/**
 * Runtime configuration, read from NEXT_PUBLIC_* variables so the same build can point at any
 * deployment (docs/partners.md lists them). Nothing here is secret: it is all in the browser.
 */
import type { ConvergeAddresses } from "@converge/sdk";
import { defineChain, type Address, type Chain } from "viem";
import { monadTestnet } from "viem/chains";

export interface DemoConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  addresses: ConvergeAddresses;
  /** The partner market to embed (create one with `pnpm create-market`). */
  market: Address | null;
  /** Shown in the headline, e.g. "ETH". */
  assetLabel: string;
  /** Binance symbol used only to show an indicative spot price; the vault prices from the oracle. */
  spotSymbol: string;
  /** Skips the spot request and uses this price (tests, offline demos). */
  spotFixed: number | null;
  indexerUrl: string | null;
}

const must = (name: string, v: string | undefined): string => {
  if (!v) throw new Error(`${name} is not set (see examples/partner-demo/README.md)`);
  return v;
};

export function readConfig(env: Record<string, string | undefined>): DemoConfig {
  const chainId = Number(env.NEXT_PUBLIC_CHAIN_ID ?? monadTestnet.id);
  return {
    chainId,
    chainName: chainId === monadTestnet.id ? monadTestnet.name : `chain ${chainId}`,
    rpcUrl: env.NEXT_PUBLIC_RPC_URL ?? monadTestnet.rpcUrls.default.http[0],
    addresses: {
      registry: must("NEXT_PUBLIC_REGISTRY", env.NEXT_PUBLIC_REGISTRY) as Address,
      vault: must("NEXT_PUBLIC_VAULT", env.NEXT_PUBLIC_VAULT) as Address,
      venue: must("NEXT_PUBLIC_VENUE", env.NEXT_PUBLIC_VENUE) as Address,
      collateral: must("NEXT_PUBLIC_COLLATERAL", env.NEXT_PUBLIC_COLLATERAL) as Address,
    },
    market: (env.NEXT_PUBLIC_MARKET as Address | undefined) ?? null,
    assetLabel: env.NEXT_PUBLIC_ASSET_LABEL ?? "ETH",
    spotSymbol: env.NEXT_PUBLIC_SPOT_SYMBOL ?? "ETHUSDT",
    spotFixed: env.NEXT_PUBLIC_SPOT_FIXED ? Number(env.NEXT_PUBLIC_SPOT_FIXED) : null,
    indexerUrl: env.NEXT_PUBLIC_INDEXER_URL ?? null,
  };
}

/** The viem chain for a config (built in the browser: a Chain has functions and cannot be a prop). */
export function chainOf(cfg: DemoConfig): Chain {
  if (cfg.chainId === monadTestnet.id) {
    return { ...monadTestnet, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  }
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}
