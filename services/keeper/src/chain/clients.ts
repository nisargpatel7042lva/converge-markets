import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainTx, Fees, TxReceipt, TxRequest } from "./tx";

export type Clients = {
  pub: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  account: Account;
  chain: Chain;
  /** Per-endpoint error counter bumps (for the RPC-error risk check and the metrics). */
  rpcErrors: { consecutive: number; total: number; lastOkMs: number | null };
  /** JSON-RPC calls made, by method (a batch counts each call). */
  rpcCalls: Map<string, number>;
};

/** The calls a halt depends on: they have their own allowance and never wait behind bulk reads. */
const URGENT = new Set([
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_chainId",
]);

/** Thrown instead of waiting for a long time on the local limiter (not an RPC failure). */
export class RateLimitedLocally extends Error {
  constructor(waitMs: number) {
    super(`RateLimitedLocally: the next call would wait ${waitMs} ms`);
  }
}

/**
 * A fetch that counts the JSON-RPC calls and holds them to `maxRps` (the public Monad endpoints
 * answer HTTP 429 above 15 calls a second per IP). Two token buckets: bulk reads, and an urgent
 * lane for what a halt needs (submission, receipts, nonces), so a flood of reads cannot starve a
 * pull-all. A call that would wait longer than `maxWaitMs` fails at once instead.
 */
export function limitedFetch(
  maxRps: number,
  calls: Map<string, number>,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  base: typeof fetch = fetch,
  urgentRps = 8,
  maxWaitMs = 2_000,
): typeof fetch {
  const bucket = (rps: number) => ({ rps, tokens: rps, last: now() });
  const bulk = bucket(maxRps);
  const urgent = bucket(maxRps > 0 ? urgentRps : 0); // no limit at all when maxRps is 0
  const take = async (b: ReturnType<typeof bucket>, n: number): Promise<void> => {
    if (b.rps <= 0) return;
    const need = Math.min(n, b.rps);
    for (;;) {
      const t = now();
      b.tokens = Math.min(b.rps, b.tokens + ((t - b.last) / 1000) * b.rps);
      b.last = t;
      if (b.tokens >= need) {
        b.tokens -= need;
        return;
      }
      const wait = Math.ceil(((need - b.tokens) / b.rps) * 1000) + 5;
      if (wait > maxWaitMs) throw new RateLimitedLocally(wait);
      await sleep(wait);
    }
  };
  return async (input, init) => {
    let methods: string[] = [];
    try {
      const body = JSON.parse(String(init?.body ?? "null")) as unknown;
      methods = (Array.isArray(body) ? body : [body])
        .map((x) => (x as { method?: string } | null)?.method)
        .filter((m): m is string => typeof m === "string");
    } catch {
      // not JSON-RPC: count it as one anonymous call
      methods = ["unknown"];
    }
    for (const m of methods) calls.set(m, (calls.get(m) ?? 0) + 1);
    const nUrgent = methods.filter((m) => URGENT.has(m)).length;
    const nBulk = Math.max(0, methods.length - nUrgent);
    if (nUrgent > 0) await take(urgent, nUrgent);
    if (nBulk > 0 || methods.length === 0) await take(bulk, Math.max(1, nBulk));
    return base(input, init);
  };
}

