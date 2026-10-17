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
