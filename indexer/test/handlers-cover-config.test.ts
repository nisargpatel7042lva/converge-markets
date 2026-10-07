import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACTS } from "../scripts/config-lib.mjs";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/handlers");
const src = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(resolve(dir, f), "utf8"))
  .join("\n");

describe("config and handlers agree", () => {
  it("every event declared in config.yaml has a handler (nothing is fetched for nothing)", () => {
    const handled = new Set<string>();
    for (const m of src.matchAll(
      /indexer\.onEvent\(\s*\{\s*contract:\s*"(\w+)",\s*event:\s*"(\w+)"/g,
    )) {
      handled.add(`${m[1]}.${m[2]}`);
    }
    const declared = Object.entries(CONTRACTS).flatMap(([c, sigs]) =>
      (sigs as string[]).map((s) => `${c}.${s.slice(0, s.indexOf("("))}`),
    );
    expect([...declared].filter((d) => !handled.has(d))).toEqual([]);
    expect([...handled].filter((h) => !declared.includes(h))).toEqual([]);
  });

  it("every dynamically registered contract is registered by a contractRegister on MarketCreated", () => {
    for (const factory of ["MarketFactory", "PartnerRegistry"]) {
      expect(src).toMatch(
        new RegExp(
          `contractRegister\\(\\s*\\{\\s*contract:\\s*"${factory}",\\s*event:\\s*"MarketCreated"`,
        ),
      );
    }
    for (const c of ["Market", "OutcomeToken"]) {
      expect(src).toContain(`context.chain.${c}.add(`);
    }
  });
});
