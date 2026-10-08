import { describe, expect, it } from "vitest";
import { plan, type Action, type PlanInput } from "../../src/planner";
import { ASSET, FEED, MKT, NOW, USDC, market, order, state } from "./fixtures";

const cfg = {
  sigmaRefreshSec: 240,
  sigmaMoveFraction: 0.05,
  targetPairFraction: 0.05,
  topUpBelowFraction: 0.5,
  minSecondsLeftToSplit: 120,
  checkpointEverySec: 300,
};

function run(over: Partial<PlanInput> = {}): Action[] {
  return plan({
    nowSec: NOW,
    state: state(),
    sigmaTarget: new Map([[ASSET.toLowerCase(), 0.6]]),
    orders: [],
    venue: { maxLateness: 4 },
    cfg,
    pulling: false,
    spots: new Map([[ASSET.toLowerCase(), 3000]]),
    ...over,
  });
}
const of = (a: Action[], t: Action["type"]) => a.filter((x) => x.type === t);

describe("planner: sigma", () => {
  it("does nothing when the stored sigma is fresh and close to the estimate", () => {
    expect(of(run(), "setSigma")).toHaveLength(0);
  });

  it("sets an unset sigma straight to the estimate", () => {
    const s = state();
    s.assets[0]!.sigma = 0;
    s.assets[0]!.sigmaUpdatedAt = 0;
    const [a] = of(
      run({ state: s, sigmaTarget: new Map([[ASSET.toLowerCase(), 0.9]]) }),
      "setSigma",
    );
    expect(a?.type === "setSigma" && a.sigma).toBeCloseTo(0.9, 9);
  });

  it("refreshes a sigma that is old even when the estimate did not move", () => {
    const s = state();
    s.assets[0]!.sigmaUpdatedAt = NOW - 300;
    expect(of(run({ state: s }), "setSigma")).toHaveLength(1);
  });

  it("moves in steps inside the vault's limit (20% per step, 10% margin)", () => {
    const [a] = of(run({ sigmaTarget: new Map([[ASSET.toLowerCase(), 1.1]]) }), "setSigma");
    expect(a?.type === "setSigma" && a.sigma).toBeCloseTo(0.6 * 1.18, 6);
  });

  it("respects the minimum interval between updates", () => {
    const s = state();
    s.assets[0]!.sigmaUpdatedAt = NOW - 10;
    expect(
      of(run({ state: s, sigmaTarget: new Map([[ASSET.toLowerCase(), 1.1]]) }), "setSigma"),
    ).toHaveLength(0);
  });

  it("clamps to the owner band, strictly inside it", () => {
    const s = state();
    s.assets[0]!.sigmaUpdatedAt = NOW - 2000; // stale: no step limit
    const [hi] = of(
      run({ state: s, sigmaTarget: new Map([[ASSET.toLowerCase(), 5]]) }),
      "setSigma",
    );
    expect(hi?.type === "setSigma" && hi.sigma).toBeLessThan(1.2);
    expect(hi?.type === "setSigma" && hi.sigma).toBeGreaterThan(1.19);
    const [lo] = of(
      run({ state: s, sigmaTarget: new Map([[ASSET.toLowerCase(), 0.01]]) }),
      "setSigma",
    );
    expect(lo?.type === "setSigma" && lo.sigma).toBeGreaterThan(0.4);
  });

  it("writes WAD with the right scale", () => {
    const s = state();
    s.assets[0]!.sigma = 0;
    const [a] = of(
      run({ state: s, sigmaTarget: new Map([[ASSET.toLowerCase(), 0.75]]) }),
      "setSigma",
    );
    expect(a?.type === "setSigma" && a.sigmaWad).toBe(750_000_000_000_000_000n);
  });

  it("skips an asset with no estimate or one the vault has not enabled", () => {
    expect(of(run({ sigmaTarget: new Map() }), "setSigma")).toHaveLength(0);
    const s = state();
    s.assets[0]!.enabled = false;
    s.assets[0]!.sigmaUpdatedAt = 0;
    expect(of(run({ state: s }), "setSigma")).toHaveLength(0);
  });
});

