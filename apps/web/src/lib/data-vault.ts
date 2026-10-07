import { convergeVaultAbi, mockErc20Abi } from "@converge/sdk";
import type { Address } from "viem";
import { deployment } from "@/config/deployment";
import { multicall, publicClient } from "./chain";

export async function readVault(user?: Address) {
  const v = deployment.vault;
  const c = (fn: string, args: readonly unknown[] = []) => ({
    address: v,
    abi: convergeVaultAbi,
    functionName: fn,
    args,
  });
  const base = await multicall({
    allowFailure: false,
    contracts: [
      c("totalSupply"),
      c("pricePerShareLower"),
      c("quoteNavLower"),
      c("lastNavUpper"),
      c("currentEpoch"),
      c("epochLength"),
      c("tvlCap"),
      c("quotingPaused"),
      c("keeperHalt"),
      c("performanceFeeBps"),
      c("lastPpsLower"),
    ] as never,
  });
  const epoch = base[4] as bigint;
  const epochEnd = await publicClient.readContract({
    address: v,
    abi: convergeVaultAbi,
    functionName: "epochEnd",
    args: [epoch],
  });
  const out = {
    totalSupply: base[0] as bigint,
    ppsLower: base[1] as bigint,
    navLower: base[2] as bigint,
    navUpper: base[3] as bigint,
    epoch,
    epochEnd: Number(epochEnd),
    epochLength: Number(base[5]),
    tvlCap: base[6] as bigint,
    quotingPaused: base[7] as boolean,
    quotingHalted: base[8] as boolean,
    performanceFeeBps: Number(base[9]),
    user: null as null | {
      shares: bigint;
      usdc: bigint;
      allowance: bigint;
      requests: {
        epoch: bigint;
        deposit: bigint;
        redeem: bigint;
        settled: boolean;
        rejected: boolean;
      }[];
    },
  };
  if (user) {
    const epochs = [epoch - 3n, epoch - 2n, epoch - 1n, epoch].filter((e) => e >= 0n);
    const res = await multicall({
      allowFailure: false,
      contracts: [
        c("balanceOf", [user]),
        { address: deployment.usdc, abi: mockErc20Abi, functionName: "balanceOf", args: [user] },
        { address: deployment.usdc, abi: mockErc20Abi, functionName: "allowance", args: [user, v] },
        ...epochs.flatMap((e) => [
          c("depositRequest", [e, user]),
          c("redeemRequest", [e, user]),
          c("epochs", [e]),
        ]),
      ] as never,
    });
    out.user = {
      shares: res[0] as bigint,
      usdc: res[1] as bigint,
      allowance: res[2] as bigint,
      requests: epochs.map((e, i) => {
        const ep = res[5 + i * 3] as readonly [bigint, bigint, boolean, boolean];
        return {
          epoch: e,
          deposit: res[3 + i * 3] as bigint,
          redeem: res[4 + i * 3] as bigint,
          settled: ep[2],
          rejected: ep[3],
        };
      }),
    };
  }
  return out;
}
