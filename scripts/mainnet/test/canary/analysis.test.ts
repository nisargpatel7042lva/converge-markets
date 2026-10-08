import { describe, expect, it } from "vitest";
import {
  INVALID_STATE,
  RESOLVED_DOWN,
  RESOLVED_UP,
  expectedStarts,
  judgeRounds,
  judgeTrades,
  overall,
  pnl,
  type RoundObs,
  type TradeRecord,
} from "../../src/canary/analysis";

const BTC = { label: "BTC/USD", durations: [900] };
const T = 1_800_000_000 - (1_800_000_000 % 900); // on the grid
const good = (start: number, d = 900): RoundObs => ({
  series: "BTC/USD",
  duration: d,
  start,
  created: true,
  state: RESOLVED_UP,
  openedAt: start + 3,
  resolvedAt: start + d + 40,
});

describe("expected rounds", () => {
  it("counts only whole rounds inside the window, on the grid", () => {
    expect(expectedStarts(900, T + 1, T + 900 * 4)).toEqual([T + 900, T + 1800, T + 2700]);
    expect(expectedStarts(900, T, T + 900 * 4)).toEqual([T, T + 900, T + 1800, T + 2700]);
    expect(expectedStarts(3600, T, T + 100)).toEqual([]);
  });
});

describe("judging rounds", () => {
  const window = { from: T, to: T + 3600 };
  it("0 missed when every expected round was created, opened on time and resolved", () => {
    const obs = [0, 900, 1800, 2700].map((o) => good(T + o));
    const v = judgeRounds(obs, [BTC], window);
    expect(v).toMatchObject({ expected: 4, resolved: 4, invalid: 0, missed: [] });
  });

  it("names every kind of miss", () => {
    const obs: RoundObs[] = [
      good(T),
      { ...good(T + 900), created: false, state: null, openedAt: null, resolvedAt: null }, // never created
      { ...good(T + 1800), openedAt: null }, // never opened
      { ...good(T + 2700), openedAt: T + 2700 + 61 }, // opened late
    ];
    const v = judgeRounds(obs, [BTC], window);
    expect(v.missed.map((m) => m.reason)).toEqual(["not-created", "not-opened", "opened-late"]);
    const v2 = judgeRounds(
      [good(T), good(T + 900), good(T + 1800), { ...good(T + 2700), state: 1, resolvedAt: null }],
      [BTC],
      window,
    );
    expect(v2.missed.map((m) => m.reason)).toEqual(["not-resolved"]);
    const v3 = judgeRounds(
      [
        good(T),
        good(T + 900),
        good(T + 1800),
        { ...good(T + 2700), resolvedAt: T + 2700 + 900 + 601 },
      ],
      [BTC],
      window,
    );
    expect(v3.missed.map((m) => m.reason)).toEqual(["resolved-late"]);
  });

  it("counts an INVALID round as a miss (holders get 0.5, not the outcome) and a round absent from the data as not created", () => {
    const v = judgeRounds([good(T), { ...good(T + 900), state: INVALID_STATE }], [BTC], {
      from: T,
      to: T + 1800,
    });
    expect(v.invalid).toBe(1);
    expect(v.missed).toEqual([expect.objectContaining({ reason: "invalid", start: T + 900 })]);
    expect(judgeRounds([], [BTC], { from: T, to: T + 900 }).missed[0]!.reason).toBe("not-created");
  });

  it("handles several series and durations, and resolved-down like resolved-up", () => {
    const obs = [
      good(T),
      { ...good(T), series: "ETH/USD" },
      { ...good(T + 900), state: RESOLVED_DOWN },
    ];
    const v = judgeRounds(obs, [BTC, { label: "ETH/USD", durations: [900] }], {
      from: T,
      to: T + 3600,
    });
    expect(v.expected).toBe(8);
    expect(v.resolved).toBe(3);
    expect(v.missed).toHaveLength(5);
  });
});

