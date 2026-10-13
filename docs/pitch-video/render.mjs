// Renders the pitch video frame by frame (deterministic: every frame is a pure function of time).
//   node render.mjs --preview 3,20,50,80   -> PNGs of those seconds in ./preview
//   node render.mjs                        -> out/converge-pitch.mp4   (add --audio voice.mp3 to mux a voiceover)
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire("/home/mysterioxplorer/converge/apps/web/package.json")("@playwright/test");
const ffmpeg = createRequire("/home/mysterioxplorer/.cache/pitch-tools/package.json")("ffmpeg-static");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FPS = 24;
const types = { ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".webm": "video/webm", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = join(here, decodeURIComponent(new URL(req.url, "http://x").pathname === "/" ? "/index.html" : new URL(req.url, "http://x").pathname));
  if (!path.startsWith(here) || !existsSync(path)) return res.writeHead(404).end();
  const buf = readFileSync(path);
  const range = req.headers.range;
  if (range && path.endsWith(".webm")) { // Chromium seeks media with range requests
    const [a, b] = range.replace("bytes=", "").split("-"); const start = Number(a), end = b ? Number(b) : buf.length - 1;
    return res.writeHead(206, { "content-type": "video/webm", "content-range": `bytes ${start}-${end}/${buf.length}`, "accept-ranges": "bytes", "content-length": end - start + 1 }).end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "accept-ranges": "bytes", "content-length": buf.length }).end(buf);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await page.waitForTimeout(800);
const total = await page.evaluate(() => TL.total);
const preview = arg("--preview");
if (preview) {
  mkdirSync(join(here, "preview"), { recursive: true });
  for (const sec of preview.split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), sec); await page.waitForTimeout(150);
    await page.screenshot({ path: join(here, "preview", `t${String(sec).padStart(3, "0")}.png`) });
  }
  console.log(`previews written; total length ${total.toFixed(1)} s`);
} else {
  mkdirSync(join(here, "out"), { recursive: true });
  const audio = arg("--audio");
  const out = join(here, "out", audio ? "converge-pitch-with-voice.mp4" : "converge-pitch.mp4");
  const args = ["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", ...(audio ? ["-i", audio] : []), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : []), "-movflags", "+faststart", out];
  const ff = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; ff.stderr.on("data", (d) => (err += d)); const closed = new Promise((r) => ff.on("close", r));
  const n = Math.round(total * FPS); const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const jpg = await page.screenshot({ type: "jpeg", quality: 95 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 240 === 0) { console.log(`frame ${i}/${n}  ${((Date.now() - t0) / 1000).toFixed(0)} s`); writeFileSync(join(here, "out", "progress.txt"), `${i}/${n}\n`); }
  }
  ff.stdin.end(); const code = await closed;
  console.log(code === 0 ? `done: ${out}` : `ffmpeg failed: ${err.slice(-600)}`);
}
await browser.close(); server.close();
