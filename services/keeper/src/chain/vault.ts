import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  marketFactoryAbi,
  mockErc20Abi,
} from "@converge/sdk";
import type { OnchainParams } from "@converge/strategy";
import type { Address, Hex, PublicClient } from "viem";
import { type Clients, tracked } from "./clients";

export const MARKET_STATE = {
  CREATED: 0,
  OPEN: 1,
  RESOLVED_UP: 2,
  RESOLVED_DOWN: 3,
  INVALID: 4,
} as const;

export type AssetState = {
  assetId: Hex;
  label: string;
  enabled: boolean;
  feedId: Hex;
  /** Annual volatility the vault holds (float); 0 = never set. */
  sigma: number;
  sigmaUpdatedAt: number;
  sigmaMin: number;
  sigmaMax: number;
};

export type MarketInfo = {
  address: Address;
  assetId: Hex;
  start: number;
  end: number;
  state: number;
  /** Strike in the report's 18-decimal scale (0 until open). */
  strike: bigint;
  up: Address;
  down: Address;
  redeemFeeBps: number;
  registered: boolean;
  tradable: boolean;
  /** Token balances held by the vault (asset units, 6 dp). */
  upBal: bigint;
  downBal: bigint;
  basis: bigint;
  cash: bigint;
};

export type EpochState = {
  id: number;
  end: number;
  depositAssets: bigint;
  redeemShares: bigint;
  settled: boolean;
  plan: { feeds: Hex[]; unresolved: Address[] } | null;
};

export type VaultState = {
  blockNumber: bigint;
  /** Chain time of the block read, seconds. */
  now: number;
  navLower: bigint;
  navUpper: bigint;
  navUpdatedAt: number;
  quotingPaused: boolean;
  keeperHalt: boolean;
  freeLiquidity: bigint;
  totalSupply: bigint;
  currentEpoch: number;
  settleWindow: number;
  assets: AssetState[];
  /** Registered markets plus the candidate (listed, not registered) markets in the lookahead. */
  markets: MarketInfo[];
  epochs: EpochState[];
  params: OnchainParams;
  limits: {
    maxSigmaStepBps: number;
    sigmaMinInterval: number;
    sigmaMaxAge: number;
    navMaxAge: number;
    marketCount: number;
    maxPairFraction: number;
    maxInventoryFraction: number;
  };
};

export type Addresses = { vault: Address; venue: Address; factory: Address; usdc: Address };

const WAD = 1e18;
const num = (x: bigint) => Number(x);

/** Static facts about a market never change: read once. */
type Static = Pick<MarketInfo, "assetId" | "start" | "end" | "up" | "down" | "redeemFeeBps">;

export class VaultReader {
  private readonly statics = new Map<string, Static>();
  private paramsCache: { at: number; v: OnchainParams } | null = null;
  private limitsCache: VaultState["limits"] | null = null;
  private settleWindow: number | null = null;

  constructor(
    private readonly c: Clients,
    private readonly a: Addresses,
    private readonly assets: readonly { assetId: Hex; label: string; durations: number[] }[],
    /** Rounds listed this far ahead of now are candidates. */
    private readonly lookaheadRounds = 2,
  ) {}

  private get pub(): PublicClient {
    return this.c.pub;
  }

  private rd<T>(
    address: Address,
    abi: unknown,
    functionName: string,
    args: unknown[] = [],
  ): Promise<T> {
    return tracked(this.c, () =>
      this.pub.readContract({ address, abi, functionName, args } as never),
    ) as Promise<T>;
  }

