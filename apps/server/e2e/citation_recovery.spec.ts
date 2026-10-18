// Bounded M3 acceptance slice: citation drawer + lost-response recovery +
// C06 accepted-202 active reload recovery.
//
// Real browser over the production UI/server/core (no API mocks). The
// deterministic fake RunStrategy (e2e/server.ts) chooses behavior from the
// input text only (ports.ts TEXT_*). Failure injection and fixture seeding
// use the loopback-only control server via the Node-side `request` fixture
// (never page.fetch, never mocked responses). Browser network interception
// (`page.route` + `route.fetch()` + `route.continue/fulfill/abort`) is used
// ONLY to gate genuine responses after the real API persisted — held and
// forwarded responses are the real unchanged upstream payloads (or the
// honest late forward, which may truthfully return `run:null`), and the
// reload/resubscription assertions run against the real produce/pipeline.

import { expect, type Page, test } from "@playwright/test";
import {
  CITATION_SNAPSHOT_TEXT,
  CITATION_SNAPSHOT_TEXT_B,
  E2E_APP_ORIGIN,
  E2E_CONTROL_ORIGIN,
  TEXT_CITE,
  TEXT_CITE_MEM,
  TEXT_CITE_TWO,
  TEXT_HANG,
  TEXT_OK,
} from "./ports.js";
import {
  canonical,
  nativeRunDeliveries,
  observeNativeRunDeliveries,
} from "./resilience.js";

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/arm-fail" | "/arm-cancel-hold" | "/release" | "/reset",
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function sessionIdOf(page: Page): Promise<string> {
  // The composer is visible/enabled from the static HTML before the async
  // boot finishes POST /api/sessions, so localStorage may still be empty on
  // a cold start. Wait for the real session-establishment signal (the UI
  // writing ch.sessionId) instead of asserting the immediate value.
  await page.waitForFunction(
    (): boolean => {
      try {
        const value = localStorage.getItem("ch.sessionId");
        return value !== null && value.length > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15_000 },
  );
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

  // Bodies and snapshot text are never kept in browser storage: assert the
  // raw stored values directly against the seeded sensitive snapshot text.
  // JSON.stringify would escape its embedded quotes and make the check
  // vacuously true, so it must not be used here.
  const stored = await storedLocalStorage(page);
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
    expect(stored[key] ?? "").not.toContain(CITATION_SNAPSHOT_TEXT);
  }
});

test("citation drawer surfaces a genuine concurrent 409, refetches, and still opens the saved citation", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);
  const seedRes = await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
    data: { sessionId },
  });
  expect(seedRes.ok()).toBe(true);
  const refA = (await seedRes.json()) as {
    referenceId: string;
    ordinal: number;
  };
  expect(refA.ordinal).toBe(1);

  await page.locator("#composer-input").fill(TEXT_CITE);
  await page.locator("#composer-send").click();
  const citeButton = page.getByRole("button", { name: "r1" });
  await expect(citeButton).toBeVisible({ timeout: 15_000 });

  // Force a genuine stale PUT inside the drawer CAS: hold the browser's
  // first conditional PUT, commit a concurrent real selection of the SAME
  // citation (version 1 -> 2) via the Node-side API, then forward the held
  // PUT unchanged so the real server answers 409
  // reference_version_conflict. The recovery runs unintercepted against the
  // real routes. No payload is fabricated.
  let totalPuts = 0;
  let firstPutHeld = false;
  let observedConflict = 0;
  await page.route("**/api/sessions/*/reference-context", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    totalPuts += 1;
    if (firstPutHeld) {
      await route.continue();
      return;
    }
    firstPutHeld = true;
    const bump = await request.put(
      `${E2E_APP_ORIGIN}/api/sessions/${sessionId}/reference-context`,
      { data: { version: 1, items: [refA.referenceId] } },
    );
    expect(bump.ok()).toBe(true);
    const genuine = await route.fetch();
    if (genuine.status() === 409) {
      observedConflict += 1;
    }
    await route.fulfill({ response: genuine });
  });
  try {
    await citeButton.click();

    // The fixed conflict notice from the changed 409 branch is visible.
    await expect(page.locator("#composer-notice")).toContainText(
      "参照の更新で競合しました。最新の状態を取得しています",
      { timeout: 15_000 },
    );
    // Recovery still opens the saved citation as escaped plain text.
    const drawer = page.locator("#drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT,
      { timeout: 15_000 },
    );
  } finally {
    await page.unroute("**/api/sessions/*/reference-context");
  }
  // The held PUT genuinely conflicted exactly once on the real server.
  expect(firstPutHeld).toBe(true);
  expect(observedConflict).toBe(1);

  // CAS recovery re-read and merged instead of losing the update: the
  // latest context holds the single selected citation with no duplicates,
  // committed past the conflicted version. Recovery issued no second PUT:
  // the re-read found the citation already selected, so exactly one PUT
  // (the conflicted one) ever reached the server.
  const ctxRes = await request.get(
    `${E2E_APP_ORIGIN}/api/sessions/${sessionId}/reference-context`,
  );
  expect(ctxRes.ok()).toBe(true);
  const ctx = (await ctxRes.json()) as { version: number; items: string[] };
  expect(ctx.version).toBeGreaterThanOrEqual(2);
  expect(ctx.items).toEqual([refA.referenceId]);
  expect(totalPuts).toBe(1);

  // No duplicate citation rendering and no unsafe browser storage effects.
  await expect(page.getByRole("button", { name: "r1" })).toHaveCount(1);
  await expect(
    page.locator("#conversation").getByText("cited answer", { exact: true }),
  ).toHaveCount(1);
  const storedAfter409 = await storedLocalStorage(page);
  for (const key of Object.keys(storedAfter409)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
    expect(storedAfter409[key] ?? "").not.toContain(CITATION_SNAPSHOT_TEXT);
  }
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

