/**
 * Shared by the two CLIs: reads the repo's .env (never printed) and the deployment's addresses.
 * Only addresses and keys come from here; every Converge call goes through @converge/sdk.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConvergeAddresses } from "@converge/sdk";
import type { Address, Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");

export function loadEnv(): void {
  const file = resolve(repoRoot, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const key = (name: string): Hex => need(name) as Hex;

/** deployments/<network>.json -> the four addresses the SDK needs. */
export function readAddresses(network: string): { chainId: number; addresses: ConvergeAddresses } {
  const d = JSON.parse(
    readFileSync(resolve(repoRoot, "deployments", `${network}.json`), "utf8"),
  ) as {
    chainId: number;
    collateral_tUSDC: Address;
    vault: { vault: Address; forwardVenue: Address };
    partners?: { partnerRegistry: Address };
  };
  if (!d.partners) {
    throw new Error(
      `deployments/${network}.json has no "partners" section: run contracts/script/deploy-partners.sh first`,
    );
  }
  return {
    chainId: d.chainId,
    addresses: {
      registry: d.partners.partnerRegistry,
      vault: d.vault.vault,
      venue: d.vault.forwardVenue,
      collateral: d.collateral_tUSDC,
    },
  };
}
