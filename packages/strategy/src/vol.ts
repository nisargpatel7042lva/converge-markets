import { SECONDS_PER_YEAR } from "./prob";

export type EwmaVolConfig = {
  /** Time for an observation's weight to halve, in seconds. */
  halfLifeSec: number;
  /** Annualized σ used until data arrives (the prior the estimate decays away from). */
  priorAnnualVol: number;
  /** The estimate is clamped to this annualized range. */
  minAnnualVol: number;
  maxAnnualVol: number;
};

/**
 * Annualization factor for a standard deviation measured over `sampleSec`-second returns:
 * σ_annual = σ_sample · √(SECONDS_PER_YEAR / sampleSec). Works for any sampling (1 s, 1 m, ...).
 */
export function annualizationFactor(sampleSec: number): number {
  if (!(Number.isFinite(sampleSec) && sampleSec > 0)) throw new RangeError("sampleSec must be > 0");
  return Math.sqrt(SECONDS_PER_YEAR / sampleSec);
}

/**
 * Time-aware EWMA volatility estimator on log returns.
 *
 * State is the per-second return variance v. For a return r over dt seconds:
 *   v ← α·v + (1-α)·r²/dt,   α = 2^(-dt/halfLife)
 * so the estimate does not depend on how often prices arrive: 1 s ticks, 1 m bars and irregular
 * gaps all feed the same recursion, and the annual figure is √(v · SECONDS_PER_YEAR).
 * Non-increasing timestamps are ignored (the first price only sets the reference).
 */
export class EwmaVol {
  private variancePerSec: number;
  private lastPrice: number | null = null;
  private lastT: number | null = null;

  constructor(private readonly cfg: EwmaVolConfig) {
    if (!(cfg.halfLifeSec > 0)) throw new RangeError("halfLifeSec must be > 0");
    if (!(cfg.minAnnualVol > 0 && cfg.maxAnnualVol >= cfg.minAnnualVol))
      throw new RangeError("invalid vol clamp");
    if (!(cfg.priorAnnualVol > 0)) throw new RangeError("priorAnnualVol must be > 0");
    this.variancePerSec = (cfg.priorAnnualVol * cfg.priorAnnualVol) / SECONDS_PER_YEAR;
  }

  /** Feeds a price observed at time `tSec` (seconds, any epoch). Returns the annualized σ. */
  update(price: number, tSec: number): number {
    if (!(Number.isFinite(price) && price > 0 && Number.isFinite(tSec))) return this.annualVol;
    if (this.lastPrice === null || this.lastT === null) {
      this.lastPrice = price;
      this.lastT = tSec;
      return this.annualVol;
    }
    const dt = tSec - this.lastT;
    if (dt <= 0) return this.annualVol;
    const r = Math.log(price / this.lastPrice);
    const alpha = Math.pow(2, -dt / this.cfg.halfLifeSec);
    this.variancePerSec = alpha * this.variancePerSec + (1 - alpha) * ((r * r) / dt);
    this.lastPrice = price;
    this.lastT = tSec;
    return this.annualVol;
  }

  /** Current annualized σ, clamped to the configured range. */
  get annualVol(): number {
    const raw = Math.sqrt(this.variancePerSec * SECONDS_PER_YEAR);
    return Math.min(this.cfg.maxAnnualVol, Math.max(this.cfg.minAnnualVol, raw));
  }
}

/**
 * Rolling price range over a time window, used by the toxicity guard: the largest log-price
 * excursion (max minus min) among observations in the last `windowSec`, in basis points.
 * Monotonic deques give O(1) amortized updates.
 */
export class RollingRange {
  private readonly maxQ: { t: number; x: number }[] = [];
  private readonly minQ: { t: number; x: number }[] = [];
  private maxHead = 0;
  private minHead = 0;

  constructor(private readonly windowSec: number) {
    if (!(windowSec > 0)) throw new RangeError("windowSec must be > 0");
  }

  push(price: number, tSec: number): void {
    if (!(Number.isFinite(price) && price > 0 && Number.isFinite(tSec))) return;
    const x = Math.log(price);
    while (this.maxQ.length > this.maxHead && this.maxQ[this.maxQ.length - 1]!.x <= x)
      this.maxQ.pop();
    this.maxQ.push({ t: tSec, x });
    while (this.minQ.length > this.minHead && this.minQ[this.minQ.length - 1]!.x >= x)
      this.minQ.pop();
    this.minQ.push({ t: tSec, x });
    const cutoff = tSec - this.windowSec;
    while (this.maxHead < this.maxQ.length && this.maxQ[this.maxHead]!.t < cutoff) this.maxHead++;
    while (this.minHead < this.minQ.length && this.minQ[this.minHead]!.t < cutoff) this.minHead++;
    if (this.maxHead > 1024) {
      this.maxQ.splice(0, this.maxHead);
      this.maxHead = 0;
    }
    if (this.minHead > 1024) {
      this.minQ.splice(0, this.minHead);
      this.minHead = 0;
    }
  }

  /** Excursion in basis points (0 until at least one observation). */
  get rangeBps(): number {
    if (this.maxHead >= this.maxQ.length || this.minHead >= this.minQ.length) return 0;
    return (this.maxQ[this.maxHead]!.x - this.minQ[this.minHead]!.x) * 1e4;
  }
}
