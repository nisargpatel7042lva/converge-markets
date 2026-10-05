import { Rng } from "./rng";

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}

/** Sample standard deviation (n−1). */
export function std(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i]! - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

/** Linear-interpolated quantile of a numeric array (does not mutate the input). */
export function quantile(xs: ArrayLike<number>, q: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  const a = Float64Array.from(xs).sort();
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return a[lo]! + (a[hi]! - a[lo]!) * (pos - lo);
}

/** Annualized Sharpe of daily P&L figures: mean/std · √365 (crypto trades every day). */
export function sharpeDaily(daily: ArrayLike<number>): number {
  const s = std(daily);
  return s > 0 ? (mean(daily) / s) * Math.sqrt(365) : 0;
}

/**
 * Percentile bootstrap (resampling days with replacement) of a statistic of the daily series.
 * Deterministic for a given seed.
 */
export function bootstrapCi(
  daily: ArrayLike<number>,
  stat: (xs: Float64Array) => number,
  seed: number,
  resamples = 2000,
): [number, number] {
  const n = daily.length;
  if (n === 0) return [0, 0];
  const r = new Rng(seed);
  const out = new Float64Array(resamples);
  const buf = new Float64Array(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) buf[i] = daily[r.int(n)]!;
    out[b] = stat(buf);
  }
  return [quantile(out, 0.025), quantile(out, 0.975)];
}

/** Maximum peak-to-trough decline of an equity series (absolute, and as a fraction of the peak). */
export function maxDrawdown(equity: ArrayLike<number>): { abs: number; frac: number } {
  let peak = -Infinity;
  let abs = 0;
  let frac = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!;
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > abs) abs = dd;
    if (peak > 0 && dd / peak > frac) frac = dd / peak;
  }
  return { abs, frac };
}

/**
 * Moving-block bootstrap (blocks of consecutive days) of a statistic of the daily series, so that
 * volatility clustering and autocorrelation between days are respected. Deterministic per seed.
 */
export function blockBootstrapCi(
  daily: ArrayLike<number>,
  stat: (xs: Float64Array) => number,
  seed: number,
  blockLen = 5,
  resamples = 2000,
): [number, number] {
  const n = daily.length;
  if (n === 0) return [0, 0];
  const L = Math.max(1, Math.min(blockLen, n));
  const r = new Rng(seed);
  const out = new Float64Array(resamples);
  const buf = new Float64Array(n);
  for (let b = 0; b < resamples; b++) {
    let filled = 0;
    while (filled < n) {
      const start = r.int(n - L + 1);
      for (let k = 0; k < L && filled < n; k++) buf[filled++] = daily[start + k]!;
    }
    out[b] = stat(buf);
  }
  return [quantile(out, 0.025), quantile(out, 0.975)];
}
