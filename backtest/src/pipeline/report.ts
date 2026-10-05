import type { StrategyParams } from "@converge/strategy";
import { DEFAULT_PARAMS, probVolPerRootSec, SECONDS_PER_YEAR } from "@converge/strategy";
import { BASE_FLOW, BASE_VENUE, PESSIMISTIC_FLOW } from "../scenarios";
import { HOLDOUT, TRAIN } from "../tune";
import type { DailyRow } from "../types";
import { DESIGNS, NAV0, SCENARIOS, type Quick } from "./config";
import type { Experiments, Grid } from "./experiments";
import {
  classify,
  classifyWindow,
  type CalibrationRow,
  type Candidate,
  type DataStats,
  type Summary,
  type WindowSummary,
} from "./stages";

type Headline = {
  set: string;
  scenario: string;
  all: WindowSummary;
  train: WindowSummary;
  holdout: WindowSummary;
  byMarket: Record<
    string,
    { rounds: number; pnl: number; edgeNoise: number; edgeInformed: number; residual: number }
  >;
  daily: DailyRow[];
  venue: { quoteUptimePct: number; gasUsdPerDay: number; repostBlocks: number };
  risk: {
    maxDrawdownPct: number;
    peakAtRiskPct: number;
    meanAbsInventoryShares: number;
    p95AbsInventoryShares: number;
  };
  flow: {
    noiseOrders: number;
    noiseOrdersUnfilled: number;
    informedOrders: number;
    informedOrdersTraded: number;
  };
  rounds: { winRatePct: number; stdPnl: number; p5: number; p95: number };
};

export type BasisFile = {
  window: { start: string; end: string };
  feeds: Record<
    string,
    {
      feed: string;
      rounds: number;
      updateGapSec: { p50: number; p95: number; max: number };
      atLagZero: {
        n: number;
        meanBps: number;
        stdBps: number;
        rmsBps: number;
        absP50Bps: number;
        absP99Bps: number;
      };
      bestLag: {
        lagSec: number;
        n: number;
        meanBps: number;
        stdBps: number;
        rmsBps: number;
        absP50Bps: number;
        absP99Bps: number;
      };
    }
  >;
};

type Verdict = {
  per: { pessimistic: WindowSummary; sniper: WindowSummary };
  cls: { pessimistic: string; sniper: string };
  worst: string;
};

export type ReportCtx = {
  quick: boolean;
  manifestSha: string;
  stats: DataStats[];
  calib: CalibrationRow[];
  calibLaunch: CalibrationRow[];
  headlines: Headline[];
  verdicts: { specTuned: Verdict; specDefault: Verdict; propTuned: Verdict };
  exp: Experiments;
  tuned: {
    specified: Candidate;
    proposed: Candidate;
    specifiedAll: { id: string; combined: number; pessimistic: number; sniper: number }[];
    proposedAll: { id: string; combined: number; pessimistic: number; sniper: number }[];
  };
  specTuned: StrategyParams;
  propTuned: StrategyParams;
  sets: { id: string; label: string; params: StrategyParams; design: "specified" | "proposed" }[];
  q: Quick;
  basis: BasisFile | null;
};

const sgn = (x: number) => (x < 0 ? "−" : "+");
const usd = (x: number, d = 0) =>
  `$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const usdS = (x: number, d = 0) => `${sgn(x)}${usd(x, d)}`;
const pct = (x: number, d = 1) => `${x.toFixed(d)}%`;
const word = (c: string) => (c === "PROFITABLE" ? "PROFITABLE UNDER PESSIMISTIC ASSUMPTIONS" : c);
const ci = (c: [number, number]) => `[${usdS(c[0])}, ${usdS(c[1])}]`;
const fmtP = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4))));

function table(head: string[], rows: string[][]): string {
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function gridStats(g: Grid): { pos: number; total: number } {
  const all = g.cells.flat();
  return { pos: all.filter((c) => c.expectedPerDay > 0).length, total: all.length };
}

/** Smallest delay (blocks) from which every larger delay is profitable, per sniper lead (H4). */
function sufficientDelays(g: Grid): string[] {
  return g.ys.map((lead, r) => {
    const row = g.cells[r]!;
    let from = -1;
    for (let c = row.length - 1; c >= 0 && row[c]!.expectedPerDay > 0; c--) from = c;
    return from < 0
      ? `${lead} ms lead: no tested delay is enough`
      : `${lead} ms lead: ≥ ${g.xs[from]} block${g.xs[from] === 1 ? "" : "s"} (${(g.xs[from]! * 0.4).toFixed(1)} s)`;
  });
}

/** Interpolated offered volume at which the expected edge crosses zero (log-linear). */
function breakEven(xs: number[], ys: number[]): number | null {
  for (let i = 1; i < xs.length; i++) {
    if (ys[i - 1]! <= 0 && ys[i]! > 0) {
      const t = -ys[i - 1]! / (ys[i]! - ys[i - 1]!);
      return Math.exp(Math.log(xs[i - 1]!) + t * (Math.log(xs[i]!) - Math.log(xs[i - 1]!)));
    }
  }
  return ys[0]! > 0 ? xs[0]! : null;
}

function breakEvenText(vol: {
  xs: number[];
  rows: { label: string; points: Summary[] }[];
}): string {
  const parts = vol.rows.map((r) => {
    const ys = r.points.map((p) => p.expectedPerDay);
    const be = breakEven(vol.xs, ys);
    if (be === null)
      return `**${r.label}: the expected edge is not positive at any tested volume** (up to $${vol.xs[vol.xs.length - 1]}/h per market).`;
    if (be <= vol.xs[0]! && ys[0]! > 0)
      return `**${r.label}: positive at every tested volume**, down to $${vol.xs[0]}/h per market ($${vol.xs[0]! * 96}/day across the four markets); there is no keeper gas to cover (other costs, such as Data Streams verification fees and keeper infrastructure, are not modelled).`;
    return `**${r.label}: break-even at about $${Math.round(be)}/h per market offered ($${Math.round(be * 96).toLocaleString("en-US")}/day across the four markets);** below it the keeper's gas exceeds spread income.`;
  });
  return parts.join("\n\n");
}

const RATIONALE: Record<string, string> = {
  minHalfSpread:
    "Floor on the half-spread; with the staleness term it sets what a noise taker pays.",
  maxHalfSpread: "Cap: a wider quote would never be accepted by retail flow.",
  volSpreadK:
    "Scales the staleness-risk term φ(d2)·√(stalenessSec/τ) that widens quotes where a digital's gamma is large.",
  stalenessSec:
    "How stale the vault assumes its price to be when it is hit (feeds the term above).",
  inventorySkewMax:
    "Maximum shift of the quote centre against inventory (always < 0.8 × half-spread, so quotes never cross fair value).",
  inventorySkewK: "tanh steepness: how quickly inventory is leaned against.",
  toxicityPullBps: "Quotes are pulled when the price range over the window exceeds this.",
  toxicityWindowSec: "Window of the toxicity range measure.",
  toxicityWidenMax: "Extra half-spread added just below the pull threshold.",
  noQuoteWindowSec: "Final seconds of a round with no quotes: gamma explodes near expiry.",
  priceMin: "CLAUDE.md quote bound.",
  priceMax: "CLAUDE.md quote bound.",
  tick: "1¢ price grid.",
  levels: "Price levels per side.",
  baseRangeTicks: "Ladder span at round start; narrows with √(τ/T).",
  minRangeTicks: "Concentration floor: the ladder never narrows below this.",
  liquidityNavFraction:
    "pm-AMM base liquidity L as a fraction of NAV: the main knob for depth and therefore variance.",
  minLevelSize: "Dust threshold (shares).",
  perMarketMaxFraction: "Worst-case loss allowed in one market, as a fraction of NAV.",
  totalAtRiskMaxFraction: "Worst-case loss allowed across all markets.",
  drawdownBreakerFraction: "Daily NAV drawdown that pauses quoting (never withdrawals).",
  vol: "EWMA volatility estimator (half-life, prior, clamp).",
  refreshTicks:
    "Posting rule for the as-specified design only (the proposed design recomputes every block).",
  maxQuoteAgeBlocks: "As above.",
};