/* ------------------------------------------------------------------ */
/* C06 accepted-202 active reload recovery                              */
/*                                                                      */
/* Distinct from the lost-delivery case above: a genuinely accepted 202  */
/* whose pending key was already cleared and whose canonical Run is      */
/* running. The reload must recover through the real discovery/status/  */
/* events/SSE pipeline — never a mutation POST, retry, or cancel, and   */
/* never any new storage fields. All held HTTP is genuine forwarding    */
/* (route.fetch/continue/fulfill), never a fabricated payload.          */
/* ------------------------------------------------------------------ */

/**
 * Start a real TEXT_HANG run inside the current page via the production
 * send path: 202 delivered, pending key already cleared, strategy holding.
 */
async function acceptedHangRun(page: Page): Promise<{
  sessionId: string;
  runId: string;
  turnId: string;
}> {
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/messages") &&
      response.request().method() === "POST",
  );
  await page.locator("#composer-input").fill(TEXT_HANG);
  await page.locator("#composer-send").click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const body = (await response.json()) as {
    run: { id: string };
    turnId: string;
  };
  const sessionId = await sessionIdOf(page);
  await expect
    .poll(() =>
      page.evaluate((): string | null => localStorage.getItem("ch.pendingKey")),
    )
    .toBe(null);
  return { sessionId, runId: body.run.id, turnId: body.turnId };
}

/** POST /messages, /retries, and /cancel observation (reload mutations). */
function observeMutations(page: Page): { requests: string[] } {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      (url.pathname.endsWith("/messages") ||
        url.pathname.endsWith("/retries") ||
        url.pathname.endsWith("/cancel"))
    ) {
      requests.push(url.pathname);
    }
  });
  return { requests };
}

async function canonicalRunStatus(
  request: import("@playwright/test").APIRequestContext,
  sessionId: string,
  runId: string,
): Promise<{ run: { status: string; eventSeq: number }; types: string[] }> {
  const c = await canonical(request, sessionId, runId);
  return {
    // The status endpoint's run projection also carries `id` (RunStatusResponseSchema);
    // poll here compares only the projection this helper declares.
    run: { status: c.run.status, eventSeq: c.run.eventSeq },
    types: c.events.map((event) => event.type),
  };
}

