/**
 * TESTNET ONLY. Creates, opens and resolves the 15-minute TEST/USD rounds on Monad testnet for the live
 * keeper and the app, with price reports signed by the TEST signer of the MockStreamsVerifierProxy
 * (testnet has no Data Streams verifier). The price is the keeper's own reference (median of Binance and
 * Coinbase ETH/USD, from the local relay), the market the keeper and the app read, so strikes and outcomes are real-looking. It is the job of
 * services/scheduler, on the one asset the testnet deployment has.
 *
 *   pnpm --filter @converge/keeper exec tsx scripts/testnet-scheduler.ts      (reads ../../.env, never prints a key)
 * Cost: about 0.25 MON per round (Monad bills the gas limit), paid by the deployer key (it holds CREATOR_ROLE).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dataStreamsResolverAbi,
  marketAbi,
  marketFactoryAbi,
  signTestReportSync,
} from "@converge/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = (k: string): string => {
  const line = readFileSync(`${root}.env`, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing in .env`);
  return line.slice(k.length + 1).trim();
};
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8")) as {
  marketFactory: Address;
  dataStreamsResolver: Address;
  assetTEST: Hex;
  testFeedId: Hex;
  finalizationWindow: number;
};
const rpc = process.env.RPC_URL ?? "https://rpc-testnet.monadinfra.com";
const chain = defineChain({
  id: 10143,
  name: "Monad testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({
  account: privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex),
  chain,
  transport: http(rpc),
});
const signer = env("STREAMS_TEST_SIGNER_KEY") as Hex;
const DURATION = 900;
const ZERO = "0x0000000000000000000000000000000000000000";
const log = (s: string) => console.log(`[sched ${new Date().toISOString().slice(11, 19)}] ${s}`);

let lastPrice = { v: 0, at: 0 };
/** The keeper's own reference price (median of Binance and Coinbase, via the local relay), so the strikes and
 *  end prices the oracle reports are on the same basis the keeper quotes from; Coinbase alone if the relay is down. */
async function price(): Promise<number> {
  if (Date.now() - lastPrice.at < 1500 && lastPrice.v) return lastPrice.v;
  let v: number;
  try {
    v = (
      (await (
        await fetch("http://127.0.0.1:9203/price", { signal: AbortSignal.timeout(2000) })
      ).json()) as { price: number }
    ).price;
  } catch {
    const r = await fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker", {
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { bid: string; ask: string };
    v = (Number(j.bid) + Number(j.ask)) / 2;
  }
  lastPrice = { v, at: Date.now() };
  return v;
}
const report = (ts: number, px: number) =>
  signTestReportSync(signer, dep.testFeedId, BigInt(ts), BigInt(Math.round(px * 1e8)) * 10n ** 10n);

