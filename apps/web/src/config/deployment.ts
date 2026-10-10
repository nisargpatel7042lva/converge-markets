import type { Address } from "viem";
import testnet from "./testnet.json";

export type Series = {
  /** The factory's asset label, e.g. "TEST/USD" (assetId = keccak256 of it). */
  label: string;
  assetId: `0x${string}`;
  /** Short name shown to people: "ETH". */
  name: string;
  pair: string;
  /** Exchange symbols for the live price. */
  symbol: string;
  binance: string;
  coinbase: string;
  durations: number[];
  decimals: number;
};

export type Deployment = {
  name: string;
  network: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  /** Multicall3 address when the chain has one (batching of reads). */
  multicall3?: Address;
  nativeSymbol: string;
  usdc: Address;
  factory: Address;
  vault: Address;
  venue: Address;
  minRewardWei: string;
  deployBlock?: number;
  testnet: boolean;
  series: Series[];
};

/**
 * Baked at build time: NEXT_PUBLIC_DEPLOYMENT_JSON (a whole deployment, used by the e2e run on a
 * local chain) or the committed testnet file generated from deployments/testnet.json.
 */
function load(): Deployment {
  const raw = process.env.NEXT_PUBLIC_DEPLOYMENT_JSON;
  return (raw ? JSON.parse(raw) : testnet) as Deployment;
}

export const deployment: Deployment = load();

export const env = {
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL || undefined,
  indexerKey: process.env.NEXT_PUBLIC_INDEXER_KEY || undefined,
  posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined,
  posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
  appEnv: process.env.NEXT_PUBLIC_APP_ENV || "development",
  /** Test builds only (refused by next.config.ts when appEnv is production). */
  mockPrices: process.env.NEXT_PUBLIC_MOCK_PRICES === "1",
  /** Testnet: pin the live price to the oracle reference price (see /api/ref-price). */
  refPrice: process.env.NEXT_PUBLIC_REF_PRICE === "1",
  faucetEnabled: process.env.NEXT_PUBLIC_FAUCET_ENABLED === "1",
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "",
};

export const isProd = env.appEnv === "production";
