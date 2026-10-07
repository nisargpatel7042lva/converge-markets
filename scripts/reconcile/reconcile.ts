/**
 * Indexer reconciliation: sample N random entities (markets, positions, trades, NAV snapshots, LP
 * positions, vault epochs, venue orders, the vault singleton) from the indexer and compare each
 * with direct chain reads (contract views, or the event log itself for trades and NAV snapshots).
 *
 * Consistency: every entity is fetched together with `_meta.progressBlock` in ONE GraphQL request and
 * the chain is read AT that block, so a live indexer can be reconciled while it advances. A mismatch
 * is re-fetched up to 3 times (the indexer may have moved between the two reads); a persistent
 * mismatch is a failure.
 *
 * Usage: tsx reconcile.ts --indexer <graphql url> --rpc <rpc url> --addresses <deployments json|local addresses json>
 *          [--n 200] [--seed 1] [--concurrency 8] [--rps 10] [--label local|testnet]
 *          [--aggregates] [--log-chunk 10000] [--allow-small] [--block latest]
 *          [--headers name=value,...] [--api-key KEY] [--out docs/evidence/phase-6]
 * Exit code 0 only if every sampled entity matches and at least N entities were sampled.
 * On the shared public Monad RPC use --rps 10 (budget 15 rps) and a small --concurrency.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { indexerQuery, navPerformance } from "@converge/sdk";
import { ROOT } from "./lib/chain";
import {
  allocate,
  Limiter,
  loadAddresses,
  opt,
  parseArgs,
  parseHeaders,
  rng,
  sample,
  sleep,
} from "./lib/common";

const args = parseArgs(process.argv.slice(2));
const indexerUrl = opt(args, "indexer", "INDEXER_URL", "http://localhost:8080/v1/graphql")!;
const rpcUrl = opt(args, "rpc", "RPC_URL", "http://127.0.0.1:8611")!;
const addrPath = opt(args, "addresses", "ADDRESSES")!;
const label = opt(args, "label", "LABEL", "local")!;
const N = Number(opt(args, "n", "N", "200"));
const seed = Number(opt(args, "seed", "SEED", "1"));
const concurrency = Number(opt(args, "concurrency", "CONCURRENCY", "8"));
const rps = Number(opt(args, "rps", "RPS", "Infinity"));
const latest = opt(args, "block", "BLOCK") === "latest";
const aggregates = args.has("aggregates");
const allowSmall = args.has("allow-small");
let logChunk = BigInt(opt(args, "log-chunk", "LOG_CHUNK", "10000")!);
// Hosted Hasura may cap the rows of a query: page small and cross-check against the aggregate count.
const pageSize = Number(opt(args, "page", "PAGE", "1000"));
// Per-market volume / trade count against the Fill logs (several log queries per sampled market).
const deep = !args.has("no-deep");
const outDir = resolve(opt(args, "out", "OUT_DIR", resolve(ROOT, "docs/evidence/phase-6"))!);
if (!addrPath) throw new Error("--addresses <file> is required");

const A = loadAddresses(resolve(addrPath));
const vault = A.vault.toLowerCase() as Address;
const venue = A.venue.toLowerCase() as Address;
const gql = {
  url: indexerUrl,
  headers: parseHeaders(opt(args, "headers", "INDEXER_HEADERS")),
  apiKey: opt(args, "api-key", "INDEXER_API_KEY"),
  timeoutMs: 30_000,
};
const pub: PublicClient = createPublicClient({
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 4 }),
});
const limiter = new Limiter(concurrency, rps);

// ---- ABIs (views only; verified against contracts/src in make check-6 by the parity tests)
const marketAbi = parseAbi([
  "function state() view returns (uint8)",
  "function strike() view returns (int256)",
  "function endPrice() view returns (int256)",
  "function startTime() view returns (uint64)",
  "function endTime() view returns (uint64)",
  "function up() view returns (address)",
  "function down() view returns (address)",
  "function redeemFeeBps() view returns (uint16)",
  "function assetId() view returns (bytes32)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function tvlCap() view returns (uint256)",
  "function performanceFeeBps() view returns (uint16)",
  "function quotingPaused() view returns (bool)",
  "function keeperHalt() view returns (bool)",
  "function keeper() view returns (address)",
  "function venue() view returns (address)",
  "function isRegistered(address) view returns (bool)",
  "function positionOf(address) view returns (int256 basis, int256 cash)",
  "function quoteNavLower() view returns (uint256)",
  "function lastNavUpper() view returns (uint256)",
  "function pricePerShareLower() view returns (uint256)",
  "function epochs(uint256) view returns (uint128 depositAssets, uint128 redeemShares, bool settled, bool depositRejected, uint128 sharesMinted, uint128 redeemFilled, uint128 redeemAssetsPaid)",
]);
const venueAbi = parseAbi([
  "function orders(uint256) view returns (address taker, uint8 kind, uint8 status, uint64 execAt, address market, uint128 shares, uint128 limit, uint128 escrow, uint128 reward)",
]);
const fillEvent = parseAbiItem(
  "event Fill(address indexed market, bool upToken, bool vaultSells, uint256 units, uint256 premium, address indexed taker, int256 basis, int256 cash)",
);
const orderExecutedEvent = parseAbiItem(
  "event OrderExecuted(uint256 indexed id, address indexed executor, uint256 filled, uint256 premium, uint256 reportPrice, uint32 reportValidFrom, uint32 reportObservations)",
);
const navEvent = parseAbiItem(
  "event NavSnapshot(uint256 navLower, uint256 navUpper, uint256 ppsLower, uint256 supply, bool settlement)",
);
const createdEvent = parseAbiItem(
  "event MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, (address factory, bytes32 assetId, address resolver, address collateral, address up, address down, uint64 startTime, uint64 endTime, uint16 redeemFeeBps) params)",
);

// ---- types
interface Check {
  field: string;
  indexer: string;
  chain: string;
}
interface Result {
  kind: string;
  id: string;
  block: number | "latest";
  checks: Check[];
  ok: boolean;
  attempts: number;
}
const S = (v: unknown) => (v === null || v === undefined ? "null" : String(v).toLowerCase());
const eq = (field: string, indexerV: unknown, chainV: unknown): Check => ({
  field,
  indexer: S(indexerV),
  chain: S(chainV),
});
const STATUS = ["CREATED", "OPEN", "RESOLVED_UP", "RESOLVED_DOWN", "INVALID"] as const;
const KINDS = ["BUY_UP", "SELL_UP", "BUY_DOWN", "SELL_DOWN"] as const;

type Raw = Record<string, unknown>;
const bn = (b: number | "latest") => (b === "latest" ? undefined : BigInt(b));

/** Fetches one entity together with the progress block, in one request. */
async function fetchOne(
  entity: string,
  fields: string,
  id: string,
  idType = "String!",
): Promise<{ row: Raw | null; block: number }> {
  const d = await indexerQuery<{ _meta: { progressBlock: number }[] } & Record<string, Raw | null>>(
    gql,
    `query($id: ${idType}) { _meta { progressBlock } ${entity}_by_pk(id: $id) { ${fields} } }`,
    { id },
  );
  return { row: d[`${entity}_by_pk`] ?? null, block: d._meta[0]?.progressBlock ?? 0 };
}

