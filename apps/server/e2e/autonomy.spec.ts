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
// AV autonomy base surface E2E over the production UI/server/core.
//
// No API mocks: every flow drives the REAL Hono app + real kernel DB +
// production UI. Fixture setup (purposes/tasks/cycles) uses the real
// autonomy HTTP routes via the Node-side `request` fixture (never
// page.fetch, never mocked responses); the browser then exercises the real
// AutonomyPanel, including history Load more.
//
// Covers (base-only, no v12 executions / pi bridge):
// (1) purpose with a custom scope, explicit goal + validity window,
//     correction vs original history + pagination cursor contract,
//     task hold with separate reason/trigger, revoked parent blocks resume
//     until a NEW active same-scope parent is supplied, Stop/reopen while
//     normal chat stays accepted, and zero proposal/action writes;
// (2) history Load more with 201 task events (100 hold/resume cycles via
//     the real API) renders exactly all ordered distinct events.

// UNION NOTE: both suites kept verbatim (renamed api helpers only).
import { randomUUID } from "node:crypto";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { E2E_APP_ORIGIN, E2E_CONTROL_ORIGIN, TEXT_OK } from "./ports.js";

async function controlReset(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}/reset`);
  expect(res.ok()).toBe(true);
}

async function bootAutonomy(page: Page): Promise<string> {
  await page.goto("/tasks");
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
async function pageApi(
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

const SCOPE = "e2e-autonomy";
const VALID_FROM = "2026-11-01T00:00:00+09:00";
const VALID_UNTIL = "2026-11-30T00:00:00+09:00";

async function nodeApi(
  request: APIRequestContext,
  method: "get" | "post",
  path: string,
  options?: { body?: unknown; key?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options?.key !== undefined) {
    headers["idempotency-key"] = options.key;
  }
  const res =
    method === "get"
      ? await request.get(`${E2E_APP_ORIGIN}${path}`, { headers })
      : await request.post(`${E2E_APP_ORIGIN}${path}`, {
          headers,
          data: options?.body ?? {},
        });
  const body = (await res.json()) as unknown;
  return { status: res.status(), body };
}

async function sessionIdOf(page: Page): Promise<string> {
  await expect(page.locator("#composer")).toBeVisible();
  const id = await page.evaluate((): string | null => {
    try {
      return localStorage.getItem("ch.sessionId");
    } catch {
      return null;
    }
  });
  expect(id).not.toBeNull();
  return id as string;
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

  const listed = await pageApi(page, "GET", `${base}/purposes?limit=50`);
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

  const purposes = await pageApi(page, "GET", `${base}/purposes?limit=50`);
  const p2 = (
    (purposes.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.statement === "ui parent two");
  const tasks = await pageApi(page, "GET", `${base}/tasks?limit=50`);
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
  const purposes = await pageApi(
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

  const tasks = await pageApi(
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
  const listed = await pageApi(page, "GET", `${base}/purposes?limit=50`);
  const target = (
    (listed.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.statement === "ui version target");
  const corrected = await pageApi(
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

  const after = await pageApi(page, "GET", `${base}/purposes?limit=50`);
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
  const taskList = await pageApi(page, "GET", `${base}/tasks?limit=50`);
  const task = (
    (taskList.body as { items: Record<string, unknown>[] }).items ?? []
  ).find((row) => row.title === "ui version task");
  const started = await pageApi(
    page,
    "POST",
    `${base}/tasks/${task?.id}/start`,
    {
      expectedVersion: 1,
    },
  );
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
  const taskAfter = await pageApi(page, "GET", `${base}/tasks/${task?.id}`);
  expect((taskAfter.body as { status: string }).status).toBe("in_progress");
  expect((taskAfter.body as { holdReason: unknown }).holdReason).toBe(null);
});

test("autonomy base: purpose/task lifecycle, guarded resume, stop control, chat accepted", async ({
  page,
  request,
}) => {
  await page.goto("/tasks");
  const sessionId = await sessionIdOf(page);
  const base = `/api/sessions/${sessionId}`;

  // Purpose with a custom scope, explicit goal + validity window.
  const made = await nodeApi(request, "post", `${base}/purposes`, {
    key: randomUUID(),
    body: {
      scope: SCOPE,
      statement: "e2e walk daily",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
    },
  });
  expect(made.status).toBe(201);
  const purposeId = (made.body as { id: string }).id;
  expect((made.body as { scope: string }).scope).toBe(SCOPE);

  // Correction vs original: the old record keeps its history trail.
  const corrected = await nodeApi(
    request,
    "post",
    `${base}/purposes/${purposeId}/correct`,
    {
      key: randomUUID(),
      body: {
        expectedVersion: 1,
        scope: SCOPE,
        statement: "e2e walk twice daily",
        kind: "goal",
        explicit: true,
        sourceKind: "user",
      },
    },
  );
  expect(corrected.status).toBe(201);
  const currentId = (corrected.body as { current: { id: string } }).current.id;
  const oldHistory = await nodeApi(
    request,
    "get",
    `${base}/purposes/${purposeId}/history`,
  );
  expect(oldHistory.status).toBe(200);
  expect(
    (oldHistory.body as { events: { event: string }[] }).events.map(
      (event) => event.event,
    ),
  ).toEqual(["created", "superseded"]);
  expect(
    (oldHistory.body as { nextAfterSeq: unknown }).nextAfterSeq,
  ).toBeNull();

  // Task hold with a separate reason + reconsider trigger.
  const tasked = await nodeApi(request, "post", `${base}/tasks`, {
    key: randomUUID(),
    body: {
      scope: SCOPE,
      title: "e2e morning run",
      kind: "task",
      speaker: "user",
      parentPurposeId: currentId,
    },
  });
  expect(tasked.status).toBe(201);
  const taskId = (tasked.body as { id: string }).id;
  const held = await nodeApi(request, "post", `${base}/tasks/${taskId}/hold`, {
    key: randomUUID(),
    body: {
      expectedVersion: 1,
      reason: "waiting for dry weather",
      reconsiderTrigger: "forecast clears",
    },
  });
  expect(held.status).toBe(200);
  expect((held.body as { holdReason: string }).holdReason).toBe(
    "waiting for dry weather",
  );
  expect((held.body as { reconsiderTrigger: string }).reconsiderTrigger).toBe(
    "forecast clears",
  );

  // Revoked parent blocks blind resume until a NEW active same-scope parent.
  const revoked = await nodeApi(
    request,
    "post",
    `${base}/purposes/${currentId}/revoke`,
    { key: randomUUID(), body: { expectedVersion: 1 } },
  );
  expect(revoked.status).toBe(200);
  // Revoking the recorded parent appends a parent_held audit row but keeps
  // the held version: blind resume uses the CURRENT version and fails on
  // state (missing new parent), not on a stale CAS.
  const heldAgain = await nodeApi(request, "get", `${base}/tasks/${taskId}`);
  expect(heldAgain.status).toBe(200);
  const heldVersion = (heldAgain.body as { version: number }).version;
  const blind = await nodeApi(
    request,
    "post",
    `${base}/tasks/${taskId}/resume`,
    {
      key: randomUUID(),
      body: {
        expectedVersion: heldVersion,
        evidenceKind: "user_confirmed",
        evidence: "just resume",
      },
    },
  );
  expect(blind.status).toBe(409);
  const replacement = await nodeApi(request, "post", `${base}/purposes`, {
    key: randomUUID(),
    body: {
      scope: SCOPE,
      statement: "e2e walk weekly",
      kind: "preference",
      explicit: true,
      sourceKind: "user",
    },
  });
  expect(replacement.status).toBe(201);
  const resumed = await nodeApi(
    request,
    "post",
    `${base}/tasks/${taskId}/resume`,
    {
      key: randomUUID(),
      body: {
        expectedVersion: heldVersion,
        evidenceKind: "user_confirmed",
        evidence: "switched plan",
        newParentPurposeId: (replacement.body as { id: string }).id,
      },
    },
  );
  expect(resumed.status).toBe(200);

  // The panel lists the recorded purpose; selecting it shows the detail.
  await page.reload();
  await expect(page.locator("#autonomy")).toBeVisible();
  await expect(page.locator("#autonomy-purpose-list")).toContainText(
    "e2e walk weekly",
    { timeout: 15_000 },
  );

  // Stop/reopen: control flips via the real buttons while chat stays usable.
  await expect(page.locator("#autonomy-control-status")).toContainText(
    "停止中",
    { timeout: 15_000 },
  );
  await page.locator("#composer-input").fill(TEXT_OK);
  await page.locator("#composer-send").click();
  await expect(page.locator("#conversation")).toContainText(`echo:${TEXT_OK}`, {
    timeout: 15_000,
  });
  await page.locator("#autonomy-resume-button").click();
  await expect(page.locator("#autonomy-control-status")).toContainText(
    "再開されています",
    { timeout: 15_000 },
  );
  await page.locator("#autonomy-stop-button").click();
  await expect(page.locator("#autonomy-control-status")).toContainText(
    "停止中",
    { timeout: 15_000 },
  );

  // Zero calendar/model/write effects: no proposals staged, no executions.
  const proposals = await nodeApi(request, "get", `${base}/proposals`);
  expect(proposals.status).toBe(200);
  expect(
    (proposals.body as { proposals?: unknown[] }).proposals ?? [],
  ).toHaveLength(0);
});

test("autonomy history Load more renders 201 task events losslessly", async ({
  page,
  request,
}) => {
  await page.goto("/tasks");
  const sessionId = await sessionIdOf(page);
  const base = `/api/sessions/${sessionId}`;
  const title = `e2e cycled ${randomUUID()}`;

  const tasked = await nodeApi(request, "post", `${base}/tasks`, {
    key: randomUUID(),
    body: { scope: SCOPE, title, kind: "task", speaker: "user" },
  });
  expect(tasked.status).toBe(201);
  const taskId = (tasked.body as { id: string }).id;
  let version = (tasked.body as { version: number }).version;
  // 100 hold/resume cycles => 201 valid events via the real API.
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const held = await nodeApi(
      request,
      "post",
      `${base}/tasks/${taskId}/hold`,
      {
        key: randomUUID(),
        body: {
          expectedVersion: version,
          reason: `waiting ${cycle}`,
          reconsiderTrigger: `signal ${cycle}`,
        },
      },
    );
    expect(held.status).toBe(200);
    version = (held.body as { version: number }).version;
    const resumed = await nodeApi(
      request,
      "post",
      `${base}/tasks/${taskId}/resume`,
      {
        key: randomUUID(),
        body: {
          expectedVersion: version,
          evidenceKind: "user_confirmed",
          evidence: `signal arrived ${cycle}`,
        },
      },
    );
    expect(resumed.status).toBe(200);
    version = (resumed.body as { version: number }).version;
  }

  // Open the task in the real panel: the first page renders bounded.
  await page.reload();
  await expect(page.locator("#autonomy-task-list")).toContainText(title, {
    timeout: 15_000,
  });
  await page
    .locator("#autonomy-task-list")
    .getByRole("button", { name: title })
    .click();
  await expect(page.locator("#autonomy-task-detail")).toBeVisible();
  const detail = page.locator("#autonomy-task-detail-body");
  await expect(detail).toContainText("#1 created", { timeout: 15_000 });
  const more = page.locator("#autonomy-task-history-more-button");
  await expect(more).toBeVisible();

  // Load more until the cursor exhausts: every page appends, never rewrites.
  for (let round = 0; round < 10; round += 1) {
    if (!(await more.isVisible())) {
      break;
    }
    await more.click();
    await page.waitForTimeout(300);
  }
  await expect(more).toBeHidden({ timeout: 15_000 });
  const text = (await detail.textContent()) ?? "";
  const seqs = Array.from(text.matchAll(/#(\d+) /g), (match) =>
    Number(match[1]),
  );
  expect(seqs).toHaveLength(201);
  expect(seqs).toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
});
