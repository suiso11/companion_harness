// PR-1 Svelte shell acceptance: the default `/` route serves the NEW Svelte
// chat UI (not the `/legacy` vanilla shell) with the dark-only theme, and
// the 375px smartphone floor holds (no horizontal overflow, send target
// >=44px). Real browser over the production UI/server with no API mocks
// (same deterministic fake RunStrategy harness as conversation.spec.ts).

import { expect, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN } from "./ports.js";

test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/arm-fail" | "/release" | "/reset",
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function noHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement;
    if (el === null) {
      return { scrollWidth: -1, clientWidth: -1 };
    }
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `horizontal overflow: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
});

test.afterEach(async ({ request }) => {
  await control(request, "/release");
});

test("new Svelte shell at / is dark-only", async ({ page }) => {
  // The SSR shell carries the Svelte bundle (and not the vanilla client),
  // proving `/` serves the NEW UI while `/legacy` keeps the vanilla shell.
  const html = await page.content();
  expect(html).toContain('src="/assets/svelte-app.js"');
  expect(html).not.toContain('src="/assets/client.js"');
  // Computed body background is dark: every channel stays well below
  // mid-grey (#101418 -> rgb(16, 20, 24)).
  const bg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  const channels = bg.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  expect(channels.length).toBeGreaterThanOrEqual(3);
  for (const channel of channels.slice(0, 3)) {
    expect(channel).toBeLessThan(64);
  }
  expect(await page.locator("#composer-send")).toBeVisible();
});

test("375px: no overflow and send target >=44px on the new UI", async ({
  page,
}) => {
  await noHorizontalOverflow(page);
  const send = page.locator("#composer-send");
  await expect(send).toBeVisible();
  const box = await send.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
