import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e run builds and serves the app against a local anvil chain with the real contracts and the
 * real keeper (see e2e/global-setup.ts). Mobile first: a 375 px phone profile. Video is recorded
 * for every test; the timed first-trade test's video is copied to docs/evidence/phase-7/.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "e2e-results/results.json" }]],
  outputDir: "e2e-results/artifacts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    ...devices["Pixel 7"],
    viewport: { width: 375, height: 812 },
    video: { mode: "on", size: { width: 375, height: 812 } },
    trace: "retain-on-failure",
  },
});
