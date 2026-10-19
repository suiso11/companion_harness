// PR-4 provisional answer draft over the production UI/server/core.
//
// No API mocks: every flow drives the real Svelte chat UI against the
// real Hono app + RunEngine. The deterministic fake RunStrategy
// (e2e/server.ts) publishes paced ephemeral `answer.draft.delta` pieces
// (same coalesced-bus pattern as the PR-3 reasoning simulation) when
// COMPANION_MODEL_STREAMING=1 (set by the e2e webServer env).

import { expect, type Page, test } from "@playwright/test";
import {
  E2E_CONTROL_ORIGIN,
  TEXT_DRAFT,
  TEXT_DRAFT_CANCEL,
  TEXT_DRAFT_RELOAD,
  TEXT_DRAFT_STEPS,
  TEXT_HANG,
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

test("draft streams incrementally as inert text, replaced by validated answer", async ({
  page,
}) => {
  await send(page, TEXT_DRAFT);
  const draft = page.locator("[data-draft]");
  await expect(draft).toBeVisible({ timeout: 15_000 });
  // Provisional label marks the bubble as unvalidated.
  await expect(page.locator("[data-draft-label]")).toContainText(
    "下書き（検証前）",
  );
  const draftText = page.locator("[data-draft-text]");
  await expect(draftText).toContainText("draft one", { timeout: 15_000 });
  await expect(draftText).toContainText("draft two", { timeout: 15_000 });
  await expect(draftText).toContainText("draft three", { timeout: 15_000 });
  // No live citation links/chips inside the draft: plain text only.
  await expect(draft.locator("a")).toHaveCount(0);
  await expect(draft.locator("button")).toHaveCount(0);
  // Markup-significant and citation-like markers stay inert text.
  await expect(draftText).toContainText('<a href="https://x">link</a>');
  await expect(draftText).toContainText("[r1]");
  await expect(draftText).toContainText("<b>bold</b>");
  await expect(draft.locator("b")).toHaveCount(0);
  // Draft tokens are never announced; the status line keeps polite updates.
  await expect(draft).toHaveAttribute("aria-live", "off");
  await expect(page.locator("[data-run-status]")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  // The validated answer REPLACES the draft completely.
  await expect(page.locator("#conversation")).toContainText(
    "validated answer",
    { timeout: 15_000 },
  );
  await expect(page.locator("[data-draft]")).toHaveCount(0);
  await expect(page.locator("[data-draft-label]")).toHaveCount(0);
  await expect(page.locator("#conversation")).not.toContainText("draft one");
  // Citations render only on the validated answer.
  await expect(
    page.locator("#conversation button", { hasText: "r1" }).first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("a new step's draft restarts instead of appending", async ({ page }) => {
  await send(page, TEXT_DRAFT_STEPS);
  const draftText = page.locator("[data-draft-text]");
  await expect(draftText).toContainText("first-piece", { timeout: 15_000 });
  await expect(draftText).toContainText("second-step", { timeout: 15_000 });
  // Restart: the step-1 text is gone once the step-2 draft lands.
  await expect(draftText).not.toContainText("first-piece");
  await expect(page.locator("[data-draft-label]")).toContainText(
    "下書き（検証前）",
  );
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_DRAFT_STEPS}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("[data-draft]")).toHaveCount(0);
});

test("cancelled run discards the draft", async ({ page }) => {
  await send(page, TEXT_DRAFT_CANCEL);
  await expect(page.locator("[data-draft-text]")).toContainText(
    "cancel draft quickly",
    { timeout: 15_000 },
  );
  await page.locator("#composer-stop").click();
  await expect(page.locator("#composer-notice")).toContainText("停止しました", {
    timeout: 15_000,
  });
  await expect(page.locator("[data-draft]")).toHaveCount(0);
  await expect(page.locator("[data-draft-label]")).toHaveCount(0);
  // The composer recovers for the next turn.
  await expect(page.locator("#composer-send")).toBeEnabled({ timeout: 15_000 });
});

test("reload drops the ephemeral draft but keeps the durable status", async ({
  page,
}) => {
  await send(page, TEXT_DRAFT_RELOAD);
  await expect(page.locator("[data-draft-text]")).toContainText(
    "reload draft slowly",
    { timeout: 15_000 },
  );
  // Mid-run reload: the ephemeral draft is gone by construction…
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("[data-draft]")).toHaveCount(0);
  await expect(page.locator("[data-draft-label]")).toHaveCount(0);
  // …but the durable phase line rebuilds from replayed events.
  await expect(page.locator("[data-run-status]")).toContainText(
    /考え中|ツール実行中|回答作成中/,
    { timeout: 15_000 },
  );
  // The run still settles, and no draft ever reappears.
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_DRAFT_RELOAD}`,
    { timeout: 20_000 },
  );
  await expect(page.locator("[data-draft]")).toHaveCount(0);
});

test("non-streaming run shows no draft", async ({ page, request }) => {
  await send(page, TEXT_HANG);
  // Active run without deltas: status line only, never a draft bubble.
  await expect(page.locator("[data-run-status]")).toContainText("考え中", {
    timeout: 15_000,
  });
  await expect(page.locator("[data-draft]")).toHaveCount(0);
  await expect(page.locator("[data-draft-label]")).toHaveCount(0);
  await control(request, "/release");
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_HANG}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("[data-draft]")).toHaveCount(0);
});
