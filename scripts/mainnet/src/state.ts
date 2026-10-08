/**
 * The deployment record: deployments/<network>.json. It is the idempotency state (a re-run skips
 * what is already there and checks it) and the input of the indexer, keeper and app generators, so
 * it keeps the shape of deployments/testnet.json: `chainId`, `deployBlock`, `marketFactory`,
 * `vault.{vault,forwardVenue,deployBlock,vaultKeeper,tvlCap}`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address, Hex } from "viem";
import { repoRoot } from "./params";

export interface TxRecord {
  step: string;
  hash: Hex;
  block: number;
  gasLimit: string;
  gasUsed: string;
  /** What Monad bills: the gas LIMIT times the effective price, in wei. */
  costWei: string;
}

export interface Deployment {
  chainId: number;
  network: string;
  deployBlock?: number;
  deployer?: Address;
  roles?: {
    safe: Address;
    guardian: Address;
    keeper: Address;
    scheduler: Address;
    treasury: Address;
  };
  collateral?: Address;
  verifier?: Address;
  creForwarder?: Address;
  marketFactory?: Address;
  marketImplementation?: Address;
  outcomeTokenImplementation?: Address;
  dataStreamsResolver?: Address;
  chainlinkRoundResolver?: Address;
  /** OwnerTimelock: the owner of the vault, the resolvers and the registry. The Safe proposes and executes. */
  timelock?: Address;
  timelockDelaySec?: number;
  schedulerReceiver?: Address;
  schedulerLens?: Address;
  assets?: Record<
    string,
    { assetId: Hex; kind: "streams" | "round"; feedId?: Hex; feed?: Address }
  >;
  vault?: {
    vault: Address;
    forwardVenue: Address;
    deployBlock: number;
    vaultKeeper: Address;
    vaultOwnerGuardianTreasury?: Address;
    epochLength: number;
    tvlCap: string;
    execDelaySeconds: number;
    maxLatenessSeconds: number;
  };
  partners?: {
    partnerRegistry: Address;
    deployBlock: number;
    thresholdResolverImplementation: Address;
    minBond: string;
    globalExposureCap: string;
    redeemFeeBps: number;
  };
  handover?: { done: boolean; pendingSafeAcceptance: string[] };
  transactions: TxRecord[];
}

export const statePath = (network: string): string =>
  resolve(repoRoot, "deployments", `${network}.json`);

export function readState(network: string, chainId: number): Deployment {
  const p = statePath(network);
  if (!existsSync(p)) return { chainId, network, transactions: [] };
  const d = JSON.parse(readFileSync(p, "utf8")) as Deployment;
  if (d.chainId !== chainId) {
    throw new Error(`${p} is for chain ${d.chainId}, the RPC is chain ${chainId}`);
  }
  d.transactions ??= [];
  return d;
}

export function writeState(d: Deployment): void {
  const p = statePath(d.network);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
}
