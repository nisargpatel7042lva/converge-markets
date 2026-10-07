/* global console, process */
// Mera is the only account layer: fail if any other wallet or account SDK is a dependency
// (direct, in package.json) or installed anywhere under node_modules/.pnpm for this app.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const FORBIDDEN = [
  /^wagmi$/,
  /^@wagmi\//,
  /^@rainbow-me\//,
  /^@web3modal\//,
  /^@reown\//,
  /^@walletconnect\//,
  /^ethers$/,
  /^web3$/,
  /^@privy-io\//,
  /^@dynamic-labs\//,
  /^@magic-sdk\//,
  /^magic-sdk$/,
  /^thirdweb$/,
  /^@thirdweb-dev\//,
  /^@coinbase\/wallet-sdk$/,
  /^@metamask\/sdk$/,
  /^@safe-global\//,
  /^@web3auth\//,
  /^@particle-network\//,
  /^@turnkey\//,
  /^@passkeys\//,
  /^@simplewebauthn\//,
  /^@getpara\//,
];
const bad = deps.filter((d) => FORBIDDEN.some((re) => re.test(d)));
if (bad.length) {
  console.error("other wallet SDKs in apps/web dependencies:", bad.join(", "));
  process.exit(1);
}
const mera = deps.filter((d) => d.startsWith("@category-labs/"));
console.log(`account layer: ${mera.join(", ") || "NONE"}`);
if (!mera.includes("@category-labs/mera")) process.exit(1);
console.log("dependencies checked:", deps.length, "none are wallet SDKs other than Mera");
