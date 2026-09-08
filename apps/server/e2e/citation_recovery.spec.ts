// Bounded M3 acceptance slice: citation drawer + lost-response recovery.
//
// Real browser over the production UI/server/core (no API mocks). The
// deterministic fake RunStrategy (e2e/server.ts) chooses behavior from the
// input text only (ports.ts TEXT_*). Failure injection and fixture seeding
// use the loopback-only control server via the Node-side `request` fixture
// (never page.fetch, never mocked responses). Browser network interception
// (`page.route` + `route.fetch()` + `route.abort()`) is used ONLY to
// simulate a lost delivery AFTER the real API persisted — the replay and
// reload assertions then run against the real stored idempotency record.

import { expect, type Page, test } from "@playwright/test";
import {
  CITATION_SNAPSHOT_TEXT,
  E2E_APP_ORIGIN,
  E2E_CONTROL_ORIGIN,
  TEXT_CITE,
  TEXT_OK,
} from "./ports.js";

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/arm-fail" | "/release" | "/reset",
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function sessionIdOf(page: Page): Promise<string> {
  const id = await page.evaluate((): string | null =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof id).toBe("string");
  expect(id === null || id.length > 0).toBe(true);
  return id as string;
}

async function storedLocalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) {
        out[key] = localStorage.getItem(key) ?? "";
      }
    }
    return out;
  });
}

test.beforeEach(async ({ page, request }) => {
  await control(request, "/reset");
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  await control(request, "/release");
});

test("citation drawer shows the escaped stored snapshot and CAS-selects it (stale PUT conflicts)", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);
  const seedRes = await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
    data: { sessionId },
  });
  expect(seedRes.ok()).toBe(true);
  const seed = (await seedRes.json()) as {
    referenceId: string;
    ordinal: number;
    snapshotId: string;
  };
  expect(seed.ordinal).toBe(1);

  await page.locator("#composer-input").fill(TEXT_CITE);
  await page.locator("#composer-send").click();
  const citeButton = page.getByRole("button", { name: "r1" });
  await expect(citeButton).toBeVisible({ timeout: 15_000 });

  await citeButton.click();
  const drawer = page.locator("#drawer");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  // Escaped plain text only: the exact stored body, no HTML interpretation.
  await expect(page.locator("#drawer-body")).toHaveText(
    CITATION_SNAPSHOT_TEXT,
    { timeout: 15_000 },
  );
  expect(await page.locator("#drawer-body script").count()).toBe(0);
  const inner = await page.locator("#drawer-body").innerHTML();
  expect(inner).not.toContain("<script");

  // Opening the citation CAS-selected it: the real context now holds it.
  const ctxRes = await request.get(
    `${E2E_APP_ORIGIN}/api/sessions/${sessionId}/reference-context`,
  );
  expect(ctxRes.ok()).toBe(true);
  const ctx = (await ctxRes.json()) as { version: number; items: string[] };
  expect(ctx.items).toContain(seed.referenceId);
  expect(ctx.version).toBeGreaterThanOrEqual(2);

  // Stale expected version conflicts instead of silently losing the update.
  const stale = await request.put(
    `${E2E_APP_ORIGIN}/api/sessions/${sessionId}/reference-context`,
    { data: { version: 1, items: [] } },
  );
  expect(stale.status()).toBe(409);
  const staleBody = (await stale.json()) as {
    error?: { code?: string };
  };
  expect(staleBody.error?.code).toBe("reference_version_conflict");

  // Bodies and snapshot text are never kept in browser storage.
  const stored = await storedLocalStorage(page);
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
  }
  expect(JSON.stringify(stored)).not.toContain(CITATION_SNAPSHOT_TEXT);
});

test("lost delivery replays the same frozen key and reload recovers the answer", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);

  // Let the real API persist, then hide the delivery from the page: the
  // server already stored the accepted 202 before route.abort() drops it.
  interface LostDelivery {
    key: string;
    body: string;
    status: number;
    turnId: string;
    runId: string;
  }
  let captured: LostDelivery | null = null;
  let abortedOnce = false;
  await page.route("**/api/sessions/*/messages", async (route) => {
    if (abortedOnce) {
      await route.continue();
      return;
    }
    abortedOnce = true;
    const response = await route.fetch();
    const status = response.status();
    let payload: { turnId?: unknown; run?: { id?: unknown } } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    captured = {
      key: (await route.request().headerValue("idempotency-key")) ?? "",
      body: route.request().postData() ?? "",
      status,
      turnId: typeof payload.turnId === "string" ? payload.turnId : "",
      runId:
        typeof payload.run === "object" &&
        payload.run !== null &&
        typeof (payload.run as { id?: unknown }).id === "string"
          ? (payload.run as { id: string }).id
          : "",
    };
    await route.abort("failed");
  });

  await page.locator("#composer-input").fill(TEXT_OK);
  await page.locator("#composer-send").click();
  await expect(page.locator("#composer-notice")).toContainText(
    "送信できませんでした",
    { timeout: 15_000 },
  );
  expect(captured).not.toBe(null);
  if (captured === null) {
    throw new Error("lost delivery was not intercepted");
  }
  const lost: LostDelivery = captured;
  expect(lost.status).toBe(202);
  expect(lost.key.length).toBeGreaterThan(0);
  expect(lost.turnId.length).toBeGreaterThan(0);
  expect(lost.runId.length).toBeGreaterThan(0);

  // The frozen key survives the loss (memory + persisted pending slot).
  const pending = await page.evaluate((): string | null =>
    localStorage.getItem("ch.pendingKey"),
  );
  expect(pending).toBe(lost.key);

  // Same frozen key + identical body replays the stored accepted response
  // through the real route (no production behavior replaced).
  const replay = await request.post(
    `${E2E_APP_ORIGIN}/api/sessions/${sessionId}/messages`,
    {
      headers: {
        "content-type": "application/json",
        "idempotency-key": lost.key,
      },
      data: JSON.parse(lost.body) as unknown,
    },
  );
  expect(replay.status()).toBe(202);
  const replayBody = (await replay.json()) as {
    turnId?: unknown;
    run?: { id?: unknown };
  };
  expect(replayBody.turnId).toBe(lost.turnId);
  const replayRun = replayBody.run as { id?: unknown } | undefined;
  expect(replayRun?.id).toBe(lost.runId);

  // Reload recovery: the accepted key replays status/body via lookup and
  // the history refreshes, so the answer renders without resending.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#conversation")).toContainText(`echo:${TEXT_OK}`, {
    timeout: 15_000,
  });
  await expect(page.locator("#composer-send")).toBeEnabled();
  const pendingAfter = await page.evaluate((): string | null =>
    localStorage.getItem("ch.pendingKey"),
  );
  expect(pendingAfter).toBe(null);

  const stored = await storedLocalStorage(page);
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
  }
  expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_OK}`);
});

test("reload with an unknown pending key asks for resend without recreating", async ({
  page,
}) => {
  await sessionIdOf(page);
  const fakeKey = await page.evaluate((): string => {
    const key = crypto.randomUUID();
    localStorage.setItem("ch.pendingKey", key);
    return key;
  });
  expect(fakeKey.length).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  // Missing lookup: fixed resend-required prompt, never recreated server-side.
  await expect(page.locator("#composer-notice")).toContainText(
    "送信を再入力してください",
    { timeout: 15_000 },
  );
  const pendingAfter = await page.evaluate((): string | null =>
    localStorage.getItem("ch.pendingKey"),
  );
  expect(pendingAfter).toBe(null);
  await expect(page.locator("#composer-send")).toBeEnabled();
});
