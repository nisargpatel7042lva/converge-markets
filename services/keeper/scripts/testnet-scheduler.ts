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
  assetIdOf,
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
/** A secret from the process environment (a container host's secrets), else from the repo's .env. */
const env = (k: string): string => {
  const fromProcess = process.env[k];
  if (fromProcess) return fromProcess.trim();
  const line = readFileSync(`${root}.env`, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing in the environment and in .env`);
  return line.slice(k.length + 1).trim();
};
/** The key that creates rounds: a dedicated SCHEDULER_PRIVATE_KEY (it needs only the factory's CREATOR_ROLE and
 *  gas) when set, otherwise the deployer's. */
const schedulerKey = (): string => {
  try {
    return env("SCHEDULER_PRIVATE_KEY");
  } catch {
    return env("DEPLOYER_PRIVATE_KEY");
  }
};
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8")) as {
  marketFactory: Address;
  dataStreamsResolver: Address;
  assetTEST: Hex;
  testFeedId: Hex;
  finalizationWindow: number;
};
/** One series per asset: ETH is the original TEST/USD asset, BTC and MON were added by testnet-add-assets.ts. */
type Series = { name: string; assetId: Hex; feedId: Hex; relay: string; coinbase: string };
const SERIES: Series[] = [
  {
    name: "ETH",
    assetId: dep.assetTEST,
    feedId: dep.testFeedId,
    relay: "ETH",
    coinbase: "ETH-USD",
  },
  {
    name: "BTC",
    assetId: assetIdOf("TEST-BTC/USD"),
    feedId: "0x0003000000000000000000000000000000000000000000000000000000000002",
    relay: "BTC",
    coinbase: "BTC-USD",
  },
  {
    name: "MON",
    assetId: assetIdOf("TEST-MON/USD"),
    feedId: "0x0003000000000000000000000000000000000000000000000000000000000003",
    relay: "MON",
    coinbase: "MON-USD",
  },
];
const only = (process.env.SERIES ?? "ETH,BTC,MON").split(",").map((x) => x.trim());
const active = SERIES.filter((x) => only.includes(x.name));

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
  account: privateKeyToAccount(schedulerKey() as Hex),
  chain,
  transport: http(rpc),
});
const signer = env("STREAMS_TEST_SIGNER_KEY") as Hex;
const DURATION = 900;
const ZERO = "0x0000000000000000000000000000000000000000";
const log = (s: string) => console.log(`[sched ${new Date().toISOString().slice(11, 19)}] ${s}`);

const lastPrice = new Map<string, { v: number; at: number }>();
/** The keeper's own reference price (median of two exchanges, via the local relay), so the strikes and
 *  end prices the oracle reports are on the same basis the keeper quotes from; Coinbase alone if the relay is down. */
async function price(x: Series): Promise<number> {
  const c = lastPrice.get(x.name);
  if (c && Date.now() - c.at < 1500) return c.v;
  let v: number | null = null;
  try {
    v = (
      (await (
        await fetch(`http://127.0.0.1:9203/price?asset=${x.relay}`, {
          signal: AbortSignal.timeout(2000),
        })
      ).json()) as { price: number | null }
    ).price;
  } catch {
    v = null;
  }
  if (!v) {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${x.coinbase}/ticker`, {
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { bid: string; ask: string };
    v = (Number(j.bid) + Number(j.ask)) / 2;
  }
  lastPrice.set(x.name, { v, at: Date.now() });
  return v;
}
const report = (x: Series, ts: number, px: number) =>
  signTestReportSync(signer, x.feedId, BigInt(ts), BigInt(Math.round(px * 1e8)) * 10n ** 10n);

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

async function tick(x: Series) {
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
      args: [x.assetId, BigInt(DURATION), BigInt(s)] as const,
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
      if (start <= t || !due(`${x.name}:create:${start}`)) continue; // a round can only be created before its start
      await once(`${x.name}:create:${start}`, async () => {
        await send({
          address: dep.marketFactory,
          abi: marketFactoryAbi,
          functionName: "createMarket",
          args: [x.assetId, BigInt(DURATION), BigInt(start)],
        });
        log(`${x.name}: created round ${label}`);
      });
      continue;
    }
    // A round more than 3 minutes past its boundary is beyond the oracle's window: retrying cannot save it, and the
    // sweep below invalidates it (50 cents a share) instead.
    const LATE_GIVE_UP = 180;
    if (m.state === 0 && t >= start && t < start + LATE_GIVE_UP) {
      if (due(`${x.name}:propose-open:${start}`))
        await once(`${x.name}:propose-open:${start}`, async () =>
          send({
            address: dep.dataStreamsResolver,
            abi: dataStreamsResolverAbi,
            functionName: "submit",
            args: [x.assetId, BigInt(start), report(x, start, await price(x))],
          }),
        );
      if (
        done.has(`${x.name}:propose-open:${start}`) &&
        t >= start + dep.finalizationWindow + 2 &&
        due(`${x.name}:open:${start}`)
      )
        await once(`${x.name}:open:${start}`, async () => {
          await send({ address: m.market, abi: marketAbi, functionName: "open", args: ["0x"] });
          log(`${x.name}: round ${label} opened`);
        });
    }
    if (m.state === 1 && t >= end && t < end + LATE_GIVE_UP) {
      if (due(`${x.name}:propose-end:${start}`))
        await once(`${x.name}:propose-end:${start}`, async () =>
          send({
            address: dep.dataStreamsResolver,
            abi: dataStreamsResolverAbi,
            functionName: "submit",
            args: [x.assetId, BigInt(end), report(x, end, await price(x))],
          }),
        );
      if (
        done.has(`${x.name}:propose-end:${start}`) &&
        t >= end + dep.finalizationWindow + 2 &&
        due(`${x.name}:resolve:${start}`)
      )
        await once(`${x.name}:resolve:${start}`, async () => {
          await send({ address: m.market, abi: marketAbi, functionName: "resolve", args: ["0x"] });
          log(`${x.name}: round ${label} resolved`);
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
const lastSweep = new Map<string, number>();
const skipUntil = new Map<string, number>();
async function sweep(x: Series) {
  if (Date.now() - (lastSweep.get(x.name) ?? 0) < 60_000) return;
  lastSweep.set(x.name, Date.now());
  const t = Number((await pub.getBlock()).timestamp);
  const cur = Math.floor(t / DURATION) * DURATION;
  const starts = Array.from({ length: 92 }, (_, i) => cur - (i + 4) * DURATION);
  const addrs = (await pub.multicall({
    allowFailure: false,
    contracts: starts.map((st) => ({
      address: dep.marketFactory,
      abi: marketFactoryAbi,
      functionName: "getMarket" as const,
      args: [x.assetId, BigInt(DURATION), BigInt(st)] as const,
    })),
  })) as Address[];
  const live = addrs.map((a, i) => ({ a, start: starts[i]! })).filter((x) => x.a !== ZERO);
  if (!live.length) return;
  const states = (await pub.multicall({
    allowFailure: false,
    contracts: live.map((x) => ({ address: x.a, abi: marketAbi, functionName: "state" as const })),
  })) as number[];
  for (const [i, r] of live.entries()) {
    const stt = Number(states[i]);
    if (stt > 1 || (skipUntil.get(r.a) ?? 0) > Date.now()) continue;
    try {
      await send({ address: r.a, abi: marketAbi, functionName: "invalidate", args: [] });
      log(
        `${x.name}: closed out stuck round ${new Date(r.start * 1000).toISOString().slice(5, 16)}Z (invalidated, pays 50c a share)`,
      );
    } catch {
      skipUntil.set(r.a, Date.now() + 600_000);
    }
  }
}

log(
  `scheduler for ${active.map((x) => x.name).join(", ")} on testnet; factory ${dep.marketFactory}`,
);
for (;;) {
  for (const x of active) {
    try {
      await tick(x);
      await sweep(x);
    } catch (e) {
      log(`${x.name} tick: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}
