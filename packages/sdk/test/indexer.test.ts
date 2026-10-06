import { describe, expect, it } from "vitest";
import {
  ALL_MARKET_STATUSES,
  createIndexerClient,
  INDEXER_QUERIES,
  IndexerError,
  indexerQuery,
  lpUnrealizedPnl,
  navPerformance,
  parseMarket,
  positionValue,
  SECONDS_PER_YEAR,
  toBig,
  totalPnl,
  unrealizedPnl,
  valuationOf,
  windowPerformance,
  WAD,
  type HoldingLike,
} from "../src";

type Call = { url: string; init: RequestInit };

/** A fetch that answers with the given JSON and records the calls. */
function fakeFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const bodyOf = (c: Call) =>
  JSON.parse(String(c.init.body)) as { query: string; variables?: unknown };

describe("transport", () => {
  it("POSTs { query, variables } with the bearer key and extra headers", async () => {
    const { f, calls } = fakeFetch({ data: { ok: 1 } });
    const d = await indexerQuery<{ ok: number }>(
      {
        url: "https://x/v1/graphql",
        apiKey: "k",
        headers: { "x-hasura-admin-secret": "testing" },
        fetch: f,
      },
      "query { ok }",
      { a: 1 },
    );
    expect(d).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe("https://x/v1/graphql");
    expect(calls[0]!.init.method).toBe("POST");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer k");
    expect(h["x-hasura-admin-secret"]).toBe("testing");
    expect(bodyOf(calls[0]!)).toEqual({ query: "query { ok }", variables: { a: 1 } });
  });

  it("surfaces GraphQL errors, HTTP errors and non-JSON bodies as IndexerError", async () => {
    await expect(
      indexerQuery({ url: "u", fetch: fakeFetch({ errors: [{ message: "boom" }] }).f }, "q"),
    ).rejects.toThrow(/boom/);
    const e = await indexerQuery(
      { url: "u", fetch: fakeFetch({ error: "unauthorized" }, 401).f },
      "q",
    ).catch((x) => x);
    expect(e).toBeInstanceOf(IndexerError);
    expect((e as IndexerError).status).toBe(401);
    await expect(
      indexerQuery({ url: "u", fetch: fakeFetch("<html>", 502).f }, "q"),
    ).rejects.toThrow(/non-JSON/);
  });

  it("wraps network failures", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(indexerQuery({ url: "u", fetch: f }, "q")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("numeric parsing", () => {
  it("BigInt columns arrive as strings and keep full precision above 2^53", () => {
    expect(toBig("1049002711066038697")).toBe(1_049_002_711_066_038_697n);
    expect(toBig("64545000000000000000000")).toBe(64_545_000_000_000_000_000_000n);
    expect(toBig(42)).toBe(42n);
  });
  it("refuses a JSON number that already lost precision", () => {
    expect(() => toBig(Number("1049002711066038697"))).toThrow(/lost precision/);
  });
});

// Shapes copied from the real (local) Hasura responses seen on 2026-10-06.
const marketRow = {
  id: "0x3ded2ea655974e00c884fcdc4b532b01831c565f",
  asset: "BTC",
  assetId: "0xaa",
  duration: 900,
  startTime: 1791304200,
  endTime: 1791305100,
  strike: "64545000000000000000000",
  endPrice: null,
  status: "OPEN",
  outcome: null,
  upToken: "0x01",
  downToken: "0x02",
  volume: "14478000",
  tradeCount: 6,
  lastUpPrice: "0.56",
  vaultRegistered: true,
  vaultBasis: "8000000",
  vaultCash: "-2",
  upSupply: "100000000",
  downSupply: "100000000",
};

describe("client", () => {
  it("markets(): enum variable, pagination, parsed rows; by-asset uses its own document", async () => {
    const { f, calls } = fakeFetch({ data: { Market: [marketRow] } });
    const c = createIndexerClient({ url: "u", fetch: f });
    const rows = await c.markets();
    expect(rows[0]).toMatchObject({
      status: "OPEN",
      strike: 64_545_000_000_000_000_000_000n,
      endPrice: null,
      volume: 14_478_000n,
      vaultCash: -2n,
      lastUpPrice: 0.56,
      vaultRegistered: true,
    });
    expect(bodyOf(calls[0]!).query).toBe(INDEXER_QUERIES.marketList);
    expect(bodyOf(calls[0]!).variables).toEqual({
      statuses: ["CREATED", "OPEN"],
      limit: 50,
      offset: 0,
    });
    await c.markets({ asset: "ETH", statuses: ALL_MARKET_STATUSES, limit: 5 });
    expect(bodyOf(calls[1]!).query).toBe(INDEXER_QUERIES.marketListByAsset);
    expect(bodyOf(calls[1]!).variables).toMatchObject({ asset: "ETH", limit: 5 });
    // the variable must never be null: Hasura rejects `_eq: null`
    expect(JSON.stringify(bodyOf(calls[0]!).variables)).not.toContain("null");
  });

  it("market(): lower-cases the id, returns null when absent, parses the trades", async () => {
    const trade = {
      id: "10_2",
      market_id: marketRow.id,
      side: "UP",
      action: "BUY",
      size: "6000000",
      premium: "3240000",
      price: "0.54",
      taker: "0xaa",
      txHash: "0xbb",
      block: 10,
      timestamp: 1791304300,
    };
    const { f, calls } = fakeFetch({ data: { Market_by_pk: { ...marketRow, trades: [trade] } } });
    const m = await createIndexerClient({ url: "u", fetch: f }).market("0xABCDEF", 10);
    expect(m!.trades[0]).toMatchObject({
      size: 6_000_000n,
      premium: 3_240_000n,
      price: 0.54,
      side: "UP",
    });
    expect(bodyOf(calls[0]!).variables).toEqual({ id: "0xabcdef", trades: 10 });
    const none = await createIndexerClient({
      url: "u",
      fetch: fakeFetch({ data: { Market_by_pk: null } }).f,
    }).market("0x1");
    expect(none).toBeNull();
  });

  it("userPositions(): parses balances, cost and the joined market", async () => {
    const { f } = fakeFetch({
      data: {
        UserPosition: [
          {
            id: "u_m",
            user: "0xu",
            market_id: "0xm",
            upBalance: "6000000",
            downBalance: "0",
            upEscrowed: "0",
            downEscrowed: "0",
            upCost: "3288000",
            downCost: "0",
            costBasis: "3288000",
            realizedPnl: "-5",
            totalIn: "5480000",
            totalOut: "2200000",
            tradeCount: 3,
            market: {
              id: "0xm",
              asset: "BTC",
              status: "RESOLVED_UP",
              outcome: "UP",
              lastUpPrice: null,
              startTime: 1,
              endTime: 2,
            },
          },
        ],
      },
    });
    const [p] = await createIndexerClient({ url: "u", fetch: f }).userPositions("0xU");
    expect(p).toMatchObject({
      realizedPnl: -5n,
      costBasis: 3_288_000n,
      market: { status: "RESOLVED_UP", outcome: "UP", lastUpPrice: null },
    });
  });

  it("vault(): empty indexer yields nulls, not exceptions", async () => {
    const { f } = fakeFetch({ data: { Vault: [], ProtocolStats_by_pk: null, NavSnapshot: [] } });
    expect(await createIndexerClient({ url: "u", fetch: f }).vault()).toEqual({
      vault: null,
      protocol: null,
      latestSnapshot: null,
    });
  });

  it("status() returns _meta rows", async () => {
    const meta = {
      chainId: 10143,
      progressBlock: 5,
      sourceBlock: 7,
      bufferBlock: 7,
      eventsProcessed: 3,
      isReady: true,
      readyAt: null,
      startBlock: 0,
      endBlock: null,
    };
    const { f } = fakeFetch({ data: { _meta: [meta] } });
    expect(await createIndexerClient({ url: "u", fetch: f }).status()).toEqual([meta]);
  });

  it("every documented query is a single operation with balanced braces and only known variables", () => {
    for (const [name, q] of Object.entries(INDEXER_QUERIES)) {
      expect(q.trim().startsWith("query "), name).toBe(true);
      expect((q.match(/{/g) ?? []).length, name).toBe((q.match(/}/g) ?? []).length);
      const declared = [...q.matchAll(/\$(\w+):/g)].map((m) => m[1]);
      const used = [...q.matchAll(/\$(\w+)/g)].map((m) => m[1]);
      for (const u of used) expect(declared, `${name} uses undeclared $${u}`).toContain(u);
    }
  });

  it("parseMarket handles a never-opened market", () => {
    const m = parseMarket({ ...marketRow, strike: null, status: "CREATED", lastUpPrice: null });
    expect([m.strike, m.lastUpPrice, m.status]).toEqual([null, null, "CREATED"]);
  });
});

describe("APY and PnL math", () => {
  it("navPerformance: one year of +100% is 100% APY; undefined for bad input", () => {
    const p = navPerformance(
      { ppsWad: 2n * WAD, timestamp: SECONDS_PER_YEAR },
      { ppsWad: WAD, timestamp: 0 },
    );
    expect(p?.apy).toBeCloseTo(1, 12);
    expect(
      navPerformance({ ppsWad: WAD, timestamp: 0 }, { ppsWad: WAD, timestamp: 0 }),
    ).toBeUndefined();
  });

  it("windowPerformance picks the last snapshot at or before now - window", () => {
    const d = 86_400;
    const snaps = [0, 3, 6, 9].map((k, i) => ({ ppsWad: BigInt(i + 1) * WAD, timestamp: k * d }));
    const p = windowPerformance(snaps, { ppsWad: 5n * WAD, timestamp: 10 * d }, 7 * d);
    expect(p?.periodReturn).toBeCloseTo(1.5, 12); // baseline = day 3 (pps 2)
    expect(
      windowPerformance(snaps, { ppsWad: 5n * WAD, timestamp: 10 * d }, 11 * d),
    ).toBeUndefined();
  });

  const held: HoldingLike = {
    upBalance: 4_000_000n,
    downBalance: 0n,
    upEscrowed: 2_000_000n,
    downEscrowed: 0n,
    upCost: 3_300_000n,
    downCost: 0n,
    realizedPnl: 8_000n,
  };

  it("positionValue / unrealized / total PnL (wallet + escrow counted)", () => {
    const live = { kind: "live", upPriceWad: (60n * WAD) / 100n } as const;
    expect(positionValue(held, live)).toBe(3_600_000n); // 6 UP at 0.60
    expect(unrealizedPnl(held, live)).toBe(300_000n);
    expect(totalPnl(held, live)).toBe(308_000n);
    expect(positionValue(held, { kind: "resolved", outcome: "UP" })).toBe(6_000_000n);
    expect(positionValue(held, { kind: "resolved", outcome: "DOWN" })).toBe(0n);
    expect(positionValue(held, { kind: "resolved", outcome: "INVALID" })).toBe(3_000_000n);
  });

  it("valuationOf: resolved statuses are exact, live uses the last fill price (0.5 when none)", () => {
    expect(valuationOf({ status: "RESOLVED_UP", lastUpPrice: 0.3 })).toEqual({
      kind: "resolved",
      outcome: "UP",
    });
    expect(valuationOf({ status: "INVALID", lastUpPrice: null })).toEqual({
      kind: "resolved",
      outcome: "INVALID",
    });
    expect(valuationOf({ status: "OPEN", lastUpPrice: "0.56" })).toEqual({
      kind: "live",
      upPriceWad: 560_000_000_000_000_000n,
    });
    expect(valuationOf({ status: "OPEN", lastUpPrice: null })).toEqual({
      kind: "live",
      upPriceWad: WAD / 2n,
    });
  });

  it("lpUnrealizedPnl at a lower price per share", () => {
    expect(
      lpUnrealizedPnl({ shares: 600n, escrowedShares: 0n, costBasis: 600n }, (11n * WAD) / 10n),
    ).toBe(60n);
  });
});
