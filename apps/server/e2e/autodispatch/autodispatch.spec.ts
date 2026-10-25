// Real-browser Auto-dispatch acceptance over the production UI/server.
//
// No route mocks and no seeded completed ledger: the browser completes a
// normal chat turn, enables ONE standing policy from that exact selected
// user turn, resumes global autonomy on the existing surface, then sends a
// concrete request. The production intake plans it and the EXISTING
// TrialRunner materializes + runs the ACTUAL installed pi-orch launcher with
// a real child Pi worker. Only the model is synthetic (loopback gateway).
//
// Also proves: enable never auto-resumes; discussion/negation creates no
// execution; an unresolved decision stays needs_decision; panel STOP during
// a hanging planner aborts intake with no late grant; a session switch
// clears old controls/plans; untrusted plan text renders as text; and the
// candidate result is never presented as host-applied.

import { randomUUID } from "node:crypto";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  AD_TEXT_ANCHOR,
  AD_TEXT_DISCUSS,
  AD_TEXT_EXECUTE,
  AD_TEXT_MISSING,
  AD_TEXT_XSS,
  AUTODISPATCH_APP_ORIGIN,
  AUTODISPATCH_CONTROL_ORIGIN,
} from "./ports.js";

const README_TEXT =
  "# Synthetic Acceptance\n\nThe child worker read this exact synthetic README.\n";

async function arm(
  request: APIRequestContext,
  mode: "execute" | "discuss" | "missing" | "hang" | "xss",
): Promise<void> {
  const res = await request.post(`${AUTODISPATCH_CONTROL_ORIGIN}/arm`, {
    data: { mode },
  });
  expect(res.ok()).toBe(true);
}

async function controlStatus(request: APIRequestContext): Promise<{
  plannerCalls: number;
  workerIds: string[];
  parentToolNames: string[];
  childToolNames: string[];
  hangingPlannerActive: boolean;
  hangingPlannerAborted: boolean;
  hangingPlannerReleased: boolean;
  hangingPlannerSettled: boolean;
}> {
  const res = await request.get(`${AUTODISPATCH_CONTROL_ORIGIN}/status`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    plannerCalls: number;
    workerIds: string[];
    parentToolNames: string[];
    childToolNames: string[];
    hangingPlannerActive: boolean;
    hangingPlannerAborted: boolean;
    hangingPlannerReleased: boolean;
    hangingPlannerSettled: boolean;
  };
}

