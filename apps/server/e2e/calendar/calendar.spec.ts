// C15 dedicated Calendar fake E2E browser spec.
//
// Drives the REAL UI over the REAL server on the dedicated Calendar
// harness (e2e/calendar/server.ts): the real C14 owned Calendar MCP
// connector talks to the scripted fake MCP server over the official SDK
// inert transport, the real agent strategy/broker runs under the scripted
// fake model, and every UI interaction goes through the real HTTP app.
// The only synthetic step is the authoritative DELETION, which happens in
// the fake upstream fixture via the loopback control seam (Node-side) —
// no production normalizer/tombstone path is touched.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  ANSWER_REFRESH_TEXT,
  ANSWER_SEARCH_TEXT,
  ANSWER_TOMBSTONE_TEXT,
  CALENDAR_CONTROL_ORIGIN,
  EVENT_START_RENDERED,
  EVENT_TITLE_V1,
  EVENT_TITLE_V2,
  TEXT_DELETE,
  TEXT_REFRESH,
  TEXT_SEARCH,
} from "./ports.js";

async function control(
  request: APIRequestContext,
  path: "/reset" | "/advance-title" | "/delete-event",
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

/**
 * REAL user selection step: opening a citation is what adds the reference to
 * the session reference context (§14.8 CAS PUT over the real HTTP app), and
 * the next turn freezes that context as its rN addressability source. A
 * follow-up turn can only address an rN the user actually selected, so any
 * scenario that re-addresses a delivered rN in a LATER turn must perform this
 * step through the real drawer — never by faking the selection server-side.
 */
async function selectCitation(page: Page, label: string): Promise<void> {
  await page
    .locator("#conversation button", { hasText: label })
    .first()
    .click();
  await expect(page.locator("#drawer")).toBeVisible();
  // Backdrop click closes the drawer (the drawer element itself is the
  // click target in its padding, outside #drawer-body).
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("conversation: real agent searches the calendar, delivers one rN and opens it", async ({
  page,
  request,
}) => {
  await send(page, TEXT_SEARCH);
  // The scripted model's real-pipeline answer (agent -> broker ->
  // connector -> fake MCP -> snapshot/rN -> agent answer).
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 30_000 },
  );
  // The user bubble and the composer released again.
  await expect(page.locator("#conversation")).toContainText(TEXT_SEARCH);
  await expect(page.locator("#composer-send")).toBeEnabled();
  // Exactly one delivered reference: citation r1 (fake upstream has one
  // event, so the first session reference has ordinal 1).
  const citation = page.locator("#conversation button", { hasText: "r1" });
  await expect(citation).toHaveCount(1);
  // REAL stored-open flow: drawer over /references + reference-context.
  await citation.click();
  await expect(page.locator("#drawer")).toBeVisible();
  const drawerBody = page.locator("#drawer-body");
  const body = (await drawerBody.textContent()) ?? "";
  expect(body).toContain(EVENT_TITLE_V1);
  expect(body).toContain(EVENT_START_RENDERED);
  // The REAL wire pipeline ran: one search call through the real connector.
  const after = await status(request);
  expect(after.searchCalls).toBe(1);
  expect(after.getCalls).toBe(0);
});

test("rN survives history reload (stored reference context)", async ({
  page,
}) => {
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 30_000 },
  );
  // Reload: history hydration renders the completed selected run + r1.
  await page.reload();
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 15_000 },
  );
  await expect(
    page.locator("#conversation button", { hasText: "r1" }),
  ).toHaveCount(1);
});

test("refresh: real reference.refresh rematerializes a NEW rN over V1->V2", async ({
  page,
  request,
}) => {
  // Seed the conversation + r1, then mutate the FAKE upstream revision.
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 30_000 },
  );
  await expect(
    page.locator("#conversation button", { hasText: "r1" }),
  ).toHaveCount(1);
  // REAL selection: the user opens r1, so the next turn's frozen reference
  // context can address r1 (reference.refresh r1 is otherwise rejected as
  // invalid_input, exactly as for any unselected rN).
  await selectCitation(page, "r1");
  await control(request, "/advance-title");
  await send(page, TEXT_REFRESH);
  // The refresh answer cites the newly materialized rN (r2).
  await expect(page.locator("#conversation")).toContainText(
    `${ANSWER_REFRESH_TEXT}`,
    { timeout: 30_000 },
  );
  await expect(
    page.locator("#conversation button", { hasText: "r2" }),
  ).toHaveCount(1);
  // Open r2: stored snapshot text reflects the ADVANCED title (V1 -> V2).
  await page.locator("#conversation button", { hasText: "r2" }).click();
  await expect(page.locator("#drawer")).toBeVisible();
  const body = (await page.locator("#drawer-body").textContent()) ?? "";
  expect(body).toContain(EVENT_TITLE_V2);
  // The V2 body no longer carries the V1-terminated title field (V1 is a
  // substring of V2, so assert the end boundary instead).
  expect(body).not.toContain('"E2E Standup",');
  const after = await status(request);
  expect(after.getCalls).toBe(1);
});

test("tombstone: authoritative upstream deletion keeps the stored open, refresh fails", async ({
  page,
  request,
}) => {
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 30_000 },
  );
  // REAL selection: r1 must be in the next turn's frozen context for
  // reference.open / reference.refresh to address it.
  await selectCitation(page, "r1");
  // Synthetic authoritative deletion IN THE FAKE UPSTREAM ONLY.
  await control(request, "/delete-event");
  await send(page, TEXT_DELETE);
  // Real pipeline: reference.open (stored) succeeds, reference.refresh
  // maps the bare upstream miss to a fixed error, and the answer cites the
  // retained stored rN (never a fabricated new reference).
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_TOMBSTONE_TEXT,
    { timeout: 30_000 },
  );
  await expect(
    page.locator("#conversation button", { hasText: "r2" }),
  ).toHaveCount(0);
  // Both turns cite the SAME stored r1 (same-session same-snapshot reuse;
  // the failed refresh never fabricated a new reference).
  await expect(
    page.locator("#conversation button", { hasText: "r1" }),
  ).toHaveCount(2);
  // The stored open still works (retained snapshot; the deletion only
  // killed the UPSTREAM read, never the stored reference).
  // Both turns cite r1, so target the LATEST turn's citation explicitly.
  await page.locator("#conversation button", { hasText: "r1" }).last().click();
  await expect(page.locator("#drawer")).toBeVisible();
  const body = (await page.locator("#drawer-body").textContent()) ?? "";
  expect(body).toContain(EVENT_TITLE_V1);
  const after = await status(request);
  expect(after.deleted).toBe(true);
  // Exactly one real upstream get attempt for the failed refresh.
  expect(after.getCalls).toBe(1);
});
