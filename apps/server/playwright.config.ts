// Playwright real-browser smoke E2E config (chromium only).
//
// webServer builds the production UI bundle first, then boots the real
// Hono app on loopback with a temp SQLite DB + deterministic fake
// RunStrategy (e2e/server.ts). Specs drive the REAL UI/API only.
//
// C15 dedicated Calendar fake harness mode: set COMPANION_E2E_CALENDAR=1
// to run the OWNED Calendar composition instead (e2e/calendar/server.ts:
// real C14 startServer seams, real MCP connector over the official SDK
// inert transport, scripted fake MCP server + fake model, real agent/
// broker pipeline, REAL UI — see docs/operations.md §Calendar E2E).

import { defineConfig, devices } from "@playwright/test";
import { CALENDAR_APP_ORIGIN } from "./e2e/calendar/ports.js";
import { MEMORY_APP_ORIGIN } from "./e2e/memory/ports.js";
import { E2E_APP_ORIGIN } from "./e2e/ports.js";

const CALENDAR_MODE = process.env.COMPANION_E2E_CALENDAR === "1";
const MEMORY_MODE = process.env.COMPANION_E2E_MEMORY === "1";

const APP_ORIGIN = CALENDAR_MODE
  ? CALENDAR_APP_ORIGIN
  : MEMORY_MODE
    ? MEMORY_APP_ORIGIN
    : E2E_APP_ORIGIN;

export default defineConfig({
  testDir: "./e2e",
  testMatch: CALENDAR_MODE
    ? [
        "calendar/calendar.spec.ts",
        "calendar/action.spec.ts",
        "calendar/tombstone.spec.ts",
        "calendar/create.spec.ts",
        "calendar/evidence.spec.ts",
      ]
    : MEMORY_MODE
      ? ["memory/memory_manage.spec.ts"]
      : [
          "conversation.spec.ts",
          "citation_recovery.spec.ts",
          "sse_history.spec.ts",
          "polling.spec.ts",
        ],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: APP_ORIGIN,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: CALENDAR_MODE
      ? "node scripts/build-ui.mjs && node --import tsx e2e/calendar/server.ts"
      : MEMORY_MODE
        ? "node scripts/build-ui.mjs && node --import tsx e2e/memory/server.ts"
        : "node scripts/build-ui.mjs && node --import tsx e2e/server.ts",
    url: `${APP_ORIGIN}/health/live`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