/** Deliver the deliberately late, otherwise-valid planner proposal. */
async function releaseHangingPlanner(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.post(
    `${AUTODISPATCH_CONTROL_ORIGIN}/release-hanging-planner`,
  );
  expect(res.ok()).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

async function settle(page: Page, text: string): Promise<void> {
  await expect(page.locator("#conversation")).toContainText(text, {
    timeout: 30_000,
  });
  await expect(page.locator("#composer-send")).toBeEnabled({ timeout: 30_000 });
}

async function resumeAutonomy(page: Page): Promise<void> {
  await page.goto("/tasks");
  await expect(page.locator("#autonomy-control-status")).toBeVisible({
    timeout: 15_000,
  });
  await page.locator("#autonomy-resume-button").click();
  await expect(page.locator("#autonomy-control-status")).toContainText("再開", {
    timeout: 15_000,
  });
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
}

/** Wait for the panel to bind the actual session and offer an enable anchor. */
async function waitForAnchor(page: Page): Promise<void> {
  await expect(page.locator("#autodispatch-panel")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-autodispatch-anchor]")).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Explicit test setup via the REAL production control API: every test
 * starts with global autonomy paused (expectedVersion CAS + idempotency +
 * same-origin), so enabling a policy can never inherit an unpaused stale
 * control. The fixture /reset then aborts/settles only its OWN synthetic
 * gateway/planner state; it never edits ledger rows.
 */
async function pauseAutonomy(request: APIRequestContext): Promise<void> {
  const current = await request.get(
    `${AUTODISPATCH_APP_ORIGIN}/api/autonomy/control`,
  );
  expect(current.ok()).toBe(true);
  const state = (await current.json()) as {
    paused: boolean;
    version: number;
  };
  expect(typeof state.version).toBe("number");
  if (state.paused === true) return;
  const paused = await request.post(
    `${AUTODISPATCH_APP_ORIGIN}/api/autonomy/control`,
    {
      headers: {
        origin: AUTODISPATCH_APP_ORIGIN,
        "idempotency-key": randomUUID(),
      },
      data: {
        paused: true,
        expectedVersion: state.version,
        reason: "e2e-fixture-reset",
      },
    },
  );
  expect(paused.ok()).toBe(true);
  expect(((await paused.json()) as { paused: boolean }).paused).toBe(true);
}

async function enablePolicy(page: Page): Promise<void> {
  await waitForAnchor(page);
  await page.locator(".autodispatch-confirm input").check();
  const enable = page.locator("[data-autodispatch-enable]");
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(page.locator(".autodispatch-notice")).toContainText(
    "スタンディングポリシーを有効化しました",
    { timeout: 15_000 },
  );
}

test.describe("standing-policy auto dispatch", () => {
  test.beforeEach(async ({ page, request }) => {
    await pauseAutonomy(request);
    const res = await request.post(`${AUTODISPATCH_CONTROL_ORIGIN}/reset`);
    expect(res.ok()).toBe(true);
    expect((await res.json()) as { reset: boolean }).toEqual({ reset: true });
    // The pause is durable ledger/control state; reset only clears the
    // synthetic gateway counters, so the precondition must survive it.
    const control = await request.get(
      `${AUTODISPATCH_APP_ORIGIN}/api/autonomy/control`,
    );
    expect(control.ok()).toBe(true);
    expect(((await control.json()) as { paused: boolean }).paused).toBe(true);
    await page.goto("/");
    await expect(page.locator("#composer")).toBeVisible();
  });

  test("normal chat -> policy -> real planner -> actual pi-orch child -> on_ready evidence", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    // 1. A normal foreground chat turn completes first.
    await send(page, AD_TEXT_ANCHOR);
    await settle(page, "Foreground answer accepted.");

    // 2. Human enables ONE policy from that actual selected turn. Enabling
    //    must NOT resume the separate global autonomy control.
    await enablePolicy(page);
    await expect(page.locator("[data-autodispatch-paused]")).toBeVisible();
    await expect(page.locator("[data-autodispatch-target]")).toContainText(
      "autodispatch-e2e",
    );
    await expect(page.locator("#autodispatch-panel")).not.toContainText(
      "/tmp/",
    );
    await expect(page.locator("#autodispatch-panel")).not.toContainText(
      "SHOULD_NOT_BE_READ",
    );

    // 3. Explicit resume happens on the EXISTING autonomy surface.
    await resumeAutonomy(page);
    const resumedControl = await request.get(
      `${AUTODISPATCH_APP_ORIGIN}/api/autonomy/control`,
    );
    expect(resumedControl.ok()).toBe(true);
    expect(((await resumedControl.json()) as { paused: boolean }).paused).toBe(
      false,
    );

    // 4. Concrete request: foreground answers, background planner creates an
    //    execute plan + grant without any per-plan approval.
    await arm(request, "execute");
    await send(page, AD_TEXT_EXECUTE);
    await settle(page, "Foreground answer accepted.");

    await expect(
      page.locator('[data-autodispatch-plan-status="dispatched"]'),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      page.locator('[data-autodispatch-execution-status="authorized"]'),
    ).toBeVisible({ timeout: 90_000 });
    // The dispatch must not run under a paused global control (a paused
    // claim becomes known-quiescence instead of a real bridge exit).
    const dispatchedControl = await request.get(
      `${AUTODISPATCH_APP_ORIGIN}/api/autonomy/control`,
    );
    expect(dispatchedControl.ok()).toBe(true);
    expect(
      ((await dispatchedControl.json()) as { paused: boolean }).paused,
    ).toBe(false);
    // No per-plan approve button exists.
    await expect(page.locator("[data-autodispatch-authorize]")).toHaveCount(0);

    // The result becomes visible as soon as it is ready (on_ready): the
    // fixed check passed and the real candidate was not host-applied.
    await expect(page.locator("[data-autodispatch-outcome]")).toContainText(
      "bridge-exit:0",
      { timeout: 90_000 },
    );
    await expect(page.locator("[data-autodispatch-panel]")).toContainText(
      "読み取りのみ",
    );
    await expect(page.locator("[data-autodispatch-panel]")).toContainText(
      "候補",
    );
    await expect(page.locator("[data-autodispatch-panel]")).not.toContainText(
      "本番反映済み",
    );

    // Actual model route reached the real pi-orch parent and child tools.
    await expect
      .poll(async () => (await controlStatus(request)).workerIds.length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const status = await controlStatus(request);
    expect(status.workerIds.at(-1)).toMatch(/^oc-\d+$/);
    expect(status.parentToolNames).toContain("capsule.opencode_task");
    expect(status.childToolNames).toContain("capsule.read");

    // The synthetic source is unchanged: no host source apply.
    const fixture = await request.get(`${AUTODISPATCH_CONTROL_ORIGIN}/fixture`);
    expect((await fixture.json()).readme).toBe(README_TEXT);

    // 5. Discussion with markup must render as text and create no execution.
    await arm(request, "xss");
    await send(page, AD_TEXT_XSS);
    await settle(page, "Foreground answer accepted.");
    await expect(
      page.locator('[data-autodispatch-plan-status="discuss"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-autodispatch-panel]")).toContainText(
      "相談扱い（実行しません）",
    );
    await expect(page.locator("[data-autodispatch-panel] img")).toHaveCount(0);
    await expect(page.locator("[data-autodispatch-panel] script")).toHaveCount(
      0,
    );
    const xssFlag = await page.evaluate(() => {
      const global = window as unknown as Record<string, unknown>;
      return global.__autodispatchXss ?? null;
    });
    expect(xssFlag).toBeNull();
    expect((await controlStatus(request)).plannerCalls).toBeGreaterThanOrEqual(
      2,
    );

    // Negated request also stays discussion-only (late grant absent).
    await arm(request, "discuss");
    await send(page, AD_TEXT_DISCUSS);
    await settle(page, "Foreground answer accepted.");
    await expect(
      page.locator('[data-autodispatch-plan-status="discuss"]'),
    ).toBeVisible({ timeout: 30_000 });

    // 6. Session switch clears the old controls/plans.
    await page.locator("#session-new").click();
    await expect(page.locator("#autodispatch-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("[data-autodispatch-plan]")).toHaveCount(0);
    await expect(page.locator("[data-autodispatch-policy]")).toHaveCount(0);
    await expect(page.locator("[data-autodispatch-execution]")).toHaveCount(0);
  });

  test("needs_decision then panel STOP during a hanging planner leaves no late grant", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await send(page, AD_TEXT_ANCHOR);
    await settle(page, "Foreground answer accepted.");
    await enablePolicy(page);
    await resumeAutonomy(page);

    // Unresolved user decision -> needs_decision, no execution.
    await arm(request, "missing");
    await send(page, AD_TEXT_MISSING);
    await settle(page, "Foreground answer accepted.");
    await expect(
      page.locator('[data-autodispatch-plan-status="needs_decision"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-autodispatch-missing]")).toBeVisible();
    await expect(page.locator("[data-autodispatch-execution]")).toHaveCount(0);

    // Hanging planner: the actual in-flight planner is awaiting its response.
    await arm(request, "hang");
    await send(page, AD_TEXT_EXECUTE);
    await settle(page, "Foreground answer accepted.");
    await expect
      .poll(async () => (await controlStatus(request)).hangingPlannerActive, {
        timeout: 30_000,
      })
      .toBe(true);

    // STOP ABORTS the real intake while that planner is still pending. The
    // synthetic gateway intentionally ignores the abort, so a late valid
    // proposal can race the stop; the trusted boundary must reject it.
    await page.locator("[data-autodispatch-stop]").click();
    await expect(page.locator(".autodispatch-notice")).toContainText("停止", {
      timeout: 15_000,
    });
    await expect(page.locator("[data-autodispatch-policy]")).toContainText(
      "取消済み",
    );
    await expect
      .poll(async () => (await controlStatus(request)).hangingPlannerAborted, {
        timeout: 15_000,
      })
      .toBe(true);

    // Release the late, otherwise-valid execute proposal AFTER STOP and wait
    // for the deterministic delivery handshake (no arbitrary sleep).
    await releaseHangingPlanner(request);
    await expect
      .poll(async () => (await controlStatus(request)).hangingPlannerSettled, {
        timeout: 15_000,
      })
      .toBe(true);
    expect((await controlStatus(request)).hangingPlannerReleased).toBe(true);

    // The actual API must still show no new plan/grant/execution after the
    // late proposal, and the policy must remain revoked.
    await expect(page.locator("#autodispatch-refresh")).toBeEnabled({
      timeout: 15_000,
    });
    const refreshed = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /\/api\/sessions\/[^/]+\/autodispatch$/.test(
          new URL(response.url()).pathname,
        ) &&
        response.status() === 200,
      { timeout: 15_000 },
    );
    await page.locator("#autodispatch-refresh").click();
    const body = (await (await refreshed).json()) as {
      plans: Array<{ status: string }>;
      executions: unknown[];
      policies: Array<{ status: string }>;
    };
    expect(body.executions).toHaveLength(0);
    // Exactly the one earlier needs_decision plan, now superseded by STOP; the
    // late execute proposal never became a second (frozen/dispatched) plan.
    expect(body.plans.map((plan) => plan.status)).toEqual(["superseded"]);
    expect(body.policies.every((policy) => policy.status !== "active")).toBe(
      true,
    );

    await expect(page.locator("[data-autodispatch-execution]")).toHaveCount(0);
    await expect(
      page.locator('[data-autodispatch-plan-status="dispatched"]'),
    ).toHaveCount(0);
  });
});
