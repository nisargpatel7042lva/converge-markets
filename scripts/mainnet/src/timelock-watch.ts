/**
 * Announces every owner action the moment it is scheduled on the OwnerTimelock, and when it is
 * executed or cancelled. The 24 h delay only protects LPs if somebody sees the operation: this
 * tells the people on call (Discord and Telegram, the same channels as the alerts).
 *
 *   RPC_URL=... NETWORK=mainnet [ALERT_WEBHOOK_URL=...] [TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...] \
 *     pnpm --filter @converge/mainnet timelock-watch [--once] [--from-block N]
 *
 * It keeps the last block it has seen in deployments/generated/<network>/timelock-watch.json, so a
 * restart repeats nothing and misses nothing.
 */
import {
  chainlinkRoundResolverAbi,
  convergeVaultAbi,
  dataStreamsResolverAbi,
  marketFactoryAbi,
  partnerRegistryAbi,
  schedulerReceiverAbi,
} from "@converge/sdk";
import {
  decodeFunctionData,
  parseAbi,
  parseAbiItem,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { timelockAbi } from "./safe";

export const scheduledEvent = parseAbiItem(
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
);
export const executedEvent = parseAbiItem(
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
);
export const cancelledEvent = parseAbiItem("event Cancelled(bytes32 indexed id)");
export const delayEvent = parseAbiItem(
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
);

const ownable = parseAbi(["function acceptOwnership()", "function transferOwnership(address)"]);
const KNOWN: [string, Abi][] = [
  ["ConvergeVault", convergeVaultAbi as Abi],
  ["DataStreamsResolver", dataStreamsResolverAbi as Abi],
  ["ChainlinkRoundResolver", chainlinkRoundResolverAbi as Abi],
  ["PartnerRegistry", partnerRegistryAbi as Abi],
  ["MarketFactory", marketFactoryAbi as Abi],
  ["SchedulerReceiver", schedulerReceiverAbi as Abi],
  ["OwnerTimelock", timelockAbi as Abi],
  ["Ownable", ownable as Abi],
];

/** "ConvergeVault.setKeeper(0xabc…)" for known calls, the raw selector otherwise. */
export function describeCall(data: Hex): string {
  for (const [name, abi] of KNOWN) {
    try {
      const d = decodeFunctionData({ abi, data });
      const args = (d.args ?? [])
        .map((a) =>
          typeof a === "bigint"
            ? a.toString()
            : JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
        )
        .join(", ");
      return `${name}.${d.functionName}(${args})`;
    } catch {
      /* not this ABI */
    }
  }
  return `unknown call ${data.slice(0, 10)}`;
}

export interface WatchEvent {
  kind: "scheduled" | "executed" | "cancelled" | "delay-changed";
  id?: Hex;
  block: bigint;
  /** Scheduled: when it becomes executable (unix seconds). */
  readyAt?: number;
  text: string;
}

/** Reads the timelock's events in [from, to] (paged) and turns them into messages. */
export async function pollOnce(
  pub: PublicClient,
  timelock: Address,
  from: bigint,
  to: bigint,
  blockTime: (b: bigint) => Promise<number>,
  pageSize = 5_000n,
): Promise<WatchEvent[]> {
  const out: WatchEvent[] = [];
  for (let a = from; a <= to; a += pageSize) {
    const b = a + pageSize - 1n > to ? to : a + pageSize - 1n;
    const [sched, exec, canc, delay] = await Promise.all([
      pub.getLogs({ address: timelock, event: scheduledEvent, fromBlock: a, toBlock: b }),
      pub.getLogs({ address: timelock, event: executedEvent, fromBlock: a, toBlock: b }),
      pub.getLogs({ address: timelock, event: cancelledEvent, fromBlock: a, toBlock: b }),
      pub.getLogs({ address: timelock, event: delayEvent, fromBlock: a, toBlock: b }),
    ]);
    for (const l of sched) {
      const at = await blockTime(l.blockNumber!);
      const readyAt = at + Number(l.args.delay);
      out.push({
        kind: "scheduled",
        id: l.args.id,
        block: l.blockNumber!,
        readyAt,
        text: `OWNER ACTION SCHEDULED: ${describeCall(l.args.data!)} on ${l.args.target}. Executable from ${new Date(readyAt * 1000).toISOString()} (operation ${l.args.id}, call ${l.args.index}). If you did not expect this, pause and tell the other signers.`,
      });
    }
    for (const l of exec)
      out.push({
        kind: "executed",
        id: l.args.id,
        block: l.blockNumber!,
        text: `OWNER ACTION EXECUTED: ${describeCall(l.args.data!)} on ${l.args.target} (operation ${l.args.id}).`,
      });
    for (const l of canc)
      out.push({
        kind: "cancelled",
        id: l.args.id,
        block: l.blockNumber!,
        text: `OWNER ACTION CANCELLED: operation ${l.args.id}.`,
      });
    for (const l of delay)
      out.push({
        kind: "delay-changed",
        block: l.blockNumber!,
        text: `TIMELOCK DELAY CHANGED: ${l.args.oldDuration} s -> ${l.args.newDuration} s.`,
      });
  }
  return out.sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : 0));
}

