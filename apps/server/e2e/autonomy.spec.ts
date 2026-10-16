// AV autonomy consumer-UI regression spec (real browser + real HTTP).
//
// No API mocks, no private-state injection, no source-wording assertions:
// every flow drives the REAL autonomy panel against the REAL Hono app +
// kernel DB (e2e/server.ts). Backend reads/writes inside page.evaluate use
// the real same-origin fetch (real Origin + Idempotency-Key headers), never
// a fabricated DTO. Each test owns a fresh browser context (fresh UI
// session) and never mutates the shared global autonomy control.
//
// Covers three consumer boundaries plus the refresh-version boundary:
//   1. statement-only UI correction preserves kind/scope/interpretation/
//      applicability window and keeps the superseded original;
//   2. a held task resumes onto a replacement parent ONLY via the explicit
//      checkbox + evidence (no blind or automatic reparenting);
//   3. selection/draft binding: switching selection clears drafts, and a
//      deliberately held-then-late detail GET never restores the stale
//      selection (purposes and tasks);
//   4. refresh-version boundary: a draft typed before a real backend
//      mutation + UI refresh cannot apply to the new version (client
//      invalidates via the captured selected-view version; the server CAS
//      would 409 regardless).

import { expect, type Page, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN } from "./ports.js";

async function controlReset(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/reset`);
  expect(res.ok()).toBe(true);
}

async function bootAutonomy(page: Page): Promise<string> {
  await page.goto("/");
  await page.locator("#autonomy-control-status").waitFor({ timeout: 15_000 });
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

interface ApiResult {
  status: number;
  body: unknown;
}

/**
 * Typed hold/release gate reusing the existing e2e route-hold pattern: the
 * route handler awaits `gate` (armed before the click) and both the explicit
 * release and the `finally` release resolve it (resolving twice is a no-op),
 * so no nullable callback slot and no control-flow narrowing are involved.
 */
function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Real same-origin HTTP from the page (real Origin, real JSON routes). */
async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
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
  ) as Promise<ApiResult>;
}

async function createPurposeUi(
  page: Page,
  opts: {
    scope: string;
    statement: string;
    kind: string;
    interpretation?: string;
    validFrom?: string;
    validUntil?: string;
  },
): Promise<void> {
  await page.locator("#autonomy-purpose-scope").fill(opts.scope);
  await page.locator("#autonomy-purpose-statement").fill(opts.statement);
  await page.locator("#autonomy-purpose-kind").selectOption(opts.kind);
  await page
    .locator("#autonomy-purpose-interpretation")
    .fill(opts.interpretation ?? "");
  await page.locator("#autonomy-purpose-valid-from").fill(opts.validFrom ?? "");
  await page
    .locator("#autonomy-purpose-valid-until")
    .fill(opts.validUntil ?? "");
  await page.locator("#autonomy-purpose-form button[type=submit]").click();
  await page
    .locator("#autonomy-purpose-list")
    .getByText(opts.statement)
    .waitFor({ timeout: 15_000 });
  await expect(page.locator("#autonomy-status")).toContainText(
    "目的を記録しました",
  );
}

async function selectPurpose(page: Page, statement: string): Promise<void> {
  await page.locator("#autonomy-purpose-list").getByText(statement).click();
  await page
    .locator("#autonomy-purpose-detail-body")
    .getByText(statement)
    .waitFor({ timeout: 15_000 });
}

async function selectTask(page: Page, title: string): Promise<void> {
  await page.locator("#autonomy-task-list").getByText(title).click();
  await page
    .locator("#autonomy-task-detail-body")
    .getByText(title)
    .waitFor({ timeout: 15_000 });
}

test.beforeEach(async ({ page, request }) => {
  await controlReset(request);
  await bootAutonomy(page);
});

test("statement-only correction preserves kind/scope/interpretation/bounds", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  const from = "2020-01-01T00:00:00+00:00";
  const until = "2030-01-01T00:00:00+00:00";
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui constraint keep window",
    kind: "constraint",
    interpretation: "narrow reading",
    validFrom: from,
    validUntil: until,
  });
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui unrelated goal",
    kind: "goal",
  });

  await selectPurpose(page, "ui constraint keep window");
  await page
    .locator("#autonomy-purpose-correct-input")
    .fill("ui constraint reworded");
  await page.locator("#autonomy-purpose-correct-button").click();
  await expect(page.locator("#autonomy-status")).toContainText(
    "訂正を記録しました",
  );

  const listed = await api(page, "GET", `${base}/purposes?limit=50`);
  expect(listed.status).toBe(200);
  const items = (listed.body as { items: Record<string, unknown>[] }).items;
  const oldRow = items.find(
    (row) => row.statement === "ui constraint keep window",
  );
  const newRow = items.find(
    (row) => row.statement === "ui constraint reworded",
  );
  const goal = items.find((row) => row.statement === "ui unrelated goal");
  expect(oldRow?.status).toBe("superseded");
  expect(newRow?.status).toBe("active");
  // New record preserves every consumer-visible field except the statement.
  expect(newRow?.kind).toBe("constraint");
  expect(newRow?.scope).toBe("work");
  expect(newRow?.interpretation).toBe("narrow reading");
  expect(newRow?.validFrom).toBe(from);
  expect(newRow?.validUntil).toBe(until);
  expect(newRow?.explicit).toBe(true);
  expect(newRow?.sourceKind).toBe("user");
  // Unrelated goal is untouched.
  expect(goal?.status).toBe("active");
  expect(goal?.kind).toBe("goal");
  expect(goal?.version).toBe(1);
});

test("held task resumes only onto an explicit replacement parent", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui parent one",
    kind: "goal",
  });
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui parent two",
    kind: "goal",
  });

  await selectPurpose(page, "ui parent one");
  await page.locator("#autonomy-task-title").fill("ui attached work");
  await page.locator("#autonomy-task-parent-mode").selectOption("attached");
  await page.locator("#autonomy-task-form button[type=submit]").click();
  await page
    .locator("#autonomy-task-list")
    .getByText("ui attached work")
    .waitFor();
  await expect(page.locator("#autonomy-status")).toContainText(
    "作業を記録しました",
  );

  // Correcting the parent supersedes it and holds the dependent task.
  await selectPurpose(page, "ui parent one");
  await page
    .locator("#autonomy-purpose-correct-input")
    .fill("ui parent one reworded");
  await page.locator("#autonomy-purpose-correct-button").click();
  await expect(page.locator("#autonomy-status")).toContainText(
    "訂正を記録しました",
  );
  await expect(
    page.locator("#autonomy-task-list").getByText("held").first(),
  ).toBeVisible();

  // Blind resume (no replacement checked) fails loudly: no auto-reparent.
  await selectTask(page, "ui attached work");
  await page.locator("#autonomy-task-resume-input").fill("blind attempt");
  await page.locator("#autonomy-task-resume-button").click();
  await expect(page.locator("#autonomy-status")).toContainText(
    "他の変更がありました",
  );

  // Explicit replacement: select the new purpose, check the box, resume.
  // (selectPurpose never clears task drafts; the task stays selected.)
  await selectTask(page, "ui attached work");
  await page.locator("#autonomy-task-resume-input").fill("moved to parent two");
  await selectPurpose(page, "ui parent two");
  await page.locator("#autonomy-task-resume-use-parent").check();
  await page.locator("#autonomy-task-resume-button").click();
  await expect(page.locator("#autonomy-status")).toContainText(
    "作業を再開しました",
  );

  const purposes = await api(page, "GET", `${base}/purposes?limit=50`);
  const p2 = (
    (purposes.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.statement === "ui parent two");
  const tasks = await api(page, "GET", `${base}/tasks?limit=50`);
  const task = (
    (tasks.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.title === "ui attached work");
  expect(task?.status).toBe("in_progress");
  expect(task?.scope).toBe("work");
  expect(task?.parentPurposeId).toBe(p2?.id);
});

test("selection clears drafts and late detail responses never restore them", async ({
  page,
}) => {
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui draft A",
    kind: "goal",
  });
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui draft B",
    kind: "goal",
  });

  // Typing a correction for A, then selecting B, clears the A draft.
  await selectPurpose(page, "ui draft A");
  await page.locator("#autonomy-purpose-correct-input").fill("draft for A");
  await selectPurpose(page, "ui draft B");
  expect(
    await page.locator("#autonomy-purpose-correct-input").inputValue(),
  ).toBe("");

  // Hold the real GET detail for A; B must still win, late A must not clobber.
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const purposes = await api(
    page,
    "GET",
    `/api/sessions/${sessionId}/purposes?limit=50`,
  );
  const idA = (
    (purposes.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.statement === "ui draft A")?.id as string;
  expect(typeof idA).toBe("string");
  // Hold the real GET detail for A; B must still win, late A must not clobber.
  // The gate is armed before the click; every exit path releases it.
  const holdA = deferred();
  try {
    await page.route("**/api/sessions/*/purposes/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname.endsWith(`/purposes/${idA}`)
      ) {
        // Deliberately hold the real A detail response until released below.
        await holdA.gate;
      }
      await route.continue();
    });
    // Clicking A re-selects it synchronously (its draft input is cleared)
    // while its real detail GET stays held: the visible detail still shows B.
    const awaitHeldA = page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        new URL(request.url()).pathname.endsWith(`/purposes/${idA}`),
      { timeout: 15_000 },
    );
    await page
      .locator("#autonomy-purpose-list")
      .getByText("ui draft A")
      .click();
    // Deterministic hold: the real A detail GET must be intercepted first.
    await awaitHeldA;
    expect(
      await page.locator("#autonomy-purpose-correct-input").inputValue(),
    ).toBe("");
    await page
      .locator("#autonomy-purpose-correct-input")
      .fill("draft for A again");
    // B's own detail GET passes the route untouched and clears A's draft.
    await selectPurpose(page, "ui draft B");
    expect(
      await page.locator("#autonomy-purpose-correct-input").inputValue(),
    ).toBe("");
    // Release the late A response: it must not restore A's detail or draft.
    holdA.release();
    await page.waitForTimeout(500);
    await expect(page.locator("#autonomy-purpose-detail-body")).toContainText(
      "ui draft B",
    );
    await expect(
      page.locator("#autonomy-purpose-detail-body"),
    ).not.toContainText("ui draft A");
    expect(
      await page.locator("#autonomy-purpose-correct-input").inputValue(),
    ).toBe("");
  } finally {
    // Release every held request, then drop the interception.
    holdA.release();
    await page.unroute("**/api/sessions/*/purposes/*");
  }

  // Same guard for task hold/resume drafts.
  await page.locator("#autonomy-task-parent-mode").selectOption("standalone");
  await page.locator("#autonomy-task-title").fill("ui task X");
  await page.locator("#autonomy-task-form button[type=submit]").click();
  await page.locator("#autonomy-task-list").getByText("ui task X").waitFor();
  await page.locator("#autonomy-task-title").fill("ui task Y");
  await page.locator("#autonomy-task-form button[type=submit]").click();
  await page.locator("#autonomy-task-list").getByText("ui task Y").waitFor();

  await selectTask(page, "ui task X");
  await page.locator("#autonomy-task-hold-input").fill("hold draft X");
  await selectTask(page, "ui task Y");
  expect(await page.locator("#autonomy-task-hold-input").inputValue()).toBe("");
  expect(await page.locator("#autonomy-task-resume-input").inputValue()).toBe(
    "",
  );

  const tasks = await api(
    page,
    "GET",
    `/api/sessions/${sessionId}/tasks?limit=50`,
  );
  const idX = (
    (tasks.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.title === "ui task X")?.id as string;
  // Same guard for task hold/resume drafts; the gate is armed before the click.
  const holdX = deferred();
  try {
    await page.route("**/api/sessions/*/tasks/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname.endsWith(`/tasks/${idX}`)
      ) {
        // Deliberately hold the real X detail response until released below.
        await holdX.gate;
      }
      await route.continue();
    });
    // Same synchronous rebind for tasks: clicking X clears drafts while
    // its real detail GET stays held; the visible detail still shows Y's.
    const awaitHeldX = page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        new URL(request.url()).pathname.endsWith(`/tasks/${idX}`),
      { timeout: 15_000 },
    );
    await page.locator("#autonomy-task-list").getByText("ui task X").click();
    await awaitHeldX;
    expect(await page.locator("#autonomy-task-hold-input").inputValue()).toBe(
      "",
    );
    await page.locator("#autonomy-task-hold-input").fill("hold draft X again");
    await selectTask(page, "ui task Y");
    expect(await page.locator("#autonomy-task-hold-input").inputValue()).toBe(
      "",
    );
    // Release the late X response: it must not restore X's detail or drafts.
    holdX.release();
    await page.waitForTimeout(500);
    await expect(page.locator("#autonomy-task-detail-body")).toContainText(
      "ui task Y",
    );
    expect(await page.locator("#autonomy-task-hold-input").inputValue()).toBe(
      "",
    );
  } finally {
    // Release every held request, then drop the interception.
    holdX.release();
    await page.unroute("**/api/sessions/*/tasks/*");
  }
});

test("stale drafts cannot apply after a backend mutation plus refresh", async ({
  page,
}) => {
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  const base = `/api/sessions/${sessionId}`;
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui version target",
    kind: "goal",
  });

  // Draft typed against v1; the backend corrects the record meanwhile.
  await selectPurpose(page, "ui version target");
  await page
    .locator("#autonomy-purpose-correct-input")
    .fill("ui stale draft must not land");
  const listed = await api(page, "GET", `${base}/purposes?limit=50`);
  const target = (
    (listed.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.statement === "ui version target");
  const corrected = await api(
    page,
    "POST",
    `${base}/purposes/${target?.id}/correct`,
    {
      expectedVersion: 1,
      scope: "work",
      statement: "ui backend reword",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
  );
  expect(corrected.status).toBe(201);

  // A UI refresh picks up the new version while the stale draft is open;
  // the client must invalidate instead of CAS-ing the fresh version.
  // (No reselect: the v1 selection + its draft stay open across refresh.)
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui refresh trigger",
    kind: "goal",
  });
  expect(
    await page.locator("#autonomy-purpose-correct-input").inputValue(),
  ).toBe("ui stale draft must not land");
  await page.locator("#autonomy-purpose-correct-button").click();
  await expect(page.locator("#autonomy-status")).toContainText(
    "他の変更がありました",
  );

  const after = await api(page, "GET", `${base}/purposes?limit=50`);
  const statements = (
    (after.body as { items: Record<string, unknown>[] }).items ?? []
  ).map((row) => row.statement);
  expect(statements).not.toContain("ui stale draft must not land");
  expect(statements).toContain("ui backend reword");

  // Same boundary for a task hold draft: backend start bumps the version,
  // refresh lands it, the old hold reason must never apply to v2.
  await page.locator("#autonomy-task-parent-mode").selectOption("standalone");
  await page.locator("#autonomy-task-title").fill("ui version task");
  await page.locator("#autonomy-task-form button[type=submit]").click();
  await page
    .locator("#autonomy-task-list")
    .getByText("ui version task")
    .waitFor();
  await selectTask(page, "ui version task");
  await page
    .locator("#autonomy-task-hold-input")
    .fill("ui stale hold must not land");
  const taskList = await api(page, "GET", `${base}/tasks?limit=50`);
  const task = (
    (taskList.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.title === "ui version task");
  const started = await api(page, "POST", `${base}/tasks/${task?.id}/start`, {
    expectedVersion: 1,
  });
  expect(started.status).toBe(200);
  await createPurposeUi(page, {
    scope: "work",
    statement: "ui refresh trigger two",
    kind: "goal",
  });
  // No reselect: the v1 task selection + hold draft stay open across refresh.
  expect(await page.locator("#autonomy-task-hold-input").inputValue()).toBe(
    "ui stale hold must not land",
  );
  await page.locator("#autonomy-task-hold-button").click();
  await expect(page.locator("#autonomy-status")).toContainText(
    "他の変更がありました",
  );
  const taskAfter = await api(page, "GET", `${base}/tasks/${task?.id}`);
  expect((taskAfter.body as { status: string }).status).toBe("in_progress");
  expect((taskAfter.body as { holdReason: unknown }).holdReason).toBe(null);
});
