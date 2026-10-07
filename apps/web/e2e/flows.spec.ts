import {
  convergeVaultAbi,
  dataStreamsResolverAbi,
  marketAbi,
  signTestReportSync,
} from "@converge/sdk";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainInfo, createAccount, expect, fundWithFaucet, test } from "./fixtures";

const info = () => chainInfo();
const TEST_FEED: Hex = "0x0003000000000000000000000000000000000000000000000000000000000001";

function admin() {
  const c = info();
  const account = privateKeyToAccount(c.adminKey);
  const transport = http(c.rpc);
  return {
    account,
    pub: createPublicClient({ transport }),
    wallet: createWalletClient({ account, transport }),
    c,
  };
}

async function rpc(method: string, params: unknown[] = []) {
  await fetch(info().rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test.describe("static pages and the edge", () => {
  test("landing, legal, stats and the PWA files load with no console errors", async ({
    page,
    problems,
    request,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Start with Face ID/ })).toBeVisible();
    for (const doc of ["terms", "risk", "privacy"]) {
      await page.goto(`/legal/${doc}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    await page.goto("/stats");
    await expect(page.getByRole("heading", { name: "Live numbers" })).toBeVisible();
    await expect(page.getByText("Money in the vault")).toBeVisible();
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBe(true);
    const m = await manifest.json();
    expect(m.display).toBe("standalone");
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
    expect((await request.get("/sw.js")).ok()).toBe(true);
    expect((await request.get("/offline.html")).ok()).toBe(true);
    expect((await request.get("/icons/icon-512.png")).ok()).toBe(true);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("a restricted region gets the explanation page (HTTP 451) for pages and the API", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { "x-vercel-ip-country": "IN" },
      baseURL: info().baseURL,
    });
    const page = await ctx.newPage();
    const res = await page.goto("/markets");
    expect(res?.status()).toBe(451);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "isn't available in your region",
    );
    const api = await ctx.request.post("/api/faucet", {
      data: { address: "0x0000000000000000000000000000000000000001" },
    });
    expect(api.status()).toBe(451);
    // the optional reviewer bypass: wrong token stays blocked, the right one sets a cookie
    const wrong = await ctx.request.get("/?region_bypass=nope", { maxRedirects: 0 });
    expect(wrong.status()).toBe(451);
    await ctx.close();
    const rev = await browser.newContext({
      extraHTTPHeaders: { "x-vercel-ip-country": "IN" },
      baseURL: info().baseURL,
    });
    const rp = await rev.newPage();
    expect((await rp.goto("/?region_bypass=e2e-bypass-token-0123456789"))?.status()).toBe(200);
    expect((await rp.goto("/markets"))?.status()).toBe(200); // the cookie keeps it open
    await rev.close();
    const ok = await browser.newContext({
      extraHTTPHeaders: { "x-vercel-ip-country": "DE" },
      baseURL: info().baseURL,
    });
    const p2 = await ok.newPage();
    expect((await p2.goto("/markets"))?.status()).toBe(200);
    await ok.close();
  });
});

test.describe("exit path", () => {
  test("a restricted region can still reach collect, withdraw and export, but not new bets", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { "x-vercel-ip-country": "IN" },
      baseURL: info().baseURL,
    });
    const page = await ctx.newPage();
    for (const path of ["/positions", "/vault", "/account"])
      expect((await page.goto(path))?.status()).toBe(200);
    expect((await ctx.cookies()).some((c) => c.name === "exit_only")).toBe(true);
    for (const path of ["/markets", "/start", "/fund"]) {
      const r = await page.goto(path);
      expect(r?.status() === 451 || path === "/fund").toBe(true);
    }
    await ctx.close();
  });
});

test.describe("account", () => {
  test("restoring with no passkey explains what to do; creating works; the recovery phrase is shown after a prompt", async ({
    page,
    authenticator,
    problems,
  }) => {
    void authenticator;
    await page.goto("/start");
    await page.getByRole("button", { name: /I already have an account/ }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText(/passkey/i);
    await page.getByRole("button", { name: /Create account with Face ID/ }).click();
    await expect(page.getByTestId("handle")).toBeVisible();
    await page.goto("/account");
    await expect(page.getByTestId("account-handle")).toBeVisible();
    await page.getByRole("button", { name: /Show my recovery phrase/ }).click();
    const words = (await page.getByTestId("phrase").textContent())!.trim().split(/\s+/);
    expect(words).toHaveLength(24);
    // the exported phrase derives the same address MetaMask would show: the page prints the address
    const address = (await page.locator("p.font-mono").first().textContent())!.match(
      /0x[0-9a-fA-F]{40}/,
    )![0];
    const { mnemonicToAccount } = await import("viem/accounts");
    expect(mnemonicToAccount(words.join(" ")).address.toLowerCase()).toBe(address.toLowerCase());
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("trading states", () => {
  test("no money: the trade sheet sends you to add money instead of failing", async ({
    page,
    authenticator,
    problems,
  }) => {
    void authenticator;
    await page.goto("/");
    await createAccount(page);
    await page.goto("/markets");
    await page.getByTestId("round-card").first().click();
    await page.getByTestId("bet-up").click();
    await expect(page.getByRole("link", { name: /Add money first/ })).toBeVisible();
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("a paused market shows a calm paused state and comes back", async ({
    page,
    authenticator,
    problems,
  }) => {
    void authenticator;
    const { wallet, pub, account, c } = admin();
    await page.goto("/markets");
    await page.getByTestId("round-card").first().click();
    await expect(page.getByTestId("bet-up")).toBeEnabled();
    const vault =
      (await (
        await fetch(c.rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        })
      ).json()) && undefined;
    void vault;
    const addr = JSON.parse(process.env.NEXT_PUBLIC_DEPLOYMENT_JSON ?? "null");
    void addr;
    const deployment = (await import("node:fs")).readFileSync(
      process.env.E2E_CHAIN as string,
      "utf8",
    );
    const v = (JSON.parse(deployment) as { deployment: { vault: `0x${string}` } }).deployment.vault;
    const pause = await wallet.writeContract({
      account,
      chain: null,
      address: v,
      abi: convergeVaultAbi,
      functionName: "pauseQuoting",
    });
    await pub.waitForTransactionReceipt({ hash: pause });
    await expect(page.getByTestId("paused")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("bet-up")).toBeDisabled();
    const resume = await wallet.writeContract({
      account,
      chain: null,
      address: v,
      abi: convergeVaultAbi,
      functionName: "resumeQuoting",
    });
    await pub.waitForTransactionReceipt({ hash: resume });
    await expect(page.getByTestId("bet-up")).toBeEnabled({ timeout: 20_000 });
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("vault", () => {
  test("an LP can read the risk text, must tick the box, and requests a deposit", async ({
    page,
    authenticator,
    problems,
  }) => {
    void authenticator;
    await page.goto("/");
    await createAccount(page);
    await fundWithFaucet(page);
    await page.goto("/vault");
    await expect(page.getByText("Read this before adding money")).toBeVisible();
    await expect(page.getByText("You can lose money.")).toBeVisible();
    await expect(page.getByTestId("epoch-clock")).toBeVisible();
    await page.getByTestId("deposit-amount").fill("50");
    await expect(page.getByTestId("deposit")).toBeDisabled(); // not until the box is ticked
    await page.getByTestId("ack").check();
    await page.getByTestId("deposit").click();
    await expect(page.getByText("Deposit $50.00")).toBeVisible({ timeout: 30_000 });
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("a bet nobody fills", () => {
  test("is shown as waiting, never offers a second bet, and can be cancelled for a full refund", async ({
    page,
    authenticator,
    problems,
  }) => {
    void authenticator;
    test.setTimeout(120_000);
    await fetch("http://127.0.0.1:3101/stop-keeper"); // nobody will execute the order
    await page.goto("/");
    await createAccount(page);
    await fundWithFaucet(page);
    await page.getByTestId("to-markets").click();
    await page.getByTestId("round-card").first().click();
    await expect(page.getByTestId("bet-down")).toBeEnabled();
    await page.getByTestId("bet-down").click();
    // the focus stays inside the sheet while it is open
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))),
    ).toBe(true);
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("waiting")).toBeVisible({ timeout: 30_000 });
    await page.goto("/positions");
    await expect(page.getByTestId("open-order")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("refund")).toHaveCount(0); // still inside its window
    await rpc("evm_increaseTime", [20]);
    await rpc("evm_mine");
    await expect(page.getByTestId("refund")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("refund").click();
    await expect(page.getByText(/Your money is back in your account/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("open-order")).toHaveCount(0, { timeout: 20_000 });
    await page.goto("/fund");
    await expect(page.getByTestId("usdc-balance")).toHaveText("$100.00");
    expect(problems, problems.join("\n")).toEqual([]);
    await fetch("http://127.0.0.1:3101/start-keeper"); // the next tests need an executor again
  });
});

test.describe("settlement", () => {
  test("a winning bet is collected in one tap after the round resolves", async ({
    page,
    authenticator,
    problems,
  }) => {
    void authenticator;
    test.setTimeout(150_000);
    const { wallet, pub, account, c } = admin();
    await page.goto("/");
    await createAccount(page);
    await fundWithFaucet(page);
    await page.getByTestId("to-markets").click();
    await page.getByTestId("round-card").first().click();
    await expect(page.getByTestId("bet-up")).toBeEnabled();
    await page.getByTestId("bet-up").click();
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("result")).toContainText("You're in on Up", { timeout: 30_000 });
    await page.getByTestId("close-result").click();

    // the round ends and the oracle says UP won (the keeper is stopped: only our report counts)
    await fetch("http://127.0.0.1:3101/stop-keeper");
    const block = await pub.getBlock();
    const toEnd = c.end - Number(block.timestamp) + 1;
    await rpc("evm_increaseTime", [toEnd]);
    await rpc("evm_mine");
    const price = BigInt(3100) * 10n ** 18n;
    const hash = await wallet.writeContract({
      account,
      chain: null,
      address: c.streams,
      abi: dataStreamsResolverAbi,
      functionName: "submit",
      args: [
        c.assetId,
        BigInt(c.end),
        signTestReportSync(c.signerKey, TEST_FEED, BigInt(c.end), price),
      ],
    });
    await pub.waitForTransactionReceipt({ hash });
    await rpc("evm_increaseTime", [25]);
    await rpc("evm_mine");
    try {
      const r = await wallet.writeContract({
        account,
        chain: null,
        address: c.market,
        abi: marketAbi,
        functionName: "resolve",
        args: ["0x"],
      });
      await pub.waitForTransactionReceipt({ hash: r });
    } catch (e) {
      void e; // the keeper is stopped, so this should not happen; the state check below decides
    }
    const state = await pub.readContract({
      address: c.market,
      abi: marketAbi,
      functionName: "state",
    });
    expect(Number(state)).toBe(2);

    await page.goto("/positions");
    await expect(page.getByTestId("claim-total")).toContainText("ready to collect", {
      timeout: 30_000,
    });
    const before = await page.evaluate(() => document.body.innerText);
    void before;
    await page.getByTestId("collect-all").click();
    await expect(page.getByText(/Collected \$/)).toBeVisible({ timeout: 30_000 });
    await page.goto("/fund");
    const usdc = await page.getByTestId("usdc-balance").textContent();
    expect(Number(usdc!.replace(/[$,]/g, ""))).toBeGreaterThan(100);
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