const rd = <T>(
  address: Address,
  abi: unknown,
  functionName: string,
  args: unknown[],
  block: number | "latest",
) =>
  limiter.run(
    () =>
      pub.readContract({
        address,
        abi,
        functionName,
        args,
        blockNumber: bn(block),
      } as never) as Promise<T>,
  );

type LogRow = { logIndex: number; blockNumber: bigint; args: Record<string, unknown> };

/** getLogs over [from, to] in chunks; a provider range error halves the chunk (down to 100 blocks). */
async function logsRange(
  address: Address,
  event: unknown,
  from: bigint,
  to: bigint,
  args?: Record<string, unknown>,
): Promise<LogRow[]> {
  const out: LogRow[] = [];
  let step = logChunk;
  for (let s0 = from; s0 <= to;) {
    const e = s0 + step - 1n > to ? to : s0 + step - 1n;
    try {
      const part = (await limiter.run(() =>
        pub.getLogs({ address, event, args, fromBlock: s0, toBlock: e } as never),
      )) as unknown as LogRow[];
      out.push(...part);
      s0 = e + 1n;
    } catch (err) {
      if (step <= 100n) throw err;
      step = step / 2n;
      logChunk = step; // remember: the provider's limit is below the configured chunk
    }
  }
  return out;
}

async function logsAt(event: typeof fillEvent | typeof navEvent, from: bigint, to: bigint) {
  return limiter.run(() =>
    pub.getLogs({ address: vault, event, fromBlock: from, toBlock: to } as never),
  ) as unknown as Promise<
    { logIndex: number; blockNumber: bigint; args: Record<string, unknown> }[]
  >;
}

// ---- checkers: each returns the field comparisons for one entity at one block
type Checker = (id: string) => Promise<{ checks: Check[]; block: number | "latest" }>;

