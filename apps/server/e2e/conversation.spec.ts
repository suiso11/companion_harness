// Real-browser smoke E2E over the production UI/server/core.
//
// No API mocks: every flow drives the real composer UI (#composer-input,
// #composer-send, #composer-stop, #composer-notice) against the real Hono
// app + RunEngine. The deterministic fake RunStrategy (e2e/server.ts)
// chooses behavior from the input text only (ports.ts TEXT_*). Failure
// injection uses the loopback-only control server via the Node-side
// `request` fixture (never page.fetch, never mocked responses).

import { expect, test, type Page } from "@playwright/test";
import {
  E2E_CONTROL_ORIGIN,
  TEXT_FAIL,
  TEXT_HANG,
  TEXT_OK,
} from "./ports.js";

async function control(
  request: import("@playwright/test").APIRequestContext,
  path: "/arm-fail" | "/release" | "/reset",
): Promise<void> {
  const res = await request.post(`${E2E_CONTROL_ORIGIN}${path}`);
  expect(res.ok()).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
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

test("send answers with the deterministic echo", async ({ page }) => {
  await send(page, TEXT_OK);
  // Optimistic user bubble renders immediately.
  await expect(page.locator("#conversation")).toContainText(TEXT_OK);
  // Terminal answer from the fake strategy (no real LLM).
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_OK}`,
    { timeout: 15_000 },
  );
  // Composer is usable again once the run is terminal.
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#composer-stop")).toBeHidden();
});

test("type while active keeps submit disabled, stop cancels the run", async ({
  page,
}) => {
  await send(page, TEXT_HANG);
  // Run active: submit disabled, stop offered.
  await expect(page.locator("#composer-send")).toBeDisabled();
  await expect(page.locator("#composer-stop")).toBeVisible();
  // Type-while-active: the input stays enabled (no message queue).
  const input = page.locator("#composer-input");
  await expect(input).toBeEnabled();
  await input.fill("typing while generating");
  expect(await input.inputValue()).toBe("typing while generating");
  // Contextual stop: cancel posts, the run stays active until terminal.
  await page.locator("#composer-stop").click();
  await expect(page.locator("#composer-notice")).toContainText("停止しました", {
    timeout: 15_000,
  });
  // Terminal cancelled: composer released, no retry offered for cancels.
  await expect(page.locator("#composer-send")).toBeEnabled();
  await expect(page.locator("#composer-stop")).toBeHidden();
  await expect(page.locator("#conversation")).not.toContainText("もう一度送る");
});

test("failure surfaces a retry that succeeds", async ({ page, request }) => {
  await control(request, "/arm-fail");
  await send(page, TEXT_FAIL);
  // Failure-only retry: fixed notice + explicit retry control.
  await expect(page.locator("#composer-notice")).toContainText(
    "生成に失敗しました",
    { timeout: 15_000 },
  );
  const retry = page.locator("#conversation", { hasText: "もう一度送る" });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  // The arm is consumed: the retry run succeeds deterministically.
  await page.getByRole("button", { name: "もう一度送る" }).click();
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_FAIL}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("privacy: strict CSP, no inline script, minimal localStorage", async ({
  page,
}) => {
  const cspCheck = await page.request.get("/");
  expect(cspCheck.ok()).toBe(true);
  const csp = cspCheck.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-inline");

  const html = await cspCheck.text();
  expect(html).toContain('src="/assets/client.js"');
  expect(html).not.toMatch(/<script(?![^>]*src="\/assets\/client\.js")/i);
  expect(html).not.toMatch(/\son\w+\s*=/i);

  await send(page, TEXT_OK);
  await expect(page.locator("#conversation")).toContainText(
    `echo:${TEXT_OK}`,
    { timeout: 15_000 },
  );

  // Browser persistence is minimal: session id, per-run cursors, and the
  // pending idempotency key only. Bodies and answer text are never stored.
  const stored = await page.evaluate((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) {
        out[key] = localStorage.getItem(key) ?? "";
      }
    }
    return out;
  });
  for (const key of Object.keys(stored)) {
    expect(key).toMatch(/^(ch\.sessionId|ch\.pendingKey|ch\.cursor\.)/);
  }
  expect(JSON.stringify(stored)).not.toContain(`echo:${TEXT_OK}`);
});
