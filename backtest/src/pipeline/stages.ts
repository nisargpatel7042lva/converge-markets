import {
  EwmaVol,
  fairProbUp,
  SECONDS_PER_YEAR,
  DEFAULT_PARAMS,
  type StrategyParams,
} from "@converge/strategy";
import { loadSeries, readManifest, SOURCES, WINDOW } from "../data/binance";
import { loadSeriesCached } from "../data/cache";
import { runCells, type Cell } from "../pool";
import { Rng } from "../rng";
import { END_EXCLUSIVE, makeConfig } from "../scenarios";
import { HOLDOUT, TRAIN, mutate, sampleParams, scoreRun, type Score } from "../tune";
import type { FlowConfig, RunResult, SimConfig, VenueConfig } from "../types";
import { DESIGNS, NAV0, SCENARIOS, type Quick } from "./config";

export type Window = { start: string; end: string; stride: number; offset: number };

export function cellFor(
  name: string,
  params: StrategyParams,
  flow: FlowConfig,
  venue: Partial<VenueConfig>,
  w: Window,
  extra: { nav0?: number; slim?: boolean; durations?: number[] } = {},
): Cell {
  return {
    name,
    slim: extra.slim ?? true,
    cfg: makeConfig({
      params,
      flow,
      venue,
      nav0: extra.nav0 ?? NAV0,
      startDay: w.start,
      endDay: w.end,
      dayStride: w.stride,
      dayOffset: w.offset,
      ...(extra.durations ? { durations: extra.durations } : {}),
    }),
  };
}

/** Compact summary of a run for the JSON report. */
export type Summary = {
  days: number;
  rounds: number;
  netPnl: number;
  expectedNetEdge: number;
  expectedPerDay: number;
  expectedPerDayCi95: [number, number];
  informedOrdersPlaced: number;
  edgeNoise: number;
  edgeInformed: number;
  residual: number;
  gasUsd: number;
  feeIncome: number;
  redeemFees: number;
  noiseVolumeUsd: number;
  informedVolumeUsd: number;
  fillsNoise: number;
  fillsInformed: number;
  sharpe: number;
  stdDaily: number;
  profitableDaysPct: number;
  meanDailyCi95: [number, number];
  totalCi95: [number, number];
  maxDrawdownPct: number;
  breakerTripDays: number;
  uptimePct: number;
  gasPctNavPerDay: number;
  apySimplePct: number;
  expectedApyPct: number;
  meanAbsInventory: number;
  peakAtRiskPct: number;
};

export function summarize(r: RunResult, nav0 = NAV0): Summary {
  const days = Math.max(1, r.days);
  // Informed traders' gains are not counted as income (a rational one would stop): the counted
  // informed edge is the sum over days of min(0, that day's informed edge).
  const edge =
    r.pnl.edgeNoise + r.pnl.edgeInformedCounted + r.pnl.feeIncome - r.pnl.gasUsd - r.pnl.redeemFees;
  return {
    days: r.days,
    rounds: r.rounds,
    netPnl: r.pnl.total,
    expectedNetEdge: edge,
    expectedPerDay: edge / days,
    expectedPerDayCi95: r.returns.expectedPerDayCi95,
    informedOrdersPlaced: r.flow.informedOrdersPlaced,
    edgeNoise: r.pnl.edgeNoise,
    edgeInformed: r.pnl.edgeInformed,
    residual: r.pnl.residual,
    gasUsd: r.pnl.gasUsd,
    feeIncome: r.pnl.feeIncome,
    redeemFees: r.pnl.redeemFees,
    noiseVolumeUsd: r.flow.noiseVolumeUsd,
    informedVolumeUsd: r.flow.informedVolumeUsd,
    fillsNoise: r.flow.noiseFills,
    fillsInformed: r.flow.informedFills,
    sharpe: r.returns.sharpeDaily,
    stdDaily: r.returns.stdDailyPnl,
    profitableDaysPct: r.returns.profitableDaysPct,
    meanDailyCi95: r.returns.meanDailyPnlCi95,
    totalCi95: r.returns.totalPnlCi95,
    maxDrawdownPct: r.risk.maxDrawdownPct,
    breakerTripDays: r.risk.breakerTripDays,
    uptimePct: r.venue.quoteUptimePct,
    gasPctNavPerDay: r.venue.gasPctNavPerDay,
    apySimplePct: r.returns.apySimplePct,
    expectedApyPct: ((edge / days) * 365 * 100) / nav0,
    meanAbsInventory: r.risk.meanAbsInventoryShares,
    peakAtRiskPct: r.risk.peakAtRiskPct,
  };
}