describe("judging trades", () => {
  const trade = (over: Partial<TradeRecord>): TradeRecord => ({
    orderId: "1",
    market: "0xm",
    series: "BTC/USD",
    side: "UP",
    placedAt: 1000,
    status: "executed",
    redeem: "ok",
    ...over,
  });
  it("a failed redeem is a failed claim; an order still open after 60 s is stuck", () => {
    const v = judgeTrades(
      [
        trade({}),
        trade({ orderId: "2", redeem: "failed", redeemError: "revert" }),
        trade({ orderId: "3", status: "open", redeem: undefined }),
        trade({ orderId: "4", status: "expired", redeem: "not-needed" }),
      ],
      1100,
    );
    expect(v.placed).toBe(4);
    expect(v.executed).toBe(2);
    expect(v.expired).toBe(1);
    expect(v.failedClaims.map((t) => t.orderId)).toEqual(["2"]);
    expect(v.stuckOrders.map((t) => t.orderId)).toEqual(["3"]);
  });
  it("a fresh open order is not stuck yet, and a pending redeem is reported separately", () => {
    const v = judgeTrades(
      [
        trade({ status: "open", redeem: undefined, placedAt: 1090 }),
        trade({ orderId: "9", redeem: "pending" }),
      ],
      1100,
    );
    expect(v.stuckOrders).toEqual([]);
    expect(v.pendingClaims.map((t) => t.orderId)).toEqual(["9"]);
  });
});

describe("pnl and the overall verdict", () => {
  it("reports the share-price change, not the NAV change", () => {
    const r = pnl(
      { at: 0, navLower: 5_000_000_000n, navUpper: 5_000_000_000n, pps: 10n ** 18n, supply: 1n },
      {
        at: 43_200,
        navLower: 4_900_000_000n,
        navUpper: 4_950_000_000n,
        pps: 99n * 10n ** 16n,
        supply: 1n,
      },
    );
    expect(r.hours).toBe(12);
    expect(r.ppsChange).toBeCloseTo(-0.01, 10);
    expect(r.note).toMatch(/almost nothing/);
  });

  it("passes only with >= 12 h, no missed round, no failed claim, no stuck order and at least one trade", () => {
    const rounds = judgeRounds([good(T)], [BTC], { from: T, to: T + 900 });
    const trades = judgeTrades(
      [
        {
          orderId: "1",
          market: "m",
          series: "s",
          side: "UP",
          placedAt: 0,
          status: "executed",
          filledShares: "1000000",
          redeem: "ok",
        },
      ],
      10_000,
    );
    expect(overall(12, 12, rounds, trades, 1)).toEqual({ pass: true, reasons: [] });
    // executed with nothing filled proves nothing about quoting
    const unfilled = judgeTrades(
      [
        {
          orderId: "1",
          market: "m",
          series: "s",
          side: "UP",
          placedAt: 0,
          status: "executed",
          filledShares: "0",
          redeem: "ok",
        },
      ],
      10_000,
    );
    expect(overall(12, 12, rounds, unfilled, 1).reasons.join()).toMatch(/actually filled/);
    // an order the trader had to expire itself is a stuck order (the keeper missed it)
    const fb = judgeTrades(
      [
        {
          orderId: "2",
          market: "m",
          series: "s",
          side: "UP",
          placedAt: 0,
          status: "expired",
          fallbackExpired: true,
          redeem: "not-needed",
        },
      ],
      10_000,
    );
    expect(fb.stuckOrders).toHaveLength(1);
    expect(overall(11.9, 12, rounds, trades, 1).reasons.join()).toMatch(/needs 12 h/);
    expect(
      overall(12, 12, judgeRounds([], [BTC], { from: T, to: T + 900 }), trades).reasons.join(),
    ).toMatch(/missed/);
    expect(overall(12, 12, rounds, judgeTrades([], 0)).reasons.join()).toMatch(/placed no order/);
    expect(
      overall(12, 12, judgeRounds([], [BTC], { from: T, to: T + 10 }), trades).reasons.join(),
    ).toMatch(/no round was expected/);
  });
});