const checkers: Record<string, Checker> = {
  async Market(id) {
    const { row: m, block } = await fetchOne(
      "Market",
      "status strike endPrice startTime endTime upToken downToken redeemFeeBps assetId upSupply downSupply vaultRegistered vaultBasis vaultCash volume tradeCount createdBlock",
      id,
    );
    if (!m) return { checks: [eq("exists", "no", "yes")], block };
    const b = latest ? "latest" : block;
    const a = id as Address;
    const [state, strike, endPrice, start, end, up, down, fee, asset, reg, pos] = await Promise.all(
      [
        rd<number>(a, marketAbi, "state", [], b),
        rd<bigint>(a, marketAbi, "strike", [], b),
        rd<bigint>(a, marketAbi, "endPrice", [], b),
        rd<bigint>(a, marketAbi, "startTime", [], b),
        rd<bigint>(a, marketAbi, "endTime", [], b),
        rd<Address>(a, marketAbi, "up", [], b),
        rd<Address>(a, marketAbi, "down", [], b),
        rd<number>(a, marketAbi, "redeemFeeBps", [], b),
        rd<string>(a, marketAbi, "assetId", [], b),
        rd<boolean>(vault, vaultAbi, "isRegistered", [a], b),
        rd<readonly [bigint, bigint]>(vault, vaultAbi, "positionOf", [a], b),
      ],
    );
    const [upSup, downSup] = await Promise.all([
      rd<bigint>(up, tokenAbi, "totalSupply", [], b),
      rd<bigint>(down, tokenAbi, "totalSupply", [], b),
    ]);
    // volume and trade count from the vault's Fill logs for this market (events, not views)
    let fillChecks: Check[] = [];
    if (deep) {
      const fills = await logsRange(
        vault,
        fillEvent,
        BigInt(Number(m.createdBlock)),
        BigInt(block),
        {
          market: a,
        },
      );
      fillChecks = [
        eq("tradeCount (Fill logs)", m.tradeCount, fills.length),
        eq(
          "volume (sum of Fill premium)",
          m.volume,
          fills.reduce((x, l) => x + BigInt(String(l.args.premium)), 0n),
        ),
      ];
    }
    return {
      block: b,
      checks: [
        ...fillChecks,
        eq("status", m.status, STATUS[Number(state)]),
        eq("strike", m.strike ?? 0, strike),
        eq("endPrice", m.endPrice ?? 0, endPrice),
        eq("startTime", m.startTime, start),
        eq("endTime", m.endTime, end),
        eq("upToken", m.upToken, up),
        eq("downToken", m.downToken, down),
        eq("redeemFeeBps", m.redeemFeeBps, fee),
        eq("assetId", m.assetId, asset),
        eq("upSupply", m.upSupply, upSup),
        eq("downSupply", m.downSupply, downSup),
        eq("vaultRegistered", m.vaultRegistered, reg),
        eq("vaultBasis", m.vaultBasis, pos[0]),
        eq("vaultCash", m.vaultCash, pos[1]),
      ],
    };
  },

  async UserPosition(id) {
    const { row: p, block } = await fetchOne(
      "UserPosition",
      "user upBalance downBalance market { upToken downToken }",
      id,
    );
    if (!p) return { checks: [eq("exists", "no", "yes")], block };
    const b = latest ? "latest" : block;
    const m = p.market as { upToken: Address; downToken: Address };
    const user = p.user as Address;
    const [up, down] = await Promise.all([
      rd<bigint>(m.upToken, tokenAbi, "balanceOf", [user], b),
      rd<bigint>(m.downToken, tokenAbi, "balanceOf", [user], b),
    ]);
    return {
      block: b,
      checks: [eq("upBalance", p.upBalance, up), eq("downBalance", p.downBalance, down)],
    };
  },

  async Trade(id) {
    const { row: t, block } = await fetchOne(
      "Trade",
      "market_id side action size premium taker block logIndex vaultBasis vaultCash txHash",
      id,
    );
    if (!t) return { checks: [eq("exists", "no", "yes")], block };
    const blk = BigInt(Number(t.block));
    const logs = await logsAt(fillEvent, blk, blk);
    const l = logs.find((x) => x.logIndex === Number(t.logIndex));
    if (!l) return { checks: [eq("log exists", "yes", "no")], block };
    const a = l.args as {
      market: string;
      upToken: boolean;
      vaultSells: boolean;
      units: bigint;
      premium: bigint;
      taker: string;
      basis: bigint;
      cash: bigint;
    };
    return {
      block,
      checks: [
        eq("market", t.market_id, a.market),
        eq("side", t.side, a.upToken ? "UP" : "DOWN"),
        eq("action", t.action, a.vaultSells ? "BUY" : "SELL"),
        eq("size", t.size, a.units),
        eq("premium", t.premium, a.premium),
        eq("taker", t.taker, a.taker),
        eq("vaultBasis", t.vaultBasis, a.basis),
        eq("vaultCash", t.vaultCash, a.cash),
      ],
    };
  },

  async NavSnapshot(id) {
    const { row: n, block } = await fetchOne(
      "NavSnapshot",
      "navLower navUpper navLowerAfter navUpperAfter ppsLower supply settlement block",
      id,
    );
    if (!n) return { checks: [eq("exists", "no", "yes")], block };
    const blk = BigInt(Number(n.block));
    const logs = await logsAt(navEvent, blk, blk);
    const logIndex = Number(id.split("_")[1]);
    const l = logs.find((x) => x.logIndex === logIndex);
    if (!l) return { checks: [eq("log exists", "yes", "no")], block };
    const a = l.args as {
      navLower: bigint;
      navUpper: bigint;
      ppsLower: bigint;
      supply: bigint;
      settlement: boolean;
    };
    // For a settlement the vault stores navLower + accepted - paid (quoteNavLower) and
    // navUpper + accepted - paid (lastNavUpper): the stored "after" values must equal the contract
    // state at that block (this is what the TVL shown to users comes from).
    const stateChecks: Check[] = [];
    if (a.settlement) {
      const nb = Number(n.block);
      const [qLo, qHi] = await Promise.all([
        rd<bigint>(vault, vaultAbi, "quoteNavLower", [], nb),
        rd<bigint>(vault, vaultAbi, "lastNavUpper", [], nb),
      ]);
      stateChecks.push(
        eq("navLowerAfter == quoteNavLower() at the block", n.navLowerAfter, qLo),
        eq("navUpperAfter == lastNavUpper() at the block", n.navUpperAfter, qHi),
      );
    }
    return {
      block,
      checks: [
        eq("navLower", n.navLower, a.navLower),
        eq("navUpper", n.navUpper, a.navUpper),
        eq("ppsLower", n.ppsLower, a.ppsLower),
        eq("supply", n.supply, a.supply),
        eq("settlement", n.settlement, a.settlement),
        ...stateChecks,
      ],
    };
  },

  async LPPosition(id) {
    const { row: p, block } = await fetchOne("LPPosition", "user shares", id);
    if (!p) return { checks: [eq("exists", "no", "yes")], block };
    const b = latest ? "latest" : block;
    const bal = await rd<bigint>(vault, vaultAbi, "balanceOf", [p.user as Address], b);
    return { block: b, checks: [eq("shares", p.shares, bal)] };
  },

  async VaultEpoch(id) {
    const { row: e, block } = await fetchOne(
      "VaultEpoch",
      "status depositRequested redeemRequested sharesMinted sharesBurned assetsPaid depositRejected",
      id,
    );
    if (!e) return { checks: [eq("exists", "no", "yes")], block };
    const b = latest ? "latest" : block;
    const c = await rd<readonly [bigint, bigint, boolean, boolean, bigint, bigint, bigint]>(
      vault,
      vaultAbi,
      "epochs",
      [BigInt(id)],
      b,
    );
    const settled = e.status !== null;
    return {
      block: b,
      checks: [
        eq("depositRequested", e.depositRequested, c[0]),
        eq("redeemRequested", e.redeemRequested, c[1]),
        eq("settled", settled, c[2]),
        ...(settled && e.status === "SETTLED"
          ? [
              eq("sharesMinted", e.sharesMinted, c[4]),
              eq("sharesBurned", e.sharesBurned, c[5]),
              eq("assetsPaid", e.assetsPaid, c[6]),
              eq("depositRejected", e.depositRejected, c[3]),
            ]
          : []),
        ...(e.status === "EXPIRED" ? [eq("depositRejected", e.depositRejected, c[3])] : []),
      ],
    };
  },

  async Order(id) {
    const { row: o, block } = await fetchOne(
      "Order",
      "venue orderId taker market_id kind status shares limit execAt filled premium settledBlock",
      id,
    );
    if (!o) return { checks: [eq("exists", "no", "yes")], block };
    const b = latest ? "latest" : block;
    const ven = String(o.venue) as Address;
    const c = await rd<
      readonly [Address, number, number, bigint, Address, bigint, bigint, bigint, bigint]
    >(ven, venueAbi, "orders", [BigInt(String(o.orderId))], b);
    const execChecks: Check[] = [];
    if (o.status === "EXECUTED" && o.settledBlock !== null) {
      const sb = BigInt(Number(o.settledBlock));
      const ex = (await logsRange(ven, orderExecutedEvent, sb, sb)).find(
        (l) => String(l.args.id) === String(o.orderId),
      );
      execChecks.push(
        eq("filled (OrderExecuted log)", o.filled, ex?.args.filled),
        eq("premium (OrderExecuted log)", o.premium, ex?.args.premium),
      );
    }
    return {
      block: b,
      checks: [
        ...execChecks,
        eq("taker", o.taker, c[0]),
        eq("kind", o.kind, KINDS[Number(c[1])]),
        eq(
          "status(open/done)",
          o.status === "OPEN" ? "OPEN" : "DONE",
          Number(c[2]) === 1 ? "OPEN" : "DONE",
        ),
        eq("execAt", o.execAt, c[3]),
        eq("market", o.market_id, c[4]),
        eq("shares", o.shares, c[5]),
        eq("limit", o.limit, c[6]),
      ],
    };
  },

  async Vault(id) {
    const { row: v, block } = await fetchOne(
      "Vault",
      "totalSupply tvlCap performanceFeeBps quotingPaused quotingHalted keeper venue ppsLower",
      id,
    );
    if (!v) return { checks: [eq("exists", "no", "yes")], block };
    const b = latest ? "latest" : block;
    const [ts, cap, fee, paused, keeper, ven, pps] = await Promise.all([
      rd<bigint>(vault, vaultAbi, "totalSupply", [], b),
      rd<bigint>(vault, vaultAbi, "tvlCap", [], b),
      rd<number>(vault, vaultAbi, "performanceFeeBps", [], b),
      rd<boolean>(vault, vaultAbi, "quotingPaused", [], b),
      rd<Address>(vault, vaultAbi, "keeper", [], b),
      rd<Address>(vault, vaultAbi, "venue", [], b),
      rd<bigint>(vault, vaultAbi, "pricePerShareLower", [], b),
    ]);
    // keeperHalt() exists only in vault builds with the halt flag; absent on older deployments.
    let halted: boolean | undefined;
    try {
      halted = await rd<boolean>(vault, vaultAbi, "keeperHalt", [], b);
    } catch {
      halted = undefined;
    }
    return {
      block: b,
      checks: [
        eq("totalSupply", v.totalSupply, ts),
        eq("tvlCap", v.tvlCap, cap),
        eq("performanceFeeBps", v.performanceFeeBps, fee),
        eq("quotingPaused", v.quotingPaused, paused),
        eq("keeper", v.keeper, keeper),
        eq("venue", v.venue, ven),
        eq("ppsLower == pricePerShareLower()", v.ppsLower, pps),
        ...(halted === undefined ? [] : [eq("quotingHalted", v.quotingHalted, halted)]),
      ],
    };
  },
};

