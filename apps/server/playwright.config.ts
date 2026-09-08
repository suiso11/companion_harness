// Playwright real-browser smoke E2E config (chromium only).
//
// webServer builds the production UI bundle first, then boots the real
// Hono app on loopback with a temp SQLite DB + deterministic fake
// RunStrategy (e2e/server.ts). Specs drive the REAL UI/API only.

import { defineConfig, devices } from "@playwright/test";
import { E2E_APP_ORIGIN } from "./e2e/ports.js";

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "conversation.spec.ts",
    "citation_recovery.spec.ts",
    "sse_history.spec.ts",
  ],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: E2E_APP_ORIGIN,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/build-ui.mjs && node --import tsx e2e/server.ts",
    url: `${E2E_APP_ORIGIN}/health/live`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
