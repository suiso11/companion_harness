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

import { randomUUID } from "node:crypto";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { E2E_APP_ORIGIN, TEXT_OK } from "./ports.js";

const SCOPE = "e2e-autonomy";
const VALID_FROM = "2026-11-01T00:00:00+09:00";
const VALID_UNTIL = "2026-11-30T00:00:00+09:00";

async function api(
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

test("autonomy base: purpose/task lifecycle, guarded resume, stop control, chat accepted", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const sessionId = await sessionIdOf(page);
  const base = `/api/sessions/${sessionId}`;

  // Purpose with a custom scope, explicit goal + validity window.
  const made = await api(request, "post", `${base}/purposes`, {
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
  const corrected = await api(
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
  const oldHistory = await api(
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
  const tasked = await api(request, "post", `${base}/tasks`, {
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
  const held = await api(request, "post", `${base}/tasks/${taskId}/hold`, {
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
  const revoked = await api(
    request,
    "post",
    `${base}/purposes/${currentId}/revoke`,
    { key: randomUUID(), body: { expectedVersion: 1 } },
  );
  expect(revoked.status).toBe(200);
  // Revoking the recorded parent appends a parent_held audit row but keeps
  // the held version: blind resume uses the CURRENT version and fails on
  // state (missing new parent), not on a stale CAS.
  const heldAgain = await api(request, "get", `${base}/tasks/${taskId}`);
  expect(heldAgain.status).toBe(200);
  const heldVersion = (heldAgain.body as { version: number }).version;
  const blind = await api(request, "post", `${base}/tasks/${taskId}/resume`, {
    key: randomUUID(),
    body: {
      expectedVersion: heldVersion,
      evidenceKind: "user_confirmed",
      evidence: "just resume",
    },
  });
  expect(blind.status).toBe(409);
  const replacement = await api(request, "post", `${base}/purposes`, {
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
  const resumed = await api(request, "post", `${base}/tasks/${taskId}/resume`, {
    key: randomUUID(),
    body: {
      expectedVersion: heldVersion,
      evidenceKind: "user_confirmed",
      evidence: "switched plan",
      newParentPurposeId: (replacement.body as { id: string }).id,
    },
  });
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
  const proposals = await api(request, "get", `${base}/proposals`);
  expect(proposals.status).toBe(200);
  expect(
    (proposals.body as { proposals?: unknown[] }).proposals ?? [],
  ).toHaveLength(0);
});

test("autonomy history Load more renders 201 task events losslessly", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const sessionId = await sessionIdOf(page);
  const base = `/api/sessions/${sessionId}`;
  const title = `e2e cycled ${randomUUID()}`;

  const tasked = await api(request, "post", `${base}/tasks`, {
    key: randomUUID(),
    body: { scope: SCOPE, title, kind: "task", speaker: "user" },
  });
  expect(tasked.status).toBe(201);
  const taskId = (tasked.body as { id: string }).id;
  let version = (tasked.body as { version: number }).version;
  // 100 hold/resume cycles => 201 valid events via the real API.
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const held = await api(request, "post", `${base}/tasks/${taskId}/hold`, {
      key: randomUUID(),
      body: {
        expectedVersion: version,
        reason: `waiting ${cycle}`,
        reconsiderTrigger: `signal ${cycle}`,
      },
    });
    expect(held.status).toBe(200);
    version = (held.body as { version: number }).version;
    const resumed = await api(
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
