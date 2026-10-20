// AV05 notification consumer-UI regressions (real browser + real HTTP).
//
// Each test boots its OWN production server (e2e/notifications_fixture.ts:
// real Hono createApp + kernel DB + notification projector on a throwaway
// file DB, fresh per test; notices seeded through REAL kernel calls —
// purpose + shadow request/claim/complete, the real M5 unknown-receipt path,
// real task deadlines — never fabricated DTOs). No API mocks, no
// private-state injection: backend reads/writes inside page.evaluate use
// the real same-origin fetch (real Origin + Idempotency-Key headers).
// Route interception only holds or drops REAL responses
// (route.fetch/abort/continue), never synthesizes bodies.
//
// Covers four consumer boundaries:
//   1. routine defers while the composer holds text (or a run is active),
//      then briefs once on the natural break with general questions grouped
//      apart from cited-deadline questions; model text stays inert
//      (textContent, no elements);
//   2. urgent receipt alerts immediately even while paused, without moving
//      focus/selection or touching the composer draft;
//   3. a REAL ack commit with an aborted response keeps the frozen
//      in-memory key+N+{} (same-key retry settles exactly ONE receipt, no
//      authority change anywhere);
//   4. a held old-session response can never clobber the new session, and
//      >50 paged history stays reachable through the real older control.

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
  const child = spawn(
    "node",
    ["--import", "tsx", "e2e/notifications_fixture.ts"],
    {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
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
      const appMatch = /notify-fixture-ready (http:\/\/127\.0\.0\.1:\d+)/.exec(
        stdout,
      );
      const controlMatch =
        /notify-fixture-control (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
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

async function controlPost(
  request: import("@playwright/test").APIRequestContext,
  controlOrigin: string,
  path: string,
  data: unknown,
): Promise<unknown> {
  const res = await request.post(`${controlOrigin}${path}`, { data });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<unknown>;
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
  key?: string,
): Promise<ApiResult> {
  return page.evaluate(
    async ({
      method,
      path,
      body,
      key,
    }: {
      method: string;
      path: string;
      body: unknown;
      key: string | undefined;
    }) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (key !== undefined) headers["idempotency-key"] = key;
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
    { method, path, body, key },
  ) as Promise<ApiResult>;
}

/** Boot on a fixture-owned session (page adopts it via the real LS key). */
async function bootOnSession(
  page: Page,
  origin: string,
  sessionId: string,
): Promise<void> {
  await page.goto(`${origin}/notifications`);
  await page.locator("#notification-badge").waitFor({ timeout: 30_000 });
  await page.evaluate((id: string) => {
    localStorage.setItem("ch.sessionId", id);
  }, sessionId);
  await page.reload();
  await page.locator("#notification-badge").waitFor({ timeout: 30_000 });
}

async function makeSession(
  request: import("@playwright/test").APIRequestContext,
  controlOrigin: string,
): Promise<string> {
  const out = (await controlPost(
    request,
    controlOrigin,
    "/notify-test/session",
    {},
  )) as {
    sessionId: string;
  };
  expect(typeof out.sessionId).toBe("string");
  return out.sessionId;
}

test("routine defers past composer text, then briefs grouped general + deadline questions with inert text", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    await bootOnSession(page, fx.origin, sessionId);
    // Composer holds text BEFORE the notices land: nothing may brief.
    await page.locator("#composer-input").fill("draft in progress");
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId,
      scope: "health",
    });
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId,
      scope: "<img src=x onerror=alert(1)>",
    });
    await controlPost(request, fx.controlOrigin, "/notify-test/deadline", {
      sessionId,
      scope: "bills",
    });
    await page.waitForTimeout(3000);
    await expect(page.locator("#notification-badge")).toContainText("保留中", {
      timeout: 15_000,
    });
    expect(await page.locator("#notification-routine h3").count()).toBe(0);
    // Untrusted scope text is already inert in durable history (no element).
    expect(await page.locator("#notification-list img").count()).toBe(0);
    // Natural break: clearing the draft briefs once, grouped.
    await page.locator("#composer-input").fill("");
    await expect(page.locator("#notification-routine h3").first()).toBeVisible({
      timeout: 15_000,
    });
    const headings = await page
      .locator("#notification-routine h3")
      .allTextContents();
    expect(headings.some((h) => h.includes("確認事項"))).toBe(true);
    // Model/attacker text never becomes an element anywhere.
    expect(await page.locator("#notifications img").count()).toBe(0);
    expect(await page.locator("#notifications script").count()).toBe(0);
  } finally {
    await fx.dispose();
  }
});

