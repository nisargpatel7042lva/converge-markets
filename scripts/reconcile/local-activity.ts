/**
 * LOCAL anvil activity generator (labelled MOCK PRICES, local chain 31337, anvil dev keys).
 *
 * Deploys the full Phase 1-4 stack (tUSDC, MarketFactory, DataStreamsResolver over the TEST-signer
 * mock verifier, ConvergeVault, ForwardVenue) from the forge artifacts in contracts/out, then runs a
 * scripted, seeded history so the indexer has every entity type to index and reconcile:
 *   - R 15-minute rounds on BTC/USD and ETH/USD (2 markets per boundary), opened, traded, resolved
 *   - LP deposits / redemptions across epochs, one epoch left to EXPIRE, requeued redemptions
 *   - takers placing BUY/SELL orders, executed with reports for the pricing second, some expired
 *   - token and share transfers between users, pause/resume and keeper halt/unhalt
 * Time is warped with anvil (evm_setNextBlockTimestamp), so hours of chain time take seconds.
 *
 * Usage:  anvil --port 8611 &        (then)
 *         pnpm --filter @converge/reconcile local:activity
 * Env:    LOCAL_RPC (default http://127.0.0.1:8611), ROUNDS (default 14), SEED (default 7),
 *         OUT_DIR (default <repo>/.local-indexer)
 * Output: <OUT_DIR>/addresses.json (chain id, contract addresses, deploy blocks, users, markets).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { signTestReportSync } from "@converge/sdk";
import {
  decodeEventLog,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { accountOf, artifact, localClients, ROOT } from "./lib/chain";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8611";
const ROUNDS = Number(process.env.ROUNDS ?? 14);
const SEED = Number(process.env.SEED ?? 7);
const OUT_DIR = process.env.OUT_DIR ?? resolve(ROOT, ".local-indexer");

const { pub, test, wallet } = localClients(RPC);
const U = 1_000_000n;
const WAD = 10n ** 18n;
const DAY = 900n;

// ---- deterministic randomness
let rngState = SEED >>> 0;
const rand = () => {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 2 ** 32;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// ---- accounts
const deployer = accountOf(0); // owner, guardian, treasury, creator, LP
const keeper = accountOf(1);
const signerAcct = accountOf(2);
const lp1 = accountOf(3);
const lp2 = accountOf(4);
const takers = [accountOf(5), accountOf(6), accountOf(7), accountOf(8), accountOf(9)];
const signerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

// ---- chain helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function nowTs(): Promise<bigint> {
  return (await pub.getBlock()).timestamp;
}
async function warp(ts: bigint): Promise<void> {
  if (ts > (await nowTs())) {
    await test.setNextBlockTimestamp({ timestamp: ts });
    await test.mine({ blocks: 1 });
  }
}
let txCount = 0;
async function send(
  account: Account,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  opts: { value?: bigint; at?: bigint } = {},
) {
  if (opts.at !== undefined) {
    const cur = await nowTs();
    await test.setNextBlockTimestamp({ timestamp: opts.at > cur ? opts.at : cur + 1n });
  }
  const hash = await wallet(account).writeContract({
    address,
    abi,
    functionName,
    args,
    value: opts.value,
  } as never);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${functionName} reverted`);
  txCount++;
  return rcpt;
}
/** Like send, but returns false instead of throwing (calls that are allowed to fail, e.g. nothing to claim). */
async function trySend(...a: Parameters<typeof send>): Promise<boolean> {
  try {
    await send(...a);
    return true;
  } catch {
    return false;
  }
}
const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

async function deploy(account: Account, name: string, args: readonly unknown[]): Promise<Address> {
  const a = artifact(name);
  const hash = await wallet(account).deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args,
  } as never);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (!rcpt.contractAddress) throw new Error(`${name} deploy failed`);
  txCount++;
  return rcpt.contractAddress;
}

// ---- main
const abis = {
  erc20: artifact("MockERC20").abi,
  factory: artifact("MarketFactory").abi,
  streams: artifact("DataStreamsResolver").abi,
  vault: artifact("ConvergeVault").abi,
  venue: artifact("ForwardVenue").abi,
  market: artifact("Market").abi,
};