// ---- main
async function pagedRows<T>(entity: string, fields: string, order = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const d = await indexerQuery<Record<string, T[]>>(
      gql,
      `{ ${entity}(order_by: {${order}: asc}, limit: ${pageSize}, offset: ${offset}) { ${fields} } }`,
    );
    out.push(...d[entity]!);
    if (d[entity]!.length < pageSize) break;
  }
  // a row cap on the endpoint (or a concurrent write) must not silently shrink the population
  const c = await indexerQuery<Record<string, { aggregate: { count: number } }>>(
    gql,
    `{ ${entity}_aggregate { aggregate { count } } }`,
  );
  const total = c[`${entity}_aggregate`]!.aggregate.count;
  if (Math.abs(total - out.length) > Math.max(5, total * 0.01)) {
    throw new Error(`${entity}: paged ${out.length} rows but the aggregate count is ${total}`);
  }
  return out;
}

async function listIds(entity: string, orderField = "id"): Promise<string[]> {
  return (await pagedRows<Raw>(entity, "id", orderField)).map((r) => String(r.id));
}

async function runOne(kind: string, id: string): Promise<Result> {
  let last: Result | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { checks, block } = await checkers[kind]!(id);
    last = {
      kind,
      id,
      block,
      checks,
      ok: checks.every((c) => c.indexer === c.chain),
      attempts: attempt,
    };
    if (last.ok) return last;
    await sleep(1000); // the live indexer may have advanced between the two reads: look again
  }
  return last!;
}

