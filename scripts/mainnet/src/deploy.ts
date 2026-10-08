/**
 * The mainnet deployer. Idempotent: it records every address in deployments/<network>.json after
 * each step and, on a re-run, checks that what is recorded exists on chain and is configured as
 * intended, then continues from there. It never sends a transaction for something already true.
 *
 * Order (each step is independent and re-runnable):
 *  1. MarketFactory, the Data Streams resolver (+ the real feed ids), the round-proof resolver (MON)
 *  2. assets registered in the factory
 *  3. the scheduler receiver and lens, creator roles
 *  4. the vault, the venue, the assets enabled in the vault with their sigma bands
 *  5. (optional) the partner registry
 *  6. role hygiene and the Safe handover: the Safe becomes owner/admin of everything; the deployer
 *     keeps nothing. Ownable2Step contracts stay "pending" until the Safe executes acceptOwnership
 *     (see `safe-batch`); `verify` reports exactly what is still pending.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeDeployData,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  convergeVaultAbi,
  dataStreamsResolverAbi,
  forwardVenueAbi,
  marketFactoryAbi,
  partnerRegistryAbi,
  chainlinkRoundResolverAbi,
  schedulerReceiverAbi,
} from "@converge/sdk";
import { artifact } from "./artifacts";
import {
  CRE_FORWARDER,
  DEFAULT_TVL_CAP,
  EPOCH_LENGTH_SEC,
  FINALIZATION_WINDOW_SEC,
  MIN_REQUEST,
  MON_MAX_ORACLE_DELAY_SEC,
  MON_USD_FEED,
  PARTNER_DEFAULTS,
  ROUND_LIVENESS_GRACE_SEC,
  SIGMA_BANDS,
  STREAMS_GRACE_SEC,
  USDC,
  VENUE_EXEC_DELAY,
  VENUE_MAX_LATENESS,
  VENUE_MIN_REWARD,
  VERIFIER_PROXY,
} from "./constants";
import { loadLaunchParams } from "./params";
import { readState, writeState, type Deployment } from "./state";

export interface SeriesAsset {
  label: string;
  symbol: string;
  resolver: "streams" | "round";
  streamsFeedId?: string;
}

export interface DeployConfig {
  network: string;
  chainId: number;
  safe: Address;
  guardian: Address;
  keeper: Address;
  scheduler: Address;
  treasury: Address;
  tvlCap: bigint;
  enablePartners: boolean;
  leader: "fallback" | "cre";
  assets: SeriesAsset[];
}

export const assetIdOf = (label: string): Hex => keccak256(stringToHex(label));
const ROLE = (name: string): Hex => keccak256(stringToHex(name));
export const DEFAULT_ADMIN_ROLE: Hex = `0x${"00".repeat(32)}`;
export const CREATOR_ROLE = ROLE("CREATOR_ROLE");
export const GUARDIAN_ROLE = ROLE("GUARDIAN_ROLE");
export const OPERATOR_ROLE = ROLE("OPERATOR_ROLE");

const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
]);
const accessAbi = parseAbi([
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)",
  "function renounceRole(bytes32,address)",
]);
const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
]);

/** Everything a feed id must satisfy before it is written, forever, into an immutable resolver. */
export function checkStreamFeedId(label: string, id: string | undefined): Hex {
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id) || /^0x0+$/.test(id)) {
    throw new Error(
      `${label}: no Data Streams feed id in config/series.json (it is a placeholder). The resolver stores it once and for ever: get the real stream id from Chainlink first.`,
    );
  }
  if (!id.toLowerCase().startsWith("0x0003")) {
    throw new Error(`${label}: ${id} is not a v3 stream id (it must start with 0x0003)`);
  }
  return id as Hex;
}

