/**
 * Round and taker driver for the testnet run (the keeper itself never creates or opens rounds):
 *
 *   - creates the next rounds of TEST/USD (15 min, grid aligned) ahead of time,
 *   - at each round start submits the strike report (TEST-ONLY: signed by the test signer, priced
 *     from the relay's live mid) and opens the round once the finalization window has passed,
 *   - deposits LP money once, so the vault has a NAV,
 *   - places a small taker order every ORDER_EVERY_S seconds while a round is tradable.
 *
 * The keeper resolves the rounds, settles the epochs, quotes and executes orders on its own.
 * Keys are read from the repo .env and never printed. Every action is one JSON log line.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  marketFactoryAbi,
  mockErc20Abi,
  dataStreamsResolverAbi,
  signTestReportSync,
} from "@converge/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const envFile = readFileSync(resolve(root, ".env"), "utf8");
const secret = (name: string): Hex => {
  const v = envFile
    .split("\n")
    .find((l) => l.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
  if (!v) throw new Error(`${name} missing in .env`);
  return v as Hex;
};

const dep = JSON.parse(readFileSync(resolve(root, "deployments/testnet.json"), "utf8"));
const rpc = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const relay = process.env.RELAY_URL ?? "http://127.0.0.1:9203";
const orderEveryS = Number(process.env.ORDER_EVERY_S ?? "300");
const depositUsd = BigInt(process.env.DEPOSIT_USD ?? "1000");
const takerFund = process.env.TAKER_FUND_MON ?? "0.4";
const logFile = process.env.DRIVER_LOG ?? "";

const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const transport = http(rpc, { timeout: 30_000, retryCount: 6, retryDelay: 1_000 });
const pub = createPublicClient({ chain, transport });
const owner = privateKeyToAccount(secret("DEPLOYER_PRIVATE_KEY"));
const signerKey = secret("STREAMS_TEST_SIGNER_KEY");
const takerKeyFile = resolve(here, "../.taker-key"); // gitignored
if (!existsSync(takerKeyFile)) writeFileSync(takerKeyFile, generatePrivateKey(), { mode: 0o600 });
const taker = privateKeyToAccount(readFileSync(takerKeyFile, "utf8").trim() as Hex);
const wallet = (a: typeof owner) => createWalletClient({ account: a, chain, transport });

const A = {
  tusdc: dep.collateral_tUSDC as Address,
  factory: dep.marketFactory as Address,
  streams: dep.dataStreamsResolver as Address,
  vault: dep.vault.vault as Address,
  venue: dep.vault.forwardVenue as Address,
};
const TEST = keccak256(stringToHex("TEST/USD"));
const TEST_FEED = dep.testFeedId as Hex;
const U = 1_000_000n;
const WAD = 10n ** 18n;
const DUR = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (o: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
};

let gasSpent = 0n;
async function send(
  label: string,
  a: typeof owner,
  req: Record<string, unknown>,
): Promise<boolean> {
  try {
    const gas = await pub.estimateContractGas({ ...(req as object), account: a } as never);
    const hash = await wallet(a).writeContract({
      ...(req as object),
      gas: (gas * 115n) / 100n,
    } as never);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 500 });
    gasSpent += r.gasUsed * r.effectiveGasPrice;
    log({ ev: label, hash, block: r.blockNumber.toString(), status: r.status });
    return r.status === "success";
  } catch (e) {
    log({ ev: `${label} failed`, err: String(e).split("\n")[0]?.slice(0, 160) });
    return false;
  }
}

async function livePrice(): Promise<bigint> {
  const j = (await (await fetch(`${relay}/price`)).json()) as { price: number | null };
  if (!j.price) throw new Error("relay has no price yet");
  return BigInt(Math.round(j.price * 1e8)) * 10n ** 10n;
}

const chainNow = async () => Number((await pub.getBlock()).timestamp);
const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

type Round = { start: number; market: Address; strike: boolean; opened: boolean };
const rounds = new Map<number, Round>();
let lastOrder = 0;
let orders = 0;

async function ensureRounds(now: number) {
  const first = (Math.floor(now / DUR) + 1) * DUR;
  for (const s of [first - DUR, first, first + DUR]) {
    if (rounds.has(s)) continue;
    let market = await read<Address>(A.factory, marketFactoryAbi, "getMarket", [
      TEST,
      BigInt(DUR),
      BigInt(s),
    ]);
    if (market === "0x0000000000000000000000000000000000000000") {
      if (s < now) continue; // too late to create
      const ok = await send("createMarket", owner, {
        address: A.factory,
        abi: marketFactoryAbi,
        functionName: "createMarket",
        args: [TEST, BigInt(DUR), BigInt(s)],
      });
      if (!ok) continue;
      market = await read<Address>(A.factory, marketFactoryAbi, "getMarket", [
        TEST,
        BigInt(DUR),
        BigInt(s),
      ]);
    }
    const state = await read<number>(market, marketAbi, "state");
    rounds.set(s, { start: s, market, strike: Number(state) > 0, opened: Number(state) > 0 });
    log({ ev: "round tracked", start: s, market, state: Number(state) });
  }
}

async function advance(r: Round, now: number) {
  if (r.opened || now < r.start) return;
  if (!r.strike) {
    const px = await livePrice();
    r.strike = await send("strike report", owner, {
      address: A.streams,
      abi: dataStreamsResolverAbi,
      functionName: "submit",
      args: [TEST, BigInt(r.start), signTestReportSync(signerKey, TEST_FEED, BigInt(r.start), px)],
    });
    return;
  }
  const opened = await send("open round", owner, {
    address: r.market,
    abi: marketAbi,
    functionName: "open",
    args: ["0x"],
  });
  if (opened) r.opened = true;
}

async function takerOrder(r: Round, now: number) {
  const kind = orders % 2; // alternate BUY_UP (0) and BUY_DOWN (2)
  const shares = BigInt(1 + (orders % 3)) * U;
  const limit = (9n * WAD) / 10n;
  const ok = await send("taker order", taker, {
    address: A.venue,
    abi: forwardVenueAbi,
    functionName: "placeOrder",
    args: [r.market, kind === 0 ? 0 : 2, shares, limit],
    value: parseEther("0.001"),
  });
  if (ok) orders += 1;
  lastOrder = now;
}

async function setup() {
  log({ ev: "driver start", owner: owner.address, taker: taker.address, vault: A.vault });
  const bal = await pub.getBalance({ address: taker.address });
  if (bal < parseEther("0.1")) {
    const hash = await wallet(owner).sendTransaction({
      to: taker.address,
      value: parseEther(takerFund),
    });
    await pub.waitForTransactionReceipt({ hash });
    log({ ev: "taker funded", mon: takerFund, hash });
  }
  // the taker mints collateral once (open mint) and approves the venue for everything
  const allowance = await read<bigint>(A.tusdc, mockErc20Abi, "allowance", [
    taker.address,
    A.venue,
  ]);
  if (allowance < 10n ** 12n) {
    await send("taker mint", taker, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [taker.address, 100_000n * U],
    });
    await send("taker approve", taker, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [A.venue, 2n ** 255n],
    });
  }
  const shares = await read<bigint>(A.vault, convergeVaultAbi, "totalSupply");
  if (shares <= 1000n && process.env.SKIP_DEPOSIT !== "1") {
    const e = await read<bigint>(A.vault, convergeVaultAbi, "currentEpoch");
    const end = Number(await read<bigint>(A.vault, convergeVaultAbi, "epochEnd", [e]));
    if (end - (await chainNow()) < 120) await sleep(125_000); // settle needs the epoch to be young
    await send("lp mint", owner, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [owner.address, depositUsd * U],
    });
    await send("lp approve", owner, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [A.vault, depositUsd * U],
    });
    await send("lp requestDeposit", owner, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "requestDeposit",
      args: [depositUsd * U],
    });
  }
}

await setup();
for (;;) {
  try {
    const now = await chainNow();
    await ensureRounds(now);
    for (const r of rounds.values()) await advance(r, now);
    const live = [...rounds.values()].find(
      (r) => r.opened && now >= r.start + 30 && now < r.start + DUR - 90,
    );
    if (live && now - lastOrder >= orderEveryS) {
      const view = await read<{ tradable: boolean }>(A.vault, convergeVaultAbi, "venueView", [
        live.market,
      ]);
      if (view.tradable) await takerOrder(live, now);
    }
    for (const s of [...rounds.keys()]) if (s + DUR + 120 < now) rounds.delete(s);
  } catch (e) {
    log({ ev: "loop error", err: String(e).split("\n")[0]?.slice(0, 200) });
  }
  log({ ev: "tick", orders, driverGasMon: Number(gasSpent) / 1e18 });
  await sleep(10_000);
}
