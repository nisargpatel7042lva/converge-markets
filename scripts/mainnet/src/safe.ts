/**
 * Safe Transaction Builder batches (the JSON the Safe web app imports). Every owner action goes
 * through the OwnerTimelock, so each batch is a call to the timelock:
 *  - handover:        schedule + execute (delay 0 while the timelock is still in its boot state):
 *                     acceptOwnership() on every contract the deployer handed to the timelock, then
 *                     updateDelay(configured delay). After it, every owner action waits that long.
 *  - launch-schedule: schedule resumeQuoting() on the vault with the full delay.
 *  - launch-execute:  execute it, once the delay has passed. Only after docs/ops/launch-checklist.md
 *                     is ticked.
 * The guardian pauses at any time, without the timelock.
 */
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { convergeVaultAbi } from "@converge/sdk";
import type { Deployment } from "./state";

export interface SafeBatch {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: { name: string; description: string };
  transactions: {
    to: Address;
    value: "0";
    data: Hex;
    contractMethod: null;
    contractInputsValues: null;
  }[];
}

export const timelockAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function updateDelay(uint256 newDelay)",
  "function getMinDelay() view returns (uint256)",
]);
const accept = parseAbi(["function acceptOwnership()"]);

/** Fixed salts: the same batch always has the same operation id, so a re-generated file is the same operation. */
export const HANDOVER_SALT = keccak256(toHex("converge:handover:v1"));
export const LAUNCH_SALT = keccak256(toHex("converge:launch:v1"));
/** Each resume is a new operation: a salt label per attempt (v1 is the launch; use v2, v3 … after a pause). */
export const launchSalt = (label = "v1"): Hex => keccak256(toHex(`converge:launch:${label}`));

const tx = (to: Address, data: Hex) => ({
  to,
  value: "0" as const,
  data,
  contractMethod: null,
  contractInputsValues: null,
});

export interface Call {
  to: Address;
  data: Hex;
}

/** What the handover executes, in order (also used by the rehearsal test). */
export function handoverCalls(d: Deployment, delaySec: number): Call[] {
  if (!d.timelock) throw new Error("no timelock in the deployment");
  const targets: (Address | undefined)[] = [
    d.vault?.vault,
    d.dataStreamsResolver,
    d.chainlinkRoundResolver,
    d.partners?.partnerRegistry,
  ];
  const data = encodeFunctionData({ abi: accept, functionName: "acceptOwnership" });
  return [
    ...targets.filter((a): a is Address => !!a).map((to) => ({ to, data })),
    {
      to: d.timelock,
      data: encodeFunctionData({
        abi: timelockAbi,
        functionName: "updateDelay",
        args: [BigInt(delaySec)],
      }),
    },
  ];
}

const meta = (name: string, description: string) => ({ name, description });

export function handoverBatch(d: Deployment, delaySec: number): SafeBatch {
  const calls = handoverCalls(d, delaySec);
  const args = [
    calls.map((c) => c.to),
    calls.map(() => 0n),
    calls.map((c) => c.data),
    zeroHash,
    HANDOVER_SALT,
  ] as const;
  return {
    version: "1.0",
    chainId: String(d.chainId),
    createdAt: Math.floor(Date.now() / 1000),
    meta: meta(
      "Converge: hand over to the timelock",
      `Two transactions to the OwnerTimelock ${d.timelock}: scheduleBatch then executeBatch (delay 0 while it is in its boot state). They run acceptOwnership() on ${calls.length - 1} contracts and then updateDelay(${delaySec}). Check each address against deployments/${d.network}.json before signing. After this every owner action waits ${delaySec} seconds.`,
    ),
    transactions: [
      tx(
        d.timelock!,
        encodeFunctionData({
          abi: timelockAbi,
          functionName: "scheduleBatch",
          args: [...args, 0n],
        }),
      ),
      tx(d.timelock!, encodeFunctionData({ abi: timelockAbi, functionName: "executeBatch", args })),
    ],
  };
}

const resume = (d: Deployment): Call => {
  if (!d.vault) throw new Error("no vault in the deployment");
  return {
    to: d.vault.vault,
    data: encodeFunctionData({ abi: convergeVaultAbi, functionName: "resumeQuoting" }),
  };
};

export function launchScheduleBatch(d: Deployment, delaySec: number, label = "v1"): SafeBatch {
  if (!d.timelock) throw new Error("no timelock in the deployment");
  const c = resume(d);
  return {
    version: "1.0",
    chainId: String(d.chainId),
    createdAt: Math.floor(Date.now() / 1000),
    meta: meta(
      "Converge: schedule resumeQuoting (launch)",
      `Schedules resumeQuoting() on the vault through the timelock with the full ${delaySec} s delay. Schedule it early; execute it (safe-launch-execute) only when every box of docs/ops/launch-checklist.md above 'launch' is ticked. The guardian can pause at any time, and the Safe can cancel the operation.`,
    ),
    transactions: [
      tx(
        d.timelock,
        encodeFunctionData({
          abi: timelockAbi,
          functionName: "schedule",
          args: [c.to, 0n, c.data, zeroHash, launchSalt(label), BigInt(delaySec)],
        }),
      ),
    ],
  };
}

export function launchExecuteBatch(d: Deployment, label = "v1"): SafeBatch {
  if (!d.timelock) throw new Error("no timelock in the deployment");
  const c = resume(d);
  return {
    version: "1.0",
    chainId: String(d.chainId),
    createdAt: Math.floor(Date.now() / 1000),
    meta: meta(
      "Converge: execute resumeQuoting (launch)",
      "Executes the scheduled resumeQuoting() once the delay has passed. Quoting starts the moment this runs.",
    ),
    transactions: [
      tx(
        d.timelock,
        encodeFunctionData({
          abi: timelockAbi,
          functionName: "execute",
          args: [c.to, 0n, c.data, zeroHash, launchSalt(label)],
        }),
      ),
    ],
  };
}
