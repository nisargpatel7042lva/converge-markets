/**
 * A uniformly sampled price series. `px[k]` is the price at time `t0 + k·stepSec` seconds: the
 * close of the bar that ended at that instant, so it only ever contains information available at
 * or before that time.
 */
export type PriceSeries = {
  label: string;
  /** Unix seconds of px[0]. */
  t0: number;
  stepSec: number;
  px: Float64Array;
};

/** Last valid time (ms) of the series. */
export function seriesEndMs(s: PriceSeries): number {
  return (s.t0 + (s.px.length - 1) * s.stepSec) * 1000;
}

/**
 * Price at an arbitrary time in ms, linearly interpolated between samples (the path inside one
 * sample interval is assumed linear; see the report's Limitations). Clamped at the ends.
 */
export function priceAtMs(s: PriceSeries, tMs: number): number {
  const u = (tMs / 1000 - s.t0) / s.stepSec;
  if (u <= 0) return s.px[0]!;
  const last = s.px.length - 1;
  if (u >= last) return s.px[last]!;
  const i = Math.floor(u);
  const f = u - i;
  return s.px[i]! + (s.px[i + 1]! - s.px[i]!) * f;
}

/** Index of the last sample at or before `tSec` (−1 if before the series). */
export function indexAtOrBefore(s: PriceSeries, tSec: number): number {
  const i = Math.floor((tSec - s.t0) / s.stepSec + 1e-9);
  return Math.min(i, s.px.length - 1);
}
