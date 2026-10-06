import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
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
};

export function makeClients(opts: {
  rpcUrls: string[];
  keeperKey: Hex;
  chainId: number;
  timeoutMs?: number;
}): Clients {
  const chain = defineChain({
    id: opts.chainId,
    name: `chain-${opts.chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: opts.rpcUrls } },
  });
  const timeout = opts.timeoutMs ?? 4_000;
  const errors = { consecutive: 0, total: 0, lastOkMs: null as number | null };
  // JSON-RPC batching turns the many reads of one tick into one HTTP request per endpoint.
  const transports = opts.rpcUrls.map((u) => http(u, { timeout, batch: true, retryCount: 2, retryDelay: 60 }));
  const transport =
    transports.length === 1
      ? (transports[0] as Transport)
      : fallback(transports, { retryCount: 1, rank: false });
  const account = privateKeyToAccount(opts.keeperKey);
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport });
  return { pub, wallet, account, chain, rpcErrors: errors };
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