/** Static validation of the configuration: fails before any transaction. */
export function validateConfig(c: DeployConfig, deployer: Address): void {
  const roles: [string, Address][] = [
    ["SAFE_ADDRESS", c.safe],
    ["GUARDIAN_ADDRESS", c.guardian],
    ["KEEPER_ADDRESS", c.keeper],
    ["SCHEDULER_ADDRESS", c.scheduler],
  ];
  for (const [n, a] of roles) {
    if (!a || a === zeroAddress) throw new Error(`${n} is not set`);
    if (a.toLowerCase() === deployer.toLowerCase()) {
      throw new Error(
        `${n} is the deployer key: every role must be a different key from the deployer`,
      );
    }
  }
  const seen = new Map<string, string>();
  for (const [n, a] of roles) {
    const k = a.toLowerCase();
    if (seen.has(k))
      throw new Error(
        `${n} and ${seen.get(k)} are the same address: guardian, keeper, scheduler and the Safe must be separate keys`,
      );
    seen.set(k, n);
  }
  if (c.tvlCap <= 0n || c.tvlCap > 100_000_000_000n)
    throw new Error("TVL cap must be between 0 and 100,000 USDC");
  if (c.assets.filter((a) => a.resolver === "streams").length === 0) {
    throw new Error(
      "no Data Streams asset configured: the vault can only quote Data Streams assets",
    );
  }
  for (const a of c.assets)
    if (a.resolver === "streams") checkStreamFeedId(a.label, a.streamsFeedId);
  for (const a of c.assets) {
    if (a.resolver === "streams" && !SIGMA_BANDS[a.label]) {
      throw new Error(`${a.label}: no sigma band in constants.ts`);
    }
  }
}

export class Deployer {
  readonly gasMultiplierPct = 115n; // Monad bills the gas LIMIT: keep it tight
  state: Deployment;
  private readonly log: (s: string) => void;

  constructor(
    readonly pub: PublicClient,
    readonly wallet: WalletClient,
    readonly cfg: DeployConfig,
    log: (s: string) => void = (s) => console.log(s),
  ) {
    this.state = readState(cfg.network, cfg.chainId);
    this.log = log;
  }

  get me(): Address {
    return (this.wallet.account as { address: Address }).address;
  }

  private save(): void {
    writeState(this.state);
  }

  // ------------------------------------------------------------------ primitives

  private async hasCode(a: Address | undefined): Promise<boolean> {
    if (!a) return false;
    const c = await this.pub.getCode({ address: a });
    return !!c && c !== "0x";
  }

  /** Test seam: called after each mined transaction, before it is written to the state file. */
  protected async recordHook(): Promise<void> {}

