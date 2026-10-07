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
import { GAS_TOPUP_BELOW_WEI } from "@/lib/limits";

/**
 * The only server-side money-mover: a small hot key that tops up gas for accounts (ADR-007) and,
 * on a test network, mints free test dollars. It never holds user keys or user funds; its balance
 * is the most it can lose. The real drip needs a deposit of at least $1, is limited to once a day
 * per account and has a daily budget; the test faucet has its own budget and cooldown. The
 * counters live in memory per server instance (serverless resets them on a cold start): a
 * production deployment needs a shared store (ADR-007). All sends go through one queue so the hot
 * key's nonces never collide.
 */
const DRIP_WEI = BigInt(process.env.DRIP_WEI ?? parseEther("0.1").toString());
const DAILY_BUDGET_WEI = BigInt(process.env.DRIP_DAILY_BUDGET_WEI ?? parseEther("5").toString());
const MIN_STABLE_FOR_DRIP = 1_000_000n; // $1: a real deposit, not a dust transfer
const FAUCET_BUDGET_WEI = BigInt(process.env.FAUCET_DAILY_BUDGET_WEI ?? parseEther("2").toString());
const FAUCET_USDC = 100n * 1_000_000n;

const byIp = new Map<string, number[]>();
const byAddress = new Map<string, number>();
let day = { start: Date.now(), spent: 0n, faucetSpent: 0n };
const inFlight = new Set<string>();
let queue: Promise<unknown> = Promise.resolve(); // one send at a time from the hot key: nonces never collide

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
  if (byIp.size > 5_000) byIp.delete(byIp.keys().next().value as string); // evict the oldest, never reset everyone
}

function budget(amount: bigint, faucet: boolean) {
  if (Date.now() - day.start > 86_400_000) day = { start: Date.now(), spent: 0n, faucetSpent: 0n };
  // the test faucet and the real drip have separate budgets: one cannot drain the other
  if (faucet) {
    if (day.faucetSpent + amount > FAUCET_BUDGET_WEI)
      throw new RelayerError(503, "The test faucet is empty for today. Try again tomorrow.");
    day.faucetSpent += amount;
    return;
  }
  if (day.spent + amount > DAILY_BUDGET_WEI)
    throw new RelayerError(
      503,
      "Today's free gas budget is used up. Add a little gas money yourself (see the Add money page) or try tomorrow.",
    );
  day.spent += amount;
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
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
  const key = address.toLowerCase();
  const lastAt = byAddress.get(key);
  const cooldown = opts.faucet ? 10 * 60_000 : 24 * 3_600_000;
  if (lastAt && Date.now() - lastAt < cooldown)
    throw new RelayerError(429, "This account was topped up recently.");
  if (inFlight.has(key))
    throw new RelayerError(429, "A top-up for this account is already on its way.");
  inFlight.add(key);
  try {
    const { account, pub, wallet } = clients();
    const [native, usdc] = await Promise.all([
      pub.getBalance({ address }),
      pub.readContract({
        address: deployment.usdc,
        abi: mockErc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ]);
    const out: { gas?: Hex; usdc?: Hex } = {};
    // Gas: whenever the account is below the top-up level. The real drip also needs a real
    // stablecoin deposit first ($1 or more); the test faucet gives both.
    const needsGas = native < GAS_TOPUP_BELOW_WEI;
    if (needsGas && (opts.faucet || usdc >= MIN_STABLE_FOR_DRIP)) {
      budget(DRIP_WEI, opts.faucet);
      out.gas = await serial(() =>
        wallet.sendTransaction({ account, chain, to: address, value: DRIP_WEI, gas: 21_000n }),
      );
    }
    if (opts.faucet && usdc < FAUCET_USDC) {
      out.usdc = await serial(() =>
        wallet.writeContract({
          account,
          chain,
          address: deployment.usdc,
          abi: mockErc20Abi,
          functionName: "mint",
          args: [address, FAUCET_USDC],
          gas: 80_000n,
        }),
      );
    }
    if (!out.gas && !out.usdc)
      throw new RelayerError(
        409,
        needsGas
          ? "Add at least $1 first: free gas is for accounts that have deposited."
          : "This account already has what it needs.",
      );
    byAddress.set(key, Date.now());
    const last = (out.usdc ?? out.gas) as Hex;
    await pub.waitForTransactionReceipt({ hash: last, pollingInterval: 300, timeout: 30_000 });
    return out;
  } finally {
    inFlight.delete(key);
  }
}