/**
 * Classifies one scenario result (the rule is in the report's Method section): UNPROFITABLE if the
 * expected net edge is not positive; PROFITABLE if the 95% block-bootstrap intervals of BOTH the
 * expected edge and the realized P&L (excluding informed gains) are above zero; else MARGINAL.
 */
export function classify(s: Summary): "PROFITABLE" | "MARGINAL" | "UNPROFITABLE" {
  if (s.expectedPerDay <= 0) return "UNPROFITABLE";
  return s.expectedPerDayCi95[0] > 0 && s.meanDailyCi95[0] > 0 ? "PROFITABLE" : "MARGINAL";
}

// ------------------------------------------------------------------ data diagnostics

export type DataStats = {
  asset: string;
  source: string;
  stepSec: number;
  days: number;
  samples: number;
  missingSamples: number;
  firstPrice: number;
  lastPrice: number;
  minPrice: number;
  maxPrice: number;
  annualizedVolPct: number;
  worst1sMovesBps: number[];
};

export function dataStats(): DataStats[] {
  const out: DataStats[] = [];
  for (const label of Object.keys(SOURCES)) {
    const { series, stats } = loadSeries(label);
    const px = series.px;
    let min = Infinity;
    let max = -Infinity;
    let sumsq = 0;
    let n = 0;
    const moves: number[] = [];
    for (let i = 1; i < px.length; i++) {
      const v = px[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
      const r = Math.log(v / px[i - 1]!);
      sumsq += r * r;
      n++;
      if (series.stepSec === 1 && Math.abs(r) > 0.0015) moves.push(Math.abs(r) * 1e4);
    }
    const src = SOURCES[label]!;
    out.push({
      asset: label,
      source: `Binance ${src.venue === "spot" ? "spot" : "USDⓈ-M perpetual"} ${src.symbol} ${src.interval} klines`,
      stepSec: series.stepSec,
      days: stats.days,
      samples: stats.samples,
      missingSamples: stats.missingSamples,
      firstPrice: px[0]!,
      lastPrice: px[px.length - 1]!,
      minPrice: min,
      maxPrice: max,
      annualizedVolPct: 100 * Math.sqrt((sumsq / n) * (SECONDS_PER_YEAR / series.stepSec)),
      worst1sMovesBps: moves.sort((a, b) => b - a).slice(0, 5),
    });
  }
  return out;
}

export type CalibrationRow = {
  asset: string;
  round: string;
  tauSec: number;
  /** The volatility multiplier (vol.scale) the probabilities were computed with. */
  scale: number;
  n: number;
  meanP: number;
  freqUp: number;
  brier: number;
  brierBaseline: number;
  logLoss: number;
  bins: { p: number; freq: number; n: number }[];
  /** Tails: rounds the model put below 10% / above 90%, with the observed frequencies. */
  tailLow: { n: number; predicted: number; observed: number };
  tailHigh: { n: number; predicted: number; observed: number };
  /** The multiplier on σ that minimises log loss on these rounds (grid 0.8..1.8), and its log loss. */
  optimalScale: number;
  logLossAtOptimal: number;
};

/**
 * Reliability of the fair-probability model + EWMA vol on real rounds, with no trading involved.
 * `scale` is the volatility multiplier (the strategy's vol.scale) applied to the estimator.
 */
export function calibration(scale = 1): CalibrationRow[] {
  const rows: CalibrationRow[] = [];
  for (const label of ["BTC/USD", "ETH/USD"]) {
    const s = loadSeriesCached(label);
    const vol = new EwmaVol({ ...DEFAULT_PARAMS.vol, scale: 1 });
    const n = s.px.length;
    const sig = new Float64Array(n); // unscaled σ̂
    for (let k = 0; k < n; k++) {
      vol.update(s.px[k]!, s.t0 + k);
      sig[k] = vol.annualVol;
    }
    for (const dur of [900, 3600]) {
      const taus = dur === 900 ? [600, 300, 120] : [1800, 600, 120];
      for (const tau of taus) {
        const spots: number[] = [];
        const strikes: number[] = [];
        const sigmas: number[] = [];
        const ups: number[] = [];
        for (let start = s.t0 + 86_400; start + dur < s.t0 + n - 1; start += dur) {
          const ks = start - s.t0;
          const ke = ks + dur;
          const kt = ke - tau;
          spots.push(s.px[kt]!);
          strikes.push(s.px[ks]!);
          sigmas.push(sig[kt]!);
          ups.push(s.px[ke]! >= s.px[ks]! ? 1 : 0);
        }
        const probs = (m: number) =>
          spots.map((sp, i) => fairProbUp(sp, strikes[i]!, sigmas[i]! * m, tau / SECONDS_PER_YEAR));
        const logLossOf = (ps: number[]) =>
          ps.reduce((a, p, i) => a + -(ups[i]! ? Math.log(p) : Math.log(1 - p)), 0) / ps.length;
        const ps = probs(scale);
        const cnt = ps.length;
        let brier = 0;
        let base = 0;
        let sumP = 0;
        let sumUp = 0;
        const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, up: 0 }));
        const lo = { n: 0, p: 0, up: 0 };
        const hi = { n: 0, p: 0, up: 0 };
        ps.forEach((p, i) => {
          const up = ups[i]!;
          sumP += p;
          sumUp += up;
          brier += (p - up) ** 2;
          base += (0.5 - up) ** 2;
          const b = bins[Math.min(9, Math.floor(p * 10))]!;
          b.n++;
          b.p += p;
          b.up += up;
          if (p < 0.1) {
            lo.n++;
            lo.p += p;
            lo.up += up;
          } else if (p > 0.9) {
            hi.n++;
            hi.p += p;
            hi.up += up;
          }
        });
        let best = { m: 1, ll: Infinity };
        for (let k = 0; k <= 20; k++) {
          const m = 0.8 + 0.05 * k;
          const ll = logLossOf(probs(m));
          if (ll < best.ll) best = { m, ll };
        }
        rows.push({
          asset: label,
          round: dur === 900 ? "15m" : "1h",
          tauSec: tau,
          scale,
          n: cnt,
          meanP: sumP / cnt,
          freqUp: sumUp / cnt,
          brier: brier / cnt,
          brierBaseline: base / cnt,
          logLoss: logLossOf(ps),
          bins: bins
            .filter((b) => b.n >= 30)
            .map((b) => ({ p: b.p / b.n, freq: b.up / b.n, n: b.n })),
          tailLow: {
            n: lo.n,
            predicted: lo.n ? lo.p / lo.n : 0,
            observed: lo.n ? lo.up / lo.n : 0,
          },
          tailHigh: {
            n: hi.n,
            predicted: hi.n ? hi.p / hi.n : 0,
            observed: hi.n ? hi.up / hi.n : 0,
          },
          optimalScale: Number(best.m.toFixed(2)),
          logLossAtOptimal: best.ll,
        });
      }
    }
  }
  return rows;
}

