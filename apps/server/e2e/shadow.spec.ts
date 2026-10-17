// AV shadow-deliberation consumer-UI regressions (real browser + real HTTP).
//
// Each test boots its OWN production server (e2e/shadow_fixture.ts: real
// Hono createApp + kernel DB + RunEngine + ShadowService on a throwaway file
// DB, fresh per test) with a synthetic gateway standing in for the model
// transport (strict native `autonomy_deliberation.submit` builders, same as
// the service HTTP tests; NOT a real model). The default shared echo server
// has no shadow model and is never used here: every flow drives the REAL
// shadow panel against per-test servers on ephemeral loopback ports.
//
// No API mocks, no private-state injection, no fabricated DTOs: backend
// reads/writes inside page.evaluate use the real same-origin fetch (real
// Origin + Idempotency-Key headers). Route interception only holds or drops
// REAL responses (route.fetch/continue), never synthesizes bodies.
//
// Covers four consumer boundaries:
//   1. trial-only proposal: execute MODEL decision renders as proposal
//      (未実行) under a CODE policy (missing_grant), untrusted model strings
//      stay inert text, permission claims are never grants, no execution or
//      adoption surface exists;
//   2. uncertain first POST: a REAL commit with an aborted response keeps the
//      frozen in-memory request; an edited draft can never reuse the old key
//      (explicit retry refuses), settling the ORIGINAL scope exactly once;
//   3. selection rebinding: a held-then-late detail GET for A can never
//      restore A after B was selected;
//   4. STOP-held background result: a parked call aborted by an explicit UI
//      STOP stays HELD (control_paused, never executed) without touching the
//      composer draft, while ordinary chat (readonly purpose/task tools +
//      answer.submit on the same gateway) completes with zero shadow side
//      effects.

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Fixture {
  origin: string;
  controlOrigin: string;
  child: ChildProcess;
  dispose: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const child = spawn("node", ["--import", "tsx", "e2e/shadow_fixture.ts"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let origin = "";
  let controlOrigin = "";
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf-8"));
  });
  const deadline = Date.now() + 120_000;
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(
          new Error(
            `fixture did not boot in time: ${stderr.join("").slice(-2000)}`,
          ),
        );
      }
    }, 100);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      const appMatch = /shadow-fixture-ready (http:\/\/127\.0\.0\.1:\d+)/.exec(
        stdout,
      );
      const controlMatch =
        /shadow-fixture-control (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (appMatch?.[1] !== undefined) origin = appMatch[1];
      if (controlMatch?.[1] !== undefined) controlOrigin = controlMatch[1];
      if (origin !== "" && controlOrigin !== "") {
        clearInterval(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearInterval(timer);
      reject(
        new Error(
          `fixture exited code=${code}: ${stderr.join("").slice(-2000)}`,
        ),
      );
    });
  });
  const dispose = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  };
  return { origin, controlOrigin, child, dispose };
}

async function configureFixture(
  request: import("@playwright/test").APIRequestContext,
  controlOrigin: string,
  body: unknown,
): Promise<void> {
  const res = await request.post(`${controlOrigin}/shadow-test/config`, {
    data: body,
  });
  expect(res.ok()).toBe(true);
}

async function fixtureStats(
  request: import("@playwright/test").APIRequestContext,
  controlOrigin: string,
): Promise<{
  deliberationCalls: number;
  ordinaryCalls: number;
  advertisedTools: string[];
  ordinaryToolCalls: string[];
}> {
  const res = await request.get(`${controlOrigin}/shadow-test/stats`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    deliberationCalls: number;
    ordinaryCalls: number;
    advertisedTools: string[];
    ordinaryToolCalls: string[];
  };
}

async function releaseFixture(
  request: import("@playwright/test").APIRequestContext,
  controlOrigin: string,
): Promise<void> {
  const res = await request.post(`${controlOrigin}/shadow-test/release`);
  expect(res.ok()).toBe(true);
}

/** Typed hold/release gate: resolving twice is a no-op, no nullable slot. */
function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