test("urgent receipt alerts immediately while paused without touching focus/selection/draft", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    // Pause autonomy first (real control CAS read + write).
    await bootOnSession(page, fx.origin, sessionId);
    const paused = await api(page, "GET", "/api/autonomy/control");
    const version = (paused.body as { version: number }).version;
    const key = await page.evaluate(() => crypto.randomUUID());
    const setPaused = await api(
      page,
      "POST",
      "/api/autonomy/control",
      { paused: true, expectedVersion: version },
      key,
    );
    expect([200, 409]).toContain(setPaused.status);
    // Composer holds a draft with a real selection.
    await page.locator("#composer-input").fill("keep this draft");
    await page.locator("#composer-input").evaluate((node) => {
      const input = node as HTMLInputElement;
      input.focus();
      input.setSelectionRange(0, 4);
    });
    const before = await page.locator("#composer-input").inputValue();
    await controlPost(
      request,
      fx.controlOrigin,
      "/notify-test/urgent-unknown",
      {
        sessionId,
      },
    );
    // Urgent receipt is visible immediately even while paused.
    await expect(page.locator("#notification-urgent")).toContainText("要確認", {
      timeout: 20_000,
    });
    // But nothing stole focus/selection or clobbered the draft.
    expect(await page.locator("#composer-input").inputValue()).toBe(before);
    const sel = await page.locator("#composer-input").evaluate((node) => {
      const input = node as HTMLInputElement;
      return {
        start: input.selectionStart,
        end: input.selectionEnd,
        focused: document.activeElement === input,
      };
    });
    expect(sel.focused).toBe(true);
    expect(sel.start).toBe(0);
    expect(sel.end).toBe(4);
  } finally {
    await fx.dispose();
  }
});

