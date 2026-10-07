/**
 * Builders for mock (simulated) events. Addresses are the real deployed ones from
 * deployments/testnet.json (the config is generated from the same file), so `srcAddress` routing is
 * exactly what production uses; markets and tokens are fake addresses that the factory registers.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(resolve(here, "../../deployments/testnet.json"), "utf8")) as {
  marketFactory: string;
  deployBlock: number;
  vault: { vault: string; forwardVenue: string; deployBlock: number };
};

export const FACTORY = dep.marketFactory.toLowerCase();
export const VAULT = dep.vault.vault.toLowerCase();
export const VENUE = dep.vault.forwardVenue.toLowerCase();
export const FACTORY_BLOCK = dep.deployBlock;
export const VAULT_BLOCK = dep.vault.deployBlock;
export const CHAIN = 10143;
/** The PartnerRegistry the vault announces (PartnerRegistrySet): the indexer follows the vault. */
export const REGISTRY = `0x${"4001".padStart(40, "0")}`;

export const ASSET = "0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const DEAD = "0x000000000000000000000000000000000000dead";

export const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
export const LP = addr(0x1001);
export const LP2 = addr(0x1002);
export const TAKER = addr(0x2001);
export const OTHER = addr(0x2002);
export const COLLATERAL = addr(0x3001);
export const RESOLVER = addr(0x3002);

export interface MarketAddrs {
  market: string;
  up: string;
  down: string;
}
export const marketAddrs = (i: number): MarketAddrs => ({
  market: addr(0xa000 + i),
  up: addr(0xb000 + 2 * i),
  down: addr(0xb000 + 2 * i + 1),
});

export interface Sim {
  contract: string;
  event: string;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string };
  params: Record<string, unknown>;
}

/** Sequential event builder: one block per `tx`, increasing log indexes inside it. */
export class Chain {
  private block = VAULT_BLOCK + 1000;
  private ts: number;
  private log = 0;
  private txn = 0;
  readonly events: Sim[] = [];

  constructor(startTs: number) {
    this.ts = startTs;
  }

  /** Starts a new transaction in a new block `dt` seconds later. */
  tx(dt = 1): this {
    this.block += 1;
    this.ts += dt;
    this.log = 0;
    this.txn += 1;
    return this;
  }

  get now(): number {
    return this.ts;
  }

  get blockNumber(): number {
    return this.block;
  }

  emit(contract: string, event: string, srcAddress: string, params: Record<string, unknown>): this {
    this.events.push({
      contract,
      event,
      srcAddress,
      logIndex: this.log++,
      block: { number: this.block, timestamp: this.ts },
      transaction: { hash: `0x${this.txn.toString(16).padStart(64, "0")}` },
      params,
    });
    return this;
  }

  // ---- factory / market
  assetSet(label = "BTC/USD"): this {
    return this.emit("MarketFactory", "AssetSet", FACTORY, {
      assetId: ASSET,
      resolver: RESOLVER,
      label,
      enabled: true,
    });
  }

  marketCreated(m: MarketAddrs, startTime: number, duration = 900): this {
    return this.emit("MarketFactory", "MarketCreated", FACTORY, {
      market: m.market,
      assetId: ASSET,
      startTime: BigInt(startTime),
      duration: BigInt(duration),
      params: {
        factory: FACTORY,
        assetId: ASSET,
        resolver: RESOLVER,
        collateral: COLLATERAL,
        up: m.up,
        down: m.down,
        startTime: BigInt(startTime),
        endTime: BigInt(startTime + duration),
        redeemFeeBps: 0n,
      },
    });
  }

  /** A partner market: the registry emits the factory-shaped event, then its own. */
  partnerMarketCreated(
    m: MarketAddrs,
    partner: string,
    startTime: number,
    duration: number,
    strike: bigint,
    feeShareBps = 3000,
    redeemFeeBps = 50n,
  ): this {
    this.emit("PartnerRegistry", "MarketCreated", REGISTRY, {
      market: m.market,
      assetId: ASSET,
      startTime: BigInt(startTime),
      duration: BigInt(duration),
      params: {
        factory: REGISTRY,
        assetId: ASSET,
        resolver: RESOLVER,
        collateral: COLLATERAL,
        up: m.up,
        down: m.down,
        startTime: BigInt(startTime),
        endTime: BigInt(startTime + duration),
        redeemFeeBps,
      },
    });
    return this.emit("PartnerRegistry", "PartnerMarketCreated", REGISTRY, {
      market: m.market,
      partner,
      assetId: ASSET,
      strike,
      startTime: BigInt(startTime),
      endTime: BigInt(startTime + duration),
      resolver: RESOLVER,
      feeShareBps,
    });
  }
  registry(event: string, params: Record<string, unknown>): this {
    return this.emit("PartnerRegistry", event, REGISTRY, params);
  }