/**
 * The volatility multiplier that minimises the pooled log loss of the fair-probability model over
 * real rounds that END before `untilDay` (the training window; the hold-out is never read). Pooled
 * over BTC/ETH, 15 m and 1 h rounds, at the horizons used in the calibration table.
 */
export function pooledOptimalScale(untilDay: string): number {
  const untilSec = Date.parse(`${untilDay}T00:00:00Z`) / 1000;
  const grid = Array.from({ length: 21 }, (_, k) => 0.8 + 0.05 * k);
  const total = new Float64Array(grid.length);
  let count = 0;
  for (const label of ["BTC/USD", "ETH/USD"]) {
    const s = loadSeriesCached(label);
    const vol = new EwmaVol({ ...DEFAULT_PARAMS.vol, scale: 1 });
    const n = s.px.length;
    const sig = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      vol.update(s.px[k]!, s.t0 + k);
      sig[k] = vol.annualVol;
    }
    for (const dur of [900, 3600]) {
      for (const tau of dur === 900 ? [600, 300, 120] : [1800, 600, 120]) {
        for (
          let start = s.t0 + 86_400;
          start + dur < Math.min(untilSec, s.t0 + n - 1);
          start += dur
        ) {
          const ks = start - s.t0;
          const ke = ks + dur;
          const kt = ke - tau;
          const up = s.px[ke]! >= s.px[ks]!;
          grid.forEach((m, g) => {
            const p = fairProbUp(s.px[kt]!, s.px[ks]!, sig[kt]! * m, tau / SECONDS_PER_YEAR);
            total[g]! += -(up ? Math.log(p) : Math.log(1 - p));
          });
          count++;
        }
      }
    }
  }
  void count;
  let best = 0;
  for (let g = 1; g < grid.length; g++) if (total[g]! < total[best]!) best = g;
  return Number(grid[best]!.toFixed(2));
}

