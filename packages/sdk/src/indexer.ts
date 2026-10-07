/**
 * Typed GraphQL helpers for the Converge Envio indexer (indexer/schema.graphql, docs in
 * indexer/QUERIES.md). The hosted endpoint is Hasura-style: `<endpoint>/v1/graphql`, entity roots
 * named like the schema types (`Market`, `Market_by_pk`), `where` / `order_by` / `limit` / `offset`.
 *
 * Numeric columns arrive as JSON strings (verified against the local Hasura, 2026-10-06), so
 * BigInt columns are parsed to `bigint` without precision loss; BigDecimal prices are parsed to
 * `number` (they are in [0, 1] with at most 12 decimals).
 *
 * Every query is a plain string constant exported from `INDEXER_QUERIES`, so the latency harness,
 * the docs and the app run exactly the same documents.
 */
export type MarketStatus = "CREATED" | "OPEN" | "RESOLVED_UP" | "RESOLVED_DOWN" | "INVALID";
export type Outcome = "UP" | "DOWN" | "INVALID";
export type Side = "UP" | "DOWN";
export type TradeAction = "BUY" | "SELL";
export type OrderKind = "BUY_UP" | "SELL_UP" | "BUY_DOWN" | "SELL_DOWN";
export type OrderStatus = "OPEN" | "EXECUTED" | "EXPIRED";
export type RequestStatus = "REQUESTED" | "CLAIMABLE" | "REFUNDABLE" | "CLAIMED" | "REFUNDED";
export type EpochStatus = "SETTLED" | "EXPIRED";

// ------------------------------------------------------------------ transport

export interface IndexerClientOptions {
  /** GraphQL endpoint, e.g. https://indexer.dev/<id>/v1/graphql or http://localhost:8080/v1/graphql */
  url: string;
  /** Envio Cloud API key (sent as `Authorization: Bearer <key>`), if the endpoint is gated. */
  apiKey?: string;
  /** Extra headers (e.g. `x-hasura-admin-secret` for the LOCAL dev Hasura). */
  headers?: Record<string, string>;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Abort a request after this many ms (default 15000). */
  timeoutMs?: number;
}

export class IndexerError extends Error {
  constructor(
    message: string,
    readonly errors: readonly unknown[] = [],
    readonly status?: number,
  ) {
    super(message);
    this.name = "IndexerError";
  }
}

export type GqlVariables = Record<string, string | number | boolean | null | readonly string[]>;

export async function indexerQuery<T>(
  o: IndexerClientOptions,
  query: string,
  variables?: GqlVariables,
): Promise<T> {
  const f = o.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", ...o.headers };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await f(o.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new IndexerError(`indexer request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new IndexerError(
      `indexer returned HTTP ${res.status} with a non-JSON body`,
      [],
      res.status,
    );
  }
  if (body.errors?.length) {
    throw new IndexerError(body.errors.map((e) => e.message).join("; "), body.errors, res.status);
  }
  if (!res.ok || body.data === undefined) {
    throw new IndexerError(`indexer returned HTTP ${res.status}`, [], res.status);
  }
  return body.data;
}

// ------------------------------------------------------------------ number parsing

type Num = string | number;
/** BigInt columns arrive as strings. A JSON number is accepted only if it is a safe integer. */
export function toBig(v: Num | bigint): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new IndexerError(
        `numeric value ${v} lost precision: the endpoint must return numerics as strings`,
      );
    }
    return BigInt(v);
  }
  return BigInt(v);
}
const nBig = (v: Num | null | undefined): bigint | null =>
  v === null || v === undefined ? null : toBig(v);
