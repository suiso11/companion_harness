// SSE + history resilience E2E over the production UI/server/core.
//
// No API mocks: real Hono app + RunEngine + production UI; the loopback SSE
// fault proxy (e2e/server.ts) forwards 1:1 and only destroys live SSE sockets
// or drops one armed SSE frame so the page's NATIVE EventSource exercises
// real reconnect + Last-Event-ID resume and JSON gap catch-up. Fixture setup
// only (session/history seeding) uses the loopback control server via the
// Node-side `request` fixture (never page.fetch, never mocked responses).
//
// Covers: (1) native SSE reconnect after a destroyed stream, (2) JSON gap
// catch-up after a dropped frame, (3) corrupt stored cursor active recovery,
// (4) >50 seeded older-history turns render oldest-first with no duplicates.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  E2E_APP_ORIGIN,
  E2E_CONTROL_ORIGIN,
  E2E_PROXY_ORIGIN,
  SEED_HISTORY_COUNT,
  SEED_HISTORY_PREFIX,
  TEXT_HANG,
} from "./ports.js";
import {
  canonical,
  cursorWrites,
  fault,
  faultStatus,
  nativeRunDeliveries,
  observeCursorWrites,
  observeNativeRunDeliveries,
  startHangingRun,
} from "./resilience.js";

async function control(
  request: APIRequestContext,
  path: string,
  body?: unknown,
): Promise<import("@playwright/test").APIResponse> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`, {
    data: body ?? {},
  });
  expect(res.ok()).toBe(true);
  return res;
}

async function proxy(
  request: APIRequestContext,
  path:
    | "/proxy/reset"
    | "/proxy/drop-sse"
    | "/proxy/arm-drop"
    | "/proxy/status",
  body?: unknown,
): Promise<import("@playwright/test").APIResponse> {
  // Proxy control endpoints live on the proxy origin itself (loopback-only).
  const res = await request.post(`${E2E_PROXY_ORIGIN}${path}`, {
    data: body ?? {},
  });
  expect(res.ok()).toBe(true);
  return res;
}

async function proxyStatus(request: APIRequestContext): Promise<{
  sseConnections: number;
  sseReconnects: number;
  droppedFrames: number;
  lastForwardedId: number;
  lastLastEventId: string | null;
  eventsPageRequests: number;
  statusRequests: number;
}> {
  const res = await request.get(`${E2E_PROXY_ORIGIN}/proxy/status`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    sseConnections: number;
    sseReconnects: number;
    droppedFrames: number;
    lastForwardedId: number;
    lastLastEventId: string | null;
    eventsPageRequests: number;
    statusRequests: number;
  };
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

async function sessionIdOf(page: Page): Promise<string> {
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

async function waitForMessagesRun(
  page: Page,
): Promise<{ runId: string; turnId: string }> {
  const res = await page.waitForResponse(
    (r) => r.url().includes("/api/sessions/") && r.url().endsWith("/messages"),
    { timeout: 15_000 },
  );
  const body = (await res.json()) as {
    turnId?: unknown;
    run?: { id?: unknown };
  };
  expect(res.status()).toBe(202);
  expect(typeof body.turnId).toBe("string");
  const runId = (body.run as { id?: unknown } | undefined)?.id;
  expect(typeof runId).toBe("string");
  return { runId: runId as string, turnId: body.turnId as string };
}

async function runStatus(
  request: APIRequestContext,
  appOrigin: string,
  sessionId: string,
  runId: string,
): Promise<{ status: string; eventSeq: number }> {
  const res = await request.get(
    `${appOrigin}/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/status`,
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    run?: { status?: unknown; eventSeq?: unknown };
  };
  expect(typeof body.run?.status).toBe("string");
  expect(typeof body.run?.eventSeq).toBe("number");
  return {
    status: body.run?.status as string,
    eventSeq: body.run?.eventSeq as number,
  };
}

async function storedCursorOf(
  page: Page,
  runId: string,
): Promise<{ raw: string | null; parsed: number | null }> {
  return page.evaluate(
    (id: string): { raw: string | null; parsed: number | null } => {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(`ch.cursor.${id}`);
      } catch {
        return { raw: null, parsed: null };
      }
      if (raw === null || raw.length === 0 || !/^\d+$/.test(raw.trim())) {
        return { raw, parsed: null };
      }
      const value = Number(raw.trim());
      return {
        raw,
        parsed: Number.isSafeInteger(value) && value >= 0 ? value : null,
      };
    },
    runId,
  );
}

test.beforeEach(async ({ request }) => {
  await control(request, "/reset");
  await proxy(request, "/proxy/reset");
});

test.afterEach(async ({ request }) => {
  await control(request, "/release");
  await proxy(request, "/proxy/reset");
});

// (1) Real-browser native SSE reconnect: destroy the live proxied stream
// mid-run; the native EventSource must reconnect (Last-Event-ID resume) and
// the terminal answer must render exactly once.
test("native SSE reconnect resumes and answers once", async ({
  page,
  request,
}) => {
  await page.goto(`${E2E_PROXY_ORIGIN}/`);
  await expect(page.locator("#composer")).toBeVisible();
  const runWait = waitForMessagesRun(page);
  await send(page, TEXT_HANG);
  const { runId } = await runWait;
  const sessionId = await sessionIdOf(page);
  await expect(page.locator("#composer-send")).toBeDisabled();
  // Wait until the SSE stream is established AND at least one frame was
  // forwarded, so the native client holds a real Last-Event-ID to resume
  // with (dropping before any frame proves nothing about resume).
  await expect
    .poll(async () => (await proxyStatus(request)).sseConnections, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await proxyStatus(request)).lastForwardedId, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  // Destroy the live stream: real transport fault, no mocking.
  await proxy(request, "/proxy/drop-sse");
  // The durable run must stay non-terminal while the stream is down: the
  // client must never cancel/finish the run on a bare disconnect.
  const mid = await runStatus(request, E2E_APP_ORIGIN, sessionId, runId);
  expect(mid.status).not.toMatch(/^(completed|failed|cancelled|abandoned)$/);
  // Release the hanging strategy so the run can complete after reconnect.
  await control(request, "/release");
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_HANG}`,
    { timeout: 20_000 },
  );
  // Reconnect observed at the proxy with a real Last-Event-ID resume header.
  await expect
    .poll(async () => (await proxyStatus(request)).sseReconnects, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const after = await proxyStatus(request);
  expect(after.lastLastEventId).not.toBeNull();
  const final = await canonical(request, sessionId, runId);
  expect(final.run.status).toBe("completed");
  expect(final.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.completed",
  ]);
  expect((await storedCursorOf(page, runId)).parsed).toBe(final.run.eventSeq);
  expect(String(after.lastLastEventId)).toMatch(/^\d+$/);
  const matches = await page
    .locator("#conversation")
    .getByText(`echo:${TEXT_HANG}`, { exact: false })
    .count();
  expect(matches).toBe(1);
  await expect(page.locator("#composer-send")).toBeEnabled();
});

