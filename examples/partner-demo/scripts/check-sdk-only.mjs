/* global console, process */
// The demo must be buildable by a third party who only has the published package: every import is
// react, next, viem, the example's own files, or the root of @converge/sdk. No deep imports into the
// monorepo, no other workspace package, no relative path that leaves this folder.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["app", "lib", "scripts", "test"];
const ALLOWED = [/^react(-dom)?(\/.*)?$/, /^next(\/.*)?$/, /^viem(\/.*)?$/, /^@converge\/sdk$/];
const NODE = /^(node:.*|fs|path|url|os|crypto)$/;
const DEV = /^(vitest|tsx)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|mjs)$/.test(name) && name !== "check-sdk-only.mjs") yield p;
  }
}

const problems = [];
for (const d of SCAN) {
  for (const file of files(join(root, d))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (relative(root, target).startsWith(".."))
          problems.push(`${relative(root, file)}: ${spec} leaves the example`);
      } else if (!ALLOWED.some((re) => re.test(spec)) && !NODE.test(spec) && !DEV.test(spec)) {
        problems.push(`${relative(root, file)}: ${spec} is not react, next, viem or @converge/sdk`);
      }
    }
  }
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (String(range).startsWith("workspace:") && name !== "@converge/sdk")
    problems.push(`package.json depends on the workspace package ${name}`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("partner-demo imports only react, next, viem and the root of @converge/sdk");