/** Mean of a tail statistic over the 15-minute rows (the rounds where tails matter). */
function tailMean(
  rows: CalibrationRow[],
  tail: "tailLow" | "tailHigh",
  key: "predicted" | "observed",
): number {
  const rs = rows.filter((r) => r.round === "15m");
  let n = 0;
  let sum = 0;
  for (const r of rs) {
    n += r[tail].n;
    sum += r[tail][key] * r[tail].n;
  }
  return n ? sum / n : 0;
}

/** Class of the proposed design under the two verdict scenarios, on each window. */
function windowClasses(c: ReportCtx): string {
  const get = (sc: string, w: "train" | "holdout" | "all") =>
    classifyWindow(c.headlines.find((h) => h.set === "prop-tuned" && h.scenario === sc)![w]);
  return (["train", "holdout", "all"] as const)
    .map(
      (w) =>
        `${w === "holdout" ? "hold-out" : w === "train" ? "training (60 days)" : "all 90 days"}: ${get("pessimistic", w)} (pessimistic) / ${get("sniper", w)} (sniper)`,
    )
    .join("; ");
}

function nearest(xs: number[], v: number): number {
  return xs.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(xs[best]! - v) ? i : best), 0);
}

/** Evidence for the chosen parameters, read from the sweeps (no generic claims). */
function launchRationale(c: ReportCtx, H: (set: string, sc: string) => Headline): string[] {
  const pp = c.propTuned;
  const ex = c.exp;
  const g = (id: string) => ex.grids.find((x) => x.id === id)!;
  const out: string[] = [];
  const hd = H("prop-default", "pessimistic").holdout;
  const ht = H("prop-tuned", "pessimistic").holdout;
  const hs = H("prop-tuned", "sniper").holdout;
  out.push(
    "### Why these values",
    "",
    `The search maximised **expected net edge minus half the daily standard deviation**, with penalties for breaker trips and drawdowns over 12%, jointly under the pessimistic and the sniper scenarios, on the training window only. The result, evaluated on the untouched hold-out:`,
    "",
    table(
      [
        "Parameters (proposed design)",
        "Scenario",
        "Expected edge $/day",
        "σ of daily P&L",
        "Max drawdown (daily)",
        "Breaker-trip days",
      ],
      [
        [
          "CLAUDE.md defaults",
          "Pessimistic",
          usdS(hd.expectedPerDay, 1),
          usd(hd.stdDaily),
          pct(hd.maxDrawdownDailyPct),
          `${hd.breakerTripDays}/${hd.days}`,
        ],
        [
          "Launch parameters",
          "Pessimistic",
          usdS(ht.expectedPerDay, 1),
          usd(ht.stdDaily),
          pct(ht.maxDrawdownDailyPct),
          `${ht.breakerTripDays}/${ht.days}`,
        ],
        [
          "Launch parameters",
          "Sniper, 1 s lead",
          usdS(hs.expectedPerDay, 1),
          usd(hs.stdDaily),
          pct(hs.maxDrawdownDailyPct),
          `${hs.breakerTripDays}/${hs.days}`,
        ],
      ],
    ),
    "",
  );
  // H6: depth x cap
  const h6 = g("H6");
  const ci6 = nearest(h6.xs, pp.liquidityNavFraction);
  const ri6 = nearest(h6.ys, pp.perMarketMaxFraction);
  out.push(
    "**Depth and per-market cap (H6)** are the variance controls. Each cell: expected edge $/day / σ of daily P&L $ / breaker-trip days on the sample.",
    "",
    table(
      ["per-market cap \\ L (fraction of NAV)", ...h6.xs.map(String)],
      h6.ys.map((cap, r) => [
        String(cap),
        ...h6.cells[r]!.map((cell, k) => {
          const txt = `${usdS(cell.expectedPerDay, 0)} / ${usd(cell.stdDaily)} / ${cell.breakerTripDays}`;
          return r === ri6 && k === ci6 ? `**${txt}**` : txt;
        }),
      ]),
    ),
    "",
    (() => {
      const launch = h6.cells[ri6]![ci6]!;
      const deep = h6.cells[h6.ys.length - 1]![h6.xs.length - 1]!;
      const edgeChange =
        launch.expectedPerDay !== 0
          ? (100 * (deep.expectedPerDay - launch.expectedPerDay)) / Math.abs(launch.expectedPerDay)
          : 0;
      return `The launch values (L = ${pp.liquidityNavFraction}, per-market cap = ${pp.perMarketMaxFraction}; bold) give ${usdS(launch.expectedPerDay, 1)}/day with σ ${usd(launch.stdDaily)} and ${launch.breakerTripDays}/${launch.days} breaker-trip days. The deepest cell of the grid (L = ${h6.xs[h6.xs.length - 1]}, cap = ${h6.ys[h6.ys.length - 1]}) gives ${usdS(deep.expectedPerDay, 1)}/day (${edgeChange >= 0 ? "+" : "−"}${Math.abs(edgeChange).toFixed(0)}% vs launch), σ ${usd(deep.stdDaily)} (${(deep.stdDaily / Math.max(1e-9, launch.stdDaily)).toFixed(1)}x) and ${deep.breakerTripDays}/${deep.days} trip days. CLAUDE.md's defaults (L = ${DEFAULT_PARAMS.liquidityNavFraction}, cap = ${DEFAULT_PARAMS.perMarketMaxFraction}) are that corner.`;
    })(),
    "",
  );
  // H2: floor x no-quote
  const h2 = g("H2");
  const ni = nearest(h2.ys, pp.noQuoteWindowSec);
  out.push(
    (() => {
      const row = h2.cells[ni]!;
      const vals = row.map((x) => x.expectedPerDay);
      const best = vals.indexOf(Math.max(...vals));
      return `**Spread floor and no-quote window (H2).** At a ${h2.ys[ni]} s no-quote window the expected edge across half-spread floors ${h2.xs.join(", ")} is ${vals.map((v) => usdS(v, 1)).join(", ")} $/day; the launch floor is ${pp.minHalfSpread} and the window ${pp.noQuoteWindowSec} s. The best floor in that row is ${h2.xs[best]}. The search objective also weighed the sniper scenario and daily variance, so its choice need not match the best floor in this single pessimistic-flow row.`;
    })(),
    "",
  );
  const h3 = g("H3");
  const ti = nearest(h3.xs, pp.toxicityPullBps);
  out.push(
    (() => {
      const row = h3.cells[nearest(h3.ys, 0.2)]!;
      const vals = row.map((x) => x.expectedPerDay);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return `**Toxicity threshold (H3).** At 20% informed arrivals the expected edge across pull thresholds ${h3.xs.join(", ")} bps is ${vals.map((v) => usdS(v, 1)).join(", ")} $/day (range ${usd(Math.max(...vals) - Math.min(...vals), 1)}/day around a mean of ${usdS(mean, 1)}); the launch value is ${pp.toxicityPullBps} bps (column ${ti + 1}).`;
    })(),
    "",
    `**Delay (H4).** From the grid: ${sufficientDelays(g("H4")).join("; ")}. The launch delay is ${DESIGNS.proposed!.venue.execDelayBlocks} blocks (${(DESIGNS.proposed!.venue.execDelayBlocks! * 0.4).toFixed(1)} s), chosen to cover the specification's largest latency (2 s); a longer delay widens the covered lead at the cost of fill time.`,
    "",
    `**Posting parameters** (\`refreshTicks\`, \`maxQuoteAgeBlocks\`) only matter for the as-specified design; the proposed design recomputes every block.`,
    "",
  );
  return out;
}

