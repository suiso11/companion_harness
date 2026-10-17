// AV03 delegation-handoff consumer vertical (real browser + real HTTP).
//
// No API mocks, no private-state injection: every flow drives the REAL
// handoff panel against the REAL Hono app + kernel DB (e2e/server.ts).
// The HUMAN half is proven in a production browser with the cached BUILDUI:
//
//   1. explicit create: the「引継ぎ」form records exactly ONE prepared
//      human-origin handoff bound to a real task; the row shows the
//      explicit「引継ぎ」badge with status + scope, the drawer quotes the
//      frozen target + criteria verbatim with the sandbox note, and a
//      reload keeps the explicit label (sandbox success is NEVER surfaced
//      as production);
//   2. revocation reevaluation: revoking a parent purpose flags the
//      in-scope handoff with the durable「要再評価」notice in the same
//      transaction (no auto-cancel); dispatch is disabled while the notice
//      is set, cancel stays enabled, and an explicit reaffirm clears the
//      notice and re-arms dispatch.
//   3. older-page lifecycle: a handoff that lives ONLY on an older page
//      (beyond the newest 50-item page) still dispatches→reports WITHOUT
//      a 409: the panel applies the 200-returned view immediately and the
//      refresh re-reads the off-page row, so the second human commit
//      always carries the version the server holds — the map's stale
//      copy never wins.

import { expect, type Page, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN } from "./ports.js";

