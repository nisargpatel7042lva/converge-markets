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

/**
 * A fetch that counts the JSON-RPC calls and holds them to `maxRps` (the public Monad endpoints
 * answer HTTP 429 above 15 calls a second). Transaction submissions are never delayed: a pull-all
 * must not queue behind reads.
 */
export function limitedFetch(
  maxRps: number,
  calls: Map<string, number>,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  base: typeof fetch = fetch,
): typeof fetch {
  let tokens = maxRps;
  let last = now();
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
    const urgent = methods.includes("eth_sendRawTransaction");
    const need = Math.max(1, methods.length);
    if (!urgent && maxRps > 0) {
      for (;;) {
        const t = now();
        tokens = Math.min(maxRps, tokens + ((t - last) / 1000) * maxRps);
        last = t;
        if (tokens >= Math.min(need, maxRps)) {
          tokens -= Math.min(need, maxRps);
          break;
        }
        await sleep(Math.ceil(((Math.min(need, maxRps) - tokens) / maxRps) * 1000) + 5);
      }
    }
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
    c.rpcErrors.consecutive += 1;
    c.rpcErrors.total += 1;
    throw e;
  }
}

/** The transaction manager's view of the chain, on viem. */
export function viemChainTx(c: Clients, defaultTipWei = 2_000_000_000n): ChainTx {
  return {
    async fees(): Promise<Fees> {
      const block = await tracked(c, () => c.pub.getBlock());
      let tip = defaultTipWei;
      try {
        tip = await c.pub.estimateMaxPriorityFeePerGas();
      } catch {
        // some nodes do not serve it
      }
      return { baseFee: block.baseFeePerGas ?? 100_000_000_000n, tip };
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
      tracked(c, () =>
        c.wallet.sendTransaction({
          account: c.account,
          chain: c.chain,
          to: req.to,
          data: req.data,
          ...(req.value === undefined ? {} : { value: req.value }),
          gas: req.gas,
          nonce: req.nonce,
          maxFeePerGas: req.maxFeePerGas,
          maxPriorityFeePerGas: req.maxPriorityFeePerGas,
        }),
      ),
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
  };
}
