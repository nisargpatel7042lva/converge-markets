import { createPublicClient, createWalletClient, defineChain, http, type Account } from "viem";
import { deployment } from "@/config/deployment";

export const chain = defineChain({
  id: deployment.chainId,
  name: deployment.name,
  nativeCurrency: { name: deployment.nativeSymbol, symbol: deployment.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
  ...(deployment.explorerUrl
    ? { blockExplorers: { default: { name: "Explorer", url: deployment.explorerUrl } } }
    : {}),
  ...(deployment.multicall3
    ? { contracts: { multicall3: { address: deployment.multicall3 } } }
    : {}),
});

export const publicClient = createPublicClient({
  chain,
  transport: http(deployment.rpcUrl, { batch: { wait: 12 }, retryCount: 2, retryDelay: 200 }),
  pollingInterval: 300,
  ...(deployment.multicall3 ? { batch: { multicall: { wait: 12 } } } : {}),
});

export function walletFor(account: Account) {
  return createWalletClient({ account, chain, transport: http(deployment.rpcUrl) });
}

export const explorerTx = (hash: string) =>
  deployment.explorerUrl ? `${deployment.explorerUrl}/tx/${hash}` : undefined;
export const explorerAddress = (a: string) =>
  deployment.explorerUrl ? `${deployment.explorerUrl}/address/${a}` : undefined;

/**
 * `publicClient.multicall` where the chain has Multicall3; plain parallel reads where it does not
 * (a local anvil chain). Same call shape, `allowFailure: false` only.
 */
export const multicall = (
  deployment.multicall3
    ? (args: Parameters<typeof publicClient.multicall>[0]) => publicClient.multicall(args)
    : async (args: { contracts: readonly unknown[] }) =>
        Promise.all(args.contracts.map((c) => publicClient.readContract(c as never)))
) as typeof publicClient.multicall;