interface ApiResult {
  status: number;
  body: unknown;
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

async function boot(page: Page, origin: string): Promise<string> {
  await page.goto(origin);
  await page.locator("#autonomy-control-status").waitFor({ timeout: 30_000 });
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
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
}

async function createStandaloneTaskUi(
  page: Page,
  title: string,
): Promise<void> {
  await page.locator("#autonomy-task-parent-mode").selectOption("standalone");
  await page.locator("#autonomy-task-title").fill(title);
  await page.locator("#autonomy-task-form button[type=submit]").click();
  await page.locator("#autonomy-task-list").getByText(title).waitFor();
}

async function requestShadowUi(
  page: Page,
  scope: string,
  reason: string,
): Promise<void> {
  await page.locator("#shadow-scope").fill(scope);
  await page.locator("#shadow-reason").fill(reason);
  await page.locator("#shadow-request-form button[type=submit]").click();
  // The acceptance notice is transient (a list refresh clears it once the
  // job renders), so anchor on the durable consumer surface: the job row.
  await page.locator("#shadow-job-list").getByText(scope).waitFor({
    timeout: 15_000,
  });
}

interface ShadowJobRow {
  id: string;
  scope: string;
  status: string;
  [key: string]: unknown;
}

async function listShadowJobs(
  page: Page,
  sessionId: string,
): Promise<ShadowJobRow[]> {
  const result = await api(
    page,
    "GET",
    `/api/sessions/${sessionId}/shadow-jobs?limit=50`,
  );
  expect(result.status).toBe(200);
  return (result.body as { items: ShadowJobRow[] }).items ?? [];
}

async function waitShadowJob(
  page: Page,
  sessionId: string,
  scope: string,
  status: string,
): Promise<ShadowJobRow> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const jobs = await listShadowJobs(page, sessionId);
    const found = jobs.find(
      (job) => job.scope === scope && job.status === status,
    );
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `shadow job scope=${scope} status=${status} never landed`,
      );
    }
    await page.waitForTimeout(250);
  }
}

async function selectShadowJob(page: Page, scope: string): Promise<void> {
  await page.locator("#shadow-job-list").getByText(scope).click();
}

test.describe.configure({ mode: "serial" });

test("trial-only execute proposal renders 未実行 under a CODE policy, untrusted strings stay inert", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    await configureFixture(request, fx.controlOrigin, {
      plan: ["execute-xss"],
    });
    const sessionId = await boot(page, fx.origin);
    const base = `/api/sessions/${sessionId}`;

    // Default control starts paused; create while paused, then resume
    // explicitly through the UI (no automatic catch-up may fire).
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "停止中",
    );
    await createPurposeUi(page, {
      scope: "health",
      statement: "ui walk goal",
      kind: "goal",
      interpretation: "narrow reading",
      validFrom: "2020-01-01T00:00:00+00:00",
      validUntil: "2030-01-01T00:00:00+00:00",
    });
    await createPurposeUi(page, {
      scope: "health",
      statement: "ui evening permission claim",
      kind: "permission",
    });
    await page.locator("#shadow-refresh").click();
    await expect(page.locator("#shadow-status")).toContainText(
      "試行の記録はまだありません",
    );

    await page.locator("#autonomy-resume-button").click();
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "再開",
    );
    const before = await listShadowJobs(page, sessionId);
    expect(before).toHaveLength(0);

    await requestShadowUi(page, "health", "check in");
    const job = await waitShadowJob(page, sessionId, "health", "completed");

    await selectShadowJob(page, "health");
    const detail = page.locator("#shadow-detail-body");
    await expect(detail).toContainText("実行案（未実行）", {
      timeout: 15_000,
    });
    // CODE policy first (never model-chosen, never a grant)...
    await expect(detail).toContainText("権限付与なし");
    await expect(detail).toContainText("未実行");
    // ...shown SEPARATE from the frozen MODEL decision.
    await expect(detail).toContainText("モデルの判断：実行案（未実行）");
    // Evidence keeps original vs interpretation apart with provenance/time.
    await expect(detail).toContainText("目的の記録 sP");
    await expect(detail).toContainText("原文：ui walk goal");
    await expect(detail).toContainText("解釈：narrow reading");
    await expect(detail).toContainText("出所：");
    await expect(detail).toContainText("適用：");
    await expect(detail).toContainText("権限の記録 sM");
    await expect(detail).toContainText("権限付与ではない");

    // Untrusted model strings render as inert text: literal payload visible,
    // zero executable elements, escaped markup in the DOM.
    const detailText = (await detail.textContent()) ?? "";
    expect(detailText).toContain('<img src="x" onerror="alert(1)">');
    expect(detailText).toContain("<script>alert(2)</script>");
    expect(await page.locator("#shadow-detail-body img").count()).toBe(0);
    expect(await page.locator("#shadow-detail-body script").count()).toBe(0);
    const inner = await detail.evaluate((node) => node.innerHTML);
    expect(inner).toContain("&lt;img");
    expect(inner).not.toContain("<img");

    // Technical ids never reach user-facing text; only data-* attributes.
    expect(detailText).not.toContain(job.id);
    expect(detailText).not.toContain(sessionId);

    // No execution/adoption/Calendar surface: the detail panel carries no
    // buttons at all (the frozen-request retry lives outside the detail and
    // stays hidden here).
    await expect(page.locator("#shadow-detail button")).toHaveCount(0);
    await expect(page.locator("#shadow-retry")).toBeHidden();
    await expect(detail).not.toContainText("成功");
    await expect(detail).not.toContainText("実行しました");

    // The recorded permission CLAIM was not altered, granted, or executed.
    const purposes = await api(page, "GET", `${base}/purposes?limit=50`);
    expect(purposes.status).toBe(200);
    const claim = (
      (purposes.body as { items: Record<string, unknown>[] }).items ?? []
    ).find((row) => row.statement === "ui evening permission claim");
    expect(claim?.status).toBe("active");
    expect(claim?.kind).toBe("permission");
    const stored = await api(page, "GET", `${base}/shadow-jobs/${job.id}`);
    expect(stored.status).toBe(200);
    expect((stored.body as { status: string }).status).toBe("completed");
    expect((stored.body as { policyCode: string }).policyCode).toBe(
      "missing_grant",
    );
    expect((stored.body as { leaseOwner: unknown }).leaseOwner).toBeNull();
  } finally {
    await fx.dispose();
  }
});

