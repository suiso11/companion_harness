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
  const cardText =
    (await page.locator('[data-action-card="true"]').textContent()) ?? "";
  expect(cardText).not.toContain("calendar.reschedule");
  void request;
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
