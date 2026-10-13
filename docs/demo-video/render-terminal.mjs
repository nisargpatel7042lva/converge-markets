// node render-scenes.mjs eth 22.9   |   node render-scenes.mjs trio 27.2   -> work/<scene>.mp4  (30 fps, no text)
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire("/home/mysterioxplorer/converge/apps/web/package.json")(
  "@playwright/test",
);
const ffmpeg = createRequire("/home/mysterioxplorer/.cache/pitch-tools/package.json")(
  "ffmpeg-static",
);
const scene = "terminal";
const FPS = 30;
const types = { ".html": "text/html", ".webm": "video/webm", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const path = join(here, u.pathname === "/" ? "/terminal.html" : decodeURIComponent(u.pathname));
  if (!path.startsWith(here) || !existsSync(path)) return res.writeHead(404).end();
  const buf = readFileSync(path);
  const range = req.headers.range;
  if (range && path.endsWith(".webm")) {
    const [a, b] = range.replace("bytes=", "").split("-");
    const s = Number(a),
      e = b ? Number(b) : buf.length - 1;
    return res
      .writeHead(206, {
        "content-type": "video/webm",
        "content-range": `bytes ${s}-${e}/${buf.length}`,
        "accept-ranges": "bytes",
        "content-length": e - s + 1,
      })
      .end(buf.subarray(s, e + 1));
  }
  res
    .writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
      "accept-ranges": "bytes",
      "content-length": buf.length,
    })
    .end(buf);
}).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
const dataFile = process.argv[2] ?? "terminal.json";
const outName = process.argv[3] ?? "terminal";
await page.goto(`http://127.0.0.1:${server.address().port}/?data=${dataFile}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
mkdirSync(join(here, "work"), { recursive: true });
const out = join(here, "work", `${outName}.mp4`);
const ff = spawn(
  ffmpeg,
  [
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(FPS),
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    out,
  ],
  { stdio: ["pipe", "ignore", "pipe"] },
);
let err = "";
ff.stderr.on("data", (d) => (err += d));
const closed = new Promise((r) => ff.on("close", r));
const secs = await page.evaluate(() => window.__total);
const n = Math.round(secs * FPS);
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  const jpg = await page.screenshot({ type: "jpeg", quality: 95 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 150 === 0) console.log(`${scene} frame ${i}/${n}`);
}
ff.stdin.end();
const code = await closed;
console.log(code === 0 ? `done ${out}` : `ffmpeg failed ${err.slice(-400)}`);
await browser.close();
server.close();
