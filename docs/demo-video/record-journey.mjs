// Records the whole user journey on the local demo stack (.demo/start.sh, real contracts, keeper, scheduler and app),
// at 30 fps, with a smooth in-page cursor and scrolling. No overlay or text is drawn: the pixels are the product.
//   DEMO_END=up bash .demo/start.sh      then      node record-journey.mjs   ->  work/journey.mp4
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const { chromium, expect } = createRequire(join(root, "apps/web/package.json"))("@playwright/test");
const ffmpeg = createRequire("/home/mysterioxplorer/.cache/pitch-tools/package.json")(
  "ffmpeg-static",
);
const base = "http://localhost:3100";
const chain = JSON.parse(readFileSync(join(root, ".demo/chain.json"), "utf8"));
const rpc = async (method, params = []) =>
  (
    await (
      await fetch(chain.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json()
  ).result;
const chainNow = async () =>
  parseInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`[journey ${new Date().toISOString().slice(11, 19)}] ${s}`);

const newContext = async (browser) => {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript(() => {
    // a smooth cursor and scroller driven by requestAnimationFrame, so every motion is rendered at the display rate
    const mount = () => {
      if (document.getElementById("__cur")) return;
      const c = document.createElement("div");
      c.id = "__cur";
      c.style.cssText =
        "position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))";
      c.innerHTML =
        '<svg width="32" height="32" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.5L9 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      const ring = document.createElement("div");
      ring.id = "__ring";
      ring.style.cssText =
        "position:fixed;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:3px solid #b6aaf6;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.6);transition:opacity .4s,transform .4s";
      document.documentElement.append(ring, c);
      const p = JSON.parse(sessionStorage.getItem("__cursor") || '{"x":1500,"y":700}');
      window.__pos = p;
      c.style.transform = `translate(${p.x - 4}px,${p.y - 2}px)`;
      addEventListener(
        "mousedown",
        () => {
          ring.style.left = window.__pos.x + "px";
          ring.style.top = window.__pos.y + "px";
          ring.style.opacity = "1";
          ring.style.transform = "scale(1)";
          setTimeout(() => {
            ring.style.opacity = "0";
            ring.style.transform = "scale(.6)";
          }, 180);
        },
        true,
      );
    };
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    window.__moveTo = (x, y, ms) =>
      new Promise((res) => {
        mount();
        const c = document.getElementById("__cur"),
          a = { ...window.__pos },
          t0 = performance.now();
        const dx = x - a.x,
          dy = y - a.y,
          bow = Math.min(60, Math.hypot(dx, dy) * 0.06); // a slight arc, like a hand
        (function f(now) {
          const k = ease(Math.min(1, (now - t0) / ms));
          const px = a.x + dx * k - (dy / (Math.hypot(dx, dy) || 1)) * bow * Math.sin(Math.PI * k);
          const py = a.y + dy * k + (dx / (Math.hypot(dx, dy) || 1)) * bow * Math.sin(Math.PI * k);
          c.style.transform = `translate(${px - 4}px,${py - 2}px)`;
          window.__pos = { x: px, y: py };
          if (k < 1) requestAnimationFrame(f);
          else {
            window.__pos = { x, y };
            sessionStorage.setItem("__cursor", JSON.stringify({ x, y }));
            res();
          }
        })(t0);
      });
    window.__scrollTo = (y, ms) =>
      new Promise((res) => {
        const y0 = window.scrollY,
          t0 = performance.now();
        (function f(now) {
          const k = ease(Math.min(1, (now - t0) / ms));
          window.scrollTo(0, y0 + (y - y0) * k);
          if (k < 1) requestAnimationFrame(f);
          else res();
        })(t0);
      });
    // backdrop blurs are the costly part of painting in a software renderer; without them the page scrolls at ~44 fps instead of ~37
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}";
      document.head.appendChild(st);
    });
    document.addEventListener("DOMContentLoaded", mount);
    window.addEventListener("load", mount);
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  return { ctx, page, cdp };
};