  private async record(step: string, hash: Hex, gasLimit: bigint): Promise<number> {
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${step}: transaction ${hash} reverted`);
    await this.recordHook();
    this.state.transactions.push({
      step,
      hash,
      block: Number(r.blockNumber),
      gasLimit: gasLimit.toString(),
      gasUsed: r.gasUsed.toString(),
      costWei: (gasLimit * r.effectiveGasPrice).toString(),
    });
    this.save();
    return Number(r.blockNumber);
  }

  /** Sends `data` to `to` (or creates when `to` is null) with gas = estimate x 1.15. */
  private async send(
    step: string,
    to: Address | null,
    data: Hex,
  ): Promise<{ hash: Hex; block: number; address?: Address }> {
    const account = this.wallet.account!;
    const est = await this.pub.estimateGas({ account, to: to ?? undefined, data });
    const gas = (est * this.gasMultiplierPct) / 100n;
    const hash = await this.wallet.sendTransaction({
      account,
      chain: this.wallet.chain,
      to: to ?? undefined,
      data,
      gas,
    });
    const block = await this.record(step, hash, gas);
    const address = to
      ? undefined
      : ((await this.pub.getTransactionReceipt({ hash })).contractAddress ?? undefined);
    this.log(`  sent ${step} ${hash} (limit ${gas})`);
    return { hash, block, address };
  }

  private async create(
    step: string,
    name: string,
    args: readonly unknown[],
  ): Promise<{ address: Address; block: number }> {
    const { abi, bytecode } = artifact(name);
    const data = encodeDeployData({ abi, bytecode, args } as never);
    const r = await this.send(`deploy ${step}`, null, data);
    if (!r.address) throw new Error(`${step}: no contract address in the receipt`);
    this.log(`deployed ${step} at ${r.address}`);
    return { address: r.address, block: r.block };
  }

  /** Calls a write function only if `already()` is false. */
  private async ensure(
    step: string,
    already: () => Promise<boolean>,
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> {
    if (await already()) {
      this.log(`  ok   ${step} (already done)`);
      return;
    }
    const { encodeFunctionData } = await import("viem");
    await this.send(step, to, encodeFunctionData({ abi, functionName, args } as never));
  }

  private read<T>(
    address: Address,
    abi: Abi | readonly unknown[],
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  }

  // ------------------------------------------------------------------ preconditions

  /** The checks that must pass before the first transaction. */
  async preflight(): Promise<void> {
    const { cfg } = this;
    validateConfig(cfg, this.me);
    const chainId = await this.pub.getChainId();
    if (chainId !== cfg.chainId)
      throw new Error(`the RPC is chain ${chainId}, expected ${cfg.chainId}`);
    for (const [name, addr] of [
      ["USDC", USDC],
      ["VerifierProxy", VERIFIER_PROXY],
      ["CRE forwarder", CRE_FORWARDER],
    ] as const) {
      if (!(await this.hasCode(addr)))
        throw new Error(`no code at the ${name} address ${addr}: docs/EXTERNAL.md is out of date`);
    }
    if (cfg.assets.some((a) => a.resolver === "round") && !(await this.hasCode(MON_USD_FEED))) {
      throw new Error(`no code at the MON/USD feed ${MON_USD_FEED}`);
    }
    const symbol = await this.read<string>(
      USDC,
      parseAbi(["function symbol() view returns (string)"]),
      "symbol",
    );
    const dec = await this.read<number>(
      USDC,
      parseAbi(["function decimals() view returns (uint8)"]),
      "decimals",
    );
    if (symbol !== "USDC" || dec !== 6)
      throw new Error(`the collateral is ${symbol}/${dec}, expected USDC/6`);
    // the Safe must be a real multisig
    if (!(await this.hasCode(cfg.safe)))
      throw new Error(`SAFE_ADDRESS ${cfg.safe} has no code: it must be a deployed Safe`);
    const owners = await this.read<Address[]>(cfg.safe, safeAbi, "getOwners");
    const threshold = await this.read<bigint>(cfg.safe, safeAbi, "getThreshold");
    this.log(
      `Safe ${cfg.safe}: ${owners.length} owners, threshold ${threshold}, version ${await this.read<string>(cfg.safe, safeAbi, "VERSION")}`,
    );
    if (cfg.network === "mainnet" && (owners.length < 2 || threshold < 2n)) {
      throw new Error(
        "the Safe must have at least 2 owners and a threshold of at least 2 for mainnet",
      );
    }
    if (owners.some((o) => o.toLowerCase() === this.me.toLowerCase())) {
      throw new Error("the deployer key is a signer of the Safe: use separate keys");
    }
  }

  // ------------------------------------------------------------------ the steps

  async run(): Promise<Deployment> {
    await this.preflight();
    const s = this.state;
    const { cfg } = this;
    s.deployer = this.me;
    s.collateral = USDC;
    s.verifier = VERIFIER_PROXY;
    s.creForwarder = CRE_FORWARDER;
    s.roles = {
      safe: cfg.safe,
      guardian: cfg.guardian,
      keeper: cfg.keeper,
      scheduler: cfg.scheduler,
      treasury: cfg.treasury,
    };
    this.save();

    await this.coreContracts();
    await this.assets();
    await this.scheduler();
    await this.vault();
    if (cfg.enablePartners) await this.partners();
    await this.handover();
    return this.state;
  }

  private async coreContracts(): Promise<void> {
    const s = this.state;
    if (!(await this.hasCode(s.marketFactory))) {
      const f = await this.create("MarketFactory", "MarketFactory", [USDC, this.me]);
      s.marketFactory = f.address;
      s.deployBlock = f.block;
      s.marketImplementation = await this.read<Address>(
        f.address,
        marketFactoryAbi,
        "marketImplementation",
      );
      s.outcomeTokenImplementation = await this.read<Address>(
        f.address,
        marketFactoryAbi,
        "tokenImplementation",
      );
      this.save();
    }
    if (!(await this.hasCode(s.dataStreamsResolver))) {
      const r = await this.create("DataStreamsResolver", "DataStreamsResolver", [
        this.me,
        VERIFIER_PROXY,
        FINALIZATION_WINDOW_SEC,
        STREAMS_GRACE_SEC,
      ]);
      s.dataStreamsResolver = r.address;
      this.save();
    }
    if (
      this.cfg.assets.some((a) => a.resolver === "round") &&
      !(await this.hasCode(s.chainlinkRoundResolver))
    ) {
      const r = await this.create("ChainlinkRoundResolver", "ChainlinkRoundResolver", [
        this.me,
        ROUND_LIVENESS_GRACE_SEC,
      ]);
      s.chainlinkRoundResolver = r.address;
      this.save();
    }
  }

  private async assets(): Promise<void> {
    const s = this.state;
    s.assets ??= {};
    const factory = s.marketFactory!;
    for (const a of this.cfg.assets) {
      const assetId = assetIdOf(a.label);
      if (a.resolver === "streams") {
        const feedId = checkStreamFeedId(a.label, a.streamsFeedId);
        const streams = s.dataStreamsResolver!;
        await this.ensure(
          `configure ${a.label} feed ${feedId.slice(0, 10)}…`,
          async () =>
            (await this.read<Hex>(streams, dataStreamsResolverAbi, "feedIdOf", [assetId])) !==
            `0x${"00".repeat(32)}`,
          streams,
          dataStreamsResolverAbi as Abi,
          "configureAsset",
          [assetId, feedId],
        );
        const onchain = await this.read<Hex>(streams, dataStreamsResolverAbi, "feedIdOf", [
          assetId,
        ]);
        if (onchain.toLowerCase() !== feedId.toLowerCase())
          throw new Error(
            `${a.label}: the resolver already holds feed ${onchain}, not ${feedId}. A feed id can never change: this deployment cannot use that resolver.`,
          );
        await this.ensure(
          `register ${a.label} in the factory`,
          async () =>
            (await this.read<{ enabled: boolean }>(factory, marketFactoryAbi, "asset", [assetId]))
              .enabled,
          factory,
          marketFactoryAbi as Abi,
          "setAsset",
          [assetId, streams, a.symbol, true],
        );
        s.assets[a.label] = { assetId, kind: "streams", feedId };
      } else {
        const rr = s.chainlinkRoundResolver!;
        await this.ensure(
          `configure ${a.label} round feed`,
          async () =>
            (
              await this.read<readonly [Address, number]>(
                rr,
                chainlinkRoundResolverAbi,
                "assetConfig",
                [assetId],
              )
            )[0] !== zeroAddress,
          rr,
          chainlinkRoundResolverAbi as Abi,
          "configureAsset",
          [assetId, MON_USD_FEED, MON_MAX_ORACLE_DELAY_SEC],
        );
        await this.ensure(
          `register ${a.label} in the factory`,
          async () =>
            (await this.read<{ enabled: boolean }>(factory, marketFactoryAbi, "asset", [assetId]))
              .enabled,
          factory,
          marketFactoryAbi as Abi,
          "setAsset",
          [assetId, rr, a.symbol, true],
        );
        s.assets[a.label] = { assetId, kind: "round", feed: MON_USD_FEED };
      }
      this.save();
    }
  }

  private async scheduler(): Promise<void> {
    const s = this.state;
    const factory = s.marketFactory!;
    if (!(await this.hasCode(s.schedulerReceiver))) {
      const r = await this.create("SchedulerReceiver", "SchedulerReceiver", [
        CRE_FORWARDER,
        factory,
        this.me,
      ]);
      s.schedulerReceiver = r.address;
      this.save();
    }
    if (!(await this.hasCode(s.schedulerLens))) {
      s.schedulerLens = (await this.create("SchedulerLens", "SchedulerLens", [])).address;
      this.save();
    }
    const receiver = s.schedulerReceiver!;
    for (const who of [receiver, this.cfg.scheduler]) {
      await this.ensure(
        `CREATOR_ROLE to ${who}`,
        () => this.read<boolean>(factory, accessAbi, "hasRole", [CREATOR_ROLE, who]),
        factory,
        accessAbi as Abi,
        "grantRole",
        [CREATOR_ROLE, who],
      );
    }
    await this.ensure(
      `GUARDIAN_ROLE to ${this.cfg.guardian}`,
      () => this.read<boolean>(factory, accessAbi, "hasRole", [GUARDIAN_ROLE, this.cfg.guardian]),
      factory,
      accessAbi as Abi,
      "grantRole",
      [GUARDIAN_ROLE, this.cfg.guardian],
    );
    // CRE is not set up yet (no account): the fallback scheduler acts. The workflow owner and id
    // are set by the Safe once a CRE workflow exists (setWorkflow); until then the receiver rejects every report.
    const want = this.cfg.leader === "fallback" ? 1 : 0;
    await this.ensure(
      `scheduler leader = ${this.cfg.leader}`,
      async () =>
        Number(await this.read<number>(receiver, schedulerReceiverAbi, "leader")) === want,
      receiver,
      schedulerReceiverAbi as Abi,
      "setLeader",
      [want],
    );
  }

  private async vault(): Promise<void> {
    const s = this.state;
    const { cfg } = this;
    const params = loadLaunchParams();
    if (!(await this.hasCode(s.vault?.vault))) {
      const v = await this.create("ConvergeVault", "ConvergeVault", [
        USDC,
        s.marketFactory,
        s.dataStreamsResolver,
        this.me, // owner for the setup; handed to the Safe in the last step
        cfg.guardian,
        cfg.keeper,
        cfg.treasury,
        EPOCH_LENGTH_SEC,
        MIN_REQUEST,
        cfg.tvlCap,
        params,
      ]);
      const venue = await this.create("ForwardVenue", "ForwardVenue", [
        v.address,
        VENUE_EXEC_DELAY,
        VENUE_MAX_LATENESS,
        VENUE_MIN_REWARD,
      ]);
      s.vault = {
        vault: v.address,
        forwardVenue: venue.address,
        deployBlock: v.block,
        vaultKeeper: cfg.keeper,
        epochLength: Number(EPOCH_LENGTH_SEC),
        tvlCap: cfg.tvlCap.toString(),
        execDelaySeconds: VENUE_EXEC_DELAY,
        maxLatenessSeconds: VENUE_MAX_LATENESS,
      };
      this.save();
    }
    const vault = s.vault!.vault;
    for (const a of cfg.assets.filter((x) => x.resolver === "streams")) {
      const id = assetIdOf(a.label);
      const band = SIGMA_BANDS[a.label]!;
      await this.ensure(
        `enable ${a.label} in the vault`,
        async () =>
          (await this.read<readonly [boolean]>(vault, convergeVaultAbi, "assetCfg", [id]))[0],
        vault,
        convergeVaultAbi as Abi,
        "enableAsset",
        [id, band.min, band.max],
      );
    }
    await this.ensure(
      "set the initial venue",
      async () => (await this.read<Address>(vault, convergeVaultAbi, "venue")) !== zeroAddress,
      vault,
      convergeVaultAbi as Abi,
      "setInitialVenue",
      [s.vault!.forwardVenue],
    );
    // The vault starts PAUSED: deposits and withdrawals work, nothing trades. The Safe resumes it
    // as the last item of docs/ops/launch-checklist.md, after the canary preconditions are met.
    await this.ensure(
      "pause quoting until launch",
      () => this.read<boolean>(vault, convergeVaultAbi, "quotingPaused"),
      vault,
      convergeVaultAbi as Abi,
      "pauseQuoting",
      [],
    );
  }

  private async partners(): Promise<void> {
    const s = this.state;
    const { cfg } = this;
    if (!(await this.hasCode(s.partners?.partnerRegistry))) {
      const r = await this.create("PartnerRegistry", "PartnerRegistry", [
        s.marketFactory,
        this.me,
        cfg.guardian,
        cfg.treasury,
      ]);
      const impl = await this.read<Address>(
        r.address,
        partnerRegistryAbi,
        "thresholdImplementation",
      );
      s.partners = {
        partnerRegistry: r.address,
        deployBlock: r.block,
        thresholdResolverImplementation: impl,
        minBond: PARTNER_DEFAULTS.minBond.toString(),
        globalExposureCap: PARTNER_DEFAULTS.globalExposureCap.toString(),
        redeemFeeBps: PARTNER_DEFAULTS.redeemFeeBps,
      };
      this.save();
    }
    const reg = s.partners!.partnerRegistry;
    const vault = s.vault!.vault;
    // the vault announces its registry FIRST so that indexers follow it from the start
    await this.ensure(
      "vault.setPartnerRegistry",
      async () =>
        (await this.read<Address>(vault, convergeVaultAbi, "partnerRegistry")) !== zeroAddress,
      vault,
      convergeVaultAbi as Abi,
      "setPartnerRegistry",
      [reg],
    );
    await this.ensure(
      "registry.setVault",
      async () => (await this.read<Address>(reg, partnerRegistryAbi, "vault")) !== zeroAddress,
      reg,
      partnerRegistryAbi as Abi,
      "setVault",
      [vault],
    );
    await this.ensure(
      "registry.setConfig",
      async () =>
        (await this.read<bigint>(reg, partnerRegistryAbi, "minBond")) ===
          PARTNER_DEFAULTS.minBond &&
        (await this.read<Address>(reg, partnerRegistryAbi, "slashRecipient")).toLowerCase() ===
          vault.toLowerCase(),
      reg,
      partnerRegistryAbi as Abi,
      "setConfig",
      [
        PARTNER_DEFAULTS.minBond,
        PARTNER_DEFAULTS.globalExposureCap,
        PARTNER_DEFAULTS.redeemFeeBps,
        cfg.treasury,
        vault,
      ],
    );
    for (const a of cfg.assets.filter((x) => x.resolver === "streams")) {
      const id = assetIdOf(a.label);
      await this.ensure(
        `registry.setFeed ${a.label}`,
        () => this.read<boolean>(reg, partnerRegistryAbi, "feedEnabled", [id]),
        reg,
        partnerRegistryAbi as Abi,
        "setFeed",
        [id, true],
      );
    }
  }

  /** Ownership and roles: the Safe takes everything, the deployer keeps nothing. */
  private async handover(): Promise<void> {
    const s = this.state;
    const { cfg } = this;
    const pending: string[] = [];
    const ownable: [string, Address | undefined][] = [
      ["ConvergeVault", s.vault?.vault],
      ["DataStreamsResolver", s.dataStreamsResolver],
      ["ChainlinkRoundResolver", s.chainlinkRoundResolver],
      ["PartnerRegistry", s.partners?.partnerRegistry],
    ];
    for (const [name, addr] of ownable) {
      if (!addr) continue;
      const owner = await this.read<Address>(addr, ownableAbi, "owner");
      if (owner.toLowerCase() === cfg.safe.toLowerCase()) {
        this.log(`  ok   ${name} is owned by the Safe`);
        continue;
      }
      if (owner.toLowerCase() !== this.me.toLowerCase())
        throw new Error(`${name} is owned by ${owner}: neither the Safe nor the deployer`);
      const p = await this.read<Address>(addr, ownableAbi, "pendingOwner");
      if (p.toLowerCase() !== cfg.safe.toLowerCase()) {
        const { encodeFunctionData } = await import("viem");
        await this.send(
          `${name}.transferOwnership(safe)`,
          addr,
          encodeFunctionData({
            abi: ownableAbi,
            functionName: "transferOwnership",
            args: [cfg.safe],
          }),
        );
      }
      pending.push(`${name} ${addr}`);
    }

    // AccessControl contracts: the Safe gets the admin role; the deployer renounces everything
    const ac: [string, Address | undefined, Hex[]][] = [
      ["MarketFactory", s.marketFactory, [CREATOR_ROLE, GUARDIAN_ROLE]],
      ["SchedulerReceiver", s.schedulerReceiver, [OPERATOR_ROLE]],
    ];
    for (const [name, addr, others] of ac) {
      if (!addr) continue;
      for (const role of [
        DEFAULT_ADMIN_ROLE,
        ...(name === "SchedulerReceiver" ? [OPERATOR_ROLE] : []),
      ]) {
        await this.ensure(
          `${name}: ${role === DEFAULT_ADMIN_ROLE ? "ADMIN" : "OPERATOR"} to the Safe`,
          () => this.read<boolean>(addr, accessAbi, "hasRole", [role, cfg.safe]),
          addr,
          accessAbi as Abi,
          "grantRole",
          [role, cfg.safe],
        );
      }
      const mine = [...others, DEFAULT_ADMIN_ROLE];
      // the deployer's creator role first, the admin role last (it is needed to renounce the others)
      for (const role of mine) {
        if (await this.read<boolean>(addr, accessAbi, "hasRole", [role, this.me])) {
          const { encodeFunctionData } = await import("viem");
          await this.send(
            `${name}: deployer renounces ${role.slice(0, 10)}`,
            addr,
            encodeFunctionData({
              abi: accessAbi,
              functionName: "renounceRole",
              args: [role, this.me],
            }),
          );
        }
      }
      // SchedulerReceiver also had the OPERATOR role for the deployer
      if (
        name === "SchedulerReceiver" &&
        (await this.read<boolean>(addr, accessAbi, "hasRole", [OPERATOR_ROLE, this.me]))
      ) {
        const { encodeFunctionData } = await import("viem");
        await this.send(
          `${name}: deployer renounces OPERATOR`,
          addr,
          encodeFunctionData({
            abi: accessAbi,
            functionName: "renounceRole",
            args: [OPERATOR_ROLE, this.me],
          }),
        );
      }
    }
    s.handover = { done: pending.length === 0, pendingSafeAcceptance: pending };
    this.save();
    if (pending.length) {
      this.log(
        `HANDOVER PENDING: the Safe must execute acceptOwnership() on: ${pending.join(", ")} (npm script: safe-batch)`,
      );
    }
  }

  totalCostWei(): bigint {
    return this.state.transactions.reduce((a, t) => a + BigInt(t.costWei), 0n);
  }
}

/** Constructor-argument encoding for explorer verification (printed by the `explorer` command). */
export function encodeArgs(types: readonly { type: string }[], values: readonly unknown[]): Hex {
  return encodeAbiParameters(types as never, values as never);
}

export { concatHex, forwardVenueAbi };
export type { PublicClient, WalletClient };
