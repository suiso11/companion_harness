import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  E2E_APP_ORIGIN,
  E2E_CONTROL_ORIGIN,
  E2E_PROXY_ORIGIN,
  TEXT_HANG,
} from "./ports.js";

declare global {
  interface Window {
    __cursorWrites: Array<{ key: string; value: string }>;
    __nativeRunDeliveries: Array<{
      sourceId: number;
      url: string;
      data: string;
      lastEventId: string;
      readyState: number;
      sameNativeTarget: boolean;
    }>;
  }
}

export interface FaultStatus {
  blockedSse: number;
  duplicatedFrames: number;
  failedPages: number;
  eventsPageRequests: number;
  pagesInFlight: number;
  pagesFinished: number;
  maxPagesInFlight: number;
  heldPages: number;
  historyRequests: number;
  cancelRequests: number;
  pageTimings: Array<{ start: number; finish: number | null; status: number }>;
}

export async function fault(
  request: APIRequestContext,
  path: string,
  data: unknown = {},
): Promise<void> {
  const response = await request.post(`${E2E_PROXY_ORIGIN}/proxy/${path}`, {
    data,
  });
  expect(response.ok()).toBe(true);
}

export async function strategy(
  request: APIRequestContext,
  path: string,
): Promise<void> {
  const response = await request.post(`${E2E_CONTROL_ORIGIN}/${path}`, {
    data: {},
  });
  expect(response.ok()).toBe(true);
}

export async function faultStatus(
  request: APIRequestContext,
): Promise<FaultStatus> {
  const response = await request.get(`${E2E_PROXY_ORIGIN}/proxy/status`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as FaultStatus;
}

export async function startHangingRun(
  page: Page,
): Promise<{ sessionId: string; runId: string }> {
  await page.goto(`${E2E_PROXY_ORIGIN}/`);
  await expect(page.locator("#composer-send")).toBeEnabled();
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/messages") &&
      response.request().method() === "POST",
  );
  await page.locator("#composer-input").fill(TEXT_HANG);
  await page.locator("#composer-send").click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const body = (await response.json()) as { run: { id: string } };
  const sessionId = await page.evaluate(() =>
    localStorage.getItem("ch.sessionId"),
  );
  expect(sessionId).not.toBeNull();
  return { sessionId: sessionId as string, runId: body.run.id };
}

export async function canonical(
  request: APIRequestContext,
  sessionId: string,
  runId: string,
): Promise<{
  run: { status: string; eventSeq: number };
  events: Array<{ seq: number; type: string; payload: unknown }>;
}> {
  const root = `${E2E_APP_ORIGIN}/api/sessions/${sessionId}/runs/${runId}`;
  const status = await request.get(`${root}/status`);
  const events = await request.get(`${root}/events?after=0&limit=50`);
  expect(status.ok()).toBe(true);
  expect(events.ok()).toBe(true);
  const statusBody = (await status.json()) as {
    run: { status: string; eventSeq: number };
  };
  const eventBody = (await events.json()) as {
    events: Array<{ seq: number; type: string; payload: unknown }>;
  };
  return { run: statusBody.run, events: eventBody.events };
}

export async function observeCursorWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: Array<{ key: string; value: string }> = [];
    Object.defineProperty(window, "__cursorWrites", { value: writes });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      original.call(this, key, value);
      if (this === localStorage && key.startsWith("ch.cursor.")) {
        writes.push({ key, value });
      }
    };
  });
}

export async function cursorWrites(
  page: Page,
  runId: string,
): Promise<number[]> {
  return page.evaluate((id) => {
    return window.__cursorWrites
      .filter((write) => write.key === `ch.cursor.${id}`)
      .map((write) => Number(write.value));
  }, runId);
}

/** Add a passive listener after the unchanged production registration. */
export async function observeNativeRunDeliveries(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const deliveries: Window["__nativeRunDeliveries"] = [];
    Object.defineProperty(window, "__nativeRunDeliveries", {
      value: deliveries,
    });
    const observed = new WeakSet<EventSource>();
    let sourceId = 0;
    const original = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (
      this: EventSource,
      type: string,
      callback:
        | EventListenerOrEventListenerObject
        | ((this: EventSource, event: MessageEvent) => unknown),
      options?: boolean | AddEventListenerOptions,
    ): void {
      original.call(this, type, callback as EventListener, options);
      if (type !== "run-event" || observed.has(this)) return;
      observed.add(this);
      const id = ++sourceId;
      original.call(this, type, (event: Event) => {
        const message = event as MessageEvent<string>;
        deliveries.push({
          sourceId: id,
          url: this.url,
          data: message.data,
          lastEventId: message.lastEventId,
          readyState: this.readyState,
          sameNativeTarget:
            event.currentTarget === this && this instanceof EventSource,
        });
      });
    };
  });
}

export async function nativeRunDeliveries(page: Page, runId: string) {
  return page.evaluate(
    (id) =>
      window.__nativeRunDeliveries.filter((delivery) =>
        delivery.url.includes(`/runs/${id}/`),
      ),
    runId,
  );
}

/** Observe genuine fetch lifetimes; never replace fetch or EventSource. */
export function observePages(
  page: Page,
): Array<{ start: number; finish: number | null }> {
  const timings: Array<{ start: number; finish: number | null }> = [];
  const requests = new Map<Request, { start: number; finish: number | null }>();
  page.on("request", (request) => {
    if (/\/runs\/[^/]+\/events\?/.test(request.url())) {
      const timing = { start: Date.now(), finish: null as number | null };
      requests.set(request, timing);
      timings.push(timing);
    }
  });
  const finished = (request: Request): void => {
    const timing = requests.get(request);
    if (timing !== undefined) {
      timing.finish = Date.now();
    }
  };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  return timings;
}
