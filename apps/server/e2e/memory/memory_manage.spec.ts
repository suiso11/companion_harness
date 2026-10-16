// Real-browser memory-management E2E over the production UI/server/core.
//
// No API mocks: every flow drives the REAL memory panel UI
// (#memory-search-input, #memory-list, #memory-detail, correct/retire/
// reactivate buttons, #memory-op-status) against the REAL Hono app +
// RunEngine + REAL remind CLI temp DB (e2e/memory/server.ts). The
// synthetic scripted gateway cultivates one "green tea" fact (never a
// real model). Fixture control uses the loopback-only control server via
// the Node-side `request` fixture (never page.fetch, never mocked
// responses).

import { expect, type Page, test } from "@playwright/test";
import {
  MEMORY_CONTROL_ORIGIN,
  MEMORY_CORRECTED_BODY,
  MEMORY_TURN_TEXT,
} from "./ports.js";

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/reset",
): Promise<void> {
  const res = await request.post(`${MEMORY_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

function isMemorySearchResponse(url: string, method: string): boolean {
  return url.includes("/memory/search") && method === "POST";
}

/**
 * Drive the REAL memory search form and wait for the NEW completed search
 * request/state (never the stale pre-click list count): every attempt
 * awaits its own POST /memory/search response, then binds the rendered
 * DOM to that response via #memory-op-status[data-search-id]. Returns the
 * fresh searchId. Retries while cultivation is still draining.
 */
async function searchFresh(
  page: Page,
  query: string,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  let lastError: unknown = null;
  for (;;) {
    const responsePromise = page.waitForResponse(
      (response) =>
        isMemorySearchResponse(response.url(), response.request().method()),
      { timeout: 15_000 },
    );
    await page.locator("#memory-search-input").fill(query);
    await page.locator("#memory-search-button").click();
    try {
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        searchId?: unknown;
        hits?: unknown;
      };
      expect(typeof body.searchId).toBe("string");
      const searchId = body.searchId as string;
      // The authoritative fresh response must be applied to the DOM: the
      // list carries the NEW search's hits and the status node carries
      // the NEW searchId (an old out-of-order response cannot satisfy
      // this binding).
      await expect(page.locator("#memory-search-button")).toBeEnabled({
        timeout: 10_000,
      });
      await expect(page.locator("#memory-list li")).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect(page.locator("#memory-op-status")).toHaveAttribute(
        "data-search-id",
        searchId,
        { timeout: 10_000 },
      );
      return searchId;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for fresh memory search hit: ${query} (${String(lastError)})`,
      );
    }
    await page.waitForTimeout(1_000);
  }
}

/** Select the first hit and wait for its authoritative detail response. */
async function selectFirstHit(page: Page): Promise<void> {
  const firstHit = page.locator("#memory-list li").first();
  const detailPromise = page.waitForResponse(
    (response) =>
      response.url().includes("/memory/searches/") &&
      response.request().method() === "GET",
    { timeout: 15_000 },
  );
  await firstHit.locator("button").click();
  const detail = await detailPromise;
  expect(detail.status()).toBe(200);
  await expect(page.locator("#memory-detail")).toBeVisible();
}

/**
 * Click a mutation button and wait for the NEW operation ack (never old
 * text): awaits the POST /memory/mutations response, asserts a NEW
 * operationId distinct from the prior operation, then waits for
 * `acked` bound to that NEW operation identity via
 * #memory-op-status[data-operation]. Status assertions stay exact.
 */
async function mutateAndAwaitNewAck(
  page: Page,
  button:
    | "#memory-correct-button"
    | "#memory-retire-button"
    | "#memory-reactivate-button",
  priorOperationId: string | null,
): Promise<string> {
  const status = page.locator("#memory-op-status");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/memory/mutations") &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  await page.locator(button).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const body = (await response.json()) as {
    operationId?: unknown;
    status?: unknown;
  };
  expect(typeof body.operationId).toBe("string");
  const operationId = body.operationId as string;
  if (priorOperationId !== null) {
    // Repeated-operation regression: each lifecycle step must stage a NEW
    // operation; the previous ack text alone never satisfies this step.
    expect(operationId).not.toBe(priorOperationId);
  }
  await expect(status).toContainText("acked", { timeout: 45_000 });
  await expect(status).toHaveAttribute("data-operation", operationId, {
    timeout: 15_000,
  });
  return operationId;
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#memory-search-form")).toBeVisible();
});

