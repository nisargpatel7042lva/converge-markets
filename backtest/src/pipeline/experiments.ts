import { DEFAULT_PARAMS, type StrategyParams } from "@converge/strategy";
import { runCells, type Cell } from "../pool";
import { PESSIMISTIC_FLOW, BASE_FLOW } from "../scenarios";
import { TRAIN, HOLDOUT } from "../tune";
import type { FlowConfig, VenueConfig } from "../types";
import { DESIGNS, NAV0, SCENARIOS, type Quick } from "./config";
import { cellFor, summarize, type Summary, type Window } from "./stages";

export type Grid = {
  id: string;
  title: string;
  xLabel: string;
  yLabel: string;
  xs: number[];
  ys: number[];
  /** cells[row][col] = Summary at (xs[col], ys[row]). */
  cells: Summary[][];
  note: string;
};

export type Curve = {
  id: string;
  title: string;
  xLabel: string;
  xs: number[];
  rows: { label: string; points: Summary[] }[];
};

export type DesignRow = {
  id: string;
  label: string;
  pessimistic: Summary;
  sniper: Summary;
};

export type StressRow = { id: string; label: string; summary: Summary };

export type Experiments = {
  window: { start: string; end: string; stride: number };
  stress: StressRow[];
  grids: Grid[];
  curves: Curve[];
  designTable: DesignRow[];
};

export type Ctx = {
  specTuned: StrategyParams;
  propTuned: StrategyParams;
  q: Quick;
  log: (m: string) => void;
};

type Tagged = { tag: string; cell: Cell };

