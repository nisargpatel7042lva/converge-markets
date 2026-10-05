/** Numerical primitives. Pure, dependency-free, deterministic. */

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Standard normal density φ(x). */
export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Standard normal CDF Φ(x), double precision (about 1e-15 absolute).
 * Hart (1968) rational approximation as published in G. West, "Better approximations to
 * cumulative normal functions" (Wilmott, 2005). Stable in both tails (no 1 - small cancellation:
 * the tail value is computed directly and mirrored).
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const xAbs = Math.abs(x);
  let tail: number;
  if (xAbs > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-0.5 * xAbs * xAbs);
    if (xAbs < 7.07106781186547) {
      let b = 3.52624965998911e-2 * xAbs + 0.700383064443688;
      b = b * xAbs + 6.37396220353165;
      b = b * xAbs + 33.912866078383;
      b = b * xAbs + 112.079291497871;
      b = b * xAbs + 221.213596169931;
      b = b * xAbs + 220.206867912376;
      let c = e * b;
      b = 8.83883476483184e-2 * xAbs + 1.75566716318264;
      b = b * xAbs + 16.064177579207;
      b = b * xAbs + 86.7807322029461;
      b = b * xAbs + 296.564248779674;
      b = b * xAbs + 637.333633378831;
      b = b * xAbs + 793.826512519948;
      b = b * xAbs + 440.413735824752;
      c = c / b;
      tail = c;
    } else {
      let b = xAbs + 0.65;
      b = xAbs + 4 / b;
      b = xAbs + 3 / b;
      b = xAbs + 2 / b;
      b = xAbs + 1 / b;
      tail = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

// Acklam's rational approximation of the inverse normal CDF (relative error < 1.15e-9),
// refined with one Halley step against normCdf to reach about 1e-15.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
] as const;
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
] as const;
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;

/** Inverse standard normal CDF Φ⁻¹(p). Returns ±Infinity at 0 and 1, NaN outside [0, 1]. */
export function normInv(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
      (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  // One Halley refinement.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(0.5 * x * x);
  return x - u / (1 + 0.5 * x * u);
}
