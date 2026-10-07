/**
 * Every event the indexer declares in config.yaml must exist in the contract ABI with the same
 * name, parameter types, parameter names and indexed flags (the topic0 hash alone does not encode
 * names or indexing). Source of truth: contracts/out (forge build, used by make check-6) when
 * present, otherwise the generated SDK ABI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbiItem, toEventSelector, type AbiEvent } from "viem";
import { describe, expect, it } from "vitest";
import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  marketFactoryAbi,
  outcomeTokenAbi,
  partnerRegistryAbi,
} from "../../packages/sdk/src/abi/generated";
import { CONTRACTS } from "../scripts/config-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../contracts/out");

const SDK_ABI: Record<string, readonly unknown[]> = {
  MarketFactory: marketFactoryAbi,
  Market: marketAbi,
  OutcomeToken: outcomeTokenAbi,
  ConvergeVault: convergeVaultAbi,
  ForwardVenue: forwardVenueAbi,
  PartnerRegistry: partnerRegistryAbi,
};

function forgeAbi(name: string): readonly unknown[] | undefined {
  const p = resolve(out, `${name}.sol/${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).abi as unknown[]) : undefined;
}

const fromForge = forgeAbi("ConvergeVault") !== undefined;

// Enums are uint8 in the ABI: the config declares them as uint8 and the ABI says uint8 too.
const norm = (e: AbiEvent) =>
  e.inputs.map((i) => ({
    name: i.name,
    type: JSON.stringify(i.type === "tuple" ? flat(i) : i.type),
    indexed: !!i.indexed,
  }));
function flat(i: {
  type: string;
  components?: readonly { name?: string; type: string; components?: unknown }[];
}): unknown {
  return { t: i.type, c: (i.components ?? []).map((c) => ({ n: c.name, t: c.type })) };
}

describe(`config events vs contract ABIs (${fromForge ? "contracts/out" : "SDK generated ABI"})`, () => {
  for (const [contract, sigs] of Object.entries(CONTRACTS)) {
    const abi = (fromForge ? forgeAbi(contract) : SDK_ABI[contract]) as readonly {
      type: string;
      name?: string;
    }[];
    for (const sig of sigs as string[]) {
      it(`${contract}.${sig.slice(0, sig.indexOf("("))}`, () => {
        const declared = parseAbiItem(`event ${sig}`) as AbiEvent;
        const real = abi.find((x) => x.type === "event" && x.name === declared.name) as
          AbiEvent | undefined;
        expect(real, `${declared.name} missing from the ${contract} ABI`).toBeDefined();
        expect(toEventSelector(declared)).toBe(toEventSelector(real!));
        expect(norm(declared)).toEqual(norm(real!));
      });
    }
  }
});
