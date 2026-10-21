// Slice ③ web search UI acceptance: dedicated「ウェブ検索中…」phase line,
// web citation chips (title + host), and the citation drawer's verified
// external URL link — over the production UI/server/core with the
// deterministic fake RunStrategy (no API mocks).
//
// The fake strategy records real durable `web.search` tool events for
// TEXT_WEB_SEARCH inputs (e2e/server.ts); the web result identity for the
// citation chip/drawer comes from the seeded `web_result_urls` side-table
// row via the real reference-detail route, including its fail-closed
// handling of a stored non-http(s) URL (repository.js + server.ts seed).

import { expect, test } from "@playwright/test";
import {
  CITATION_SNAPSHOT_TEXT,
  E2E_CONTROL_ORIGIN,
  TEXT_CITE,
  TEXT_WEB_SEARCH,
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

async function seedWebCitation(
  request: import("@playwright/test").APIRequestContext,
  sessionId: string,
  url: string | null,
  title?: string,
) {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
    data: { sessionId, url: url ?? undefined, title },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { referenceId: string; ordinal: number };
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

test("web.search tool phase shows the dedicated ウェブ検索中… status line", async ({
  page,
}) => {
  await send(page, TEXT_WEB_SEARCH);
  const status = page.locator("[data-run-status]");
  await expect(status).toContainText("ウェブ検索中…", { timeout: 15_000 });
  // The held fake tool phase ends; the terminal echo lands and the run
  // status line disappears with the composer released.
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_WEB_SEARCH}`, { exact: true }),
  ).toHaveCount(1);
  await expect(status).toHaveCount(0);
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("web citation chip hydrates with the result title and host; drawer URL link launches externally", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);
  expect(typeof sessionId).toBe("string");
  const seed = await seedWebCitation(
    request,
    sessionId as string,
    "https://example.com/alpha/search-result",
    "Example Alpha Page",
  );
  expect(seed.ordinal).toBe(1);

  await send(page, TEXT_CITE);
  const chip = page.locator('[data-citation="r1"]');
  await expect(chip).toBeVisible({ timeout: 15_000 });
  // Hydrated chip text: rN + bounded title + host.
  await expect(chip).toHaveText("r1 Example Alpha Page（example.com）", {
    timeout: 15_000,
  });

  await chip.click();
  const drawer = page.locator("#drawer");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#drawer-body")).toHaveText(
    CITATION_SNAPSHOT_TEXT,
    { timeout: 15_000 },
  );
  const link = page.locator("[data-web-citation-url]");
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  expect(href).toBe("https://example.com/alpha/search-result");
  expect(href?.startsWith("http://") || href?.startsWith("https://")).toBe(
    true,
  );
  const target = await link.getAttribute("target");
  expect(target).toBe("_blank");
  const rel = (await link.getAttribute("rel")) ?? "";
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");
  await expect(link).toHaveText("https://example.com/alpha/search-result");
});

test("a seeded javascript: URL result degrades to no drawer link (fail closed)", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);
  expect(typeof sessionId).toBe("string");
  const seed = await seedWebCitation(
    request,
    sessionId as string,
    "javascript:alert('e2e-xss')",
  );
  expect(seed.ordinal).toBe(1);

  await send(page, TEXT_CITE);
  const chip = page.locator('[data-citation="r1"]');
  await expect(chip).toBeVisible({ timeout: 15_000 });
  // Hydration refuses non-http(s): the chip keeps the plain rN label.
  await expect(chip).toHaveText("r1", { timeout: 15_000 });

  await chip.click();
  const drawer = page.locator("#drawer");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#drawer-body")).toHaveText(
    CITATION_SNAPSHOT_TEXT,
    { timeout: 15_000 },
  );
  // Fail-closed: no web-citation link block is rendered at all, and no
  // anchor anywhere in the drawer carries the stored javascript: URL.
  await expect(page.locator("[data-web-citation-url]")).toHaveCount(0);
  await expect(page.locator("#drawer a[href^='javascript:']")).toHaveCount(0);
  await expect(page.locator("[data-web-citation]")).toHaveCount(0);
  // The snapshot body text is inert plain text; no script element.
  expect(await page.locator("#drawer-body script").count()).toBe(0);
});
