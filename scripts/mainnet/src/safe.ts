/**
 * Safe Transaction Builder batches (the JSON the Safe web app imports). Two batches, so that the
 * signers review each on its own:
 *  - handover: acceptOwnership() on every Ownable2Step contract the deployer proposed to the Safe;
 *  - launch:   resumeQuoting() on the vault. Only after docs/ops/launch-checklist.md section "before
 *              the Safe resumes quoting" is ticked.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
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

const accept = parseAbi(["function acceptOwnership()"]);

const tx = (to: Address, data: Hex) => ({
  to,
  value: "0" as const,
  data,
  contractMethod: null,
  contractInputsValues: null,
});

export function handoverBatch(d: Deployment): SafeBatch {
  const targets: [string, Address | undefined][] = [
    ["ConvergeVault", d.vault?.vault],
    ["DataStreamsResolver", d.dataStreamsResolver],
    ["ChainlinkRoundResolver", d.chainlinkRoundResolver],
    ["PartnerRegistry", d.partners?.partnerRegistry],
  ];
  const data = encodeFunctionData({ abi: accept, functionName: "acceptOwnership" });
  return {
    version: "1.0",
    chainId: String(d.chainId),
    createdAt: Math.floor(Date.now() / 1000),
    meta: {
      name: "Converge: accept ownership",
      description: `Executes acceptOwnership() on ${targets
        .filter(([, a]) => a)
        .map(([n]) => n)
        .join(
          ", ",
        )}. The deployer key proposed the Safe as owner; until this runs the deployer is still the owner. Check each address against deployments/${d.network}.json before signing.`,
    },
    transactions: targets.filter((t): t is [string, Address] => !!t[1]).map(([, a]) => tx(a, data)),
  };
}

export function launchBatch(d: Deployment): SafeBatch {
  if (!d.vault) throw new Error("no vault in the deployment");
  return {
    version: "1.0",
    chainId: String(d.chainId),
    createdAt: Math.floor(Date.now() / 1000),
    meta: {
      name: "Converge: resume quoting (launch)",
      description:
        "Resumes quoting on the vault. Sign only when every box of docs/ops/launch-checklist.md above 'launch' is ticked. The guardian can pause again at any time.",
    },
    transactions: [
      tx(
        d.vault.vault,
        encodeFunctionData({ abi: convergeVaultAbi, functionName: "resumeQuoting" }),
      ),
    ],
  };
}