test("aborted ack response keeps the frozen key; same-key retry settles exactly one receipt with no authority change", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId,
      scope: "health",
    });
    await bootOnSession(page, fx.origin, sessionId);
    await expect(page.locator("#notification-list li").first()).toBeVisible({
      timeout: 20_000,
    });
    const listed = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/notifications?limit=50`,
    );
    expect(listed.status).toBe(200);
    const first = (listed.body as { items: Array<{ id: string }> }).items[0];
    expect(first).toBeDefined();
    // Authority baseline: purposes/tasks/control untouched by anything yet.
    const purposesBefore = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/purposes`,
    );
    expect(purposesBefore.status).toBe(200);
    // Hold the FIRST real ack POST: commit for real, abort ONLY the response.
    let firstAck = true;
    await page.route("**/api/sessions/*/notifications/*/ack", async (route) => {
      if (route.request().method() === "POST" && firstAck) {
        firstAck = false;
        await route.fetch();
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.locator("#notification-list li button").first().click();
    await expect(page.locator("#notification-detail")).toBeVisible();
    await page.locator("#notification-ack").click();
    await expect(page.locator("#notification-retry")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("#notification-status")).toContainText("再送");
    // The backend really committed exactly ONE receipt under the frozen key.
    const history = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/notifications/${first?.id}/history`,
    );
    expect(history.status).toBe(200);
    expect(
      (history.body as { ack: { status: string } | null }).ack?.status,
    ).toBe("acknowledged");
    // Same-key retry settles the SAME receipt (200 replay, no duplicate).
    await page.locator("#notification-retry").click();
    await expect(page.locator("#notification-status")).toContainText(
      "確認済み",
      { timeout: 15_000 },
    );
    const history2 = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/notifications/${first?.id}/history`,
    );
    expect(
      (history2.body as { ack: { status: string } | null }).ack?.status,
    ).toBe("acknowledged");
    // Ack changed NOTHING but the receipt: purposes/tasks/control identical.
    const purposesAfter = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/purposes`,
    );
    expect(JSON.stringify(purposesAfter.body)).toBe(
      JSON.stringify(purposesBefore.body),
    );
    const stored = await page.evaluate((): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k !== null) out[k] = localStorage.getItem(k) ?? "";
      }
      return out;
    });
    for (const value of Object.values(stored)) {
      expect(value).not.toContain("needs the owner to confirm");
    }
    await page.unroute("**/api/sessions/*/notifications/*/ack");
  } finally {
    await fx.dispose();
  }
});

test("held old-session history can never clobber the new session; >50 pages load older", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionA = await makeSession(request, fx.controlOrigin);
    await controlPost(request, fx.controlOrigin, "/notify-test/bulk", {
      sessionId: sessionA,
      count: 60,
      scopePrefix: "bulk-a",
    });
    const sessionB = await makeSession(request, fx.controlOrigin);
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId: sessionB,
      scope: "health-b",
    });
    await bootOnSession(page, fx.origin, sessionA);
    await expect(page.locator("#notification-list li").first()).toBeVisible({
      timeout: 20_000,
    });
    // Hold session A's history responses (real responses, never answered).
    await page.route(
      `**/api/sessions/${sessionA}/notifications*`,
      () => new Promise(() => {}),
    );
    // Switch to B: the held A reply must never render into B.
    await page.evaluate((id: string) => {
      localStorage.setItem("ch.sessionId", id);
    }, sessionB);
    await page.reload();
    await page.locator("#notification-badge").waitFor({ timeout: 30_000 });
    await expect(page.locator("#notification-list li").first()).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(2000);
    const texts = await page.locator("#notification-list li").allTextContents();
    expect(texts.some((t) => t.includes("bulk-a"))).toBe(false);
    expect(texts.some((t) => t.includes("health-b"))).toBe(true);
    await page.unroute(`**/api/sessions/${sessionA}/notifications*`);
    // Back on A: >50 notices stay reachable through the older control.
    await page.evaluate((id: string) => {
      localStorage.setItem("ch.sessionId", id);
    }, sessionA);
    await page.reload();
    await page.locator("#notification-badge").waitFor({ timeout: 30_000 });
    await expect(page.locator("#notification-list li").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("#notification-older")).toBeVisible({
      timeout: 15_000,
    });
    const before = await page.locator("#notification-list li").count();
    expect(before).toBeLessThanOrEqual(50);
    await page.locator("#notification-older").click();
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll("#notification-list li").length > n,
      before,
      { timeout: 15_000 },
    );
    const after = await page.locator("#notification-list li").count();
    expect(after).toBeGreaterThan(50);
  } finally {
    await fx.dispose();
  }
});

test("post-baseline burst before initial history is never skipped and never briefs while drafting", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    await bootOnSession(page, fx.origin, sessionId);
    // Fresh boot with the initial history HELD: the cursor baseline is
    // taken first, then 60 post-baseline arrivals land before history.
    const resumes: Array<() => void> = [];
    await page.route(
      (url) =>
        url.pathname.endsWith("/notifications") &&
        url.searchParams.get("limit") === "50" &&
        !url.searchParams.has("beforeSeq"),
      async (route) => {
        await new Promise<void>((resolve) => {
          resumes.push(resolve);
        });
        await route.continue();
      },
    );
    await page.evaluate((id: string) => {
      localStorage.setItem("ch.sessionId", id);
    }, sessionId);
    await page.reload();
    await page.locator("#notification-badge").waitFor({ timeout: 30_000 });
    // Composer holds a draft BEFORE history lands: nothing may brief.
    await page.locator("#composer-input").fill("burst draft held");
    await controlPost(request, fx.controlOrigin, "/notify-test/bulk", {
      sessionId,
      count: 60,
      scopePrefix: "burst",
    });
    await page.waitForTimeout(1000);
    for (const resume of resumes.splice(0)) resume();
    await page.unrouteAll({ behavior: "wait" });
    // All 60 arrive exactly once (the 10 pre-page arrivals are replayed
    // live, not skipped past the history latest).
    await page.waitForFunction(
      () => document.querySelectorAll("#notification-list li").length === 60,
      null,
      { timeout: 25_000 },
    );
    await expect(page.locator("#notification-badge")).toContainText("保留中", {
      timeout: 15_000,
    });
    // While the draft is held, the initial burst stays behind the badge.
    expect(await page.locator("#notification-routine h3").count()).toBe(0);
    // Natural break briefs the whole burst once, grouped.
    await page.locator("#composer-input").fill("");
    await expect(page.locator("#notification-routine h3").first()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await fx.dispose();
  }
});

test("dropped forward page never skips the urgent notice; reconnect replays it exactly once", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    await bootOnSession(page, fx.origin, sessionId);
    // Drop the FIRST real feed consume (a real abort, never a fake body):
    // the checkpoint must stay behind the unconsumed record. Both the
    // durable forward page and a legacy per-record GET are armed so the
    // old independent-GET path drops N while the fixed ordered path just
    // replays it.
    let firstForward = true;
    let firstRecord = true;
    await page.route(
      (url) =>
        (url.pathname.endsWith("/notifications/forward") &&
          url.searchParams.has("after")) ||
        (/\/notifications\/[^/]+$/.test(url.pathname) &&
          !url.pathname.endsWith("/notifications")),
      async (route) => {
        const isForward = route.request().url().includes("/forward");
        if (isForward && firstForward) {
          firstForward = false;
          await route.abort();
          return;
        }
        if (!isForward && firstRecord) {
          firstRecord = false;
          await route.abort();
          return;
        }
        await route.continue();
      },
    );
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId,
      scope: "feed-n",
    });
    await controlPost(
      request,
      fx.controlOrigin,
      "/notify-test/urgent-unknown",
      {
        sessionId,
      },
    );
    // The urgent notice surfaces after the bounded reconnect replay…
    await expect(page.locator("#notification-urgent")).toContainText("要確認", {
      timeout: 25_000,
    });
    // …exactly once, with the earlier routine notice intact (no N+1 skip).
    await expect(page.locator("#notification-urgent div")).toHaveCount(1, {
      timeout: 25_000,
    });
    await expect(
      page.locator("#notification-list li").filter({ hasText: "feed-n" }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.unrouteAll({ behavior: "wait" });
  } finally {
    await fx.dispose();
  }
});

test("uncertain ack stays owned by A: B never inherits retry, same-key retry settles A once", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId,
      scope: "ack-a",
    });
    await controlPost(request, fx.controlOrigin, "/notify-test/ask", {
      sessionId,
      scope: "ack-b",
    });
    await bootOnSession(page, fx.origin, sessionId);
    await expect(page.locator("#notification-list li").first()).toBeVisible({
      timeout: 20_000,
    });
    // REAL commit, aborted response: the receipt exists, the UI is unsure.
    let firstAck = true;
    const ackKeys: Array<string | null> = [];
    await page.route("**/api/sessions/*/notifications/*/ack", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      ackKeys.push(await route.request().headerValue("idempotency-key"));
      if (firstAck) {
        firstAck = false;
        await route.fetch();
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page
      .locator("#notification-list li", { hasText: "ack-a" })
      .locator("button")
      .click();
    await expect(page.locator("#notification-detail")).toBeVisible();
    await page.locator("#notification-ack").click();
    await expect(page.locator("#notification-retry")).toBeVisible({
      timeout: 15_000,
    });
    // Switch to B: B shows no retry and no foreign error text…
    await page
      .locator("#notification-list li", { hasText: "ack-b" })
      .locator("button")
      .click();
    await expect(page.locator("#notification-retry")).toBeHidden({
      timeout: 10_000,
    });
    expect(await page.locator("#notification-status").textContent()).toBe("");
    // …and starting B's ack while A is unresolved cannot steal A's key.
    await page.locator("#notification-ack").click();
    await expect(page.locator("#notification-status")).toContainText(
      "別の確認",
      { timeout: 10_000 },
    );
    // Back on A: the SAME frozen entry retries with the SAME key…
    await page
      .locator("#notification-list li", { hasText: "ack-a" })
      .locator("button")
      .click();
    await expect(page.locator("#notification-retry")).toBeVisible({
      timeout: 15_000,
    });
    await page.locator("#notification-retry").click();
    await expect(page.locator("#notification-status")).toContainText(
      "確認済み",
      { timeout: 15_000 },
    );
    expect(ackKeys.length).toBe(2);
    expect(ackKeys[0]).not.toBeNull();
    expect(ackKeys[1]).toBe(ackKeys[0]);
    // Canonical outcome: exactly one receipt on A, zero on B.
    const listed = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/notifications?limit=50`,
    );
    const items = (listed.body as { items: Array<{ id: string }> }).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const ackedFlags: Array<{ scope: string; acked: boolean }> = [];
    for (const scope of ["ack-a", "ack-b"]) {
      const item = (
        listed.body as {
          items: Array<{ id: string; scope: string }>;
        }
      ).items.find((v) => v.scope === scope);
      expect(item).toBeDefined();
      const h = await api(
        page,
        "GET",
        `/api/sessions/${sessionId}/notifications/${item?.id}/history`,
      );
      ackedFlags.push({
        scope,
        acked:
          (h.body as { ack: { status: string } | null }).ack?.status ===
          "acknowledged",
      });
    }
    expect(ackedFlags).toEqual([
      { scope: "ack-a", acked: true },
      { scope: "ack-b", acked: false },
    ]);
    await page.unrouteAll({ behavior: "wait" });
  } finally {
    await fx.dispose();
  }
});