/** Safe event type from a native delivery payload (null when unparseable). */
function deliveryType(delivery: { data: string }): string | null {
  try {
    const parsed = JSON.parse(delivery.data) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

test("C06: active reload resubscribes natively and releases the held strategy to exactly one answer", async ({
  page,
  request,
}) => {
  // Passive observation only (init script applies from the next reload on).
  await observeNativeRunDeliveries(page);
  const { sessionId, runId } = await acceptedHangRun(page);
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "running", eventSeq: 2 },
      types: ["run.queued", "run.started"],
    });

  const mutations = observeMutations(page);
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  // Same recovered session: discovery never recreates or swaps the session,
  // and no pending key reappears for a recovery that never mutates.
  expect(await sessionIdOf(page)).toBe(sessionId);
  expect(
    await page.evaluate((): string | null =>
      localStorage.getItem("ch.pendingKey"),
    ),
  ).toBe(null);
  // Discovery recovers the active run: Send disabled, Stop visible.
  await expect(page.locator("#composer-send")).toBeDisabled();
  await expect(page.locator("#composer-stop")).toBeVisible();
  expect(mutations.requests).toEqual([]);

  // Release the actually held TEXT_HANG strategy.
  await control(request, "/release");
  // Canonical terminal: status completed, 3 events, one run.completed.
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "completed", eventSeq: 3 },
      types: ["run.queued", "run.started", "run.completed"],
    });
  // The terminal was delivered on a REAL native resubscription: deliveries
  // observed post-reload come from a fresh same-native EventSource target.
  await expect
    .poll(
      async () =>
        (await nativeRunDeliveries(page, runId)).filter(
          (delivery) => deliveryType(delivery) === "run.completed",
        ).length,
    )
    .toBeGreaterThan(0);
  const terminalDeliveries = await nativeRunDeliveries(page, runId);
  for (const delivery of terminalDeliveries) {
    expect(delivery.sameNativeTarget).toBe(true);
  }
  // One owner/terminal callback: every run.completed delivery came from a
  // single subscribed native EventSource (no duplicate subscription).
  const completedDeliveries = terminalDeliveries.filter(
    (delivery) => deliveryType(delivery) === "run.completed",
  );
  expect(
    new Set(completedDeliveries.map((delivery) => delivery.sourceId)).size,
  ).toBe(1);

  // Exactly one user turn and one UI answer; the composer is released.
  await expect(
    page.locator("#conversation").getByText(TEXT_HANG, { exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#composer-stop")).toBeHidden();
  expect(mutations.requests).toEqual([]);

  // No reload mutation POST/retry/cancel and no storage expansion, and the
  // answer body never persists in browser storage.
  const stored = await storedLocalStorage(page);
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
  }
  expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_HANG}`);
});

test("C06: discovery held past completion forwards the genuine null and history recovers once", async ({
  page,
  request,
}) => {
  const { sessionId, runId } = await acceptedHangRun(page);
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "running", eventSeq: 2 },
      types: ["run.queued", "run.started"],
    });

  // Hold discovery (do not forward) until the strategy actually completed.
  // Defaulted so a setup failure can never strand the in-flight request.
  let holdDiscovery: () => void = () => {};
  const discoveryHeld = new Promise<void>((resolve) => {
    holdDiscovery = resolve;
  });
  let discoveryRequests = 0;
  let forwarded: { status: number; body: string } | null = null;
  await page.route("**/api/sessions/*/active-run", async (route) => {
    discoveryRequests += 1;
    await discoveryHeld;
    // Genuine forwarding: capture the real upstream response bytes so the
    // test itself observes the truthful body — a completed run answers a
    // genuine 200 `{run:null}`; nothing is fabricated here.
    const response = await route.fetch();
    forwarded = {
      status: response.status(),
      body: await response.text(),
    };
    await route.fulfill({
      status: forwarded.status,
      contentType: response.headers()["content-type"] ?? "application/json",
      body: forwarded.body,
    });
  });
  const mutations = observeMutations(page);
  try {
    // domcontentloaded: the held discovery fetch must never block settling
    // the reload navigation itself.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => discoveryRequests).toBeGreaterThanOrEqual(1);

    // Boot is held on discovery: no answer rendered yet, no mutations fired.
    await expect(
      page
        .locator("#conversation")
        .getByText(`echo:${TEXT_HANG}`, { exact: true }),
    ).toHaveCount(0);
    expect(mutations.requests).toEqual([]);

    // Release the strategy; the run completes while the discovery request is
    // still held.
    await control(request, "/release");
    await expect
      .poll(async () => (await canonical(request, sessionId, runId)).run.status)
      .toBe("completed");
    expect((await canonical(request, sessionId, runId)).run.eventSeq).toBe(3);

    // Forwarding now: the real discovery answer is null, so the one final
    // history hydration must recover the completed answer.
    holdDiscovery();
    await expect(
      page
        .locator("#conversation")
        .getByText(`echo:${TEXT_HANG}`, { exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("#composer-send")).toBeEnabled();
    expect(mutations.requests).toEqual([]);

    // Explicitly observe the forwarded genuine payload: a real 200 with the
    // truthful `{run:null}` (the late forward, not a fabricated marker).
    const observed = forwarded as { status: number; body: string } | null;
    expect(observed).not.toBe(null);
    expect(observed?.status).toBe(200);
    expect((JSON.parse(observed?.body ?? "null") as { run: unknown }).run).toBe(
      null,
    );
  } finally {
    // Release the gate (a no-op if the test body already did) and the held
    // strategy, unroute, and settle the reload so no request is stranded.
    holdDiscovery();
    await request.post(`${E2E_CONTROL_ORIGIN}/release`).catch(() => undefined);
    await page.unroute("**/api/sessions/*/active-run").catch(() => undefined);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
    } catch {
      // Navigation already settled or the page failed: nothing to strand.
    }
  }

  const stored = await storedLocalStorage(page);
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
  }
  expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_HANG}`);
});

