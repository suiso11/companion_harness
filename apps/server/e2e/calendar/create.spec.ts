// M6 REAL browser calendar.create acceptance.
//
// Drives the REAL UI, the REAL approval control and the REAL server APIs on
// the dedicated Calendar fake harness (e2e/calendar/server.ts): the owned
// Calendar composition talks to the scripted fake MCP server over the
// official SDK inert transport, the REAL agent stages the proposal-only
// `calendar.create` under the scripted fake model, the ONLY external insert
// is the trusted fake create port performing a REAL loopback HTTP POST
// against the hermetic Google-shaped fixture (the event actually
// materializes there), and the authoritative read-back is a REAL loopback
// HTTP GET served through the readonly fake MCP `get-event`. No live
// provider, no OAuth, no model approval, no bypass of any UI control, no
// direct DB proposal, no forged receipt.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  ANSWER_CREATE_TEXT,
  CALENDAR_APP_ORIGIN,
  CALENDAR_CONTROL_ORIGIN,
  CALENDAR_ID,
  CREATE_END,
  CREATE_START,
  CREATE_TITLE,
  TEXT_CREATE,
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

async function status(
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const res = await request.get(`${CALENDAR_CONTROL_ORIGIN}/status`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function createPostCount(request: APIRequestContext): Promise<number> {
  const value = (await status(request)).createPostCount;
  expect(typeof value).toBe("number");
  return value as number;
}

/** The REAL session this page owns (created by the real UI, not the test). */
async function sessionIdOf(page: Page): Promise<string> {
  const sessionId = await page.evaluate(
    () => window.localStorage.getItem("ch.sessionId") ?? "",
  );
  expect(sessionId).not.toBe("");
  return sessionId;
}

/** The ACTUAL execution + receipt read for this session's one proposal. */
async function executionView(
  page: Page,
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const sessionId = await sessionIdOf(page);
  const list = await request.get(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/proposals`,
  );
  expect(list.ok()).toBe(true);
  const proposals = (await list.json()) as {
    proposals?: { proposalId?: string }[];
  };
  const proposalId = (proposals.proposals ?? [])[0]?.proposalId ?? "";
  expect(proposalId).not.toBe("");
  const execution = await request.get(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/proposals/${proposalId}/execution`,
  );
  expect(execution.ok()).toBe(true);
  return (await execution.json()) as Record<string, unknown>;
}

/** The REAL staged proposal meta (id/hash/server deadline) for this page. */
async function realProposalMeta(
  page: Page,
  request: APIRequestContext,
): Promise<{ proposalId: string; hash: string; expiresAt: number }> {
  const sessionId = await sessionIdOf(page);
  const list = await request.get(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/proposals`,
  );
  expect(list.ok()).toBe(true);
  const body = (await list.json()) as {
    proposals?: {
      proposalId?: unknown;
      hash?: unknown;
      expiresAt?: unknown;
    }[];
  };
  expect(body.proposals).toHaveLength(1);
  const item = body.proposals?.[0];
  expect(typeof item?.proposalId).toBe("string");
  expect(typeof item?.hash).toBe("string");
  expect(typeof item?.expiresAt).toBe("number");
  return {
    proposalId: item?.proposalId as string,
    hash: item?.hash as string,
    expiresAt: item?.expiresAt as number,
  };
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

/** REAL user selection: opening the delivered citation adds rN to the session. */
async function selectCitation(page: Page, label: string): Promise<void> {
  await page
    .locator("#conversation button", { hasText: label })
    .first()
    .click();
  await expect(page.locator("#drawer")).toBeVisible();
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
}

/** Joined localStorage values (technical ids/keys allowed, no event text). */
async function localStorageText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const parts: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) ?? "";
      parts.push(window.localStorage.getItem(key) ?? "");
    }
    return parts.join("\n");
  });
}

/**
 * Real single-turn create flow: the composer sends the actual creation
 * prompt, the REAL agent proposes targetless `calendar.create` through the
 * normal agent pipeline (proposal-only, never a model approval), and the
 * REAL UI renders the pending creation card.
 */
async function stageCreate(page: Page): Promise<void> {
  await send(page, TEXT_CREATE);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_CREATE_TEXT,
    { timeout: 30_000 },
  );
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-action-state", /pending/);
  await expect(card).toHaveAttribute("data-action-tool", "calendar.create");
  await expect(page.locator("#action-approve")).toBeVisible();
  await expect(page.locator("#action-reject")).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("approve: stage-only 0 POST -> hash-bound approve 202 -> 1 LOCAL POST -> verified receipt + drawer + 0 extra on duplicate", async ({
  page,
  request,
}) => {
  await stageCreate(page);
  const card = page.locator('[data-action-card="true"]');
  // Targetless creation card: exact title/calendar/start/end/expiry, no old
  // rN, no prepopulated fake event.
  await expect(card).toContainText("予定作成の確認");
  await expect(card.locator("[data-action-preview='true']")).toContainText(
    "作成予定",
  );
  await expect(card.locator("[data-action-preview='true']")).toContainText(
    CREATE_TITLE,
  );
  // The markup-significant title survives VERBATIM through the reused UI
  // (rendered via textContent, never parsed as HTML).
  await expect(card.locator("[data-action-title='true']")).toHaveText(
    `件名: ${CREATE_TITLE}`,
  );
  await expect(card.locator("[data-action-start='true']")).toContainText(
    CREATE_START,
  );
  await expect(card.locator("[data-action-end='true']")).toContainText(
    CREATE_END,
  );
  await expect(card.locator("[data-action-deadline='true']")).toBeVisible();
  // Stage-only: nothing was inserted yet, no source event prepopulated, no
  // citation claimed before the human approval.
  expect(await createPostCount(request)).toBe(0);
  const before = await status(request);
  expect(before.createdEventIds).toEqual([]);
  await expect(
    page.locator("#conversation [data-action-citation='true']"),
  ).toHaveCount(0);
  const meta = await realProposalMeta(page, request);
  expect(meta.expiresAt).toBeGreaterThan(Date.now());
  // The REAL approval: capture the actual network request — hash-bound body
  // on the REAL session route (never a model-side approval).
  const approveRequest = page.waitForRequest(
    (req) => req.url().includes("/approve") && req.method() === "POST",
  );
  const approved = page.waitForResponse(
    (res) =>
      res.url().includes("/approve") && res.request().method() === "POST",
  );
  await page.locator("#action-approve").click();
  expect((await approved).status()).toBe(202);
  const networkApprove = await approveRequest;
  const sessionId = await sessionIdOf(page);
  expect(networkApprove.url()).toContain(
    `/api/sessions/${sessionId}/proposals/${meta.proposalId}/approve`,
  );
  expect(networkApprove.postDataJSON()).toEqual({
    proposalHash: meta.hash,
  });
  // The real scheduler runs the insert: exactly ONE LOCAL POST and the real
  // verified receipt with a NEW rN (the session's first reference: the
  // freshly materialized creation, never a staged source). The card outcome
  // line carries the fixed Japanese verified text (same reused renderer as
  // the reschedule receipt); the structured receipt outcome below proves
  // `succeeded`.
  await expect(card).toContainText("日程を更新しました", {
    timeout: 60_000,
  });
  await expect(card).toHaveAttribute("data-action-state", "succeeded", {
    timeout: 30_000,
  });
  expect(await createPostCount(request)).toBe(1);
  const citations = page.locator("#conversation [data-action-citation='true']");
  await expect(citations.first()).toBeVisible({ timeout: 30_000 });
  await expect(citations).toHaveCount(1);
  const receiptCitation = await citations.first().textContent();
  expect(receiptCitation).toMatch(/^r\d+$/);
  // LOCAL fixture POST header/body proof: same calendar/account, stable
  // 32-hex insert id, exact immutable fields, exact-only body shape.
  const after = await status(request);
  expect(after.createPostCount).toBe(1);
  expect(after.createdEventIds).toHaveLength(1);
  const stored = (
    (after.createdEvents ?? []) as {
      id?: unknown;
      summary?: unknown;
      start?: unknown;
      end?: unknown;
      calendarId?: unknown;
    }[]
  )[0];
  expect(stored?.calendarId).toBe(CALENDAR_ID);
  expect(stored?.summary).toBe(CREATE_TITLE);
  expect(stored?.start).toBe(CREATE_START);
  expect(stored?.end).toBe(CREATE_END);
  expect(typeof stored?.id).toBe("string");
  expect(stored?.id as string).toMatch(/^[0-9a-f]{32}$/);
  const recorded = (
    (after.createRequests ?? []) as {
      contentType?: unknown;
      account?: unknown;
      calendarId?: unknown;
      body?: unknown;
    }[]
  )[0];
  expect(recorded?.contentType).toContain("application/json");
  expect(recorded?.account).toBeNull();
  expect(recorded?.calendarId).toBe(CALENDAR_ID);
  const recordedBody = recorded?.body as Record<string, unknown>;
  expect(Object.keys(recordedBody).sort()).toEqual([
    "end",
    "id",
    "start",
    "summary",
  ]);
  expect(recordedBody.id).toBe(stored?.id);
  expect(recordedBody.summary).toBe(CREATE_TITLE);
  expect(recordedBody).not.toHaveProperty("description");
  expect(recordedBody).not.toHaveProperty("attendees");
  expect(recordedBody).not.toHaveProperty("recurrence");
  // The readonly GET returns the newly created event (title + time), and the
  // drawer shows the actual new title/bounds from that read-back.
  expect(after.createGetCount as number).toBeGreaterThanOrEqual(1);
  const receiptLabel = (await citations.first().textContent()) ?? "";
  await selectCitation(page, receiptLabel);
  await page
    .locator("#conversation button", { hasText: receiptLabel })
    .first()
    .click();
  await expect(page.locator("#drawer")).toBeVisible();
  await expect(page.locator("#drawer")).toContainText(CREATE_TITLE);
  await expect(page.locator("#drawer")).toContainText("2026-11-04");
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
  // localStorage carries NO title/event text/proposal content (technical
  // ids/keys only).
  const stored_text = await localStorageText(page);
  expect(stored_text).not.toContain(CREATE_TITLE);
  expect(stored_text).not.toContain("Q3 planning");
  expect(stored_text).not.toContain("作成予定");
  // Duplicate approve of the SAME known hash after the terminal: the grant
  // is consumed, so no second insert is possible — zero extra POSTs, one
  // receipt, one record.
  const duplicate = await request.post(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/proposals/${meta.proposalId}/approve`,
    { data: { proposalHash: meta.hash } },
  );
  expect([200, 400, 404, 409]).toContain(duplicate.status());
  expect(await createPostCount(request)).toBe(1);
  const done = await executionView(page, request);
  expect((done.receipt as { outcome?: unknown } | null)?.outcome).toBe(
    "succeeded",
  );
  await expect(
    page.locator("#conversation [data-action-receipt='true']"),
  ).toHaveCount(1);
  await page.waitForTimeout(2_000);
  expect(await createPostCount(request)).toBe(1);
});

test("loss-after-POST: write applied before response closed -> unknown terminal, no resolve, no resend, no stop", async ({
  page,
  request,
}) => {
  await stageCreate(page);
  // Armed AFTER staging so the arm is in force for exactly the approval's
  // insert (the staging turn itself never inserts).
  await control(request, "/arm-create", { mode: "loss" });
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute("data-action-state", "unknown", {
    timeout: 60_000,
  });
  const view = await executionView(page, request);
  expect(view.status).toBe("unknown");
  expect((view.receipt as { outcome?: unknown } | null)?.outcome).toBe(
    "unknown",
  );
  // The write WAS applied before the response was lost (one POST, one
  // stored event), but the outcome stays honestly unknown.
  expect(await createPostCount(request)).toBe(1);
  const applied = await status(request);
  expect((applied.createdEventIds as unknown[]).length).toBe(1);
  // GET does not auto-resolve and a direct read does not upgrade the
  // terminal: still unknown, still no verified citation.
  await page.waitForTimeout(2_000);
  const reread = await executionView(page, request);
  expect(reread.status).toBe("unknown");
  expect((reread.receipt as { outcome?: unknown } | null)?.outcome).toBe(
    "unknown",
  );
  await expect(page.locator("[data-action-citation='true']")).toHaveCount(0);
  expect(await createPostCount(request)).toBe(1);
  // Reload: the terminal survives via the history projection with the
  // manual-check outcome; the user cannot press Stop post-marker (no stop
  // control exists after the committed marker).
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  await expect(history).toContainText("承認", { timeout: 30_000 });
  await expect(page.locator("[data-action-stop='true']")).toHaveCount(0);
  const sessionId = await sessionIdOf(page);
  const terminal = await executionView(page, request);
  expect(terminal.markerCommitted).toBe(true);
  expect(terminal.cancellable).toBe(false);
  expect(typeof terminal.runId).toBe("string");
  const cancel = await request.post(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/runs/${terminal.runId as string}/cancel`,
    { data: {} },
  );
  // Terminal run: the late cancel lands as HTTP 200 with the ACTUAL terminal
  // status — never a stop claim, never a success rewrite (same rule as the
  // reschedule late-cancel race).
  expect(cancel.status()).toBe(200);
  const cancelBody = (await cancel.json()) as {
    run?: { status?: unknown };
  };
  const terminalStatus = cancelBody.run?.status;
  expect(["completed", "failed", "abandoned"]).toContain(terminalStatus);
  expect(terminalStatus).not.toBe("cancelled");
  await expect(page.locator("#composer-notice")).not.toContainText(
    "停止しました",
  );
  // A replayed approve cannot POST again: same known hash, zero extra
  // POSTs, receipt stays the single unknown record.
  const meta = await realProposalMeta(page, request);
  const replayed = await request.post(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/proposals/${meta.proposalId}/approve`,
    { data: { proposalHash: meta.hash } },
  );
  expect([200, 400, 404, 409]).toContain(replayed.status());
  await page.waitForTimeout(2_000);
  expect(await createPostCount(request)).toBe(1);
  const kept = await executionView(page, request);
  expect((kept.receipt as { outcome?: unknown } | null)?.outcome).toBe(
    "unknown",
  );
});

test("wrong read-back: succeeded insert with drifted title -> succeeded_unverified, never verified", async ({
  page,
  request,
}) => {
  await stageCreate(page);
  // Armed AFTER staging: the insert stores the exact title, but the
  // authoritative GET observes a drifted one.
  await control(request, "/arm-create", { mode: "wrong-title" });
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute(
    "data-action-state",
    "succeeded_unverified",
    { timeout: 60_000 },
  );
  const view = await executionView(page, request);
  expect(view.status).toBe("succeeded_unverified");
  expect((view.receipt as { outcome?: unknown } | null)?.outcome).toBe(
    "succeeded_unverified",
  );
  expect(await createPostCount(request)).toBe(1);
  // Succeeded insert, but NO verified claim: zero verified citations
  // (Google-source citation count stays 0).
  await expect(page.locator("[data-action-citation='true']")).toHaveCount(0);
  await page.waitForTimeout(2_000);
  expect(await createPostCount(request)).toBe(1);
});
