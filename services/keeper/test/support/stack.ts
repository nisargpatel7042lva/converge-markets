import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetIdOf,
  convergeVaultAbi,
  dataStreamsResolverAbi,
  forwardVenueAbi,
  marketAbi,
  marketFactoryAbi,
  mockErc20Abi,
  partnerRegistryAbi,
  signTestReportSync,
} from "@converge/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_PARAMS_ONCHAIN } from "../unit/params";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../../contracts/out");

// Public anvil development keys: not secrets.
export const KEYS = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  keeper: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  lp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  taker: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  signer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  executor: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  partner: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
} as const;

export const TEST_LABEL = "TEST/USD";
export const TEST_FEED: Hex = "0x0003000000000000000000000000000000000000000000000000000000000001";
export const ASSET_ID = assetIdOf(TEST_LABEL);
const WAD = 10n ** 18n;
export const U = 1_000_000n;

type W = WalletClient<Transport, Chain, Account>;

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export type Stack = {
  url: string;
  pub: PublicClient;
  chain: Chain;
  admin: W;
  lp: W;
  taker: W;
  executor: W;
  /** An approved, bonded partner of the PartnerRegistry (cap 40 USD). */
  partner: W;
  keeperAccount: Account;
  signerKey: Hex;
  addrs: {
    usdc: Address;
    factory: Address;
    streams: Address;
    vault: Address;
    venue: Address;
    verifier: Address;
    registry: Address;
  };
  /** Moves chain time forward and mines a block. */
  warp: (seconds: number) => Promise<void>;
  now: () => Promise<number>;
  report: (ts: number, price: number) => Hex;
  tx: (
    w: W,
    p: {
      address: Address;
      abi: Abi | readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
      value?: bigint;
    },
  ) => Promise<Hex>;
  read: <T>(
    address: Address,
    abi: Abi | readonly unknown[],
    functionName: string,
    args?: readonly unknown[],
  ) => Promise<T>;
  /** Creates the 15-minute round starting at the next boundary at least `lead` seconds ahead, opens it. */
  openRound: (
    price: number,
    lead?: number,
  ) => Promise<{ market: Address; start: number; end: number }>;
  /** Submits the end report, waits out the finalization window and resolves the round. */
  resolveRound: (market: Address, end: number, price: number) => Promise<void>;
  /** Deposits `usd`, settles the epoch and claims shares (the vault then has a NAV). */
  fund: (usd: number) => Promise<void>;
  placeOrder: (market: Address, kind: number, shares: bigint, limit: bigint) => Promise<bigint>;
};

