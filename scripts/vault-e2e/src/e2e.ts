/**
 * Phase 4 testnet end-to-end run (Monad testnet, chain 10143), real wall-clock time:
 *
 *   deposit -> epoch settles -> keeper prepares inventory -> a taker fills through the forward
 *   venue -> the round resolves -> redeemResolved -> LP redeems -> withdraw
 *
 * Every transaction hash is recorded in docs/evidence/phase-4/testnet-e2e.json and rendered to
 * testnet-e2e.md. Prices come from MockStreamsVerifierProxy reports signed by STREAMS_TEST_SIGNER_KEY
 * (Monad testnet has no live Data Streams verifier): the run is labelled TEST-ONLY. The numbers are
 * the same ones VaultE2E.t.sol derives by hand (premium 5.50 USDC, LP ends with 995.499004).
 *
 * Keys are read from the repo .env and never printed. Usage: pnpm --filter @converge/vault-e2e e2e
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEventLogs,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  marketFactoryAbi,
  mockErc20Abi,
  dataStreamsResolverAbi,
  signTestReportSync,
} from "@converge/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const evidenceDir = resolve(root, "docs/evidence/phase-4");

function env(name: string): string {
  const line = readFileSync(resolve(root, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  const v = line?.slice(name.length + 1).trim();
  if (!v) throw new Error(`${name} missing in .env`);
  return v;
}

const dep = JSON.parse(readFileSync(resolve(root, "deployments/testnet.json"), "utf8"));
const rpc = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pub = createPublicClient({
  chain,
  transport: http(rpc, { timeout: 30_000, retryCount: 6, retryDelay: 1_000 }),
});
const lp = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex); // LP, owner, creator
const keeper = privateKeyToAccount(env("KEEPER_PRIVATE_KEY") as Hex);
const signerKey = env("STREAMS_TEST_SIGNER_KEY") as Hex;
const takerKey = generatePrivateKey(); // ephemeral, in memory only
const taker = privateKeyToAccount(takerKey);

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

const wallet = (account: typeof lp) =>
  createWalletClient({
    account,
    chain,
    transport: http(rpc, { timeout: 30_000, retryCount: 6, retryDelay: 1_000 }),
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = {
  label: string;
  hash: Hex;
  block: string;
  gasUsed: string;
  from: Address;
  note?: string;
};
const resume = process.env.RESUME === "1";
const prior = resume
  ? (JSON.parse(readFileSync(resolve(evidenceDir, "testnet-e2e.json"), "utf8")) as {
      steps: Step[];
      facts: Record<string, string>;
    })
  : { steps: [] as Step[], facts: {} as Record<string, string> };
const steps: Step[] = prior.steps;
const facts: Record<string, string> = prior.facts;

function persist(status: "running" | "complete" | "failed", error?: string) {
  writeFileSync(
    resolve(evidenceDir, "testnet-e2e.json"),
    JSON.stringify({ status, error, chainId: 10143, addresses: A, facts, steps }, null, 2),
  );
}

async function chainTime(): Promise<bigint> {
  // The public RPC drops requests now and then: retry instead of aborting a 40 minute run.
  for (;;) {
    try {
      return (await pub.getBlock()).timestamp;
    } catch (e) {
      console.log(`  rpc hiccup (${e instanceof Error ? e.name : "error"}), retrying`);
      await sleep(3000);
    }
  }
}

async function waitUntil(ts: bigint, why: string) {
  for (;;) {
    const now = await chainTime();
    if (now >= ts) return now;
    const left = Number(ts - now);
    console.log(`  waiting ${left}s for ${why}`);
    await sleep(Math.min(left, 20) * 1000);
  }
}

async function send(
  label: string,
  account: typeof lp,
  req: Record<string, unknown>,
  note?: string,
) {
  const w = wallet(account);
  // Monad bills the gas limit: estimate, add 15% (the same margin as the deploy scripts).
  const gas = await pub.estimateContractGas({ ...(req as object), account } as never);
  const hash = await w.writeContract({ ...(req as object), gas: (gas * 115n) / 100n } as never);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  steps.push({
    label,
    hash,
    block: rcpt.blockNumber.toString(),
    gasUsed: rcpt.gasUsed.toString(),
    from: account.address,
    note,
  });
  persist("running");
  console.log(`✓ ${label}  ${hash}  gas ${rcpt.gasUsed}`);
  return rcpt;
}

async function sendNative(label: string, to: Address, value: bigint) {
  const hash = await wallet(lp).sendTransaction({ to, value });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  steps.push({
    label,
    hash,
    block: rcpt.blockNumber.toString(),
    gasUsed: rcpt.gasUsed.toString(),
    from: lp.address,
  });
  persist("running");
  console.log(`✓ ${label}  ${hash}`);
}

const report = (ts: bigint, price: bigint): Hex =>
  signTestReportSync(signerKey, TEST_FEED, ts, price);

async function main() {
  console.log("Phase 4 testnet E2E. TEST-ONLY prices (MockStreamsVerifierProxy).");
  facts.note =
    "TEST-ONLY: prices are signed by STREAMS_TEST_SIGNER_KEY via MockStreamsVerifierProxy";
  const read = <T>(p: object) => pub.readContract(p as never) as Promise<T>;

  let epoch = BigInt(facts.depositEpoch ?? "0");
  let epochEnd = 0n;
  let S = BigInt(facts.roundStart ?? "0");
  let E = BigInt(facts.roundEnd ?? "0");
  let market = (facts.market ?? "0x") as Address;
  // The taker key is ephemeral (never stored), so a resumed run funds a fresh one.
  if ((await pub.getBalance({ address: keeper.address })) < parseEther("0.2"))
    await sendNative("fund keeper (0.5 MON)", keeper.address, parseEther("0.5"));
  const pastFill = resume && facts.filled !== undefined;
  if (!pastFill) await sendNative("fund taker (0.3 MON)", taker.address, parseEther("0.3"));
  if (!resume) {
    // ---- 1. LP gets test USDC (open mint) and approves the vault
    await send("LP: mint 1,000 tUSDC", lp, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [lp.address, 1000n * U],
    });
    await send("LP: approve vault", lp, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [A.vault, 1000n * U],
    });

    // ---- 2. request the deposit early in an epoch (enough time to set the round up)
    const now = await chainTime();
    epoch = await read<bigint>({
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "currentEpoch",
    });
    epochEnd = await read<bigint>({
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "epochEnd",
      args: [epoch],
    });
    if (epochEnd - now < 120n) {
      console.log("too close to an epoch end: starting in the next epoch");
      await waitUntil(epochEnd, "the next epoch");
      epoch += 1n;
      epochEnd += 900n;
    }
    await send("LP: requestDeposit 1,000 tUSDC", lp, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "requestDeposit",
      args: [1000n * U],
    });
    facts.depositEpoch = epoch.toString();

    // ---- 3. the round starts at the epoch end (both grids are 15 minutes)
    S = epochEnd;
    E = S + 900n;
    await send("creator: createMarket(TEST/USD, 15m, start)", lp, {
      address: A.factory,
      abi: marketFactoryAbi,
      functionName: "createMarket",
      args: [TEST, 900n, S],
    });
    market = await read<Address>({
      address: A.factory,
      abi: marketFactoryAbi,
      functionName: "getMarket",
      args: [TEST, 900n, S],
    });
    facts.market = market;
    facts.roundStart = S.toString();
    facts.roundEnd = E.toString();
  }

  const strikePrice = 3000n * WAD;
  const shares = BigInt(facts.lpShares ?? "0");
  if (!pastFill) {
    // ---- 4. at the start: strike report, settle the deposit epoch, open the round
    await waitUntil(S, "the round start");
    await send("anyone: submit strike report (TEST price 3000)", lp, {
      address: A.streams,
      abi: dataStreamsResolverAbi,
      functionName: "submit",
      args: [TEST, S, report(S, strikePrice)],
    });
    const proposedAt = await chainTime();
    await send("anyone: settleEpoch(deposit epoch)", lp, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "settleEpoch",
      args: [epoch, []],
    });
    await send("LP: claimDeposit", lp, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "claimDeposit",
      args: [epoch, lp.address],
    });
    const lpSharesNow = await read<bigint>({
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "balanceOf",
      args: [lp.address],
    });
    facts.lpShares = lpSharesNow.toString();

    if (lpSharesNow !== 1000n * U - 1000n) throw new Error(`unexpected LP shares ${lpSharesNow}`);
    await waitUntil(proposedAt + 21n, "the finalization window");
    await send("anyone: market.open()", lp, {
      address: market,
      abi: marketAbi,
      functionName: "open",
      args: ["0x"],
    });

    // ---- 5. keeper: bounded actions
    await send("keeper: setSigma(TEST, 0.6)", keeper, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "setSigma",
      args: [TEST, (6n * WAD) / 10n],
    });
    await send("keeper: splitForInventory(100 USDC)", keeper, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "splitForInventory",
      args: [market, 100n * U],
    });
    await send("anyone: checkpoint()", lp, {
      address: A.vault,
      abi: convergeVaultAbi,
      functionName: "checkpoint",
      args: [[]],
    });

    // ---- 6. a taker buys 10 UP through the forward venue
    await send("taker: mint 7 tUSDC", lp, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [taker.address, 7n * U],
    });
    await send("taker: approve venue", taker, {
      address: A.tusdc,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [A.venue, 7n * U],
    });
    const placed = await send("taker: placeOrder(BUY_UP, 10 shares, limit 0.60)", taker, {
      address: A.venue,
      abi: forwardVenueAbi,
      functionName: "placeOrder",
      args: [market, 0, 10n * U, (6n * WAD) / 10n],
      value: parseEther("0.001"),
    });
    const ev = parseEventLogs({
      abi: forwardVenueAbi,
      logs: placed.logs,
      eventName: "OrderPlaced",
    })[0];
    if (!ev) throw new Error("no OrderPlaced event");
    const orderId = ev.args.id;
    const execAt = ev.args.execAt;
    facts.orderId = orderId.toString();
    facts.execAt = execAt.toString();
    await waitUntil(execAt, "the pricing time (T + 2 s)");
    const exec = await send("executor: executeOrder (report for T)", lp, {
      address: A.venue,
      abi: forwardVenueAbi,
      functionName: "executeOrder",
      args: [orderId, report(execAt, strikePrice)],
    });
    const done = parseEventLogs({
      abi: forwardVenueAbi,
      logs: exec.logs,
      eventName: "OrderExecuted",
    })[0];
    if (!done) throw new Error("no OrderExecuted event");
    facts.filled = done.args.filled.toString();
    facts.premium = done.args.premium.toString();
    facts.secondsLeftAtPricing = (E - execAt).toString();
    // hand-check: ask = 0.55 -> 10 x 0.55 = 5.50 USDC
    facts.premiumExpected = "5500000";
    if (done.args.filled !== 10n * U || done.args.premium !== 5_500_000n)
      throw new Error(
        `fill differs from the hand-checked 10 @ 0.55: ${done.args.filled} / ${done.args.premium}`,
      );
  }

  // ---- 7. the round ends, UP wins
  await waitUntil(E, "the round end");
  await send("anyone: submit end report (TEST price 3100)", lp, {
    address: A.streams,
    abi: dataStreamsResolverAbi,
    functionName: "submit",
    args: [TEST, E, report(E, 3100n * WAD)],
  });
  const endProposed = await chainTime();
  await waitUntil(endProposed + 21n, "the finalization window");
  await send("anyone: market.resolve()", lp, {
    address: market,
    abi: marketAbi,
    functionName: "resolve",
    args: ["0x"],
  });
  if (!pastFill) {
    await send("taker: market.redeem() (10 UP -> 10 tUSDC)", taker, {
      address: market,
      abi: marketAbi,
      functionName: "redeem",
    });
  } else {
    facts.takerRedeem = "skipped: the ephemeral taker key was lost when the run was resumed";
  }
  await send("anyone: vault.redeemResolved()", lp, {
    address: A.vault,
    abi: convergeVaultAbi,
    functionName: "redeemResolved",
    args: [market],
  });
  const vaultBal = await read<bigint>({
    address: A.tusdc,
    abi: mockErc20Abi,
    functionName: "balanceOf",
    args: [A.vault],
  });
  facts.vaultAssetsAfterResolution = vaultBal.toString();
  facts.vaultAssetsExpected = "995500000";
  if (vaultBal !== 995_500_000n) throw new Error(`vault holds ${vaultBal}, hand-checked 995500000`);

  // ---- 8. the LP leaves in the next epoch
  epoch = await read<bigint>({
    address: A.vault,
    abi: convergeVaultAbi,
    functionName: "currentEpoch",
  });
  await send("LP: requestRedeem(all shares)", lp, {
    address: A.vault,
    abi: convergeVaultAbi,
    functionName: "requestRedeem",
    args: [shares],
  });
  epochEnd = await read<bigint>({
    address: A.vault,
    abi: convergeVaultAbi,
    functionName: "epochEnd",
    args: [epoch],
  });
  await waitUntil(epochEnd, "the redemption epoch end");
  await send("anyone: settleEpoch(redemption epoch)", lp, {
    address: A.vault,
    abi: convergeVaultAbi,
    functionName: "settleEpoch",
    args: [epoch, []],
  });
  const before = await read<bigint>({
    address: A.tusdc,
    abi: mockErc20Abi,
    functionName: "balanceOf",
    args: [lp.address],
  });
  await send("LP: claimRedeem", lp, {
    address: A.vault,
    abi: convergeVaultAbi,
    functionName: "claimRedeem",
    args: [epoch, lp.address],
  });
  const after = await read<bigint>({
    address: A.tusdc,
    abi: mockErc20Abi,
    functionName: "balanceOf",
    args: [lp.address],
  });
  facts.lpReceived = (after - before).toString();
  facts.lpReceivedExpected = "995499004";
  facts.lpDeposited = "1000000000";
  if (after - before !== 995_499_004n)
    throw new Error(`LP received ${after - before}, hand-checked 995499004`);
  persist("complete");
  console.log(
    "E2E complete: LP 1,000.000000 -> 995.499004 tUSDC (the 4.50 loss + dead shares), as hand-checked.",
  );
}

main().catch((e) => {
  persist("failed", e instanceof Error ? e.message : String(e));
  console.error(e);
  process.exit(1);
});