// ------------------------------------------------------------------ tuning

export type Candidate = {
  id: string;
  params: StrategyParams;
  screen: { pessimistic: Score; sniper: Score; combined: number };
  train?: { pessimistic: Score; sniper: Score; combined: number };
};

const combine = (a: Score, b: Score) => a.score + b.score;

/**
 * Two-stage search for one design: random screening on a thin slice of the TRAIN window, then the
 * top candidates (plus mutations of the best) on the whole TRAIN window.
 */
export async function tuneDesign(
  design: "specified" | "proposed",
  q: Quick,
  seed: number,
  log: (m: string) => void,
  volScale: number,
): Promise<{ candidates: Candidate[]; winner: Candidate }> {
  const venue = DESIGNS[design]!.venue;
  const rng = new Rng(seed);
  const pool: { id: string; params: StrategyParams }[] = [
    { id: "defaults", params: DEFAULT_PARAMS },
  ];
  for (let i = 0; i < q.screenN; i++)
    pool.push({ id: `r${i}`, params: sampleParams(rng, volScale) });
  const screenW: Window = { start: TRAIN.start, end: TRAIN.end, stride: q.trainStride, offset: 1 };
  const evalPool = async (items: { id: string; params: StrategyParams }[], w: Window) => {
    const cells: Cell[] = items.flatMap((c) => [
      cellFor(`${c.id}|pess`, c.params, SCENARIOS.pessimistic!.flow, venue, w),
      cellFor(`${c.id}|snip`, c.params, SCENARIOS.sniper!.flow, venue, w),
    ]);
    const rs = await runCells(cells, undefined, {
      onProgress: (d, t) => d % 16 === 0 && log(`  ${design}: ${d}/${t}`),
    });
    return items.map((c, i) => {
      const pessimistic = scoreRun(rs[2 * i]!, NAV0);
      const sniper = scoreRun(rs[2 * i + 1]!, NAV0);
      return { pessimistic, sniper, combined: combine(pessimistic, sniper) };
    });
  };
  log(`tuning ${design}: screening ${pool.length} candidates`);
  const screened = await evalPool(pool, screenW);
  const cands: Candidate[] = pool.map((c, i) => ({
    id: c.id,
    params: c.params,
    screen: screened[i]!,
  }));
  cands.sort((a, b) => b.screen.combined - a.screen.combined || (a.id < b.id ? -1 : 1));
  // Refine: mutations of the best two, screened too.
  const best = cands.slice(0, 2);
  const mutants: { id: string; params: StrategyParams }[] = [];
  for (let b = 0; b < best.length; b++) {
    for (let m = 0; m < Math.max(2, Math.floor(q.screenN / 4)); m++) {
      mutants.push({ id: `m${b}.${m}`, params: mutate(best[b]!.params, rng, 2) });
    }
  }
  const mScreen = await evalPool(mutants, screenW);
  mutants.forEach((c, i) => cands.push({ id: c.id, params: c.params, screen: mScreen[i]! }));
  cands.sort((a, b) => b.screen.combined - a.screen.combined || (a.id < b.id ? -1 : 1));
  const top = cands.slice(0, q.topK);
  log(`tuning ${design}: full TRAIN window for ${top.length} finalists`);
  const fullW: Window = { start: TRAIN.start, end: TRAIN.end, stride: q.finalStride, offset: 0 };
  const trained = await evalPool(
    top.map((c) => ({ id: c.id, params: c.params })),
    fullW,
  );
  top.forEach((c, i) => (c.train = trained[i]!));
  const winner = [...top].sort(
    (a, b) => b.train!.combined - a.train!.combined || (a.id < b.id ? -1 : 1),
  )[0]!;
  return { candidates: cands, winner };
}

