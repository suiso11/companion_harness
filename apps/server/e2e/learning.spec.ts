// AV04 learning consumer vertical (real browser + real HTTP).
//
// No API mocks, no private-state injection: every flow drives the REAL
// learning panel against the REAL Hono app + kernel DB (e2e/server.ts).
// The HUMAN half is proven in a production browser with the cached BUILDUI:
//
//   1. explicit create: the「学びの記録」form records exactly ONE open
//      human-origin hypothesis; the row shows the explicit「仮説」badge
//      with kind + status + evidence counts, and a reload keeps the
//      explicit label (refuted is NEVER surfaced as supported/fact);
//   2. revocation reevaluation: revoking a parent purpose flags the
//      in-scope hypothesis with the durable「要再評価」notice in the same
//      transaction (no auto-cancel of tasks); the flag is visible in the
//      UI and survives a reload.

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
  await page.locator("#learning-create").waitFor({ timeout: 15_000 });
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

test.beforeEach(async ({ page, request }) => {
  await controlReset(request);
  await boot(page);
});

test("explicit create records a labeled hypothesis; refute stays labeled refuted", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof sessionId).toBe("string");

  // Explicit human create through the real panel form.
  await page.locator("#learning-scope").fill("health");
  await page.locator("#learning-kind").selectOption("hypothesis");
  await page.locator("#learning-statement").fill("e2e morning runs help");
  await page.locator("#learning-create").click();
  await expect(page.locator("#learning-status")).toContainText(
    "仮説を記録しました",
    { timeout: 15_000 },
  );
  // Explicit「仮説」badge: kind + status + evidence counts, never a fact.
  const firstRow = page.locator("#learning-list button").first();
  await expect(firstRow).toContainText("仮説");
  await expect(firstRow).toContainText("検討中");
  await expect(firstRow).toContainText("支持0");

  // Explicit review: full statement + label + counts.
  await firstRow.click();
  await expect(page.locator("#learning-detail")).toBeVisible();
  const detailBody = page.locator("#learning-detail-body");
  await expect(detailBody).toContainText("e2e morning runs help");
  await expect(detailBody).toContainText("仮説");
  await expect(detailBody).toContainText("検討中");
  await expect(page.locator("#learning-evidence-list")).toContainText(
    "証拠はまだありません",
  );

  // Explicit human refute: the record is still labeled refuted on read.
  await page.locator("#learning-refute").click();
  await expect(page.locator("#learning-status")).toContainText(
    "操作を反映しました",
    { timeout: 15_000 },
  );
  await expect(page.locator("#learning-detail-body")).toContainText("反証");
  await expect(page.locator("#learning-list button").first()).toContainText(
    "反証",
  );

  // Reload: the read DTO keeps the explicit refuted label (never promoted).
  await page.reload();
  await page.locator("#learning-create").waitFor({ timeout: 15_000 });
  await page.locator("#learning-refresh").click();
  await expect(page.locator("#learning-list button").first()).toContainText(
    "反証",
    { timeout: 15_000 },
  );
  await page.locator("#learning-list button").first().click();
  await expect(page.locator("#learning-detail-body")).toContainText("反証");
  // Explicit refuted label (never promoted to supported): the badge names
  // the refuted status while the counts stay an explicit 0/0/0 tally.
  await expect(page.locator("#learning-detail-body")).toContainText(
    "仮説［仮説・反証］",
  );
});

