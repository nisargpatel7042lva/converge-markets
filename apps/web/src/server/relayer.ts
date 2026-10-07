import "server-only";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain } from "@/lib/chain";
import { deployment } from "@/config/deployment";
import { mockErc20Abi } from "@converge/sdk";

/**
 * The only server-side money-mover: a small hot key that tops up gas for new accounts (ADR-007) and,
 * on a test network, mints free test dollars. It never holds user keys or user funds; its balance
 * is the most it can lose. Limits are best effort on serverless (in-memory per instance): the
 * chain-derived rule (account has never sent a transaction and holds almost no MON) is the real
 * one-drip-per-account guard, and the daily budget caps the total.
 */
const DRIP_WEI = BigInt(process.env.DRIP_WEI ?? parseEther("0.05").toString());
const DAILY_BUDGET_WEI = BigInt(process.env.DRIP_DAILY_BUDGET_WEI ?? parseEther("5").toString());
const ELIGIBLE_BELOW_WEI = parseEther("0.02");
const FAUCET_USDC = 100n * 1_000_000n;

const byIp = new Map<string, number[]>();
const byAddress = new Map<string, number>();
let day = { start: Date.now(), spent: 0n };

export class RelayerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function hit(ip: string, limit: number, windowMs: number) {
  const now = Date.now();
  const list = (byIp.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit)
    throw new RelayerError(429, "Too many requests from this connection. Try again later.");
  byIp.set(ip, [...list, now]);
  if (byIp.size > 5_000) byIp.clear();
}

function budget(amount: bigint) {
  if (Date.now() - day.start > 86_400_000) day = { start: Date.now(), spent: 0n };
  if (day.spent + amount > DAILY_BUDGET_WEI)
    throw new RelayerError(
      503,
      "Today's free gas budget is used up. Add a little gas money yourself or try tomorrow.",
    );
  day.spent += amount;
}

function clients() {
  const key = process.env.DRIP_PRIVATE_KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new RelayerError(503, "Free gas isn't set up on this deployment.");
  const account = privateKeyToAccount(key);
  const transport = http(process.env.DRIP_RPC_URL ?? deployment.rpcUrl);
  return {
    account,
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account, chain, transport }),
  };
}

export async function drip(addressRaw: unknown, ip: string, opts: { faucet: boolean }) {
  if (typeof addressRaw !== "string" || !isAddress(addressRaw))
    throw new RelayerError(400, "That isn't an address.");
  const address = addressRaw as Address;
  if (opts.faucet && !(deployment.testnet && process.env.FAUCET_ENABLED === "1"))
    throw new RelayerError(404, "The test faucet is off.");
  hit(ip, opts.faucet ? 10 : 5, 3_600_000);
  const lastAt = byAddress.get(address.toLowerCase());
  if (lastAt && Date.now() - lastAt < 10 * 60_000)
    throw new RelayerError(429, "This account was topped up a moment ago.");

  const { account, pub, wallet } = clients();
  const [native, nonce, usdc] = await Promise.all([
    pub.getBalance({ address }),
    pub.getTransactionCount({ address }),
    pub.readContract({
      address: deployment.usdc,
      abi: mockErc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);

  const out: { gas?: Hex; usdc?: Hex } = {};
  // Gas: only for an account that has never sent anything and holds almost nothing; for the real
  // (non-faucet) drip also only after it received a stablecoin deposit.
  const needsGas = native < ELIGIBLE_BELOW_WEI;
  if (needsGas && (opts.faucet || (nonce === 0 && usdc > 0n))) {
    budget(DRIP_WEI);
    out.gas = await wallet.sendTransaction({
      account,
      chain,
      to: address,
      value: DRIP_WEI,
      gas: 21_000n,
    });
  }
  if (opts.faucet && usdc < FAUCET_USDC) {
    out.usdc = await wallet.writeContract({
      account,
      chain,
      address: deployment.usdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [address, FAUCET_USDC],
      gas: 80_000n,
    });
  }
  if (!out.gas && !out.usdc)
    throw new RelayerError(
      409,
      needsGas
        ? "This account isn't eligible for free gas."
        : "This account already has what it needs.",
    );
  byAddress.set(address.toLowerCase(), Date.now());
  const last = (out.usdc ?? out.gas) as Hex;
  await pub.waitForTransactionReceipt({ hash: last, pollingInterval: 300, timeout: 30_000 });
  return out;
}
