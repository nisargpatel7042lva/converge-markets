/**
 * The canary's scripted second wallet: places small real orders through the venue on the live
 * rounds, checks the keeper executes them, and redeems every settled round. Every action is
 * appended to a JSONL log (the evidence) and judged by analysis.ts.
 *
 *   CANARY_TRADER_KEY=...  RPC_URL=...  pnpm --filter @converge/mainnet canary:trade [--dry-run] [--once]
 *   CANARY_ORDER_USDC (default 1)  CANARY_INTERVAL_SEC (default 300)  CANARY_MAX_SPEND_USDC (default 40)
 *
 * The key is read from the environment only. The wallet needs a little USDC and MON; the spend
 * ceiling stops the run if something is wrong (an order that fills at an absurd price cannot
 * happen: planBuy caps the cost at the limit, and the limit is the displayed ask plus slippage).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  forwardVenueAbi,
  marketAbi,
  mockErc20Abi,
  planBuy,
  askFromLadder,
  ORDER_KIND,
} from "@converge/sdk";
import {
  parseEventLogs,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXCHANGE_SYMBOLS } from "../gen";
import { repoRoot } from "../params";
import type { Deployment } from "../state";
import { RESOLVED_DOWN, RESOLVED_UP, type TradeRecord } from "./analysis";

const executedEvent = parseAbiItem(
  "event OrderExecuted(uint256 indexed id, address indexed executor, uint256 filled, uint256 premium, uint256 reportPrice, uint32 reportValidFrom, uint32 reportObservations)",
);
const expiredEvent = parseAbiItem("event OrderExpired(uint256 indexed id, address indexed caller)");
const placedEvent = parseAbiItem(
  "event OrderPlaced(uint256 indexed id, address indexed taker, address indexed market, uint8 kind, uint256 shares, uint256 limit, uint64 execAt, uint256 reward)",
);

export const LOG = resolve(repoRoot, "docs/evidence/phase-9/canary/trades.jsonl");

export function readLog(path = LOG): TradeRecord[] {
  if (!existsSync(path)) return [];
  const byId = new Map<string, TradeRecord>();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as TradeRecord;
    byId.set(r.orderId, { ...byId.get(r.orderId), ...r }); // later lines update earlier ones
  }
  return [...byId.values()];
}

function append(r: Partial<TradeRecord> & { orderId: string }, path = LOG): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(r) + "\n");
}

/** A round worth trading: open, with enough time left for the order to be priced and still matter. */
export function tradable(now: number, start: number, duration: number): boolean {
  const elapsed = now - start;
  return elapsed >= 45 && duration - elapsed >= 240;
}

export function nextSide(done: number): "UP" | "DOWN" {
  return done % 2 === 0 ? "UP" : "DOWN";
}

async function spotOf(label: string): Promise<number> {
  const ex = EXCHANGE_SYMBOLS[label];
  if (!ex) throw new Error(`no exchange symbols for ${label}`);
  const r = await fetch(`https://api.exchange.coinbase.com/products/${ex.coinbase}/ticker`, {
    signal: AbortSignal.timeout(5_000),
  });
  const j = (await r.json()) as { price: string };
  return Number(j.price);
}