test("memory panel search/detail/correct/retire/reactivate lifecycle", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await send(page, MEMORY_TURN_TEXT);
  await expect(page.locator("#conversation")).toContainText(
    "Noted green tea.",
    {
      timeout: 30_000,
    },
  );
  await expect(page.locator("#composer-send")).toBeEnabled();

  // Explicit search over the REAL UI: opaque mN handle, live record.
  const searchId1 = await searchFresh(page, "green tea", 90_000);
  expect(searchId1.length).toBeGreaterThan(0);
  const firstHit = page.locator("#memory-list li").first();
  await expect(firstHit).toContainText(/m1 \[active\]/);

  // Confirmation detail: immutable snapshot vs live current provenance.
  await selectFirstHit(page);
  const detailBody = page.locator("#memory-detail-body");
  await expect(detailBody).toContainText("green tea");
  await expect(detailBody).toContainText("companion");

  // Correct through the REAL UI: queued then acked (bounded UI poll).
  await page.locator("#memory-correct-input").fill(MEMORY_CORRECTED_BODY);
  const opCorrect = await mutateAndAwaitNewAck(
    page,
    "#memory-correct-button",
    null,
  );

  // Stale-search regression: the cited snapshot is now stale and the prior
  // selection must NOT stay actionable. The new search invalidates the old
  // result synchronously, completes a NEW request, and binds fresh state.
  const searchId2 = await searchFresh(page, "green tea", 45_000);
  expect(searchId2).not.toBe(searchId1);
  // While no fresh detail is selected, mutation actions stay disabled: the
  // While no fresh detail is selected, mutation actions stay disabled: the
  // old selected target cannot be re-operated after the new search.
  await expect(page.locator("#memory-correct-button")).toBeDisabled();
  await expect(page.locator("#memory-retire-button")).toBeDisabled();
  const liveHit = page.locator("#memory-list li").first();
  await expect(liveHit).toContainText("[active]");
  await selectFirstHit(page);
  await expect(page.locator("#memory-detail")).toBeVisible();
  // Fresh detail re-enables the actions for the NEW target only.
  await expect(page.locator("#memory-retire-button")).toBeEnabled();
  const opRetire = await mutateAndAwaitNewAck(
    page,
    "#memory-retire-button",
    opCorrect,
  );

  // Fresh search still returns the handle, now with retired status.
  const searchId3 = await searchFresh(page, "green tea", 45_000);
  expect(searchId3).not.toBe(searchId2);
  const retiredHit = page.locator("#memory-list li").first();
  await expect(retiredHit).toContainText("[retired]");

  // Reactivate through the REAL UI and confirm active again.
  await retiredHit.locator("button").click();
  await expect(page.locator("#memory-detail")).toBeVisible();
  const opReactivate = await mutateAndAwaitNewAck(
    page,
    "#memory-reactivate-button",
    opRetire,
  );
  expect(opReactivate).not.toBe(opCorrect);
  const searchId4 = await searchFresh(page, "green tea", 45_000);
  expect(searchId4).not.toBe(searchId3);
  await expect(page.locator("#memory-list li").first()).toContainText(
    "[active]",
  );
});

test("memory correction draft binds to the exact target (F6) and pending stays pending (F4)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await send(page, MEMORY_TURN_TEXT);
  await expect(page.locator("#conversation")).toContainText(
    "Noted green tea.",
    {
      timeout: 30_000,
    },
  );
  await expect(page.locator("#composer-send")).toBeEnabled();

  await searchFresh(page, "green tea", 90_000);
  await selectFirstHit(page);
  await expect(page.locator("#memory-detail")).toBeVisible();
  // Type a draft for the current target, then start a new search: the draft
  // must clear synchronously so it can never apply to the next target.
  await page.locator("#memory-correct-input").fill("draft-for-first-target");
  await expect(page.locator("#memory-correct-input")).toHaveValue(
    "draft-for-first-target",
  );
  await searchFresh(page, "green tea", 45_000);
  await expect(page.locator("#memory-correct-input")).toHaveValue("");
  // A bare search result is never directly actionable (stale target guard).
  await expect(page.locator("#memory-correct-button")).toBeDisabled();
  await selectFirstHit(page);
  // Fresh detail for the new target starts with an empty draft.
  await expect(page.locator("#memory-correct-input")).toHaveValue("");

  // Stage a correction through the REAL UI: the operation reports queued or
  // acked, and a still-pending operation stays visibly pending (never failed
  // at the poll bound with a failure retry).
  await page.locator("#memory-correct-input").fill(MEMORY_CORRECTED_BODY);
  const status = page.locator("#memory-op-status");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/memory/mutations") &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  await page.locator("#memory-correct-button").click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const body = (await response.json()) as {
    operationId?: unknown;
    status?: unknown;
  };
  expect(typeof body.operationId).toBe("string");
  await expect(status).toContainText(/queued|acked/, { timeout: 15_000 });
  const statusText = await status.textContent();
  // Terminal-failure copy is never shown for a staged (non-failed) op.
  expect(statusText).not.toContain("再検索してください");
});
