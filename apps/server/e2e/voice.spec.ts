// Voice UI acceptance: a rendered voice projection is displayed by default,
// the per-answer「原文」/「話し方」 toggle switches between voiced and
// canonical text (citations stay bound to the canonical part index), and
// the whole flow renders under the strict production CSP with no inline
// styles. The e2e server uses the REAL voice renderer/gate with a fake
// model gateway (COMPANION_VOICE_JSON opt-in); no API responses are mocked.

import { expect, test } from "@playwright/test";
import {
  CITATION_SNAPSHOT_TEXT,
  E2E_CONTROL_ORIGIN,
  TEXT_VOICE,
  VOICE_CANONICAL_TEXT,
  VOICE_RENDERED_TEXT,
} from "./ports.js";

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/release" | "/reset",
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function send(page: import("@playwright/test").Page, text: string) {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

async function sessionIdOf(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    (): boolean => {
      try {
        const value = localStorage.getItem("ch.sessionId");
        return value !== null && value.length > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15_000 },
  );
  return (await page.evaluate(() => localStorage.getItem("ch.sessionId"))) as
    | string
    | null;
}

async function seedCitation(
  request: import("@playwright/test").APIRequestContext,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
    data: { sessionId, text },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ordinal: number };
  expect(body.ordinal).toBe(1);
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

test("rendered voice is default, toggle returns to canonical, citation stays canonical", async ({
  page,
  request,
}) => {
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy/i.test(message.text())
    ) {
      cspViolations.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const sessionId = await sessionIdOf(page);
  expect(typeof sessionId).toBe("string");
  await seedCitation(request, sessionId as string, CITATION_SNAPSHOT_TEXT);

  await send(page, TEXT_VOICE);
  const conversation = page.locator("#conversation");
  await expect(conversation).toContainText(VOICE_RENDERED_TEXT, {
    timeout: 15_000,
  });
  // Default shows the voiced text, not the canonical answer.
  await expect(conversation).not.toContainText(VOICE_CANONICAL_TEXT);

  const toggle = page.locator('[data-voice-toggle="true"]').first();
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toHaveAttribute("data-voice-view", "voiced");
  await expect(toggle).toHaveAttribute("aria-label", "原文を表示");
  await expect(toggle).toHaveText("原文");

  // Keyboard-accessible toggle: focus + Enter (not a mouse-only control).
  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("data-voice-view", "canonical");
  await expect(toggle).toHaveAttribute("aria-label", "話し方で表示");
  await expect(toggle).toHaveText("話し方");
  await expect(conversation).toContainText(VOICE_CANONICAL_TEXT);
  await expect(conversation).not.toContainText(VOICE_RENDERED_TEXT);

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-voice-view", "voiced");
  await expect(toggle).toHaveAttribute("aria-label", "原文を表示");
  await expect(conversation).toContainText(VOICE_RENDERED_TEXT);
  await expect(conversation).not.toContainText(VOICE_CANONICAL_TEXT);

  // The citation button is bound to the canonical part and still opens the
  // stored reference while the voiced text is displayed.
  await page.locator('[data-citation="r1"]').first().click();
  await expect(page.locator("#drawer")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#drawer-body")).toHaveText(
    CITATION_SNAPSHOT_TEXT,
    { timeout: 15_000 },
  );

  // Strict CSP: no violation console errors and no inline style attributes.
  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.locator("#conversation [style]").count()).toBe(0);
});