test("C06: captured-active held until completion keeps the terminal replay at exactly one answer", async ({
  page,
  request,
}) => {
  await observeNativeRunDeliveries(page);
  const { sessionId, runId, turnId } = await acceptedHangRun(page);
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "running", eventSeq: 2 },
      types: ["run.queued", "run.started"],
    });

  // Capture the REAL active-run response once (still running), then
  // withhold it until the strategy completed and forward it unchanged.
  // Defaulted so a setup failure can never strand the in-flight request.
  let holdCaptured: () => void = () => {};
  const capturedHeld = new Promise<void>((resolve) => {
    holdCaptured = resolve;
  });
  let capturedOnce = false;
  await page.route("**/api/sessions/*/active-run", async (route) => {
    expect(capturedOnce).toBe(false);
    // Signal only after the genuine response was fully fetched; capture
    // reads the real upstream body so the test verifies what it forwards.
    const response = await route.fetch();
    const capturedNow: { status: number; contentType: string; body: string } = {
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "application/json",
      body: await response.text(),
    };
    expect(capturedNow.status).toBe(200);
    const payload = JSON.parse(capturedNow.body) as {
      run: { id: string; turnId: string; status: string } | null;
    };
    // The captured proactive response is a genuine ACTIVE projection.
    expect(payload.run).not.toBeNull();
    expect(payload.run?.id).toBe(runId);
    expect(payload.run?.turnId).toBe(turnId);
    expect(payload.run?.status).toBe("running");
    capturedOnce = true;
    await capturedHeld;
    await route.fulfill({
      status: capturedNow.status,
      contentType: capturedNow.contentType,
      body: capturedNow.body,
    });
  });
  const mutations = observeMutations(page);
  try {
    // domcontentloaded: the (later) held captured fetch must never block
    // settling this reload navigation.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => capturedOnce).toBe(true);

    // The run completes while the captured response is still withheld.
    await control(request, "/release");
    await expect
      .poll(async () => (await canonical(request, sessionId, runId)).run.status)
      .toBe("completed");
    expect((await canonical(request, sessionId, runId)).run.eventSeq).toBe(3);

    // Forward the unchanged captured response: boot maps the captured run
    // turn, hydrates history once (dedup anchor), and subscribes the
    // captured ID. Prove the terminal replay arrived through a REAL native
    // resubscription of the captured run BEFORE the final one-answer claim
    // (polled: the SSE frame can land slightly after the terminal
    // transaction).
    holdCaptured();
    await expect
      .poll(
        async () =>
          (await nativeRunDeliveries(page, runId)).filter(
            (delivery) => deliveryType(delivery) === "run.completed",
          ).length,
      )
      .toBeGreaterThan(0);
    const terminalDeliveries = await nativeRunDeliveries(page, runId);
    for (const delivery of terminalDeliveries) {
      expect(delivery.sameNativeTarget).toBe(true);
    }
    expect(
      new Set(
        terminalDeliveries
          .filter((delivery) => deliveryType(delivery) === "run.completed")
          .map((delivery) => delivery.sourceId),
      ).size,
    ).toBe(1);

    // The terminal replay was already proven above: the UI answer renders
    // exactly once (dedup anchor), and the composer is released.
    await expect(
      page
        .locator("#conversation")
        .getByText(`echo:${TEXT_HANG}`, { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.locator("#conversation").getByText(TEXT_HANG, { exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("#composer-send")).toBeEnabled();
    await expect(page.locator("#composer-stop")).toBeHidden();
    expect(mutations.requests).toEqual([]);
  } finally {
    // Release the gate (a no-op if the test body already did) and the held
    // strategy, unroute, and settle the reload so no request is stranded.
    holdCaptured();
    await request.post(`${E2E_CONTROL_ORIGIN}/release`).catch(() => undefined);
    await page.unroute("**/api/sessions/*/active-run").catch(() => undefined);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
    } catch {
      // Navigation already settled or the page failed: nothing to strand.
    }
  }

  const stored = await storedLocalStorage(page);
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
  }
  expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_HANG}`);
});

test("C06: SSE-blocked reload falls back to a JSON replay from the reducer cursor and still lands exactly one answer", async ({
  page,
  request,
}) => {
  const { sessionId, runId } = await acceptedHangRun(page);
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "running", eventSeq: 2 },
      types: ["run.queued", "run.started"],
    });
  // The SSE path already stored the resume hint (cursor 2 = seq of
  // run.started). This is exactly the reload state under test: the stored
  // cursor is the SSE resume hint, while the reloaded in-memory reducer
  // view starts at 0.
  await expect
    .poll(() =>
      page.evaluate((id) => localStorage.getItem(`ch.cursor.${id}`), runId),
    )
    .toBe("2");

  // Block the genuine SSE transport on the reload: route.abort() is a pure
  // transport failure (no payload mock, no fabricated events); the JSON
  // status/events endpoints stay real. Passive observation of the real
  // catch-up page requests records the actual `after` cursors used.
  const catchUpPages: number[] = [];
  page.on("request", (caught) => {
    const url = new URL(caught.url());
    if (
      caught.method() === "GET" &&
      url.pathname.endsWith("/events") &&
      url.pathname.includes(`/runs/${runId}`)
    ) {
      catchUpPages.push(Number(url.searchParams.get("after")));
    }
  });
  await page.route("**/api/sessions/*/runs/*/events/stream*", (route) =>
    route.abort(),
  );
  const mutations = observeMutations(page);
  try {
    await page.reload();
    await expect(page.locator("#composer")).toBeVisible();
    // Same recovered session; the pending key stays cleared (recovery never
    // mutates).
    expect(await sessionIdOf(page)).toBe(sessionId);
    expect(
      await page.evaluate((): string | null =>
        localStorage.getItem("ch.pendingKey"),
      ),
    ).toBe(null);
    // Discovery recovers the active run: Send disabled, Stop visible.
    await expect(page.locator("#composer-send")).toBeDisabled();
    await expect(page.locator("#composer-stop")).toBeVisible();

    // The real JSON fallback catch-up must start from the IN-MEMORY reducer
    // cursor (0 after reload), not the stored resume hint (2): observe the
    // first genuine events page request replaying from after=0.
    await expect.poll(() => catchUpPages[0] ?? -1).toBe(0);
    // The queued/started replay applied: the generating notice renders and
    // the run stays active while the strategy is still held.
    await expect(page.locator("#composer-notice")).toContainText("生成中", {
      timeout: 15_000,
    });
    await expect(page.locator("#composer-send")).toBeDisabled();
    await expect(page.locator("#composer-stop")).toBeVisible();
    expect(mutations.requests).toEqual([]);

    // Release the actually held TEXT_HANG strategy; the polling loop picks
    // up the real terminal on the next genuine events page.
    await control(request, "/release");
    await expect
      .poll(async () => canonicalRunStatus(request, sessionId, runId))
      .toEqual({
        run: { status: "completed", eventSeq: 3 },
        types: ["run.queued", "run.started", "run.completed"],
      });

    // Exactly one user turn and one UI answer; the composer is released and
    // the reducer cursor was saved (3).
    await expect(
      page.locator("#conversation").getByText(TEXT_HANG, { exact: true }),
    ).toHaveCount(1);
    await expect(
      page
        .locator("#conversation")
        .getByText(`echo:${TEXT_HANG}`, { exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("#composer-send")).toBeEnabled();
    await expect(page.locator("#composer-stop")).toBeHidden();
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`ch.cursor.${id}`),
        runId,
      ),
    ).toBe("3");
    // No reload mutation POST/retry/cancel, and no storage expansion.
    expect(mutations.requests).toEqual([]);
    const stored = await storedLocalStorage(page);
    for (const key of Object.keys(stored)) {
      expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
    }
    expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_HANG}`);
  } finally {
    // Unroute the transport gate and release the held strategy safely (the
    // release is a no-op if the test body already did it).
    await page
      .unroute("**/api/sessions/*/runs/*/events/stream*")
      .catch(() => undefined);
    await request.post(`${E2E_CONTROL_ORIGIN}/release`).catch(() => undefined);
  }
});