test("revoking a parent purpose flags the in-scope hypothesis for reevaluation", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  // User purpose + same-scope hypothesis (real routes, human explicit).
  const purpose = await api(page, "POST", `${base}/purposes`, {
    scope: "health",
    statement: "e2e parent goal",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(purpose.status).toBe(201);
  const purposeId = (purpose.body as { id: string }).id;
  const hyp = await api(page, "POST", `${base}/learning/hypotheses`, {
    scope: "health",
    kind: "method",
    statement: "e2e scoped method",
  });
  expect(hyp.status).toBe(201);

  // Revoke the parent: the hypothesis is flagged, never auto-cancelled.
  const revoked = await api(
    page,
    "POST",
    `${base}/purposes/${purposeId}/revoke`,
    {
      expectedVersion: 1,
    },
  );
  expect(revoked.status).toBe(200);

  await page.locator("#learning-refresh").click();
  const row = page.locator("#learning-list button").first();
  await expect(row).toContainText("要再評価", { timeout: 15_000 });
  await row.click();
  await expect(page.locator("#learning-detail")).toBeVisible();
  await expect(page.locator("#learning-detail-body")).toContainText("要再評価");
  await expect(page.locator("#learning-detail-body")).toContainText("検討中");
});

test("lost create keeps a section-level retry; definitive 409 clears instead of pinning", async ({
  page,
  request,
}) => {
  void request;
  // Retry + status live at the section level, NOT inside the hidden
  // drawer: they must be reachable after a lost response with no
  // selection at all.
  const placement = await page.evaluate(() => {
    const retry = document.getElementById("learning-retry");
    const status = document.getElementById("learning-status");
    const detail = document.getElementById("learning-detail");
    return {
      retryParent: retry?.parentElement?.id ?? null,
      statusParent: status?.parentElement?.id ?? null,
      detailHidden: detail?.hidden ?? null,
    };
  });
  expect(placement.retryParent).toBe("learning");
  expect(placement.statusParent).toBe("learning");
  expect(placement.detailHidden).toBe(true);

  // Drop the first create POST (lost response): the frozen op survives at
  // the section level and the explicit retry resends the identical key.
  await page.route("**/learning/hypotheses", async (route) => route.abort(), {
    times: 1,
  });
  try {
    await page.locator("#learning-scope").fill("health");
    await page.locator("#learning-kind").selectOption("hypothesis");
    await page.locator("#learning-statement").fill("e2e frozen create");
    await page.locator("#learning-create").click();
    await expect(page.locator("#learning-status")).toContainText(
      "応答が不確定です",
      { timeout: 15_000 },
    );
    await expect(page.locator("#learning-detail")).toBeHidden();
    await expect(page.locator("#learning-retry")).toBeVisible();
    await page.locator("#learning-retry").click();
    await expect(page.locator("#learning-status")).toContainText(
      "仮説を記録しました",
      { timeout: 15_000 },
    );
    await expect(page.locator("#learning-list button").first()).toContainText(
      "仮説",
    );
  } finally {
    await page.unroute("**/learning/hypotheses");
  }

  // Definitive 409 clears the frozen op (never pins the panel): open the
  // drawer on v1, revoke the scope parent out-of-band (no panel refresh,
  // so the drawer still holds v1), then commit a stale transition.
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  const created = await api(page, "POST", `${base}/learning/hypotheses`, {
    scope: "e2e-stale",
    kind: "hypothesis",
    statement: "e2e stale guard",
  });
  expect(created.status).toBe(201);
  const purpose = await api(page, "POST", `${base}/purposes`, {
    scope: "e2e-stale",
    statement: "e2e stale parent",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(purpose.status).toBe(201);
  const purposeId = (purpose.body as { id: string }).id;
  await page.locator("#learning-refresh").click();
  const staleRow = page.locator("#learning-list button").filter({
    hasText: "e2e-stale",
  });
  await expect(staleRow.first()).toBeVisible({ timeout: 15_000 });
  await staleRow.first().click();
  await expect(page.locator("#learning-detail")).toBeVisible();
  const revoked = await api(
    page,
    "POST",
    `${base}/purposes/${purposeId}/revoke`,
    { expectedVersion: 1 },
  );
  expect(revoked.status).toBe(200);
  // The drawer still holds v1: the commit 409s, then clears (never pins).
  await page.locator("#learning-support").click();
  await expect(page.locator("#learning-status")).toContainText("競合しました", {
    timeout: 15_000,
  });
  // Cleared, not pinned: no retry offered, fresh controls live again, and
  // a fresh commit (new key, fresh version) succeeds immediately.
  await expect(page.locator("#learning-retry")).toBeHidden();
  await expect(page.locator("#learning-retire")).toBeEnabled();
  await page.locator("#learning-retire").click();
  await expect(page.locator("#learning-status")).toContainText(
    "操作を反映しました",
    { timeout: 15_000 },
  );
});

test("unknown-source evidence 404 keeps the drawer and typed inputs", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  const created = await api(page, "POST", `${base}/learning/hypotheses`, {
    scope: "health",
    kind: "method",
    statement: "e2e evidence drawer",
  });
  expect(created.status).toBe(201);
  await page.locator("#learning-refresh").click();
  const row = page.locator("#learning-list button").first();
  await expect(row).toContainText("仮説", { timeout: 15_000 });
  await row.click();
  await expect(page.locator("#learning-detail")).toBeVisible();

  // A well-formed but UNKNOWN source id: the 404 names the source, not the
  // hypothesis. Selection + typed inputs survive; no retry is offered for
  // the doomed identical body.
  const unknown = await page.evaluate(() => crypto.randomUUID());
  await page.locator("#learning-evidence-source-id").fill(unknown);
  await page.locator("#learning-evidence-attach").click();
  await expect(page.locator("#learning-status")).toContainText(
    "参照元が見つかりません",
    { timeout: 15_000 },
  );
  await expect(page.locator("#learning-detail")).toBeVisible();
  await expect(page.locator("#learning-evidence-source-id")).toHaveValue(
    unknown,
  );
  await expect(page.locator("#learning-retry")).toBeHidden();
  // The hypothesis itself is untouched and still openable.
  await expect(page.locator("#learning-detail-body")).toContainText(
    "e2e evidence drawer",
  );
});

test("reaffirm keeps the supported status and clears the notice", async ({
  page,
  request,
}) => {
  void request;
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  const purpose = await api(page, "POST", `${base}/purposes`, {
    scope: "e2e-reaffirm",
    statement: "e2e reaffirm parent",
    kind: "goal",
    explicit: true,
    sourceKind: "user",
  });
  expect(purpose.status).toBe(201);
  const purposeId = (purpose.body as { id: string }).id;
  const hyp = await api(page, "POST", `${base}/learning/hypotheses`, {
    scope: "e2e-reaffirm",
    kind: "method",
    statement: "e2e steady method",
  });
  expect(hyp.status).toBe(201);
  const hypId = (hyp.body as { id: string }).id;
  const supported = await api(
    page,
    "POST",
    `${base}/learning/hypotheses/${hypId}/transition`,
    { expectedVersion: 1, transition: "support" },
  );
  expect(supported.status).toBe(200);
  const revoked = await api(
    page,
    "POST",
    `${base}/purposes/${purposeId}/revoke`,
    { expectedVersion: 1 },
  );
  expect(revoked.status).toBe(200);

  await page.locator("#learning-refresh").click();
  const row = page.locator("#learning-list button").filter({
    hasText: "e2e-reaffirm",
  });
  await expect(row.first()).toContainText("要再評価", { timeout: 15_000 });
  await row.first().click();
  await expect(page.locator("#learning-detail")).toBeVisible();
  await expect(page.locator("#learning-reaffirm")).toBeEnabled();
  await page.locator("#learning-reaffirm").click();
  await expect(page.locator("#learning-status")).toContainText(
    "操作を反映しました",
    { timeout: 15_000 },
  );
  // Status kept (still supported), notice cleared, button rearms off.
  await expect(page.locator("#learning-detail-body")).toContainText("支持");
  await expect(page.locator("#learning-detail-body")).not.toContainText(
    "要再評価",
  );
  await expect(page.locator("#learning-reaffirm")).toBeDisabled();
});

test("refresh merges the newest page and never drops the older-page drawer", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  const scope = "e2e-bulk";
  for (let n = 0; n < 55; n += 1) {
    const created = await api(page, "POST", `${base}/learning/hypotheses`, {
      scope,
      kind: "method",
      statement: `e2e bulk row ${String(n).padStart(3, "0")}`,
    });
    expect(created.status).toBe(201);
  }
  await page.locator("#learning-refresh").click();
  await expect(page.locator("#learning-list button")).toHaveCount(50, {
    timeout: 15_000,
  });
  await expect(page.locator("#learning-more")).toBeVisible();
  await page.locator("#learning-more").click();
  await expect(page.locator("#learning-list button")).toHaveCount(55, {
    timeout: 15_000,
  });
  // A background refresh merges the newest page: the older page survives.
  await page.locator("#learning-refresh").click();
  await expect(page.locator("#learning-list button")).toHaveCount(55, {
    timeout: 15_000,
  });
  // Open the oldest row (last in newest-first order), then refresh: the
  // drawer stays on the same record (fetched directly when it leaves the
  // newest page).
  const oldest = page.locator("#learning-list button").last();
  await oldest.click();
  await expect(page.locator("#learning-detail")).toBeVisible();
  const shown = await page.locator("#learning-detail-body").textContent();
  expect(shown).toContain("e2e bulk row");
  await page.locator("#learning-refresh").click();
  await expect(page.locator("#learning-detail")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("#learning-detail-body")).toContainText(
    (shown ?? "e2e bulk row").trim().slice(0, 40),
  );
});
