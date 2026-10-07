/**
 * Shared helpers for the indexer tools: CLI args, address loading, percentiles, rate limiting,
 * a seeded sampler. Pure functions are unit-tested in test/common.test.ts.
 */
import { readFileSync } from "node:fs";

// ------------------------------------------------------------------ CLI

/** `--key value` and `--flag` parsing; env vars are the fallback (INDEXER_URL -> --indexer). */
export function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(key, next);
      i++;
    } else out.set(key, true);
  }
  return out;
}

export function opt(
  args: Map<string, string | true>,
  key: string,
  env: string,
  fallback?: string,
): string | undefined {
  const v = args.get(key);
  if (typeof v === "string") return v;
  return process.env[env] ?? fallback;
}

/** `name=value,name2=value2` -> headers (for the LOCAL Hasura admin secret). */
export function parseHeaders(s: string | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (!s) return h;
  for (const part of s.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) h[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return h;
}

// ------------------------------------------------------------------ addresses

export interface Addresses {
  chainId: number;
  factory: string;
  vault: string;
  venue: string;
  /** Deploy block of the vault (start of its events). */
  vaultBlock?: number;
}

/** Reads deployments/<net>.json (vault under "vault") or the local addresses.json. */
export function loadAddresses(path: string): Addresses {
  const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const v = j.vault as
    { vault?: string; forwardVenue?: string; deployBlock?: number } | string | undefined;
  if (typeof v === "object" && v?.vault && v.forwardVenue) {
    return {
      chainId: Number(j.chainId),
      factory: String(j.marketFactory),
      vault: v.vault,
      venue: v.forwardVenue,
      vaultBlock: Number((v as { deployBlock?: number }).deployBlock),
    };
  }
  if (typeof v === "string" && typeof j.venue === "string" && typeof j.factory === "string") {
    return {
      chainId: Number(j.chainId),
      factory: j.factory,
      vault: v,
      venue: j.venue,
      vaultBlock: typeof j.vaultBlock === "number" ? j.vaultBlock : undefined,
    };
  }
  throw new Error(`${path}: unrecognised addresses file`);
}

// ------------------------------------------------------------------ statistics

/** Nearest-rank percentile (p in (0, 100]) of a sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarize(values: readonly number[]) {
  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n,
    min: Math.min(...values),
    mean: n ? sum / n : NaN,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
  };
}

// ------------------------------------------------------------------ sampling

/** Deterministic PRNG (LCG) in [0, 1). */
export function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** Fisher-Yates partial shuffle: `k` distinct items, deterministic for a seed. */
export function sample<T>(items: readonly T[], k: number, rand: () => number): T[] {
  const a = [...items];
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/**
 * Splits `total` samples over pools in proportion to `weights`, never exceeding a pool's size;
 * leftover capacity is handed to the pools that still have room. If the pools together hold fewer
 * than `total` items every item is taken (the caller reports the shortfall).
 */
export function allocate(
  total: number,
  pools: readonly { name: string; size: number; weight: number }[],
): Map<string, number> {
  const out = new Map<string, number>(pools.map((p) => [p.name, 0]));
  let left = Math.min(
    total,
    pools.reduce((s, p) => s + p.size, 0),
  );
  while (left > 0) {
    const open = pools.filter((p) => out.get(p.name)! < p.size);
    if (open.length === 0) break;
    const w = open.reduce((s, p) => s + p.weight, 0);
    let given = 0;
    for (const p of open) {
      const room = p.size - out.get(p.name)!;
      const want = Math.max(1, Math.floor((left * p.weight) / w));
      const take = Math.min(room, want, left - given);
      out.set(p.name, out.get(p.name)! + take);
      given += take;
      if (given >= left) break;
    }
    left -= given;
    if (given === 0) break;
  }
  return out;
}

// ------------------------------------------------------------------ concurrency / rate

export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private nextSlot = 0;
  constructor(
    private readonly concurrency: number,
    private readonly rps = Infinity,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      if (Number.isFinite(this.rps)) {
        const now = Date.now();
        const slot = Math.max(now, this.nextSlot);
        this.nextSlot = slot + 1000 / this.rps;
        if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
      }
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
