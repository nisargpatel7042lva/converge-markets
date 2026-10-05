/** Seedable, dependency-free PRNG and distributions. Same seed in, same numbers out, everywhere. */

export function hashSeed(...parts: (string | number)[]): number {
  // FNV-1a over the joined string.
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  /** Uniform in [0, 1). mulberry32. */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in (0, 1]. */
  nextOpen(): number {
    return 1 - this.next();
  }
  /** Exponential with the given mean. */
  exp(mean: number): number {
    return -Math.log(this.nextOpen()) * mean;
  }
  /** Standard normal (Box-Muller). */
  normal(): number {
    return Math.sqrt(-2 * Math.log(this.nextOpen())) * Math.cos(2 * Math.PI * this.next());
  }
  /** Lognormal with the given median and log-space sigma. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}