test("aborted first POST keeps the frozen request; edited retry refuses and the original scope settles once", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    await configureFixture(request, fx.controlOrigin, {
      plan: ["donothing"],
    });
    const sessionId = await boot(page, fx.origin);
    // Seed while paused so no policy job can race the explicit request;
    // resume through the UI, then prove nothing auto-started.
    await createPurposeUi(page, {
      scope: "health",
      statement: "ui retry goal",
      kind: "goal",
    });
    await page.locator("#autonomy-resume-button").click();
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "再開",
    );
    expect(await listShadowJobs(page, sessionId)).toHaveLength(0);

    // Hold the FIRST real POST: commit it for real, abort ONLY the response.
    let firstPost = true;
    await page.route("**/api/sessions/*/shadow-jobs", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "POST" &&
        firstPost &&
        url.pathname.endsWith("/shadow-jobs")
      ) {
        firstPost = false;
        await route.fetch();
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.locator("#shadow-scope").fill("health");
    await page.locator("#shadow-reason").fill("check in");
    await page.locator("#shadow-request-form button[type=submit]").click();
    await expect(page.locator("#shadow-retry")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("#shadow-status")).toContainText("再送");
    await expect(page.locator("#shadow-status")).toContainText("再送");

    // The backend really committed exactly one job for the original scope.
    const committed = await waitShadowJob(
      page,
      sessionId,
      "health",
      "completed",
    );
    expect(committed.scope).toBe("health");

    // Editing scope/reason then retrying must NOT reuse the old key and must
    // NOT mint a fresh duplicate: the frozen body stays byte-identical.
    await page.locator("#shadow-scope").fill("changed-scope");
    await page.locator("#shadow-reason").fill("changed reason");
    await page.locator("#shadow-retry").click();
    await expect(page.locator("#shadow-status")).toContainText(
      "内容が変更されました",
    );
    await expect(page.locator("#shadow-retry")).toBeHidden();

    const jobs = await listShadowJobs(page, sessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.scope).toBe("health");
    const scopes = jobs.map((job) => job.scope);
    expect(new Set(scopes).size).toBe(1);

    // ONE canonical job, ONE deliberation call: the stored record settles
    // the ORIGINAL scope, no changed request ever reached the old key.
    const settled = await waitShadowJob(page, sessionId, "health", "completed");
    expect(settled.id).toBe(committed.id);
    const stats = await fixtureStats(request, fx.controlOrigin);
    expect(stats.deliberationCalls).toBe(1);
    expect(stats.advertisedTools).toContain("autonomy_deliberation.submit");

    // In-memory frozen request only: no user content in browser storage, and
    // the stale ack path is gone (retry consumed, hidden, single job).
    const stored = await page.evaluate((): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) out[key] = localStorage.getItem(key) ?? "";
      }
      return out;
    });
    for (const value of Object.values(stored)) {
      expect(value).not.toContain("changed-scope");
      expect(value).not.toContain("changed reason");
      expect(value).not.toContain("check in");
    }
    await page.unroute("**/api/sessions/*/shadow-jobs");
  } finally {
    await fx.dispose();
  }
});

