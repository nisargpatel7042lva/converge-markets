import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, expect, test } from "../e2e/fixtures";

const evidence = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/evidence/phase-10",
);

test("a Mera passkey account trades on Monad testnet, live", async ({
  page,
  authenticator,
  problems,
}) => {
  void authenticator;
  const t: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => (t[k] = Date.now() - t0);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Call the next 15 minutes");
  mark("landing");

  const handle = await createAccount(page);
  mark("accountCreated");

  // the public testnet RPC is shared and rate-limited, so the balance can take longer than on a local chain
  await page.getByRole("button", { name: /Add money to start/ }).click();
  await page.getByTestId("faucet").click();
  await expect(page.getByTestId("usdc-balance")).toHaveText("$100.00", { timeout: 120_000 });
  mark("funded");

  await page.getByTestId("to-markets").click();
  await page.getByTestId("round-card").first().click();
  await expect(page.getByTestId("bet-up")).toBeEnabled({ timeout: 60_000 });
  mark("marketReady");

  await page.getByTestId("bet-up").click();
  await expect(page.getByTestId("pay")).not.toHaveText("—");
  await page.getByTestId("confirm").click();
  mark("confirmed");
  const result = page.getByTestId("result");
  await expect(result).toContainText(/You're in on Up|refund|back in your account|cancel/i, {
    timeout: 90_000,
  });
  const outcome = (await result.textContent()) ?? "";
  mark("resultShown");
  const filled = /You're in on Up/.test(outcome);

  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, "mera-testnet-result.png") });
  await page.getByTestId("close-result").click();
  await page.goto("/account");
  const address = await page.evaluate(() => {
    try {
      return (
        (JSON.parse(localStorage.getItem("converge.profile.v1") ?? "{}") as { address?: string })
          .address ?? null
      );
    } catch {
      return null;
    }
  });
  expect(problems, problems.join("\n")).toEqual([]);

  writeFileSync(
    resolve(evidence, "mera-testnet-trade.json"),
    JSON.stringify(
      {
        note: "Wall-clock milliseconds from page.goto('/') on a 375x812 mobile profile, against the live Monad testnet app, the live keeper and a live 15-minute round. Includes creating the passkey account (Chromium virtual authenticator with PRF), the in-app faucet, the approval and the order, and the keeper's fill.",
        handle,
        address,
        filled,
        resultText: outcome.replace(/\s+/g, " ").trim().slice(0, 160),
        steps: t,
        totalMs: t.resultShown,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await page.close();
  const video = await page.video()?.path();
  if (video) copyFileSync(video, resolve(evidence, "mera-testnet-trade.webm"));
  expect(filled, `the bet was not filled: ${outcome}`).toBe(true);
});