test("C06: recovered active run keeps the composer busy and rejects a submit while the final history is held", async ({
  page,
  request,
}) => {
  const { sessionId, runId } = await acceptedHangRun(page);
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "running", eventSeq: 2 },
      types: ["run.queued", "run.started"],
    });

  // Gate ONLY the boot history hydration (`limit=50`), never the
  // ensureSession existence probe (`limit=1`): the recovered run must own
  // the composer while the real final history response is still in flight.
  let releaseHistory: () => void = () => {};
  const historyHeld = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let hydrationRequests = 0;
  await page.route("**/api/sessions/*/history*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("limit") === "50") {
      hydrationRequests += 1;
      await historyHeld;
    }
    await route.continue();
  });
  const mutations = observeMutations(page);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    // Discovery returned the genuine active descriptor; boot is now held on
    // the real final history response.
    await expect.poll(() => hydrationRequests).toBeGreaterThanOrEqual(1);
    expect(await sessionIdOf(page)).toBe(sessionId);

    // The recovered run already owns the composer: Send disabled, Stop
    // visible, and the input stays enabled (§16.3 type-while-active).
    await expect(page.locator("#composer-send")).toBeDisabled();
    await expect(page.locator("#composer-stop")).toBeVisible();
    await expect(page.locator("#composer-input")).toBeEnabled();

    // A user submit attempt while history is held is rejected by the active
    // run guard: no message/retry/cancel POST and no pending key appears.
    await page.locator("#composer-input").fill(TEXT_HANG);
    await page.locator("#composer-input").press("Enter");
    await expect(page.locator("#composer-send")).toBeDisabled();
    expect(mutations.requests).toEqual([]);
    expect(
      await page.evaluate((): string | null =>
        localStorage.getItem("ch.pendingKey"),
      ),
    ).toBe(null);

    // Release the genuine hydration gate; the run is still held, so the
    // composer stays busy with no mutation fired.
    releaseHistory();
    await expect(page.locator("#composer-send")).toBeDisabled();
    await expect(page.locator("#composer-stop")).toBeVisible();
    expect(mutations.requests).toEqual([]);

    // Release the actually held TEXT_HANG strategy: the deferred native
    // subscription completes the run with exactly one answer and releases
    // the composer.
    await control(request, "/release");
    await expect
      .poll(async () => canonicalRunStatus(request, sessionId, runId))
      .toEqual({
        run: { status: "completed", eventSeq: 3 },
        types: ["run.queued", "run.started", "run.completed"],
      });
    await expect(
      page.locator("#conversation").getByText(TEXT_HANG, { exact: true }),
    ).toHaveCount(1);
    await expect(
      page
        .locator("#conversation")
        .getByText(`echo:${TEXT_HANG}`, { exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("#composer-send")).toBeEnabled();
    await expect(page.locator("#composer-stop")).toBeHidden();
    expect(mutations.requests).toEqual([]);

    // No reload mutation POST/retry/cancel and no storage expansion, and the
    // answer body never persists in browser storage.
    const stored = await storedLocalStorage(page);
    for (const key of Object.keys(stored)) {
      expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
    }
    expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_HANG}`);
  } finally {
    // Release the gate (a no-op if the test body already did), unroute, and
    // release the held strategy so no request is stranded.
    releaseHistory();
    await request.post(`${E2E_CONTROL_ORIGIN}/release`).catch(() => undefined);
    await page.unroute("**/api/sessions/*/history*").catch(() => undefined);
  }
});

test("C06: cancel_requested reload seeds the stop notice before the native terminal resumes", async ({
  page,
  request,
}, testInfo) => {
  await observeNativeRunDeliveries(page);
  await control(request, "/arm-cancel-hold");
  const { sessionId, runId } = await acceptedHangRun(page);
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "running", eventSeq: 2 },
      types: ["run.queued", "run.started"],
    });

  // Click Stop: a real cancel POST, then the non-terminal cancel_requested
  // commits (seq 3) and the client stores the real resume cursor 3.
  const cancelResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/runs/${runId}/cancel`) &&
      response.request().method() === "POST",
  );
  await page.locator("#composer-stop").click();
  expect((await cancelResponse).ok()).toBe(true);
  await expect(page.locator("#composer-notice")).toContainText("停止しました");
  await expect(page.locator("#composer-send")).toBeDisabled();
  await expect(page.locator("#composer-stop")).toBeVisible();
  await expect
    .poll(async () => canonicalRunStatus(request, sessionId, runId))
    .toEqual({
      run: { status: "cancel_requested", eventSeq: 3 },
      types: ["run.queued", "run.started", "run.cancel_requested"],
    });
  await expect
    .poll(() =>
      page.evaluate((id) => localStorage.getItem(`ch.cursor.${id}`), runId),
    )
    .toBe("3");

  // Hold the boot history hydration so the seeded (pre-subscription) view is
  // observable deterministically; the native stream stays deferred until the
  // gate is released.
  let releaseHistory: () => void = () => {};
  const historyHeld = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let hydrationRequests = 0;
  await page.route("**/api/sessions/*/history*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("limit") === "50") {
      hydrationRequests += 1;
      await historyHeld;
    }
    await route.continue();
  });
  const mutations = observeMutations(page);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => hydrationRequests).toBeGreaterThanOrEqual(1);
    expect(await sessionIdOf(page)).toBe(sessionId);

    // Discovery returned cancel_requested: the stop notice renders BEFORE
    // any subscription, Send stays disabled, Stop stays visible, the input
    // stays enabled, and the stored resume cursor is NOT advanced from the
    // discovery eventSeq.
    await expect(page.locator("#composer-notice")).toContainText(
      "停止しました",
    );
    await expect(page.locator("#composer-send")).toBeDisabled();
    await expect(page.locator("#composer-stop")).toBeVisible();
    await expect(page.locator("#composer-input")).toBeEnabled();
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`ch.cursor.${id}`),
        runId,
      ),
    ).toBe("3");
    expect(mutations.requests).toEqual([]);

    // Release the history gate and the genuinely held strategy promptly
    // (inside the production 3s cancellation watchdog): the native stream
    // resumes from the stored cursor 3 (no cancel_requested replay) and
    // delivers the authoritative terminal.
    releaseHistory();
    await control(request, "/release");
    await expect
      .poll(async () => canonicalRunStatus(request, sessionId, runId))
      .toEqual({
        run: { status: "cancelled", eventSeq: 4 },
        types: [
          "run.queued",
          "run.started",
          "run.cancel_requested",
          "run.cancelled",
        ],
      });
    await expect
      .poll(async () => (await nativeRunDeliveries(page, runId)).length)
      .toBeGreaterThan(0);
    const deliveries = await nativeRunDeliveries(page, runId);
    expect(
      deliveries.some((delivery) => delivery.url.includes("after=3")),
    ).toBe(true);
    expect(deliveries.map((delivery) => deliveryType(delivery))).not.toContain(
      "run.cancel_requested",
    );

    await expect(page.locator("#composer-notice")).toContainText(
      "停止しました",
    );
    await expect(page.locator("#composer-send")).toBeEnabled();
    await expect(page.locator("#composer-stop")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate((id) => localStorage.getItem(`ch.cursor.${id}`), runId),
      )
      .toBe("4");
    expect(mutations.requests).toEqual([]);

    // No reload mutation POST/retry/cancel, no storage expansion, and no
    // echo body (the run was cancelled, never completed).
    const stored = await storedLocalStorage(page);
    for (const key of Object.keys(stored)) {
      expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
    }
    expect(JSON.stringify(stored)).not.toContain("echo:");
    // Observable proof: canonical terminal + stored resume cursor + zero
    // reload mutations.
    await testInfo.attach("cancel-recovery-proof.json", {
      body: JSON.stringify({
        canonical: await canonical(request, sessionId, runId),
        cursor: await page.evaluate(
          (id) => localStorage.getItem(`ch.cursor.${id}`),
          runId,
        ),
        mutations: mutations.requests,
      }),
      contentType: "application/json",
    });
  } finally {
    // Release the gate (a no-op if the test body already did), unroute, and
    // release the held strategy so no request is stranded.
    releaseHistory();
    await request.post(`${E2E_CONTROL_ORIGIN}/release`).catch(() => undefined);
    await page.unroute("**/api/sessions/*/history*").catch(() => undefined);
  }
});

