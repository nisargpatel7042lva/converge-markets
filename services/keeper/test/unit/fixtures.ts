import type { Address, Hex } from "viem";
import type { MarketInfo, OrderRow, VaultState } from "../../src/chain/vault";
import { DEFAULT_PARAMS_ONCHAIN } from "./params";

export const ASSET: Hex = `0x${"aa".repeat(32)}`;
export const FEED: Hex = `0x0003${"bb".repeat(30)}`;
export const MKT = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const NOW = 1_800_000_000;
export const USDC = (x: number) => BigInt(Math.round(x * 1e6));

export function market(over: Partial<MarketInfo> = {}): MarketInfo {
  return {
    address: MKT(1),
    assetId: ASSET,
    start: NOW - 300,
    end: NOW + 600,
    state: 1,
    strike: 3000n * 10n ** 18n,
    up: MKT(101),
    down: MKT(102),
    redeemFeeBps: 0,
    registered: true,
    tradable: true,
    upBal: USDC(50),
    downBal: USDC(50),
    basis: USDC(50),
    cash: 0n,
    ...over,
  };
}

export function state(over: Partial<VaultState> = {}): VaultState {
  return {
    blockNumber: 1000n,
    now: NOW,
    navLower: USDC(1000),
    navUpper: USDC(1000),
    navUpdatedAt: NOW - 30,
    quotingPaused: false,
    keeperHalt: false,
    freeLiquidity: USDC(900),
    totalSupply: USDC(1000),
    currentEpoch: 10,
    settleWindow: 600,
    assets: [
      {
        assetId: ASSET,
        label: "TEST/USD",
        enabled: true,
        feedId: FEED,
        sigma: 0.6,
        sigmaUpdatedAt: NOW - 100,
        sigmaMin: 0.4,
        sigmaMax: 1.2,
      },
    ],
    markets: [market()],
    epochs: [],
    params: DEFAULT_PARAMS_ONCHAIN,
    limits: {
      maxSigmaStepBps: 2000,
      sigmaMinInterval: 30,
      sigmaMaxAge: 900,
      navMaxAge: 1800,
      marketCount: 1,
      maxPairFraction: 0.3,
      maxInventoryFraction: 0.5,
    },
    ...over,
  };
}

export function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 1n,
    taker: MKT(7),
    kind: 0,
    status: 1,
    execAt: NOW - 1,
    market: MKT(1),
    shares: USDC(2),
    limit: 6n * 10n ** 17n,
    escrow: USDC(1.2),
    reward: 10n ** 15n,
    ...over,
  };
}
