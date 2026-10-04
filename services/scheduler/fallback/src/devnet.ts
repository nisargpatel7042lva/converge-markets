/**
 * Local devnet stack for integration tests and the local soak (NOT a production deploy):
 * tUSDC, MarketFactory, DataStreamsResolver over MockStreamsVerifierProxy (TEST signer) for
 * BTC/USD + ETH/USD, ChainlinkRoundResolver over a MockAggregator for MON/USD, and a
 * SchedulerReceiver whose "forwarder" is a local account (stands in for the KeystoneForwarder).
 * Contract bytecode comes from contracts/out (run `forge build` first).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetIdOf,
  chainlinkRoundResolverAbi,
  dataStreamsResolverAbi,
  marketFactoryAbi,
  mockAggregatorAbi,
  schedulerReceiverAbi,
  type SeriesConfig,
} from "@converge/sdk";
import type {
  Abi,
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../../contracts/out");

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export const DEVNET_FEEDS = {
  "BTC/USD": "0x0003000000000000000000000000000000000000000000000000000000000b7c",
  "ETH/USD": "0x0003000000000000000000000000000000000000000000000000000000000e7e",
} as const;

export function devnetSeriesConfig(): SeriesConfig {
  return {
    lookaheadRounds: 3,
    recentLookbackSeconds: 7200,
    deepLookbackSeconds: 93600,
    lateAfterSeconds: 60,
    durations: [900, 3600],
    assets: [
      {
        label: "BTC/USD",
        symbol: "BTC",
        resolver: "streams",
        streamsFeedId: DEVNET_FEEDS["BTC/USD"],
      },
      {
        label: "ETH/USD",
        symbol: "ETH",
        resolver: "streams",
        streamsFeedId: DEVNET_FEEDS["ETH/USD"],
      },
      { label: "MON/USD", symbol: "MON", resolver: "round" },
    ],
    kuru: { enabled: false, reason: "devnet" },
  };
}

export type Devnet = {
  usdc: Address;
  factory: Address;
  receiver: Address;
  streamsResolver: Address;
  roundResolver: Address;
  monFeed: Address;
  verifier: Address;
};

type W = WalletClient<Transport, Chain, Account>;

async function deploy(
  pub: PublicClient,
  wallet: W,
  name: string,
  args: readonly unknown[] = [],
): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args, chain: wallet.chain } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error(`${name}: no address`);
  return r.contractAddress;
}

async function tx(pub: PublicClient, wallet: W, p: object): Promise<void> {
  const hash = await wallet.writeContract({ ...p, chain: wallet.chain } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("devnet setup tx reverted");
}

/**
 * @param admin deployer/admin wallet
 * @param scheduler fallback scheduler EOA (gets CREATOR_ROLE)
 * @param forwarder stand-in for the KeystoneForwarder (CRE path)
 * @param testSigner TEST signer accepted by MockStreamsVerifierProxy
 */
export async function deployDevnet(
  pub: PublicClient,
  admin: W,
  scheduler: Address,
  forwarder: Address,
  testSigner: Address,
  opts: {
    finalizationWindow?: bigint;
    streamsGrace?: bigint;
    livenessGrace?: bigint;
    maxOracleDelay?: number;
  } = {},
): Promise<Devnet> {
  const me = admin.account.address;
  const usdc = await deploy(pub, admin, "MockERC20", ["Converge Test USD", "tUSDC", 6]);
  const factory = await deploy(pub, admin, "MarketFactory", [usdc, me]);
  const verifier = await deploy(pub, admin, "MockStreamsVerifierProxy", [testSigner]);
  const streamsResolver = await deploy(pub, admin, "DataStreamsResolver", [
    me,
    verifier,
    opts.finalizationWindow ?? 30n,
    opts.streamsGrace ?? 1800n,
  ]);
  const monFeed = await deploy(pub, admin, "MockAggregator", [8]);
  const roundResolver = await deploy(pub, admin, "ChainlinkRoundResolver", [
    me,
    opts.livenessGrace ?? 86_400n,
  ]);
  const receiver = await deploy(pub, admin, "SchedulerReceiver", [forwarder, factory, me]);

  for (const label of ["BTC/USD", "ETH/USD"] as const) {
    await tx(pub, admin, {
      address: streamsResolver,
      abi: dataStreamsResolverAbi,
      functionName: "configureAsset",
      args: [assetIdOf(label), DEVNET_FEEDS[label]],
    });
  }
  await tx(pub, admin, {
    address: roundResolver,
    abi: chainlinkRoundResolverAbi,
    functionName: "configureAsset",
    args: [assetIdOf("MON/USD"), monFeed, opts.maxOracleDelay ?? 120],
  });
  const creator = await pub.readContract({
    address: factory,
    abi: marketFactoryAbi,
    functionName: "CREATOR_ROLE",
  });
  await tx(pub, admin, {
    address: factory,
    abi: marketFactoryAbi,
    functionName: "grantRole",
    args: [creator, scheduler],
  });
  await tx(pub, admin, {
    address: factory,
    abi: marketFactoryAbi,
    functionName: "grantRole",
    args: [creator, receiver],
  });
  for (const [label, sym, res] of [
    ["BTC/USD", "BTC", streamsResolver],
    ["ETH/USD", "ETH", streamsResolver],
    ["MON/USD", "MON", roundResolver],
  ] as const) {
    await tx(pub, admin, {
      address: factory,
      abi: marketFactoryAbi,
      functionName: "setAsset",
      args: [assetIdOf(label), res, sym, true],
    });
  }
  await tx(pub, admin, {
    address: receiver,
    abi: schedulerReceiverAbi,
    functionName: "setWorkflow",
    args: [me, `0x${"00".repeat(32)}`],
  });
  // Seed the MON feed with a round before go-live so the first boundary proof has a predecessor.
  const blk = await pub.getBlock();
  await tx(pub, admin, {
    address: monFeed,
    abi: mockAggregatorAbi,
    functionName: "setRound",
    args: [1, 1n, 3_431_197n, blk.timestamp - 30n],
  });
  return { usdc, factory, receiver, streamsResolver, roundResolver, monFeed, verifier };
}