const nNum = (v: Num | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

// ------------------------------------------------------------------ row types

export interface IndexerMeta {
  chainId: number;
  progressBlock: number;
  sourceBlock: number;
  bufferBlock: number;
  eventsProcessed: number;
  isReady: boolean;
  readyAt: string | null;
  startBlock: number;
  endBlock: number | null;
}

export interface MarketRow {
  id: string;
  asset: string;
  assetId: string;
  duration: number;
  startTime: number;
  endTime: number;
  strike: bigint | null;
  endPrice: bigint | null;
  status: MarketStatus;
  outcome: Outcome | null;
  upToken: string;
  downToken: string;
  volume: bigint;
  tradeCount: number;
  lastUpPrice: number | null;
  vaultRegistered: boolean;
  vaultBasis: bigint;
  vaultCash: bigint;
  upSupply: bigint;
  downSupply: bigint;
}

export interface TradeRow {
  id: string;
  marketId: string;
  side: Side;
  action: TradeAction;
  size: bigint;
  premium: bigint;
  price: number;
  taker: string;
  txHash: string;
  block: number;
  timestamp: number;
}

export interface PositionRow {
  id: string;
  user: string;
  marketId: string;
  upBalance: bigint;
  downBalance: bigint;
  upEscrowed: bigint;
  downEscrowed: bigint;
  upCost: bigint;
  downCost: bigint;
  costBasis: bigint;
  realizedPnl: bigint;
  totalIn: bigint;
  totalOut: bigint;
  tradeCount: number;
  market: Pick<
    MarketRow,
    "id" | "asset" | "status" | "outcome" | "lastUpPrice" | "startTime" | "endTime"
  > & { redeemFeeBps: number };
}

export interface VaultRow {
  id: string;
  navLower: bigint;
  navUpper: bigint;
  ppsLower: bigint;
  supply: bigint;
  totalSupply: bigint;
  lastNavTimestamp: number;
  tvlCap: bigint;
  performanceFeeBps: number;
  quotingPaused: boolean;
  quotingHalted: boolean;
  breakerTrips: number;
  settledEpochs: number;
  expiredEpochs: number;
  totalDeposited: bigint;
  totalRedeemed: bigint;
  totalPerformanceFees: bigint;
  totalFillVolume: bigint;
  fillCount: number;
  apy7d: number | null;
  apy30d: number | null;
  return7d: number | null;
  return30d: number | null;
  apySinceInception: number | null;
}

export interface NavSnapshotRow {
  id: string;
  /** As emitted by the vault: for a settlement, BEFORE the epoch's deposits and redemptions. */
  navLower: bigint;
  navUpper: bigint;
  /** After the epoch's flows (equal to the raw values for checkpoints): the NAV the vault stores. */
  navLowerAfter: bigint;
  navUpperAfter: bigint;
  ppsLower: bigint;
  supply: bigint;
  settlement: boolean;
  block: number;
  timestamp: number;
}

export interface EpochRow {
  epochId: number;
  status: EpochStatus | null;
  navLower: bigint | null;
  navUpper: bigint | null;
  ppsLower: bigint | null;
  sharesMinted: bigint | null;
  sharesBurned: bigint | null;
  assetsPaid: bigint | null;
  depositsAccepted: bigint | null;
  feeAssets: bigint;
  depositRequested: bigint;
  redeemRequested: bigint;
  settledTimestamp: number | null;
}

export interface LpRow {
  id: string;
  user: string;
  shares: bigint;
  escrowedShares: bigint;
  costBasis: bigint;
  realizedPnl: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
}

export interface DepositRequestRow {
  id: string;
  epochId: number;
  owner: string;
  assets: bigint;
  status: RequestStatus;
  shares: bigint | null;
  refunded: bigint | null;
}

export interface RedeemRequestRow {
  id: string;
  epochId: number;
  owner: string;
  shares: bigint;
  requeued: boolean;
  status: RequestStatus;
  assets: bigint | null;
  requeuedShares: bigint | null;
}

export interface OrderRow {
  id: string;
  taker: string;
  marketId: string;
  kind: OrderKind;
  status: OrderStatus;
  shares: bigint;
  limit: bigint;
  execAt: number;
  filled: bigint | null;
  premium: bigint | null;
  placedTimestamp: number;
}

export interface DailyStatsRow {
  day: number;
  date: string;
  volume: bigint;
  trades: number;
  feesPerformance: bigint;
  feesRedeem: bigint;
  depositsAssets: bigint;
  redeemedAssets: bigint;
  tvlClose: bigint;
  ppsClose: bigint | null;
  activeUsers: number;
  newUsers: number;
  marketsCreated: number;
  marketsResolved: number;
}

export interface ProtocolStatsRow {
  totalVolume: bigint;
  totalTrades: number;
  totalFeesPerformance: bigint;
  totalFeesRedeem: bigint;
  totalMarkets: number;
  totalMarketsResolved: number;
  totalUsers: number;
  totalDeposited: bigint;
  totalRedeemed: bigint;
  tvl: bigint;
  lastUpdatedBlock: number;
}

// ------------------------------------------------------------------ field selections

const MARKET_FIELDS = `id asset assetId duration startTime endTime strike endPrice status outcome upToken downToken volume tradeCount lastUpPrice vaultRegistered vaultBasis vaultCash upSupply downSupply`;
const TRADE_FIELDS = `id market_id side action size premium price taker txHash block timestamp`;
const POSITION_FIELDS = `id user market_id upBalance downBalance upEscrowed downEscrowed upCost downCost costBasis realizedPnl totalIn totalOut tradeCount market { id asset status outcome lastUpPrice startTime endTime redeemFeeBps }`;
const VAULT_FIELDS = `id navLower navUpper ppsLower supply totalSupply lastNavTimestamp tvlCap performanceFeeBps quotingPaused quotingHalted breakerTrips settledEpochs expiredEpochs totalDeposited totalRedeemed totalPerformanceFees totalFillVolume fillCount apy7d apy30d return7d return30d apySinceInception`;
const NAV_FIELDS = `id navLower navUpper navLowerAfter navUpperAfter ppsLower supply settlement block timestamp`;
const EPOCH_FIELDS = `epochId status navLower navUpper ppsLower sharesMinted sharesBurned assetsPaid depositsAccepted feeAssets depositRequested redeemRequested settledTimestamp`;
const LP_FIELDS = `id user shares escrowedShares costBasis realizedPnl totalDeposited totalWithdrawn`;
const DEPOSIT_FIELDS = `id epochId owner assets status shares refunded`;
const REDEEM_FIELDS = `id epochId owner shares requeued status assets requeuedShares`;
const ORDER_FIELDS = `id taker market_id kind status shares limit execAt filled premium placedTimestamp`;
const DAILY_FIELDS = `day date volume trades feesPerformance feesRedeem depositsAssets redeemedAssets tvlClose ppsClose activeUsers newUsers marketsCreated marketsResolved`;
const PROTOCOL_FIELDS = `totalVolume totalTrades totalFeesPerformance totalFeesRedeem totalMarkets totalMarketsResolved totalUsers totalDeposited totalRedeemed tvl lastUpdatedBlock`;

/**
 * The documented queries (indexer/QUERIES.md mirrors these strings). Enum variables use the Hasura
 * enum scalar names (lower-cased schema enum name: `marketstatus`).
 */
export const INDEXER_QUERIES = {
  status: `query IndexerStatus { _meta { chainId progressBlock sourceBlock bufferBlock eventsProcessed isReady readyAt startBlock endBlock } }`,

  /** App home: markets by status set, soonest end first. */
  marketList: `query MarketList($statuses: [marketstatus!]!, $limit: Int!, $offset: Int!) {
  Market(
    where: { status: { _in: $statuses } }
    order_by: { endTime: asc }
    limit: $limit
    offset: $offset
  ) { ${MARKET_FIELDS} }
}`,

  /** Same, restricted to one asset label (e.g. "BTC"). Hasura rejects `_eq: null`, hence a second document. */
  marketListByAsset: `query MarketListByAsset($statuses: [marketstatus!]!, $asset: String!, $limit: Int!, $offset: Int!) {
  Market(
    where: { status: { _in: $statuses }, asset: { _eq: $asset } }
    order_by: { endTime: asc }
    limit: $limit
    offset: $offset
  ) { ${MARKET_FIELDS} }
}`,

  marketDetail: `query MarketDetail($id: String!, $trades: Int!) {
  Market_by_pk(id: $id) {
    ${MARKET_FIELDS}
    trades(order_by: { block: desc, logIndex: desc }, limit: $trades) { ${TRADE_FIELDS} }
  }
}`,

  recentTrades: `query RecentTrades($limit: Int!) {
  Trade(order_by: { block: desc, logIndex: desc }, limit: $limit) { ${TRADE_FIELDS} }
}`,

  userTrades: `query UserTrades($user: String!, $limit: Int!, $offset: Int!) {
  Trade(where: { taker: { _eq: $user } }, order_by: { block: desc, logIndex: desc }, limit: $limit, offset: $offset) { ${TRADE_FIELDS} }
}`,

  userPositions: `query UserPositions($user: String!) {
  UserPosition(where: { user: { _eq: $user } }, order_by: { lastUpdated: desc }) { ${POSITION_FIELDS} }
}`,

  userOrders: `query UserOrders($user: String!, $limit: Int!) {
  Order(where: { taker: { _eq: $user } }, order_by: { placedTimestamp: desc }, limit: $limit) { ${ORDER_FIELDS} }
}`,

  vaultOverview: `query VaultOverview {
  Vault(limit: 1) { ${VAULT_FIELDS} }
  ProtocolStats_by_pk(id: "global") { ${PROTOCOL_FIELDS} }
  NavSnapshot(order_by: { block: desc }, limit: 1) { ${NAV_FIELDS} }
}`,

  /** Newest first, so a limit never drops the most recent rows; the client reverses to chronological order. */
  navHistory: `query NavHistory($since: Int!, $limit: Int!) {
  NavSnapshot(where: { timestamp: { _gte: $since } }, order_by: { timestamp: desc }, limit: $limit) { ${NAV_FIELDS} }
}`,

  /** Newest first. */
  epochs: `query Epochs($limit: Int!) {
  VaultEpoch(order_by: { epochId: desc }, limit: $limit) { ${EPOCH_FIELDS} }
}`,

  lpOverview: `query LpOverview($user: String!) {
  LPPosition_by_pk(id: $user) { ${LP_FIELDS} }
  DepositRequest(where: { owner: { _eq: $user } }, order_by: { epochId: desc }, limit: 50) { ${DEPOSIT_FIELDS} }
  RedeemRequest(where: { owner: { _eq: $user } }, order_by: { epochId: desc }, limit: 50) { ${REDEEM_FIELDS} }
}`,

  dailyStats: `query DailyStats($days: Int!) {
  DailyStats(order_by: { day: desc }, limit: $days) { ${DAILY_FIELDS} }
}`,

  protocolStats: `query ProtocolStats { ProtocolStats_by_pk(id: "global") { ${PROTOCOL_FIELDS} } }`,
} as const;

// ------------------------------------------------------------------ parsers (exported for tests)

type Raw = Record<string, unknown>;
const s = (v: unknown) => String(v);
const n = (v: unknown) => Number(v);

export function parseMarket(r: Raw): MarketRow {
  return {
    id: s(r.id),
    asset: s(r.asset),
    assetId: s(r.assetId),
    duration: n(r.duration),
    startTime: n(r.startTime),
    endTime: n(r.endTime),
    strike: nBig(r.strike as Num | null),
    endPrice: nBig(r.endPrice as Num | null),
    status: r.status as MarketStatus,
    outcome: (r.outcome ?? null) as Outcome | null,
    upToken: s(r.upToken),
    downToken: s(r.downToken),
    volume: toBig(r.volume as Num),
    tradeCount: n(r.tradeCount),
    lastUpPrice: nNum(r.lastUpPrice as Num | null),
    vaultRegistered: Boolean(r.vaultRegistered),
    vaultBasis: toBig(r.vaultBasis as Num),
    vaultCash: toBig(r.vaultCash as Num),
    upSupply: toBig(r.upSupply as Num),
    downSupply: toBig(r.downSupply as Num),
  };
}

export function parseTrade(r: Raw): TradeRow {
  return {
    id: s(r.id),
    marketId: s(r.market_id),
    side: r.side as Side,
    action: r.action as TradeAction,
    size: toBig(r.size as Num),
    premium: toBig(r.premium as Num),
    price: n(r.price),
    taker: s(r.taker),
    txHash: s(r.txHash),
    block: n(r.block),
    timestamp: n(r.timestamp),
  };
}

export function parsePosition(r: Raw): PositionRow {
  const m = r.market as Raw;
  return {
    id: s(r.id),
    user: s(r.user),
    marketId: s(r.market_id),
    upBalance: toBig(r.upBalance as Num),
    downBalance: toBig(r.downBalance as Num),
    upEscrowed: toBig(r.upEscrowed as Num),
    downEscrowed: toBig(r.downEscrowed as Num),
    upCost: toBig(r.upCost as Num),
    downCost: toBig(r.downCost as Num),
    costBasis: toBig(r.costBasis as Num),
    realizedPnl: toBig(r.realizedPnl as Num),
    totalIn: toBig(r.totalIn as Num),
    totalOut: toBig(r.totalOut as Num),
    tradeCount: n(r.tradeCount),
    market: {
      id: s(m.id),
      asset: s(m.asset),
      status: m.status as MarketStatus,
      outcome: (m.outcome ?? null) as Outcome | null,
      lastUpPrice: nNum(m.lastUpPrice as Num | null),
      startTime: n(m.startTime),
      endTime: n(m.endTime),
      redeemFeeBps: n(m.redeemFeeBps),
    },
  };
}

export function parseVault(r: Raw): VaultRow {
  return {
    id: s(r.id),
    navLower: toBig(r.navLower as Num),
    navUpper: toBig(r.navUpper as Num),
    ppsLower: toBig(r.ppsLower as Num),
    supply: toBig(r.supply as Num),
    totalSupply: toBig(r.totalSupply as Num),
    lastNavTimestamp: n(r.lastNavTimestamp),
    tvlCap: toBig(r.tvlCap as Num),
    performanceFeeBps: n(r.performanceFeeBps),
    quotingPaused: Boolean(r.quotingPaused),
    quotingHalted: Boolean(r.quotingHalted),
    breakerTrips: n(r.breakerTrips),
    settledEpochs: n(r.settledEpochs),
    expiredEpochs: n(r.expiredEpochs),
    totalDeposited: toBig(r.totalDeposited as Num),
    totalRedeemed: toBig(r.totalRedeemed as Num),
    totalPerformanceFees: toBig(r.totalPerformanceFees as Num),
    totalFillVolume: toBig(r.totalFillVolume as Num),
    fillCount: n(r.fillCount),
    apy7d: nNum(r.apy7d as Num | null),
    apy30d: nNum(r.apy30d as Num | null),
    return7d: nNum(r.return7d as Num | null),
    return30d: nNum(r.return30d as Num | null),
    apySinceInception: nNum(r.apySinceInception as Num | null),
  };
}

export function parseNavSnapshot(r: Raw): NavSnapshotRow {
  return {
    id: s(r.id),
    navLower: toBig(r.navLower as Num),
    navUpper: toBig(r.navUpper as Num),
    navLowerAfter: toBig(r.navLowerAfter as Num),
    navUpperAfter: toBig(r.navUpperAfter as Num),
    ppsLower: toBig(r.ppsLower as Num),
    supply: toBig(r.supply as Num),
    settlement: Boolean(r.settlement),
    block: n(r.block),
    timestamp: n(r.timestamp),
  };
}

export function parseEpoch(r: Raw): EpochRow {
  return {
    epochId: n(r.epochId),
    status: (r.status ?? null) as EpochStatus | null,
    navLower: nBig(r.navLower as Num | null),
    navUpper: nBig(r.navUpper as Num | null),
    ppsLower: nBig(r.ppsLower as Num | null),
    sharesMinted: nBig(r.sharesMinted as Num | null),
    sharesBurned: nBig(r.sharesBurned as Num | null),
    assetsPaid: nBig(r.assetsPaid as Num | null),
    depositsAccepted: nBig(r.depositsAccepted as Num | null),
    feeAssets: toBig(r.feeAssets as Num),
    depositRequested: toBig(r.depositRequested as Num),
    redeemRequested: toBig(r.redeemRequested as Num),
    settledTimestamp: nNum(r.settledTimestamp as Num | null),
  };
}

export function parseLp(r: Raw): LpRow {
  return {
    id: s(r.id),
    user: s(r.user),
    shares: toBig(r.shares as Num),
    escrowedShares: toBig(r.escrowedShares as Num),
    costBasis: toBig(r.costBasis as Num),
    realizedPnl: toBig(r.realizedPnl as Num),
    totalDeposited: toBig(r.totalDeposited as Num),
    totalWithdrawn: toBig(r.totalWithdrawn as Num),
  };
}

export function parseDepositRequest(r: Raw): DepositRequestRow {
  return {
    id: s(r.id),
    epochId: n(r.epochId),
    owner: s(r.owner),
    assets: toBig(r.assets as Num),
    status: r.status as RequestStatus,
    shares: nBig(r.shares as Num | null),
    refunded: nBig(r.refunded as Num | null),
  };
}

export function parseRedeemRequest(r: Raw): RedeemRequestRow {
  return {
    id: s(r.id),
    epochId: n(r.epochId),
    owner: s(r.owner),
    shares: toBig(r.shares as Num),
    requeued: Boolean(r.requeued),
    status: r.status as RequestStatus,
    assets: nBig(r.assets as Num | null),
    requeuedShares: nBig(r.requeuedShares as Num | null),
  };
}

export function parseOrder(r: Raw): OrderRow {
  return {
    id: s(r.id),
    taker: s(r.taker),
    marketId: s(r.market_id),
    kind: r.kind as OrderKind,
    status: r.status as OrderStatus,
    shares: toBig(r.shares as Num),
    limit: toBig(r.limit as Num),
    execAt: n(r.execAt),
    filled: nBig(r.filled as Num | null),
    premium: nBig(r.premium as Num | null),
    placedTimestamp: n(r.placedTimestamp),
  };
}

export function parseDaily(r: Raw): DailyStatsRow {
  return {
    day: n(r.day),
    date: s(r.date),
    volume: toBig(r.volume as Num),
    trades: n(r.trades),
    feesPerformance: toBig(r.feesPerformance as Num),
    feesRedeem: toBig(r.feesRedeem as Num),
    depositsAssets: toBig(r.depositsAssets as Num),
    redeemedAssets: toBig(r.redeemedAssets as Num),
    tvlClose: toBig(r.tvlClose as Num),
    ppsClose: nBig(r.ppsClose as Num | null),
    activeUsers: n(r.activeUsers),
    newUsers: n(r.newUsers),
    marketsCreated: n(r.marketsCreated),
    marketsResolved: n(r.marketsResolved),
  };
}

export function parseProtocol(r: Raw): ProtocolStatsRow {
  return {
    totalVolume: toBig(r.totalVolume as Num),
    totalTrades: n(r.totalTrades),
    totalFeesPerformance: toBig(r.totalFeesPerformance as Num),
    totalFeesRedeem: toBig(r.totalFeesRedeem as Num),
    totalMarkets: n(r.totalMarkets),
    totalMarketsResolved: n(r.totalMarketsResolved),
    totalUsers: n(r.totalUsers),
    totalDeposited: toBig(r.totalDeposited as Num),
    totalRedeemed: toBig(r.totalRedeemed as Num),
    tvl: toBig(r.tvl as Num),
    lastUpdatedBlock: n(r.lastUpdatedBlock),
  };
}

// ------------------------------------------------------------------ client

const lc = (a: string) => a.toLowerCase();
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

export interface IndexerClient {
  /** Raw access for queries not covered below. */
  query<T>(query: string, variables?: GqlVariables): Promise<T>;
  /** Per-chain indexing progress (`sourceBlock - progressBlock` is the lag in blocks). */
  status(): Promise<IndexerMeta[]>;
  markets(args?: {
    statuses?: readonly MarketStatus[];
    asset?: string;
    limit?: number;
    offset?: number;
  }): Promise<MarketRow[]>;
  market(id: string, recentTrades?: number): Promise<(MarketRow & { trades: TradeRow[] }) | null>;
  recentTrades(limit?: number): Promise<TradeRow[]>;
  userTrades(user: string, limit?: number, offset?: number): Promise<TradeRow[]>;
  userPositions(user: string): Promise<PositionRow[]>;
  userOrders(user: string, limit?: number): Promise<OrderRow[]>;
  vault(): Promise<{
    vault: VaultRow | null;
    protocol: ProtocolStatsRow | null;
    latestSnapshot: NavSnapshotRow | null;
  }>;
  navHistory(sinceTimestamp: number, limit?: number): Promise<NavSnapshotRow[]>;
  epochs(limit?: number): Promise<EpochRow[]>;
  lp(user: string): Promise<{
    position: LpRow | null;
    deposits: DepositRequestRow[];
    redemptions: RedeemRequestRow[];
  }>;
  dailyStats(days?: number): Promise<DailyStatsRow[]>;
  protocolStats(): Promise<ProtocolStatsRow | null>;
}

export const ALL_MARKET_STATUSES: readonly MarketStatus[] = [
  "CREATED",
  "OPEN",
  "RESOLVED_UP",
  "RESOLVED_DOWN",
  "INVALID",
];

export function createIndexerClient(o: IndexerClientOptions): IndexerClient {
  const q = <T>(query: string, variables?: GqlVariables) => indexerQuery<T>(o, query, variables);
  return {
    query: q,
    async status() {
      const d = await q<{ _meta: IndexerMeta[] }>(INDEXER_QUERIES.status);
      return d._meta;
    },
    async markets(a = {}) {
      const base = {
        statuses: a.statuses ?? ["CREATED", "OPEN"],
        limit: a.limit ?? 50,
        offset: a.offset ?? 0,
      };
      const d = a.asset
        ? await q<{ Market: Raw[] }>(INDEXER_QUERIES.marketListByAsset, { ...base, asset: a.asset })
        : await q<{ Market: Raw[] }>(INDEXER_QUERIES.marketList, base);
      return d.Market.map(parseMarket);
    },
    async market(id, recent = 50) {
      const d = await q<{ Market_by_pk: (Raw & { trades?: Raw[] }) | null }>(
        INDEXER_QUERIES.marketDetail,
        {
          id: lc(id),
          trades: recent,
        },
      );
      const m = d.Market_by_pk;
      return m ? { ...parseMarket(m), trades: rows(m.trades).map(parseTrade) } : null;
    },
    async recentTrades(limit = 50) {
      const d = await q<{ Trade: Raw[] }>(INDEXER_QUERIES.recentTrades, { limit });
      return d.Trade.map(parseTrade);
    },
    async userTrades(user, limit = 50, offset = 0) {
      const d = await q<{ Trade: Raw[] }>(INDEXER_QUERIES.userTrades, {
        user: lc(user),
        limit,
        offset,
      });
      return d.Trade.map(parseTrade);
    },
    async userPositions(user) {
      const d = await q<{ UserPosition: Raw[] }>(INDEXER_QUERIES.userPositions, { user: lc(user) });
      return d.UserPosition.map(parsePosition);
    },
    async userOrders(user, limit = 50) {
      const d = await q<{ Order: Raw[] }>(INDEXER_QUERIES.userOrders, { user: lc(user), limit });
      return d.Order.map(parseOrder);
    },
    async vault() {
      const d = await q<{ Vault: Raw[]; ProtocolStats_by_pk: Raw | null; NavSnapshot: Raw[] }>(
        INDEXER_QUERIES.vaultOverview,
      );
      const v = d.Vault[0];
      const snap = d.NavSnapshot[0];
      return {
        vault: v ? parseVault(v) : null,
        protocol: d.ProtocolStats_by_pk ? parseProtocol(d.ProtocolStats_by_pk) : null,
        latestSnapshot: snap ? parseNavSnapshot(snap) : null,
      };
    },
    async navHistory(since, limit = 1000) {
      const d = await q<{ NavSnapshot: Raw[] }>(INDEXER_QUERIES.navHistory, { since, limit });
      return d.NavSnapshot.map(parseNavSnapshot).reverse();
    },
    async epochs(limit = 20) {
      const d = await q<{ VaultEpoch: Raw[] }>(INDEXER_QUERIES.epochs, { limit });
      return d.VaultEpoch.map(parseEpoch);
    },
    async lp(user) {
      const d = await q<{
        LPPosition_by_pk: Raw | null;
        DepositRequest: Raw[];
        RedeemRequest: Raw[];
      }>(INDEXER_QUERIES.lpOverview, { user: lc(user) });
      return {
        position: d.LPPosition_by_pk ? parseLp(d.LPPosition_by_pk) : null,
        deposits: d.DepositRequest.map(parseDepositRequest),
        redemptions: d.RedeemRequest.map(parseRedeemRequest),
      };
    },
    async dailyStats(days = 30) {
      const d = await q<{ DailyStats: Raw[] }>(INDEXER_QUERIES.dailyStats, { days });
      return d.DailyStats.map(parseDaily);
    },
    async protocolStats() {
      const d = await q<{ ProtocolStats_by_pk: Raw | null }>(INDEXER_QUERIES.protocolStats);
      return d.ProtocolStats_by_pk ? parseProtocol(d.ProtocolStats_by_pk) : null;
    },
  };
}
