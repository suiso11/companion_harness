// Production UI + real Hono/RunEngine/temp SQLite. Only transport faults
// and bounded deterministic fake-strategy controls are injected.
import { expect, test } from "@playwright/test";
import { TEXT_HANG } from "./ports.js";
import {
  canonical,
  fault,
  faultStatus,
  observePages,
  startHangingRun,
  strategy,
} from "./resilience.js";

const FAILURE_NOTICE = "状態の取得に失敗しました。再読み込みしてください";

test.beforeEach(async ({ request }) => {
  await strategy(request, "reset");
  await fault(request, "reset");
  await fault(request, "configure", { unavailableSse: true });
});

test.afterEach(async ({ request }) => {
  await strategy(request, "reset");
  await fault(request, "reset");
});

test("JSON fallback continues through long run and delayed pages without overlap or implicit cancel", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const timings = observePages(page);
  const ids = await startHangingRun(page);
  const cdp = await page.context().newCDPSession(page);
  const version: unknown = await cdp.send("Browser.getVersion");
  await cdp.detach();
  await testInfo.attach("browser-runtime.json", {
    body: JSON.stringify({
      browserType: browser.browserType().name(),
      version,
    }),
    contentType: "application/json",
  });
  await expect
    .poll(async () => (await faultStatus(request)).pagesFinished)
    .toBeGreaterThanOrEqual(8);
  await fault(request, "configure", { holdPages: true });
  await expect.poll(async () => (await faultStatus(request)).heldPages).toBe(1);
  const held = await faultStatus(request);
  expect(held.blockedSse).toBeGreaterThan(0);
  expect(held.pagesInFlight).toBe(1);
  await page.locator("#composer-input").fill("draft while polling");
  await page.locator("#composer-input").press("End");
  await expect(page.locator("#composer-send")).toBeDisabled();
  // Bounded absence observation spans two configured 1s poll intervals.
  await page.waitForTimeout(2200);
  const delayed = await faultStatus(request);
  expect(delayed.eventsPageRequests).toBe(held.eventsPageRequests);
  expect(delayed.maxPagesInFlight).toBe(1);
  expect(delayed.cancelRequests).toBe(0);
  const active = await canonical(request, ids.sessionId, ids.runId);
  expect(active.run.status).toBe("running");
  expect(active.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
  ]);
  await fault(request, "release-pages");
  await strategy(request, "release");
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("#composer-send")).toBeEnabled();
  const final = await canonical(request, ids.sessionId, ids.runId);
  expect(final.run.status).toBe("completed");
  expect(
    final.events.filter((event) => event.type === "run.completed"),
  ).toHaveLength(1);
  await expect
    .poll(() =>
      Promise.resolve(timings.every((timing) => timing.finish !== null)),
    )
    .toBe(true);
  for (let index = 1; index < timings.length; index += 1) {
    expect(timings[index]?.start).toBeGreaterThanOrEqual(
      timings[index - 1]?.finish as number,
    );
  }
  const finished = await faultStatus(request);
  expect(finished.maxPagesInFlight).toBe(1);
  expect(finished.pagesInFlight).toBe(0);
  expect(finished.cancelRequests).toBe(0);
  await testInfo.attach("sequential-poll-proof.json", {
    body: JSON.stringify({
      browserTimings: timings,
      proxy: finished,
      canonical: final,
    }),
    contentType: "application/json",
  });
});

