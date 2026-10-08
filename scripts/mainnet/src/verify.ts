/**
 * Read-only verification of a deployment against the intended configuration. It trusts nothing in
 * the state file: every claim is read from the chain. Exit code 1 if anything FAILs. A WARN is
 * something that is correct but not final (a Safe acceptance that is still pending, CRE not set up).
 */
import {
  keccak256,
  toHex,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  chainlinkRoundResolverAbi,
  convergeVaultAbi,
  dataStreamsResolverAbi,
  forwardVenueAbi,
  marketFactoryAbi,
  partnerRegistryAbi,
  schedulerReceiverAbi,
} from "@converge/sdk";
import {
  CREATOR_ROLE,
  DEFAULT_ADMIN_ROLE,
  GUARDIAN_ROLE,
  OPERATOR_ROLE,
  assetIdOf,
  type DeployConfig,
} from "./deploy";
import {
  CRE_FORWARDER,
  EPOCH_LENGTH_SEC,
  FINALIZATION_WINDOW_SEC,
  MIN_REQUEST,
  MON_MAX_ORACLE_DELAY_SEC,
  MON_USD_FEED,
  SIGMA_BANDS,
  STREAMS_GRACE_SEC,
  USDC,
  VENUE_EXEC_DELAY,
  VENUE_MAX_LATENESS,
  VENUE_MIN_REWARD,
  VERIFIER_PROXY,
} from "./constants";
import { loadLaunchParams } from "./params";
import type { Deployment } from "./state";

export type Level = "PASS" | "WARN" | "FAIL";
export interface Check {
  level: Level;
  what: string;
  detail?: string;
}

