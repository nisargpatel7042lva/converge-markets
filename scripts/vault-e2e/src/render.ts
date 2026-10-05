/**
 * Renders docs/evidence/phase-4/testnet-e2e.json to testnet-e2e.md (tx table with explorer links).
 * Usage: pnpm --filter @converge/vault-e2e render
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../../docs/evidence/phase-4");
const j = JSON.parse(readFileSync(resolve(dir, "testnet-e2e.json"), "utf8")) as {
  status: string;
  error?: string;
  chainId: number;
  addresses: Record<string, string>;
  facts: Record<string, string>;
  steps: { label: string; hash: string; block: string; gasUsed: string; from: string }[];
};
const ex = "https://testnet.monadvision.com/tx/";
const usd = (raw: string | undefined) => (Number(raw ?? "0") / 1e6).toFixed(6);
let md = `# Phase 4 testnet end-to-end (Monad testnet, chain ${j.chainId})\n\n`;
md += `Status: **${j.status}**${j.error ? ` (${j.error})` : ""}\n\n`;
md += `**TEST-ONLY prices.** Monad testnet has no live Data Streams verifier, so the vault's TEST/USD asset is verified by \`MockStreamsVerifierProxy\`; the reports are signed by a test key. The contracts, the epoch settlement, the forward-priced fill and the accounting are the production code. Source: \`scripts/vault-e2e/src/e2e.ts\` (real wall-clock time, about 40 minutes).\n\n`;
md += `## Addresses\n\n| | |\n|---|---|\n`;
for (const [k, v] of Object.entries(j.addresses)) md += `| ${k} | \`${v}\` |\n`;
md += `| round market | \`${j.facts.market}\` |\n\n`;
md += `## Hand-checked results\n\n| quantity | observed | hand-derived (VaultE2E.t.sol) |\n|---|---|---|\n`;
md += `| LP shares after the first epoch | ${j.facts.lpShares} raw (1,000 USDC minus 1,000 dead shares) | 999,999,000 |\n`;
md += `| taker fill | ${usd(j.facts.filled)} UP | 10.000000 |\n`;
md += `| premium paid (ask 0.55) | ${usd(j.facts.premium)} USDC | 5.500000 |\n`;
md += `| seconds left at the pricing time | ${j.facts.secondsLeftAtPricing} | |\n`;
md += `| vault collateral after resolution and redeemResolved | ${usd(j.facts.vaultAssetsAfterResolution)} | 995.500000 |\n`;
md += `| LP received for all shares | ${usd(j.facts.lpReceived)} | 995.499004 |\n`;
md += `| LP deposited | ${usd(j.facts.lpDeposited)} | |\n\n`;
md += `The LP lost 4.50 USDC (UP won while the vault was short 10 UP at 0.55) and 0.000996 USDC stays behind as the dead shares' claim.\n\n`;
md += `## Transactions (${j.steps.length})\n\n| # | step | tx | block | gas used |\n|---|---|---|---|---|\n`;
j.steps.forEach((s, i) => {
  md += `| ${i + 1} | ${s.label} | [\`${s.hash}\`](${ex}${s.hash}) | ${s.block} | ${s.gasUsed} |\n`;
});
writeFileSync(resolve(dir, "testnet-e2e.md"), md);
console.log("wrote testnet-e2e.md");
