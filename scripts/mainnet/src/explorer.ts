/**
 * `forge verify-contract` commands for every deployed contract. The constructor arguments are
 * taken from the creation transaction itself (its input minus the artifact's creation code), so
 * they are exactly what was deployed. Commands for MonadVision (Sourcify, no key) per
 * https://docs.monad.xyz/guides/verify-smart-contract/foundry (read 2026-10-08).
 */
import type { Address, Hex, PublicClient } from "viem";
import { artifact } from "./artifacts";
import type { Deployment } from "./state";

export const SOURCIFY_URL = "https://sourcify-api-monad.blockvision.org/";

const TARGETS: {
  name: string;
  path: string;
  addr: (d: Deployment) => Address | undefined;
  step: string;
}[] = [
  {
    name: "OwnerTimelock",
    path: "src/governance/OwnerTimelock.sol:OwnerTimelock",
    addr: (d) => d.timelock,
    step: "deploy OwnerTimelock",
  },
  {
    name: "MarketFactory",
    path: "src/MarketFactory.sol:MarketFactory",
    addr: (d) => d.marketFactory,
    step: "deploy MarketFactory",
  },
  {
    name: "DataStreamsResolver",
    path: "src/resolvers/DataStreamsResolver.sol:DataStreamsResolver",
    addr: (d) => d.dataStreamsResolver,
    step: "deploy DataStreamsResolver",
  },
  {
    name: "ChainlinkRoundResolver",
    path: "src/resolvers/ChainlinkRoundResolver.sol:ChainlinkRoundResolver",
    addr: (d) => d.chainlinkRoundResolver,
    step: "deploy ChainlinkRoundResolver",
  },
  {
    name: "SchedulerReceiver",
    path: "src/scheduler/SchedulerReceiver.sol:SchedulerReceiver",
    addr: (d) => d.schedulerReceiver,
    step: "deploy SchedulerReceiver",
  },
  {
    name: "SchedulerLens",
    path: "src/scheduler/SchedulerLens.sol:SchedulerLens",
    addr: (d) => d.schedulerLens,
    step: "deploy SchedulerLens",
  },
  {
    name: "ConvergeVault",
    path: "src/vault/ConvergeVault.sol:ConvergeVault",
    addr: (d) => d.vault?.vault,
    step: "deploy ConvergeVault",
  },
  {
    name: "ForwardVenue",
    path: "src/vault/ForwardVenue.sol:ForwardVenue",
    addr: (d) => d.vault?.forwardVenue,
    step: "deploy ForwardVenue",
  },
  {
    name: "PartnerRegistry",
    path: "src/partners/PartnerRegistry.sol:PartnerRegistry",
    addr: (d) => d.partners?.partnerRegistry,
    step: "deploy PartnerRegistry",
  },
];

/** The constructor arguments of a deployed contract, read from its creation transaction. */
export async function constructorArgsOf(
  pub: PublicClient,
  d: Deployment,
  step: string,
  name: string,
): Promise<Hex> {
  const rec = d.transactions.find((t) => t.step === step);
  if (!rec) throw new Error(`no creation transaction recorded for ${name}`);
  const tx = await pub.getTransaction({ hash: rec.hash });
  const { bytecode } = artifact(name);
  if (!tx.input.toLowerCase().startsWith(bytecode.toLowerCase().slice(0, 200))) {
    throw new Error(
      `${name}: the creation transaction does not start with the current artifact's creation code: rebuild the contracts at the deployed commit before verifying`,
    );
  }
  return ("0x" + tx.input.slice(bytecode.length)) as Hex;
}

export async function verifyCommands(pub: PublicClient, d: Deployment): Promise<string[]> {
  const out: string[] = [
    `# run from contracts/, at the commit that was deployed; chain ${d.chainId}`,
  ];
  for (const t of TARGETS) {
    const a = t.addr(d);
    if (!a) continue;
    const args = await constructorArgsOf(pub, d, t.step, t.name);
    out.push(
      `forge verify-contract ${a} ${t.path} --chain ${d.chainId} --verifier sourcify --verifier-url ${SOURCIFY_URL} --constructor-args ${args}`,
    );
  }
  out.push("# the implementations that the factory and the registry create in their constructors:");
  for (const [n, a] of [
    ["Market (implementation)", d.marketImplementation],
    ["OutcomeToken (implementation)", d.outcomeTokenImplementation],
    ["ThresholdResolver (implementation)", d.partners?.thresholdResolverImplementation],
  ] as const) {
    if (a)
      out.push(
        `# ${n} ${a}: forge verify-contract ${a} <path:Name> --chain ${d.chainId} --verifier sourcify --verifier-url ${SOURCIFY_URL}`,
      );
  }
  return out;
}
