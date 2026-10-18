// AV03 conversation-proposal consumer vertical (real browser + real HTTP).
//
// No API mocks, no private-state injection: every flow drives the REAL
// proposal panel against the REAL Hono app + kernel DB (e2e/server.ts).
// Drafts are staged from the test's OWN chat text via POST /seed-proposal,
// which calls the REAL model-only kernel path
// (`stageConversationProposalFromModel`, the exact function the
// `purpose.propose` / `task.propose` tool registrations call) against the
// session's latest real `user_text` turn. The native toolcall half
// (synthetic provider -> native propose -> answer.submit, server stores
// pending, never auto-accepts) is proven in the kernel agent test; here the
// HUMAN half is proven in a production browser with the cached BUILDUI:
//
//   1. purpose draft: quiet pending while the user keeps chatting (no
//      forced taskization, badge counts only), explicit drawer review with
//      the original quote apart from the interpretation, explicit accept
//      creates exactly ONE SELF purpose (explicit human dates only);
//   2. task draft: model's explicit parent shown as a readable title
//      (immutable, never auto-picked), human deadline adopted exactly,
//      markup quote renders inert (textContent-only), reject creates
//      nothing, reload replays no duplicate.

import { expect, type Page, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN } from "./ports.js";

async function controlReset(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/reset`);
  expect(res.ok()).toBe(true);
}

async function seedProposal(
  request: import("@playwright/test").APIRequestContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/seed-proposal`, {
    data: payload,
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function seedBurst(
  request: import("@playwright/test").APIRequestContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/seed-proposal-burst`, {
    data: payload,
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function boot(page: Page): Promise<string> {
  await page.goto("/");
  await page.locator("#proposal-badge").waitFor({ timeout: 15_000 });
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
  await expect(page.locator("#conversation")).toContainText(`echo:${text}`, {
    timeout: 15_000,
  });
  await expect(page.locator("#composer-send")).toBeEnabled();
}

/** Real same-origin HTTP from the page (real Origin, real JSON routes). */
async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({
      method,
      path,
      body,
    }: {
      method: string;
      path: string;
      body?: unknown;
    }) => {
      const headers: Record<string, string> = {
        accept: "application/json",
        "idempotency-key": crypto.randomUUID(),
      };
      let payload: string | undefined;
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const response = await fetch(path, {
        method,
        headers,
        body: payload ?? null,
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    { method, path, body },
  ) as Promise<{ status: number; body: unknown }>;
}

test.beforeEach(async ({ page, request }) => {
  await controlReset(request);
  await boot(page);
});

test("purpose draft stays quiet until the human explicitly adopts it", async ({
  page,
  request,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  // No drafts yet: quiet badge, no brief, no drawer.
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補はありません",
  );
  await expect(page.locator("#proposal-brief")).toHaveText("");

  await sendChat(page, "i want to walk daily e2e");
  // Ordinary chat stages nothing by itself (no automatic taskization).
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補はありません",
  );

  // The model stages ONE draft quoting the OWN chat text verbatim.
  const staged = await seedProposal(request, {
    sessionId,
    target: "purpose",
    quote: "walk daily",
  });
  expect(staged.status).toBe("pending");
  expect(staged.sourceKind).toBe("model");

  // Quiet pending: badge counts, brief appears only on the natural break
  // (composer blank, no active run, document visible) — no drawer opens,
  // composer text and focus are untouched.
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 1件",
  );
  await expect(page.locator("#proposal-brief")).toContainText(
    "AI候補が1件あります",
  );
  await expect(page.locator("#proposal-detail")).toBeHidden();

  // The user keeps chatting: the draft is preserved, never auto-adopted.
  await sendChat(page, "unrelated followup e2e");
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 1件",
  );
  const pending = await api(page, "GET", `${base}/purposes?limit=50`);
  expect((pending.body as { items: unknown[] }).items).toHaveLength(0);

  // Explicit review: original quote apart from the AI interpretation,
  // source badge marks AI候補／未採用 (no user-intent forgery).
  await page.locator("#proposal-list button").first().click();
  await expect(page.locator("#proposal-detail")).toBeVisible();
  const detailBody = page.locator("#proposal-detail-body");
  await expect(detailBody).toContainText("発言の原文（引用）:");
  await expect(detailBody).toContainText("walk daily");
  await expect(detailBody).toContainText("AIの解釈（原文ではありません）:");
  await expect(detailBody).toContainText("AI候補／未採用");

  // Explicit adopt: exactly ONE SELF purpose, quote + interpretation kept.
  await page.locator("#proposal-accept").click();
  await expect(page.locator("#proposal-status")).toContainText("採用しました", {
    timeout: 15_000,
  });
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補はありません",
  );
  const purposes = await api(page, "GET", `${base}/purposes?limit=50`);
  const items = (purposes.body as { items: Record<string, unknown>[] }).items;
  expect(items).toHaveLength(1);
  expect(items[0]?.statement).toBe("walk daily");
  expect(items[0]?.explicit).toBe(false);
  expect(items[0]?.sourceKind).toBe("self");
  const proposals = await api(
    page,
    "GET",
    `${base}/conversation-proposals?limit=50`,
  );
  const drafts = (proposals.body as { items: Record<string, unknown>[] }).items;
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.status).toBe("accepted");
  expect(drafts[0]?.acceptedTargetId).toBe(items[0]?.id);
});

test("task draft shows the explicit parent, adopts the human deadline, renders markup inert", async ({
  page,
  request,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  // Explicit human-owned parent first (real route, never auto-picked).
  const parent = await api(page, "POST", `${base}/purposes`, {
    scope: "health",
    statement: "e2e parent goal",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(parent.status).toBe(201);
  const parentBody = parent.body as { id: string; version: number };

  await sendChat(page, "buy <img src=x onerror=alert(1)> milk e2e");
  const staged = await seedProposal(request, {
    sessionId,
    target: "task",
    draftKind: "task",
    taskKind: "task",
    quote: "<img src=x onerror=alert(1)>",
    interpretation: "buy milk after work",
    parentPurposeId: parentBody.id,
    expectedParentVersion: parentBody.version,
  });
  expect(staged.status).toBe("pending");

  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 1件",
  );
  await page.locator("#proposal-list button").first().click();
  await expect(page.locator("#proposal-detail")).toBeVisible();
  // Markup quote renders inert: text only, no element, no execution.
  const detailBody = page.locator("#proposal-detail-body");
  await expect(detailBody).toContainText("<img src=x onerror=alert(1)>");
  expect(await detailBody.locator("img").count()).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { alerted?: boolean }).alerted,
    ),
  ).toBeUndefined();
  // The model's explicit parent is shown as a readable title (immutable).
  await expect(page.locator("#proposal-parent")).toContainText(
    "e2e parent goal",
    { timeout: 15_000 },
  );

  // Human deadline (blank defaults to none): explicit strict RFC3339 only.
  await page.locator("#proposal-date").fill("2026-11-01T09:00:00+09:00");
  await page.locator("#proposal-accept").click();
  await expect(page.locator("#proposal-status")).toContainText("採用しました", {
    timeout: 15_000,
  });
  const tasks = await api(page, "GET", `${base}/tasks?limit=50`);
  const taskItems = (tasks.body as { items: Record<string, unknown>[] }).items;
  expect(taskItems).toHaveLength(1);
  expect(taskItems[0]?.title).toBe("<img src=x onerror=alert(1)>");
  expect(taskItems[0]?.deadline).toBe("2026-11-01T09:00:00+09:00");
  expect(taskItems[0]?.speaker).toBe("self");
  expect(taskItems[0]?.parentPurposeId).toBe(parentBody.id);

  // Reject path creates nothing: seed a second draft and decline it.
  await sendChat(page, "maybe nap daily e2e");
  await seedProposal(request, {
    sessionId,
    target: "purpose",
    quote: "nap daily",
  });
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 1件",
  );
  await page.locator("#proposal-list button").first().click();
  await page.locator("#proposal-reject").click();
  await expect(page.locator("#proposal-status")).toContainText(
    "見送りにしました",
    { timeout: 15_000 },
  );
  const purposesAfter = await api(page, "GET", `${base}/purposes?limit=50`);
  expect((purposesAfter.body as { items: unknown[] }).items).toHaveLength(1);

  // Reload replays no duplicate: history shows one accepted + one rejected.
  await page.reload();
  await page.locator("#proposal-badge").waitFor({ timeout: 15_000 });
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補はありません",
  );
  const history = await api(
    page,
    "GET",
    `${base}/conversation-proposals?limit=50`,
  );
  const historyItems = (history.body as { items: Record<string, unknown>[] })
    .items;
  expect(
    historyItems
      .map((row) => row.status)
      .sort()
      .join(","),
  ).toBe("accepted,rejected");
  const tasksAfter = await api(page, "GET", `${base}/tasks?limit=50`);
  expect((tasksAfter.body as { items: unknown[] }).items).toHaveLength(1);
});

test("an old pending draft stays reachable and actionable behind history paging", async ({
  page,
  request,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  // One old pending draft buried under 55 newer rejections (real kernel
  // paths; the keeper quote occurs exactly once in its own source text).
  const burst = await seedBurst(request, {
    sessionId,
    decided: 55,
    pendingQuote: "keeper choice",
  });
  expect(burst.decided).toBe(55);

  await page.locator("#proposal-refresh").click();
  // The badge counts ALL owned pending (truthful pendingCount), not the
  // visible page — even though the keeper is not on the newest page.
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 1件",
  );
  await expect(page.locator("#proposal-more")).toBeVisible();

  // Load the older page: the buried keeper appears and opens real detail.
  await page.locator("#proposal-more").click();
  const keeperRow = page.locator("#proposal-list button", {
    hasText: "未採用",
  });
  await expect(keeperRow).toHaveCount(1);
  await keeperRow.click();
  await expect(page.locator("#proposal-detail")).toBeVisible();
  await expect(page.locator("#proposal-detail-body")).toContainText(
    "keeper choice",
  );
  // Fresh decision controls are live for the pending keeper.
  await expect(page.locator("#proposal-accept")).toBeEnabled();
  await page.locator("#proposal-accept").click();
  await expect(page.locator("#proposal-status")).toContainText("採用しました", {
    timeout: 15_000,
  });
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補はありません",
  );
  const purposes = await api(page, "GET", `${base}/purposes?limit=50`);
  const items = (purposes.body as { items: Record<string, unknown>[] }).items;
  expect(items).toHaveLength(1);
  expect(items[0]?.statement).toBe("keeper choice");
});

test("typed dates survive refresh and resolved drafts open readonly", async ({
  page,
  request,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  await sendChat(page, "i want to garden daily e2e");
  await seedProposal(request, {
    sessionId,
    target: "purpose",
    quote: "garden daily",
  });
  await page.locator("#proposal-refresh").click();
  await page.locator("#proposal-list button").first().click();
  await expect(page.locator("#proposal-detail")).toBeVisible();

  // Human-typed window survives a same-selection refresh untouched.
  await page.locator("#proposal-date").fill("2026-11-01T09:00:00+09:00");
  await page.locator("#proposal-date-until").fill("2026-11-08T09:00:00+09:00");
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-date")).toHaveValue(
    "2026-11-01T09:00:00+09:00",
  );
  await expect(page.locator("#proposal-date-until")).toHaveValue(
    "2026-11-08T09:00:00+09:00",
  );

  // Adopt with the frozen window, then reload: the resolved row reopens
  // READONLY with the real quote/interpretation/outcome and no live
  // decision controls (reopening mutates nothing).
  await page.locator("#proposal-accept").click();
  await expect(page.locator("#proposal-status")).toContainText("採用しました", {
    timeout: 15_000,
  });
  await page.reload();
  await page.locator("#proposal-badge").waitFor({ timeout: 15_000 });
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補はありません",
  );
  await page.locator("#proposal-list button").first().click();
  await expect(page.locator("#proposal-detail")).toBeVisible();
  const detailBody = page.locator("#proposal-detail-body");
  await expect(detailBody).toContainText("garden daily");
  await expect(detailBody).toContainText("採用済み");
  await expect(page.locator("#proposal-accept")).toBeDisabled();
  await expect(page.locator("#proposal-reject")).toBeDisabled();
  const purposes = await api(page, "GET", `${base}/purposes?limit=50`);
  const items = (purposes.body as { items: Record<string, unknown>[] }).items;
  expect(items).toHaveLength(1);
  expect(items[0]?.validFrom).toBe("2026-11-01T09:00:00+09:00");
  expect(items[0]?.validUntil).toBe("2026-11-08T09:00:00+09:00");
});

test("a late parent read never overwrites the shown draft", async ({
  page,
  request,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  const parentA = await api(page, "POST", `${base}/purposes`, {
    scope: "health",
    statement: "e2e parent alpha",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(parentA.status).toBe(201);
  const parentB = await api(page, "POST", `${base}/purposes`, {
    scope: "health",
    statement: "e2e parent beta",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(parentB.status).toBe(201);
  const paBody = parentA.body as { id: string; version: number };
  const pbBody = parentB.body as { id: string; version: number };

  await sendChat(page, "alpha task work now");
  await seedProposal(request, {
    sessionId,
    target: "task",
    draftKind: "task",
    taskKind: "task",
    quote: "alpha task",
    interpretation: "alpha reading",
    parentPurposeId: paBody.id,
    expectedParentVersion: paBody.version,
  });
  await sendChat(page, "beta task work now");
  await seedProposal(request, {
    sessionId,
    target: "task",
    draftKind: "task",
    taskKind: "task",
    quote: "beta task",
    interpretation: "beta reading",
    parentPurposeId: pbBody.id,
    expectedParentVersion: pbBody.version,
  });
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 2件",
  );

  // Hold A's actual parent GET, open A, then select B: B shows its own
  // parent, and A's late reply must not overwrite it.
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  await page.route(`**/purposes/${paBody.id}`, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    const rows = page.locator("#proposal-list button");
    await rows.last().click();
    await expect(page.locator("#proposal-parent")).toContainText(
      "親の目的を確認しています",
    );
    await rows.first().click();
    await expect(page.locator("#proposal-parent")).toContainText(
      "e2e parent beta",
      { timeout: 15_000 },
    );
    releaseA();
    await page.waitForTimeout(500);
    await expect(page.locator("#proposal-parent")).toContainText(
      "e2e parent beta",
    );
    await expect(page.locator("#proposal-parent")).not.toContainText(
      "e2e parent alpha",
    );

    // Adopting B binds B's actual parent (no approval drift to A).
    await page.locator("#proposal-date").fill("2026-11-02T09:00:00+09:00");
    await page.locator("#proposal-accept").click();
    await expect(page.locator("#proposal-status")).toContainText(
      "採用しました",
      { timeout: 15_000 },
    );
    const tasks = await api(page, "GET", `${base}/tasks?limit=50`);
    const taskItems = (tasks.body as { items: Record<string, unknown>[] })
      .items;
    expect(taskItems).toHaveLength(1);
    expect(taskItems[0]?.parentPurposeId).toBe(pbBody.id);
    expect(taskItems[0]?.title).toBe("beta task");
  } finally {
    await page.unroute(`**/purposes/${paBody.id}`);
  }
});

test("a lost accept response freezes one operation until same-key retry", async ({
  page,
  request,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  await sendChat(page, "frozen alpha wish e2e");
  await seedProposal(request, {
    sessionId,
    target: "purpose",
    quote: "frozen alpha",
  });
  await sendChat(page, "frozen beta wish e2e");
  await seedProposal(request, {
    sessionId,
    target: "purpose",
    quote: "frozen beta",
  });
  await page.locator("#proposal-refresh").click();
  await expect(page.locator("#proposal-badge")).toContainText(
    "未採用の候補 2件",
  );

  // Newest first: open the older alpha draft (last row).
  await page.locator("#proposal-list button").last().click();
  await expect(page.locator("#proposal-detail-body")).toContainText(
    "frozen alpha",
  );

  // Drop the first accept POST (lost response): the frozen op survives,
  // fresh controls lock, and only the explicit retry may resend it.
  await page.route(
    "**/conversation-proposals/*/accept",
    async (route) => route.abort(),
    { times: 1 },
  );
  try {
    await page.locator("#proposal-accept").click();
    await expect(page.locator("#proposal-status")).toContainText(
      "応答が不確定です",
      { timeout: 15_000 },
    );
    await expect(page.locator("#proposal-retry")).toBeVisible();
    await expect(page.locator("#proposal-accept")).toBeDisabled();
    await expect(page.locator("#proposal-reject")).toBeDisabled();

    // Fresh decisions cannot overwrite the frozen operation: reject is
    // refused and selecting B keeps A's drawer pinned.
    await page.locator("#proposal-reject").dispatchEvent("click");
    await expect(page.locator("#proposal-status")).toContainText(
      "未確定の操作があります",
    );
    await page.locator("#proposal-list button").first().click();
    await expect(page.locator("#proposal-detail-body")).toContainText(
      "frozen alpha",
    );

    // Same-key retry commits exactly ONE adoption; B stays pending.
    await page.locator("#proposal-retry").click();
    await expect(page.locator("#proposal-status")).toContainText(
      "採用しました",
      { timeout: 15_000 },
    );
    await expect(page.locator("#proposal-badge")).toContainText(
      "未採用の候補 1件",
    );
  } finally {
    await page.unroute("**/conversation-proposals/*/accept");
  }
  const purposes = await api(page, "GET", `${base}/purposes?limit=50`);
  expect((purposes.body as { items: unknown[] }).items).toHaveLength(1);
  const drafts = await api(
    page,
    "GET",
    `${base}/conversation-proposals?limit=50`,
  );
  const rows = (drafts.body as { items: Record<string, unknown>[] }).items;
  expect(rows.filter((row) => row.status === "accepted")).toHaveLength(1);
  expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
});
