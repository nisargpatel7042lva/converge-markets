/** Retries `fn` with exponential backoff (base * 2^attempt, capped), for transient RPC errors. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries: number;
    baseMs?: number;
    maxMs?: number;
    onRetry?: (e: unknown, n: number) => void;
  },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 8_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= opts.retries) throw e;
      opts.onRetry?.(e, attempt + 1);
      await sleep(Math.min(max, base * 2 ** attempt));
    }
  }
}