describe("planner: orders", () => {
  it("executes an order inside its window", () => {
    const a = run({ orders: [order({ execAt: NOW - 2 })] });
    expect(of(a, "executeOrder")).toHaveLength(1);
    expect(a[0]?.type).toBe("executeOrder"); // and it goes first
  });

  it("does not execute before the pricing time", () => {
    expect(run({ orders: [order({ execAt: NOW + 1 })] })).toEqual([]);
  });

  it("expires an order that was missed", () => {
    const a = run({ orders: [order({ execAt: NOW - 5 })] });
    expect(of(a, "executeOrder")).toHaveLength(0);
    expect(of(a, "expireOrder")).toHaveLength(1);
  });

  it("does not execute while pulled, halted or paused: it expires them instead", () => {
    const o = [order({ execAt: NOW - 1 })];
    expect(of(run({ orders: o, pulling: true }), "executeOrder")).toHaveLength(0);
    expect(of(run({ orders: o, state: state({ keeperHalt: true }) }), "executeOrder")).toHaveLength(
      0,
    );
    expect(
      of(run({ orders: o, state: state({ quotingPaused: true }) }), "executeOrder"),
    ).toHaveLength(0);
    const late = [order({ execAt: NOW - 10 })];
    expect(of(run({ orders: late, pulling: true }), "expireOrder")).toHaveLength(1);
  });
});

describe("planner: settlement", () => {
  const epoch = (over: object = {}) => ({
    id: 9,
    end: NOW - 20,
    depositAssets: USDC(10),
    redeemShares: 0n,
    settled: false,
    plan: { feeds: [FEED], unresolved: [] as `0x${string}`[] },
    ...over,
  });

  it("settles an ended epoch with requests and asks for the marks it needs", () => {
    const [a] = of(run({ state: state({ epochs: [epoch()] }) }), "settle");
    expect(a?.type === "settle" && a.feeds).toEqual([FEED]);
    expect(a?.type === "settle" && a.end).toBe(NOW - 20);
  });

  it("resolves the rounds that ended before it settles", () => {
    const e = epoch({ plan: { feeds: [], unresolved: [MKT(5)] } });
    const a = run({ state: state({ epochs: [e] }) });
    expect(of(a, "settle")).toHaveLength(0);
    expect(of(a, "resolve")).toHaveLength(1);
  });

  it("leaves an epoch alone before its end, after its window, or when already settled", () => {
    expect(of(run({ state: state({ epochs: [epoch({ end: NOW + 5 })] }) }), "settle")).toHaveLength(
      0,
    );
    expect(
      of(run({ state: state({ epochs: [epoch({ end: NOW - 598 })] }) }), "settle"),
    ).toHaveLength(0);
    expect(
      of(run({ state: state({ epochs: [epoch({ settled: true })] }) }), "settle"),
    ).toHaveLength(0);
    expect(of(run({ state: state({ epochs: [epoch({ plan: null })] }) }), "settle")).toHaveLength(
      0,
    );
  });
});

describe("planner: checkpoint, registry upkeep", () => {
  it("checkpoints when the vault's NAV is old, with a feed for exposed open markets", () => {
    const s = state({
      navUpdatedAt: NOW - 400,
      markets: [market({ upBal: USDC(60), downBal: USDC(50) })],
    });
    const [c] = of(run({ state: s }), "checkpoint");
    expect(c?.type === "checkpoint" && c.feeds).toEqual([FEED]);
    expect(of(run({ state: state({ navUpdatedAt: NOW - 100 }) }), "checkpoint")).toHaveLength(0);
  });

  it("redeems resolved rounds, prunes empty registered ones, ignores unregistered", () => {
    const s = state({
      markets: [
        market({ address: MKT(1), state: 2 }),
        market({ address: MKT(2), state: 3, upBal: 0n, downBal: 0n }),
        market({ address: MKT(3), state: 2, registered: false }),
        market({ address: MKT(4), state: 1, end: NOW - 5, upBal: 0n, downBal: 0n }),
      ],
    });
    const a = run({ state: s });
    expect(of(a, "redeemResolved").map((x) => (x as { market: string }).market)).toEqual([MKT(1)]);
    expect(
      of(a, "pruneEmpty")
        .map((x) => (x as { market: string }).market)
        .sort(),
    ).toEqual([MKT(2), MKT(4)]);
  });
});