export interface Notifier {
  send(text: string): Promise<void>;
}

/** Discord webhook and/or Telegram bot; delivery errors are thrown so a missed announcement is loud. */
export function webhookNotifier(env: NodeJS.ProcessEnv, f: typeof fetch = fetch): Notifier {
  const sends: ((t: string) => Promise<void>)[] = [];
  if (env.ALERT_WEBHOOK_URL)
    sends.push(async (t) => {
      const r = await f(env.ALERT_WEBHOOK_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `[converge-timelock] ${t}` }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`Discord answered ${r.status}`);
    });
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    sends.push(async (t) => {
      const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `[converge-timelock] ${t}` }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`Telegram answered ${r.status}`);
    });
  if (sends.length === 0)
    throw new Error(
      "no channel configured: set ALERT_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID",
    );
  return {
    async send(raw) {
      // Discord rejects over 2,000 characters and Telegram over 4,096: a hostile operation with a huge
      // argument must still be announced, so the text is cut and the operation id (at the end of the
      // message) is kept.
      const text = raw.length > 1500 ? `${raw.slice(0, 1200)} … [cut] … ${raw.slice(-250)}` : raw;
      const results = await Promise.allSettled(sends.map((s) => s(text)));
      const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (bad.length === results.length)
        throw new Error(`no channel delivered: ${bad.map((b) => String(b.reason)).join("; ")}`);
      if (bad.length)
        console.error(`one channel failed: ${bad.map((b) => String(b.reason)).join("; ")}`);
    },
  };
}

async function main() {
  const { createPublicClient, defineChain, http } = await import("viem");
  const { mkdirSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { repoRoot } = await import("./params");
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is required");
  const network = process.env.NETWORK ?? "mainnet";
  const dep = JSON.parse(
    readFileSync(resolve(repoRoot, "deployments", `${network}.json`), "utf8"),
  ) as import("./state").Deployment;
  if (!dep.timelock) throw new Error("the deployment has no timelock");
  const pub = createPublicClient({
    chain: defineChain({
      id: dep.chainId,
      name: "monad",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    }),
    transport: http(rpc),
  });
  const notifier = webhookNotifier(process.env);
  const stateFile = resolve(repoRoot, "deployments/generated", network, "timelock-watch.json");
  const fromArg = process.argv.indexOf("--from-block");
  let next =
    fromArg > 0
      ? BigInt(process.argv[fromArg + 1]!)
      : existsSync(stateFile)
        ? BigInt((JSON.parse(readFileSync(stateFile, "utf8")) as { next: string }).next)
        : BigInt(dep.deployBlock ?? 0);
  const times = new Map<bigint, number>();
  const blockTime = async (b: bigint) => {
    if (!times.has(b)) times.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp));
    return times.get(b)!;
  };
  const once = process.argv.includes("--once");
  for (;;) {
    const head = await pub.getBlockNumber();
    if (head >= next) {
      for (const e of await pollOnce(pub, dep.timelock, next, head, blockTime)) {
        console.log(e.text);
        // never let one undeliverable message stop the watch: retry, then say so loudly and go on
        let sent = false;
        for (let i = 0; i < 3 && !sent; i++) {
          try {
            await notifier.send(e.text);
            sent = true;
          } catch (err) {
            console.error(`announcement failed (attempt ${i + 1}): ${String(err)}`);
            await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
          }
        }
        if (!sent)
          console.error(
            `ANNOUNCEMENT NOT DELIVERED for operation ${e.id ?? "(none)"}: tell the other signers by hand`,
          );
      }
      next = head + 1n;
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ next: next.toString() }) + "\n");
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

if (process.argv[1]?.endsWith("timelock-watch.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
