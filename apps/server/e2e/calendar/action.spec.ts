// C22 REAL browser fake-Action SAFETY acceptance.
//
// Drives the REAL UI, the REAL approval/reject/stop controls and the REAL
// server APIs on the dedicated Calendar fake harness (e2e/calendar/server.ts):
// the owned Calendar connector talks to the scripted fake MCP server over the
// official SDK inert transport, the real agent stages the proposal-only
// `calendar.reschedule` under the scripted fake model, and the ONLY external
// write is the injected trusted fake write port — counted, scripted and
// deterministic. No live provider, no OAuth, no model approval, no bypass of
// any UI control.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  ANSWER_ASSENT_TEXT,
  ANSWER_SEARCH_TEXT,
  ANSWER_STAGE_TEXT,
  CALENDAR_APP_ORIGIN,
  CALENDAR_CONTROL_ORIGIN,
  EVENT_TITLE_TOOL_PREFIXED,
  EVENT_TITLE_V1,
  STAGE_END,
  STAGE_START,
  TEXT_ASSENT,
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

async function status(
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const res = await request.get(`${CALENDAR_CONTROL_ORIGIN}/status`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function writeCalls(request: APIRequestContext): Promise<number> {
  const value = (await status(request)).writeCalls;
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

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

/** REAL user selection: opening the delivered citation adds r1 to the session. */
async function selectCitation(page: Page, label: string): Promise<void> {
  await page
    .locator("#conversation button", { hasText: label })
    .first()
    .click();
  await expect(page.locator("#drawer")).toBeVisible();
  await page.locator("#drawer").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#drawer")).toBeHidden();
}

/**
 * Real two-turn flow: search delivers r1, the user selects it through the real
 * drawer, then the NEXT turn stages the reschedule proposal for that r1.
 */
async function stageProposal(page: Page): Promise<void> {
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    {
      timeout: 30_000,
    },
  );
  await selectCitation(page, "r1");
  await send(page, TEXT_STAGE);
  await expect(page.locator("#conversation")).toContainText(ANSWER_STAGE_TEXT, {
    timeout: 30_000,
  });
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-action-state", /pending/);
  await expect(page.locator("#action-approve")).toBeVisible();
  await expect(page.locator("#action-reject")).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("staging search citation is a normal citation, not an action receipt", async ({
  page,
}) => {
  await send(page, TEXT_SEARCH);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_SEARCH_TEXT,
    {
      timeout: 30_000,
    },
  );
  // The normal staging citation renders as a plain conversation button...
  await expect(
    page.locator("#conversation button", { hasText: "r1" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  // ...but claims NO action-receipt marker: only a real verified receipt
  // from an approved action may carry [data-action-citation].
  await expect(
    page.locator("#conversation [data-action-citation='true']"),
  ).toHaveCount(0);
  // The normal citation still opens the drawer (per-run binding intact).
  await selectCitation(page, "r1");
});

test("approve: pending card -> hash-bound approve 202 -> one write + fresh verified receipt", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  const approved = page.waitForResponse(
    (res) =>
      res.url().includes("/approve") && res.request().method() === "POST",
  );
  await page.locator("#action-approve").click();
  expect((await approved).status()).toBe(202);
  // The real scheduler picks the run up automatically: exactly ONE external
  // write and the real verified receipt.
  await expect(page.locator('[data-action-card="true"]')).toContainText(
    "日程を更新しました",
    { timeout: 60_000 },
  );
  expect(await writeCalls(request)).toBe(1);
  // The receipt cites a FRESH reference materialized by the authoritative
  // read-back (a new rN, never the staged r1).
  const citations = page.locator("#conversation [data-action-citation='true']");
  await expect(citations.first()).toBeVisible({ timeout: 30_000 });
  expect(await citations.first().textContent()).not.toBe("r1");
  const receiptCitation = await citations.first().textContent();
  expect(receiptCitation).toMatch(/^r\d+$/);
  // The real upstream now serves the intended boundaries.
  const after = await status(request);
  expect(after.startOverride).toBe(STAGE_START);
  expect(after.endOverride).toBe(STAGE_END);
});

test("reject: hash-bound reject -> durable rejection history, no run, no write", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  const rejected = page.waitForResponse(
    (res) => res.url().includes("/reject") && res.request().method() === "POST",
  );
  await page.locator("#action-reject").click();
  expect((await rejected).status()).toBe(200);
  // The decision is durable and visible as a REJECTION history item: the
  // consumer behaviour the user is left with after rejecting.
  await expect(
    page.locator("#conversation [data-action-history='action_rejection']"),
  ).toHaveCount(1, { timeout: 30_000 });
  // Approval cards exist only for a pending, unexpired proposal, so the
  // rejected card legitimately disappears: no control can be re-used.
  await expect(page.locator('[data-action-card="true"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  // The real execution read proves a rejection never created a Run.
  const view = await executionView(page, request);
  expect(view.proposalStatus).toBe("rejected");
  expect(view.runId ?? null).toBeNull();
  expect(view.status ?? null).toBeNull();
  expect(view.markerCommitted).toBe(false);
  expect(view.receipt ?? null).toBeNull();
  await page.waitForTimeout(2_000);
  expect(await writeCalls(request)).toBe(0);
});

test("natural-language assent approves nothing and writes nothing", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await send(page, TEXT_ASSENT);
  await expect(page.locator("#conversation")).toContainText(
    ANSWER_ASSENT_TEXT,
    { timeout: 30_000 },
  );
  // The pending card is untouched: assent is not approval.
  await expect(page.locator('[data-action-card="true"]')).toHaveAttribute(
    "data-action-state",
    /pending/,
  );
  await expect(page.locator("#action-approve")).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(await writeCalls(request)).toBe(0);
});

test("stale preflight: an advanced upstream blocks the write (0 writes)", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // The upstream changes AFTER the staged snapshot: the authoritative
  // preflight can no longer match the proposal's expected revision.
  await control(request, "/advance-title");
  await page.locator("#action-approve").click();
  await expect(page.locator('[data-action-card="true"]')).toContainText(
    "元の予定に変更があったため、更新しませんでした",
    { timeout: 60_000 },
  );
  expect(await writeCalls(request)).toBe(0);
});

test("deleted upstream: the authoritative read fails closed (failed preflight, 0 writes)", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await control(request, "/delete-event");
  await page.locator("#action-approve").click();
  // The upstream now answers a bare isError miss: per the C11 rule a bare
  // miss can NOT be inferred as a deletion, so the authoritative preflight
  // fails closed (no stale-vs-deleted guess) BEFORE any external write.
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute("data-action-state", "failed", {
    timeout: 60_000,
  });
  const view = await executionView(page, request);
  expect(view.status).toBe("failed");
  expect(view.errorCode).toBe("action_preflight_failed");
  expect(view.markerCommitted).toBe(false);
  expect(view.cancellable).toBe(false);
  expect((view.receipt as { outcome?: string } | null)?.outcome).toBe("failed");
  expect(await writeCalls(request)).toBe(0);
});

test("failed read-back: succeeded_unverified, no result reference", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // Armed AFTER staging so the arm is in force for exactly the write the
  // approval triggers (the staging turn itself never writes).
  await control(request, "/arm-write", { mode: "unverified" });
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute(
    "data-action-state",
    "succeeded_unverified",
    {
      timeout: 60_000,
    },
  );
  const view = await executionView(page, request);
  expect(view.status).toBe("succeeded_unverified");
  expect((view.receipt as { outcome?: string } | null)?.outcome).toBe(
    "succeeded_unverified",
  );
  expect(await writeCalls(request)).toBe(1);
  // No verified fresh citation is ever claimed.
  await expect(page.locator("[data-action-citation='true']")).toHaveCount(0);
});

test("unknown write: manual check, exactly one attempt, no retry", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await control(request, "/arm-write", { mode: "unknown" });
  await page.locator("#action-approve").click();
  await expect(page.locator('[data-action-card="true"]')).toHaveAttribute(
    "data-action-state",
    "unknown",
    { timeout: 60_000 },
  );
  const view = await executionView(page, request);
  expect(view.status).toBe("unknown");
  expect((view.receipt as { outcome?: string } | null)?.outcome).toBe(
    "unknown",
  );
  await page.waitForTimeout(3_000);
  // Exactly one attempt, and the ambiguous outcome is never retried.
  expect(await writeCalls(request)).toBe(1);
  await expect(page.locator("[data-action-citation='true']")).toHaveCount(0);
});