describe("planner: inventory", () => {
  it("merges all pairs in the final seconds of a round", () => {
    const s = state({ markets: [market({ end: NOW + 35 })] });
    const [m] = of(run({ state: s }), "merge");
    expect(m?.type === "merge" && m.amount).toBe(USDC(50));
    expect(
      of(run({ state: state({ markets: [market({ end: NOW + 300 })] }) }), "merge"),
    ).toHaveLength(0);
  });

  it("merges to cover a redemption shortfall, the soonest-ending round first", () => {
    const s = state({
      freeLiquidity: USDC(10),
      epochs: [
        {
          id: 9,
          end: NOW - 20,
          depositAssets: 0n,
          redeemShares: USDC(100),
          settled: false,
          plan: null,
        },
      ],
      markets: [
        market({ address: MKT(1), end: NOW + 800, upBal: USDC(40), downBal: USDC(40) }),
        market({ address: MKT(2), end: NOW + 400, upBal: USDC(30), downBal: USDC(30) }),
      ],
    });
    const merges = of(run({ state: s }), "merge").map(
      (x) => x as { market: string; amount: bigint },
    );
    expect(merges[0]).toMatchObject({ market: MKT(2), amount: USDC(30) });
    expect(merges[1]).toMatchObject({ market: MKT(1), amount: USDC(40) }); // all it has: 90 short - 30 = 60
  });

  it("splits into an open round that has no inventory, up to the target", () => {
    const s = state({
      markets: [market({ registered: false, upBal: 0n, downBal: 0n, basis: 0n })],
    });
    const [sp] = of(run({ state: s }), "split");
    expect(sp?.type === "split" && sp.amount).toBe(USDC(50)); // 5% of 1000
  });

  it("tops up only below half the target", () => {
    const above = state({ markets: [market({ upBal: USDC(26), downBal: USDC(26) })] });
    expect(of(run({ state: above }), "split")).toHaveLength(0);
    const below = state({
      markets: [market({ upBal: USDC(20), downBal: USDC(20), basis: USDC(20) })],
    });
    const [sp] = of(run({ state: below }), "split");
    expect(sp?.type === "split" && sp.amount).toBe(USDC(30));
  });

  it("never splits while pulled, halted or paused, or late in a round", () => {
    const fresh = state({
      markets: [market({ registered: false, upBal: 0n, downBal: 0n, basis: 0n })],
    });
    expect(of(run({ state: fresh, pulling: true }), "split")).toHaveLength(0);
    expect(of(run({ state: { ...fresh, keeperHalt: true } }), "split")).toHaveLength(0);
    expect(of(run({ state: { ...fresh, quotingPaused: true } }), "split")).toHaveLength(0);
    const late = state({
      markets: [market({ registered: false, end: NOW + 100, upBal: 0n, downBal: 0n, basis: 0n })],
    });
    expect(of(run({ state: late }), "split")).toHaveLength(0);
  });

  it("respects the pair cap, the inventory cap, free liquidity and the registry limit", () => {
    const fresh = (over: object) =>
      state({
        markets: [market({ registered: false, upBal: 0n, downBal: 0n, basis: 0n })],
        ...over,
      });
    // free liquidity smaller than the target
    const [a] = of(run({ state: fresh({ freeLiquidity: USDC(20) }) }), "split");
    expect(a?.type === "split" && a.amount).toBe(USDC(20));
    // free liquidity already owed to redeemers: nothing left to split
    const owed = fresh({
      freeLiquidity: USDC(60),
      epochs: [
        {
          id: 9,
          end: NOW - 20,
          depositAssets: 0n,
          redeemShares: USDC(100),
          settled: false,
          plan: null,
        },
      ],
    });
    expect(of(run({ state: owed }), "split")).toHaveLength(0);
    // total inventory cap: other markets already hold 480 of the 500 allowed
    const full = state({
      markets: [
        market({ address: MKT(1), registered: false, upBal: 0n, downBal: 0n, basis: 0n }),
        market({
          address: MKT(2),
          basis: USDC(480),
          upBal: USDC(480),
          downBal: USDC(480),
          end: NOW + 800,
        }),
      ],
    });
    const [b] = of(run({ state: full }), "split");
    expect(b?.type === "split" && b.amount).toBe(USDC(20));
    // registry full: no new registration
    const slots = fresh({});
    slots.limits.marketCount = 16;
    expect(of(run({ state: slots }), "split")).toHaveLength(0);
  });

  it("orders the actions by priority", () => {
    const s = state({
      navUpdatedAt: NOW - 400,
      markets: [
        market({ address: MKT(1), state: 2 }),
        market({ address: MKT(9), registered: false, upBal: 0n, downBal: 0n, basis: 0n }),
      ],
    });
    const types = run({ state: s, orders: [order({ execAt: NOW - 1 })] }).map((x) => x.type);
    expect(types[0]).toBe("executeOrder");
    expect(types.indexOf("checkpoint")).toBeLessThan(types.indexOf("redeemResolved"));
    expect(types.indexOf("redeemResolved")).toBeLessThan(types.indexOf("split"));
  });
});

