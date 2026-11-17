// Real-browser episodic-memory view E2E over the production UI/server.
//
// Episodes are a separate chronological reference layer, not graph nodes:
// this spec drives #memory-view-episodes against the REAL Hono route; only
// the remind CLI's episode read ops are answered by the harness fixture
// wrapper (the real maintain.episodes pass needs an LLM, see server.ts).

import { expect, test } from "@playwright/test";

const SCREENSHOT = "/tmp/memory-episodes.png";

test.beforeEach(async ({ page }) => {
  await page.goto("/memory");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#memory-view-episodes")).toBeVisible();
});

test("episode view lists summaries separately and expands windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const listResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/memory/episodes?") &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await page.locator("#memory-view-episodes").click();
  await listResponse;

  const items = page.locator('[data-testid="memory-episode-item"]');
  await expect(items).toHaveCount(2);
  // remind returns startAt ASC: the older unsummarized episode comes first.
  await expect(items.first()).toContainText("未要約");
  await expect(items.nth(1)).toContainText("朝の会話");

  const windowsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/memory/episodes/windows?") &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await items.nth(1).click();
  await windowsResponse;

  const windows = page
    .locator('[data-testid="memory-episode-windows"]')
    .first();
  await expect(windows).toContainText("窓1");
  await expect(windows).toContainText("窓2");

  await page.locator("#memory").screenshot({ path: SCREENSHOT });
});
