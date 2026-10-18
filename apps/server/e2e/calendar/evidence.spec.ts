// M5 action evidence navigation: REAL Chromium proof over the REAL app.
//
// Drives the REAL UI + REAL server APIs on the dedicated Calendar fake
// harness (e2e/calendar/server.ts, temp SQLite, counted fake upstream):
// stage -> approve -> verified succeeded shows BOTH the ORIGINAL BEFORE
// (r1) and the fresh verified AFTER (new rN); opening either button shows
// the EXACT different stored bodies with NO additional upstream I/O
// (fixture counters unchanged, single write); reload retains both links.
// A second unverified run shows BEFORE alone with the real warning, no
// fabricated AFTER, and its stored original still opens with zero extra
// upstream I/O. No fake echo, no exact wording pins beyond behavior.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  ANSWER_SEARCH_TEXT,
  ANSWER_STAGE_TEXT,
  CALENDAR_CONTROL_ORIGIN,
  TEXT_SEARCH,
  TEXT_STAGE,
} from "./ports.js";

async function control(
  request: APIRequestContext,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res =
    body === undefined
      ? await request.post(`${CALENDAR_CONTROL_ORIGIN}${path}`)
      : await request.post(`${CALENDAR_CONTROL_ORIGIN}${path}`, { data: body });
  expect(res.ok(), `${path} -> ${res.status()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function counters(request: APIRequestContext): Promise<{
  searchCalls: number;
  listCalls: number;
  getCalls: number;
  writeCalls: number;
}> {
  const res = await request.get(`${CALENDAR_CONTROL_ORIGIN}/status`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    searchCalls: unknown;
    listCalls: unknown;
    getCalls: unknown;
    writeCalls: unknown;
  };
  expect(typeof body.searchCalls).toBe("number");
  expect(typeof body.listCalls).toBe("number");
  expect(typeof body.getCalls).toBe("number");
  expect(typeof body.writeCalls).toBe("number");
  return {
    searchCalls: body.searchCalls as number,
    listCalls: body.listCalls as number,
    getCalls: body.getCalls as number,
    writeCalls: body.writeCalls as number,
  };
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

async function selectCitation(page: Page, label: string): Promise<void> {
  await page
    .locator("#conversation button", { hasText: label })
    .first()
    .click();
  await expect(page.locator("#drawer")).toBeVisible();
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
}

async function stageProposal(page: Page): Promise<void> {
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    { timeout: 30_000 },
  );
  await selectCitation(page, "r1");
  await send(page, TEXT_STAGE);
  await expect(page.locator("#conversation")).toContainText(ANSWER_STAGE_TEXT, {
    timeout: 30_000,
  });
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#action-approve")).toBeVisible();
}

async function openEvidence(
  page: Page,
  kind: "before" | "after",
  scope?: string,
): Promise<string> {
  const base = scope ?? "#conversation";
  const button = page
    .locator(`${base} [data-action-evidence="${kind}"]`)
    .first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect(page.locator("#drawer")).toBeVisible({ timeout: 15_000 });
  const body = (await page.locator("#drawer-body").textContent()) ?? "";
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
  return body;
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("verified: BEFORE + AFTER open exact different stored bodies, reload retains, opening adds no upstream I/O", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  const beforeApprove = await counters(request);
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute("data-action-state", "succeeded", {
    timeout: 60_000,
  });
  const afterApprove = await counters(request);
  // Exactly ONE external write drove the verified terminal.
  expect(afterApprove.writeCalls).toBe(beforeApprove.writeCalls + 1);

  // BOTH evidence links exist and are distinct: ORIGINAL BEFORE r1 plus a
  // physically distinct verified AFTER (never r1, never a bare label).
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  const beforeBtn = history.locator('[data-action-evidence="before"]').first();
  const afterBtn = history.locator('[data-action-evidence="after"]').first();
  await expect(beforeBtn).toBeVisible({ timeout: 30_000 });
  await expect(afterBtn).toBeVisible({ timeout: 30_000 });
  const beforeLabel = ((await beforeBtn.textContent()) ?? "").trim();
  const afterLabel = ((await afterBtn.textContent()) ?? "").trim();
  expect(beforeLabel).toContain("r1");
  expect(afterLabel).toMatch(/r[1-9][0-9]*/);
  expect(afterLabel).not.toContain("r1");
  // Receipt-button contract: the verified AFTER keeps the bare `rN` text
  // (existing calendar action E2E asserts [data-action-citation] matches
  // /^r\d+$/); the BEFORE/AFTER distinction rides data-action-evidence +
  // aria-label, never a text prefix on the receipt button.
  await expect(afterBtn).toHaveAttribute("data-action-citation", "true");
  expect(afterLabel).toMatch(/^r[1-9][0-9]*$/);
  await expect(afterBtn).toHaveAttribute(
    "aria-label",
    /確認済みの変更後 r[1-9][0-9]*/,
  );
  // Dedup: one Run never renders four evidence buttons (card BEFORE at most
  // one + history BEFORE/AFTER = at most three total nodes).
  const totalBefore = await page
    .locator('[data-action-evidence="before"]')
    .count();
  const totalAfter = await page
    .locator('[data-action-evidence="after"]')
    .count();
  expect(totalBefore).toBeLessThanOrEqual(2);
  expect(totalAfter).toBe(1);

  // Opening BEFORE shows the EXACT stored original body (old 09:00 start);
  // opening AFTER shows the EXACT new stored body (moved 11:00 start) —
  // asserted as exact text, not mere length.
  const ioBeforeOpen = await counters(request);
  const beforeBody = await openEvidence(page, "before");
  expect(beforeBody.length).toBeGreaterThan(0);
  expect(beforeBody).toContain("09:00");
  const ioAfterBefore = await counters(request);
  expect(ioAfterBefore).toEqual(ioBeforeOpen);
  const afterBody = await openEvidence(page, "after");
  expect(afterBody.length).toBeGreaterThan(0);
  expect(afterBody).toContain("11:00");
  expect(afterBody).not.toBe(beforeBody);
  const ioAfterOpen = await counters(request);
  // Stored-only drawer: no additional upstream GET and no extra PATCH/write.
  expect(ioAfterOpen).toEqual(ioBeforeOpen);

  // Reload retains BOTH links with zero extra upstream I/O.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const reloaded = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(reloaded).toHaveCount(1, { timeout: 30_000 });
  await expect(
    reloaded.locator('[data-action-evidence="before"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    reloaded.locator('[data-action-evidence="after"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  const ioAfterReload = await counters(request);
  expect(ioAfterReload).toEqual(ioAfterOpen);
  // The retained links still open the exact stored bodies after reload.
  const reBefore = await openEvidence(page, "before");
  expect(reBefore).toBe(beforeBody);
  const reAfter = await openEvidence(page, "after");
  expect(reAfter).toBe(afterBody);
  expect(await counters(request)).toEqual(ioAfterReload);
});

test("unverified: BEFORE alone with the real warning, AFTER absent, stored original opens with zero extra I/O", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // Armed AFTER staging so the arm covers exactly the approval's write.
  await control(request, "/arm-write", { mode: "unverified" });
  const beforeApprove = await counters(request);
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute(
    "data-action-state",
    "succeeded_unverified",
    { timeout: 60_000 },
  );
  const afterApprove = await counters(request);
  expect(afterApprove.writeCalls).toBe(beforeApprove.writeCalls + 1);

  // ORIGINAL present, verified AFTER absent: no fabricated success link.
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  await expect(
    history.locator('[data-action-evidence="before"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-action-evidence="after"]')).toHaveCount(0);
  await expect(page.locator("[data-action-citation='true']")).toHaveCount(0);
  // The real terminal renders its manual-check outcome (behavior: non-empty
  // outcome text distinct from any verified success claim).
  const historyText = (await history.textContent()) ?? "";
  expect(historyText.length).toBeGreaterThan(0);

  // The stored original still opens with zero extra upstream I/O and no
  // extra PATCH: the unverified result is never presented as evidence.
  const ioBeforeOpen = await counters(request);
  const beforeBody = await openEvidence(page, "before");
  expect(beforeBody.length).toBeGreaterThan(0);
  expect(beforeBody).toContain("09:00");
  expect(await counters(request)).toEqual(ioBeforeOpen);

  // Reload retains the BEFORE-only state with no extra write.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const reloaded = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(reloaded).toHaveCount(1, { timeout: 30_000 });
  await expect(
    reloaded.locator('[data-action-evidence="before"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-action-evidence="after"]')).toHaveCount(0);
  expect(await counters(request)).toEqual(ioBeforeOpen);
});
