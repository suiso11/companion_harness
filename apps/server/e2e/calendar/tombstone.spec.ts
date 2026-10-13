// C15 POSITIVE authoritative tombstone browser scenario.
//
// Runs against App C (port 4185): a REAL server booted through the EXISTING
// C12 `calendarBinding` seam in its own throwaway DB with its own registered
// `calendar` instance, a REAL production Calendar adapter over a REAL
// `McpConnector` on the official inert SDK transport, the real agent/broker/
// ReferenceManager/UI, and the REAL scripted fake MCP upstream.
//
// The ONLY synthetic element is the deletion itself, and it is EXPLICIT and
// host-trusted: the loopback control seam arms the fixture's DEDICATED
// authoritative synthetic get mode, whose SEPARATE real wire
// `get-event-authoritative` operation returns positive deleted evidence that
// the fixture wrapper (never the production normalizer) turns into a
// `deleted` observation. Nothing here seeds the DB, presents a reference by
// hand, or bypasses the UI: r1 is delivered + selected through the real
// drawer, and the tombstone rN is materialized by the real refresh path.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  ANSWER_SEARCH_TEXT,
  ANSWER_TOMBSTONE_TEXT,
  CALENDAR_CONTROL_ORIGIN,
  CALENDAR_TOMBSTONE_APP_ORIGIN,
  EVENT_START_RENDERED,
  EVENT_TITLE_V1,
  TEXT_DELETE,
  TEXT_SEARCH,
} from "./ports.js";

async function control(
  request: APIRequestContext,
  path: "/reset-tombstone" | "/authoritative-delete",
): Promise<Record<string, unknown>> {
  const res = await request.post(`${CALENDAR_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function status(
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const res = await request.get(`${CALENDAR_CONTROL_ORIGIN}/status`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

/** REAL selection: opening the citation is what freezes r1 for the next turn. */
async function selectCitation(page: Page, label: string): Promise<void> {
  await page
    .locator("#conversation button", { hasText: label })
    .first()
    .click();
  await expect(page.locator("#drawer")).toBeVisible();
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset-tombstone");
  await page.goto(`${CALENDAR_TOMBSTONE_APP_ORIGIN}/`);
  await expect(page.locator("#composer")).toBeVisible();
});

test("tombstone: positive authoritative deletion materializes a new deleted rN while the prior rN stays open", async ({
  page,
  request,
}) => {
  // Turn 1: the real pipeline delivers r1 (rN 1) from the fake upstream.
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 30_000 },
  );
  await expect(
    page.locator("#conversation button", { hasText: "r1" }),
  ).toHaveCount(1);
  await selectCitation(page, "r1");
  const before = await status(request);
  expect(before.authoritativeDeleted).toBe(false);

  // Explicit HOST-TRUSTED authoritative synthetic deletion (fixture gate
  // only; the bare404 `/delete-event` miss stays the uncertain case).
  const armed = await control(request, "/authoritative-delete");
  expect(armed.authoritativeDeleted).toBe(true);

  // Turn 2: stored open + reference.refresh over the REAL adapter/broker.
  await send(page, TEXT_DELETE);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_TOMBSTONE_TEXT,
    { timeout: 30_000 },
  );
  // The positive authoritative read materialized a NEW rN (r2), unlike the
  // bare404 case which retains the prior rN and fabricates nothing.
  await expect(
    page.locator("#conversation button", { hasText: "r2" }),
  ).toHaveCount(1);

  // REAL UI tombstone: the new snapshot body carries status "deleted".
  await page.locator("#conversation button", { hasText: "r2" }).click();
  await expect(page.locator("#drawer")).toBeVisible();
  const deletedBody = (await page.locator("#drawer-body").textContent()) ?? "";
  expect(deletedBody).toContain('"status":"deleted"');
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });

  // History retention: the stored prior r1 remains OPEN and non-deleted.
  await page.locator("#conversation button", { hasText: "r1" }).first().click();
  await expect(page.locator("#drawer")).toBeVisible();
  const priorBody = (await page.locator("#drawer-body").textContent()) ?? "";
  expect(priorBody).toContain('"status":"confirmed"');
  expect(priorBody).toContain(EVENT_TITLE_V1);
  expect(priorBody).toContain(EVENT_START_RENDERED);

  // Real wire evidence: exactly one get on the tombstone app, reached only
  // after the gate was armed (the ordinary get is untouched otherwise).
  const after = await status(request);
  expect(after.authoritativeDeleted).toBe(true);
  expect(after.tombstoneGetCalls).toBe(1);
});