/** Everything here is descriptive sensitivity over the whole 90 days, subsampled by day stride. */
export async function runExperiments(ctx: Ctx): Promise<Experiments> {
  const { q, log } = ctx;
  const W: Window = { start: TRAIN.start, end: HOLDOUT.end, stride: q.sweepStride, offset: 2 };
  const prop = DESIGNS.proposed!.venue;
  const spec = DESIGNS.specified!.venue;
  const tagged: Tagged[] = [];
  const add = (
    tag: string,
    params: StrategyParams,
    flow: FlowConfig,
    venue: Partial<VenueConfig>,
    extra: { nav0?: number; durations?: number[] } = {},
  ) => tagged.push({ tag, cell: cellFor(tag, params, flow, venue, W, extra) });

  const inf = (share: number, lead: number): FlowConfig => ({
    ...PESSIMISTIC_FLOW,
    informedShare: share,
    latencyMs: lead,
  });
  const sniperAt = (lead: number, base: FlowConfig = BASE_FLOW): FlowConfig => ({
    ...base,
    informedMode: "sniper",
    sniperPresence: 1,
    latencyMs: lead,
  });

  // --- H1: informed share x latency (Poisson arrivals), proposed design
  const shares = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const leads = [100, 250, 500, 1000, 1500, 2000];
  for (const l of leads)
    for (const s of shares) add(`H1|${s}|${l}`, ctx.propTuned, inf(s, l), prop);
  // --- H5: the same grid for the design as specified (its tuned parameters)
  for (const l of leads)
    for (const s of shares) add(`H5|${s}|${l}`, ctx.specTuned, inf(s, l), spec);
  // --- H2: min spread x no-quote window (pessimistic flow), proposed design
  const floors = [0.01, 0.02, 0.03, 0.05, 0.08];
  const nqs = [30, 60, 120, 240, 480];
  for (const nq of nqs)
    for (const h of floors)
      add(
        `H2|${h}|${nq}`,
        {
          ...ctx.propTuned,
          minHalfSpread: h,
          maxHalfSpread: Math.max(0.2, h),
          noQuoteWindowSec: nq,
        },
        PESSIMISTIC_FLOW,
        prop,
      );
  // --- H3: toxicity threshold x informed share
  const tox = [6, 10, 15, 25, 50, 100];
  const shares3 = [0, 0.1, 0.2, 0.35, 0.5];
  for (const s of shares3)
    for (const t of tox)
      add(`H3|${t}|${s}`, { ...ctx.propTuned, toxicityPullBps: t }, inf(s, 1000), prop);
  // --- H4: execution delay x sniper lead, proposed pricing mode
  const delays = [0, 1, 2, 3, 5, 8];
  const leads4 = [250, 500, 1000, 2000, 3000];
  for (const l of leads4)
    for (const d of delays)
      add(`H4|${d}|${l}`, ctx.propTuned, sniperAt(l), { ...prop, execDelayBlocks: d });

  // --- H6: pm-AMM depth x per-market loss cap (the variance controls), pessimistic flow
  const liqs = [0.03, 0.06, 0.12, 0.25, 0.5];
  const caps = [0.01, 0.02, 0.035, 0.05];
  for (const cap of caps)
    for (const liq of liqs)
      add(
        `H6|${liq}|${cap}`,
        {
          ...ctx.propTuned,
          liquidityNavFraction: liq,
          perMarketMaxFraction: cap,
          totalAtRiskMaxFraction: Math.min(0.4, 8 * cap),
        },
        PESSIMISTIC_FLOW,
        prop,
      );

  // --- curves (pessimistic informed flow unless noted)
  const vols = [10, 25, 50, 125, 250, 500, 1000];
  for (const v of vols)
    add(`C-vol|${v}`, ctx.propTuned, { ...PESSIMISTIC_FLOW, noiseUsdPerHourPerMarket: v }, prop);
  for (const v of vols)
    add(
      `C-vol-spec|${v}`,
      ctx.specTuned,
      { ...PESSIMISTIC_FLOW, noiseUsdPerHourPerMarket: v },
      spec,
    );
  const tvls = [1000, 5000, 25_000, 100_000];
  for (const n of tvls) {
    add(`C-tvl-pess|${n}`, ctx.propTuned, PESSIMISTIC_FLOW, prop, { nav0: n });
    add(`C-tvl-base|${n}`, ctx.propTuned, BASE_FLOW, prop, { nav0: n });
  }
  const tols = [0.02, 0.04, 0.06, 0.1, Infinity];
  for (const t of tols)
    add(`C-tol|${t}`, ctx.propTuned, { ...PESSIMISTIC_FLOW, noiseToleranceMean: t }, prop);
  const redeem = [0, 25, 100];
  for (const r of redeem)
    add(`C-redeem|${r}`, ctx.propTuned, PESSIMISTIC_FLOW, { ...prop, redeemFeeBps: r });

  // --- design-change table: each change vs the pessimistic and the sniper scenario
  const rows: {
    id: string;
    label: string;
    params: StrategyParams;
    venue: Partial<VenueConfig>;
    durations?: number[];
  }[] = [
    { id: "d0", label: "As specified, CLAUDE.md defaults", params: DEFAULT_PARAMS, venue: spec },
    { id: "d1", label: "As specified, tuned parameters", params: ctx.specTuned, venue: spec },
    {
      id: "d2",
      label: "+ much wider floor (half-spread ≥ 10¢, 5x staleness term)",
      params: { ...ctx.specTuned, minHalfSpread: 0.1, maxHalfSpread: 0.3, volSpreadK: 5 },
      venue: spec,
    },
    { id: "d3", label: "+ 1h markets only", params: ctx.specTuned, venue: spec, durations: [3600] },
    {
      id: "d4",
      label: "+ quote only mid-round (no quotes in the last 600 s)",
      params: { ...ctx.specTuned, noQuoteWindowSec: 600 },
      venue: spec,
    },
    {
      id: "d5",
      label: "+ 1% taker fee paid to LPs",
      params: ctx.specTuned,
      venue: { ...spec, takerFeeBps: 100, feeToLp: true },
    },
    {
      id: "d6",
      label: "+ tiny depth (0.5% of NAV, 0.5% per-market cap)",
      params: {
        ...ctx.specTuned,
        liquidityNavFraction: 0.01,
        perMarketMaxFraction: 0.005,
        totalAtRiskMaxFraction: 0.04,
      },
      venue: spec,
    },
    {
      id: "d7",
      label: "Swap-time pricing, immediate fills",
      params: ctx.propTuned,
      venue: { ...prop, execDelayBlocks: 0 },
    },
    {
      id: "d8",
      label: "+ forward-priced execution, 2 blocks (0.8 s)",
      params: ctx.propTuned,
      venue: { ...prop, execDelayBlocks: 2 },
    },
    {
      id: "d9",
      label: "+ forward-priced execution, 5 blocks (2.0 s)",
      params: ctx.propTuned,
      venue: prop,
    },
  ];
  for (const r of rows) {
    add(
      `D|${r.id}|pess`,
      r.params,
      SCENARIOS.pessimistic!.flow,
      r.venue,
      r.durations ? { durations: r.durations } : {},
    );
    add(
      `D|${r.id}|snip`,
      r.params,
      SCENARIOS.sniper!.flow,
      r.venue,
      r.durations ? { durations: r.durations } : {},
    );
  }

  // --- stress of the proposed design: leads at or above the delay, and the timing-option sniper
  const stress: { id: string; label: string; lead: number; window: number; delay: number }[] = [
    { id: "s1", label: "Sniper, 1 s lead (the verdict scenario)", lead: 1000, window: 0, delay: 5 },
    {
      id: "s2",
      label: "Sniper, 2 s lead (equal to the delay: zero margin)",
      lead: 2000,
      window: 0,
      delay: 5,
    },
    { id: "s3", label: "Sniper, 3 s lead (above the delay)", lead: 3000, window: 0, delay: 5 },
    {
      id: "s4",
      label: "Sniper, 3 s lead, delay 8 blocks (3.2 s)",
      lead: 3000,
      window: 0,
      delay: 8,
    },
    {
      id: "s5",
      label: "Timing-option sniper, 1 s lead (execution not forced)",
      lead: 1000,
      window: 25,
      delay: 5,
    },
    {
      id: "s6",
      label: "Timing-option sniper, 2 s lead (execution not forced)",
      lead: 2000,
      window: 25,
      delay: 5,
    },
  ];
  for (const r of stress)
    add(`X|${r.id}`, ctx.propTuned, sniperAt(r.lead), {
      ...prop,
      execDelayBlocks: r.delay,
      execWindowBlocks: r.window,
    });

  log(`experiments: ${tagged.length} cells on ${W.stride}-day stride`);
  const rs = await runCells(
    tagged.map((t) => t.cell),
    undefined,
    { onProgress: (d, t) => d % 20 === 0 && log(`  experiments: ${d}/${t}`) },
  );
  const get = new Map<string, Summary>();
  tagged.forEach((t, i) => get.set(t.tag, summarize(rs[i]!, parseNav(t.tag))));
  const S = (tag: string) => get.get(tag)!;

  const grid = (
    id: string,
    title: string,
    xLabel: string,
    yLabel: string,
    xs: number[],
    ys: number[],
    key: (x: number, y: number) => string,
    note: string,
  ): Grid => ({
    id,
    title,
    xLabel,
    yLabel,
    xs,
    ys,
    cells: ys.map((y) => xs.map((x) => S(key(x, y)))),
    note,
  });

  const grids: Grid[] = [
    grid(
      "H1",
      "Proposed design: expected net edge ($/day) vs informed share and latency",
      "informed share of arrivals",
      "latency (ms)",
      shares,
      leads,
      (x, y) => `H1|${x}|${y}`,
      "Pessimistic noise volume; Poisson informed arrivals.",
    ),
    grid(
      "H5",
      "As specified: expected net edge ($/day) vs informed share and latency",
      "informed share of arrivals",
      "latency (ms)",
      shares,
      leads,
      (x, y) => `H5|${x}|${y}`,
      "Same flow as H1, keeper-posted quotes with immediate fills.",
    ),
    grid(
      "H2",
      "Proposed design: expected net edge ($/day) vs minimum half-spread and no-quote window",
      "minimum half-spread",
      "no-quote window (s)",
      floors,
      nqs,
      (x, y) => `H2|${x}|${y}`,
      "Pessimistic flow.",
    ),
    grid(
      "H3",
      "Proposed design: expected net edge ($/day) vs toxicity threshold and informed share",
      "toxicity pull threshold (bps / 5 s)",
      "informed share of arrivals",
      tox,
      shares3,
      (x, y) => `H3|${x}|${y}`,
      "Noise volume as pessimistic, 1 s latency.",
    ),
    grid(
      "H6",
      "Proposed design: expected net edge ($/day) vs pm-AMM depth and per-market loss cap",
      "pm-AMM liquidity L (fraction of NAV)",
      "per-market loss cap (fraction of NAV)",
      liqs,
      caps,
      (x, y) => `H6|${x}|${y}`,
      "Pessimistic flow. Total at-risk cap = 8x the per-market cap (at most 40%).",
    ),
    grid(
      "H4",
      "Expected net edge ($/day) vs execution delay and sniper lead",
      "execution delay (blocks of 400 ms)",
      "sniper information lead (ms)",
      delays,
      leads4,
      (x, y) => `H4|${x}|${y}`,
      "A sniper checks every block; base noise volume; breaker active.",
    ),
  ];
  const curve = (
    id: string,
    title: string,
    xLabel: string,
    xs: number[],
    rowsDef: { label: string; key: (x: number) => string }[],
  ): Curve => ({
    id,
    title,
    xLabel,
    xs,
    rows: rowsDef.map((r) => ({ label: r.label, points: xs.map((x) => S(r.key(x))) })),
  });
  const curves: Curve[] = [
    curve(
      "volume",
      "Expected net edge vs noise volume",
      "noise taker volume offered ($ per hour per market)",
      vols,
      [
        { label: "Proposed design", key: (x) => `C-vol|${x}` },
        { label: "As specified (tuned)", key: (x) => `C-vol-spec|${x}` },
      ],
    ),
    curve("tvl", "Expected edge vs TVL (flow held fixed)", "TVL ($)", tvls, [
      { label: "Pessimistic", key: (x) => `C-tvl-pess|${x}` },
      { label: "Base", key: (x) => `C-tvl-base|${x}` },
    ]),
    curve(
      "tolerance",
      "Expected net edge vs noise-taker cost tolerance",
      "mean maximum acceptable cost (fraction of notional)",
      tols.map((t) => (Number.isFinite(t) ? t : 1)),
      [
        {
          label: "Pessimistic informed flow (1 = inelastic)",
          key: (x) => `C-tol|${x >= 1 ? Infinity : x}`,
        },
      ],
    ),
    curve("redeem", "Expected net edge vs redemption fee", "redeemFeeBps", redeem, [
      { label: "Pessimistic", key: (x) => `C-redeem|${x}` },
    ]),
  ];
  const designTable: DesignRow[] = rows.map((r) => ({
    id: r.id,
    label: r.label,
    pessimistic: S(`D|${r.id}|pess`),
    sniper: S(`D|${r.id}|snip`),
  }));
  const stressRows: StressRow[] = stress.map((r) => ({
    id: r.id,
    label: r.label,
    summary: S(`X|${r.id}`),
  }));
  return {
    window: { start: W.start, end: W.end, stride: W.stride },
    stress: stressRows,
    grids,
    curves,
    designTable,
  };
}

/** C-tvl cells carry their NAV in the tag; everything else uses the launch NAV. */
function parseNav(tag: string): number {
  const m = /^C-tvl-(?:pess|base)\|(\d+)$/.exec(tag);
  return m ? Number(m[1]) : NAV0;
}
