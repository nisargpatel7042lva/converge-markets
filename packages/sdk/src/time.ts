/**
 * UTC round boundaries. Unix time has no leap seconds and no DST, so a boundary aligned to the
 * duration in seconds is aligned to the UTC wall clock (15m: :00/:15/:30/:45, 1h: :00).
 * Mirrors contracts/src/libraries/Series.sol.
 */
export const FIFTEEN_MINUTES = 900n;
export const ONE_HOUR = 3600n;
export const SUPPORTED_DURATIONS = [FIFTEEN_MINUTES, ONE_HOUR] as const;

export function assertSupportedDuration(duration: bigint): void {
  if (duration !== FIFTEEN_MINUTES && duration !== ONE_HOUR) {
    throw new Error(`unsupported duration ${duration}`);
  }
}

/** Start of the round containing `t` (largest boundary <= t). */
export function roundStart(t: bigint, duration: bigint): bigint {
  assertSupportedDuration(duration);
  if (t < 0n) throw new Error("negative time");
  return t - (t % duration);
}

/** First boundary strictly after `t`. */
export function nextBoundary(t: bigint, duration: bigint): bigint {
  return roundStart(t, duration) + duration;
}

export function isAligned(t: bigint, duration: bigint): boolean {
  assertSupportedDuration(duration);
  return t % duration === 0n;
}

/**
 * Start times of the next `n` rounds that start strictly after `now`
 * (the factory only accepts start >= block.timestamp; a round starting exactly now is "current").
 */
export function upcomingStarts(now: bigint, duration: bigint, n: number): bigint[] {
  const first = nextBoundary(now, duration);
  return Array.from({ length: n }, (_, i) => first + BigInt(i) * duration);
}

/** Start times of rounds whose start is in (now - lookback, now], newest first. */
export function recentStarts(now: bigint, duration: bigint, lookback: bigint): bigint[] {
  const out: bigint[] = [];
  for (let s = roundStart(now, duration); s > now - lookback && s >= 0n; s -= duration) {
    out.push(s);
  }
  return out;
}

/** ISO-8601 UTC, e.g. 2026-10-01T14:15:00Z (for logs and token-name cross-checks). */
export function isoUtc(t: bigint): string {
  return new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
}