export function buildReport(c: ReportCtx): string {
  const H = (set: string, sc: string) =>
    c.headlines.find((h) => h.set === set && h.scenario === sc)!;
  const vs = c.verdicts.specTuned;
  const vp = c.verdicts.propTuned;
  const specPess = vs.per.pessimistic;
  const specSnip = vs.per.sniper;
  const propPess = vp.per.pessimistic;
  const propSnip = vp.per.sniper;
  const specAll = c.tuned.specifiedAll;
  const volCurve = c.exp.curves.find((x) => x.id === "volume")!;
  const lowIdx = volCurve.xs.indexOf(25);
  const lowVol = lowIdx >= 0 ? volCurve.rows[0]!.points[lowIdx] : undefined;
  const L: string[] = [];
  const push = (...s: string[]) => L.push(...s);

  const stressS2 = c.exp.stress.find((x) => x.id === "s2")!.summary;
  const stressS3 = c.exp.stress.find((x) => x.id === "s3")!.summary;
  const stressS5 = c.exp.stress.find((x) => x.id === "s5")!.summary;
  const topVerdict =
    `**VERDICT: ${word(vs.worst)}** for the design as specified (ADR-001 Option D: keeper-posted quotes, immediate fills). ` +
    `On the ${HOLDOUT.start} to 2026-10-03 hold-out (an independent restart), with the best parameters the search found, expected net edge is ` +
    `**${usdS(specSnip.expectedPerDay)}/day** against a block-by-block latency sniper with a 1 s information lead and ` +
    `${usdS(specPess.expectedPerDay)}/day under the specification's pessimistic flow (50% informed arrivals, 2 s latency, half the noise volume); ` +
    `drawdown ${pct(H("spec-tuned", "sniper").holdout.maxDrawdownDailyPct)} of NAV and ${H("spec-tuned", "sniper").holdout.breakerTripDays} of ${specSnip.days} days with the circuit breaker tripped under the sniper. ` +
    `*Conditional on:* a trader whose price leads the vault's by 1 s or more, and Binance prices being predictive of what Chainlink Data Streams will show; neither is measured (no Data Streams key).\n\n` +
    `**With the proposed design change (forward-priced execution: an order placed in block *b* is executed at block *b+5*, 2 s later, once, against a book repriced from the canonical report of that block): ${word(vp.worst)} on the hold-out by the rule in section 2.4, but only on that window.** ` +
    `Hold-out expected net edge ${usdS(propPess.expectedPerDay, 1)}/day (pessimistic) and ${usdS(propSnip.expectedPerDay, 1)}/day (sniper); hold-out realized net P&L ${usdS(propPess.netPnl)} / ${usdS(propSnip.netPnl)} (the sniper figure includes ${usd(Math.max(0, propSnip.edgeInformed))} donated by the sniper's own losing orders), and the 95% block-bootstrap CIs of realized P&L *excluding* those gains are ${ci(propPess.totalCi95)} / ${ci(propSnip.totalCi95)} on a ${usd(NAV0)} vault. ` +
    `**Across windows the same rule gives ${windowClasses(c)}** (table in section 3.2), and over all 90 days realized P&L is only about ${Math.round((100 * H("prop-tuned", "pessimistic").all.meanDaily) / Math.max(1e-9, H("prop-tuned", "pessimistic").all.expectedPerDay))}% of the expected edge. ` +
    `**Both verdict scenarios are safe for this design by construction:** the pessimistic scenario's 2 s latency equals the 2 s delay, so informed flow has no edge there and that scenario tests only noise volume and tolerance, and the 1 s sniper is below the delay. ` +
    `**It is not robust:** at a 2 s lead (zero margin) the vault still earns ${usdS(stressS2.expectedPerDay, 1)}/day, but at a 3 s lead it makes ${usdS(stressS3.expectedPerDay, 1)}/day, and if execution timing is *not* forced (a sniper that picks its block) it makes ${usdS(stressS5.expectedPerDay, 1)}/day even at a 1 s lead (section 4; those rows use a ${Math.ceil(90 / c.exp.window.stride)}-day sample, every ${c.exp.window.stride}th day of the 90, and are partly in-sample).`;

  push(
    "# Phase 3 report: does the vault make money from spreads with zero incentives?",
    "",
    topVerdict,
    "",
    c.quick
      ? "> **QUICK RUN: this is a smoke test of the pipeline on reduced windows, not a result.**\n"
      : "",
    "## Summary",
    "",
    `- **What was run.** ${c.stats[0]!.days} days of 1-second Binance BTC and ETH prices (${TRAIN.start} to 2026-10-03; ${c.stats[0]!.days - 1} evaluation days plus one volatility warm-up day), the production round rules (strike at the open, UP iff end ≥ strike, ties UP), 15-minute and 1-hour rounds, the **same \`generateQuotes\` code the keeper will run**, re-quoted every 400 ms block. Search on the first 60 days; the last 30 days were never seen by the search.`,
    `- **The fair-value model is sound in the middle and over-confident in the tails.** On 90 days of real rounds, rounds the model puts below 10% happen ${pct(100 * tailMean(c.calib, "tailLow", "observed"), 1)} of the time against ${pct(100 * tailMean(c.calib, "tailLow", "predicted"), 1)} predicted (BTC and ETH 15m, averaged over horizons); above 90%, ${pct(100 * tailMean(c.calib, "tailHigh", "observed"), 1)} against ${pct(100 * tailMean(c.calib, "tailHigh", "predicted"), 1)}. The strategy therefore carries a volatility multiplier, set from calibration on the **training window only** (pooled log-loss optimum ${c.propTuned.vol.scale}; not searched, because the expected-edge objective cannot see model error). With it, the same tails are ${pct(100 * tailMean(c.calibLaunch, "tailLow", "observed"), 1)} observed vs ${pct(100 * tailMean(c.calibLaunch, "tailLow", "predicted"), 1)} predicted below 10% and ${pct(100 * tailMean(c.calibLaunch, "tailHigh", "observed"), 1)} vs ${pct(100 * tailMean(c.calibLaunch, "tailHigh", "predicted"), 1)} above 90%. A tail error of several points of probability is the same size as the spreads, so it matters, and a gap remains at the launch multiplier in BTC (see the table in section 1); the check on the whole strategy is the outcome residual (section 3.3).`,
    `- **Latency, not spread, decides viability.** Against a bot that sees the price one 1-second bar earlier than the vault and checks the book on every block, the as-specified vault loses ${usd(Math.abs(specSnip.edgeInformed / specSnip.days))}/day to adverse selection on the hold-out. The vault is quoting ${pct(H("spec-tuned", "sniper").venue.quoteUptimePct, 0)} of the time and the breaker tripped on ${H("spec-tuned", "sniper").holdout.breakerTripDays} of ${specSnip.days} hold-out days, yet spread income is only ${usd(specSnip.edgeNoise / specSnip.days)}/day against that loss. Of the ${specAll.length} parameter sets screened for this design, ${specAll.filter((x) => x.sniper > 0).length} had a positive expected edge under the sniper (best ${usdS(Math.max(...specAll.map((x) => x.sniper)), 1)}/day); wider spreads cannot cover a one-second gap on a 15-minute digital (see section 4).`,
    `- **Forward pricing neutralises the sniper.** Filling an order two seconds after it is placed, against a book repriced from newer data, removes the information edge of any trader whose lead is shorter than the delay. The heatmap of delay vs lead (H4) shows the boundary.`,
    `- **Earnings are limited by taker flow, not by TVL.** On the hold-out, if retail takers offer the pessimistic ${usd(PESSIMISTIC_FLOW.noiseUsdPerHourPerMarket * 24 * 4)}/day of volume, the proposed ${usd(NAV0)} vault's expected edge is ${usdS(propPess.expectedPerDay, 1)}/day (${pct(propPess.expectedApyPct, 0)} APY); at ${usd(25 * 24 * 4)}/day it is ${lowVol ? `${usdS(lowVol.expectedPerDay, 1)}/day (${pct(lowVol.expectedApyPct, 0)} APY)` : "n/a"}. Return per dollar falls as TVL grows (TVL table). **The volume is an assumption (no users yet)**, so the break-even offered volume is reported instead of a headline APY.`,
    `- **Variance is the real risk.** Outcome luck has zero mean but its standard deviation is ${usd(propPess.stdDaily)}/day against an expected edge of ${usd(propPess.expectedPerDay, 1)}/day, so a 30-day window can look good or bad by chance (the CIs above).`,
    "",
    "## How to reproduce",
    "",
    "```bash",
    "pnpm install",
    "pnpm --filter @converge/backtest backtest:data   # download and verify the Binance archives (about 370 MB)",
    "pnpm backtest                                    # regenerates this report, results.json, charts and config/strategy.default.json",
    "```",
    "",
    `Seeds are fixed; running \`pnpm backtest\` twice produces byte-identical \`results.json\` (CI check: \`make check-3\`). Data pinned by manifest SHA-256 \`${c.manifestSha}\`.`,
    "",
    "## 1. Data",
    "",
    table(
      [
        "Asset",
        "Source",
        "Resolution",
        "Days",
        "Samples",
        "Missing",
        "Price range",
        "Realized vol (annualized)",
      ],
      c.stats.map((s) => [
        s.asset,
        s.source,
        `${s.stepSec} s`,
        String(s.days),
        s.samples.toLocaleString("en-US"),
        s.missingSamples.toLocaleString("en-US"),
        `${s.minPrice.toPrecision(5)} to ${s.maxPrice.toPrecision(5)}`,
        pct(s.annualizedVolPct, 0),
      ]),
    ),
    "",
    "- **Source and license.** Binance Data Collection, public daily kline archives at https://data.binance.vision (no key). Every archive was verified against the SHA-256 that Binance publishes next to it, and the hashes are pinned in `backtest/data/manifest.json`. The data are public and free to download under Binance's terms (https://www.binance.com/en/terms); only derived close prices are used, and the raw archives are git-ignored.",
    `- **Timing convention.** A bar's close is the price *at the bar's end*, so \`px[k]\` only contains information available at time k. Strike = the bar at the boundary second; resolution = the bar at the end second; ties resolve UP. Missing seconds (${c.stats.map((s) => `${s.asset}: ${s.missingSamples}`).join(", ")}) are forward-filled.`,
    "- **BTC and ETH only.** They use 1-second spot data. **MON is excluded from the economic backtest:** Binance has no MON spot market, so the only history is the USDⓈ-M perpetual at 1-minute resolution (shown above), which cannot support latency or informed-flow modelling at a 400 ms block time, and MON resolves through a Chainlink push-feed round proof (ADR-002) that has no relation to Binance perpetual prints. Its volatility is reported for context only.",
    "- **Chainlink Data Streams history was not used** (it needs an API key and secret we do not have; blocker in `docs/EXTERNAL.md`). Binance is a proxy. The Chainlink *push-feed* history on Monad was read to measure the basis and the cadence (next subsection).",
    "",
    ...(c.basis
      ? [
          "### Chainlink push feeds vs Binance (basis and lag)",
          "",
          `For each on-chain update of the Chainlink BTC/USD and ETH/USD push feeds on Monad mainnet (${c.basis.window.start} to ${c.basis.window.end}; read round by round through Multicall3, \`backtest/data/chainlink-basis.json\`), the feed's answer is compared with the Binance price at the same instant and at the lag that best aligns the two.`,
          "",
          table(
            [
              "Feed",
              "Rounds",
              "Update gap p50 / p95 / max (s)",
              "Basis at lag 0: mean / σ / abs p99 (bps)",
              "Best-aligned lag (s)",
              "Basis at best lag: σ / abs p99 (bps)",
            ],
            Object.entries(c.basis.feeds).map(([k, f]) => [
              k,
              f.rounds.toLocaleString("en-US"),
              `${f.updateGapSec.p50} / ${f.updateGapSec.p95} / ${f.updateGapSec.max}`,
              `${f.atLagZero.meanBps.toFixed(2)} / ${f.atLagZero.stdBps.toFixed(2)} / ${f.atLagZero.absP99Bps.toFixed(1)}`,
              String(f.bestLag.lagSec),
              `${f.bestLag.stdBps.toFixed(2)} / ${f.bestLag.absP99Bps.toFixed(1)}`,
            ]),
          ),
          "",
          `Two readings. (1) **Basis.** The feeds sit a roughly constant ${Math.abs(Object.values(c.basis.feeds)[0]!.atLagZero.meanBps).toFixed(1)} bps from Binance's USDT-quoted price (consistent with a USDT/USD offset; not verified here), with only about ${Object.values(c.basis.feeds)[0]!.atLagZero.stdBps.toFixed(1)} bps of jitter around it. If the offset is constant it cancels when the strike and the end price are compared, so using Binance would add only that jitter to outcomes and no systematic bias against the vault. Caveat: the comparison is taken at push-update instants, when the feed is by construction freshly synced, so it describes accuracy at update time, not the error between updates. (2) **Staleness.** Aligning the series by lag barely improves the match (the best lag is ${Object.values(c.basis.feeds)[0]!.bestLag.lagSec} s and the error falls by under 1%), so a fixed lag is not resolvable against the basis noise. What limits a push feed is its **update cadence**: BTC updates have a median gap of ${Object.values(c.basis.feeds)[0]!.updateGapSec.p50} s and a 95th percentile of ${Object.values(c.basis.feeds)[0]!.updateGapSec.p95} s (ETH: ${Object.values(c.basis.feeds)[1]!.updateGapSec.p50} s and ${Object.values(c.basis.feeds)[1]!.updateGapSec.p95} s). A vault priced from a push feed alone would trail a trader watching Binance by tens of seconds, far more than the 2 s execution delay of the proposed design, so that design needs a low-latency source (Data Streams). **Its Binance-to-Streams lead is exactly what this backtest cannot measure without an API key.**`,
          "",
        ]
      : [
          "### Chainlink push feeds vs Binance",
          "",
          "Not run (`backtest/data/chainlink-basis.json` is absent): `pnpm --filter @converge/backtest backtest:chainlink` needs an archive-capable Monad RPC.",
          "",
        ]),
    "### Calibration of the fair-probability model",
    "",
    "Independent of any trading: the vault's fair probability (EWMA volatility with a 30-minute half-life, `fairProbUp`) against what actually happened, on every real round.",
    "",
    table(
      [
        "Asset",
        "Round",
        "Seconds before expiry",
        "Rounds",
        "Mean predicted P(UP)",
        "Observed UP freq.",
        "Brier",
        "Brier of a coin flip",
      ],
      c.calib.map((r) => [
        r.asset,
        r.round,
        String(r.tauSec),
        String(r.n),
        r.meanP.toFixed(4),
        r.freqUp.toFixed(4),
        r.brier.toFixed(4),
        r.brierBaseline.toFixed(4),
      ]),
    ),
    "",
    "![calibration](charts/calibration.png)",
    "",
    "**Tails and the best volatility multiplier.** The means above are about one half for any model, so the informative check is the tails. Rounds the model puts below 10% or above 90%, predicted vs observed, at the default volatility (multiplier 1) and at the launch multiplier; and the multiplier that minimises log loss on these rounds.",
    "",
    table(
      [
        "Asset",
        "Round",
        "Seconds left",
        "Below 10%: predicted / observed (n)",
        "Above 90%: predicted / observed (n)",
        `Launch ×${c.propTuned.vol.scale}: below 10% / above 90% (observed vs predicted)`,
        "Log-loss-optimal ×",
      ],
      c.calib.map((r, i) => {
        const l = c.calibLaunch[i]!;
        return [
          r.asset,
          r.round,
          String(r.tauSec),
          `${pct(100 * r.tailLow.predicted)} / ${pct(100 * r.tailLow.observed)} (${r.tailLow.n})`,
          `${pct(100 * r.tailHigh.predicted)} / ${pct(100 * r.tailHigh.observed)} (${r.tailHigh.n})`,
          `${pct(100 * l.tailLow.observed)} vs ${pct(100 * l.tailLow.predicted)} / ${pct(100 * l.tailHigh.observed)} vs ${pct(100 * l.tailHigh.predicted)}`,
          String(r.optimalScale),
        ];
      }),
    ),
    "",
    "Real prices have fat tails, so a stated 3% happens more often than 3%. The multiplier widens the distribution to compensate; it is one of the searched parameters, and a model-free check on the whole strategy is the **outcome residual** in section 3.3 (zero mean if calibrated; its t-statistic is reported).",
    "",
  );

  // ---------------- model
  push(
    "## 2. Model and assumptions",
    "",
    "Every assumption below is a parameter in `backtest/src/scenarios.ts`; the ones that move the answer most are swept in section 5.",
    "",
    "### 2.1 The strategy (`packages/strategy`, shared with the keeper)",
    "",
    "- **Fair value:** p = N(d2), d2 = (ln(S/K) − ½σ²τ)/(σ√τ), clamped to [1e-6, 1−1e-6]; EWMA volatility on log returns, time-aware, so 1 s and 1 m sampling annualize identically.",
    '- **Liquidity:** the dynamic pm-AMM schedule L_t = L·√(T−t) (Paradigm, *pm-AMM: A Uniform AMM for Prediction Markets*, Nov 2024, https://www.paradigm.xyz/2024/11/pm-amm, section "Dynamic pm-AMM", subsection "Constant LVR"). Depth of each ladder level is the pm-AMM reserve change L_t·|Φ⁻¹(p₁) − Φ⁻¹(p₀)| over a band of fixed width. The quoted range narrows with √(τ/T) down to a concentration floor.',
    "- **Quotes:** half-spread = max(floor, k·φ(d2)·√(staleness/τ)) + toxicity widening; inventory skew by tanh of net exposure; no-quote window; bounds [0.02, 0.98]; per-market and total at-risk caps; daily drawdown breaker. DOWN is quoted by complement. Property tests assert: never crossed, always inside the bounds, never through fair value, sizes shrink toward expiry, the floor is respected.",
    "",
    "### 2.2 The venue and the flow",
    "",
    table(
      ["Assumption", "Value", "Why / where it is swept"],
      [
        ["Block time", "400 ms", "Monad (CLAUDE.md)."],
        [
          "Rounds",
          "BTC and ETH, 15 m (96/day) and 1 h (24/day)",
          "Wedge product. Rounds open 30 s after the boundary; the strike is the boundary price.",
        ],
        [
          "Price information",
          "Sample-and-hold 1 s bars. The vault sees the bar from `latencyMs` ago, informed traders the current bar",
          "No interpolation, so nothing uses a bar before it closes. The block grid is offset by 100 ms so bar-edge alignment is unbiased.",
        ],
        [
          "Posting (as specified)",
          "Takers hit the last *posted* book. The keeper re-posts when the best quote moves ≥ N ticks, after any fill, or after 25-200 blocks; each post costs gas",
          "ADR-001 Option D. Levels that were filled stay empty until the next post.",
        ],
        [
          "Gas",
          `${BASE_VENUE.gasBase.toLocaleString("en-US")} + ${BASE_VENUE.gasPerMarket.toLocaleString("en-US")} per market per batched update, ${BASE_VENUE.gasPriceGwei} gwei, MON $${BASE_VENUE.monUsd}`,
          'ADR-001 estimated 67-107k excluding report verification and on-chain ln/√/Φ and said "realistic 2-3x"; this is about 2-3x. Monad bills the gas limit.',
        ],
        [
          "Fees",
          "No taker fee, no redeem fee (conservative)",
          "A taker fee only deters informed flow; redeem fee swept (curve in section 5).",
        ],
        [
          "Noise takers",
          `Poisson arrivals, random side, lognormal size (median $${BASE_FLOW.noiseSizeMedianUsd}, σ ${BASE_FLOW.noiseSizeSigma}); offered volume $${BASE_FLOW.noiseUsdPerHourPerMarket}/h per market (base), $${PESSIMISTIC_FLOW.noiseUsdPerHourPerMarket}/h (pessimistic)`,
          "**Unknown until we have users; swept over 10 to 1,000 $/h.**",
        ],
        [
          "Elasticity",
          `Each noise order draws a maximum acceptable cost from an exponential with mean ${pct(BASE_FLOW.noiseToleranceMean * 100, 0)} (base) / ${pct(PESSIMISTIC_FLOW.noiseToleranceMean * 100, 0)} (pessimistic) of notional and stops walking the book when a level costs more`,
          "Without this, flow is inelastic and the best spread is infinite. **An assumption, swept** (tolerance curve).",
        ],
        [
          "Informed takers (arrivals)",
          `Share of taker arrivals: ${pct(BASE_FLOW.informedShare * 100, 0)} base, ${pct(PESSIMISTIC_FLOW.informedShare * 100, 0)} pessimistic. They see the current bar (the vault sees one from \`latencyMs\` ago, ${BASE_FLOW.latencyMs} ms base, ${PESSIMISTIC_FLOW.latencyMs} ms pessimistic), compute fair value, and take every level whose net edge exceeds ${BASE_FLOW.informedEdgeThreshold * 100}¢, sized to take the available depth`,
          'Matches the specification ("informed traders trade whenever the edge exceeds their threshold"). Swept 0-50% × 100-2000 ms.',
        ],
        [
          "Informed takers (sniper)",
          "A bot checks the book on every block with the same rule",
          "The adversary that exists wherever a public price feed leads the vault. Not in the specification; **added because it is what a real market contains.**",
        ],
        ["Same-block ordering", "Informed orders before noise orders", "Worst case for the vault."],
        [
          "Vault inputs",
          "Price from `latencyMs` ago; EWMA σ; its own position",
          "Nothing newer than t − latency is used. Verified by a test that rewrites all prices after a cutoff and requires every earlier fill to be identical.",
        ],
        [
          "Start capital",
          `${usd(NAV0)} (CLAUDE.md launch TVL cap)`,
          "Depth and caps scale with NAV; flow does not (TVL table).",
        ],
        [
          "Risk limits",
          "Per-market loss ≤ 5% of NAV (default), total ≤ 40%, daily drawdown breaker 5%",
          "CLAUDE.md defaults; the tuned values are in section 6.",
        ],
      ],
    ),
    "",
    "### 2.3 P&L accounting (exact)",
    "",
    "Each fill splits into **edge** against the fair value at the instant of the fill and an **outcome residual**: for a vault sale of u shares at price a with fair value p, edge = u(a − p) and residual = u(p − 1{UP}); they sum exactly to the settlement P&L u(a − 1{UP}) (unit-tested to 1e-6). Over many rounds the residual has zero mean if the model is calibrated (the t-statistics in sections 3.2 and 3.3 check this, and they are not all above −2), so the **expected net edge** = spread capture (noise flow) + adverse selection (informed flow) − gas − fees is the quantity the vault earns in expectation. Realized P&L adds the residual, a pure variance term.\n\n**Informed traders' wins are not counted.** If informed flow loses money to the vault (which a rational informed trader would stop doing), that income is *excluded* from the expected edge; their losses *to* informed flow are counted in full (expected edge uses min(0, informed edge) over the window). Realized P&L shows what the simulation actually produced, wins included. In the proposed design this matters: a sniper's limit orders fill only when the market has moved against them, so the raw informed line is positive for the vault, and it is deliberately not credited.",
    "",
    "### 2.4 Method and verdict rule",
    "",
    `1. The search sees only ${TRAIN.start} to ${TRAIN.end} (60 days). ${HOLDOUT.start} to 2026-10-03 (30 days) is reported out of sample as an **independent restart** with a fresh $5,000 NAV; only the parameter search and the volatility multiplier's value were restricted to the training window. The scenarios, the proposed design, its 2 s delay and the idea of a multiplier were chosen after seeing training-window results, and the calibration table that motivates the multiplier includes hold-out rounds.`,
    "2. **What was and was not fixed in advance.** The pessimistic scenario (the specification's definition) and the verdict rule were set before any hold-out number was read. The **sniper scenario and the forward-priced design were not in the original plan**: they were developed after exploring training-window results, in response to what those showed. Treat the verdict as conditional on the scenarios chosen, not as a pre-registered test.",
    "3. For each design the search draws random parameter sets from a fixed grid (and mutates the best), scores each on the pessimistic and the sniper scenario with *expected net edge − 0.5 × daily standard deviation − penalties for breaker trips and drawdowns above 12%*, then confirms the finalists on all 60 training days. Both designs get the same budget and objective.",
    "4. **Verdict = the worst of two scenarios on the hold-out**: the specification's pessimistic flow, and the sniper with a 1 s lead. Per scenario: expected net edge ≤ 0 → UNPROFITABLE; expected edge > 0 and the 95% **moving-block** bootstrap CIs (5-day blocks, so volatility clustering is respected) of *both* the expected edge and the realized P&L excluding informed gains above 0 → PROFITABLE UNDER PESSIMISTIC ASSUMPTIONS; otherwise MARGINAL. The proposed design's verdict also depends on stress cases (section 4) that the rule does not include and that it fails.",
    "",
  );

  // ---------------- results
  push("## 3. Results", "", "### 3.1 Scenarios", "");
  push(
    table(
      ["Scenario", "Noise $/h/market", "Cost tolerance", "Informed", "Latency / lead"],
      Object.entries(SCENARIOS).map(([, s]) => [
        s.label,
        String(s.flow.noiseUsdPerHourPerMarket),
        pct(s.flow.noiseToleranceMean * 100, 0),
        s.flow.informedMode === "sniper"
          ? "sniper (every block)"
          : pct(s.flow.informedShare * 100, 0) + " of arrivals",
        `${s.flow.latencyMs} ms`,
      ]),
    ),
    "",
    "### 3.2 Headline: hold-out window (out of sample, 30 days, independent restart)",
    "",
  );
  const rows: string[][] = [];
  for (const s of c.sets) {
    for (const sc of Object.keys(SCENARIOS)) {
      const h = H(s.id, sc);
      const w = h.holdout;
      rows.push([
        s.label,
        SCENARIOS[sc]!.label,
        usdS(w.expectedPerDay, 1),
        `[${usdS(w.expectedPerDayCi95[0], 0)}, ${usdS(w.expectedPerDayCi95[1], 0)}]`,
        usdS(w.netPnl),
        ci(w.totalCi95),
        w.sharpe.toFixed(1),
        pct(w.maxDrawdownDailyPct),
        `${w.breakerTripDays}/${w.days}`,
        classifyWindow(w),
      ]);
    }
  }
  push(
    table(
      [
        "Parameters / design",
        "Scenario",
        "Expected net edge $/day",
        "95% CI of expected edge ($/day)",
        "Realized net P&L",
        "95% CI of realized, excl. informed gains",
        "Daily Sharpe (ann.)",
        "Max drawdown (daily, % of starting NAV)",
        "Breaker-trip days",
        "Class",
      ],
      rows,
    ),
    "",
    "Expected edge is what the vault earns on average; realized P&L adds outcome luck. A negative expected edge is a loss whatever the luck. *Realized net P&L* includes whatever informed traders donated to the vault (a sniper's resting orders can fill against it); the CI deliberately excludes those gains, so the realized figure can lie outside its own CI. Drawdown is of the cumulative daily P&L as a share of the starting NAV and can exceed 100% when donations inflate the equity curve. Rows labelled *as specified* use ADR-001 Option D unchanged. All amounts are dollars on a $5,000 vault.",
    "",
    "**The same rule on every window** (proposed design, launch parameters, and the specified design's best parameters; the training window is where the parameters were searched, so it is in-sample for the search but not for the verdict question):",
    "",
    table(
      [
        "Design / scenario",
        "Window",
        "Days",
        "Expected edge $/day (95% CI)",
        "Realized net P&L $/day",
        "Realized t-stat",
        "Outcome residual t-stat",
        "Class",
      ],
      (["spec-tuned", "prop-tuned"] as const).flatMap((set) =>
        (["pessimistic", "sniper"] as const).flatMap((sc) =>
          (["train", "holdout", "all"] as const).map((w) => {
            const x = H(set, sc)[w];
            const t = x.stdDaily > 0 ? x.meanDaily / (x.stdDaily / Math.sqrt(x.days)) : 0;
            return [
              `${set === "spec-tuned" ? "Specified" : "Proposed"} / ${SCENARIOS[sc]!.label}`,
              w === "holdout" ? "hold-out" : w === "train" ? "training" : "all 90",
              String(x.days),
              `${usdS(x.expectedPerDay, 1)} [${usdS(x.expectedPerDayCi95[0], 0)}, ${usdS(x.expectedPerDayCi95[1], 0)}]`,
              usdS(x.meanDaily, 1),
              t.toFixed(1),
              x.residualT.toFixed(1),
              classifyWindow(x),
            ];
          }),
        ),
      ),
    ),
    "",
    "Realized net P&L is about half of the expected edge over the full 90 days for the proposed design, and the residual t-statistic is below −2 in some training-window cells (the same alarm threshold as above): the outcome residual is a real, partly unexplained drag, not zero-mean noise, and the expected edge probably overstates what a live vault would earn. The hold-out window is the most favourable of the three.",
    "",
    "![cumulative proposed](charts/cumulative_proposed.png)",
    "",
    "![cumulative specified](charts/cumulative_specified.png)",
    "",
    "### 3.3 Decomposition and risk (hold-out)",
    "",
    "![decomposition](charts/decomposition.png)",
    "",
  );
  const dr: string[][] = [];
  for (const [id, sc] of [
    ["prop-tuned", "base"],
    ["prop-tuned", "pessimistic"],
    ["prop-tuned", "sniper"],
    ["spec-tuned", "pessimistic"],
    ["spec-tuned", "sniper"],
  ] as const) {
    const h = H(id, sc);
    dr.push([
      `${id === "prop-tuned" ? "Proposed" : "Specified"} / ${SCENARIOS[sc]!.label}`,
      usdS(h.holdout.edgeNoise / h.holdout.days, 1),
      usdS(h.holdout.edgeInformed / h.holdout.days, 1),
      usdS(-h.holdout.gasUsd / h.holdout.days, 1),
      `${usdS(h.holdout.residual / h.holdout.days)} (t = ${h.holdout.residualT.toFixed(1)})`,
      usd(h.holdout.stdDaily),
      pct(h.venue.quoteUptimePct, 0),
      `${h.risk.meanAbsInventoryShares.toFixed(0)} / ${h.risk.p95AbsInventoryShares.toFixed(0)}`,
      `${pct(h.risk.peakAtRiskPct, 1)}`,
    ]);
  }
  push(
    table(
      [
        "Run",
        "Spread capture $/day",
        "Adverse selection $/day",
        "Gas $/day",
        "Outcome residual $/day (t-stat)",
        "σ of daily P&L",
        "Quote uptime",
        "Inventory at expiry mean / p95 (shares)",
        "Peak at-risk (% NAV)",
      ],
      dr,
    ),
    "",
    "Quote uptime and inventory are over all 90 days of the run. The outcome residual should have zero mean if the fair-value model is calibrated, so it is the model-free check on the whole strategy: a t-statistic well below −2 would mean the expected edge is overstated. It is also the reason a short window can disagree with the expected edge.",
    "",
    "### 3.4 P&L by market (proposed, pessimistic, all 90 days)",
    "",
    table(
      ["Market", "Rounds", "Net P&L", "Spread capture", "Adverse selection", "Outcome residual"],
      Object.entries(H("prop-tuned", "pessimistic").byMarket).map(([k, v]) => [
        k,
        String(v.rounds),
        usdS(v.pnl),
        usdS(v.edgeNoise),
        usdS(v.edgeInformed),
        usdS(v.residual),
      ]),
    ),
    "",
    `Outcome residual over all 90 days, proposed design: pessimistic ${usdS(H("prop-tuned", "pessimistic").all.residualPerDay, 1)}/day (t = ${H("prop-tuned", "pessimistic").all.residualT.toFixed(1)}), base ${usdS(H("prop-tuned", "base").all.residualPerDay, 1)}/day (t = ${H("prop-tuned", "base").all.residualT.toFixed(1)}). A t-statistic below −2 would indicate that the model flatters the expected edge; the 15-minute markets' residuals above are the ones to watch.`,
    "",
    `Over all 90 days the proposed design earns ${usdS(H("prop-tuned", "pessimistic").all.expectedPerDay, 1)}/day expected edge in the pessimistic scenario and ${usdS(H("prop-tuned", "base").all.expectedPerDay, 1)}/day in the base scenario (hold-out alone: ${usdS(propPess.expectedPerDay, 1)} and ${usdS(H("prop-tuned", "base").holdout.expectedPerDay, 1)}).`,
    "",
    "![daily pnl](charts/daily_pnl_proposed.png)",
    "",
  );

  // ---------------- pessimistic & design changes
  const ex = c.exp;
  push(
    "## 4. The pessimistic case and the design changes",
    "",
    `The pessimistic flow of the specification (50% informed arrivals, 2 s latency, half the noise volume) is only just survivable by the as-specified design, with small, slow, wide quotes (expected ${usdS(specPess.expectedPerDay, 1)}/day on the hold-out: effectively break-even). What kills it is the sniper. The table evaluates each candidate fix on the same sample of ${Math.ceil(90 / ex.window.stride)} days (every ${ex.window.stride}th day of the 90) (a descriptive comparison, not a selection).`,
    "",
    table(
      [
        "Design",
        "Pessimistic $/day",
        "Class",
        "Sniper $/day",
        "Class",
        "Sniper breaker-trip days",
        "Sniper quote uptime",
      ],
      ex.designTable.map((d) => [
        d.id === "d6" ? "+ tiny depth (pm-AMM L = 1% of NAV, per-market cap 0.5%)" : d.label,
        usdS(d.pessimistic.expectedPerDay, 1),
        classify(d.pessimistic),
        usdS(d.sniper.expectedPerDay, 1),
        classify(d.sniper),
        `${d.sniper.breakerTripDays}/${d.sniper.days}`,
        pct(d.sniper.uptimePct, 0),
      ]),
    ),
    "",
    ...(() => {
      const st = c.specTuned;
      const already: string[] = [];
      if (st.minHalfSpread >= 0.1) already.push(`a half-spread floor of ${st.minHalfSpread}`);
      if (st.noQuoteWindowSec >= 600) already.push(`a ${st.noQuoteWindowSec} s no-quote window`);
      return already.length
        ? [
            `*Note:* the as-specified tuned parameters already include ${already.join(" and ")}, so the rows that add those are the baseline repeated (or nearly so), not independent evidence. The claim that parameter-level changes do not fix the sniper result rests mainly on the search itself: ${c.tuned.specifiedAll.length} parameter sets screened, ${c.tuned.specifiedAll.filter((x) => x.sniper > 0).length} with a positive expected edge under the sniper.`,
            "",
          ]
        : [];
    })(),
    ...(() => {
      const param = ex.designTable.filter((d) => ["d2", "d3", "d4", "d5", "d6"].includes(d.id));
      const worked = param.filter((d) => d.sniper.expectedPerDay > 0);
      const gamma = [600, 300, 120].map((tau) => ({
        tau,
        cents:
          100 *
          probVolPerRootSec({
            spot: 100,
            strike: 100,
            sigma: 0.5,
            tauYears: tau / SECONDS_PER_YEAR,
          }),
      }));
      const delayRows = ex.designTable.filter((d) => ["d7", "d8", "d9"].includes(d.id));
      return [
        worked.length === 0
          ? `- **Wider floors, 1h-only, mid-round-only quoting, an LP-side taker fee and tiny depth do not fix it**: none of these ${param.length} changes makes the sniper result positive (${param.map((d) => usdS(d.sniper.expectedPerDay, 0)).join(", ")} $/day). They change how much the vault loses, or how fast the circuit breaker stops it, but not the sign. The reason is arithmetic: the fair probability of a digital moves \`φ(d2)/√τ\` per √second of price movement, independent of volatility: at the money that is ${gamma.map((g) => `${g.cents.toFixed(1)}¢ at ${g.tau} s`).join(", ")} before expiry per one-second standard deviation, so a one-second information gap makes a stale quote wrong by several cents on most blocks, while retail takers accept half-spreads of only a few cents.`
          : `- **Parameter-level changes**: ${worked.map((d) => d.label).join("; ")} turned the sniper result positive (${worked.map((d) => usdS(d.sniper.expectedPerDay, 0)).join(", ")} $/day); the rest did not (${param
              .filter((d) => !worked.includes(d))
              .map((d) => usdS(d.sniper.expectedPerDay, 0))
              .join(", ")} $/day).`,
        `- **Forward-priced execution**: ${delayRows.map((d) => `${d.label} gives ${usdS(d.sniper.expectedPerDay, 0)}/day against the sniper`).join("; ")}. The fill price then uses data newer than the information the taker acted on; a trader's lead is only useful while the book lags it, and once the delay exceeds the lead the book already contains what they knew. The cost is a two-step swap (place, then fill 2 s later) and a contract that prices from an attached oracle report at execution; both are Phase 4 work and are listed under Needs from Nisarg.`,
      ];
    })(),
    "",
  );
  push(
    "### Robustness of the proposed design",
    "",
    `The proposed design is profitable against the 1 s sniper only because the sniper's lead is shorter than the 2 s delay. Same launch parameters, base noise volume, sample of ${Math.ceil(90 / ex.window.stride)} days:`,
    "",
    table(
      [
        "Case",
        "Expected net edge $/day",
        "Informed edge (raw) $/day",
        "Class",
        "Breaker-trip days",
      ],
      ex.stress.map((r) => [
        r.label,
        usdS(r.summary.expectedPerDay, 1),
        usdS(r.summary.edgeInformed / r.summary.days, 1),
        classify(r.summary),
        `${r.summary.breakerTripDays}/${r.summary.days}`,
      ]),
    ),
    "",
    '- **Zero margin at a 2 s lead.** At lead = delay the sniper\'s limit orders essentially never fill, so "sniper edge 0" is true by construction, not a measured robustness. A lead above the delay (3 s) breaks it, and the lead is **unmeasured** (no Data Streams key).',
    "- **Execution must be forced.** The simulator executes an order once, at its block, and drops it if it does not fill. If the executor can choose the block or the report (ADR-004 now forbids this: single execution at block *b+n* against the canonical report of that block, no cancellation), a sniper that waits for a favourable moment re-creates the lead and the design loses (the *timing-option* rows).",
    `- **Griefing and gas.** A sniper placing an order on every block costs the vault's executor gas for each execution. In the sniper scenario ${ex.stress[0]!.summary.informedOrdersPlaced.toLocaleString("en-US")} informed orders were placed over ${ex.stress[0]!.summary.days} days (${Math.round(ex.stress[0]!.summary.informedOrdersPlaced / ex.stress[0]!.summary.days).toLocaleString("en-US")}/day); at ${BASE_VENUE.gasPerFill.toLocaleString("en-US")} gas each that would be about ${usd((ex.stress[0]!.summary.informedOrdersPlaced / ex.stress[0]!.summary.days) * BASE_VENUE.gasPerFill * BASE_VENUE.gasPriceGwei * 1e-9 * BASE_VENUE.monUsd)}/day if the vault paid. The simulation charges gas only for orders that fill; **the design therefore requires the taker to prepay execution gas with the order** (ADR-004).`,
    "",
  );
  const [h1, h5, h4] = ["H1", "H5", "H4"].map((id) => ex.grids.find((g) => g.id === id)!);
  push(
    "## 5. Sensitivity",
    "",
    `Each cell is expected net edge in $/day (blue = profit, orange = loss) on a sample of ${Math.ceil(90 / ex.window.stride)} days (every ${ex.window.stride}th day of the 90).`,
    "",
    `### H4: execution delay vs sniper information lead (the design boundary)`,
    "",
    "![H4](charts/heatmap_H4.png)",
    "",
    `Sufficient delay for the vault to be profitable at every larger delay: ${sufficientDelays(h4!).join("; ")}.`,
    "",
    "### H1 and H5: informed share × latency (the specification's axes)",
    "",
    "![H1](charts/heatmap_H1.png)",
    "",
    "![H5](charts/heatmap_H5.png)",
    "",
    `Proposed design: ${gridStats(h1!).pos} of ${gridStats(h1!).total} cells profitable; as specified (its best parameters): ${gridStats(h5!).pos} of ${gridStats(h5!).total}. Latencies of 100 ms and below are not resolved by 1-second bars on a 400 ms grid (see Limitations).`,
    "",
    "### H2: minimum half-spread × no-quote window",
    "",
    "![H2](charts/heatmap_H2.png)",
    "",
    "### H3: toxicity threshold × informed share",
    "",
    "![H3](charts/heatmap_H3.png)",
    "",
  );
  const vol = ex.curves.find((x) => x.id === "volume")!;
  const tvl = ex.curves.find((x) => x.id === "tvl")!;
  const tol = ex.curves.find((x) => x.id === "tolerance")!;
  const red = ex.curves.find((x) => x.id === "redeem")!;
  push(
    "### Noise volume: the break-even",
    "",
    "![volume](charts/curve_volume.png)",
    "",
    table(
      [
        "Offered noise volume ($/h/market)",
        "Offered ($/day, 4 markets)",
        "Filled ($/day)",
        "Expected edge $/day",
        "Net P&L $/day (realized sample)",
      ],
      vol.xs.map((x, i) => {
        const p = vol.rows[0]!.points[i]!;
        return [
          String(x),
          usd(x * 24 * 4),
          usd(p.noiseVolumeUsd / p.days),
          usdS(p.expectedPerDay, 1),
          usdS(p.netPnl / p.days, 1),
        ];
      }),
    ),
    "",
    breakEvenText(vol),
    "",
    "### LP return by TVL",
    "",
    "![tvl](charts/curve_tvl.png)",
    "",
    table(
      [
        "TVL",
        "Pessimistic: expected edge $/day",
        "Pessimistic: expected APY",
        "Base: expected edge $/day",
        "Base: expected APY",
      ],
      tvl.xs.map((x, i) => [
        usd(x),
        usdS(tvl.rows[0]!.points[i]!.expectedPerDay, 1),
        pct(tvl.rows[0]!.points[i]!.expectedApyPct, 1),
        usdS(tvl.rows[1]!.points[i]!.expectedPerDay, 1),
        pct(tvl.rows[1]!.points[i]!.expectedApyPct, 1),
      ]),
    ),
    "",
    "Taker flow is held fixed while TVL grows, so earnings are flow-limited and the return per dollar falls: **APY figures are only meaningful together with the volume assumption**, and a vault much larger than the flow can use earns almost nothing per dollar. Expected APY here ignores the variance in section 3.",
    "",
    "### Noise elasticity and redemption fee",
    "",
    "![tolerance](charts/curve_tolerance.png)",
    "",
    table(
      ["Mean acceptable cost", "Expected edge $/day"],
      tol.xs.map((x, i) => [
        x >= 1 ? "inelastic" : pct(x * 100, 0),
        usdS(tol.rows[0]!.points[i]!.expectedPerDay, 1),
      ]),
    ),
    "",
    table(
      ["redeemFeeBps", "Expected edge $/day"],
      red.xs.map((x, i) => [String(x), usdS(red.rows[0]!.points[i]!.expectedPerDay, 1)]),
    ),
    "",
  );

  // ---------------- launch params
  const pp = c.propTuned;
  const keys = Object.keys(DEFAULT_PARAMS).filter((k) => k !== "vol") as (keyof StrategyParams)[];
  push(
    "## 6. Launch parameters and rationale",
    "",
    `Written to \`config/strategy.default.json\` for the **forward-priced execution design** (delay 5 blocks), which is **Proposed (ADR-004), not accepted**. For ADR-001 as written (keeper-posted, immediate fills) no parameter set survives the sniper, so no launch configuration is written for it; the best parameters found are the *as specified, tuned* rows in section 3.2 and the search log. The tuned risk caps (per-market ${pp.perMarketMaxFraction}, total ${pp.totalAtRiskMaxFraction}) are tighter than CLAUDE.md's defaults (0.05 and 0.4), which the specification allows (tunable, to be set by the Phase 3 backtest). Chosen by the search on the training window under the pessimistic and the sniper scenarios, then confirmed on the hold-out; candidates were scored on risk-adjusted expected edge, not on the best case.`,
    "",
    table(
      ["Parameter", "CLAUDE.md default", "Launch value", "Role"],
      keys.map((k) => [
        `\`${k}\``,
        fmtP(DEFAULT_PARAMS[k] as number),
        fmtP(pp[k] as number),
        RATIONALE[k] ?? "",
      ]),
    ),
    "",
    `Volatility estimator: half-life ${pp.vol.halfLifeSec} s, prior ${pp.vol.priorAnnualVol}, clamp [${pp.vol.minAnnualVol}, ${pp.vol.maxAnnualVol}] (not searched), **scale ${pp.vol.scale}** (fat-tail multiplier chosen by pooled log loss on the training window; CLAUDE.md default 1).`,
    "",
    ...launchRationale(c, H),
    "",
    `Search budget: ${c.q.screenN} random draws plus mutations of the best two per design, screened on a ${c.q.trainStride}-day stride of the training window; the top ${c.q.topK} re-run on all 60 training days. With 14 parameters and one regime this can over-fit; the hold-out and the sensitivity grids are the check, and Phase 5 should re-tune on live data.`,
    "",
    "## 7. Limitations",
    "",
    "1. **Taker flow is synthetic.** Noise volume, order size and price elasticity are assumptions (swept, with a break-even), not measurements. There are no users yet. Real retail flow is autocorrelated, directional and event-driven; random-side Poisson flow is the friendliest possible case for the vault's inventory risk.",
    "2. **Binance is a proxy for Chainlink.** BTC/ETH resolve on Data Streams reports. The Binance-to-Streams lead (the quantity that sets the sniper's edge) is **unmeasured**: it needs a Data Streams key (Needs from Nisarg). The proposed design's 2 s delay is justified against the leads tested, not against a measured one.",
    "3. **1-second bars.** Price is sample-and-hold, so information arrives in 1-second jumps. Latencies below about 250 ms are not resolved (a 100 ms lead is invisible on most blocks), and the intra-second path is unknown, which understates sub-second volatility.",
    `4. **One regime, two assets, and a quiet one.** 90 days (2026-07-06 to 2026-10-03) of BTC and ETH, the two most liquid assets. Realized volatility over the window was only ${pct(c.stats[0]!.annualizedVolPct, 0)} for BTC and ${pct(c.stats[1]!.annualizedVolPct, 0)} for ETH, below the ~50% that ADR-002 assumed for BTC; a more volatile regime means larger one-second moves and more adverse selection. Other regimes (a crash, a quiet month) and MON are not covered; MON was excluded for lack of 1 s data. Smaller assets were not tested and would likely do worse.`,
    "5. **The hold-out is a single 30-day period** and the bootstrap resamples 5-day blocks of days (so volatility clustering is respected within a block, not across blocks). Parameter search over 14 dimensions can over-fit the training window.",
    "6. **Not modelled:** oracle failures and voided (INVALID, 0.5) rounds; keeper downtime, reorgs and transaction failures; MEV and gas auctions; competing LPs and venues (takers have only this venue); opportunity cost of capital; the on-chain gas of computing N(d2) per swap in the proposed design (Phase 4 must measure it); the UX effect of a 2 s fill on noise volume.",
    "7. **Informed traders are simple:** they use the vault's own volatility and fair-value model with fresher price. Real adversaries use better models, can split orders and can collude.",
    "8. **Fees:** the ADR-002 protocol fee on swaps is not credited to LPs (conservative); an LP-side fee is shown only as a design change.",
    "9. **Expected edge vs realized P&L.** The headline expectations assume the fair-value model stays calibrated; its tails are mildly over-confident (Calibration).",
    "",
    "10. **The sniper is a Binance sniper.** One-second returns are heavy-tailed, and the sniper's biggest fills come from single-bar jumps of 10 cents or more in fair probability. A jump that appears on Binance but not in Data Streams would be no edge in production, so the sniper may be overstated; equally, a sniper with a better feed than Binance would be understated. The sign of the as-specified result holds across everything tested in the simulation; its size in production is unknown.",
    "11. **The information lead is a constant** in every scenario. A real lead is a distribution with heavy tails (feed hiccups, congestion). The design table and heatmap H4 show how fast the proposed design fails when the lead exceeds the delay.",
    "12. **MON is a third of the wedge** (BTC, ETH, MON) and is not covered: no 1-second history exists, and it resolves differently (ADR-002). Its realized volatility over the window was far higher than BTC's (section 1), so it would be a harder market to make.",
    "13. **Costs not modelled in the proposed design:** Data Streams verification fees, keeper infrastructure, gas for failed or griefing executions (requires taker-prepaid gas), and any volume lost to the 2 s fill. The comparison between the designs assumes equal noise volume.",
    "14. **APY figures** are expected edge divided by TVL under assumed volumes; they exclude informed gains and outcome variance and are sensitivities to the volume assumption, not forecasts.",
    "",
    "## 8. Files",
    "",
    "- `backtest/report/results.json`: every number in this report; `backtest/report/tuning.json`: the parameter search.",
    "- `backtest/report/charts/*.png`; `backtest/data/manifest.json`: pinned data hashes.",
    "- `config/strategy.default.json`: launch parameters.",
    "",
  );
  return L.join("\n");
}
