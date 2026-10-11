/* global console, process */
// Enforces the numbers ledger (docs/numbers.md):
//  1. every ledger row has a unique id, a recognised type, and a source that is an existing repo path or an https link;
//  2. every dollar figure and percentage in the five public documents appears in the ledger.
// A figure that is not in the ledger fails the check, so a number cannot reach a judge without a source.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(resolve(root, f), "utf8");
const ledger = read("docs/numbers.md");
const TYPES = new Set([
  "measured",
  "live",
  "estimate",
  "cited",
  "assumption",
  "design",
  "unverified",
]);
const failures = [];

const rows = ledger
  .split("\n")
  .filter((l) => /^\| N\d+ /.test(l))
  .map((l) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim()),
  );
const ids = new Set();
for (const [id, claim, value, source, type] of rows) {
  if (ids.has(id)) failures.push(`${id}: duplicate id`);
  ids.add(id);
  if (!claim || !value) failures.push(`${id}: empty claim or value`);
  if (!TYPES.has(type))
    failures.push(`${id}: type "${type}" is not one of ${[...TYPES].join(", ")}`);
  const paths = [
    ...source.matchAll(/`([^`\s]+\.[a-z]{1,5})(?::\d+)?`|\]\((?!https?:)([^)#\s]+)/g),
  ].map((m) => m[1] ?? m[2]);
  const urls = [...source.matchAll(/https?:\/\/[^\s)|]+/g)];
  if (paths.length === 0 && urls.length === 0 && type !== "design")
    failures.push(`${id}: source names no file or link`);
  for (const p of paths)
    if (
      !existsSync(resolve(root, p.replace(/^\.\.\//, ""))) &&
      !existsSync(resolve(root, "docs", p))
    )
      failures.push(`${id}: source path ${p} does not exist`);
}

// Normalise both sides the same way WITHOUT gluing numbers together: thousands commas and a space before % go,
// "$", "+" and minus signs become spaces, so "$1.0119, +1.19%" stays two figures.
const norm = (t) =>
  t
    .toLowerCase()
    .replace(/(?<=\d),(?=\d{3}\b)/g, "")
    .replace(/\s+%/g, "%")
    .replace(/[$+\u2212\u2013]/g, " ")
    .replace(/(?<![\w.])-(?=\d)/g, " ");
const book = norm(rows.map((r) => `${r[1]} ${r[2]} ${r[3]}`).join(" | "));
const DOCS = [
  "README.md",
  "docs/submission.md",
  "docs/demo-script.md",
  "docs/pitch-outline.md",
  "docs/launch/x-thread.md",
];
const missing = new Map();
for (const f of DOCS) {
  const text = read(f)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\]\([^)]*\)/g, "]");
  for (const m of text.matchAll(/-?\$\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%/g)) {
    const fig = norm(m[0]).trim();
    // a whole figure, not a substring of a longer number ($5 must not match $50.5)
    if (!new RegExp(`(?<![\\d.])${fig.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`).test(book))
      missing.set(`${f}: ${m[0]}`, true);
  }
}
for (const k of missing.keys()) failures.push(`not in the ledger -> ${k}`);
console.log(
  `ledger: ${rows.length} rows; documents checked: ${DOCS.length}; figures not in the ledger: ${missing.size}`,
);
for (const x of failures) console.log(`FAIL  ${x}`);
process.exit(failures.length ? 1 : 0);