const ASSETS = [
  {
    label: "BTC",
    id: keccak256(stringToHex("BTC/USD")),
    feed: "0x0003000000000000000000000000000000000000000000000000000000000b7c" as Hex,
    price: 65_000n * WAD,
    sigma: (6n * WAD) / 10n,
  },
  {
    label: "ETH",
    id: keccak256(stringToHex("ETH/USD")),
    feed: "0x0003000000000000000000000000000000000000000000000000000000000e7e" as Hex,
    price: 3_000n * WAD,
    sigma: (7n * WAD) / 10n,
  },
] as const;

const launchParams = {
  minHalfSpread: 5n * 10n ** 16n,
  maxHalfSpread: 2n * 10n ** 17n,
  volSpreadK: WAD,
  stalenessSec: 4n * WAD,
  inventorySkewMax: 10n ** 17n,
  inventorySkewK: 2n * WAD,
  noQuoteWindowSec: 30n,
  priceMin: 2n * 10n ** 16n,
  priceMax: 98n * 10n ** 16n,
  tick: 10n ** 16n,
  levels: 2n,
  baseRangeTicks: 8n * WAD,
  minRangeTicks: 2n * WAD,
  liquidityNavFraction: 12n * 10n ** 16n,
  minLevelSize: 1n,
  perMarketMaxFraction: 10n ** 16n,
  totalAtRiskMaxFraction: 8n * 10n ** 16n,
};

interface MarketRec {
  addr: Address;
  asset: (typeof ASSETS)[number];
  start: bigint;
  end: bigint;
  up: Address;
  down: Address;
}