export async function deployStack(url: string): Promise<Stack> {
  const chainId = Number(
    await (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      })
    )
      .json()
      .then((j: { result: string }) => BigInt(j.result)),
  );
  const chain = defineChain({
    id: chainId,
    name: "anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const pub = createPublicClient({
    chain,
    transport: http(url),
    pollingInterval: 100,
  }) as PublicClient;
  const mk = (k: Hex): W =>
    createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(url) });
  const admin = mk(KEYS.admin);
  const lp = mk(KEYS.lp);
  const taker = mk(KEYS.taker);
  const executor = mk(KEYS.executor);
  const partner = mk(KEYS.partner);
  const keeperAccount = privateKeyToAccount(KEYS.keeper);
  const signer = privateKeyToAccount(KEYS.signer);

  const tx: Stack["tx"] = async (w, p) => {
    const hash = await w.writeContract({ ...p, chain } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${p.functionName} reverted`);
    return hash;
  };
  const read: Stack["read"] = (address, abi, functionName, args = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<never>;
  const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
    const { abi, bytecode } = artifact(name);
    const hash = await admin.deployContract({ abi, bytecode, args, chain } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`${name}: no address`);
    return r.contractAddress;
  };

  const usdc = await deploy("MockERC20", ["Test USD", "tUSDC", 6]);
  const verifier = await deploy("MockStreamsVerifierProxy", [signer.address]);
  const factory = await deploy("MarketFactory", [usdc, admin.account.address]);
  const streams = await deploy("DataStreamsResolver", [
    admin.account.address,
    verifier,
    20n,
    1800n,
  ]);
  await tx(admin, {
    address: streams,
    abi: dataStreamsResolverAbi,
    functionName: "configureAsset",
    args: [ASSET_ID, TEST_FEED],
  });
  const creator = await read<Hex>(factory, marketFactoryAbi, "CREATOR_ROLE");
  await tx(admin, {
    address: factory,
    abi: marketFactoryAbi,
    functionName: "grantRole",
    args: [creator, admin.account.address],
  });
  await tx(admin, {
    address: factory,
    abi: marketFactoryAbi,
    functionName: "setAsset",
    args: [ASSET_ID, streams, "TEST", true],
  });
  const P = DEFAULT_PARAMS_ONCHAIN;
  const wad = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
  const params = {
    minHalfSpread: wad(P.minHalfSpread),
    maxHalfSpread: wad(P.maxHalfSpread),
    volSpreadK: wad(P.volSpreadK),
    stalenessSec: wad(P.stalenessSec),
    inventorySkewMax: wad(P.inventorySkewMax),
    inventorySkewK: wad(P.inventorySkewK),
    noQuoteWindowSec: BigInt(P.noQuoteWindowSec),
    priceMin: wad(P.priceMin),
    priceMax: wad(P.priceMax),
    tick: wad(P.tick),
    levels: BigInt(P.levels),
    baseRangeTicks: wad(P.baseRangeTicks),
    minRangeTicks: wad(P.minRangeTicks),
    liquidityNavFraction: wad(P.liquidityNavFraction),
    minLevelSize: 1n,
    perMarketMaxFraction: wad(P.perMarketMaxFraction),
    totalAtRiskMaxFraction: wad(P.totalAtRiskMaxFraction),
  };
  const vault = await deploy("ConvergeVault", [
    usdc,
    factory,
    streams,
    admin.account.address,
    admin.account.address,
    keeperAccount.address,
    admin.account.address,
    900n,
    10n * U,
    5_000n * U,
    params,
  ]);
  const venue = await deploy("ForwardVenue", [vault, 2, 4, parseEther("0.001")]);
  await tx(admin, {
    address: vault,
    abi: convergeVaultAbi,
    functionName: "enableAsset",
    args: [ASSET_ID, wad(0.4), wad(1.2)],
  });
  await tx(admin, {
    address: vault,
    abi: convergeVaultAbi,
    functionName: "setInitialVenue",
    args: [venue],
  });

  // ---- partners (ADR-008): registry, one approved partner with a bond, linked to the vault
  const registry = await deploy("PartnerRegistry", [
    factory,
    admin.account.address,
    admin.account.address,
    admin.account.address,
  ]);
  const pr = async (functionName: string, args: readonly unknown[]) =>
    tx(admin, { address: registry, abi: partnerRegistryAbi, functionName, args });
  await pr("setConfig", [100n * U, 500n * U, 50, admin.account.address, vault]);
  await pr("setVault", [vault]);
  await pr("setFeed", [ASSET_ID, true]);
  await pr("approvePartner", [partner.account.address, 40n * U, 3000, [ASSET_ID]]);
  await tx(admin, {
    address: vault,
    abi: convergeVaultAbi,
    functionName: "setPartnerRegistry",
    args: [registry],
  });
  await tx(admin, {
    address: usdc,
    abi: mockErc20Abi,
    functionName: "mint",
    args: [partner.account.address, 100n * U],
  });
  await tx(partner, {
    address: usdc,
    abi: mockErc20Abi,
    functionName: "approve",
    args: [registry, 100n * U],
  });
  await tx(partner, {
    address: registry,
    abi: partnerRegistryAbi,
    functionName: "postBond",
    args: [100n * U],
  });

  const rpc = async (method: string, params: unknown[]) =>
    (await (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json()) as { result?: unknown };
  const now = async () => Number((await pub.getBlock()).timestamp);
  const warp: Stack["warp"] = async (s) => {
    await rpc("evm_increaseTime", [s]);
    await rpc("evm_mine", []);
  };
  /** Moves chain time to at least `ts` (the latest block can lag the wall clock by a block). */
  const warpTo = async (ts: number) => {
    for (let i = 0; i < 5; i++) {
      const n = await now();
      if (n >= ts) return;
      await warp(ts - n + 1);
    }
  };
  const report = (ts: number, price: number) =>
    signTestReportSync(
      KEYS.signer,
      TEST_FEED,
      BigInt(ts),
      BigInt(Math.round(price * 1e8)) * 10n ** 10n,
    );

  const openRound: Stack["openRound"] = async (price, lead = 40) => {
    const t = await now();
    const start = (Math.floor((t + lead) / 900) + 1) * 900;
    await tx(admin, {
      address: factory,
      abi: marketFactoryAbi,
      functionName: "createMarket",
      args: [ASSET_ID, 900n, BigInt(start)],
    });
    const market = await read<Address>(factory, marketFactoryAbi, "getMarket", [
      ASSET_ID,
      900n,
      BigInt(start),
    ]);
    await warpTo(start + 1);
    await tx(admin, {
      address: streams,
      abi: dataStreamsResolverAbi,
      functionName: "submit",
      args: [ASSET_ID, BigInt(start), report(start, price)],
    });
    await warp(25); // the finalization window is 20 s: keep a margin
    await tx(admin, { address: market, abi: marketAbi, functionName: "open", args: ["0x"] });
    return { market, start, end: start + 900 };
  };

  const resolveRound: Stack["resolveRound"] = async (market, end, price) => {
    await warpTo(end + 1);
    await tx(admin, {
      address: streams,
      abi: dataStreamsResolverAbi,
      functionName: "submit",
      args: [ASSET_ID, BigInt(end), report(end, price)],
    });
    await warp(25); // the finalization window is 20 s: keep a margin
    await tx(admin, { address: market, abi: marketAbi, functionName: "resolve", args: ["0x"] });
  };

  const fund: Stack["fund"] = async (usd) => {
    const amount = BigInt(Math.round(usd * 1e6));
    await tx(lp, {
      address: usdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [lp.account.address, amount],
    });
    await tx(lp, {
      address: usdc,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [vault, amount],
    });
    const e = await read<bigint>(vault, convergeVaultAbi, "currentEpoch");
    await tx(lp, {
      address: vault,
      abi: convergeVaultAbi,
      functionName: "requestDeposit",
      args: [amount],
    });
    const end = Number(await read<bigint>(vault, convergeVaultAbi, "epochEnd", [e]));
    await warpTo(end + 1);
    await tx(lp, {
      address: vault,
      abi: convergeVaultAbi,
      functionName: "settleEpoch",
      args: [e, []],
    });
    await tx(lp, {
      address: vault,
      abi: convergeVaultAbi,
      functionName: "claimDeposit",
      args: [e, lp.account.address],
    });
  };

  const placeOrder: Stack["placeOrder"] = async (market, kind, shares, limit) => {
    const escrow = (shares * limit + WAD - 1n) / WAD + 4n;
    await tx(admin, {
      address: usdc,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [taker.account.address, escrow],
    });
    await tx(taker, {
      address: usdc,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [venue, escrow],
    });
    await tx(taker, {
      address: venue,
      abi: forwardVenueAbi,
      functionName: "placeOrder",
      args: [market, kind, shares, limit],
      value: parseEther("0.001"),
    });
    return (await read<bigint>(venue, forwardVenueAbi, "nextOrderId")) - 1n;
  };

  return {
    url,
    pub,
    chain,
    admin,
    lp,
    taker,
    executor,
    partner,
    keeperAccount,
    signerKey: KEYS.signer,
    addrs: { usdc, factory, streams, vault, venue, verifier, registry },
    warp,
    now,
    report,
    tx,
    read,
    openRound,
    resolveRound,
    fund,
    placeOrder,
  };
}