test("held detail GET never restores the stale selection after rebinding", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    await configureFixture(request, fx.controlOrigin, {
      plan: ["donothing", "ask"],
    });
    const sessionId = await boot(page, fx.origin);
    // Seed while paused so no policy job can race the sequential explicit
    // requests; resume through the UI, then prove nothing auto-started.
    // Both scopes are seeded while paused so each explicit job's frozen
    // context contains its own sP1 label (no auto job, no cross-scope race).
    await createPurposeUi(page, {
      scope: "scope-a",
      statement: "ui shared goal",
      kind: "goal",
    });
    await createPurposeUi(page, {
      scope: "scope-b",
      statement: "ui shared goal b",
      kind: "goal",
    });
    await page.locator("#autonomy-resume-button").click();
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "再開",
    );
    expect(await listShadowJobs(page, sessionId)).toHaveLength(0);

    // Sequential COMPLETED jobs (global one-claim bound: never parallel).
    await requestShadowUi(page, "scope-a", "first");
    await waitShadowJob(page, sessionId, "scope-a", "completed");
    await requestShadowUi(page, "scope-b", "second");
    await waitShadowJob(page, sessionId, "scope-b", "completed");

    const jobs = await listShadowJobs(page, sessionId);
    const idA = jobs.find((job) => job.scope === "scope-a")?.id;
    expect(typeof idA).toBe("string");

    // Hold the REAL GET detail for A; B passes through untouched.
    const holdA = deferred();
    try {
      await page.route("**/api/sessions/*/shadow-jobs/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === "GET" &&
          url.pathname.endsWith(`/shadow-jobs/${idA as string}`)
        ) {
          await holdA.gate;
        }
        await route.continue();
      });
      const awaitHeldA = page.waitForRequest(
        (candidate) =>
          candidate.method() === "GET" &&
          new URL(candidate.url()).pathname.endsWith(
            `/shadow-jobs/${idA as string}`,
          ),
        { timeout: 15_000 },
      );
      await selectShadowJob(page, "scope-a");
      await awaitHeldA;
      await expect(page.locator("#shadow-detail-body")).toContainText(
        "読み込み中",
      );

      // B still loads while A is held; selecting B clears A's selection.
      await selectShadowJob(page, "scope-b");
      const detail = page.locator("#shadow-detail-body");
      await expect(detail).toContainText("scope-b", { timeout: 15_000 });
      await expect(detail).toContainText("確認案");

      // Release the late A response: it must not restore A.
      holdA.release();
      await page.waitForTimeout(600);
      await expect(detail).toContainText("scope-b");
      await expect(detail).not.toContainText("scope-a");

      // Rebinding cleared the old selection: the request draft (typed scope)
      // was never rewritten by selection traffic.
      expect(await page.locator("#shadow-scope").inputValue()).toBe("scope-b");
    } finally {
      holdA.release();
      await page.unroute("**/api/sessions/*/shadow-jobs/*");
    }
  } finally {
    await fx.dispose();
  }
});