describe("planner: partner markets (ADR-008)", () => {
  const P1 = MKT(901);
  const P2 = MKT(902);
  const partnerMarket = (n: number, partner = P1, over: Partial<ReturnType<typeof market>> = {}) =>
    market({
      address: MKT(n),
      registered: false,
      basis: 0n,
      upBal: 0n,
      downBal: 0n,
      partner,
      partnerActive: true,
      partnerCap: USDC(40),
      end: NOW + 3600,
      ...over,
    });
  const withPartners = (markets: ReturnType<typeof market>[], over = {}) =>
    state({
      markets,
      limits: { ...state().limits, marketCount: markets.filter((m) => m.registered).length },
      partners: {
        globalCap: USDC(500),
        fraction: 0.1,
        maxMarkets: 6,
        maxPerPartner: 3,
        registered: 0,
      },
      ...over,
    });
  const splits = (a: Action[]) =>
    of(a, "split").map((x) => (x.type === "split" ? [x.market, x.amount] : null));

  it("splits into a partner market and stops at the partner's cap", () => {
    // target is 5 % of 1000 = 50, the partner cap is 40
    const a = run({ state: withPartners([partnerMarket(11)]) });
    // a market gets a third of the cap (the partner may hold three at once)
    expect(splits(a)).toEqual([[MKT(11), USDC(40) / 3n]]);
  });

  it("counts every market of the same partner against its cap", () => {
    const a = run({
      state: withPartners([
        partnerMarket(11, P1, {
          registered: true,
          basis: USDC(30),
          upBal: USDC(30),
          downBal: USDC(30),
        }),
        partnerMarket(12),
      ]),
    });
    // the registered market is at 30 pairs (target 50, tops up only below half): only the new one
    // can take the 10 left under the 40 cap
    expect(splits(a)).toEqual([[MKT(12), USDC(10)]]);
  });

  it("gives another partner its own cap", () => {
    const a = run({
      state: withPartners([
        partnerMarket(11, P1, {
          registered: true,
          basis: USDC(40),
          upBal: USDC(40),
          downBal: USDC(40),
        }),
        partnerMarket(12, P2),
      ]),
    });
    expect(splits(a)).toEqual([[MKT(12), USDC(40) / 3n]]);
  });

  it("stops at the lower of the registry's global cap and the vault's fraction of NAV", () => {
    // fraction 10 % of 1000 = 100 > global cap 60: the registry cap binds
    const a = run({
      state: withPartners(
        [
          partnerMarket(11, P1, { partnerCap: USDC(400) }),
          partnerMarket(12, P2, { partnerCap: USDC(400) }),
        ],
        {
          partners: {
            globalCap: USDC(60),
            fraction: 0.1,
            maxMarkets: 6,
            maxPerPartner: 3,
            registered: 0,
          },
        },
      ),
    });
    expect(splits(a)).toEqual([
      [MKT(11), USDC(50)], // the target
      [MKT(12), USDC(10)], // what is left under the registry's 60
    ]);
    // global cap 500 > fraction 10 % of 1000 = 100: the vault's fraction binds
    const b = run({
      state: withPartners([
        partnerMarket(11, P1, { partnerCap: USDC(400) }),
        partnerMarket(12, P2, { partnerCap: USDC(400) }),
      ]),
    });
    const total = splits(b).reduce((x, y) => x + Number(y?.[1] ?? 0n), 0);
    expect(total).toBe(Number(USDC(100)));
  });

  it("skips an inactive partner and a vault without a registry", () => {
    expect(
      splits(run({ state: withPartners([partnerMarket(11, P1, { partnerActive: false })]) })),
    ).toEqual([]);
    const noRegistry = state({ markets: [partnerMarket(11)], partners: null });
    expect(splits(run({ state: noRegistry }))).toEqual([]);
  });

  it("respects the partner slots", () => {
    const a = run({
      state: withPartners([partnerMarket(11), partnerMarket(12, P2)], {
        partners: {
          globalCap: USDC(500),
          fraction: 0.3,
          maxMarkets: 6,
          maxPerPartner: 3,
          registered: 6,
        },
      }),
    });
    expect(splits(a)).toEqual([]);
  });

  it("lets the core rounds take liquidity first", () => {
    const core = market({ address: MKT(5), registered: false, basis: 0n, upBal: 0n, downBal: 0n });
    const a = run({
      state: withPartners([partnerMarket(11), core], { freeLiquidity: USDC(60) }),
    });
    expect(splits(a)[0]).toEqual([MKT(5), USDC(50)]);
    expect(splits(a)[1]).toEqual([MKT(11), USDC(10)]);
  });

  it("brings the end price for a partner market that ended, and retries it later", () => {
    const ended = partnerMarket(11, P1, {
      registered: true,
      end: NOW - 5,
      basis: USDC(20),
      upBal: USDC(20),
      downBal: USDC(20),
    });
    const [r] = of(run({ state: withPartners([ended]) }), "resolve");
    expect(r?.type === "resolve" && r.evidence).toEqual({ feed: FEED, end: NOW - 5 });
    // just tried: wait
    const attempts = new Map([[MKT(11).toLowerCase(), NOW - 2]]);
    expect(
      of(run({ state: withPartners([ended]), resolveAttempts: attempts }), "resolve"),
    ).toHaveLength(0);
    // later: again
    const later = new Map([[MKT(11).toLowerCase(), NOW - 20]]);
    expect(
      of(run({ state: withPartners([ended]), resolveAttempts: later }), "resolve"),
    ).toHaveLength(1);
  });

  it("does not send evidence for core rounds, and does not resolve a partner market early", () => {
    const early = partnerMarket(11, P1, {
      registered: true,
      end: NOW + 30,
      basis: USDC(20),
      upBal: USDC(20),
      downBal: USDC(20),
    });
    expect(of(run({ state: withPartners([early]) }), "resolve")).toHaveLength(0);
  });

  it("attaches evidence when a settlement waits for a partner market", () => {
    const ended = partnerMarket(11, P1, {
      registered: true,
      end: NOW - 5,
      basis: USDC(20),
      upBal: USDC(30),
      downBal: USDC(10),
    });
    const s = withPartners([ended], {
      epochs: [
        {
          id: 9,
          end: NOW - 10,
          depositAssets: USDC(10),
          redeemShares: 0n,
          settled: false,
          plan: { feeds: [], unresolved: [MKT(11)] },
        },
      ],
    });
    const r = of(run({ state: s }), "resolve");
    expect(r).toHaveLength(1); // one action for the market, not two
    expect(r[0]?.type === "resolve" && r[0].evidence?.end).toBe(NOW - 5);
  });
});