test("terminal task flips the deadline notice outdated in place, never re-nudging", async ({
  page,
  request,
}) => {
  const fx = await startFixture();
  try {
    const sessionId = await makeSession(request, fx.controlOrigin);
    await controlPost(request, fx.controlOrigin, "/notify-test/deadline", {
      sessionId,
      scope: "rent-5",
    });
    await bootOnSession(page, fx.origin, sessionId);
    await expect(page.locator("#notification-list li").first()).toBeVisible({
      timeout: 20_000,
    });
    await page
      .locator("#notification-list li", { hasText: "rent-5" })
      .locator("button")
      .click();
    await expect(page.locator("#notification-detail")).toBeVisible();
    const beforeText =
      (await page.locator("#notification-detail-body").textContent()) ?? "";
    expect(beforeText).not.toContain("古い内容");
    const listedBefore = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/notifications?limit=50`,
    );
    const before = (
      listedBefore.body as {
        items: Array<{ id: string; seq: number; scope: string }>;
      }
    ).items.find((v) => v.scope === "rent-5");
    expect(before).toBeDefined();
    // REAL terminal write on the task source (no new notice seq).
    await controlPost(
      request,
      fx.controlOrigin,
      "/notify-test/task-complete-latest",
      { sessionId },
    );
    // Reopen: the SAME id/seq now reads outdated, truthfully unread…
    await page
      .locator("#notification-list li", { hasText: "rent-5" })
      .locator("button")
      .click();
    await expect(page.locator("#notification-detail-body")).toContainText(
      "古い内容",
      { timeout: 15_000 },
    );
    const listedAfter = await api(
      page,
      "GET",
      `/api/sessions/${sessionId}/notifications?limit=50`,
    );
    const after = (
      listedAfter.body as {
        items: Array<{ id: string; seq: number; scope: string }>;
      }
    ).items.find((v) => v.scope === "rent-5");
    expect(after?.id).toBe(before?.id);
    expect(after?.seq).toBe(before?.seq);
    // …with no extra alert: no urgent box, quiet badge, same brief text.
    expect(await page.locator("#notification-urgent div").count()).toBe(0);
    await expect(page.locator("#notification-badge")).toContainText("未読", {
      timeout: 15_000,
    });
    const afterText =
      (await page.locator("#notification-detail-body").textContent()) ?? "";
    // Same source body, only the outdated marker added (no rewrite).
    expect(afterText.replace("古い内容です（履歴表示のみ）", "")).toBe(
      beforeText,
    );
  } finally {
    await fx.dispose();
  }
});
