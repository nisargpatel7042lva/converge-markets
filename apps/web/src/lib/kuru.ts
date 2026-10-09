"use client";
import { useQuery } from "@tanstack/react-query";
import { parseAbi, type Address } from "viem";
import { deployment } from "@/config/deployment";
import { publicClient } from "./chain";
import type { Round } from "./data";

/**
 * Kuru lists each round's UP token on its spot order book (services/kuru). A Kuru market's address is a
 * pure function of its parameters, so the app finds it with the Router's `computeAddress` view and no
 * registry: if code exists at that address, the token is listed and its best bid and ask can be read.
 * Testnet only (Kuru's Router address below is its Monad testnet deployment).
 */
const ROUTER: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const abi = parseAbi([
  "function computeAddress(address base, address quote, uint96 sizePrecision, uint32 pricePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 ammSpread, address oldImplementation, bool old) view returns (address)",
  "function bestBidAsk() view returns (uint256, uint256)",
]);

export const kuruEnabled = deployment.chainId === 10143;
export const KURU_APP = "https://www.kuru.io";

export type KuruBook = { market: Address; bid: number | null; ask: number | null };

/** The price scale `bestBidAsk` reports in: the market's price precision (1e4) times 1e10. */
const fromBook = (v: bigint): number | null => (v === 0n ? null : Number(v) / 1e14);

export async function readKuruBook(round: Round): Promise<KuruBook | null> {
  const market = await publicClient.readContract({
    address: ROUTER,
    abi,
    functionName: "computeAddress",
    args: [
      round.up,
      deployment.usdc,
      10_000n,
      10_000,
      10,
      10_000n,
      1_000_000_000n,
      0n,
      0n,
      100n,
      ZERO,
      false,
    ],
  });
  const code = await publicClient.getCode({ address: market });
  if (!code || code === "0x") return null;
  const [bid, ask] = await publicClient.readContract({
    address: market,
    abi,
    functionName: "bestBidAsk",
  });
  return { market, bid: fromBook(bid), ask: fromBook(ask) };
}

export function useKuruBook(round: Round | undefined) {
  return useQuery({
    queryKey: ["kuru-book", round?.address],
    queryFn: () => readKuruBook(round as Round),
    enabled: kuruEnabled && round !== undefined && round.state <= 1,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}