export async function runOnce(args: {
  pub: PublicClient;
  wallet: WalletClient | undefined;
  me: Address;
  dep: Deployment;
  dryRun: boolean;
  orderUsdc: bigint;
  spent: { v: bigint };
  maxSpend: bigint;
  durations: number[];
  log?: string;
}): Promise<void> {
  const { pub, wallet, me, dep, dryRun } = args;
  const venue = dep.vault!.forwardVenue;
  const now = Math.floor(Date.now() / 1000);
  const trades = readLog(args.log);

  // 1. settle accounts first: redeem every executed trade whose round has resolved
  for (const t of trades) {
    if (t.status !== "executed" || t.redeem !== "pending") continue;
    const st = Number(
      await pub.readContract({
        address: t.market as Address,
        abi: marketAbi,
        functionName: "state",
      }),
    );
    if (st !== RESOLVED_UP && st !== RESOLVED_DOWN && st !== 4) continue;
    if (dryRun) {
      console.log(`would redeem ${t.market}`);
      continue;
    }
    try {
      const before = (await pub.readContract({
        address: dep.collateral ?? "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        abi: mockErc20Abi,
        functionName: "balanceOf",
        args: [me],
      })) as bigint;
      const hash = await wallet!.writeContract({
        address: t.market as Address,
        abi: marketAbi,
        functionName: "redeem",
        chain: undefined,
        account: wallet!.account!,
        gas: 400_000n,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      const after = (await pub.readContract({
        address: dep.collateral ?? "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        abi: mockErc20Abi,
        functionName: "balanceOf",
        args: [me],
      })) as bigint;
      append(
        {
          orderId: t.orderId,
          redeem: rc.status === "success" ? "ok" : "failed",
          payoutUsdc: (after - before).toString(),
        },
        args.log,
      );
    } catch (e) {
      append(
        {
          orderId: t.orderId,
          redeem: "failed",
          redeemError: String(e instanceof Error ? e.message : e).split("\n")[0],
        },
        args.log,
      );
    }
  }

  // 2. one small order per series on its shortest running round
  for (const [label, a] of Object.entries(dep.assets ?? {})) {
    if (a.kind !== "streams") continue;
    const d = Math.min(...args.durations);
    const start = Math.floor(now / d) * d;
    if (!tradable(now, start, d)) continue;
    const market = (await pub.readContract({
      address: dep.marketFactory!,
      abi: (await import("@converge/sdk")).marketFactoryAbi,
      functionName: "getMarket",
      args: [a.assetId, BigInt(d), BigInt(start)],
    })) as Address;
    if (market === "0x0000000000000000000000000000000000000000") {
      console.log(`${label}: round ${start} does not exist yet`);
      continue;
    }
    if (trades.some((t) => t.market.toLowerCase() === market.toLowerCase())) continue; // one order per round
    const spot = await spotOf(label);
    const ladder = await pub.readContract({
      address: venue,
      abi: forwardVenueAbi,
      functionName: "quoteAt",
      args: [market, BigInt(Math.round(spot * 1e8)) * 10n ** 10n, BigInt(now)],
    });
    const side = nextSide(trades.length);
    const ask = askFromLadder(side, {
      quoting: ladder.quoting,
      bids: ladder.bids,
      asks: ladder.asks,
    });
    if (!ask) {
      console.log(`${label}: not quoting (${side})`);
      continue;
    }
    const plan = planBuy({
      side,
      budget: args.orderUsdc,
      priceWad: ask.priceWad,
      slippageBps: 300,
    });
    if (args.spent.v + plan.escrow > args.maxSpend)
      throw new Error("canary spend ceiling reached; stopping");
    console.log(
      `${label} ${side}: ask ${Number(ask.priceWad) / 1e18}, ${plan.shares} shares, escrow ${plan.escrow}`,
    );
    if (dryRun) continue;
    const reward = (await pub.readContract({
      address: venue,
      abi: forwardVenueAbi,
      functionName: "minReward",
    })) as bigint;
    const hash = await wallet!.writeContract({
      address: venue,
      abi: forwardVenueAbi,
      functionName: "placeOrder",
      args: [market, ORDER_KIND[plan.kind], plan.shares, plan.limitWad],
      value: reward,
      chain: undefined,
      account: wallet!.account!,
      gas: 400_000n,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const placed = parseEventLogs({ abi: [placedEvent], logs: rc.logs })[0];
    const id =
      placed?.args.id ??
      ((await pub.readContract({
        address: venue,
        abi: forwardVenueAbi,
        functionName: "nextOrderId",
      })) as bigint) - 1n;
    args.spent.v += plan.escrow;
    const rec: TradeRecord = {
      orderId: id.toString(),
      market,
      series: label,
      side,
      placedAt: now,
      status: "open",
    };
    append(rec, args.log);
    // 3. watch it: the keeper should execute within a few blocks
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_500));
      const head = await pub.getBlockNumber();
      const from = rc.blockNumber;
      const ex = await pub.getLogs({
        address: venue,
        event: executedEvent,
        args: { id },
        fromBlock: from,
        toBlock: head,
      });
      if (ex[0]) {
        const filled = ex[0].args.filled ?? 0n;
        append(
          {
            orderId: rec.orderId,
            status: "executed",
            statusAt: Math.floor(Date.now() / 1000),
            filledShares: filled.toString(),
            costUsdc: (ex[0].args.premium ?? 0n).toString(),
            redeem: "pending",
          },
          args.log,
        );
        break;
      }
      const exp = await pub.getLogs({
        address: venue,
        event: expiredEvent,
        args: { id },
        fromBlock: from,
        toBlock: head,
      });
      if (exp[0]) {
        append(
          {
            orderId: rec.orderId,
            status: "expired",
            statusAt: Math.floor(Date.now() / 1000),
            redeem: "not-needed",
          },
          args.log,
        );
        break;
      }
    }
    const last = readLog(args.log).find((t) => t.orderId === rec.orderId)!;
    if (last.status === "open") {
      // nobody executed it: that is the finding. Refund ourselves so no money is stuck, and record the miss.
      const h2 = await wallet!
        .writeContract({
          address: venue,
          abi: forwardVenueAbi,
          functionName: "expireOrder",
          args: [id],
          chain: undefined,
          account: wallet!.account!,
          gas: 300_000n,
        })
        .catch(() => undefined);
      append(
        {
          orderId: rec.orderId,
          status: "expired",
          fallbackExpired: true,
          redeem: "not-needed",
          statusAt: Math.floor(Date.now() / 1000),
          ...(h2 ? {} : { redeemError: "expire failed" }),
        },
        args.log,
      );
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const once = process.argv.includes("--once");
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is required");
  const key = process.env.CANARY_TRADER_KEY as Hex | undefined;
  if (!dryRun && !key) throw new Error("CANARY_TRADER_KEY is required (not for --dry-run)");
  const network = process.env.NETWORK ?? "mainnet";
  const dep = JSON.parse(
    readFileSync(resolve(repoRoot, "deployments", `${network}.json`), "utf8"),
  ) as Deployment;
  const chain = defineChain({
    id: dep.chainId,
    name: "monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = key ? privateKeyToAccount(key) : undefined;
  const wallet = account ? createWalletClient({ account, chain, transport: http(rpc) }) : undefined;
  const me = (account?.address ?? "0x0000000000000000000000000000000000000001") as Address;
  const durations = JSON.parse(readFileSync(resolve(repoRoot, "config/series.json"), "utf8"))
    .durations as number[];
  const orderUsdc = BigInt(Math.round(Number(process.env.CANARY_ORDER_USDC ?? 1) * 1e6));
  const maxSpend = BigInt(Math.round(Number(process.env.CANARY_MAX_SPEND_USDC ?? 40) * 1e6));
  const spent = { v: 0n };
  if (wallet && key) {
    const usdc = dep.collateral ?? "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
    const allowance = (await pub.readContract({
      address: usdc,
      abi: mockErc20Abi,
      functionName: "allowance",
      args: [me, dep.vault!.forwardVenue],
    })) as bigint;
    if (allowance < 10n ** 12n)
      await pub.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: usdc,
          abi: mockErc20Abi,
          functionName: "approve",
          args: [dep.vault!.forwardVenue, 10n ** 12n],
          chain,
          account: account!,
          gas: 120_000n,
        }),
      });
  }
  const every = Number(process.env.CANARY_INTERVAL_SEC ?? 300) * 1000;
  for (;;) {
    await runOnce({
      pub: pub as PublicClient,
      wallet,
      me,
      dep,
      dryRun,
      orderUsdc,
      spent,
      maxSpend,
      durations,
    });
    if (once) return;
    await new Promise((r) => setTimeout(r, every));
  }
}

if (process.argv[1]?.endsWith("trader.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