// ---- prepare: put the chain clock just before a round boundary so a fresh round (about 14 minutes) is open and quoted
const browser = await chromium.launch();
{
  const t = await chainNow(),
    B = Math.ceil((t + 5) / 900) * 900;
  if (B - t > 60) {
    await rpc("evm_increaseTime", [B - t - 45]);
    await rpc("evm_mine");
  }
  log(
    `chain clock moved to ${new Date((await chainNow()) * 1000).toISOString().slice(11, 19)}, waiting for the round to open`,
  );
  const { page } = await newContext(browser);
  await page.goto(base + "/markets");
  await page.getByTestId("round-card").first().waitFor({ timeout: 240000 });
  await page.getByTestId("round-card").first().click();
  await expect(page.getByTestId("bet-up")).toBeEnabled({ timeout: 120000 });
  await page.close();
  log("round is open and quoted");
}

// ---- record
const work = join(here, "work"),
  frames = join(work, "journey-frames");
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const { ctx, page, cdp } = await newContext(browser);
const got = [];
cdp.on("Page.screencastFrame", async (f) => {
  got.push({ ts: f.metadata.timestamp, data: f.data });
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
const wait = (ms) => page.waitForTimeout(ms);
const glide = async (loc, ms = 900, pause = 350) => {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  const x = b.x + b.width / 2 + Math.min(b.width, 80) / 6,
    y = b.y + b.height / 2;
  await page.evaluate(([x, y, ms]) => window.__moveTo(x, y, ms), [x, y, ms]);
  await page.mouse.move(x, y);
  await wait(pause);
};
const tap = async (loc, ms = 900, pause = 700) => {
  await glide(loc, ms);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
  await wait(pause);
};
const scroll = (y, ms) => page.evaluate(([y, ms]) => window.__scrollTo(y, ms), [y, ms]);

await page.goto(base + "/", { waitUntil: "load" });
await page.waitForFunction(() => !!document.getElementById("__cur"));
await wait(800);
await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 90,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
});
const T0 = Date.now();
const mark = (s) => log(`${((Date.now() - T0) / 1000).toFixed(1)} s  ${s}`);

// 1 · landing
await page.evaluate(() => window.__moveTo(1180, 520, 1400));
await wait(2200);
await scroll(760, 2000);
await wait(2200);
await scroll(0, 1500);
await wait(700);
mark("landing done");

// 2 · the passkey account
await tap(page.getByRole("link", { name: /Start with Face ID/ }).first(), 1100, 1500);
await wait(1200);
await tap(page.getByRole("button", { name: /Create account with Face ID/ }), 1000, 400);
await expect(page.getByTestId("handle")).toBeVisible({ timeout: 30000 });
await wait(2600);
mark("account created");

// 3 · test money
await tap(page.getByRole("button", { name: /Add money to start/ }), 1000, 900);
await tap(page.getByTestId("faucet"), 900, 300);
await expect(page.getByTestId("usdc-balance")).toHaveText("$100.00", { timeout: 60000 });
await wait(2400);
mark("funded");

// 4 · the live round and the bet
await tap(page.getByTestId("to-markets"), 1000, 1800);
await wait(1200);
const card = page.getByTestId("round-card").first();
await tap(card, 1100, 1800);
await expect(page.getByTestId("bet-up")).toBeEnabled({ timeout: 60000 });
await wait(2800);
await tap(page.getByTestId("bet-up"), 1000, 2200);
await expect(page.getByTestId("pay")).not.toHaveText("—");
await wait(1800);
await tap(page.getByTestId("confirm"), 1000, 300);
await expect(page.getByTestId("result")).toContainText("You're in on Up", { timeout: 60000 });
await wait(3600);
await tap(page.getByTestId("close-result"), 900, 1200);
mark("bet filled");

