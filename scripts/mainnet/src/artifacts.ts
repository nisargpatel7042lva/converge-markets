import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";
import { repoRoot } from "./params";

/** A forge artifact (contracts/out): run `forge build` first. */
export function artifact(name: string): { abi: Abi; bytecode: Hex; deployedBytecode: Hex } {
  const file = resolve(repoRoot, "contracts/out", `${name}.sol`, `${name}.json`);
  let j: { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no artifact for ${name} at ${file}: run \`cd contracts && forge build\``);
  }
  return { abi: j.abi, bytecode: j.bytecode.object, deployedBytecode: j.deployedBytecode.object };
}