async function aggregatesCheck(): Promise<Result[]> {
  const meta = await indexerQuery<{
    _meta: { progressBlock: number; startBlock: number }[];
    ProtocolStats_by_pk: Raw | null;
  }>(
    gql,
    `{ _meta { progressBlock startBlock } ProtocolStats_by_pk(id: "global") { totalTrades totalVolume totalMarkets } }`,
  );
  const P = BigInt(meta._meta[0]!.progressBlock);
  const from = BigInt(meta._meta[0]!.startBlock);
  let trades = 0;
  let volume = 0n;
  let markets = 0;
  for (let s = from; s <= P; s += logChunk) {
    const e = s + logChunk - 1n > P ? P : s + logChunk - 1n;
    const fl = (await limiter.run(() =>
      pub.getLogs({ address: vault, event: fillEvent, fromBlock: s, toBlock: e } as never),
    )) as unknown as { args: { premium: bigint } }[];
    trades += fl.length;
    for (const l of fl) volume += l.args.premium;
    const cl = await limiter.run(() =>
      pub.getLogs({
        address: A.factory as Address,
        event: createdEvent,
        fromBlock: s,
        toBlock: e,
      } as never),
    );
    markets += cl.length;
  }
  const s = meta.ProtocolStats_by_pk;
  const checks = [
    eq("totalTrades (count of Fill logs)", s?.totalTrades, trades),
    eq("totalVolume (sum of Fill premium)", s?.totalVolume, volume),
    eq("totalMarkets (count of MarketCreated logs)", s?.totalMarkets, markets),
  ];
  return [
    {
      kind: "ProtocolStats",
      id: "global",
      block: Number(P),
      checks,
      ok: checks.every((c) => c.indexer === c.chain),
      attempts: 1,
    },
  ];
}