// (2) JSON gap catch-up: drop one armed SSE frame; the client must bridge the
// gap via the real JSON events pagination API and render the answer once.
test("dropped SSE frame holds JSON catch-up while duplicate terminal callbacks arrive across reconnect", async ({
  page,
  request,
}, testInfo) => {
  await observeCursorWrites(page);
  await observeNativeRunDeliveries(page);
  await fault(request, "configure", { holdPages: true, duplicateSeqs: [3] });
  await page.goto(`${E2E_PROXY_ORIGIN}/`);
  await expect(page.locator("#composer")).toBeVisible();
  // Arm BEFORE send: otherwise the race lets the frame pass before the arm
  // lands and the proxy-status-only assertion proves nothing.
  await proxy(request, "/proxy/arm-drop", { seq: 2 });
  const seenEventsPages: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (/\/runs\/[0-9a-f-]{36}\/events\?/.test(url)) {
      seenEventsPages.push(url);
    }
  });
  const runWait = waitForMessagesRun(page);
  await send(page, TEXT_HANG);
  const { runId } = await runWait;
  const sessionId = await sessionIdOf(page);
  await expect
    .poll(async () => (await storedCursorOf(page, runId)).parsed)
    .toBe(1);
  await control(request, "/release");
  await expect.poll(async () => (await faultStatus(request)).heldPages).toBe(1);
  await expect
    .poll(
      async () =>
        (await nativeRunDeliveries(page, runId)).filter(
          (delivery) => JSON.parse(delivery.data).type === "run.completed",
        ).length,
    )
    .toBe(2);
  const terminalBeforeRelease = (await nativeRunDeliveries(page, runId)).filter(
    (delivery) => JSON.parse(delivery.data).type === "run.completed",
  );
  expect(terminalBeforeRelease.map((delivery) => delivery.lastEventId)).toEqual(
    ["3", "3"],
  );
  expect(
    new Set(terminalBeforeRelease.map((delivery) => delivery.sourceId)).size,
  ).toBe(1);
  expect(
    terminalBeforeRelease.every(
      (delivery) => delivery.sameNativeTarget && delivery.readyState === 1,
    ),
  ).toBe(true);
  const historyBeforeRelease = (await faultStatus(request)).historyRequests;
  expect((await storedCursorOf(page, runId)).parsed).toBe(1);
  const heldCursorWrites = await cursorWrites(page, runId);
  expect(heldCursorWrites).toEqual([1]);
  await expect(page.locator("#conversation")).not.toContainText(
    `echo:${TEXT_HANG}`,
  );
  await expect(page.locator("#composer-send")).toBeDisabled();
  // Both genuine terminal frames dispatched on the same native source while
  // serialized application awaits the missing event in the held real page.
  // Native wire Last-Event-ID is NOT the persisted application cursor.
  const held = await faultStatus(request);
  await expect
    .poll(async () => (await proxyStatus(request)).sseReconnects)
    .toBeGreaterThan(0);
  expect((await storedCursorOf(page, runId)).parsed).toBe(1);
  expect(await cursorWrites(page, runId)).toEqual([1]);
  await fault(request, "release-pages");
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_HANG}`,
    {
      timeout: 20_000,
    },
  );
  const status = await proxyStatus(request);
  expect(status.droppedFrames).toBeGreaterThanOrEqual(1);
  // The missing seq must have been bridged by a REAL JSON pagination fetch,
  // not just inferred from the proxy drop counter.
  await expect
    .poll(() => Promise.resolve(seenEventsPages.length), { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(seenEventsPages.some((u) => /after=\d+/.test(u))).toBe(true);
  // Caught-up cursor: finite, persisted, and within the authoritative seq.
  const authoritative = await runStatus(
    request,
    E2E_APP_ORIGIN,
    sessionId,
    runId,
  );
  const cursor = await storedCursorOf(page, runId);
  expect(cursor.parsed).toBe(authoritative.eventSeq);
  expect(await cursorWrites(page, runId)).toEqual([1, 2, 3]);
  const final = await canonical(request, sessionId, runId);
  expect(final.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.completed",
  ]);
  const matches = await page
    .locator("#conversation")
    .getByText(`echo:${TEXT_HANG}`, { exact: true })
    .count();
  expect(matches).toBe(1);
  await expect(page.locator("#composer-send")).toBeEnabled();
  // The proxy's historyRequests counter is GLOBAL (session bootstrap, older
  // pages, and unrelated panels all call /history), so it cannot prove this
  // run's single history effect. The per-run cursor writes, canonical events,
  // and exactly-one rendered answer below are the contract.
  expect(await cursorWrites(page, runId)).toEqual([1, 2, 3]);
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: true }),
  ).toHaveCount(1);
  await testInfo.attach("held-gap-reconnect-proof.json", {
    body: JSON.stringify({
      held,
      terminalBeforeRelease,
      heldCursorWrites,
      historyBeforeRelease,
      historyAfter: (await faultStatus(request)).historyRequests,
      canonical: final,
      proxy: await proxyStatus(request),
      cursorWrites: await cursorWrites(page, runId),
    }),
    contentType: "application/json",
  });
});

test("actual preterminal duplicate SSE frames apply answer and history effect once", async ({
  page,
  request,
}, testInfo) => {
  await observeCursorWrites(page);
  await fault(request, "configure", { duplicateSeqs: [1, 2] });
  const { sessionId, runId } = await startHangingRun(page);
  await expect
    .poll(async () => (await faultStatus(request)).duplicatedFrames)
    .toBe(2);
  await expect
    .poll(async () => await cursorWrites(page, runId))
    .toEqual([1, 2]);
  await expect(page.locator("#composer-notice")).toHaveText("生成中");
  await expect(
    page.locator("#conversation").getByText(TEXT_HANG, { exact: true }),
  ).toHaveCount(1);
  const before = await faultStatus(request);
  await control(request, "/release");
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect
    .poll(async () => (await faultStatus(request)).duplicatedFrames)
    .toBe(2);
  await expect
    .poll(async () => await cursorWrites(page, runId))
    .toEqual([1, 2, 3]);
  // A late second terminal effect would append another per-run cursor write
  // or duplicate answer. Do not use the GLOBAL proxy history counter here:
  // unrelated session/older-history hydration also calls /history.
  const after = await faultStatus(request);
  expect(await cursorWrites(page, runId)).toEqual([1, 2, 3]);
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: true }),
  ).toHaveCount(1);
  const final = await canonical(request, sessionId, runId);
  expect(final.run.status).toBe("completed");
  expect(final.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.completed",
  ]);
  expect((await storedCursorOf(page, runId)).parsed).toBe(final.run.eventSeq);
  await testInfo.attach("duplicate-application-proof.json", {
    body: JSON.stringify({
      canonical: final,
      cursorWrites: await cursorWrites(page, runId),
      historyBefore: before.historyRequests,
      proxy: after,
    }),
    contentType: "application/json",
  });
});

// (3) Corrupt stored cursor active recovery: intercept the REAL accepted
// messages response, poison ch.cursor.<runId> for that exact run before the
// page processes the acceptance, then prove resync from history (ahead) or
// normal completion (malformed, which readStoredCursor maps to null).
for (const variant of ["ahead", "malformed"] as const) {
  test(`corrupt stored cursor (${variant}) recovers on the live run`, async ({
    page,
    request,
  }) => {
    await page.goto(`${E2E_APP_ORIGIN}/`);
    await expect(page.locator("#composer")).toBeVisible();
    const poisonValue = variant === "ahead" ? "999999999" : "not-a-cursor!!";
    const seenStatus: string[] = [];
    const seenHistory: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (/\/runs\/[0-9a-f-]{36}\/status/.test(url)) {
        seenStatus.push(url);
      }
      if (/\/history\?/.test(url)) {
        seenHistory.push(url);
      }
    });
    // Deterministic interception: fetch the REAL persisted response, poison
    // the exact accepted run's cursor, then release the real response.
    await page.route("**/api/sessions/*/messages", async (route) => {
      const real = await route.fetch();
      let runId: string | null = null;
      try {
        const body = (await real.json()) as {
          run?: { id?: unknown };
        };
        const id = (body.run as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") {
          runId = id;
        }
      } catch {
        runId = null;
      }
      if (runId !== null) {
        const id = runId;
        try {
          await page.evaluate(
            ({ key, value }: { key: string; value: string }): void => {
              try {
                localStorage.setItem(key, value);
              } catch {
                // Surface nothing: evaluate failure below would hide it, so
                // rethrow to fail the test instead of swallowing.
                throw new Error("poison-write-failed");
              }
            },
            { key: `ch.cursor.${id}`, value: poisonValue },
          );
        } catch {
          throw new Error("poison-write-failed");
        }
      }
      await route.fulfill({ response: real });
    });
    const runWait = waitForMessagesRun(page);
    await send(page, TEXT_HANG);
    const { runId } = await runWait;
    const hangSessionId = await sessionIdOf(page);
    // Wait for the client to validate against the authoritative run status
    // (ahead) before releasing the hang: releasing first would mask resync.
    if (variant === "ahead") {
      await expect
        .poll(() => Promise.resolve(seenStatus.length), { timeout: 15_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(() => Promise.resolve(seenHistory.length), { timeout: 15_000 })
        .toBeGreaterThan(0);
    } else {
      // Malformed cursors normalize to null (no status resync expected), so
      // wait for the REAL strategy to be running server-side before
      // releasing: an early /release would otherwise land before the hanger
      // registers and the run would hang forever.
      await expect
        .poll(
          async () =>
            (await runStatus(request, E2E_APP_ORIGIN, hangSessionId, runId))
              .status,
          { timeout: 15_000 },
        )
        .toMatch(/^(queued|running|cancel_requested)$/);
    }
    await control(request, "/release");
    await expect(page.locator("#conversation")).toContainText(
      `echo:${TEXT_HANG}`,
      { timeout: 20_000 },
    );
    const sessionId = await sessionIdOf(page);
    // Resolve the live run id from the single persisted cursor key space.
    const liveRunId = await page.evaluate((): string | null => {
      try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key?.startsWith("ch.cursor.")) {
            keys.push(key);
          }
        }
        if (keys.length === 0) {
          return null;
        }
        keys.sort();
        return (keys[keys.length - 1] as string).slice("ch.cursor.".length);
      } catch {
        throw new Error("cursor-scan-failed");
      }
    });
    expect(liveRunId).not.toBeNull();
    const authoritative = await runStatus(
      request,
      E2E_APP_ORIGIN,
      sessionId,
      liveRunId as string,
    );
    const cursor = await storedCursorOf(page, liveRunId as string);
    // After recovery the stored cursor (when present) is finite and within
    // the authoritative eventSeq; the poisoned value is gone (normalization).
    // Malformed cursors normalize to null and replay from 0, so the run
    // still completes and renders exactly once (no status/history resync is
    // expected on that path — only the ahead variant resyncs).
    if (cursor.raw !== null) {
      expect(cursor.raw).not.toBe(poisonValue);
      expect(cursor.parsed).not.toBeNull();
      expect(cursor.parsed as number).toBeLessThanOrEqual(
        authoritative.eventSeq,
      );
    }
    const matches = await page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: false })
      .count();
    expect(matches).toBe(1);
    await expect(page.locator("#composer-send")).toBeEnabled();
    await page.unroute("**/api/sessions/*/messages");
  });
}

// (4) >50 older history turns: seed 60 completed turns, reload, click the real
// older-history control until the oldest seeded turn is reachable, then assert
// oldest-first order and no duplicates across the full sequence.
test("seeded older history renders oldest-first without duplicates", async ({
  page,
  request,
}) => {
  await page.goto(`${E2E_APP_ORIGIN}/`);
  await expect(page.locator("#composer")).toBeVisible();
  const sessionId = await sessionIdOf(page);
  const seed = await control(request, "/seed-history", {
    sessionId,
    count: SEED_HISTORY_COUNT,
    prefix: SEED_HISTORY_PREFIX,
  });
  const seeded = (await seed.json()) as {
    count: number;
    firstSeq: number;
    lastSeq: number;
  };
  expect(seeded.count).toBe(SEED_HISTORY_COUNT);
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible({ timeout: 15_000 });
  const first = `${SEED_HISTORY_PREFIX}-000`;
  const last = `${SEED_HISTORY_PREFIX}-059`;
  // Do not assume all 60 auto-render: drive the ACTUAL older-history button
  // until the oldest seeded turn becomes reachable (or it disappears when
  // everything already rendered).
  for (let round = 0; round < 25; round += 1) {
    const older = page.locator("#history-older");
    if ((await older.count()) === 0) {
      break;
    }
    if (!(await older.first().isVisible())) {
      break;
    }
    await older.first().click();
    await expect(page.locator("#conversation"))
      .toContainText(first, {
        timeout: 20_000,
      })
      .catch(() => undefined);
    if (
      ((await page.locator("#conversation").innerText()) ?? "").includes(first)
    ) {
      break;
    }
  }
  await expect(page.locator("#conversation")).toContainText(first, {
    timeout: 20_000,
  });
  await expect(page.locator("#conversation")).toContainText(last, {
    timeout: 20_000,
  });
  // Full chronological sequence: every seeded index present in order.
  const text = (await page.locator("#conversation").innerText()) ?? "";
  let previous = -1;
  for (let i = 0; i < 60; i += 1) {
    const needle = `${SEED_HISTORY_PREFIX}-${String(i).padStart(3, "0")}`;
    const position = text.indexOf(needle);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  // No duplicates: each seeded user text occurs exactly once in the DOM.
  const dupes = await page.evaluate((prefix: string): string[] => {
    const body = document.getElementById("conversation")?.innerText ?? "";
    const found: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const needle = `${prefix}-${String(i).padStart(3, "0")}`;
      const occurrences = body.split(needle).length - 1;
      if (occurrences !== 1) {
        found.push(`${needle}x${occurrences}`);
      }
    }
    return found;
  }, SEED_HISTORY_PREFIX);
  expect(dupes).toEqual([]);
});