test("JSON fallback recovers from transient errors and successful pages reset the failure streak", async ({
  page,
  request,
}, testInfo) => {
  // Four failures, a real success, then four more: a cumulative-error
  // regression would stop at the sixth request instead of converging.
  await fault(request, "configure", {
    failures: [
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
    ],
  });
  const ids = await startHangingRun(page);
  await expect
    .poll(async () => (await faultStatus(request)).failedPages, {
      timeout: 20_000,
    })
    .toBe(8);
  await expect
    .poll(async () => (await faultStatus(request)).pagesFinished, {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(11);
  await expect(page.locator("#composer-notice")).not.toContainText(
    FAILURE_NOTICE,
  );
  await expect(page.locator("#composer-send")).toBeDisabled();
  await strategy(request, "release");
  await expect(
    page
      .locator("#conversation")
      .getByText(`echo:${TEXT_HANG}`, { exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("#composer-send")).toBeEnabled();
  const final = await canonical(request, ids.sessionId, ids.runId);
  expect(final.run.status).toBe("completed");
  expect(final.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.completed",
  ]);
  await testInfo.attach("transient-recovery-proof.json", {
    body: JSON.stringify({
      proxy: await faultStatus(request),
      canonical: final,
    }),
    contentType: "application/json",
  });
});

test("JSON fallback stops exactly after five consecutive failures with the fixed notice", async ({
  page,
  request,
}, testInfo) => {
  await fault(request, "configure", {
    failures: [true, true, true, true, true],
  });
  const ids = await startHangingRun(page);
  await expect(page.locator("#composer-notice")).toContainText(FAILURE_NOTICE, {
    timeout: 20_000,
  });
  const stopped = await faultStatus(request);
  expect(stopped.failedPages).toBe(5);
  expect(stopped.eventsPageRequests).toBe(5);
  expect(stopped.pagesFinished).toBe(5);
  await page.waitForTimeout(2200);
  expect((await faultStatus(request)).eventsPageRequests).toBe(5);
  const active = await canonical(request, ids.sessionId, ids.runId);
  expect(active.run.status).toBe("running");
  expect(stopped.cancelRequests).toBe(0);
  // Poll failure affects observation only, never durable execution.
  await strategy(request, "release");
  await expect
    .poll(
      async () =>
        (await canonical(request, ids.sessionId, ids.runId)).run.status,
    )
    .toBe("completed");
  await expect(page.locator("#conversation")).not.toContainText(
    `echo:${TEXT_HANG}`,
  );
  expect((await faultStatus(request)).eventsPageRequests).toBe(5);
  await testInfo.attach("five-failures-proof.json", {
    body: JSON.stringify({
      proxy: await faultStatus(request),
      canonical: await canonical(request, ids.sessionId, ids.runId),
    }),
    contentType: "application/json",
  });
});

test("JSON fallback observes real cancel_requested as active and polls until cancelled", async ({
  page,
  request,
}, testInfo) => {
  await strategy(request, "arm-cancel-hold");
  const ids = await startHangingRun(page);
  await expect
    .poll(async () => (await faultStatus(request)).pagesFinished)
    .toBeGreaterThanOrEqual(2);
  await page.locator("#composer-stop").click();
  await expect(page.locator("#composer-notice")).toContainText("停止しました");
  await expect(page.locator("#composer-send")).toBeDisabled();
  await expect(page.locator("#composer-stop")).toBeVisible();
  const requested = await canonical(request, ids.sessionId, ids.runId);
  expect(requested.run.status).toBe("cancel_requested");
  expect(requested.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.cancel_requested",
  ]);
  const observed = await faultStatus(request);
  await expect
    .poll(async () => (await faultStatus(request)).pagesFinished, {
      timeout: 2000,
      intervals: [100],
    })
    .toBeGreaterThan(observed.pagesFinished);
  await expect(page.locator("#composer-send")).toBeDisabled();
  await strategy(request, "release");
  await expect(page.locator("#composer-stop")).toBeHidden();
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#composer-notice")).toContainText("停止しました");
  const final = await canonical(request, ids.sessionId, ids.runId);
  expect(final.run.status).toBe("cancelled");
  expect(final.events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.cancel_requested",
    "run.cancelled",
  ]);
  expect((await faultStatus(request)).cancelRequests).toBe(1);
  await testInfo.attach("nonterminal-cancel-proof.json", {
    body: JSON.stringify({
      requested,
      canonical: final,
      proxy: await faultStatus(request),
    }),
    contentType: "application/json",
  });
});