export { HOLDOUT, TRAIN, END_EXCLUSIVE, WINDOW, readManifest };

// ------------------------------------------------------------------ window summaries from daily rows

import type { DailyRow } from "../types";
import { blockBootstrapCi, maxDrawdown, mean, sharpeDaily, std } from "../metrics";
import { hashSeed } from "../rng";

export type WindowSummary = {
  days: number;
  netPnl: number;
  expectedNetEdge: number;
  expectedPerDay: number;
  expectedPerDayCi95: [number, number];
  expectedApyPct: number;
  edgeNoise: number;
  edgeInformed: number;
  residual: number;
  /** Mean and t-statistic of the daily outcome residual (zero mean if the model is calibrated). */
  residualPerDay: number;
  residualT: number;
  gasUsd: number;
  noiseVolumeUsd: number;
  informedVolumeUsd: number;
  meanDaily: number;
  /** CIs of realized P&L EXCLUDING informed gains (moving 5-day blocks). */
  meanDailyCi95: [number, number];
  totalCi95: [number, number];
  stdDaily: number;
  sharpe: number;
  profitableDaysPct: number;
  breakerTripDays: number;
  /** Peak-to-trough decline of the cumulative daily P&L, as % of starting NAV. */
  maxDrawdownDailyPct: number;
};

export function summarizeDays(daily: DailyRow[], nav0 = NAV0, seed = 1): WindowSummary {
  const n = daily.length;
  const pnl = Float64Array.from(daily.map((d) => d.pnl));
  const adj = Float64Array.from(daily.map((d) => d.pnl - Math.max(0, d.edgeInformed)));
  const expDaily = Float64Array.from(
    daily.map(
      (d) => d.edgeNoise + Math.min(0, d.edgeInformed) + d.feeIncome - d.gasUsd - d.redeemFees,
    ),
  );
  const resid = Float64Array.from(daily.map((d) => d.residual));
  const sum = (f: (d: DailyRow) => number) => daily.reduce((a, d) => a + f(d), 0);
  const edge = expDaily.reduce((a, b) => a + b, 0);
  const cum: number[] = [nav0];
  for (const d of daily) cum.push(cum[cum.length - 1]! + d.pnl);
  const ci = blockBootstrapCi(adj, mean, hashSeed(seed, "w", n));
  const eci = blockBootstrapCi(expDaily, mean, hashSeed(seed, "e", n));
  const rs = std(resid);
  return {
    days: n,
    netPnl: sum((d) => d.pnl),
    expectedNetEdge: edge,
    expectedPerDay: n ? edge / n : 0,
    expectedPerDayCi95: eci,
    expectedApyPct: n ? ((edge / n) * 365 * 100) / nav0 : 0,
    edgeNoise: sum((d) => d.edgeNoise),
    edgeInformed: sum((d) => d.edgeInformed),
    residual: sum((d) => d.residual),
    residualPerDay: mean(resid),
    residualT: rs > 0 ? mean(resid) / (rs / Math.sqrt(n)) : 0,
    gasUsd: sum((d) => d.gasUsd),
    noiseVolumeUsd: sum((d) => d.noiseVolumeUsd),
    informedVolumeUsd: sum((d) => d.informedVolumeUsd),
    meanDaily: mean(pnl),
    meanDailyCi95: ci,
    totalCi95: [ci[0] * n, ci[1] * n],
    stdDaily: std(pnl),
    sharpe: sharpeDaily(pnl),
    profitableDaysPct: n ? (100 * pnl.filter((x) => x > 0).length) / n : 0,
    breakerTripDays: daily.filter((d) => d.breakerTripped).length,
    maxDrawdownDailyPct: 100 * (maxDrawdown(cum).abs / nav0),
  };
}

export function classifyWindow(s: WindowSummary): "PROFITABLE" | "MARGINAL" | "UNPROFITABLE" {
  if (s.expectedPerDay <= 0) return "UNPROFITABLE";
  return s.expectedPerDayCi95[0] > 0 && s.meanDailyCi95[0] > 0 ? "PROFITABLE" : "MARGINAL";
}

export type { RunResult, SimConfig, DailyRow };