/**
 * Indexer-internal conservation checks (GraphQL only, no RPC): they catch a missed Transfer or a
 * double-counted fill even for fields no contract view exposes (cost basis, volumes). Reported
 * separately from the sampled entities; every one must hold.
 */
async function invariantChecks(): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const page = async <T>(entity: string, fields: string, order = "id"): Promise<T[]> => {
    const out: T[] = [];
    for (let offset = 0; ; offset += 5000) {
      const d = await indexerQuery<Record<string, T[]>>(
        gql,
        `{ ${entity}(order_by: {${order}: asc}, limit: 5000, offset: ${offset}) { ${fields} } }`,
      );
      out.push(...d[entity]!);
      if (d[entity]!.length < 5000) break;
    }
    return out;
  };
  const markets = await page<Raw>("Market", "id upSupply downSupply volume tradeCount");
  const positions = await page<Raw>(
    "UserPosition",
    "id market_id upBalance downBalance upEscrowed downEscrowed upCost downCost costBasis",
  );
  const lps = await page<Raw>("LPPosition", "shares escrowedShares costBasis");
  const vaults = await page<Raw>(
    "Vault",
    "totalSupply totalFillVolume fillCount apy7d apy30d return7d return30d apySinceInception",
  );
  const snaps = await page<Raw>("NavSnapshot", "ppsLower timestamp block", "block");
  const protocol = (
    await indexerQuery<{ ProtocolStats_by_pk: Raw | null }>(
      gql,
      `{ ProtocolStats_by_pk(id: "global") { totalVolume totalTrades } }`,
    )
  ).ProtocolStats_by_pk;

  const out: { name: string; ok: boolean; detail: string }[] = [];
  const sums = new Map<string, { up: bigint; down: bigint }>();
  let negative = 0;
  let costMismatch = 0;
  for (const p of positions) {
    const k = String(p.market_id);
    const s = sums.get(k) ?? { up: 0n, down: 0n };
    s.up += BigInt(p.upBalance as string);
    s.down += BigInt(p.downBalance as string);
    sums.set(k, s);
    for (const f of [
      "upBalance",
      "downBalance",
      "upEscrowed",
      "downEscrowed",
      "upCost",
      "downCost",
    ]) {
      if (BigInt(p[f] as string) < 0n) negative++;
    }
    if (BigInt(p.costBasis as string) !== BigInt(p.upCost as string) + BigInt(p.downCost as string))
      costMismatch++;
  }
  let bad = 0;
  for (const m of markets) {
    const s = sums.get(String(m.id)) ?? { up: 0n, down: 0n };
    if (s.up !== BigInt(m.upSupply as string) || s.down !== BigInt(m.downSupply as string)) bad++;
  }
  out.push({
    name: "per market: sum of holder balances (incl. vault and venue) == token total supply",
    ok: bad === 0,
    detail: `${markets.length} markets, ${bad} violations`,
  });
  out.push({
    name: "no negative balance, escrow or cost",
    ok: negative === 0,
    detail: `${positions.length} positions, ${negative} violations`,
  });
  out.push({
    name: "costBasis == upCost + downCost",
    ok: costMismatch === 0,
    detail: `${costMismatch} violations`,
  });
  const lpShares = lps.reduce((a, l) => a + BigInt(l.shares as string), 0n);
  const supply = BigInt((vaults[0]?.totalSupply as string) ?? "0");
  out.push({
    name: "sum of LP wallet shares <= vault share supply",
    ok: lpShares <= supply,
    detail: `${lpShares} <= ${supply}`,
  });
  const mTrades = markets.reduce((a, m) => a + Number(m.tradeCount), 0);
  const mVolume = markets.reduce((a, m) => a + BigInt(m.volume as string), 0n);
  out.push({
    name: "protocol totals == sum over markets == vault fill totals",
    ok:
      Number(protocol?.totalTrades) === mTrades &&
      BigInt((protocol?.totalVolume as string) ?? "0") === mVolume &&
      BigInt((vaults[0]?.totalFillVolume as string) ?? "0") === mVolume &&
      Number(vaults[0]?.fillCount) === mTrades,
    detail: `trades ${protocol?.totalTrades}/${mTrades}, volume ${protocol?.totalVolume}/${mVolume}`,
  });

  // Derived metrics: recompute the vault's APY fields from the NavSnapshot rows with the documented
  // day-bucket baseline (the last snapshot of the last day that ends before now - window).
  if (snaps.length > 0 && vaults[0]) {
    const obs = snaps.map((x) => ({
      ppsWad: BigInt(x.ppsLower as string),
      timestamp: Number(x.timestamp),
    }));
    const lastObs = obs[obs.length - 1]!;
    const dayOf = (t: number) => Math.floor(t / 86_400);
    const lastOfDay = new Map<number, { ppsWad: bigint; timestamp: number }>();
    for (const o of obs) lastOfDay.set(dayOf(o.timestamp), o);
    const recompute = (days: number) => {
      const target = dayOf(lastObs.timestamp - days * 86_400) - 1;
      for (let d = target; d >= target - 21; d--) {
        const b = lastOfDay.get(d);
        if (b) return navPerformance(lastObs, b);
      }
      return undefined;
    };
    const v = vaults[0];
    const close = (a: unknown, b: number | undefined) =>
      a === null || a === undefined
        ? b === undefined
        : b !== undefined && Math.abs(Number(a) - b) <= 1e-9 * Math.max(1, Math.abs(b));
    const e7 = recompute(7);
    const e30 = recompute(30);
    const eInc = navPerformance(lastObs, obs[0]!);
    const ok =
      close(v.apy7d, e7?.apy) &&
      close(v.return7d, e7?.periodReturn) &&
      close(v.apy30d, e30?.apy) &&
      close(v.return30d, e30?.periodReturn) &&
      close(v.apySinceInception, eInc?.apy);
    out.push({
      name: "Vault apy7d / apy30d / apySinceInception == recomputed from the NavSnapshot rows",
      ok,
      detail: `${obs.length} snapshots; indexer apy7d ${v.apy7d}, apy30d ${v.apy30d}; recomputed ${e7?.apy}, ${e30?.apy}`,
    });
  }
  return out;
}