describe("planner: partner markets, review fixes", () => {
  const P1 = MKT(901);
  const PM = (n: number, over: Partial<ReturnType<typeof market>> = {}) =>
    market({
      address: MKT(n),
      registered: false,
      basis: 0n,
      upBal: 0n,
      downBal: 0n,
      partner: P1,
      partnerActive: true,
      partnerCap: USDC(40),
      end: NOW + 3600,
      ...over,
    });
  const st = (markets: ReturnType<typeof market>[], registeredCount = 0) =>
    state({
      markets,
      limits: { ...state().limits, marketCount: registeredCount },
      partners: {
        globalCap: USDC(500),
        fraction: 0.3,
        maxMarkets: 6,
        maxPerPartner: 3,
        registered: registeredCount,
      },
    });
  const splits = (a: Action[]) =>
    of(a, "split").map((x) => (x.type === "split" ? [x.market, x.amount] : null));

  it("does not fund a strike far from the spot (a typo, a double-scaled number, an attack)", () => {
    const wild = (strike: bigint) => run({ state: st([PM(11, { strike })]) });
    expect(splits(wild(1n * 10n ** 18n))).toEqual([]); // $1 against a $3,000 spot
    expect(splits(wild(10n ** 40n))).toEqual([]); // 1e22 times the spot
    expect(splits(wild(3000n * 10n ** 18n * 6n))).toEqual([]); // 6x
    expect(splits(wild((3000n * 10n ** 18n) / 6n))).toEqual([]); // one sixth
    expect(splits(wild(3200n * 10n ** 18n))).toHaveLength(1); // a normal strike
    expect(splits(wild(3000n * 10n ** 18n * 5n))).toHaveLength(1); // the edge of the band
  });

  it("does not fund anything while the keeper has no spot price for the asset", () => {
    expect(splits(run({ state: st([PM(11)]), spots: new Map() }))).toEqual([]);
  });

  it("splits a partner's cap between its open markets instead of giving it all to the first", () => {
    const a = run({ state: st([PM(11), PM(12), PM(13)]) });
    // 40 / 3 per market, rounded down to whole base units
    const each = USDC(40) / 3n;
    expect(splits(a)).toEqual([
      [MKT(11), each],
      [MKT(12), each],
      [MKT(13), each],
    ]);
  });

  it("never opens a fourth registry slot for one partner", () => {
    const reg = (n: number) =>
      PM(n, { registered: true, basis: USDC(10), upBal: USDC(10), downBal: USDC(10) });
    const a = run({ state: st([reg(11), reg(12), reg(13), PM(14)], 3) });
    expect(splits(a).find((x) => x?.[0] === MKT(14))).toBeUndefined();
  });

  it("merges the pairs of an inactive partner market at once", () => {
    const m = PM(11, {
      registered: true,
      partnerActive: false,
      basis: USDC(30),
      upBal: USDC(30),
      downBal: USDC(30),
      end: NOW + 3600,
    });
    const merges = of(run({ state: st([m], 1) }), "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]?.type === "merge" && merges[0].amount).toBe(USDC(30));
    // an active one keeps its inventory until the final window
    expect(of(run({ state: st([{ ...m, partnerActive: true }], 1) }), "merge")).toHaveLength(0);
  });

  it("resolves a partner market the vault traded in and then emptied", () => {
    const flat = PM(11, { end: NOW - 5, registered: false, basis: USDC(30), cash: USDC(2) });
    const [r] = of(run({ state: st([flat]) }), "resolve");
    expect(r?.type === "resolve" && r.evidence?.end).toBe(NOW - 5);
    // a market the vault never touched is the partner's to resolve, not the keeper's
    const untouched = PM(12, { end: NOW - 5, registered: false, basis: 0n, cash: 0n });
    expect(of(run({ state: st([untouched]) }), "resolve")).toHaveLength(0);
  });
});

describe("keeper reader: partner candidates", () => {
  it("is bounded and has no duplicates", async () => {
    const { limitPartnerCandidates, MAX_PARTNER_CANDIDATES } =
      await import("../../src/chain/vault");
    const many = Array.from({ length: 100 }, (_, i) => MKT(i + 1));
    const out = limitPartnerCandidates([...many, ...many]);
    expect(out).toHaveLength(MAX_PARTNER_CANDIDATES);
    expect(new Set(out).size).toBe(out.length);
  });
});