test("Stop before the write marker cancels with 0 writes", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // Armed AFTER staging: the barrier must hold the APPROVAL's authoritative
  // preflight read, not the staging turn's own search.
  await control(request, "/arm-read-barrier");
  await page.locator("#action-approve").click();
  // Real pre-marker window: the authoritative preflight read is held inside
  // the real connector, so the real stop control is offered.
  const stop = page.locator("[data-action-stop='true']");
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await stop.click();
  await control(request, "/release");
  await expect(page.locator('[data-action-card="true"]')).toHaveAttribute(
    "data-action-state",
    "failed",
    { timeout: 60_000 },
  );
  const view = await executionView(page, request);
  expect(view.errorCode).toBe("action_cancelled_before_write");
  expect(view.markerCommitted).toBe(false);
  expect(view.cancellable).toBe(false);
  expect((view.receipt as { outcome?: string } | null)?.outcome).toBe("failed");
  await page.waitForTimeout(2_000);
  expect(await writeCalls(request)).toBe(0);
});

test("Stop after the write marker is disabled (409) and the write completes", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await control(request, "/arm-write", { mode: "barrier" });
  await page.locator("#action-approve").click();
  // The committed external-call marker makes the action non-cancellable:
  // the real UI removes the stop control and the real API refuses (409).
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute("data-action-state", "executing", {
    timeout: 60_000,
  });
  await expect(card).toHaveAttribute("data-action-marker", "committed");
  await expect(page.locator("[data-action-stop='true']")).toBeHidden();
  const view = await executionView(page, request);
  expect(view.runId ?? "").not.toBe("");
  expect(view.markerCommitted).toBe(true);
  expect(view.cancellable).toBe(false);
  const cancel = await request.post(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${await sessionIdOf(page)}/runs/${view.runId}/cancel`,
    { data: {} },
  );
  expect(cancel.status()).toBe(409);
  await control(request, "/release");
  await expect(card).toHaveAttribute("data-action-state", "succeeded", {
    timeout: 60_000,
  });
  const done = await executionView(page, request);
  expect((done.receipt as { outcome?: string } | null)?.outcome).toBe(
    "succeeded",
  );
  expect(await writeCalls(request)).toBe(1);
});

test("reload after unknown terminal keeps receipt manual outcome with no extra write", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await control(request, "/arm-write", { mode: "unknown" });
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute("data-action-state", "unknown", {
    timeout: 60_000,
  });
  expect(await writeCalls(request)).toBe(1);
  // Reload: the terminal receipt must survive via the history projection
  // (no card needed), with the manual-check outcome and no stopped claim.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  await expect(history).toContainText("承認", { timeout: 30_000 });
  await expect(history).not.toContainText("停止しました");
  await expect(page.locator("#composer-notice")).not.toContainText(
    "停止しました",
  );
  await page.waitForTimeout(3_000);
  expect(await writeCalls(request)).toBe(1);
});

test("completed verified history excludes internal IDs but keeps the fresh citation", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toContainText("日程を更新しました", { timeout: 60_000 });
  expect(await writeCalls(request)).toBe(1);
  const view = await executionView(page, request);
  const proposalId = view.proposalId as string;
  const runId = view.runId as string;
  expect(proposalId).not.toBe("");
  expect(runId).not.toBe("");
  // Reload: the verified history must render with no internal IDs or tool
  // name in visible text, while the fresh rN citation survives.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  const text = (await history.textContent()) ?? "";
  expect(text).not.toContain(proposalId);
  expect(text).not.toContain(runId);
  expect(text).not.toContain("calendar.reschedule");
  const citations = page.locator("#conversation [data-action-citation='true']");
  await expect(citations.first()).toBeVisible({ timeout: 30_000 });
  expect(await citations.first().textContent()).not.toBe("r1");
  expect(await citations.first().textContent()).toMatch(/^r\d+$/);
  await page.waitForTimeout(2_000);
  expect(await writeCalls(request)).toBe(1);
});

test("reload during held post-marker write hides every Stop and cancel API 409s", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  await control(request, "/arm-write", { mode: "barrier" });
  await page.locator("#action-approve").click();
  // The write barrier holds the run AFTER the committed external-call
  // marker: the real UI removes the card Stop before the reload.
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toHaveAttribute("data-action-state", "executing", {
    timeout: 60_000,
  });
  await expect(card).toHaveAttribute("data-action-marker", "committed");
  await expect(page.locator("[data-action-stop='true']")).toBeHidden();
  // Reload adopts the still-executing Action run as the generic active run:
  // the composer stays busy (Send disabled) but must offer NO Stop, and no
  // card Stop may exist either.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeDisabled();
  const composerStop = page.locator("#composer-stop");
  await expect(composerStop).toBeHidden();
  await expect(composerStop).toBeDisabled();
  await expect(page.locator("[data-action-stop='true']")).toHaveCount(0);
  // The committed marker refuses cancellation through the real API, and no
  // stop is claimed for the refusal.
  const sessionId = await sessionIdOf(page);
  const view = await executionView(page, request);
  expect(view.markerCommitted).toBe(true);
  expect(view.cancellable).toBe(false);
  expect(typeof view.runId).toBe("string");
  const cancel = await request.post(
    `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/runs/${view.runId as string}/cancel`,
    { data: {} },
  );
  expect(cancel.status()).toBe(409);
  await expect(page.locator("#composer-notice")).not.toContainText(
    "停止しました",
  );
  // The adopted still-executing approval renders its REAL live progress
  // from the history projection (never a fake failure): the visible
  // held-write state the release below must transition out of.
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  await expect(history).toContainText("日程を更新しています", {
    timeout: 30_000,
  });
  // Releasing the held write lets the run verify to a real success.
  await control(request, "/release");
  // VISIBLE terminal without a second reload: the replayed SSE terminal is
  // deduped against the history anchor above (no second answer), yet the
  // single-owner refresh still lands the REAL verified receipt and the
  // fresh rN citation in the visible history (the approved proposal has no
  // card, so no watch drives this update).
  await expect(history).toContainText("日程を更新しました", {
    timeout: 60_000,
  });
  await expect(page.locator("#composer-send")).toBeEnabled();
  const citations = page.locator("#conversation [data-action-citation='true']");
  await expect(citations.first()).toBeVisible({ timeout: 30_000 });
  expect(await citations.first().textContent()).not.toBe("r1");
  expect(await citations.first().textContent()).toMatch(/^r\d+$/);
  // Exactly one history item, one receipt line, one citation: the terminal
  // never duplicates the answer, and the verified text carries no internal
  // IDs or tool name.
  await expect(history).toHaveCount(1);
  await expect(
    page.locator("#conversation [data-action-receipt='true']"),
  ).toHaveCount(1);
  await expect(citations).toHaveCount(1);
  const done = await executionView(page, request);
  expect((done.receipt as { outcome?: string } | null)?.outcome).toBe(
    "succeeded",
  );
  const text = (await history.textContent()) ?? "";
  expect(text).not.toContain(done.proposalId as string);
  expect(text).not.toContain(done.runId as string);
  expect(text).not.toContain("calendar.reschedule");
  await expect(page.locator("#composer-notice")).not.toContainText(
    "停止しました",
  );
  expect(await writeCalls(request)).toBe(1);
});

test("late cancel on a terminal run claims no stop (200 keeps actual receipt)", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // Hold the authoritative preflight read so the card Stop is offered on a
  // stable pre-marker window; the write itself resolves ambiguous.
  await control(request, "/arm-read-barrier");
  await control(request, "/arm-write", { mode: "unknown" });
  await page.locator("#action-approve").click();
  const stop = page.locator("[data-action-stop='true']");
  await expect(stop).toBeVisible({ timeout: 60_000 });
  // Gate the REAL cancel POST (test-side timing only — the click, the
  // request and the server are all real) so the run reaches its terminal
  // BEFORE the cancel is processed: a deterministic late-cancel race.
  let releaseCancel!: () => void;
  const cancelGate = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  try {
    await page.route("**/runs/*/cancel", async (route) => {
      await cancelGate;
      await route.continue();
    });
    const card = page.locator('[data-action-card="true"]');
    await stop.click();
    // The held read now runs to its real terminal while cancel is gated.
    await control(request, "/release");
    await expect(card).toHaveAttribute("data-action-state", "unknown", {
      timeout: 60_000,
    });
    const done = await executionView(page, request);
    expect(done.status).toBe("unknown");
    expect(done.markerCommitted).toBe(true);
    // The late cancel lands on the terminal run: HTTP 200 with the actual
    // terminal run status — never a stop claim, never a success rewrite.
    const cancelWait = page.waitForResponse(
      (res) =>
        res.url().includes("/cancel") && res.request().method() === "POST",
    );
    const refreshed = page.waitForResponse(
      (res) =>
        res.url().includes("/execution") && res.request().method() === "GET",
    );
    releaseCancel();
    const cancelRes = await cancelWait;
    expect(cancelRes.status()).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      run?: { status?: unknown };
    };
    const terminal = cancelBody.run?.status;
    expect(["completed", "failed", "abandoned"]).toContain(terminal);
    expect(terminal).not.toBe("cancelled");
    // The client processed the late 200 by refreshing the actual state...
    await refreshed;
    // ...and claimed no stop: the real ambiguous outcome stands.
    await expect(page.locator("#composer-notice")).not.toContainText(
      "停止しました",
    );
    await expect(card).toHaveAttribute("data-action-state", "unknown");
    const view = await executionView(page, request);
    expect((view.receipt as { outcome?: string } | null)?.outcome).toBe(
      "unknown",
    );
    expect(await writeCalls(request)).toBe(1);
  } finally {
    releaseCancel();
    await page.unroute("**/runs/*/cancel").catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* C22 pending-expiry + decision-race regressions (real clock/proposal)  */
/* ------------------------------------------------------------------ */

/**
 * Fake clock installed BEFORE any page load, so the client's Date.now and
 * setTimeout are controlled from the first script run. The re-goto reuses
 * the same session (same context localStorage), so the staged proposal and
 * its REAL server deadline are unaffected.
 */
async function installClockAndLoad(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
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

test("preview names the frozen event title and session rN, never the tool name", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  const preview = page.locator("[data-action-preview='true']");
  await expect(preview).toContainText(EVENT_TITLE_V1);
  await expect(preview).toContainText("r1");
  // Before→after comparison: the frozen source range and the proposed range
  // are both visible (offsets intact), with explicit before/after labels.
  await expect(preview).toContainText("2026-10-13T09:00:00.000Z");
  await expect(preview).toContainText("2026-10-13T10:00:00.000Z");
  await expect(preview).toContainText(STAGE_START);
  await expect(preview).toContainText(STAGE_END);
  const cardText =
    (await page.locator('[data-action-card="true"]').textContent()) ?? "";
  expect(cardText).not.toContain("calendar.reschedule");
  void request;
});

test("all-day source shows exclusive-end dates and the timed conversion, then approves once", async ({
  page,
  request,
}) => {
  // Test-only all-day source seam (loopback control; production normalizer
  // untouched): the fake upstream serves date-only bounds with an exclusive
  // end. `/reset` (beforeEach) clears it per test.
  await control(request, "/set-all-day", { allDay: true });
  await stageProposal(page);
  const preview = page.locator("[data-action-preview='true']");
  // BEFORE stays date-only with the exclusive end denoted (no invented
  // midnight); AFTER is the proposed timed range with offsets intact, and
  // the kind change (all-day → timed) is visible.
  await expect(preview).toContainText("2026-10-13");
  await expect(preview).toContainText("2026-10-14");
  await expect(preview).toContainText(STAGE_START);
  await expect(preview).toContainText(STAGE_END);
  await expect(preview).toContainText("r1");
  const approved = page.waitForResponse(
    (res) =>
      res.url().includes("/approve") && res.request().method() === "POST",
  );
  await page.locator("#action-approve").click();
  expect((await approved).status()).toBe(202);
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toContainText("日程を更新しました", { timeout: 60_000 });
  expect(await writeCalls(request)).toBe(1);
  // Verified receipt cites a FRESH reference (new rN, never the staged r1).
  const citations = page.locator("#conversation [data-action-citation='true']");
  await expect(citations.first()).toBeVisible({ timeout: 30_000 });
  expect(await citations.first().textContent()).not.toBe("r1");
  expect(await citations.first().textContent()).toMatch(/^r\d+$/);
  const after = await status(request);
  expect(after.startOverride).toBe(STAGE_START);
  expect(after.endOverride).toBe(STAGE_END);
});

test("tool-prefixed title survives card, receipt and reloaded history in full (1 write)", async ({
  page,
  request,
}) => {
  // Test-only upstream title override (loopback control seam; the production
  // normalizer is untouched): the fake upstream serves an event whose title
  // begins with the legacy preview tool prefix. `/reset` (beforeEach) clears
  // it per test like every other fixture field.
  await control(request, "/set-title", { title: EVENT_TITLE_TOOL_PREFIXED });
  await stageProposal(page);
  // The initial card carries the WHOLE title behind the unambiguous marker:
  // the legacy tool-prefix strip must not cut it.
  const preview = page.locator("[data-action-preview='true']");
  await expect(preview).toContainText(EVENT_TITLE_TOOL_PREFIXED);
  // The REAL approve through the real UI: exactly one external write and
  // the verified receipt, with the full title intact on the receipt card.
  const approved = page.waitForResponse(
    (res) =>
      res.url().includes("/approve") && res.request().method() === "POST",
  );
  await page.locator("#action-approve").click();
  expect((await approved).status()).toBe(202);
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toContainText("日程を更新しました", { timeout: 60_000 });
  await expect(card).toContainText(EVENT_TITLE_TOOL_PREFIXED);
  expect(await writeCalls(request)).toBe(1);
  // Durable history + reload: the receipt line keeps the whole title (no
  // legacy-strip cut, no re-verification write).
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const history = page.locator(
    "#conversation [data-action-history='action_approval']",
  );
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  await expect(history).toContainText(EVENT_TITLE_TOOL_PREFIXED, {
    timeout: 30_000,
  });
  await page.waitForTimeout(2_000);
  expect(await writeCalls(request)).toBe(1);
});

test("pending expiry: controls live at deadline-1, card retires at deadline with 0 writes", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  await stageProposal(page);
  const meta = await realProposalMeta(page, request);
  expect(meta.expiresAt).toBeGreaterThan(Date.now());
  // One millisecond before the REAL server deadline the decision controls
  // are still enabled; the one-shot timer has not fired yet.
  await page.clock.pauseAt(meta.expiresAt - 1);
  await expect(page.locator("#action-approve")).toBeEnabled();
  await expect(page.locator("#action-reject")).toBeEnabled();
  // Crossing the deadline fires the bounded one-shot timer: the still-local
  // pending card is retired with no decision and no external write.
  await page.clock.fastForward(1);
  await expect(page.locator('[data-action-card="true"]')).toHaveCount(0);
  expect(await writeCalls(request)).toBe(0);
});

test("clock skew: capped one-shot rearms and retires at the real deadline with 0 writes", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  // Skew the client wall clock 20min behind the server BEFORE the real
  // staged proposal, so the first capped 15min one-shot fires while the
  // REAL server deadline is still in the future.
  await page.clock.setSystemTime(Date.now() - 20 * 60 * 1000);
  await stageProposal(page);
  const meta = await realProposalMeta(page, request);
  const clientNow = await page.evaluate(() => Date.now());
  expect(meta.expiresAt - clientNow).toBeGreaterThan(15 * 60 * 1000);
  // First capped timeout fires while the deadline is future: the rearmed
  // card stays pending with live controls (no retire, no write).
  await page.clock.fastForward(15 * 60 * 1000);
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toBeVisible();
  await expect(page.locator("#action-approve")).toBeEnabled();
  await expect(page.locator("#action-reject")).toBeEnabled();
  // Advance the actual remaining time to the REAL deadline: the rearmed
  // one-shot retires the card locally with no visibility/network refresh.
  const remaining = meta.expiresAt - (await page.evaluate(() => Date.now()));
  expect(remaining).toBeGreaterThan(0);
  await page.clock.fastForward(remaining + 1);
  await expect(page.locator('[data-action-card="true"]')).toHaveCount(0);
  expect(await writeCalls(request)).toBe(0);
});

test("tab resume retires the expired pending card with no new polling", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  await stageProposal(page);
  const meta = await realProposalMeta(page, request);
  // Jump the clock WITHOUT firing any timer: the stale one-shot cannot run,
  // so the card is still visible — and only the ACTUAL visibilitychange
  // reconciliation retires it, locally, with no proposals/execution/provider
  // reads and no external write.
  await page.clock.setSystemTime(meta.expiresAt);
  const card = page.locator('[data-action-card="true"]');
  await expect(card).toBeVisible();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator('[data-action-card="true"]')).toHaveCount(0);
  expect(await writeCalls(request)).toBe(0);
});

test("decision race: approve across the old deadline keeps the live execution card", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  await stageProposal(page);
  const meta = await realProposalMeta(page, request);
  // Hold the authoritative preflight read AFTER staging, so the approval's
  // execution stays live (pre-marker) while the deadline passes.
  await control(request, "/arm-read-barrier");
  // Delay the REAL approve response: fetch the actual response, hold it past
  // the old deadline, then fulfill the ACTUAL 202 (never fabricated).
  let releaseApprove!: () => void;
  const approveGate = new Promise<void>((resolve) => {
    releaseApprove = resolve;
  });
  try {
    await page.route("**/proposals/*/approve", async (route) => {
      const response = await route.fetch();
      await approveGate;
      await route.fulfill({ response });
    });
    const approveSent = page.waitForRequest("**/proposals/*/approve");
    await page.locator("#action-approve").click();
    await approveSent;
    // Cross the old server deadline while the REAL decision is awaited: the
    // stale one-shot timer must not retire the decision-in-flight card.
    await page.clock.fastForward(15 * 60 * 1000 + 1);
    const card = page.locator('[data-action-card="true"]');
    await expect(card).toBeVisible();
    // Release the held REAL 202 and drive the read-only execution polls past
    // the frozen clock: the live execution card survives the old deadline.
    const approved = page.waitForResponse(
      (res) =>
        res.url().includes("/approve") && res.request().method() === "POST",
    );
    releaseApprove();
    expect((await approved).status()).toBe(202);
    await page.clock.runFor(5_000);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute(
      "data-action-state",
      /queued|preflight|executing/,
    );
    // Release the held preflight: the run verifies to the REAL receipt, and
    // the terminal receipt persists on the surviving card.
    await control(request, "/release");
    await page.clock.runFor(30_000);
    await expect(card).toContainText("日程を更新しました");
    expect(await writeCalls(request)).toBe(1);
  } finally {
    releaseApprove();
    await page.unroute("**/proposals/*/approve").catch(() => {});
  }
  void meta;
});

test("reject transport abort recovers pending controls, then real reject writes nothing", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // Abort the FIRST real reject POST before the server sees it: the client
  // must release decision ownership and reconcile, never wedge pending.
  let firstReject = true;
  try {
    await page.route("**/proposals/*/reject", async (route) => {
      if (firstReject) {
        firstReject = false;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.locator("#action-reject").click();
    // Fixed transport notice; nothing is claimed rejected.
    await expect(page.locator("#composer-notice")).toContainText(
      "却下できませんでした",
    );
    // The still-pending proposal reconciles from the REAL repository state:
    // controls recover with the pending card intact.
    await expect(page.locator("#action-approve")).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.locator("#action-reject")).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.locator('[data-action-card="true"]')).toHaveAttribute(
      "data-action-state",
      /pending/,
    );
    const sessionId = await sessionIdOf(page);
    const list = await request.get(
      `${CALENDAR_APP_ORIGIN}/api/sessions/${sessionId}/proposals`,
    );
    expect(list.ok()).toBe(true);
    const body = (await list.json()) as { proposals?: { status?: unknown }[] };
    expect(body.proposals?.[0]?.status).toBe("pending");
    // The retry is the REAL reject: durable rejection history, 0 writes.
    const rejected = page.waitForResponse(
      (res) =>
        res.url().includes("/reject") && res.request().method() === "POST",
    );
    await page.locator("#action-reject").click();
    expect((await rejected).status()).toBe(200);
    await expect(
      page.locator("#conversation [data-action-history='action_rejection']"),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('[data-action-card="true"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    await page.waitForTimeout(2_000);
    expect(await writeCalls(request)).toBe(0);
  } finally {
    await page.unroute("**/proposals/*/reject").catch(() => {});
  }
});

test("lost approve response still retires the old timer and verifies (1 write)", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  await stageProposal(page);
  const meta = await realProposalMeta(page, request);
  // Hold the authoritative preflight AFTER staging so the approved run stays
  // live (pre-marker) while the execution read below is failed.
  await control(request, "/arm-read-barrier");
  try {
    // The REAL approve commits server-side (202) but its delivery aborts:
    // the client sees a transport failure, never an approval claim.
    let firstApprove = true;
    await page.route("**/proposals/*/approve", async (route) => {
      if (firstApprove) {
        firstApprove = false;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    // Fail ONLY the execution GET; the proposals GET stays real (approved).
    await page.route("**/proposals/*/execution", async (route) => {
      await route.abort("failed");
    });
    await page.locator("#action-approve").click();
    await expect(page.locator("#composer-notice")).toContainText(
      "承認できませんでした",
    );
    // Authoritative approved ownership BEFORE the failed execution read:
    // cross the ORIGINAL deadline and the server-accepted card is retained
    // with decisions disabled (no stale pending downgrade, no timer retire).
    await page.clock.fastForward(15 * 60 * 1000 + 1);
    const card = page.locator('[data-action-card="true"]');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-action-state", /approved/);
    await expect(page.locator("#action-approve")).toBeDisabled();
    await expect(page.locator("#action-reject")).toBeDisabled();
    // Resume the REAL execution reads; the bounded existing watch recovers
    // without any new polling path. Release the held preflight so the run
    // verifies to the REAL receipt with exactly one external write.
    await page.unroute("**/proposals/*/execution").catch(() => {});
    await control(request, "/release");
    await page.clock.runFor(60_000);
    await expect(card).toContainText("日程を更新しました", { timeout: 30_000 });
    expect(await writeCalls(request)).toBe(1);
  } finally {
    await page.unroute("**/proposals/*/approve").catch(() => {});
    await page.unroute("**/proposals/*/execution").catch(() => {});
  }
  void meta;
});

/* ------------------------------------------------------------------ */
/* PR28 review races (real UI + real fake seams, deterministic)        */
/* ------------------------------------------------------------------ */

test("PR28-1 lost reject during in-flight proposals sync recovers controls", async ({
  page,
  request,
}) => {
  await stageProposal(page);
  // Hold every proposals list GET so a background sync stays in flight while
  // the real reject POST aborts: the deduped sync alone must never own this
  // recovery (it is dropped while in flight).
  let releaseLists!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseLists = resolve;
  });
  let holdLists = true;
  try {
    await page.route("**/proposals", async (route) => {
      if (
        holdLists &&
        !route.request().url().includes("/agora/") &&
        !route.request().url().includes("/approve") &&
        !route.request().url().includes("/reject") &&
        !route.request().url().includes("/execution")
      ) {
        await listGate;
      }
      await route.continue();
    });
    let firstReject = true;
    await page.route("**/proposals/*/reject", async (route) => {
      if (firstReject) {
        firstReject = false;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.locator("#action-reject").click();
    await expect(page.locator("#composer-notice")).toContainText(
      "却下できませんでした",
    );
    // Release the held lists: the held decision ownership reconciles the real
    // pending state with live controls and an intact timer.
    holdLists = false;
    releaseLists();
    await expect(page.locator("#action-approve")).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.locator("#action-reject")).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.locator('[data-action-card="true"]')).toHaveAttribute(
      "data-action-state",
      /pending/,
    );
    // The retry is the real reject: durable history, no write.
    const rejected = page.waitForResponse(
      (res) =>
        res.url().includes("/reject") && res.request().method() === "POST",
    );
    await page.locator("#action-reject").click();
    expect((await rejected).status()).toBe(200);
    await expect(
      page.locator("#conversation [data-action-history='action_rejection']"),
    ).toHaveCount(1, { timeout: 30_000 });
    expect(await writeCalls(request)).toBe(0);
  } finally {
    try {
      holdLists = false;
      releaseLists();
    } catch {
      // Best effort.
    }
    await page.unroute("**/proposals").catch(() => {});
    await page.unroute("**/proposals/*/reject").catch(() => {});
  }
});

test("PR28-2 stale pending list cannot downgrade approved ownership without runId", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  await stageProposal(page);
  const meta = await realProposalMeta(page, request);
  // Hold the authoritative preflight AFTER staging so the approved run stays
  // live (pre-marker) and no runId can be supplied until the release below.
  await control(request, "/arm-read-barrier");
  // Hold the OLDER proposals list at the network: the next list GET (the
  // real assent-terminal sync below, sent while the card is still pending)
  // is fetched NOW while genuinely pending, but its delivery is gated until
  // AFTER the server has approved and the client owns approved state.
  let releaseOlder!: () => void;
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  let markOlderSeen!: () => void;
  const olderSeenAt = new Promise<void>((resolve) => {
    markOlderSeen = resolve;
  });
  let olderCount = 0;
  let listHits = 0;
  let olderBody = "";
  let olderFulfilled = false;
  // Lost-approve delivery (the server commits; the client sees a transport
  // failure) keeps the approved card WITHOUT a runId; execution reads fail
  // so the bounded watch cannot supply one either.
  let firstApprove = true;
  try {
    await page.route("**/proposals", async (route) => {
      const url = route.request().url();
      if (
        url.includes("/agora/") ||
        route.request().method() !== "GET" ||
        url.includes("/approve") ||
        url.includes("/reject") ||
        url.includes("/execution")
      ) {
        await route.continue();
        return;
      }
      listHits += 1;
      if (olderCount === 0) {
        olderCount += 1;
        const live = await route.fetch();
        olderBody = await live.text();
        markOlderSeen();
        await olderGate;
        olderFulfilled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: olderBody,
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/proposals/*/approve", async (route) => {
      if (firstApprove) {
        firstApprove = false;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.route("**/proposals/*/execution", async (route) => {
      await route.abort("failed");
    });
    // A REAL older sync in flight while pending: the assent turn answers
    // (the pending card is untouched) and its terminal schedules the genuine
    // proposals sync whose list delivery is now held at the network.
    await send(page, TEXT_ASSENT);
    await expect(page.locator("#conversation")).toContainText(
      ANSWER_ASSENT_TEXT,
      { timeout: 30_000 },
    );
    await olderSeenAt;
    // The held body is genuinely the pending summary for this proposal
    // (fetched from the real server while still pending).
    expect(olderBody).toContain("pending");
    expect(olderBody).toContain(meta.proposalId);
    // The REAL approve commits server-side while the older list is held;
    // its delivery aborts, so reconciliation must take approved ownership
    // with no runId (timer cleared, decisions disabled, execution watch on).
    await page.locator("#action-approve").click();
    await expect(page.locator("#composer-notice")).toContainText(
      "承認できませんでした",
      { timeout: 30_000 },
    );
    const card = page.locator('[data-action-card="true"]');
    await expect(card).toHaveAttribute("data-action-state", /approved/, {
      timeout: 30_000,
    });
    await expect(page.locator("#action-approve")).toBeDisabled();
    await expect(page.locator("#action-reject")).toBeDisabled();
    // All three real lists flowed: the held older, the approve pre-read,
    // and the lost-approve authoritative re-read.
    expect(listHits).toBeGreaterThanOrEqual(3);
    // Release the STALE pending summary AFTER authoritative approved
    // ownership while the runId is still unavailable: the held sync resumes
    // through the REAL sync path and must not downgrade the card.
    releaseOlder();
    await expect.poll(() => olderFulfilled, { timeout: 30_000 }).toBe(true);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-action-state", /approved/);
    await expect(page.locator("#action-approve")).toBeDisabled();
    await expect(page.locator("#action-reject")).toBeDisabled();
    // The cleared timer (not the stale list) owns expiry: crossing the
    // original deadline retires nothing.
    await page.clock.fastForward(15 * 60 * 1000 + 1);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-action-state", /approved/);
    await expect(page.locator("#action-approve")).toBeDisabled();
    await expect(page.locator("#action-reject")).toBeDisabled();
    await page.unroute("**/proposals").catch(() => {});
    await page.unroute("**/proposals/*/execution").catch(() => {});
    await control(request, "/release");
    await page.clock.runFor(60_000);
    await expect(card).toContainText("日程を更新しました", { timeout: 30_000 });
    expect(await writeCalls(request)).toBe(1);
  } finally {
    try {
      releaseOlder();
    } catch {
      // Best effort.
    }
    await page.unroute("**/proposals").catch(() => {});
    await page.unroute("**/proposals/*/approve").catch(() => {});
    await page.unroute("**/proposals/*/execution").catch(() => {});
  }
});

test("PR28-3 historic rejections survive reload without duplicate rows or writes", async ({
  page,
  request,
}) => {
  // Two real stage+reject cycles leave two historic rejected proposals.
  await stageProposal(page);
  let rejected = page.waitForResponse(
    (res) => res.url().includes("/reject") && res.request().method() === "POST",
  );
  await page.locator("#action-reject").click();
  expect((await rejected).status()).toBe(200);
  await expect(
    page.locator("#conversation [data-action-history='action_rejection']"),
  ).toHaveCount(1, { timeout: 30_000 });
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
  await expect(page.locator('[data-action-card="true"]')).toBeVisible({
    timeout: 30_000,
  });
  rejected = page.waitForResponse(
    (res) => res.url().includes("/reject") && res.request().method() === "POST",
  );
  await page.locator("#action-reject").click();
  expect((await rejected).status()).toBe(200);
  await expect(page.locator('[data-action-card="true"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  // Reload and verify the durable consumer state: both rejections survive as
  // exactly two rows, no active action card remains, and no write is emitted.
  // History GETs are NOT owned by this panel: other consumers (e.g. the
  // autodispatch panel's accepted-turn permission anchor) legitimately fetch
  // the same /api/sessions/:sid/history endpoint, so a global request count
  // cannot prove hydration ownership here.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  await expect(
    page.locator("#conversation [data-action-history='action_rejection']"),
  ).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('[data-action-card="true"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  expect(await writeCalls(request)).toBe(0);
});

test("PR28-4 delayed live execution cannot overwrite terminal receipt", async ({
  page,
  request,
}) => {
  await installClockAndLoad(page);
  await stageProposal(page);
  // Hold the authoritative preflight AFTER staging so the approved run stays
  // live (pre-marker) with its real Stop control until the release below.
  await control(request, "/arm-read-barrier");
  await page.locator("#action-approve").click();
  const card = page.locator('[data-action-card="true"]');
  // The REAL execution watch renders the live card first (runId known).
  await expect(card).toHaveAttribute(
    "data-action-state",
    /queued|preflight|executing/,
    { timeout: 60_000 },
  );
  await expect(page.locator("[data-action-stop='true']")).toBeVisible({
    timeout: 30_000,
  });
  const liveView = await executionView(page, request);
  expect(liveView.runId ?? "").not.toBe("");
  // Hold the NEXT live execution read at the network: fetch the REAL live
  // body now (genuinely live, receipt-free) but gate its delivery until
  // AFTER the authoritative terminal is rendered on the same live card.
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let markStaleSeen!: () => void;
  const staleSeenAt = new Promise<void>((resolve) => {
    markStaleSeen = resolve;
  });
  let staleCount = 0;
  let execHits = 0;
  let staleBody = "";
  let staleFulfilled = false;
  try {
    await page.route("**/proposals/*/execution", async (route) => {
      execHits += 1;
      if (staleCount === 0) {
        staleCount += 1;
        const live = await route.fetch();
        staleBody = await live.text();
        markStaleSeen();
        await staleGate;
        staleFulfilled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: staleBody,
        });
        return;
      }
      await route.continue();
    });
    // Drive the clock-controlled watch to its next tick so the held read is
    // genuinely the client's own execution poll (not a synthesized replay).
    await page.clock.runFor(1_000);
    await staleSeenAt;
    // Genuine delayed-live race input: a live (non-terminal, receipt-free)
    // execution read fetched from the real server while still live.
    expect(staleBody).toMatch(/"status":"(queued|preflight|executing)"/);
    expect(staleBody).toContain('"receipt":null');
    // Release the server run to its REAL terminal while the stale live read
    // stays held; the page watch is blocked on it, so observe the terminal
    // through the real Node API (same server, no page reload).
    await control(request, "/release");
    await expect
      .poll(
        async () => {
          const terminal = await executionView(page, request);
          return (
            (terminal.receipt as { outcome?: string } | null)?.outcome ?? ""
          );
        },
        { timeout: 60_000 },
      )
      .toBe("succeeded");
    expect(await writeCalls(request)).toBe(1);
    // Render the authoritative terminal on the SAME live card through a real
    // client sync (the assent terminal below schedules the genuine
    // proposals+execution sync whose execution read continues fresh) while
    // the stale live read stays held. No reload: the card never leaves.
    await send(page, TEXT_ASSENT);
    await expect(page.locator("#conversation")).toContainText(
      ANSWER_ASSENT_TEXT,
      { timeout: 30_000 },
    );
    await expect(card).toHaveAttribute("data-action-state", "succeeded", {
      timeout: 60_000,
    });
    await expect(card).toContainText("日程を更新しました", {
      timeout: 30_000,
    });
    await expect(page.locator("[data-action-stop='true']")).toBeHidden();
    expect(execHits).toBeGreaterThanOrEqual(2);
    // Release the STALE live read AFTER the terminal: the terminal-wins
    // guard must drop it — receipt and Stop ownership stay terminal.
    releaseStale();
    await expect.poll(() => staleFulfilled, { timeout: 30_000 }).toBe(true);
    await page.clock.runFor(5_000);
    await expect(card).toHaveAttribute("data-action-state", "succeeded");
    await expect(card).toContainText("日程を更新しました");
    await expect(page.locator("[data-action-stop='true']")).toBeHidden();
    await expect(page.locator("#composer-notice")).not.toContainText(
      "停止しました",
    );
    const view = await executionView(page, request);
    expect((view.receipt as { outcome?: string } | null)?.outcome).toBe(
      "succeeded",
    );
    expect(await writeCalls(request)).toBe(1);
  } finally {
    try {
      releaseStale();
    } catch {
      // Best effort.
    }
    await page.unroute("**/proposals/*/execution").catch(() => {});
  }
});