  async read(): Promise<VaultState> {
    const { vault, venue, factory, usdc } = this.a;
    const v = <T>(fn: string, args: unknown[] = []) =>
      this.rd<T>(vault, convergeVaultAbi, fn, args);
    const block = await tracked(this.c, () => this.pub.getBlock());
    const now = Number(block.timestamp);

    const [
      navLower,
      navUpper,
      navUpdatedAt,
      quotingPaused,
      keeperHalt,
      currentEpoch,
      totalSupply,
      pendingDeposits,
      claimableAssets,
      usdcBal,
      count,
    ] = await Promise.all([
      v<bigint>("quoteNavLower"),
      v<bigint>("lastNavUpper"),
      v<bigint>("navUpdatedAt"),
      v<boolean>("quotingPaused"),
      v<boolean>("keeperHalt"),
      v<bigint>("currentEpoch"),
      v<bigint>("totalSupply"),
      v<bigint>("pendingDeposits"),
      v<bigint>("claimableAssets"),
      this.rd<bigint>(usdc, mockErc20Abi, "balanceOf", [vault]),
      v<bigint>("marketCount"),
    ]);
    const reserved = pendingDeposits + claimableAssets;

    const [params, limits, settleWindow] = await Promise.all([
      this.getParams(),
      this.getLimits(Number(count)),
      this.getSettleWindow(),
    ]);
    limits.marketCount = Number(count);

    // ---- assets
    const assets: AssetState[] = await Promise.all(
      this.assets.map(async (as) => {
        const r = await v<readonly [boolean, Hex, bigint, bigint, bigint, bigint]>("assetCfg", [
          as.assetId,
        ]);
        return {
          assetId: as.assetId,
          label: as.label,
          enabled: r[0],
          feedId: r[1],
          sigma: num(r[2]) / WAD,
          sigmaUpdatedAt: num(r[3]),
          sigmaMin: num(r[4]) / WAD,
          sigmaMax: num(r[5]) / WAD,
        };
      }),
    );

    // ---- registered markets, then candidates not yet registered
    const registered = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) => v<Address>("marketAt", [BigInt(i)])),
    );
    const candidates = await this.candidates(now);
    const addrs = [
      ...new Set([...registered, ...candidates].map((x) => x.toLowerCase() as Address)),
    ];
    const regSet = new Set(registered.map((x) => x.toLowerCase()));
    const markets = await Promise.all(
      addrs.map((m) => this.market(m, regSet.has(m.toLowerCase()), vault, venue)),
    );

    // ---- recent epochs with requests
    const epochs: EpochState[] = [];
    const cur = Number(currentEpoch);
    for (let id = Math.max(0, cur - 2); id < cur; id++) {
      const [e, end] = await Promise.all([
        v<readonly [bigint, bigint, boolean, boolean, bigint, bigint, bigint]>("epochs", [
          BigInt(id),
        ]),
        v<bigint>("epochEnd", [BigInt(id)]),
      ]);
      const open = !e[2] && (e[0] > 0n || e[1] > 0n);
      const plan = open
        ? await v<readonly [Hex[], Address[]]>("settlementPlan", [BigInt(id)])
        : null;
      epochs.push({
        id,
        end: Number(end),
        depositAssets: e[0],
        redeemShares: e[1],
        settled: e[2],
        plan: plan ? { feeds: [...plan[0]], unresolved: [...plan[1]] } : null,
      });
    }

    return {
      blockNumber: block.number as bigint,
      now,
      navLower,
      navUpper,
      navUpdatedAt: num(navUpdatedAt),
      quotingPaused,
      keeperHalt,
      freeLiquidity: usdcBal > reserved ? usdcBal - reserved : 0n,
      totalSupply,
      currentEpoch: cur,
      settleWindow,
      assets,
      markets,
      epochs,
      params,
      limits,
    };
  }

  private async getSettleWindow(): Promise<number> {
    this.settleWindow ??= Number(
      await this.rd<bigint>(this.a.vault, convergeVaultAbi, "settleWindow"),
    );
    return this.settleWindow;
  }

  private async getLimits(count: number): Promise<VaultState["limits"]> {
    if (!this.limitsCache) {
      const v = <T>(fn: string) => this.rd<T>(this.a.vault, convergeVaultAbi, fn);
      const [a, b, c, d, e, f] = await Promise.all([
        v<bigint>("maxSigmaStepBps"),
        v<bigint>("sigmaMinInterval"),
        v<bigint>("sigmaMaxAge"),
        v<bigint>("navMaxAge"),
        v<bigint>("maxPairFraction"),
        v<bigint>("maxInventoryFraction"),
      ]);
      this.limitsCache = {
        maxSigmaStepBps: Number(a),
        sigmaMinInterval: Number(b),
        sigmaMaxAge: Number(c),
        navMaxAge: Number(d),
        marketCount: count,
        maxPairFraction: Number(e) / WAD,
        maxInventoryFraction: Number(f) / WAD,
      };
    }
    return { ...this.limitsCache };
  }

  private async getParams(): Promise<OnchainParams> {
    const now = Date.now();
    if (this.paramsCache && now - this.paramsCache.at < 60_000) return this.paramsCache.v;
    const p = await this.rd<Record<string, bigint>>(this.a.vault, convergeVaultAbi, "quoteParams");
    const f = (k: string) => Number(p[k] as bigint) / WAD;
    const v: OnchainParams = {
      minHalfSpread: f("minHalfSpread"),
      maxHalfSpread: f("maxHalfSpread"),
      volSpreadK: f("volSpreadK"),
      stalenessSec: f("stalenessSec"),
      inventorySkewMax: f("inventorySkewMax"),
      inventorySkewK: f("inventorySkewK"),
      noQuoteWindowSec: Number(p.noQuoteWindowSec as bigint),
      priceMin: f("priceMin"),
      priceMax: f("priceMax"),
      tick: f("tick"),
      levels: Number(p.levels as bigint),
      baseRangeTicks: f("baseRangeTicks"),
      minRangeTicks: f("minRangeTicks"),
      liquidityNavFraction: f("liquidityNavFraction"),
      minLevelSize: Number(p.minLevelSize as bigint) / WAD,
      perMarketMaxFraction: f("perMarketMaxFraction"),
      totalAtRiskMaxFraction: f("totalAtRiskMaxFraction"),
    };
    this.paramsCache = { at: now, v };
    return v;
  }

  /** Rounds on the grid around now, for each asset and duration, that the factory has created. */
  private async candidates(now: number): Promise<Address[]> {
    const out: Address[] = [];
    const calls: Promise<void>[] = [];
    for (const a of this.assets) {
      for (const dur of a.durations) {
        const base = Math.floor(now / dur) * dur;
        for (let k = -1; k <= this.lookaheadRounds; k++) {
          const start = base + k * dur;
          calls.push(
            this.rd<Address>(this.a.factory, marketFactoryAbi, "getMarket", [
              a.assetId,
              BigInt(dur),
              BigInt(start),
            ]).then((m) => {
              if (m !== "0x0000000000000000000000000000000000000000") out.push(m);
            }),
          );
        }
      }
    }
    await Promise.all(calls);
    return out;
  }

  private async market(
    m: Address,
    registered: boolean,
    vault: Address,
    venue: Address,
  ): Promise<MarketInfo> {
    const key = m.toLowerCase();
    let st = this.statics.get(key);
    if (!st) {
      const r = <T>(fn: string) => this.rd<T>(m, marketAbi, fn);
      const [assetId, start, end, up, down, fee] = await Promise.all([
        r<Hex>("assetId"),
        r<bigint>("startTime"),
        r<bigint>("endTime"),
        r<Address>("up"),
        r<Address>("down"),
        r<number | bigint>("redeemFeeBps"),
      ]);
      st = { assetId, start: Number(start), end: Number(end), up, down, redeemFeeBps: Number(fee) };
      this.statics.set(key, st);
    }
    const [state, strike] = await Promise.all([
      this.rd<number>(m, marketAbi, "state"),
      this.rd<bigint>(m, marketAbi, "strike"),
    ]);
    let upBal = 0n;
    let downBal = 0n;
    let basis = 0n;
    let cash = 0n;
    let tradable = false;
    if (registered) {
      const [u, d, pos, view] = await Promise.all([
        this.rd<bigint>(st.up, mockErc20Abi, "balanceOf", [vault]),
        this.rd<bigint>(st.down, mockErc20Abi, "balanceOf", [vault]),
        this.rd<readonly [bigint, bigint]>(vault, convergeVaultAbi, "positionOf", [m]),
        this.rd<{ tradable: boolean }>(vault, convergeVaultAbi, "venueView", [m]),
      ]);
      upBal = u;
      downBal = d;
      basis = pos[0];
      cash = pos[1];
      tradable = view.tradable;
    }
    void venue;
    return {
      address: m,
      ...st,
      state: Number(state),
      strike: strike as bigint,
      registered,
      tradable,
      upBal,
      downBal,
      basis,
      cash,
    };
  }
}

export type OrderRow = {
  id: bigint;
  taker: Address;
  kind: number;
  status: number; // 0 NONE, 1 OPEN, 2 DONE
  execAt: number;
  market: Address;
  shares: bigint;
  limit: bigint;
  escrow: bigint;
  reward: bigint;
};

export async function readOrder(c: Clients, venue: Address, id: bigint): Promise<OrderRow> {
  const r = (await tracked(c, () =>
    c.pub.readContract({
      address: venue,
      abi: forwardVenueAbi,
      functionName: "orders",
      args: [id],
    }),
  )) as readonly [Address, number, number, bigint, Address, bigint, bigint, bigint, bigint];
  return {
    id,
    taker: r[0],
    kind: Number(r[1]),
    status: Number(r[2]),
    execAt: Number(r[3]),
    market: r[4],
    shares: r[5],
    limit: r[6],
    escrow: r[7],
    reward: r[8],
  };
}

export async function readNextOrderId(c: Clients, venue: Address): Promise<bigint> {
  return (await tracked(c, () =>
    c.pub.readContract({ address: venue, abi: forwardVenueAbi, functionName: "nextOrderId" }),
  )) as bigint;
}
