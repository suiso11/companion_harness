// PR-3 thinking/status UI over the production UI/server/core.
//
// No API mocks: every flow drives the real composer UI against the real
// Hono app + RunEngine. The deterministic fake RunStrategy
// (e2e/server.ts) publishes streaming-equivalent ephemeral deltas
// (`model.reasoning.delta` + `model.usage`) for TEXT_THINK* inputs when
// COMPANION_MODEL_STREAMING=1 (set by the e2e webServer env), and records
// real durable `tool.requested`/`tool.completed` rows for the tool phase.

import { expect, type Page, test } from "@playwright/test";
import {
  E2E_CONTROL_ORIGIN,
  TEXT_HANG,
  TEXT_THINK,
  TEXT_THINK_TOOLS,
} from "./ports.js";

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/arm-fail" | "/release" | "/reset",
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  await control(request, "/release");
});

test("thinking block streams, collapses after answer, tok/s shown", async ({
  page,
}) => {
  await send(page, TEXT_THINK);
  // Status line appears while the run is active (phase + elapsed).
  const status = page.locator("[data-run-status]");
  await expect(status).toContainText("考え中", { timeout: 15_000 });
  await expect(status).toContainText("秒");
  // The Thinking block streams the ephemeral reasoning text.
  const thinking = page.locator("[data-thinking]");
  await expect(thinking).toBeVisible({ timeout: 15_000 });
  const toggle = page.locator("[data-thinking-toggle]");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const body = page.locator("[data-thinking-text]");
  await expect(body).toContainText("続き two", { timeout: 15_000 });
  // Markup-significant reasoning stays plain text: no HTML interpretation.
  await expect(body).toContainText("<b>one</b>");
  await expect(thinking.locator("b")).toHaveCount(0);
  // Terminal answer auto-collapses the block and shows tok/s stats.
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_THINK}`,
    { timeout: 15_000 },
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-run-stats]")).toContainText("tok/s", {
    timeout: 15_000,
  });
  // The user can re-open the collapsed block.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect(body).toContainText("続き two");
});

test("tool phase from durable events; reload keeps status, drops thinking text", async ({
  page,
}) => {
  await send(page, TEXT_THINK_TOOLS);
  const status = page.locator("[data-run-status]");
  await expect(status).toContainText("ツール実行中", { timeout: 15_000 });
  // Tool kind only (カレンダー検索), never raw tool names or args.
  await expect(status).toContainText("カレンダー検索");
  await expect(status).not.toContainText("calendar.search");
  await expect(status).toContainText("秒");
  // Mid-run reload: the ephemeral thinking text is gone by construction…
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("[data-thinking]")).toHaveCount(0);
  // …but the durable phase line rebuilds from replayed events.
  const statusAfter = page.locator("[data-run-status]");
  await expect(statusAfter).toContainText(/考え中|ツール実行中|回答作成中/, {
    timeout: 15_000,
  });
  // The run still settles with its terminal echo answer.
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_THINK_TOOLS}`,
    { timeout: 20_000 },
  );
  await expect(page.locator("[data-run-status]")).toHaveCount(0);
});

test("non-streaming run shows status line without thinking block", async ({
  page,
  request,
}) => {
  await send(page, TEXT_HANG);
  // Active run: phase line visible, no thinking block without deltas.
  const status = page.locator("[data-run-status]");
  await expect(status).toContainText("考え中", { timeout: 15_000 });
  await expect(page.locator("[data-thinking]")).toHaveCount(0);
  await expect(page.locator("[data-run-stats]")).toHaveCount(0);
  // Release the hang: terminal echo, still no thinking block or stats.
  await control(request, "/release");
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_HANG}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("[data-thinking]")).toHaveCount(0);
  await expect(page.locator("[data-run-stats]")).toHaveCount(0);
});
