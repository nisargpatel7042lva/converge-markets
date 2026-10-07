/* global console, process */
// Proves the package is publishable: builds it, packs it exactly as `npm publish` would, checks the
// tarball's contents and its rewritten package.json (publishConfig), and loads the built file in
// plain Node ESM (no bundler) to call the public API.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const fail = (m) => {
  console.error(`check:pack FAILED: ${m}`);
  process.exit(1);
};
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: "utf8" });

run("pnpm", ["run", "build"]);
const tmp = mkdtempSync(join(tmpdir(), "sdk-pack-"));
try {
  run("pnpm", ["pack", "--pack-destination", tmp]);
  const tgz = run("ls", [tmp]).trim().split("\n")[0];
  const files = run("tar", ["-tzf", join(tmp, tgz)])
    .trim()
    .split("\n");
  for (const need of [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    if (!files.includes(need)) fail(`the tarball has no ${need}`);
  }
  const stray = files.filter(
    (f) => !/^package\/(package\.json|README\.md|LICENSE|dist\/.+)$/.test(f),
  );
  if (stray.length) fail(`unexpected files in the tarball: ${stray.join(", ")}`);
  const pkg = JSON.parse(run("tar", ["-xzOf", join(tmp, tgz), "package/package.json"]));
  if (pkg.private) fail("the package is private");
  if (pkg.main !== "./dist/index.js" || pkg.types !== "./dist/index.d.ts")
    fail(`main/types were not rewritten for publishing: ${pkg.main} ${pkg.types}`);
  if (pkg.exports?.["."]?.import !== "./dist/index.js")
    fail("exports were not rewritten for publishing");
  if (!pkg.license || !pkg.repository || !pkg.description) fail("license/repository/description");
  if (!pkg.peerDependencies?.viem) fail("viem must be a peer dependency");
  if (pkg.dependencies?.viem) fail("viem must not be a regular dependency");
  console.log(`tarball ok: ${files.length} files, ${tgz}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// plain Node ESM, no bundler, no TypeScript
const sdk = await import(pathToFileURL(join(root, "dist/index.js")).href);
for (const name of [
  "createConvergeClient",
  "parseStrike",
  "assetIdFor",
  "partnerRegistryAbi",
  "createIndexerClient",
]) {
  if (typeof sdk[name] === "undefined") fail(`dist/index.js does not export ${name}`);
}
if (sdk.parseStrike("3200") !== 3200n * 10n ** 18n) fail("parseStrike gives a wrong value");
const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
if (!dts.includes("createConvergeClient")) fail("the declarations lack createConvergeClient");
console.log("check:pack OK (loads in plain Node ESM)");
