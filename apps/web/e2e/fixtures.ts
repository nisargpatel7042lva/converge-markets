import { test as base, expect, type CDPSession, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export type Chain = {
  baseURL: string;
  rpc: string;
  market: `0x${string}`;
  start: number;
  end: number;
  adminKey: `0x${string}`;
  signerKey: `0x${string}`;
  streams: `0x${string}`;
  assetId: `0x${string}`;
};

export const chainInfo = (): Chain =>
  JSON.parse(readFileSync(process.env.E2E_CHAIN as string, "utf8"));

/**
 * Every test gets a Chromium virtual authenticator with the PRF extension (a platform passkey
 * that always passes user verification) and a collector for console errors, page errors and
 * failed requests: a test fails if the app logs an error or a hydration warning.
 */
export const test = base.extend<{ authenticator: CDPSession; problems: string[] }>({
  problems: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /hydrat/i.test(m.text()))
        problems.push(`console ${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await use(problems);
  },
  authenticator: async ({ context, page }, use) => {
    const cdp = await context.newCDPSession(page);
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
    await use(cdp);
  },
});

export { expect };

/** Creates a Mera account through the real UI and returns its handle. */
export async function createAccount(page: Page): Promise<string> {
  await page.getByRole("link", { name: /Start with Face ID/ }).click();
  await page.getByRole("button", { name: /Create account with Face ID/ }).click();
  const handle = page.getByTestId("handle");
  await expect(handle).toBeVisible();
  return (await handle.textContent()) ?? "";
}

/** Gets free test money through the app's own faucet and waits for the balance. */
export async function fundWithFaucet(page: Page) {
  await page.getByRole("button", { name: /Add money to start/ }).click();
  await page.getByTestId("faucet").click();
  await expect(page.getByTestId("usdc-balance")).toHaveText("$100.00");
}