/* ------------------------------------------------------------------ */
/* Shared citation drawer last-user-intent races (follow-up)            */
/*                                                                      */
/* rN stored citations and mN run-bound memory citations share ONE      */
/* drawer with no generation guard (before fix): an older delayed A     */
/* overwrites a newer B, or reopens after close. All held HTTP below    */
/* is genuine forwarding (route.fetch + fulfill unchanged); no payload  */
/* is fabricated and no sleeps/timing are used — gates release          */
/* deterministically.                                                   */
/* ------------------------------------------------------------------ */

test("drawer last-intent wins when an older stored detail resolves late (rA held, rB wins)", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);
  const seedA = (await (
    await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
      data: { sessionId },
    })
  ).json()) as { referenceId: string; ordinal: number };
  expect(seedA.ordinal).toBe(1);
  const seedB = (await (
    await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
      data: { sessionId, text: CITATION_SNAPSHOT_TEXT_B },
    })
  ).json()) as { referenceId: string; ordinal: number };
  expect(seedB.ordinal).toBe(2);

  await page.locator("#composer-input").fill(TEXT_CITE_TWO);
  await page.locator("#composer-send").click();
  await expect(page.getByRole("button", { name: "r1" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "r2" })).toBeVisible({
    timeout: 15_000,
  });

  let heldA = 0;
  let fulfilledA = 0;
  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  await page.route("**/api/sessions/*/references/*", async (route) => {
    if (route.request().url().endsWith(`/references/${seedA.referenceId}`)) {
      heldA += 1;
      const genuine = await route.fetch();
      await gateA;
      await route.fulfill({ response: genuine });
      fulfilledA += 1;
      return;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "r1" }).click();
    await expect.poll(() => heldA).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "r2" }).click();
    await expect(page.locator("#drawer")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT_B,
      { timeout: 15_000 },
    );
    releaseA();
    // Wait for the late rA response to actually reach the page before
    // asserting the final UI state; otherwise the check can observe the
    // unchanged rB body and pass even when a broken client mishandles it.
    await expect.poll(() => fulfilledA).toBeGreaterThanOrEqual(1);
    // The late rA detail must not overwrite the newer rB body.
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT_B,
      { timeout: 15_000 },
    );
    expect(await page.locator("#drawer-body script").count()).toBe(0);
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT_B,
    );
  } finally {
    releaseA();
    await page.unroute("**/api/sessions/*/references/*").catch(() => undefined);
  }
});

