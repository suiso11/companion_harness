// System monitor page (real browser + real HTTP/API, no mocks).
//
// Proves the /monitor route actually renders the live GET /api/monitor
// payload (host cards, service state, 24h totals), polls the same origin
// more than once, and does so with zero inline style attributes or CSP
// violation console messages under the strict production CSP.

import { expect, test } from "@playwright/test";

test("monitor renders live telemetry without inline styles or CSP violations", async ({
  page,
}) => {
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];
  const requestUrls: string[] = [];

  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy/i.test(message.text())
    ) {
      cspViolations.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("request", (request) => {
    requestUrls.push(request.url());
  });

  const firstMonitor = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/monitor",
  );
  await page.goto("/monitor");
  await expect(page.locator("#monitor")).toBeVisible();
  const api = (await (await firstMonitor).json()) as {
    version: number;
    totals: { calls: number };
    hardware: { ramTotalMiB: number | null };
    requests: unknown[];
    services: { model: { configured: boolean }; webSearch: { status: string } };
    live: { state: string };
  };
  expect(api.version).toBe(1);

  // Header pill + service card reflect the real payload.
  await expect(page.locator("#monitor-state")).toHaveText("待機中");
  await expect(page.locator("#monitor-service-configured")).toHaveText(
    "未設定",
  );
  await expect(page.locator("#monitor-service-model")).toHaveText("—");
  await expect(page.locator("#monitor-service-websearch")).toHaveText("無効");
  await expect(page.locator("#monitor-totals-calls")).toHaveText(
    String(api.totals.calls),
  );

  // Base cards (speed, CPU, RAM, services) plus any real GPU cards.
  expect(await page.locator(".monitor-card").count()).toBeGreaterThanOrEqual(4);

  // RAM card shows the API's total in GiB (used may drift between polls).
  expect(api.hardware.ramTotalMiB).not.toBeNull();
  const totalGib = ((api.hardware.ramTotalMiB ?? 0) / 1024).toFixed(1);
  await expect(page.locator("#monitor-ram-used")).toContainText(
    `${totalGib} GiB`,
  );

  // cpuPct is null on the very first sample; the second 2s poll fills it.
  await expect(page.locator("#monitor-cpu-pct")).not.toHaveText("—", {
    timeout: 15_000,
  });
  await expect(page.locator("#monitor-cpu-pct")).toHaveText(/^\d+(\.\d)?%$/);
  expect(await page.locator(".monitor-spark-line").count()).toBeGreaterThan(0);

  // Request table is present (empty is a valid state on a fresh DB).
  await expect(page.locator("#monitor-requests-title")).toBeVisible();
  if (api.requests.length === 0) {
    await expect(page.locator(".monitor-requests")).toContainText(
      "まだリクエストがありません",
    );
  } else {
    await expect(page.locator("#monitor-requests")).toBeVisible();
  }

  // Let at least one more 2s poll complete.
  await page.waitForTimeout(2500);

  // The page only talks to its own origin, and it polls /api/monitor.
  const origin = new URL(page.url()).origin;
  const outside = requestUrls.filter((url) => {
    try {
      return new URL(url).origin !== origin;
    } catch {
      return true;
    }
  });
  expect(outside).toEqual([]);
  const monitorCalls = requestUrls.filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && parsed.pathname === "/api/monitor";
    } catch {
      return false;
    }
  });
  expect(monitorCalls.length).toBeGreaterThanOrEqual(2);

  // Strict CSP: no inline style attributes anywhere in the live DOM.
  await expect(page.locator("[style]")).toHaveCount(0);
  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
});