// 5 · the round runs out (time-lapse of the chain clock), then settles
{
  // find this round's end from the page's countdown by reading the chain: the market was created by the scheduler
  const now0 = await chainNow();
  const end = Math.ceil((now0 + 1) / 900) * 900;
  const total = end - now0 + 1;
  const steps = 36;
  for (let i = 0; i < steps; i++) {
    await rpc("evm_increaseTime", [Math.ceil(total / steps)]);
    await rpc("evm_mine");
    await sleep(140);
  }
}
await wait(2500);
// the scheduler proposes the end price, waits out the finalization window (chain time), then resolves
for (let i = 0; i < 6; i++) {
  await sleep(1200);
  await rpc("evm_increaseTime", [8]);
  await rpc("evm_mine");
}
await expect(page.getByText(/Round over/).first()).toBeVisible({ timeout: 90000 });
await wait(3200);
mark("round settled");

// 6 · collect
await tap(page.getByRole("link", { name: /My bets/ }).first(), 1000, 1500);
await expect(page.getByTestId("claim-total")).toContainText("ready to collect", { timeout: 60000 });
await wait(2400);
await tap(page.getByTestId("collect-all"), 1000, 400);
await expect(page.getByText(/Collected \$/).first()).toBeVisible({ timeout: 60000 });
await wait(3200);
mark("collected");

// 7 · earn (the LP side)
await tap(page.getByRole("link", { name: /^Earn$/ }).first(), 1000, 1800);
await expect(page.getByTestId("epoch-clock")).toBeVisible();
await wait(1800);
await scroll(520, 1800);
await wait(2400);
await scroll(0, 1200);
await wait(500);
await tap(page.getByTestId("deposit-amount"), 900, 300);
await page.getByTestId("deposit-amount").pressSequentially("50", { delay: 220 });
await wait(900);
await tap(page.getByTestId("ack"), 900, 700);
await tap(page.getByTestId("deposit"), 900, 300);
await expect(page.getByText("Deposit $50.00")).toBeVisible({ timeout: 60000 });
await wait(3200);
mark("deposit requested");

// 8 · live numbers
await tap(page.getByRole("link", { name: /Stats/ }).first(), 1000, 2500);
await wait(2500);
await scroll(620, 2000);
await wait(2600);
await scroll(0, 1400);
await wait(900);
mark("stats done");

await cdp.send("Page.stopScreencast");
await ctx.close();
await browser.close();

// ---- frames -> a constant 60 fps video
got.sort((a, b) => a.ts - b.ts);
const list = [];
got.forEach((f, i) => {
  const name = `f${String(i).padStart(5, "0")}.jpg`;
  writeFileSync(join(frames, name), Buffer.from(f.data, "base64"));
  const dur = i + 1 < got.length ? Math.max(0.001, got[i + 1].ts - f.ts) : 0.6;
  list.push(`file '${name}'\nduration ${dur.toFixed(5)}`);
});
list.push(`file 'f${String(got.length - 1).padStart(5, "0")}.jpg'`);
writeFileSync(join(frames, "list.txt"), list.join("\n"));
const out = join(work, "journey.mp4");
const r = spawnSync(
  ffmpeg,
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    join(frames, "list.txt"),
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "17",
    "-preset",
    "medium",
    out,
  ],
  { stdio: "inherit" },
);
const iv = got
  .slice(1)
  .map((f, i) => (f.ts - got[i].ts) * 1000)
  .filter((x) => x < 100)
  .sort((a, b) => a - b);
log(
  `while the screen was changing: interval p50 ${iv[Math.floor(iv.length / 2)].toFixed(0)} ms, p95 ${iv[Math.floor(iv.length * 0.95)].toFixed(0)} ms, share over 50 ms ${((100 * iv.filter((x) => x > 50).length) / iv.length).toFixed(1)} %`,
);
const span = got.at(-1).ts - got[0].ts;
log(
  `frames ${got.length} over ${span.toFixed(1)} s (${(got.length / span).toFixed(1)} fps captured) -> ${out} (exit ${r.status})`,
);
rmSync(frames, { recursive: true, force: true });
