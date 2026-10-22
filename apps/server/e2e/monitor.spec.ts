// System monitor page (real browser + real HTTP/API, no mocks).
//
// Proves the /monitor route actually renders the live GET /api/monitor
// payload (host cards, service state, 24h totals), polls the same origin
// more than once, and does so with zero inline style attributes or CSP
// violation console messages under the strict production CSP.

import { expect, test } from "@playwright/test";

// Mirrors apps/web/src/lib/monitor.ts stateLabel(): every state the API can
// return must surface its exact label (and exposing the unknown-state dash
// would be a product bug).
const STATE_LABELS = {
  idle: "待機中",
  generating: "生成中",
  queued: "待ち",
} as const;

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
    hardware: {
      ramTotalMiB: number | null;
      gpus: Array<{
        index: number;
        name: string;
        util: number | null;
        memUsedMiB: number | null;
        memTotalMiB: number | null;
        tempC: number | null;
        powerW: number | null;
        powerLimitW: number | null;
      }>;
    };
    requests: unknown[];
    services: { model: { configured: boolean }; webSearch: { status: string } };
    live: { state: string };
  };
  expect(api.version).toBe(1);
  expect(Object.keys(STATE_LABELS)).toContain(api.live.state);

  // Header pill + service card reflect the real payload. The shared e2e
  // server can still be finishing another spec's run (CI observed
  // "生成中"), so never hard-code idle: assert the label matches the
  // published state and that the live counts are consistent with it.
  await expect(page.locator("#monitor-state")).toBeVisible();
  const live = await page.evaluate(() => ({
    state:
      document.querySelector("#monitor-state")?.getAttribute("data-state") ??
      "",
    label: document.querySelector("#monitor-state")?.textContent?.trim() ?? "",
    counts:
      document
        .querySelector("#monitor-live-counts")
        ?.textContent?.replace(/\s+/g, " ") ?? "",
  }));
  expect(Object.keys(STATE_LABELS)).toContain(live.state);
  expect(live.label).toBe(
    STATE_LABELS[live.state as keyof typeof STATE_LABELS],
  );
  const counts = live.counts.match(/実行中\s*([\d,]+)・待ち\s*([\d,]+)/);
  expect(counts).not.toBeNull();
  const runningRuns = Number((counts?.[1] ?? "").replaceAll(",", ""));
  const queuedRuns = Number((counts?.[2] ?? "").replaceAll(",", ""));
  if (live.state === "idle") {
    expect({ runningRuns, queuedRuns }).toEqual({
      runningRuns: 0,
      queuedRuns: 0,
    });
  } else if (live.state === "generating") {
    expect(runningRuns).toBeGreaterThan(0);
  } else {
    expect(runningRuns).toBe(0);
    expect(queuedRuns).toBeGreaterThan(0);
  }
  await expect(page.locator("#monitor-service-configured")).toHaveText(
    "未設定",
  );
  await expect(page.locator("#monitor-service-model")).toHaveText("—");
  await expect(page.locator("#monitor-service-websearch")).toHaveText("無効");
  await expect(page.locator("#monitor-totals-calls")).toHaveText(
    String(api.totals.calls),
  );

  // Base cards (speed, CPU, RAM, services) plus EXACTLY one card per GPU
  // reported by the payload. CI runners have no nvidia-smi (gpus: []), so
  // this must hold with zero GPU cards as well as on a GPU host.
  expect(await page.locator(".monitor-card").count()).toBe(
    4 + api.hardware.gpus.length,
  );
  for (const gpu of api.hardware.gpus) {
    const card = page.locator(`#monitor-gpu-${gpu.index}`);
    await expect(card).toBeVisible();
    await expect(card.locator(".monitor-card-head h3")).toHaveText(
      `GPU ${gpu.index}`,
    );
    await expect(
      card.locator(".monitor-card-head .monitor-card-note"),
    ).toHaveText(gpu.name);
    // Null readings must render the em dash, never 0 or an empty cell.
    if (gpu.util === null) {
      await expect(card.locator(".monitor-big")).toHaveText("—");
    }
    if (gpu.memUsedMiB === null && gpu.memTotalMiB === null) {
      await expect(
        card.locator(".monitor-metric-line .monitor-metric-value"),
      ).toHaveText("—");
    }
    if (gpu.tempC === null) {
      await expect(
        card
          .locator(".monitor-metric-cell")
          .filter({ hasText: "温度" })
          .locator(".monitor-metric-value"),
      ).toHaveText("—");
    }
    if (gpu.powerW === null && gpu.powerLimitW === null) {
      await expect(
        card
          .locator(".monitor-metric-cell")
          .filter({ hasText: "電力" })
          .locator(".monitor-metric-value"),
      ).toHaveText("—");
    }
  }

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
