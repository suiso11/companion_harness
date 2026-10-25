// AGORA real-browser review E2E.
//
// Drives the REAL Svelte UI over the REAL Hono app, real RunEngine, real
// agent strategy/ToolBroker, real AGORA store and real approval/send routes.
// The ONLY substitutes are the synthetic ModelGateway (emits the real
// `agora.propose_thread` + `answer.submit` tool calls) and the injected
// local `AgoraTransport` (records writes; no public network, no real key).
//
// Covers: agent-created pending proposal with exact malicious text rendered
// inertly, pending approve/reject with Send disabled, approve with zero
// transport writes, one explicit Send with exactly one verified transport
// call, reload/refresh without replay, session switch dropping the prior
// session's rows/controls, a rejected proposal that cannot be sent, an
// ambiguous Send that becomes terminal unknown without retry, and the
// unconfigured-AGORA server 404 hiding the whole panel.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  AGORA_AMBIGUOUS_APP_ORIGIN,
  AGORA_AMBIGUOUS_BODY,
  AGORA_AMBIGUOUS_TITLE,
  AGORA_BODY,
  AGORA_CONTROL_ORIGIN,
  AGORA_DISABLED_APP_ORIGIN,
  AGORA_REJECT_BODY,
  AGORA_REJECT_TITLE,
  AGORA_RESULT_THREAD_ID,
  AGORA_RESULT_URL,
  AGORA_TEXT_AMBIGUOUS,
  AGORA_TEXT_PROPOSE,
  AGORA_TEXT_REJECT,
  AGORA_TITLE,
} from "./ports.js";

interface Observation {
  attempts: number;
  posts: Array<{
    path: string;
    body: unknown;
    hasAgentKey: boolean;
  }>;
}

interface Status {
  success: Observation;
  ambiguous: Observation;
  disabled: Observation;
}

