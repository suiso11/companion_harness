// Slice (c) minimum smartphone layout (design §6): real-browser checks at
// a 375x667 smartphone viewport plus an explicit 360px-width pass, over the
// production UI/server with no API mocks (same deterministic fake
// RunStrategy harness as conversation.spec.ts).
//
// Covers: no page-level horizontal overflow, composer send ≥44px touch
// target, and one basic send turn. The remote login form (served only in
// remote mode, off in this harness) is covered by unit assertions instead:
// remoteAuth.test.ts pins the shared-stylesheet link + script-free markup,
// and the login rules live in the same client.css exercised here.

import { expect, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN, TEXT_OK } from "./ports.js";

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

test("360px width has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await noHorizontalOverflow(page);
});

test("375x667: no overflow, send target >=44px, one send turn works", async ({
  page,
}) => {
  await noHorizontalOverflow(page);
  const send = page.locator("#composer-send");
  await expect(send).toBeVisible();
  const box = await send.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.locator("#composer-input").fill(TEXT_OK);
  await send.click();
  await expect(page.locator("#conversation")).toContainText(TEXT_OK);
  await expect(page.locator("#conversation")).toContainText(`echo:${TEXT_OK}`, {
    timeout: 15_000,
  });
  await expect(page.locator("#composer-send")).toBeEnabled();
  // Transcript stays inside the viewport after content renders.
  await noHorizontalOverflow(page);
});
