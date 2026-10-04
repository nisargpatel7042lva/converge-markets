/**
 * Phase 0 Kuru feasibility spike.
 *
 * Measures what it costs to run Converge's "new Kuru market per round" model on Monad:
 *   1. deploy outcome token + collateral (open-mint SpikeToken, test only)
 *   2. create a Kuru market via Router.deployProxy (permissionless?)
 *   3. deposit to Kuru MarginAccount, post a bid + ask
 *   4. 20 rounds of atomic cancel/replace via OrderBook.batchUpdate
 *   5. 3 rounds of unbatched cancel + re-post for comparison
 *   6. create two more markets to check repeat-creation cost and limits
 *
 * ABIs come from the official @kuru-labs/kuru-sdk@0.0.95 package (abi/*.json), addresses from
 * https://docs.kuru.io/contracts/Contract-addresses. Nothing is hand-written.
 *
 * Run (live testnet):  SPIKE_MODE=testnet pnpm --filter @converge/spike kuru
 * Run (anvil fork):    SPIKE_MODE=fork SPIKE_RPC_URL=http://127.0.0.1:8546 pnpm --filter @converge/spike kuru
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const Env = z.object({
  SPIKE_MODE: z.enum(["testnet", "fork"]),
  SPIKE_RPC_URL: z.string().url().default("https://testnet-rpc.monad.xyz"),
  DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  // MON/USD used only to express costs in USD. Default = Chainlink MON/USD (mainnet) read on 2026-10-04.
  MON_USD: z.coerce.number().positive().default(0.03431197),
});

// Kuru testnet addresses: https://docs.kuru.io/contracts/Contract-addresses (verified 2026-10-04)
const KURU_ROUTER: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const KURU_MARGIN_ACCOUNT: Address = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";

const sdkAbi = (name: string): Abi => {
  const json = require(`@kuru-labs/kuru-sdk/abi/${name}.json`) as { abi: Abi };
  return json.abi;
};
const routerAbi = sdkAbi("Router");
const orderBookAbi = sdkAbi("OrderBook");
const marginAbi = sdkAbi("MarginAccount");
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);

type TxRecord = {
  label: string;
  hash: Hash;
  gasLimit: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
  // Monad charges the declared gas limit, not gas used (docs.monad.xyz/developer-essentials/gas-pricing).
  costMonAtLimit: number;
  costMonAtUsed: number;
  latencyMs: number;
  block: string;
};

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
  const transport = http(env.SPIKE_RPC_URL, { timeout: 30_000 });
  const pub = createPublicClient({ chain: monadTestnet, transport, pollingInterval: 100 });
  const wallet = createWalletClient({ account, chain: monadTestnet, transport });
  const records: TxRecord[] = [];
  const notes: string[] = [];

  const balance = await pub.getBalance({ address: account.address });
  console.log(`mode=${env.SPIKE_MODE} deployer=${account.address} balanceWei=${balance}`);
  if (balance === 0n) throw new Error("deployer has 0 MON: fund it from https://faucet.monad.xyz");

  async function send(
    label: string,
    to: Address | undefined,
    data: Hex,
  ): Promise<TransactionReceipt> {
    const est = await pub.estimateGas({ account, to, data });
    const gas = (est * 115n) / 100n; // 15% headroom; Monad bills the limit so keep it tight
    const t0 = performance.now();
    const hash = to
      ? await wallet.sendTransaction({ to, data, gas })
      : await wallet.sendTransaction({ data, gas } as Parameters<typeof wallet.sendTransaction>[0]);
    const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    const latencyMs = Math.round(performance.now() - t0);
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    const price = receipt.effectiveGasPrice;
    const rec: TxRecord = {
      label,
      hash,
      gasLimit: gas.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: price.toString(),
      costMonAtLimit: Number(gas * price) / 1e18,
      costMonAtUsed: Number(receipt.gasUsed * price) / 1e18,
      latencyMs,
      block: receipt.blockNumber.toString(),
    };
    records.push(rec);
    console.log(
      `${label.padEnd(28)} gasUsed=${rec.gasUsed.padStart(8)} limit=${rec.gasLimit.padStart(8)} ` +
        `costMON=${rec.costMonAtLimit.toFixed(6)} latency=${latencyMs}ms`,
    );
    return receipt;
  }

  const artifact = JSON.parse(
    readFileSync(resolve(repoRoot, "contracts/out/SpikeToken.sol/SpikeToken.json"), "utf8"),
  ) as { abi: Abi; bytecode: { object: Hex } };

  async function deployToken(label: string, name: string, symbol: string, decimals: number) {
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [name, symbol, decimals],
    });
    // Re-measure via receipt for consistent records
    const t0 = performance.now();
    const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    const tx = await pub.getTransaction({ hash });
    records.push({
      label,
      hash,
      gasLimit: tx.gas.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
      costMonAtLimit: Number(tx.gas * receipt.effectiveGasPrice) / 1e18,
      costMonAtUsed: Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18,
      latencyMs: Math.round(performance.now() - t0),
      block: receipt.blockNumber.toString(),
    });
    if (!receipt.contractAddress) throw new Error(`${label}: no contract address`);
    console.log(`${label.padEnd(28)} -> ${receipt.contractAddress} gasUsed=${receipt.gasUsed}`);
    return receipt.contractAddress;
  }

  // Market parameters for an outcome token priced in [0.02, 0.98] collateral.
  // Uses the official SDK helper rather than re-deriving Kuru's precision rules.
  const { ParamCreator } = (await import("@kuru-labs/kuru-sdk")) as unknown as {
    ParamCreator: new () => {
      calculatePrecisions: (
        q: number,
        b: number,
        maxPrice: number,
        minSize: number,
        tickBps: number,
      ) => Record<
        "pricePrecision" | "sizePrecision" | "tickSize" | "minSize" | "maxSize",
        { toString(): string }
      >;
    };
  };
  const p = new ParamCreator().calculatePrecisions(0.5, 1, 1, 1, 20);
  const params = {
    pricePrecision: BigInt(p.pricePrecision.toString()),
    sizePrecision: BigInt(p.sizePrecision.toString()),
    tickSize: BigInt(p.tickSize.toString()),
    minSize: BigInt(p.minSize.toString()),
    maxSize: BigInt(p.maxSize.toString()),
  };
  console.log(
    "market params",
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.toString()])),
  );

  const collateral = await deployToken("deploy collateral (6dp)", "Spike USD", "sUSD", 6);

  async function createMarket(round: number) {
    const up = await deployToken(
      `deploy outcome token r${round}`,
      `UP r${round}`,
      `UP${round}`,
      18,
    );
    const receipt = await send(
      `kuru deployProxy r${round}`,
      KURU_ROUTER,
      encodeFunctionData({
        abi: routerAbi,
        functionName: "deployProxy",
        args: [
          0, // NO_NATIVE
          up,
          collateral,
          params.sizePrecision,
          Number(params.pricePrecision),
          Number(params.tickSize),
          params.minSize,
          params.maxSize,
          0n, // taker fee bps
          0n, // maker fee bps
          100n, // Kuru AMM spread bps (min 10, multiple of 10)
        ],
      }),
    );
    let market: Address | undefined;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "MarketRegistered") {
          market = (ev.args as unknown as { market: Address }).market;
        }
      } catch {
        // not a router event
      }
    }
    if (!market) throw new Error("MarketRegistered not found");
    console.log(`market r${round} -> ${market}`);
    return { up, market };
  }

  const { up, market } = await createMarket(1);

  // Fund + deposit into Kuru MarginAccount (orders are backed by margin balances).
  const baseAmt = 1_000n * 10n ** 18n;
  const quoteAmt = 1_000n * 10n ** 6n;
  await send(
    "mint outcome",
    up,
    encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [account.address, baseAmt] }),
  );
  await send(
    "mint collateral",
    collateral,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "mint",
      args: [account.address, quoteAmt * 10n],
    }),
  );
  await send(
    "approve outcome",
    up,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [KURU_MARGIN_ACCOUNT, baseAmt],
    }),
  );
  await send(
    "approve collateral",
    collateral,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [KURU_MARGIN_ACCOUNT, quoteAmt * 10n],
    }),
  );
  await send(
    "margin deposit outcome",
    KURU_MARGIN_ACCOUNT,
    encodeFunctionData({
      abi: marginAbi,
      functionName: "deposit",
      args: [account.address, up, baseAmt],
    }),
  );
  await send(
    "margin deposit collateral",
    KURU_MARGIN_ACCOUNT,
    encodeFunctionData({
      abi: marginAbi,
      functionName: "deposit",
      args: [account.address, collateral, quoteAmt],
    }),
  );

  const price = (x: number) =>
    Number(
      (BigInt(Math.round(x * Number(params.pricePrecision))) / params.tickSize) * params.tickSize,
    );
  const size = 10n * params.sizePrecision; // 10 outcome tokens

  const orderIdsFrom = (receipt: TransactionReceipt): bigint[] => {
    const ids: bigint[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== market.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: orderBookAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "OrderCreated")
          ids.push((ev.args as unknown as { orderId: bigint }).orderId);
      } catch {
        // other events
      }
    }
    return ids;
  };

  const batch = (bid: number, ask: number, cancel: bigint[]) =>
    encodeFunctionData({
      abi: orderBookAbi,
      functionName: "batchUpdate",
      args: [[price(bid)], [size], [price(ask)], [size], cancel.map(Number), true],
    });

  let live = orderIdsFrom(
    await send("initial bid+ask (batchUpdate)", market, batch(0.48, 0.52, [])),
  );
  if (live.length !== 2)
    notes.push(`initial batchUpdate created ${live.length} orders (expected 2)`);

  const t20 = performance.now();
  for (let i = 1; i <= 20; i++) {
    const mid = 0.5 + 0.01 * Math.sin(i); // drift the quote each round
    const r = await send(
      `requote ${String(i).padStart(2, "0")} (batchUpdate)`,
      market,
      batch(mid - 0.02, mid + 0.02, live),
    );
    live = orderIdsFrom(r);
  }
  const wall20 = Math.round(performance.now() - t20);

  // Unbatched comparison: cancel in one tx, re-post bid and ask in two more.
  for (let i = 1; i <= 3; i++) {
    await send(
      `unbatched cancel ${i}`,
      market,
      encodeFunctionData({
        abi: orderBookAbi,
        functionName: "batchCancelOrders",
        args: [live.map(Number)],
      }),
    );
    const b = await send(
      `unbatched bid ${i}`,
      market,
      encodeFunctionData({
        abi: orderBookAbi,
        functionName: "addBuyOrder",
        args: [price(0.47), size, true],
      }),
    );
    const a = await send(
      `unbatched ask ${i}`,
      market,
      encodeFunctionData({
        abi: orderBookAbi,
        functionName: "addSellOrder",
        args: [price(0.53), size, true],
      }),
    );
    live = [...orderIdsFrom(b), ...orderIdsFrom(a)];
  }

  // Repeat market creation (rate limits / allowlists / cost drift).
  await createMarket(2);
  await createMarket(3);

  const block = await pub.getBlock();
  const gasPrice = await pub.getGasPrice();
  const out = {
    mode: env.SPIKE_MODE,
    rpc: env.SPIKE_RPC_URL.replace(/\/\/.*@/, "//"),
    chainId: await pub.getChainId(),
    ranAt: new Date().toISOString(),
    deployer: account.address,
    kuru: {
      router: KURU_ROUTER,
      marginAccount: KURU_MARGIN_ACCOUNT,
      sdk: "@kuru-labs/kuru-sdk@0.0.95",
    },
    marketParams: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.toString()])),
    collateral,
    market,
    baseFeePerGasWei: block.baseFeePerGas?.toString() ?? null,
    gasPriceWei: gasPrice.toString(),
    monUsd: env.MON_USD,
    requote20WallClockMs: wall20,
    notes,
    records,
  };
  const dir = resolve(repoRoot, "docs/evidence/phase-0");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `kuru-spike-${env.SPIKE_MODE}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
