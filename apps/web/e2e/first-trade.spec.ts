import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, expect, fundWithFaucet, test } from "./fixtures";

const evidence = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/evidence/phase-7");

test("landing to a confirmed first trade in under 60 seconds", async ({
  page,
  authenticator,
  problems,
}, info) => {
  void authenticator;
  const t: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => (t[k] = Date.now() - t0);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Call the next 15 minutes");
  mark("landing");

  const handle = await createAccount(page);
  mark("accountCreated");
  expect(handle).toMatch(/^[a-z]+-[a-z]+-\d\d$/);

  await fundWithFaucet(page);
  mark("funded");

  await page.getByTestId("to-markets").click();
  await page.getByTestId("round-card").first().click();
  await expect(page.getByTestId("bet-up")).toBeEnabled();
  mark("marketReady");

  await page.getByTestId("bet-up").click();
  await expect(page.getByTestId("pay")).not.toHaveText("—");
  await page.getByTestId("confirm").click();
  mark("confirmed");
  await expect(page.getByTestId("result")).toContainText("You're in on Up", { timeout: 30_000 });
  mark("tradeFilled");
  const total = t.tradeFilled!;

  // the trade really happened: the dollars left the account and the position is listed
  await page.getByTestId("close-result").click();
  await page.goto("/positions");
  await expect(page.getByTestId("position")).toHaveCount(1);
  await page.goto("/fund");
  const left = Number((await page.getByTestId("usdc-balance").textContent())!.replace(/[$,]/g, ""));
  expect(left).toBeLessThan(100);
  expect(left).toBeGreaterThan(94);

  expect(problems, problems.join("\n")).toEqual([]);

  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, "first-trade-timing.json"),
    JSON.stringify(
      {
        note: "Wall-clock milliseconds from page.goto('/') on a 375x812 mobile profile. Chain: local anvil with 0.4 s blocks, real contracts, real keeper. Includes creating the passkey account (Chromium virtual authenticator with PRF), the in-app faucet, the approval and the order, and the keeper's execution.",
        steps: t,
        totalMs: total,
        thresholdMs: 60_000,
        pass: total < 60_000,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: resolve(evidence, "first-trade-result.png") });
  expect(total).toBeLessThan(60_000);

  // the video is finalised when the page closes: copy it in afterEach-style
  await page.close();
  const video = await page.video()?.path();
  if (video) copyFileSync(video, resolve(evidence, "first-trade.webm"));
  info.annotations.push({ type: "timing", description: JSON.stringify(t) });
});