export function makeClients(opts: {
  rpcUrls: string[];
  keeperKey: Hex;
  chainId: number;
  timeoutMs?: number;
  /** Cap on JSON-RPC calls per second (all endpoints together). 0 disables it. */
  maxRps?: number;
  /** Multicall3: concurrent reads are aggregated into one eth_call. */
  multicall3?: Address;
}): Clients {
  const chain = defineChain({
    id: opts.chainId,
    name: `chain-${opts.chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: opts.rpcUrls } },
    ...(opts.multicall3 ? { contracts: { multicall3: { address: opts.multicall3 } } } : {}),
  });
  const timeout = opts.timeoutMs ?? 4_000;
  const errors = { consecutive: 0, total: 0, lastOkMs: null as number | null };
  // JSON-RPC batching turns the many reads of one tick into one HTTP request per endpoint.
  const rpcCalls = new Map<string, number>();
  const fetchFn = limitedFetch(opts.maxRps ?? 0, rpcCalls);
  const transports = opts.rpcUrls.map((u) =>
    http(u, { timeout, batch: true, retryCount: 2, retryDelay: 60, fetchFn }),
  );
  const transport =
    transports.length === 1
      ? (transports[0] as Transport)
      : fallback(transports, { retryCount: 1, rank: false });
  const account = privateKeyToAccount(opts.keeperKey);
  const pub = createPublicClient({
    chain,
    transport,
    ...(opts.multicall3 ? { batch: { multicall: { wait: 8 } } } : {}),
  }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport });
  return { pub, wallet, account, chain, rpcErrors: errors, rpcCalls };
}

/** Counts consecutive RPC failures (reset by any success) for the risk check. */
export async function tracked<T>(c: Clients, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    c.rpcErrors.consecutive = 0;
    c.rpcErrors.lastOkMs = Date.now();
    return r;
  } catch (e) {
    // waiting for our own limiter is not a sign that the node is down
    if (/RateLimitedLocally/.test(String(e))) throw e;
    c.rpcErrors.consecutive += 1;
    c.rpcErrors.total += 1;
    throw e;
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The transaction manager's view of the chain, on viem. Signing is local: no node round trip. */
export function viemChainTx(
  c: Clients,
  defaultTipWei = 2_000_000_000n,
  now: () => number = Date.now,
): ChainTx {
  // The base fee moves by at most 12.5 % a block and the max fee carries a 2x headroom, so a base
  // fee a few seconds old is fine: a halt does not wait for two extra round trips.
  let cachedFees: { baseFee: bigint; tip: bigint; at: number; tipAt: number } | null = null;
  return {
    address: c.account.address,
    async fees(): Promise<Fees> {
      const t = now();
      if (cachedFees && t - cachedFees.at < 3_000)
        return { baseFee: cachedFees.baseFee, tip: cachedFees.tip };
      let block: Awaited<ReturnType<typeof c.pub.getBlock>>;
      try {
        block = await tracked(c, () => c.pub.getBlock());
      } catch (e) {
        // a halt must not fail because a read was refused: a base fee a few seconds old will do
        if (cachedFees && t - cachedFees.at < 60_000)
          return { baseFee: cachedFees.baseFee, tip: cachedFees.tip };
        throw e;
      }
      let tip = cachedFees?.tip ?? defaultTipWei;
      let tipAt = cachedFees?.tipAt ?? 0;
      if (t - tipAt > 60_000) {
        try {
          // the node's estimate follows recent tips, ours included: keep it within a sane bound
          tip = min(await c.pub.estimateMaxPriorityFeePerGas(), 10_000_000_000n);
          tipAt = t;
        } catch {
          // some nodes do not serve it
        }
      }
      const baseFee = block.baseFeePerGas ?? 100_000_000_000n;
      cachedFees = { baseFee, tip, at: t, tipAt };
      return { baseFee, tip };
    },
    estimateGas: (req) =>
      tracked(c, () =>
        c.pub.estimateGas({
          account: c.account,
          to: req.to,
          data: req.data,
          ...(req.value === undefined ? {} : { value: req.value }),
        }),
      ),
    sendTx: (req: TxRequest) =>
      tracked(c, async () => {
        const serialized = await c.account.signTransaction?.({
          type: "eip1559",
          chainId: c.chain.id,
          to: req.to,
          data: req.data,
          ...(req.value === undefined ? {} : { value: req.value }),
          gas: req.gas,
          nonce: req.nonce,
          maxFeePerGas: req.maxFeePerGas,
          maxPriorityFeePerGas: req.maxPriorityFeePerGas,
        });
        if (!serialized) throw new Error("the keeper account cannot sign locally");
        return c.pub.sendRawTransaction({ serializedTransaction: serialized });
      }),
    async receipt(hash: Hex): Promise<TxReceipt | null> {
      try {
        const r = await c.pub.getTransactionReceipt({ hash });
        return {
          hash,
          status: r.status === "success" ? "success" : "reverted",
          blockNumber: r.blockNumber,
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
        };
      } catch (e) {
        if (/not be found|could not be found|TransactionReceiptNotFound/i.test(String(e)))
          return null;
        throw e;
      }
    },
    pendingNonce: () =>
      tracked(c, () =>
        c.pub.getTransactionCount({ address: c.account.address, blockTag: "pending" }),
      ),
    confirmedNonce: () =>
      tracked(c, () =>
        c.pub.getTransactionCount({ address: c.account.address, blockTag: "latest" }),
      ),
  };
}