async function send(req: {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}) {
  const gas = await pub.estimateContractGas({ ...req, account: wallet.account } as never);
  const hash = await wallet.writeContract({
    ...req,
    chain,
    gas: (gas * 115n) / 100n,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${req.functionName} reverted (${hash})`);
}

const done = new Set<string>();
const once = async (key: string, fn: () => Promise<unknown>) => {
  if (done.has(key)) return;
  try {
    await fn();
    done.add(key);
  } catch (e) {
    log(`${key}: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
    // do not hammer a failing call every tick
    done.add(`${key}:retry@${Math.floor(Date.now() / 20000)}`);
  }
};
const due = (key: string) => !done.has(`${key}:retry@${Math.floor(Date.now() / 20000)}`);

async function tick() {
  const t = Number((await pub.getBlock()).timestamp);
  const cur = Math.floor(t / DURATION) * DURATION;
  const starts = [-3, -2, -1, 0, 1, 2].map((k) => cur + k * DURATION);
  // two multicalls for the whole picture (the public RPC takes about a second a call: one call per
  // market and per field made a tick take 20 s and the rounds open minutes late)
  const addrs = (await pub.multicall({
    allowFailure: false,
    contracts: starts.map((s) => ({
      address: dep.marketFactory,
      abi: marketFactoryAbi,
      functionName: "getMarket" as const,
      args: [dep.assetTEST, BigInt(DURATION), BigInt(s)] as const,
    })),
  })) as Address[];
  const live = addrs.map((a, i) => ({ a, start: starts[i]! })).filter((x) => x.a !== ZERO);
  const states = live.length
    ? ((await pub.multicall({
        allowFailure: false,
        contracts: live.map((x) => ({
          address: x.a,
          abi: marketAbi,
          functionName: "state" as const,
        })),
      })) as number[])
    : [];
  const stateOf = new Map(live.map((x, i) => [x.start, { market: x.a, state: Number(states[i]) }]));

  for (const start of starts) {
    const end = start + DURATION;
    const label = new Date(start * 1000).toISOString().slice(11, 16);
    const m = stateOf.get(start);
    if (!m) {
      if (start <= t || !due(`create:${start}`)) continue; // a round can only be created before its start
      await once(`create:${start}`, async () => {
        await send({
          address: dep.marketFactory,
          abi: marketFactoryAbi,
          functionName: "createMarket",
          args: [dep.assetTEST, BigInt(DURATION), BigInt(start)],
        });
        log(`created round ${label}`);
      });
      continue;
    }
    if (m.state === 0 && t >= start) {
      if (due(`propose-open:${start}`))
        await once(`propose-open:${start}`, async () =>
          send({
            address: dep.dataStreamsResolver,
            abi: dataStreamsResolverAbi,
            functionName: "submit",
            args: [dep.assetTEST, BigInt(start), report(start, await price())],
          }),
        );
      if (
        done.has(`propose-open:${start}`) &&
        t >= start + dep.finalizationWindow + 2 &&
        due(`open:${start}`)
      )
        await once(`open:${start}`, async () => {
          await send({ address: m.market, abi: marketAbi, functionName: "open", args: ["0x"] });
          log(`round ${label} opened`);
        });
    }
    if (m.state === 1 && t >= end) {
      if (due(`propose-end:${start}`))
        await once(`propose-end:${start}`, async () =>
          send({
            address: dep.dataStreamsResolver,
            abi: dataStreamsResolverAbi,
            functionName: "submit",
            args: [dep.assetTEST, BigInt(end), report(end, await price())],
          }),
        );
      if (
        done.has(`propose-end:${start}`) &&
        t >= end + dep.finalizationWindow + 2 &&
        due(`resolve:${start}`)
      )
        await once(`resolve:${start}`, async () => {
          await send({ address: m.market, abi: marketAbi, functionName: "resolve", args: ["0x"] });
          log(`round ${label} resolved`);
        });
    }
  }
}

/**
 * Rounds older than the tick's window that never settled (the scheduler was down, the machine slept) would
 * stay open forever and hold people's bets. Every minute, look back 24 h and `invalidate()` any round whose
 * price boundary can never be determined: it pays 50 cents a share, so nobody is stuck. Anything the
 * contract refuses (still resolvable) is left alone and retried only every 10 minutes.
 */
let lastSweep = 0;
const skipUntil = new Map<string, number>();
async function sweep() {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  const t = Number((await pub.getBlock()).timestamp);
  const cur = Math.floor(t / DURATION) * DURATION;
  const starts = Array.from({ length: 92 }, (_, i) => cur - (i + 4) * DURATION);
  const addrs = (await pub.multicall({
    allowFailure: false,
    contracts: starts.map((st) => ({
      address: dep.marketFactory,
      abi: marketFactoryAbi,
      functionName: "getMarket" as const,
      args: [dep.assetTEST, BigInt(DURATION), BigInt(st)] as const,
    })),
  })) as Address[];
  const live = addrs.map((a, i) => ({ a, start: starts[i]! })).filter((x) => x.a !== ZERO);
  if (!live.length) return;
  const states = (await pub.multicall({
    allowFailure: false,
    contracts: live.map((x) => ({ address: x.a, abi: marketAbi, functionName: "state" as const })),
  })) as number[];
  for (const [i, x] of live.entries()) {
    const stt = Number(states[i]);
    if (stt > 1 || (skipUntil.get(x.a) ?? 0) > Date.now()) continue;
    try {
      await send({ address: x.a, abi: marketAbi, functionName: "invalidate", args: [] });
      log(`closed out stuck round ${new Date(x.start * 1000).toISOString().slice(5, 16)}Z (invalidated, pays 50c a share)`);
    } catch {
      skipUntil.set(x.a, Date.now() + 600_000);
    }
  }
}

log(`scheduler for TEST/USD on testnet; factory ${dep.marketFactory}`);
for (;;) {
  try {
    await tick();
    await sweep();
  } catch (e) {
    log(`tick: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
