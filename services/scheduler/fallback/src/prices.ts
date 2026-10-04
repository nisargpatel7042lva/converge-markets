import { aggregatorV3Abi, type PriceAt } from "@converge/sdk";
import { createPublicClient, http, type Address, type Hex } from "viem";

/**
 * TEST-ONLY price source for the test signer: reads the latest answer of a Chainlink aggregator
 * (e.g. Monad mainnet ETH/USD) and scales 8 -> 18 decimals. Used for local/testnet soaks so test
 * reports carry realistic prices; it does NOT look up the price at the boundary historically.
 */
export function chainlinkMirror(rpcUrl: string, feeds: Record<string, Address>) {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  return (feedId: Hex): PriceAt =>
    async () => {
      const agg = feeds[feedId.toLowerCase()];
      if (!agg) return null;
      const [, answer] = await client.readContract({
        address: agg,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
      });
      const dec = await client.readContract({
        address: agg,
        abi: aggregatorV3Abi,
        functionName: "decimals",
      });
      return answer * 10n ** BigInt(18 - Number(dec));
    };
}
