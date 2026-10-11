/* global fetch, console, process, AbortSignal */
// Verifies that every link and every transaction in the Phase 10 documents resolves.
//   node scripts/docs/check-links.mjs [--offline]
// - repo links (relative, or https://github.com/nisargpatel7042lva/converge-markets/{blob,tree}/main/...): the path exists; a #L<n> anchor is within the file
// - testnet explorer links and any 0x…64-hex hash: the transaction exists on Monad testnet; address links: contract code exists
// - other external links: reachable (a 403 or 429 is a warning, not a failure)
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const offline = process.argv.includes("--offline");
const FILES = [
  "README.md",
  "docs/submission.md",
  "docs/demo-script.md",
  "docs/pitch-outline.md",
  "docs/numbers.md",
  "docs/launch/x-thread.md",
  "docs/launch/outreach.md",
  "docs/sponsors/README.md",
  "docs/kuru/INTEGRATION.md",
].filter((f) => existsSync(resolve(root, f)));
const GH =
  /^https:\/\/github\.com\/nisargpatel7042lva\/converge-markets\/(?:blob|tree)\/main\/([^#?\s)]+)(?:#L(\d+))?$/;
const RPC = "https://rpc-testnet.monadinfra.com";
const rpc = async (method, params) =>
  (
    await (
      await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      })
    ).json()
  ).result;

const failures = [];
const warnings = [];
let checked = 0;
const txs = new Map();
const addrs = new Map();
const ext = new Map();
const note = (file, what) => failures.push(`${file}: ${what}`);

function checkLocal(file, rel, line) {
  const p = resolve(root, rel);
  if (!existsSync(p)) return note(file, `missing path ${rel}`);
  if (line && statSync(p).isFile()) {
    const n = readFileSync(p, "utf8").split("\n").length;
    if (Number(line) > n) note(file, `${rel}#L${line} is past the end of the file (${n} lines)`);
  }
  checked += 1;
}

for (const f of FILES) {
  const text = readFileSync(resolve(root, f), "utf8");
  const links = new Set();
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) links.add(m[1]);
  for (const m of text.matchAll(/(?<![(\w])(https?:\/\/[^\s)<>`"']+)/g))
    links.add(m[1].replace(/[.,;]+$/, ""));
  for (const l of links) {
    const g = l.match(GH);
    if (g) {
      checkLocal(f, decodeURIComponent(g[1]), g[2]);
      continue;
    }
    if (/^https:\/\/github\.com\/nisargpatel7042lva\/converge-markets\/?$/.test(l)) continue;
    const tx = l.match(/testnet\.monadvision\.com\/tx\/(0x[0-9a-fA-F]{64})/);
    const ad = l.match(/testnet\.monadvision\.com\/address\/(0x[0-9a-fA-F]{40})/);
    if (tx) txs.set(tx[1], f);
    else if (ad) addrs.set(ad[1], f);
    else if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(l)) continue;
    else if (/^https?:\/\//.test(l)) ext.set(l, f);
    else if (!l.startsWith("#") && !l.startsWith("mailto:")) {
      const [path, anchor] = l.split("#");
      const line = anchor?.match(/^L(\d+)$/)?.[1];
      checkLocal(f, resolve(dirname(resolve(root, f)), path).slice(root.length + 1), line);
    }
  }
  for (const m of text.matchAll(/\b0x[0-9a-fA-F]{64}\b/g)) if (!txs.has(m[0])) txs.set(m[0], f);
}

if (!offline) {
  for (const [h, f] of txs) {
    const r = await rpc("eth_getTransactionByHash", [h]);
    if (r) checked += 1;
    else note(f, `transaction ${h} not found on Monad testnet`);
  }
  for (const [a, f] of addrs) {
    const c = await rpc("eth_getCode", [a, "latest"]);
    if (c && c !== "0x") checked += 1;
    else note(f, `no contract code at ${a} on Monad testnet`);
  }
  for (const [u, f] of ext) {
    try {
      let r = await fetch(u, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
        headers: { "user-agent": "Mozilla/5.0 link-check" },
      });
      if (r.status === 405 || r.status === 404)
        r = await fetch(u, {
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
          headers: { "user-agent": "Mozilla/5.0 link-check" },
        });
      if (r.ok) checked += 1;
      else if ([401, 403, 429, 451].includes(r.status))
        warnings.push(
          `${f}: ${u} answered ${r.status} (reachable, but blocks automated checks or our region)`,
        );
      else note(f, `${u} answered ${r.status}`);
    } catch (e) {
      warnings.push(`${f}: ${u} not reachable from here (${String(e.message ?? e).slice(0, 60)})`);
    }
  }
}
console.log(
  `checked ${checked} links in ${FILES.length} files (${txs.size} transactions, ${addrs.size} addresses, ${ext.size} external)${offline ? " [offline: chain and external links skipped]" : ""}`,
);
for (const w of warnings) console.log(`warning  ${w}`);
for (const x of failures) console.log(`FAIL     ${x}`);
process.exit(failures.length ? 1 : 0);
