import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, "../README.md"), "utf8");
const quickstart = /```ts\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";
const codeLines = quickstart
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("//"));

describe("README quickstart", () => {
  it("is at most 20 lines of code", () => {
    expect(codeLines.length).toBeGreaterThan(10);
    expect(codeLines.length).toBeLessThanOrEqual(20);
  });

  it("only uses SDK exports and client methods that exist", () => {
    const imported = /import \{([^}]*)\} from "@converge\/sdk"/.exec(quickstart)?.[1] ?? "";
    for (const name of imported.split(",").map((x) => x.trim())) {
      expect(typeof (sdk as Record<string, unknown>)[name], name).toBe("function");
    }
    const client = sdk.createConvergeClient({
      publicClient: {} as never,
      addresses: { registry: "0x1", vault: "0x2", venue: "0x3", collateral: "0x4" } as never,
    }) as unknown as Record<string, unknown>;
    const used = new Set([...quickstart.matchAll(/converge\.(\w+)\(/g)].map((m) => m[1] as string));
    expect(used.size).toBeGreaterThanOrEqual(5);
    for (const method of used) expect(typeof client[method], method).toBe("function");
  });

  it("documents every client method in the API table", () => {
    const client = sdk.createConvergeClient({
      publicClient: {} as never,
      addresses: { registry: "0x1", vault: "0x2", venue: "0x3", collateral: "0x4" } as never,
    }) as unknown as Record<string, unknown>;
    const methods = Object.keys(client).filter((k) => typeof client[k] === "function");
    for (const m of methods) expect(readme, m).toContain(`\`${m}(`);
  });
});
