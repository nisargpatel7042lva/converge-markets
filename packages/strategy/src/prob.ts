import { clamp, normCdf, normPdf } from "./math";

/** Probabilities are kept strictly inside (0, 1) so downstream log-odds and ladders stay finite. */
export const PROB_MIN = 1e-6;
export const PROB_MAX = 1 - 1e-6;

/** Seconds in a (Julian) year, the annualization basis for σ throughout the library. */
export const SECONDS_PER_YEAR = 365.25 * 86_400;

/** Smallest σ·√τ treated as non-degenerate (below this the outcome is effectively decided). */
const MIN_STD = 1e-12;

export type DigitalInputs = { spot: number; strike: number; sigma: number; tauYears: number };

function assertInputs({ spot, strike, sigma, tauYears }: DigitalInputs): void {
  if (!(Number.isFinite(spot) && spot > 0)) throw new RangeError("spot must be finite and > 0");
  if (!(Number.isFinite(strike) && strike > 0))
    throw new RangeError("strike must be finite and > 0");
  if (!(Number.isFinite(sigma) && sigma >= 0))
    throw new RangeError("sigma must be finite and >= 0");
  if (!(Number.isFinite(tauYears) && tauYears >= 0))
    throw new RangeError("tauYears must be finite and >= 0");
}

/**
 * d2 of the digital option: (ln(S/K) - ½σ²τ) / (σ√τ).
 * Returns ±Infinity when σ√τ is degenerate (decided by the sign of ln(S/K); ties go to +∞,
 * matching the production rule "UP iff endPrice >= strike").
 */
export function d2(inputs: DigitalInputs): number {
  assertInputs(inputs);
  const { spot, strike, sigma, tauYears } = inputs;
  const std = sigma * Math.sqrt(tauYears);
  const m = Math.log(spot / strike);
  if (std < MIN_STD) return m >= 0 ? Infinity : -Infinity;
  return (m - 0.5 * std * std) / std;
}

/**
 * Fair probability that UP wins: p = N(d2), clamped to [1e-6, 1 - 1e-6].
 * S = spot, K = strike (price at round open), σ annualized volatility, τ years to expiry
 * (CLAUDE.md "Core math"). The ½σ²τ term is the log-normal drift correction that makes the
 * probability exact for a driftless martingale price S.
 */
export function fairProbUp(spot: number, strike: number, sigma: number, tauYears: number): number {
  const x = d2({ spot, strike, sigma, tauYears });
  return clamp(normCdf(x), PROB_MIN, PROB_MAX);
}

/**
 * Instantaneous volatility of the fair probability per √second: φ(d2)/√τ(sec).
 * σ cancels: dp = φ(d2) · dB / √τ, the same form as Paradigm's pm-AMM outcome-token volatility
 * φ(Φ⁻¹(P))/√(T−t) (https://www.paradigm.xyz/2024/11/pm-amm, "Gaussian score dynamics").
 */
export function probVolPerRootSec(inputs: DigitalInputs): number {
  const x = d2(inputs);
  if (!Number.isFinite(x)) return 0;
  const tauSec = inputs.tauYears * SECONDS_PER_YEAR;
  if (tauSec <= 0) return 0;
  return normPdf(x) / Math.sqrt(tauSec);
}