async function main() {
  console.log(`LOCAL activity generator -> ${RPC} (MOCK prices, anvil dev keys)`);
  const chainId = await pub.getChainId();
  if (chainId !== 31337) throw new Error(`refusing to run on chain ${chainId}: local anvil only`);

  // ---------------------------------------------------------------- deploy
  const tusdc = await deploy(deployer, "MockERC20", ["Converge Test USD", "tUSDC", 6]);
  const factoryBlockStart = await pub.getBlockNumber();
  const factory = await deploy(deployer, "MarketFactory", [tusdc, deployer.address]);
  const verifier = await deploy(deployer, "MockStreamsVerifierProxy", [signerAcct.address]);
  const streams = await deploy(deployer, "DataStreamsResolver", [
    deployer.address,
    verifier,
    20n,
    1800n,
  ]);
  await send(deployer, factory, abis.factory, "grantRole", [
    await read(factory, abis.factory, "CREATOR_ROLE"),
    deployer.address,
  ]);
  for (const a of ASSETS) {
    await send(deployer, streams, abis.streams, "configureAsset", [a.id, a.feed]);
    await send(deployer, factory, abis.factory, "setAsset", [a.id, streams, a.label, true]);
  }
  // The vault is deployed after the factory: its own start block is later (like testnet).
  const vault = await deploy(deployer, "ConvergeVault", [
    tusdc,
    factory,
    streams,
    deployer.address,
    deployer.address,
    keeper.address,
    deployer.address,
    DAY,
    10n * U,
    5_000n * U,
    launchParams,
  ]);
  const venue = await deploy(deployer, "ForwardVenue", [vault, 2, 4, parseEther("0.001")]);
  const vaultBlock = await pub.getBlockNumber();
  for (const a of ASSETS) {
    await send(deployer, vault, abis.vault, "enableAsset", [
      a.id,
      (4n * WAD) / 10n,
      (12n * WAD) / 10n,
    ]);
  }
  await send(deployer, vault, abis.vault, "setInitialVenue", [venue]);
  await send(deployer, vault, abis.vault, "setTvlCap", [5_000n * U]);
  // fund everyone, approvals
  for (const u of [deployer, lp1, lp2, ...takers]) {
    await send(deployer, tusdc, abis.erc20, "mint", [u.address, 100_000n * U]);
    await send(u, tusdc, abis.erc20, "approve", [vault, 2n ** 255n]);
    await send(u, tusdc, abis.erc20, "approve", [venue, 2n ** 255n]);
  }
  console.log(`deployed: factory ${factory} vault ${vault} venue ${venue}`);

  const report = (feed: Hex, ts: bigint, price: bigint): Hex =>
    signTestReportSync(signerKey, feed, ts, price);

  // ---------------------------------------------------------------- time grid
  const t0 = await nowTs();
  const B0 = (t0 / DAY + 3n) * DAY; // first round boundary, at least 2 epochs ahead
  const genesis = await read<bigint>(vault, abis.vault, "genesis");
  const epochOf = (t: bigint) => (t - genesis) / DAY;

  const markets: MarketRec[] = [];
  const marketsBy = new Map<bigint, MarketRec[]>(); // start -> markets
  async function createRound(start: bigint) {
    const rec: MarketRec[] = [];
    for (const a of ASSETS) {
      await send(deployer, factory, abis.factory, "createMarket", [a.id, 900n, start]);
      const addr = await read<Address>(factory, abis.factory, "getMarket", [a.id, 900n, start]);
      const up = await read<Address>(addr, abis.market, "up");
      const down = await read<Address>(addr, abis.market, "down");
      const m = { addr, asset: a, start, end: start + 900n, up, down };
      rec.push(m);
      markets.push(m);
    }
    marketsBy.set(start, rec);
  }

  // ---------------------------------------------------------------- the story
  await warp(B0 - 800n);
  await createRound(B0);
  await send(lp1, vault, abis.vault, "requestDeposit", [1_500n * U]); // epoch of B0
  const prices = new Map(ASSETS.map((a) => [a.id, a.price]));
  const moves = () => (WAD * BigInt(1000 + between(-12, 12))) / 1000n;

  const lpEpochs: { epoch: bigint; who: Account; kind: "dep" | "red" }[] = [];
  const claimed = new Set<string>();
  async function claimAll(upToEpoch: bigint) {
    for (const r of lpEpochs) {
      const key = `${r.epoch}_${r.who.address}_${r.kind}`;
      if (r.epoch > upToEpoch || claimed.has(key)) continue;
      const ok = await trySend(
        r.who,
        vault,
        abis.vault,
        r.kind === "dep" ? "claimDeposit" : "claimRedeem",
        [r.epoch, r.who.address],
      );
      if (ok) claimed.add(key);
    }
  }
  async function lpRequest(who: Account, kind: "dep" | "red", amount: bigint) {
    const epoch = await read<bigint>(vault, abis.vault, "currentEpoch");
    const ok = await trySend(
      who,
      vault,
      abis.vault,
      kind === "dep" ? "requestDeposit" : "requestRedeem",
      [amount],
    );
    if (ok) lpEpochs.push({ epoch, who, kind });
  }
  lpEpochs.push({ epoch: epochOf(B0 - 800n), who: lp1, kind: "dep" });

  const orders: {
    id: bigint;
    execAt: bigint;
    taker: Account;
    market: MarketRec;
    executed: boolean;
  }[] = [];
  let expiredEpochTested = false;
  let orderCount = 0;

  async function placeAndExecute(
    taker: Account,
    m: MarketRec,
    kind: 0 | 1 | 2 | 3,
    shares: bigint,
    at: bigint,
    skipExec: boolean,
  ) {
    const limit = kind === 0 || kind === 2 ? (95n * WAD) / 100n : (5n * WAD) / 100n;
    const rcpt = await send(taker, venue, abis.venue, "placeOrder", [m.addr, kind, shares, limit], {
      value: parseEther("0.001"),
      at,
    });
    let id = 0n;
    let execAt = 0n;
    for (const log of rcpt.logs) {
      try {
        const ev = decodeEventLog({ abi: abis.venue, data: log.data, topics: log.topics });
        if (ev.eventName === "OrderPlaced") {
          const a = ev.args as unknown as { id: bigint; execAt: bigint };
          id = a.id;
          execAt = a.execAt;
        }
      } catch {
        /* other contract's log */
      }
    }
    orderCount++;
    const rec = { id, execAt, taker, market: m, executed: false };
    orders.push(rec);
    if (skipExec) return;
    const px = prices.get(m.asset.id)!;
    await trySend(
      deployer,
      venue,
      abis.venue,
      "executeOrder",
      [id, report(m.asset.feed, execAt, px)],
      { at: execAt },
    );
    rec.executed = true;
  }

  async function wave(round: MarketRec[], startAt: bigint, n: number, skipLast: boolean) {
    let t = startAt;
    for (let i = 0; i < n; i++) {
      const taker = takers[i % takers.length]!;
      const m = pick(round);
      const holdsUp = (await read<bigint>(m.up, abis.erc20, "balanceOf", [taker.address])) > 2n * U;
      const holdsDown =
        (await read<bigint>(m.down, abis.erc20, "balanceOf", [taker.address])) > 2n * U;
      let kind: 0 | 1 | 2 | 3 = rand() < 0.5 ? 0 : 2;
      if (holdsUp && rand() < 0.5) kind = 1;
      else if (holdsDown && rand() < 0.5) kind = 3;
      const shares = BigInt(between(2, 12)) * U;
      const sellShares =
        kind === 1
          ? ((await read<bigint>(m.up, abis.erc20, "balanceOf", [taker.address])) * 6n) / 10n
          : kind === 3
            ? ((await read<bigint>(m.down, abis.erc20, "balanceOf", [taker.address])) * 6n) / 10n
            : shares;
      if ((kind === 1 || kind === 3) && sellShares < 1_000n) continue;
      if (kind === 1) await trySend(taker, m.up, abis.erc20, "approve", [venue, 2n ** 255n]);
      if (kind === 3) await trySend(taker, m.down, abis.erc20, "approve", [venue, 2n ** 255n]);
      const skip = skipLast && i === n - 1;
      await placeAndExecute(
        taker,
        m,
        kind,
        kind === 1 || kind === 3 ? sellShares : shares,
        t,
        skip,
      );
      t = (await nowTs()) + 3n;
    }
  }

  for (let k = 0; k <= ROUNDS; k++) {
    const B = B0 + BigInt(k) * 900n;
    // 1. reports for this boundary (end of round k-1 AND strike of round k share the same report)
    await warp(B + 1n);
    for (const a of ASSETS) prices.set(a.id, (prices.get(a.id)! * moves()) / WAD);
    for (const a of ASSETS) {
      await send(deployer, streams, abis.streams, "submit", [
        a.id,
        B,
        report(a.feed, B, prices.get(a.id)!),
      ]);
    }
    await warp((await nowTs()) + 21n);
    // 2. resolve k-1, open k
    if (k > 0)
      for (const m of marketsBy.get(B - 900n)!)
        await send(deployer, m.addr, abis.market, "resolve", ["0x"]);
    if (k < ROUNDS) {
      // create the next round while this one runs (start must be in the future)
      await createRound(B + 900n);
      for (const m of marketsBy.get(B)!) await send(deployer, m.addr, abis.market, "open", ["0x"]);
    }
    // 3. settle the epoch that ended at B (or leave it to expire once)
    const ended = epochOf(B) - 1n;
    const hasWork = lpEpochs.some((r) => r.epoch === ended);
    if (hasWork) {
      if (!expiredEpochTested && k === 5) {
        expiredEpochTested = true;
        await warp(B + 700n); // past the settle window: the settlement call expires the epoch
        await send(deployer, vault, abis.vault, "settleEpoch", [ended, []]);
        await claimAll(ended);
      } else {
        await send(deployer, vault, abis.vault, "settleEpoch", [ended, []]);
        await claimAll(ended);
      }
    }
    if (k === ROUNDS) break;
    // 4. takers redeem the finished round, the vault redeems its resolved inventory
    if (k > 0) {
      for (const m of marketsBy.get(B - 900n)!) {
        for (const t of takers) await trySend(t, m.addr, abis.market, "redeem", []);
        await trySend(deployer, vault, abis.vault, "redeemResolved", [m.addr]);
      }
    }
    // 5. keeper prepares the new round
    for (const a of ASSETS) {
      const cur = a.sigma + BigInt(between(-2, 2)) * 10n ** 16n;
      await trySend(keeper, vault, abis.vault, "setSigma", [a.id, cur]);
    }
    for (const m of marketsBy.get(B)!)
      await trySend(keeper, vault, abis.vault, "splitForInventory", [m.addr, 60n * U]);
    await trySend(deployer, vault, abis.vault, "checkpoint", [[]]);

    // 6. user activity inside the round
    const round = marketsBy.get(B)!;
    const dt = (await nowTs()) - B;
    await wave(round, B + (dt > 40n ? dt + 5n : 40n), between(4, 7), k % 4 === 3);
    // OTC splits / merges / transfers between users
    const u1 = takers[k % takers.length]!;
    const u2 = takers[(k + 1) % takers.length]!;
    const m = pick(round);
    await trySend(u1, tusdc, abis.erc20, "approve", [m.addr, 2n ** 255n]);
    await trySend(u1, m.addr, abis.market, "split", [BigInt(between(5, 20)) * U]);
    await trySend(u1, m.addr, abis.market, "merge", [BigInt(between(1, 4)) * U]);
    const bal = await read<bigint>(m.up, abis.erc20, "balanceOf", [u1.address]);
    if (bal > 4n * U) await trySend(u1, m.up, abis.erc20, "transfer", [u2.address, 2n * U]);
    await wave(round, B + 420n, between(2, 5), false);

    // 7. LP flows for this epoch
    if (k === 1) await lpRequest(lp2, "dep", 500n * U);
    if (k === 2) {
      const sh = await read<bigint>(vault, abis.vault, "balanceOf", [lp1.address]);
      if (sh > 0n) await lpRequest(lp1, "red", sh / 4n);
    }
    if (k === 3) {
      await lpRequest(lp2, "dep", 200n * U);
      await lpRequest(lp1, "dep", 100n * U);
    }
    if (k === 4) await lpRequest(lp2, "dep", 50n * U); // left unsettled: this epoch expires at k = 5
    if (k === 6) {
      const sh = await read<bigint>(vault, abis.vault, "balanceOf", [lp2.address]);
      if (sh > 0n) {
        await trySend(lp2, vault, abis.vault, "transfer", [lp1.address, sh / 5n]); // share transfer
        await lpRequest(lp2, "red", sh / 3n);
      }
    }
    if (k === 8) await lpRequest(lp1, "dep", 300n * U);
    if (k === 10) {
      const sh = await read<bigint>(vault, abis.vault, "balanceOf", [lp1.address]);
      if (sh > 0n) await lpRequest(lp1, "red", sh / 2n);
    }
    // 8. flags
    if (k === 7) {
      await send(deployer, vault, abis.vault, "pauseQuoting", []);
      await send(deployer, vault, abis.vault, "resumeQuoting", []);
    }
    if (k === 9) {
      await trySend(keeper, vault, abis.vault, "haltQuoting", [
        keccak256(stringToHex("local-test")),
      ]);
      await trySend(keeper, vault, abis.vault, "unhaltQuoting", []);
    }
    // expire what was left open
    for (const o of orders) {
      if (o.executed || o.execAt === 0n) continue;
      const cur = await nowTs();
      if (cur > o.execAt + 4n) {
        if (await trySend(deployer, venue, abis.venue, "expireOrder", [o.id])) o.executed = true;
      } else {
        await warp(o.execAt + 5n);
        if (await trySend(deployer, venue, abis.venue, "expireOrder", [o.id])) o.executed = true;
      }
    }
    if (k % 3 === 0)
      console.log(
        `  round ${k}/${ROUNDS}: ${markets.length} markets, ${orderCount} orders, ${txCount} txs`,
      );
  }

  // Quiet days: one checkpoint a day for DAYS days, so NAV snapshots span more than 30 days and the
  // 7d / 30d APY fields are exercised by real events (all markets are resolved: the NAV is flat).
  const DAYS = Number(process.env.QUIET_DAYS ?? 40);
  for (let d = 0; d < DAYS; d++) {
    await warp((await nowTs()) + 86_400n + 60n);
    await trySend(deployer, vault, abis.vault, "checkpoint", [[]]);
  }

  // Quiet days: one checkpoint a day, so the NAV snapshots span more than 30 days and the 7d / 30d
  // APY fields are exercised by real events (every market is resolved: the NAV stays flat).
  const quietDays = Number(process.env.QUIET_DAYS ?? 40);
  for (let d = 0; d < quietDays; d++) {
    await warp((await nowTs()) + 86_400n + 60n);
    await trySend(deployer, vault, abis.vault, "checkpoint", [[]]);
  }

  const head = await pub.getBlockNumber();
  const users = [deployer, lp1, lp2, ...takers].map((a) => a.address);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUT_DIR, "addresses.json"),
    JSON.stringify(
      {
        chainId: 31337,
        factory,
        factoryBlock: Number(factoryBlockStart),
        vault,
        venue,
        vaultBlock: Number(vaultBlock),
        tusdc,
        streams,
        // constructor state no event carries (the indexer needs it as a default)
        keeper: keeper.address,
        tvlCap: (5_000n * U).toString(),
        head: Number(head),
        users,
        lps: [lp1.address, lp2.address],
        markets: markets.map((m) => ({
          market: m.addr,
          up: m.up,
          down: m.down,
          asset: m.asset.label,
          start: Number(m.start),
        })),
        txCount,
        orderCount,
        note: "LOCAL anvil, mock prices, anvil dev keys",
      },
      null,
      2,
    ),
  );
  console.log(
    `done: ${markets.length} markets, ${orderCount} orders, ${txCount} txs, head block ${head}`,
  );
  await sleep(10);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
