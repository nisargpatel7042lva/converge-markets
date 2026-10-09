import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export interface Ctx {
  pub: PublicClient;
  wallet: WalletClient;
  me: Address;
  log: (s: string) => void;
}

export function makeCtx(rpc: string, key: Hex, log: (s: string) => void = console.log): Ctx {
  const chain = { ...monadTestnet, rpcUrls: { default: { http: [rpc] } } };
  const account = privateKeyToAccount(key);
  return {
    pub: createPublicClient({ chain, transport: http(rpc, { retryCount: 2 }) }) as PublicClient,
    wallet: createWalletClient({ account, chain, transport: http(rpc) }),
    me: account.address,
    log,
  };
}

export interface SendResult {
  hash: Hex;
  receipt: TransactionReceipt;
  gasLimit: bigint;
}

/**
 * Sends one call with an explicit gas limit (estimate + 15 %): Monad bills the limit, so a lazy
 * over-estimate costs real money. Throws on a reverted transaction.
 */
export async function send(
  ctx: Ctx,
  req: {
    address: Address;
    abi: Abi | readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  },
): Promise<SendResult> {
  const account = ctx.wallet.account!;
  const call = { ...req, args: req.args ?? [], account } as never;
  const gas = await ctx.pub.estimateContractGas(call);
  const gasLimit = (gas * 115n) / 100n;
  const hash = await ctx.wallet.writeContract({
    ...(call as object),
    chain: ctx.wallet.chain,
    gas: gasLimit,
  } as never);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${req.functionName} reverted (${hash})`);
  return { hash, receipt, gasLimit };
}

export const read = <T>(
  ctx: Ctx,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> => ctx.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