async function main() {
  const chainId = await pub.getChainId();
  if (A.chainId && chainId !== A.chainId)
    throw new Error(`rpc chain ${chainId} != addresses chain ${A.chainId}`);
  console.log(
    `reconcile (${label}): indexer ${indexerUrl}, rpc ${rpcUrl.replace(/\/\/[^/@]*@/, "//")}, target N=${N}`,
  );
  const rand = rng(seed);

  const pools = {
    Market: await listIds("Market"),
    UserPosition: await listIds("UserPosition"),
    Trade: await listIds("Trade"),
    NavSnapshot: await listIds("NavSnapshot"),
    LPPosition: await listIds("LPPosition"),
    VaultEpoch: await listIds("VaultEpoch", "epochId"),
    Order: await listIds("Order", "placedBlock"),
    Vault: await listIds("Vault"),
  };
  const weights: Record<string, number> = {
    Market: 18,
    UserPosition: 30,
    Trade: 16,
    NavSnapshot: 8,
    LPPosition: 4,
    VaultEpoch: 6,
    Order: 16,
    Vault: 1,
  };
  const plan = allocate(
    N,
    Object.entries(pools).map(([name, ids]) => ({
      name,
      size: ids.length,
      weight: weights[name]!,
    })),
  );
  const population = Object.values(pools).reduce((s, p) => s + p.length, 0);
  const jobs: { kind: string; id: string }[] = [];
  for (const [kind, ids] of Object.entries(pools)) {
    for (const id of sample(ids, plan.get(kind)!, rand)) jobs.push({ kind, id });
  }
  console.log(
    `population ${population}; sampling ${jobs.length}: ${[...plan].map(([k, v]) => `${k} ${v}/${pools[k as keyof typeof pools].length}`).join(", ")}`,
  );

  const results = await Promise.all(jobs.map((j) => runOne(j.kind, j.id)));
  if (aggregates) results.push(...(await aggregatesCheck()));
  const invariants = args.has("no-invariants") ? [] : await invariantChecks();

  const byKind = new Map<string, { n: number; ok: number }>();
  for (const r of results) {
    const k = byKind.get(r.kind) ?? { n: 0, ok: 0 };
    k.n++;
    if (r.ok) k.ok++;
    byKind.set(r.kind, k);
  }
  const total = results.length;
  const matched = results.filter((r) => r.ok).length;
  const fieldChecks = results.reduce((s, r) => s + r.checks.length, 0);
  const bad = results.filter((r) => !r.ok);
  const enough = total >= N || allowSmall;
  const invariantsOk = invariants.every((i) => i.ok);
  const pass = bad.length === 0 && enough && total > 0 && invariantsOk;

  mkdirSync(outDir, { recursive: true });
  const meta = {
    label,
    when: new Date().toISOString(),
    indexer: indexerUrl,
    rpc: rpcUrl.replace(/\/\/[^/@]*@/, "//"),
    chainId,
    pinnedToIndexerBlock: !latest,
    seed,
    requestedN: N,
    populationSize: population,
    sampled: total,
    matched,
    mismatched: bad.length,
    fieldComparisons: fieldChecks,
    percentMatching: total ? (100 * matched) / total : 0,
    invariants,
    pass,
  };
  writeFileSync(
    resolve(outDir, `reconcile-${label}.json`),
    JSON.stringify(
      {
        ...meta,
        byKind: Object.fromEntries(byKind),
        mismatches: bad,
        results: results.map((r) => ({
          kind: r.kind,
          id: r.id,
          block: r.block,
          ok: r.ok,
          attempts: r.attempts,
        })),
      },
      null,
      2,
    ),
  );
  const md = [
    `# Reconciliation: indexer vs chain (${label})`,
    "",
    `- Run at ${meta.when}; indexer \`${meta.indexer}\`; chain ${chainId} via \`${meta.rpc}\``,
    label === "local"
      ? "- **LOCAL**: local anvil chain, local indexer (RPC data source), mock prices. Not testnet, not hosted."
      : "",
    `- Each entity is fetched with \`_meta.progressBlock\` in one request and the chain is read at that block${latest ? " (DISABLED: --block latest)" : ""}. Mismatches are re-fetched up to 3 times.`,
    `- Population ${population} entities; requested ${N}; **sampled ${total}**; **matched ${matched}**; mismatched ${bad.length}; field comparisons ${fieldChecks}; seed ${seed}`,
    `- Result: **${meta.percentMatching.toFixed(2)}% matching: ${pass ? "PASS" : "FAIL"}**${enough ? "" : ` (fewer than ${N} entities sampled)`}`,
    "",
    "| entity | sampled | matched |",
    "|---|---|---|",
    ...[...byKind].map(([k, v]) => `| ${k} | ${v.n} | ${v.ok} |`),
    "",
    "## Indexer-internal invariants (GraphQL only)",
    "",
    ...invariants.map((i) => `- ${i.ok ? "PASS" : "FAIL"}: ${i.name} (${i.detail})`),
    "",
    bad.length ? "## Mismatches" : "",
    ...bad.flatMap((r) => [
      `- ${r.kind} \`${r.id}\` (block ${r.block}):`,
      ...r.checks
        .filter((c) => c.indexer !== c.chain)
        .map((c) => `  - ${c.field}: indexer ${c.indexer}, chain ${c.chain}`),
    ]),
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, `reconcile-${label}.md`), md);
  for (const i of invariants)
    console.log(`${i.ok ? "ok  " : "FAIL"} invariant: ${i.name} (${i.detail})`);
  console.log(
    `${pass ? "PASS" : "FAIL"}: sampled ${total}, matched ${matched}, mismatched ${bad.length} (${meta.percentMatching.toFixed(2)}%)`,
  );
  for (const r of bad.slice(0, 10))
    console.log(JSON.stringify(r.checks.filter((c) => c.indexer !== c.chain)), r.kind, r.id);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