  opened(m: MarketAddrs, strike: bigint): this {
    return this.emit("Market", "Opened", m.market, { strike });
  }
  resolved(m: MarketAddrs, outcome: 2 | 3, strike: bigint, endPrice: bigint): this {
    return this.emit("Market", "Resolved", m.market, {
      outcome: BigInt(outcome),
      strike,
      endPrice,
    });
  }
  invalidated(m: MarketAddrs): this {
    return this.emit("Market", "Invalidated", m.market, { boundary: 0n });
  }
  split(m: MarketAddrs, account: string, amount: bigint): this {
    this.emit("Market", "Split", m.market, { account, amount });
    this.transfer(m.up, ZERO, account, amount, "OutcomeToken");
    return this.transfer(m.down, ZERO, account, amount, "OutcomeToken");
  }
  merged(m: MarketAddrs, account: string, amount: bigint): this {
    this.emit("Market", "Merged", m.market, { account, amount });
    this.transfer(m.up, account, ZERO, amount, "OutcomeToken");
    return this.transfer(m.down, account, ZERO, amount, "OutcomeToken");
  }
  redeemed(
    m: MarketAddrs,
    account: string,
    upBurned: bigint,
    downBurned: bigint,
    payout: bigint,
    fee = 0n,
  ): this {
    this.emit("Market", "Redeemed", m.market, { account, upBurned, downBurned, payout, fee });
    if (upBurned > 0n) this.transfer(m.up, account, ZERO, upBurned, "OutcomeToken");
    if (downBurned > 0n) this.transfer(m.down, account, ZERO, downBurned, "OutcomeToken");
    return this;
  }
  transfer(
    token: string,
    from: string,
    to: string,
    value: bigint,
    contract: "OutcomeToken" | "ConvergeVault" = "OutcomeToken",
  ): this {
    return this.emit(contract, "Transfer", token, { from, to, value });
  }

  // ---- vault
  depositRequested(epochId: number, owner: string, assets: bigint): this {
    return this.emit("ConvergeVault", "DepositRequested", VAULT, {
      epochId: BigInt(epochId),
      owner,
      assets,
    });
  }
  redeemRequested(epochId: number, owner: string, shares: bigint, requeued = false): this {
    this.emit("ConvergeVault", "RedeemRequested", VAULT, {
      epochId: BigInt(epochId),
      owner,
      shares,
      requeued,
    });
    return this;
  }
  epochSettled(p: {
    epochId: number;
    navLower: bigint;
    navUpper: bigint;
    supplyBefore: bigint;
    sharesMinted: bigint;
    sharesBurned: bigint;
    assetsPaid: bigint;
    depositsAccepted: bigint;
    depositRejected?: boolean;
  }): this {
    return this.emit("ConvergeVault", "EpochSettled", VAULT, {
      ...p,
      epochId: BigInt(p.epochId),
      depositRejected: p.depositRejected ?? false,
    });
  }
  epochExpired(epochId: number, depositsRefunded: bigint, redeemShares: bigint): this {
    return this.emit("ConvergeVault", "EpochExpired", VAULT, {
      epochId: BigInt(epochId),
      depositsRefunded,
      redeemShares,
    });
  }
  navSnapshot(
    navLower: bigint,
    navUpper: bigint,
    ppsLower: bigint,
    supply: bigint,
    settlement: boolean,
  ): this {
    return this.emit("ConvergeVault", "NavSnapshot", VAULT, {
      navLower,
      navUpper,
      ppsLower,
      supply,
      settlement,
    });
  }
  performanceFee(feeShares: bigint, feeAssets: bigint, newHwm: bigint): this {
    return this.emit("ConvergeVault", "PerformanceFee", VAULT, { feeShares, feeAssets, newHwm });
  }
  depositClaimed(
    epochId: number,
    owner: string,
    receiver: string,
    shares: bigint,
    refunded: bigint,
  ): this {
    return this.emit("ConvergeVault", "DepositClaimed", VAULT, {
      epochId: BigInt(epochId),
      owner,
      receiver,
      shares,
      refunded,
    });
  }
  redeemClaimed(
    epochId: number,
    owner: string,
    receiver: string,
    assets: bigint,
    requeuedShares: bigint,
  ): this {
    return this.emit("ConvergeVault", "RedeemClaimed", VAULT, {
      epochId: BigInt(epochId),
      owner,
      receiver,
      assets,
      requeuedShares,
    });
  }
  fill(p: {
    market: string;
    upToken: boolean;
    vaultSells: boolean;
    units: bigint;
    premium: bigint;
    taker: string;
    basis?: bigint;
    cash?: bigint;
  }): this {
    return this.emit("ConvergeVault", "Fill", VAULT, { basis: 0n, cash: 0n, ...p });
  }
  vault(event: string, params: Record<string, unknown>): this {
    return this.emit("ConvergeVault", event, VAULT, params);
  }
  shareTransfer(from: string, to: string, value: bigint): this {
    return this.transfer(VAULT, from, to, value, "ConvergeVault");
  }

  // ---- venue
  orderPlaced(p: {
    id: number;
    taker: string;
    market: string;
    kind: 0 | 1 | 2 | 3;
    shares: bigint;
    limit: bigint;
    execAt: number;
    reward?: bigint;
  }): this {
    return this.emit("ForwardVenue", "OrderPlaced", VENUE, {
      ...p,
      id: BigInt(p.id),
      kind: BigInt(p.kind),
      execAt: BigInt(p.execAt),
      reward: p.reward ?? 1_000_000_000_000_000n,
    });
  }
  orderExecuted(
    id: number,
    executor: string,
    filled: bigint,
    premium: bigint,
    reportPrice = 65_000n * 10n ** 8n,
  ): this {
    return this.emit("ForwardVenue", "OrderExecuted", VENUE, {
      id: BigInt(id),
      executor,
      filled,
      premium,
      reportPrice,
      reportValidFrom: 1,
      reportObservations: 2,
    });
  }
  orderExpired(id: number, caller: string): this {
    return this.emit("ForwardVenue", "OrderExpired", VENUE, { id: BigInt(id), caller });
  }
}
