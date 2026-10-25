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
import { AGORA_APP_ORIGIN } from "./e2e/agora/ports.js";
import { AUTODISPATCH_APP_ORIGIN } from "./e2e/autodispatch/ports.js";
import { CALENDAR_APP_ORIGIN } from "./e2e/calendar/ports.js";
import { MEMORY_APP_ORIGIN } from "./e2e/memory/ports.js";
import { E2E_APP_ORIGIN } from "./e2e/ports.js";

const CALENDAR_MODE = process.env.COMPANION_E2E_CALENDAR === "1";
const MEMORY_MODE = process.env.COMPANION_E2E_MEMORY === "1";
const AGORA_MODE = process.env.COMPANION_E2E_AGORA === "1";
const AUTODISPATCH_MODE = process.env.COMPANION_E2E_AUTODISPATCH === "1";

const APP_ORIGIN = CALENDAR_MODE
  ? CALENDAR_APP_ORIGIN
  : MEMORY_MODE
    ? MEMORY_APP_ORIGIN
    : AGORA_MODE
      ? AGORA_APP_ORIGIN
      : AUTODISPATCH_MODE
        ? AUTODISPATCH_APP_ORIGIN
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
      ? [
          "memory/memory_graph.spec.ts",
          "memory/memory_associate.spec.ts",
          "memory/memory_manage.spec.ts",
        ]
      : AGORA_MODE
        ? ["agora/agora.spec.ts"]
        : AUTODISPATCH_MODE
          ? ["autodispatch/autodispatch.spec.ts"]
          : [
            "conversation.spec.ts",
            "citation_recovery.spec.ts",
            "sse_history.spec.ts",
            "polling.spec.ts",
            "autonomy.spec.ts",
            "shadow.spec.ts",
            "notifications.spec.ts",
            "conversation_proposals.spec.ts",
            "learning.spec.ts",
            "handoff.spec.ts",
            "monitor.spec.ts",
            "mobile_layout.spec.ts",
            "svelte_shell.spec.ts",
            "thinking_status.spec.ts",
            "draft_answer.spec.ts",
            "web_search.spec.ts",
            "voice.spec.ts",
          ],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serial execution is REQUIRED for the calendar suite: the dedicated
  // fake harness (e2e/calendar/server.ts) keeps process-global fixture
  // state (upstream revision, search/get/write counters, arm modes) that
  // every spec resets via loopback /reset. Parallel workers share that
  // state, so concurrent specs pollute each other's count assertions
  // (searchCalls/writeCalls Expected 1 Received N/0). Do not override
  // with --workers=N on the CLI.
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
        : AGORA_MODE
          ? // Always build through the standard guard: no prebuilt bundle
            // reuse, so the AGORA browser smoke exercises the real budget.
            "node scripts/build-ui.mjs && node --import tsx e2e/agora/server.ts"
          : AUTODISPATCH_MODE
            ? // Same standard build guard; the real installed pi-orch child
              // needs the host user-systemd bus, which the harness locates.
              // The preflight ONLY terminates a prior fixture whose argv+cwd
              // match this exact autodispatch server (no port-wide kill).
              // `exec` makes the node server the shell's PID, so Playwright's
              // timeout SIGTERM reaches the fixture teardown directly.
              "node e2e/autodispatch/preflight.mjs && node scripts/build-ui.mjs && exec node --import tsx e2e/autodispatch/server.ts"
            : "node scripts/build-ui.mjs && node --import tsx e2e/server.ts",
    url: `${APP_ORIGIN}/health/live`,
    // The autodispatch fixture owns durable global control/ledger state and
    // a real pi-orch scope: NEVER reuse a server left by an earlier run
    // (timed-out runs previously left an unpaused/old-code fixture behind).
    // Every other mode keeps the existing local reuse behaviour.
    reuseExistingServer: AUTODISPATCH_MODE ? false : !process.env.CI,
    timeout: 120_000,
    // The autodispatch fixture needs a REAL graceful stop so its SIGTERM
    // teardown can close the runner/control server and remove its OS tmp
    // roots. Without this Playwright force-kills it (SIGKILL) and leftovers
    // accumulate. Other modes keep the existing stop behaviour.
    ...(AUTODISPATCH_MODE
      ? { gracefulShutdown: { signal: "SIGTERM" as const, timeout: 20_000 } }
      : {}),
    stdout: "pipe",
    stderr: "pipe",
    // PR-2/PR-3: the default e2e harness simulates model streaming
    // (ephemeral reasoning/usage deltas) when this flag is set; the fake
    // strategy stays delta-free without it.
    env: {
      COMPANION_MODEL_STREAMING: "1",
      // Voice spec: the shared e2e server only enables the TEXT_VOICE fake
      // branch when this opt-in config is present (all other specs ignore it).
      COMPANION_VOICE_JSON: '{"profile":"shunkin"}',
    },
  },
});