async function controlReset(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/reset`);
  expect(res.ok()).toBe(true);
}

async function boot(page: Page): Promise<string> {
  await page.goto("/");
  await page.locator("#handoff-create").waitFor({ timeout: 15_000 });
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
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

async function seedTask(
  page: Page,
  sessionId: string,
): Promise<{ purposeId: string; taskId: string }> {
  const base = `/api/sessions/${sessionId}`;
  const purpose = await api(page, "POST", `${base}/purposes`, {
    scope: "work",
    statement: "e2e handoff parent goal",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(purpose.status).toBe(201);
  const purposeId = (purpose.body as { id: string }).id;
  const task = await api(page, "POST", `${base}/tasks`, {
    scope: "work",
    title: "e2e handoff task",
    kind: "task",
    speaker: "self",
    parentPurposeId: purposeId,
  });
  expect(task.status).toBe(201);
  return { purposeId, taskId: (task.body as { id: string }).id };
}

test.beforeEach(async ({ page, request }) => {
  await controlReset(request);
  await boot(page);
});

test("explicit create records a labeled handoff; drawer quotes frozen fields", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof sessionId).toBe("string");
  const { taskId } = await seedTask(page, sessionId as string);

  // Explicit human create through the real panel form.
  await page.locator("#handoff-task").fill(taskId);
  await page.locator("#handoff-target").fill("e2e hand the queue to pi-orch");
  await page
    .locator("#handoff-criteria")
    .fill("e2e queue drains without loss\ne2e no duplicate work");
  await page.locator("#handoff-op-scope").selectOption("implement");
  await page.locator("#handoff-create").click();
  await expect(page.locator("#handoff-status")).toContainText(
    "引継ぎを記録しました",
    { timeout: 15_000 },
  );
  // Explicit「引継ぎ」badge: status + scope, never a bare UUID row.
  const firstRow = page.locator("#handoff-list button").first();
  await expect(firstRow).toContainText("引継ぎ");
  await expect(firstRow).toContainText("準備中");
  await expect(firstRow).toContainText("実装");

  // Explicit review: frozen target + criteria quoted verbatim, sandbox note.
  await firstRow.click();
  await expect(page.locator("#handoff-detail")).toBeVisible();
  const detailBody = page.locator("#handoff-detail-body");
  await expect(detailBody).toContainText("e2e hand the queue to pi-orch");
  await expect(detailBody).toContainText("e2e queue drains without loss");
  await expect(detailBody).toContainText("e2e no duplicate work");
  await expect(detailBody).toContainText("サンドボックス成功≠本番");

  // Reload: the read DTO keeps the explicit prepared label (never verified).
  await page.reload();
  await page.locator("#handoff-create").waitFor({ timeout: 15_000 });
  await page.locator("#handoff-refresh").click();
  await expect(page.locator("#handoff-list button").first()).toContainText(
    "準備中",
    { timeout: 15_000 },
  );
  await page.locator("#handoff-list button").first().click();
  await expect(page.locator("#handoff-detail-body")).toContainText(
    "e2e hand the queue to pi-orch",
  );
  await expect(page.locator("#handoff-detail-body")).toContainText("準備中");
});

test("revocation flags the handoff; dispatch blocked, cancel kept, reaffirm clears", async ({
  page,
}) => {
  const sessionId = (await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  )) as string;
  const base = `/api/sessions/${sessionId}`;
  const { purposeId, taskId } = await seedTask(page, sessionId);
  const created = await api(page, "POST", `${base}/handoffs`, {
    taskId,
    target: "e2e revoke handoff",
    acceptanceCriteria: ["e2e steady queue"],
    opScope: "implement",
  });
  expect(created.status).toBe(201);

  // Revoke the parent: the handoff is flagged, never auto-cancelled.
  const revoked = await api(
    page,
    "POST",
    `${base}/purposes/${purposeId}/revoke`,
    {
      expectedVersion: 1,
    },
  );
  expect(revoked.status).toBe(200);

  await page.locator("#handoff-refresh").click();
  const row = page.locator("#handoff-list button").first();
  await expect(row).toContainText("要再評価", { timeout: 15_000 });
  await row.click();
  await expect(page.locator("#handoff-detail")).toBeVisible();
  await expect(page.locator("#handoff-detail-body")).toContainText("要再評価");
  await expect(page.locator("#handoff-detail-body")).toContainText("準備中");
  // Dispatch refused while the notice is set; cancel stays allowed.
  await expect(page.locator("#handoff-dispatch")).toBeDisabled();
  await expect(page.locator("#handoff-cancel")).toBeEnabled();
  await expect(page.locator("#handoff-reaffirm")).toBeEnabled();

  // Explicit human reaffirm: the notice clears and dispatch re-arms.
  await page.locator("#handoff-reaffirm").click();
  await expect(page.locator("#handoff-status")).toContainText(
    "操作を反映しました",
    { timeout: 15_000 },
  );
  await expect(page.locator("#handoff-detail-body")).not.toContainText(
    "要再評価",
  );
  await expect(page.locator("#handoff-dispatch")).toBeEnabled();
  await expect(page.locator("#handoff-reaffirm")).toBeDisabled();
});

// Regression: a handoff that lives ONLY on an older page (beyond the
// newest 50-item page) survives the full dispatch→report lifecycle WITHOUT
// a stale-version 409. The panel applies each 200-returned view to the map
// immediately and the refresh re-reads the off-page row, so the second
// human commit always carries the version the server holds.
test("older-page handoff dispatches→reports without a stale-version 409", async ({
  page,
}) => {
  const sessionId = (await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  )) as string;
  const base = `/api/sessions/${sessionId}`;
  const { taskId } = await seedTask(page, sessionId);

  // The target is created FIRST: 51 fillers push it onto the OLDER page
  // (item 52 of 52, newest-first). Its boundary flag makes its list row
  // uniquely identifiable (`［要承認:支払い］`).
  const target = await api(page, "POST", `${base}/handoffs`, {
    taskId,
    target: "e2e older-page handoff",
    acceptanceCriteria: ["e2e older page flows without loss"],
    opScope: "implement",
    boundaries: ["payment"],
  });
  expect(target.status).toBe(201);
  for (let i = 0; i < 51; i += 1) {
    const filler = await api(page, "POST", `${base}/handoffs`, {
      taskId,
      target: `e2e older-page filler ${i}`,
      acceptanceCriteria: ["e2e older page filler"],
      opScope: "implement",
    });
    expect(filler.status).toBe(201);
  }

  // Refresh loads the newest 50 page; the target is NOT on it — the row
  // only appears after「古い履歴を読み込む」merges the older page.
  await page.locator("#handoff-refresh").click();
  await expect(page.locator("#handoff-more")).toBeVisible({
    timeout: 15_000,
  });
  const row = page
    .locator("#handoff-list button")
    .filter({ hasText: "要承認:支払い" });
  await expect(row).toHaveCount(0);
  await page.locator("#handoff-more").click();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Dispatch off-page: the 200-returned view lands in the map before the
  // page fetch finishes, and the refresh re-reads the off-page row — the
  // committed truth (dispatched) replaces the stale copy, never a 409.
  await row.click();
  await expect(page.locator("#handoff-detail")).toBeVisible();
  await expect(page.locator("#handoff-detail-body")).toContainText("準備中");
  await page.locator("#handoff-dispatch").click();
  await expect(page.locator("#handoff-status")).toContainText(
    "操作を反映しました",
    { timeout: 15_000 },
  );
  await expect(page.locator("#handoff-detail-body")).toContainText("送付済");
  await expect(page.locator("#handoff-detail-body")).toContainText("版 2");

  // Report off-page: the second commit carries the SERVER version (版 2),
  // so the CAS check passes — 報告あり・版 3, never a stale-version 409.
  await page.locator("#handoff-report-env").selectOption("sandbox");
  await page.locator("#handoff-report-summary").fill("e2e older-page report");
  await page.locator("#handoff-report").click();
  await expect(page.locator("#handoff-status")).toContainText(
    "操作を反映しました",
    { timeout: 15_000 },
  );
  await expect(page.locator("#handoff-detail-body")).toContainText("報告あり");
  await expect(page.locator("#handoff-detail-body")).toContainText("版 3");
  await expect(page.locator("#handoff-status")).not.toContainText(
    "競合しました",
  );
});