test("drawer close-while-pending is never resurrected (A held, close, B held, A release)", async ({
  page,
  request,
}) => {
  const sessionId = await sessionIdOf(page);
  const seedA = (await (
    await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
      data: { sessionId },
    })
  ).json()) as { referenceId: string; ordinal: number };
  expect(seedA.ordinal).toBe(1);
  const seedB = (await (
    await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
      data: { sessionId, text: CITATION_SNAPSHOT_TEXT_B },
    })
  ).json()) as { referenceId: string; ordinal: number };
  expect(seedB.ordinal).toBe(2);

  await page.locator("#composer-input").fill(TEXT_CITE_TWO);
  await page.locator("#composer-send").click();
  await expect(page.getByRole("button", { name: "r1" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "r2" })).toBeVisible({
    timeout: 15_000,
  });

  let heldA = 0;
  let heldB = 0;
  let fulfilledA = 0;
  let fulfilledB = 0;
  let releaseA: () => void = () => {};
  let releaseB: () => void = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  await page.route("**/api/sessions/*/references/*", async (route) => {
    const url = route.request().url();
    if (url.endsWith(`/references/${seedA.referenceId}`)) {
      heldA += 1;
      const genuine = await route.fetch();
      await gateA;
      await route.fulfill({ response: genuine });
      fulfilledA += 1;
      return;
    }
    if (url.endsWith(`/references/${seedB.referenceId}`)) {
      heldB += 1;
      const genuine = await route.fetch();
      await gateB;
      await route.fulfill({ response: genuine });
      fulfilledB += 1;
      return;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "r1" }).click();
    await expect.poll(() => heldA).toBeGreaterThanOrEqual(1);
    // Close while A is pending: the real backdrop listener (no test API).
    await page.locator("#drawer").dispatchEvent("click");
    await expect(page.locator("#drawer")).toBeHidden();
    await page.getByRole("button", { name: "r2" }).click();
    await expect.poll(() => heldB).toBeGreaterThanOrEqual(1);
    // Late A must not resurrect while B is still pending.
    releaseA();
    await expect.poll(() => fulfilledA).toBeGreaterThanOrEqual(1);
    await expect(page.locator("#drawer")).toBeHidden();
    await expect(page.locator("#drawer-body")).toHaveText("");
    // Releasing B opens exactly B (plain text, no HTML interpretation).
    releaseB();
    await expect.poll(() => fulfilledB).toBeGreaterThanOrEqual(1);
    await expect(page.locator("#drawer")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT_B,
      { timeout: 15_000 },
    );
    expect(await page.locator("#drawer-body script").count()).toBe(0);
  } finally {
    releaseA();
    releaseB();
    await page.unroute("**/api/sessions/*/references/*").catch(() => undefined);
  }
});

