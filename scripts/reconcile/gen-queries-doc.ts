/**
 * Generates indexer/QUERIES.md from the SDK's INDEXER_QUERIES (so the documented queries are the
 * exact strings the app and the latency harness run). `--check` fails when the file is stale.
 * Usage: tsx gen-queries-doc.ts [--check]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { INDEXER_QUERIES } from "@converge/sdk";
import { ROOT } from "./lib/chain";

type Doc = {
  key: keyof typeof INDEXER_QUERIES;
  title: string;
  powers: string;
  helper: string;
  vars: string;
  notes: string;
};

const DOCS: Doc[] = [
  {
    key: "marketList",
    title: "Market list (app home)",
    powers:
      "Home screen: live and upcoming rounds, soonest end first; the resolved tab with `statuses: [RESOLVED_UP, RESOLVED_DOWN, INVALID]`.",
    helper: "`client.markets({ statuses, limit, offset })`",
    vars: "`statuses: [marketstatus!]!` (enum values `CREATED OPEN RESOLVED_UP RESOLVED_DOWN INVALID`), `limit`, `offset`",
    notes:
      "`lastUpPrice` is the last fill price of the UP token (null before the first fill); `vaultRegistered` is true while the vault quotes the market; `strike`/`endPrice` are in the oracle's 18-decimal price units, `null` until set.",
  },
  {
    key: "marketListByAsset",
    title: "Market list for one asset",
    powers: "Asset filter chips (BTC / ETH).",
    helper: '`client.markets({ asset: "BTC", ... })`',
    vars: "as above plus `asset: String!` (the factory label, e.g. `BTC`)",
    notes: "A second document because Hasura rejects `_eq: null`.",
  },
  {
    key: "marketDetail",
    title: "Market detail with the latest trades",
    powers: "Market screen: strike, status, vault position, price and trade tape.",
    helper: "`client.market(id, trades)`",
    vars: "`id: String!` (lower-case market address), `trades: Int!`",
    notes:
      "`vaultBasis`/`vaultCash` equal `ConvergeVault.positionOf(market)` (reconciled). Trades are ordered by block then log index, newest first.",
  },
  {
    key: "recentTrades",
    title: "Live trade feed",
    powers: "Global activity ticker.",
    helper: "`client.recentTrades(limit)`",
    vars: "`limit: Int!`",
    notes:
      "One row per vault ladder level filled. `price = premium / size`; `action` is from the taker's side (`BUY` when the vault sold the token). The vault is always the maker.",
  },
  {
    key: "userTrades",
    title: "A user's trade history",
    powers: "Portfolio > History.",
    helper: "`client.userTrades(user, limit, offset)`",
    vars: "`user: String!` (lower-case address), `limit`, `offset`",
    notes: "",
  },
  {
    key: "userPositions",
    title: "A user's positions (with the market)",
    powers: "Portfolio: open positions, settled-but-unredeemed winners, PnL.",
    helper: "`client.userPositions(user)` then `totalPnl(position, valuationOf(position.market))`",
    vars: "`user: String!`",
    notes:
      "Balances are exact wallet balances; `upEscrowed`/`downEscrowed` are tokens locked in open venue sell orders (still the user's). `costBasis` is the average cost of tokens still held; `realizedPnl` is booked on sells, merges and redeems. Value and unrealized PnL are computed client-side (`positionValue`, `unrealizedPnl`, `totalPnl` in the SDK): live markets at the last fill price, resolved markets exactly (winner 1, loser 0, invalid 0.5).",
  },
  {
    key: "userOrders",
    title: "A user's venue orders",
    powers: "Order status (open, executed with fill, expired).",
    helper: "`client.userOrders(user, limit)`",
    vars: "`user: String!`, `limit: Int!`",
    notes:
      "An order is priced once at `execAt` (placed + 2 s); `filled`/`premium` are null while OPEN.",
  },
  {
    key: "vaultOverview",
    title: "Vault overview (NAV, price per share, APY, totals)",
    powers: "Vault screen header and the public stats strip.",
    helper: "`client.vault()`",
    vars: "none",
    notes:
      "`ppsLower` is WAD (1e18 = 1.0). `apy7d`/`apy30d` are annualised compound returns of the lower price per share (null until the history covers the window). The baseline is the last snapshot of the last day that ends before `now - window`, so the effective window is between W and W + 1 day. Use `navHistory` and `windowPerformance` for the exact figure.",
  },
  {
    key: "navHistory",
    title: "NAV / price-per-share history",
    powers: "Vault chart; exact APY audit.",
    helper:
      "`client.navHistory(sinceTimestamp, limit)` then `windowPerformance(snapshots, latest, windowSeconds)`",
    vars: "`since: Int!` (unix seconds), `limit: Int!`",
    notes:
      "Snapshots come from settlements (every epoch with requests), `checkpoint` calls and the vault's automatic checkpoint (at most one per minute while trading). The lower NAV carries the 5-point mark band, so a short window is noisy and annualisation amplifies it.",
  },
  {
    key: "epochs",
    title: "Vault epochs",
    powers:
      "Epoch table: NAV, price per share, fees, deposits and redemptions of each 15 minute epoch.",
    helper: "`client.epochs(limit)`",
    vars: "`limit: Int!`",
    notes:
      "`status` is null while the epoch is only requested, `SETTLED` or `EXPIRED` (nobody settled it in time; deposits are refundable and redemptions re-queued).",
  },
  {
    key: "lpOverview",
    title: "An LP's position and requests",
    powers: "LP screen: shares, cost basis, PnL, pending deposits and redemptions.",
    helper: "`client.lp(user)` then `lpUnrealizedPnl(position, vault.ppsLower)`",
    vars: "`user: String!`",
    notes:
      "`shares` is the exact share-token balance; `escrowedShares` sits in open redeem requests (still the LP's). Request `status`: `REQUESTED` (epoch not settled), `CLAIMABLE`, `REFUNDABLE` (rejected or expired deposit), `CLAIMED`, `REFUNDED`.",
  },
  {
    key: "dailyStats",
    title: "Daily statistics",
    powers: "Public stats page and charts.",
    helper: "`client.dailyStats(days)`",
    vars: "`days: Int!`",
    notes:
      "UTC days. `volume` is premium traded; `tvlClose` and `ppsClose` come from the day's last NAV snapshot; `activeUsers` counts distinct non-system addresses that traded, requested or split/merged/redeemed that day.",
  },
  {
    key: "protocolStats",
    title: "All-time totals",
    powers: "Public stats header.",
    helper: "`client.protocolStats()`",
    vars: "none",
    notes:
      "`totalFeesRedeem` is redeem fees accrued by markets, `totalFeesPerformance` the vault's performance fee in assets.",
  },
  {
    key: "status",
    title: "Indexing status (freshness and lag)",
    powers: "Staleness banner; the lag monitor.",
    helper: "`client.status()`",
    vars: "none",
    notes:
      "`sourceBlock - progressBlock` is the lag in blocks. `isReady` is true once the historical backfill is complete.",
  },
];

function render(): string {
  const out: string[] = [
    "# Indexer queries",
    "",
    "_Generated by `pnpm --filter @converge/reconcile gen:queries-doc` from `INDEXER_QUERIES` in `packages/sdk/src/indexer.ts`: these are the exact documents the app, the SDK and the latency harness run. Do not edit by hand._",
    "",
    "## Endpoint and conventions",
    "",
    "- Envio HyperIndex serves a Hasura GraphQL API at `<endpoint>/v1/graphql`. Hosted (Envio Cloud) endpoints may require `Authorization: Bearer <key>`; the local dev Hasura uses the header `x-hasura-admin-secret: testing`.",
    "- Entity roots are named like the schema types (`Market`, `Trade`, ...), single rows by primary key as `Market_by_pk(id:)`; `where`, `order_by`, `limit`, `offset` as in Hasura. Relations are `market { ... }` (stored as `market_id`).",
    "- **Numbers:** BigInt and BigDecimal columns are returned as JSON **strings** (verified), so `uint256` values keep full precision. Collateral amounts are integer 6-decimal units; shares, `ppsLower` and navs per share are WAD; prices are decimals in [0, 1].",
    "- **Ids:** addresses are lower-case `0x...`; `Trade` and `NavSnapshot` are `<block>_<logIndex>`; positions `<user>_<market>`; requests `<epoch>_<owner>`; epochs and orders their numeric id.",
    "- **Enums as variables** use the lower-cased enum name as the GraphQL type (`marketstatus`); inline they are bare literals (`status: { _eq: OPEN }`).",
    "- **Freshness:** every answer reflects `_meta.progressBlock`; request `_meta` in the same document when the UI must show it.",
    "- Typed access: `createIndexerClient({ url, apiKey? })` from `@converge/sdk` (`packages/sdk/src/indexer.ts`), the helpers named below.",
    "",
    "## Derived metrics",
    "",
    "- **Vault APY** = `(ppsLower_now / ppsLower_then) ^ (365 d / elapsed) - 1` over actual elapsed time; `return7d`/`return30d` are the un-annualised period returns. Stored on `Vault` as `apy7d`, `apy30d`, `apySinceInception` (null until the history covers the window). Source: `NavSnapshot` events (ADR-005 lower NAV).",
    "- **User PnL** = `realizedPnl` (stored; average-cost, booked on sells, merges and redeems) + unrealized (client-side from the held tokens and the market valuation). A `split` costs its collateral 50/50 between UP and DOWN; tokens transferred between ordinary wallets carry their cost; tokens received any other way have zero cost.",
    "- **LP PnL** = `realizedPnl` (booked at redemption claims) + `shares x ppsLower - costBasis`. A deposit's cost is its requested assets; shares and cost land with the `receiver` of the claim.",
    "",
  ];
  for (const d of DOCS) {
    out.push(
      `## ${d.title}`,
      "",
      `Powers: ${d.powers}`,
      "",
      `SDK: ${d.helper}`,
      "",
      `Variables: ${d.vars}`,
      "",
    );
    out.push("```graphql", INDEXER_QUERIES[d.key].trim(), "```", "");
    if (d.notes) out.push(d.notes, "");
  }
  out.push(
    "## Not covered by a helper",
    "",
    "Anything else is a plain Hasura query through `client.query(document, variables)`. Aggregates are available (`Trade_aggregate { aggregate { count sum { premium } } }`).",
    "",
  );
  return out.join("\n");
}

const target = resolve(ROOT, "indexer/QUERIES.md");
const doc = render();
if (process.argv.includes("--check")) {
  const cur = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (cur !== doc) {
    console.error(
      "indexer/QUERIES.md is stale: run pnpm --filter @converge/reconcile gen:queries-doc",
    );
    process.exit(1);
  }
  console.log("QUERIES.md up to date");
} else {
  writeFileSync(target, doc);
  console.log(`wrote ${target}`);
}
