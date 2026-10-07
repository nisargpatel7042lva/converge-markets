/* global console, process, fetch, setTimeout */
// Lighthouse (mobile, simulated throttling: the default) for the main pages of a production build.
// Usage: pnpm --filter @converge/web lighthouse   (builds, serves on :3200, audits, writes the reports)
// Needs a Chrome: CHROME_PATH (default: Playwright's Chromium) and its system libraries.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "../../docs/evidence/phase-7/lighthouse");
mkdirSync(out, { recursive: true });
const pw = resolve(homedir(), ".cache/ms-playwright");
const chrome =
  process.env.CHROME_PATH ??
  resolve(
    pw,
    readdirSync(pw).find((d) => d.startsWith("chromium-")) ?? "",
    "chrome-linux64/chrome",
  );
const PORT = 3200;
const pages = process.env.PAGES
  ? process.env.PAGES.split(",")
  : ["/", "/markets", "/stats", "/legal/terms", "/start"];
const env = { ...process.env, NEXT_DIST_DIR: ".next-lh", NEXT_PUBLIC_APP_ENV: "production" };

const sh = (cmd, args, opts = {}) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], ...opts });
    p.on("exit", (c) => (c === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} -> ${c}`))));
  });

if (!process.env.SKIP_BUILD) await sh("pnpm", ["exec", "next", "build"], { env });
const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
  cwd: root,
  env,
  stdio: "ignore",
  detached: true,
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 300));
}

// Chrome is started here (a fixed debugging port) and Lighthouse attaches to it.
const CDP_PORT = 9333;
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=/tmp/lh-profile",
    "about:blank",
  ],
  { stdio: "ignore", detached: true },
);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 200));
}

const results = [];
try {
  for (const p of pages) {
    const name = p === "/" ? "home" : p.slice(1).replace(/\//g, "-");
    const base = resolve(out, name);
    await sh("pnpm", [
      "exec",
      "lighthouse",
      `http://localhost:${PORT}${p}`,
      "--only-categories=performance,accessibility,best-practices",
      "--output=json",
      "--output=html",
      `--output-path=${base}`,
      `--port=${CDP_PORT}`,
      "--quiet",
    ]);
    const j = JSON.parse(readFileSync(`${base}.report.json`, "utf8"));
    const c = j.categories;
    const row = {
      page: p,
      performance: Math.round(c.performance.score * 100),
      accessibility: Math.round(c.accessibility.score * 100),
      bestPractices: Math.round(c["best-practices"].score * 100),
      lcpMs: Math.round(j.audits["largest-contentful-paint"].numericValue),
      tbtMs: Math.round(j.audits["total-blocking-time"].numericValue),
      cls: Number(j.audits["cumulative-layout-shift"].numericValue.toFixed(3)),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  try {
    process.kill(-browser.pid, "SIGTERM");
  } catch {
    // gone
  }
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // gone
  }
}
const bar = { performance: 90, accessibility: 95, bestPractices: 95 };
const pass = results.every(
  (r) =>
    r.performance >= bar.performance &&
    r.accessibility >= bar.accessibility &&
    r.bestPractices >= bar.bestPractices,
);
writeFileSync(
  resolve(out, "summary.json"),
  JSON.stringify(
    { bar, pass, formFactor: "mobile", throttling: "lighthouse default (simulated)", results },
    null,
    2,
  ),
);
console.log(pass ? "LIGHTHOUSE PASS" : "LIGHTHOUSE FAIL");
process.exit(pass ? 0 : 1);