test("shared drawer: stale memory-citation error cannot replace the newer stored citation", async ({
  page,
  request,
}) => {
  // Fixture backend note: this harness has no memory backend, so the m1
  // recall is a GENUINE 404 from the real route (held + forwarded
  // unchanged) — it exercises the shared-drawer async ordering without a
  // real remind CLI dataset. Pure rN races above run on the production
  // UI + temp DB regardless.
  const sessionId = await sessionIdOf(page);
  const seed = (await (
    await request.post(`${E2E_CONTROL_ORIGIN}/seed-citation`, {
      data: { sessionId },
    })
  ).json()) as { referenceId: string; ordinal: number };
  expect(seed.ordinal).toBe(1);

  await page.locator("#composer-input").fill(TEXT_CITE_MEM);
  await page.locator("#composer-send").click();
  await expect(page.getByRole("button", { name: "m1" })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator("#composer-input").fill(TEXT_CITE);
  await page.locator("#composer-send").click();
  await expect(page.getByRole("button", { name: "r1" })).toBeVisible({
    timeout: 15_000,
  });

  let heldMem = 0;
  let fulfilledMem = 0;
  let releaseMem: () => void = () => {};
  const gateMem = new Promise<void>((resolve) => {
    releaseMem = resolve;
  });
  await page.route("**/api/sessions/*/memory/recall/**", async (route) => {
    heldMem += 1;
    const genuine = await route.fetch();
    await gateMem;
    await route.fulfill({ response: genuine });
    fulfilledMem += 1;
  });
  try {
    await page.getByRole("button", { name: "m1" }).click();
    await expect.poll(() => heldMem).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "r1" }).click();
    await expect(page.locator("#drawer")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT,
      { timeout: 15_000 },
    );
    const noticeBefore = await page.locator("#composer-notice").textContent();
    releaseMem();
    // Wait for the late genuine m1 error to reach the page before asserting
    // the final UI state; otherwise the check can pass on the unchanged r1
    // body before a broken client processes the stale error.
    await expect.poll(() => fulfilledMem).toBeGreaterThanOrEqual(1);
    // The late genuine m1 error must not replace the newer r1 body, must
    // not overwrite the current notice, and must not latch the memory
    // backend disabled (a later search stays usable).
    await expect(page.locator("#drawer-body")).toHaveText(
      CITATION_SNAPSHOT_TEXT,
      { timeout: 15_000 },
    );
    await expect(page.locator("#drawer")).toBeVisible();
    expect(await page.locator("#composer-notice").textContent()).toBe(
      noticeBefore,
    );
  } finally {
    releaseMem();
    await page
      .unroute("**/api/sessions/*/memory/recall/**")
      .catch(() => undefined);
  }
});