test("STOP-held background output leaves the composer draft alone while ordinary chat completes", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    await configureFixture(request, fx.controlOrigin, {
      plan: ["donothing"],
      parkIndexes: [0],
    });
    const sessionId = await boot(page, fx.origin);

    // Seed owned reads while paused, then resume through the ACTUAL UI so
    // the composer/panel hold the fresh control version (never a stale CAS).
    await createPurposeUi(page, {
      scope: "health",
      statement: "ui stop goal",
      kind: "goal",
    });
    await createStandaloneTaskUi(page, "ui stop task");
    await page.locator("#autonomy-resume-button").click();
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "再開",
    );
    expect(await listShadowJobs(page, sessionId)).toHaveLength(0);

    // Draft in the composer BEFORE the background result lands.
    await page.locator("#composer-input").fill("draft must survive");
    await page.locator("#composer-input").focus();
    await page.evaluate(() => {
      const input = document.getElementById(
        "composer-input",
      ) as HTMLInputElement | null;
      input?.setSelectionRange(0, 5);
    });

    // Request a trial, wait for the provider call to park, then STOP.
    await page.locator("#shadow-scope").fill("health");
    await page.locator("#shadow-reason").fill("parked trial");
    await page.locator("#shadow-request-form button[type=submit]").click();
    // Anchor on the durable job row: the acceptance notice is transient.
    await page.locator("#shadow-job-list").getByText("health").waitFor({
      timeout: 15_000,
    });
    const parkedAt = Date.now();
    for (;;) {
      const stats = await fixtureStats(request, fx.controlOrigin);
      if (stats.deliberationCalls >= 1) break;
      if (Date.now() - parkedAt > 30_000) {
        throw new Error("deliberation call never parked");
      }
      await page.waitForTimeout(100);
    }

    await page.locator("#autonomy-stop-button").click();
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "停止中",
    );
    // Re-establish the composer focus AFTER the explicit STOP click so the
    // assertion below isolates the background result: the button clicks
    // legitimately move focus, but the held landing must not.
    await page.locator("#composer-input").focus();
    await page.evaluate(() => {
      const input = document.getElementById(
        "composer-input",
      ) as HTMLInputElement | null;
      input?.setSelectionRange(0, 5);
    });
    await releaseFixture(request, fx.controlOrigin);

    // Pure STOP holds the late output: control_paused, never executed.
    // Assert the composer BEFORE the explicit selection click below: the
    // held background result must not have touched draft/focus/selection,
    // while the selection click itself legitimately moves focus.
    const held = await waitShadowJob(page, sessionId, "health", "held");
    expect(held.scope).toBe("health");
    expect(await page.locator("#composer-input").inputValue()).toBe(
      "draft must survive",
    );
    expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe(
      "composer-input",
    );
    const selection = await page.evaluate(() => {
      const input = document.getElementById(
        "composer-input",
      ) as HTMLInputElement | null;
      return {
        start: input?.selectionStart ?? -1,
        end: input?.selectionEnd ?? -1,
      };
    });
    expect(selection).toEqual({ start: 0, end: 5 });
    await selectShadowJob(page, "health");
    const detail = page.locator("#shadow-detail-body");
    await expect(detail).toContainText("一時停止中のため保留", {
      timeout: 15_000,
    });
    const stored = await api(
      page,
      "GET",
      `${`/api/sessions/${sessionId}/shadow-jobs/${held.id}`}`,
    );
    expect((stored.body as { holdReason: string }).holdReason).toBe(
      "control_paused",
    );
    expect((stored.body as { leaseOwner: unknown }).leaseOwner).toBeNull();

    // The background result never rewrote the composer draft (selection
    // click aside, the value stays intact).
    expect(await page.locator("#composer-input").inputValue()).toBe(
      "draft must survive",
    );

    // Ordinary chat works while autonomy stays STOPPED: the same gateway
    // serves readonly purpose/task tools, then a native answer.submit.
    await page.locator("#composer-input").fill("hello ordinary");
    await page.locator("#composer-send").click();
    await expect(page.locator("#conversation")).toContainText(
      "ordinary answer ok",
      { timeout: 60_000 },
    );
    await expect(page.locator("#autonomy-control-status")).toContainText(
      "停止中",
    );

    const stats = await fixtureStats(request, fx.controlOrigin);
    expect(stats.ordinaryCalls).toBe(3);
    expect(stats.ordinaryToolCalls).toEqual([
      "purpose.list",
      "task.list",
      "purpose.list",
      "task.list",
    ]);
    expect(stats.advertisedTools).toContain("purpose.list");
    expect(stats.advertisedTools).toContain("purpose.open");
    expect(stats.advertisedTools).toContain("task.list");
    expect(stats.advertisedTools).toContain("task.open");

    // Normal readonly reads created no shadow jobs and no side effects.
    const jobsAfter = await listShadowJobs(page, sessionId);
    expect(jobsAfter).toHaveLength(1);
    expect(jobsAfter[0]?.status).toBe("held");
  } finally {
    await fx.dispose();
  }
});