const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);
const accessAbi = parseAbi(["function hasRole(bytes32,address) view returns (bool)"]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function verifyDeployment(
  pub: PublicClient,
  d: Deployment,
  cfg: DeployConfig,
  deployer: Address | undefined,
): Promise<Check[]> {
  const out: Check[] = [];
  const add = (level: Level, what: string, detail?: string) => out.push({ level, what, detail });
  const expect = (ok: boolean, what: string, detail?: string) =>
    add(ok ? "PASS" : "FAIL", what, ok ? undefined : detail);
  const rd = <T>(
    address: Address,
    abi: readonly unknown[],
    fn: string,
    args: readonly unknown[] = [],
  ) => pub.readContract({ address, abi, functionName: fn, args } as never) as Promise<T>;
  const code = async (name: string, a: Address | undefined): Promise<boolean> => {
    const c = a ? await pub.getCode({ address: a }) : undefined;
    expect(!!c && c !== "0x", `${name} has code`, `${name} ${a ?? "(not deployed)"}`);
    return !!c && c !== "0x";
  };

  expect((await pub.getChainId()) === cfg.chainId, `chain id is ${cfg.chainId}`);

  // The contracts forward no value to the verifier and call it from three contracts: both are only
  // true while the proxy has no fee manager and no access controller (audit F9-02, F9-05).
  const proxyAbi = [
    {
      type: "function",
      name: "s_feeManager",
      inputs: [],
      outputs: [{ type: "address" }],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "s_accessController",
      inputs: [],
      outputs: [{ type: "address" }],
      stateMutability: "view",
    },
  ] as const;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const fm = await rd<Address>(VERIFIER_PROXY, proxyAbi, "s_feeManager").catch(() => undefined);
  expect(
    fm !== undefined && eq(fm, ZERO),
    "VerifierProxy has no fee manager (the vault and venue forward no value)",
    fm ? `fee manager ${fm}` : "unreadable",
  );
  const ac = await rd<Address>(VERIFIER_PROXY, proxyAbi, "s_accessController").catch(
    () => undefined,
  );
  expect(
    ac !== undefined && eq(ac, ZERO),
    "VerifierProxy has no access controller (vault, venue and resolver may all verify)",
    ac ? `access controller ${ac}` : "unreadable",
  );
  const tl = d.timelock;
  const owned = async (name: string, a: Address | undefined) => {
    if (!a) return;
    if (!tl) return add("FAIL", `${name}: the deployment has no timelock to own it`);
    const owner = await rd<Address>(a, ownableAbi, "owner");
    if (eq(owner, tl)) return add("PASS", `${name} is owned by the timelock`);
    const pend = await rd<Address>(a, ownableAbi, "pendingOwner");
    if (eq(pend, tl))
      return add(
        "WARN",
        `${name}: ownership is PENDING, the Safe must run the handover batch (acceptOwnership through the timelock)`,
        a,
      );
    add("FAIL", `${name} is not owned by the timelock`, `owner ${owner}, pending ${pend}`);
    if (deployer && eq(owner, deployer)) add("FAIL", `${name} is still owned by the deployer key`);
  };

  // ---- the owner timelock
  if (await code("OwnerTimelock", tl)) {
    const t = tl!;
    const timelockAbiV = parseAbi([
      "function getMinDelay() view returns (uint256)",
      "function hasRole(bytes32,address) view returns (bool)",
    ]);
    const R = (n: string) => keccak256(toHex(n));
    const delay = Number(await rd<bigint>(t, timelockAbiV, "getMinDelay"));
    if (delay >= cfg.timelockDelaySec)
      add("PASS", `timelock delay is ${delay} s (configured ${cfg.timelockDelaySec} s)`);
    else if (delay === 0 && !d.handover?.done)
      add(
        "WARN",
        `timelock delay is still 0 (boot state): the handover batch raises it to ${cfg.timelockDelaySec} s`,
      );
    else add("FAIL", `timelock delay ${delay} s is below the configured ${cfg.timelockDelaySec} s`);
    for (const [role, label] of [
      ["PROPOSER_ROLE", "propose"],
      ["EXECUTOR_ROLE", "execute"],
      ["CANCELLER_ROLE", "cancel"],
    ] as const)
      expect(
        await rd<boolean>(t, timelockAbiV, "hasRole", [R(role), cfg.safe]),
        `the Safe can ${label} on the timelock`,
      );
    expect(
      !(await rd<boolean>(t, timelockAbiV, "hasRole", [DEFAULT_ADMIN_ROLE, cfg.safe])) &&
        (!deployer ||
          !(await rd<boolean>(t, timelockAbiV, "hasRole", [DEFAULT_ADMIN_ROLE, deployer]))),
      "nobody but the timelock itself administers the timelock (no admin to bypass the delay)",
    );
    expect(
      await rd<boolean>(t, timelockAbiV, "hasRole", [DEFAULT_ADMIN_ROLE, t]),
      "the timelock administers itself (its own delay can only change through a timelocked call)",
    );
    if (deployer)
      expect(
        !(await rd<boolean>(t, timelockAbiV, "hasRole", [R("PROPOSER_ROLE"), deployer])),
        "the deployer cannot propose on the timelock",
      );
  }

  // ---- factory
  if (await code("MarketFactory", d.marketFactory)) {
    const f = d.marketFactory!;
    expect(
      eq(await rd<Address>(f, marketFactoryAbi, "collateral"), USDC),
      "factory collateral is the real USDC",
    );
    expect(
      tl !== undefined && (await rd<boolean>(f, accessAbi, "hasRole", [DEFAULT_ADMIN_ROLE, tl])),
      "the timelock is admin of the factory",
    );
    if (deployer)
      expect(
        !(await rd<boolean>(f, accessAbi, "hasRole", [DEFAULT_ADMIN_ROLE, deployer])),
        "the deployer is not admin of the factory",
      );
    if (d.schedulerReceiver)
      expect(
        await rd<boolean>(f, accessAbi, "hasRole", [CREATOR_ROLE, d.schedulerReceiver]),
        "the scheduler receiver can create markets",
      );
    expect(
      await rd<boolean>(f, accessAbi, "hasRole", [CREATOR_ROLE, cfg.scheduler]),
      "the fallback scheduler key can create markets",
    );
    expect(
      await rd<boolean>(f, accessAbi, "hasRole", [GUARDIAN_ROLE, cfg.guardian]),
      "the guardian key holds GUARDIAN_ROLE on the factory",
    );
    if (deployer) {
      expect(
        !(await rd<boolean>(f, accessAbi, "hasRole", [CREATOR_ROLE, deployer])),
        "the deployer cannot create markets",
      );
      expect(
        !(await rd<boolean>(f, accessAbi, "hasRole", [GUARDIAN_ROLE, deployer])),
        "the deployer is not a guardian",
      );
    }
    expect(!(await rd<boolean>(f, marketFactoryAbi, "paused")), "market creation is not paused");
    const fee = await rd<number>(f, marketFactoryAbi, "redeemFeeBps");
    add("PASS", `redeem fee of core markets is ${fee} bps (set by the Safe; capped at 100)`);
  }

  // ---- resolvers
  if (await code("DataStreamsResolver", d.dataStreamsResolver)) {
    const r = d.dataStreamsResolver!;
    expect(
      eq(await rd<Address>(r, dataStreamsResolverAbi, "verifier"), VERIFIER_PROXY),
      "the resolver verifies with the real Chainlink VerifierProxy",
    );
    expect(
      BigInt(await rd<bigint>(r, dataStreamsResolverAbi, "finalizationWindow")) ===
        FINALIZATION_WINDOW_SEC,
      `finalization window is ${FINALIZATION_WINDOW_SEC} s`,
    );
    expect(
      BigInt(await rd<bigint>(r, dataStreamsResolverAbi, "grace")) === STREAMS_GRACE_SEC,
      `grace is ${STREAMS_GRACE_SEC} s`,
    );
    for (const a of cfg.assets.filter((x) => x.resolver === "streams")) {
      const onchain = await rd<Hex>(r, dataStreamsResolverAbi, "feedIdOf", [assetIdOf(a.label)]);
      expect(
        a.streamsFeedId !== undefined && eq(onchain, a.streamsFeedId),
        `${a.label}: the resolver holds the intended Data Streams feed id`,
        `on chain ${onchain}, config ${a.streamsFeedId}`,
      );
    }
    await owned("DataStreamsResolver", r);
  }
  if (
    d.chainlinkRoundResolver &&
    (await code("ChainlinkRoundResolver", d.chainlinkRoundResolver))
  ) {
    const rr = d.chainlinkRoundResolver;
    const cfgRow = await rd<readonly [Address, number]>(
      rr,
      chainlinkRoundResolverAbi,
      "assetConfig",
      [assetIdOf("MON/USD")],
    );
    expect(
      eq(cfgRow[0], MON_USD_FEED) && Number(cfgRow[1]) === MON_MAX_ORACLE_DELAY_SEC,
      "MON/USD round resolver points at the real Chainlink MON/USD feed with the intended maximum delay",
    );
    await owned("ChainlinkRoundResolver", rr);
  }

  // ---- vault and venue
  if (
    d.vault &&
    (await code("ConvergeVault", d.vault.vault)) &&
    (await code("ForwardVenue", d.vault.forwardVenue))
  ) {
    const v = d.vault.vault;
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "asset"), USDC),
      "vault asset is the real USDC",
    );
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "factory"), d.marketFactory!),
      "vault factory is ours",
    );
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "streams"), d.dataStreamsResolver!),
      "vault streams resolver is ours",
    );
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "verifier"), VERIFIER_PROXY),
      "vault verifier is the real VerifierProxy",
    );
    expect(
      BigInt(await rd<bigint>(v, convergeVaultAbi, "epochLength")) === EPOCH_LENGTH_SEC,
      "epoch length is 15 minutes",
    );
    expect(
      BigInt(await rd<bigint>(v, convergeVaultAbi, "minRequest")) === MIN_REQUEST,
      "minimum request is 10 USDC",
    );
    const cap = await rd<bigint>(v, convergeVaultAbi, "tvlCap");
    expect(cap === cfg.tvlCap, `TVL cap is ${Number(cfg.tvlCap) / 1e6} USDC`, `on chain ${cap}`);
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "keeper"), cfg.keeper),
      "keeper is the hot keeper key",
    );
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "guardian"), cfg.guardian),
      "guardian is the guardian key",
    );
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "treasury"), cfg.treasury),
      "treasury is as configured",
    );
    expect(
      !eq(cfg.keeper, cfg.safe) && !eq(cfg.guardian, cfg.keeper),
      "keeper, guardian and Safe are three different addresses",
    );
    expect(
      eq(await rd<Address>(v, convergeVaultAbi, "venue"), d.vault.forwardVenue),
      "the venue is linked",
    );
    const vp = await rd<Record<string, bigint>>(v, convergeVaultAbi, "quoteParams");
    const want = loadLaunchParams();
    const bad = Object.keys(want).filter(
      (k) => (vp[k] as bigint) !== (want as unknown as Record<string, bigint>)[k],
    );
    expect(
      bad.length === 0,
      "quote parameters equal config/strategy.default.json",
      `differ: ${bad.join(", ")}`,
    );
    for (const a of cfg.assets.filter((x) => x.resolver === "streams")) {
      const row = await rd<readonly [boolean, Hex, bigint, bigint, bigint, bigint]>(
        v,
        convergeVaultAbi,
        "assetCfg",
        [assetIdOf(a.label)],
      );
      const band = SIGMA_BANDS[a.label]!;
      expect(
        row[0] && row[4] === band.min && row[5] === band.max,
        `${a.label}: enabled in the vault with the intended sigma band`,
      );
    }
    const paused = await rd<boolean>(v, convergeVaultAbi, "quotingPaused");
    add(
      paused ? "WARN" : "PASS",
      paused ? "quoting is PAUSED (resumed at launch through the timelock)" : "quoting is live",
    );
    const supply = await rd<bigint>(v, convergeVaultAbi, "totalSupply");
    add("PASS", `vault share supply ${supply}`);
    await owned("ConvergeVault", v);

    const ve = d.vault.forwardVenue;
    expect(eq(await rd<Address>(ve, forwardVenueAbi, "vault"), v), "venue points at the vault");
    expect(
      Number(await rd<number>(ve, forwardVenueAbi, "execDelay")) === VENUE_EXEC_DELAY &&
        Number(await rd<number>(ve, forwardVenueAbi, "maxLateness")) === VENUE_MAX_LATENESS,
      "venue timing is 2 s / 4 s",
    );
    expect(
      BigInt(await rd<bigint>(ve, forwardVenueAbi, "minReward")) === VENUE_MIN_REWARD,
      "venue minimum reward is as configured",
    );
  }

  // ---- scheduler
  if (d.schedulerReceiver && (await code("SchedulerReceiver", d.schedulerReceiver))) {
    const r = d.schedulerReceiver;
    expect(
      eq(await rd<Address>(r, schedulerReceiverAbi, "forwarder"), CRE_FORWARDER),
      "receiver trusts only the real CRE forwarder",
    );
    expect(
      tl !== undefined && (await rd<boolean>(r, accessAbi, "hasRole", [DEFAULT_ADMIN_ROLE, tl])),
      "the timelock is admin of the receiver",
    );
    expect(
      await rd<boolean>(r, accessAbi, "hasRole", [OPERATOR_ROLE, cfg.safe]),
      "the Safe can switch the scheduler leader",
    );
    if (deployer)
      expect(
        !(await rd<boolean>(r, accessAbi, "hasRole", [DEFAULT_ADMIN_ROLE, deployer])) &&
          !(await rd<boolean>(r, accessAbi, "hasRole", [OPERATOR_ROLE, deployer])),
        "the deployer holds no role on the receiver",
      );
    const wo = await rd<Address>(r, schedulerReceiverAbi, "expectedWorkflowOwner");
    if (wo === zeroAddress)
      add(
        "WARN",
        "CRE workflow owner is not set: the receiver rejects every CRE report (the fallback scheduler is the leader)",
      );
    const leader = Number(await rd<number>(r, schedulerReceiverAbi, "leader"));
    add("PASS", `scheduler leader is ${leader === 1 ? "FALLBACK" : "CRE"}`);
  }

  // ---- partners
  if (d.partners && (await code("PartnerRegistry", d.partners.partnerRegistry))) {
    const reg = d.partners.partnerRegistry;
    expect(
      eq(await rd<Address>(reg, partnerRegistryAbi, "vault"), d.vault!.vault),
      "registry knows the vault",
    );
    expect(
      eq(await rd<Address>(d.vault!.vault, convergeVaultAbi, "partnerRegistry"), reg),
      "vault accepts exactly this registry",
    );
    await owned("PartnerRegistry", reg);
  }

  if (deployer) {
    for (const [name, a] of [
      ["vault", d.vault?.vault],
      ["streams", d.dataStreamsResolver],
      ["registry", d.partners?.partnerRegistry],
    ] as const) {
      if (!a) continue;
      const stillOwner = eq(await rd<Address>(a, ownableAbi, "owner"), deployer);
      if (!stillOwner) add("PASS", `the deployer does not own the ${name}`);
      else if (tl && eq(await rd<Address>(a, ownableAbi, "pendingOwner"), tl))
        add(
          "WARN",
          `the deployer still owns the ${name} until the handover batch runs (handover pending)`,
        );
      else add("FAIL", `the deployer does not own the ${name}`);
    }
  }
  return out;
}

export function render(checks: Check[]): string {
  const mark = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" } as const;
  return checks
    .map((c) => `${mark[c.level]}  ${c.what}${c.detail ? `  [${c.detail}]` : ""}`)
    .join("\n");
}