async function reset(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${AGORA_CONTROL_ORIGIN}/reset`);
  expect(res.ok()).toBe(true);
}

async function status(request: APIRequestContext): Promise<Status> {
  const res = await request.get(`${AGORA_CONTROL_ORIGIN}/status`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Status;
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
}

async function panelItem(page: Page) {
  const item = page.locator("#agora-panel [data-agora-proposal]").first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  return item;
}

async function exactText(
  locator: import("@playwright/test").Locator,
  expected: string,
): Promise<void> {
  await expect(locator).toBeVisible();
  expect(await locator.textContent()).toBe(expected);
}

test.beforeEach(async ({ page, request }) => {
  await reset(request);
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();
});

test("agent proposal renders exact untrusted text; approve sends nothing and one Send is verified with no replay", async ({
  page,
  request,
}) => {
  await send(page, AGORA_TEXT_PROPOSE);
  const item = await panelItem(page);

  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "pending",
    { timeout: 15_000 },
  );
  await exactText(item.locator('[data-agora-title="true"]'), AGORA_TITLE);
  await exactText(item.locator('[data-agora-body="true"]'), AGORA_BODY);
  // Interpolation only: no markup elements or executing script from the
  // proposal text, and no inline handler ran.
  await expect(item.locator("script, img, b")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __agoraXss?: unknown }).__agoraXss,
    ),
  ).toBeUndefined();

  const sendButton = item.locator('[data-agora-send="true"]');
  await expect(item.locator('[data-agora-approve="true"]')).toBeEnabled();
  await expect(item.locator('[data-agora-reject="true"]')).toBeEnabled();
  await expect(sendButton).toBeDisabled();
  expect((await status(request)).success.attempts).toBe(0);

  // Approve is a human decision only: no external/transport write yet.
  await item.locator('[data-agora-approve="true"]').click();
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "approved",
    { timeout: 15_000 },
  );
  await expect(sendButton).toBeEnabled();
  const afterApprove = await status(request);
  expect(afterApprove.success.attempts).toBe(0);
  expect(afterApprove.success.posts).toHaveLength(0);

  // A separate explicit Send: exactly one write with the approved bytes.
  await sendButton.click();
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "sent",
    { timeout: 15_000 },
  );
  const link = item.locator('[data-agora-result-link="true"]');
  await expect(link).toHaveAttribute("href", AGORA_RESULT_URL);
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(item.locator('[data-agora-result="true"]')).toContainText(
    AGORA_RESULT_THREAD_ID,
  );
  const afterSend = await status(request);
  expect(afterSend.success.attempts).toBe(1);
  expect(afterSend.success.posts).toHaveLength(1);
  expect(afterSend.success.posts[0]?.path).toBe("/api/threads");
  expect(afterSend.success.posts[0]?.body).toEqual({
    title: AGORA_TITLE,
    body: AGORA_BODY,
  });
  expect(afterSend.success.posts[0]?.hasAgentKey).toBe(true);
  await expect(sendButton).toBeDisabled();

  // Reload + explicit refresh re-read the durable state; no replay.
  await page.reload();
  await expect(page.locator("#composer")).toBeVisible();
  const reloaded = await panelItem(page);
  await expect(reloaded.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "sent",
    { timeout: 15_000 },
  );
  await exactText(reloaded.locator('[data-agora-title="true"]'), AGORA_TITLE);
  await exactText(reloaded.locator('[data-agora-body="true"]'), AGORA_BODY);
  await expect(reloaded.locator('[data-agora-send="true"]')).toBeDisabled();
  await page.locator("#agora-refresh").click();
  await expect(reloaded.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "sent",
  );
  const afterReload = await status(request);
  expect(afterReload.success.attempts).toBe(1);
  expect(afterReload.success.posts).toHaveLength(1);

  // Session switch: the prior session's rows and decision controls are gone.
  const sessionA = await page.locator("#session-list").inputValue();
  expect(sessionA.length).toBeGreaterThan(0);
  await page.locator("#session-new").click();
  await expect(page.locator("#session-list")).not.toHaveValue(sessionA);
  await expect(page.locator("#agora-panel [data-agora-proposal]")).toHaveCount(
    0,
  );
  await expect(page.locator("#agora-panel [data-agora-approve]")).toHaveCount(
    0,
  );
  await expect(page.locator("#agora-panel [data-agora-reject]")).toHaveCount(0);
  await expect(page.locator("#agora-panel [data-agora-send]")).toHaveCount(0);
  // Switching back re-reads only that session's durable rows.
  await page.locator("#session-list").selectOption(sessionA);
  const restored = await panelItem(page);
  await expect(restored.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "sent",
    { timeout: 15_000 },
  );
  await exactText(restored.locator('[data-agora-title="true"]'), AGORA_TITLE);
  expect((await status(request)).success.attempts).toBe(1);
});

test("a freshly rejected proposal can never be sent", async ({
  page,
  request,
}) => {
  await send(page, AGORA_TEXT_REJECT);
  const item = await panelItem(page);
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "pending",
    { timeout: 15_000 },
  );
  await exactText(
    item.locator('[data-agora-title="true"]'),
    AGORA_REJECT_TITLE,
  );
  await exactText(item.locator('[data-agora-body="true"]'), AGORA_REJECT_BODY);

  await item.locator('[data-agora-reject="true"]').click();
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "rejected",
    { timeout: 15_000 },
  );
  await expect(item).toContainText("却下済みです。送信できません。");
  await expect(item.locator('[data-agora-send="true"]')).toBeDisabled();
  await expect(item.locator('[data-agora-approve="true"]')).toBeDisabled();
  await expect(item.locator('[data-agora-reject="true"]')).toBeDisabled();
  const observed = await status(request);
  expect(observed.success.attempts).toBe(0);
  expect(observed.success.posts).toHaveLength(0);

  await page.reload();
  const reloaded = await panelItem(page);
  await expect(reloaded.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "rejected",
    { timeout: 15_000 },
  );
  await expect(reloaded.locator('[data-agora-send="true"]')).toBeDisabled();
  expect((await status(request)).success.attempts).toBe(0);
});

test("an ambiguous Send becomes terminal unknown and is never retried", async ({
  page,
  request,
}) => {
  await page.goto(`${AGORA_AMBIGUOUS_APP_ORIGIN}/`);
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#composer-send")).toBeEnabled();

  await send(page, AGORA_TEXT_AMBIGUOUS);
  const item = await panelItem(page);
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "pending",
    { timeout: 15_000 },
  );
  await exactText(
    item.locator('[data-agora-title="true"]'),
    AGORA_AMBIGUOUS_TITLE,
  );
  await exactText(
    item.locator('[data-agora-body="true"]'),
    AGORA_AMBIGUOUS_BODY,
  );
  await item.locator('[data-agora-approve="true"]').click();
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "approved",
    { timeout: 15_000 },
  );
  await item.locator('[data-agora-send="true"]').click();
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "unknown",
    { timeout: 15_000 },
  );
  await expect(item).toContainText("結果不明です。再送せず");
  await expect(item.locator('[data-agora-send="true"]')).toBeDisabled();
  await expect(item.locator('[data-agora-approve="true"]')).toBeDisabled();
  const afterSend = await status(request);
  expect(afterSend.ambiguous.attempts).toBe(1);
  expect(afterSend.ambiguous.posts).toHaveLength(0);

  // Refresh + reload only re-read state: the terminal unknown is never sent
  // again automatically (or by the refresh control).
  await page.locator("#agora-refresh").click();
  await expect(item.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "unknown",
  );
  await page.reload();
  const reloaded = await panelItem(page);
  await expect(reloaded.locator("[data-agora-status]")).toHaveAttribute(
    "data-agora-status",
    "unknown",
    { timeout: 15_000 },
  );
  await expect(reloaded.locator('[data-agora-send="true"]')).toBeDisabled();
  const afterReload = await status(request);
  expect(afterReload.ambiguous.attempts).toBe(1);
  expect(afterReload.ambiguous.posts).toHaveLength(0);
});

test("a server without AGORA config hides the panel after the real 404", async ({
  page,
}) => {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/agora/proposals"),
    { timeout: 15_000 },
  );
  await page.goto(`${AGORA_DISABLED_APP_ORIGIN}/`);
  const response = await responsePromise;
  expect(response.status()).toBe(404);
  await expect(page.locator("#composer")).toBeVisible();
  await expect(page.locator("#agora-panel")).toHaveCount(0);
});
