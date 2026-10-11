import { defineConfig, devices } from "@playwright/test";

/**
 * The same passkey-to-first-trade flow as e2e/first-trade.spec.ts, against the LIVE Monad testnet app
 * (default http://localhost:3200: .testnet/start-app.sh), with the live keeper and a live round. No local chain and
 * no global setup: the testnet stack must already be running.
 *   E2E_BASE_URL=http://localhost:3200 pnpm exec playwright test -c playwright.testnet.config.ts
 */
export default defineConfig({
  testDir: "./e2e-testnet",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "e2e-results/testnet",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3200",
    ...devices["Pixel 7"],
    viewport: { width: 375, height: 812 },
    video: { mode: "on", size: { width: 375, height: 812 } },
    trace: "retain-on-failure",
  },
});
