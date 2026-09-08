// M3 UI + SSE wiring tests (plan §16.4, §16.7).
//
// Route ownership/cursor/CSP/asset serving via Hono app.request (no
// listener), plus pure unit tests for the SSE wire helpers and the client
// reducer contract (dup/gap/unknown/failure-only retry/contextual stop).

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostMessageResponseSchema } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  formatRunEventSse,
  pollSseStep,
  SSE_HEARTBEAT_CHUNK,
} from "../src/sse.js";
import { STRICT_CSP, shellHasNoInlineScript } from "../src/ui/page.js";
import {
  applyRunEvent,
  effectiveCursor,
  INITIAL_RUN_VIEW,
  isCorruptCursor,
  runResultToAnswerParts,
} from "../src/ui/reducer.js";

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  close: () => void;
}

async function makeApp(assets?: {
  clientJs?: string;
  clientCss?: string;
}): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-m3-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({
    config,
    repo,
    engine,
    logger,
    ...(assets !== undefined ? { assets } : {}),
  });
  return { ...created, repo, close: () => closeKernelDatabase(handle) };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { host: "127.0.0.1", ...extra };
}

async function seedRun(
  f: Fixture,
): Promise<{ sessionId: string; runId: string }> {
  const sessionId = f.repo.createSession({
    key: randomUUID(),
    now: 1790000000000,
  }).body.sessionId;
  const res = await f.app.request(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      ...headers(),
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ text: "hello" }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { turnId: string; run: { id: string } };
  return { sessionId, runId: body.run.id };
}

describe("M3 SSR shell + CSP + assets", () => {
  it("serves GET / with the strict CSP and no inline script", async () => {
    const f = await makeApp();
    try {
      const res = await f.app.request("/", { headers: headers() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(STRICT_CSP);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('src="/assets/client.js"');
      expect(shellHasNoInlineScript(html)).toBe(true);
      expect(html.toLowerCase()).not.toContain("innerhtml");
    } finally {
      f.close();
    }
  });

  it("serves injected bundle assets and 404s when unbuilt", async () => {
    const built = await makeApp({
      clientJs: "console.log(1)",
      clientCss: "body{}",
    });
    try {
      const js = await built.app.request("/assets/client.js", {
        headers: headers(),
      });
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("javascript");
      expect(await js.text()).toBe("console.log(1)");
      const css = await built.app.request("/assets/client.css", {
        headers: headers(),
      });
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("css");
    } finally {
      built.close();
    }
    const bare = await makeApp();
    try {
      const missing = await bare.app.request("/assets/client.js", {
        headers: headers(),
      });
      expect(missing.status).toBe(404);
    } finally {
      bare.close();
    }
  });
});

describe("M3 SSE route ownership + cursor", () => {
  it("rejects foreign runs with 404 and bad ids with 400", async () => {
    const f = await makeApp();
    try {
      const a = await seedRun(f);
      const b = await seedRun(f);
      const foreign = await f.app.request(
        `/api/sessions/${a.sessionId}/runs/${b.runId}/events/stream`,
        { headers: headers() },
      );
      expect(foreign.status).toBe(404);
      await foreign.body?.cancel();
      const bad = await f.app.request(
        `/api/sessions/not-a-uuid/runs/${b.runId}/events/stream`,
        { headers: headers() },
      );
      expect(bad.status).toBe(400);
      await bad.body?.cancel();
      void a;
    } finally {
      f.close();
    }
  });

  it("opens an event-stream for the owning session", async () => {
    const f = await makeApp();
    try {
      const seeded = await seedRun(f);
      const res = await f.app.request(
        `/api/sessions/${seeded.sessionId}/runs/${seeded.runId}/events/stream?after=0`,
        {
          headers: { ...headers(), "last-event-id": "1" },
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      await res.body?.cancel();
    } finally {
      f.close();
    }
  });
});

describe("M3 SSE wire helpers", () => {
  it("formats id = seq, event = run-event, full DTO data", () => {
    const chunk = formatRunEventSse({
      schemaVersion: 1,
      runId: "r",
      seq: 7,
      type: "run.queued",
      createdAt: 1,
      payload: {},
    });
    expect(chunk.startsWith("id: 7\nevent: run-event\ndata: ")).toBe(true);
    const data = JSON.parse(chunk.split("data: ")[1] as string) as {
      seq: number;
      type: string;
    };
    expect(data.seq).toBe(7);
    expect(data.type).toBe("run.queued");
    expect(SSE_HEARTBEAT_CHUNK).toBe(": heartbeat\n\n");
  });

  it("closes only when terminal and cursor reached event_seq", () => {
    const open = {
      getEvents: () => ({
        events: [],
        nextAfter: 2,
        hasMore: false,
        terminal: false,
      }),
      getRun: () => ({ status: "running", eventSeq: 2 }),
    };
    expect(pollSseStep(open, "s", "r", 2).done).toBe(false);
    const terminalBehind = {
      getEvents: () => ({
        events: [],
        nextAfter: 1,
        hasMore: false,
        terminal: true,
      }),
      getRun: () => ({ status: "completed", eventSeq: 3 }),
    };
    expect(pollSseStep(terminalBehind, "s", "r", 1).done).toBe(false);
    const terminalCaughtUp = {
      getEvents: () => ({
        events: [],
        nextAfter: 3,
        hasMore: false,
        terminal: true,
      }),
      getRun: () => ({ status: "completed", eventSeq: 3 }),
    };
    expect(pollSseStep(terminalCaughtUp, "s", "r", 3).done).toBe(true);
  });

  it("takes max(valid after, valid Last-Event-ID), ignoring invalid", () => {
    expect(effectiveCursor("3", "5")).toBe(5);
    expect(effectiveCursor("abc", null)).toBe(0);
    expect(effectiveCursor("0", "-2")).toBe(0);
    expect(effectiveCursor(undefined, undefined)).toBe(0);
  });

  it("flags corrupt cursors for history resync", () => {
    expect(isCorruptCursor(-1, 5)).toBe(true);
    expect(isCorruptCursor(1.5, 5)).toBe(true);
    expect(isCorruptCursor(99, 5)).toBe(true);
    expect(isCorruptCursor(5, 5)).toBe(false);
    expect(isCorruptCursor(0, 5)).toBe(false);
  });
});

describe("M3 client reducer contract", () => {
  it("ignores duplicates, demands catch-up on gaps, advances on unknown", () => {
    const first = applyRunEvent(INITIAL_RUN_VIEW, {
      seq: 1,
      type: "run.started",
      payload: {},
    });
    expect(first.outcome.kind).toBe("applied");
    expect(first.state.stopVisible).toBe(true);
    const dup = applyRunEvent(first.state, {
      seq: 1,
      type: "run.started",
      payload: {},
    });
    expect(dup.outcome.kind).toBe("ignored-duplicate");
    const gap = applyRunEvent(first.state, {
      seq: 3,
      type: "run.completed",
      payload: {},
    });
    expect(gap.outcome.kind).toBe("needs-catchup");
    const unknown = applyRunEvent(first.state, {
      seq: 2,
      type: "model.step.started",
      payload: {},
    });
    expect(unknown.state.cursor).toBe(2);
  });

  it("maps completed/failed/cancelled to failure-only retry + contextual stop", () => {
    const s1 = applyRunEvent(INITIAL_RUN_VIEW, {
      seq: 1,
      type: "run.started",
      payload: {},
    }).state;
    // Exact contracts `run.completed` payload: `{ result: RunResult }` with
    // V2 carrying the nested StructuredAnswer parts + citations.
    const done = applyRunEvent(s1, {
      seq: 2,
      type: "run.completed",
      payload: {
        result: {
          version: 2,
          text: "hi",
          answer: { version: 1, parts: [{ text: "hi", citations: ["r1"] }] },
        },
      },
    }).state;
    expect(done.visible).toBe("answered");
    expect(done.retryVisible).toBe(false);
    expect(done.stopVisible).toBe(false);
    expect(done.answer).toEqual([{ text: "hi", citations: ["r1"] }]);
    const failed = applyRunEvent(s1, {
      seq: 2,
      type: "run.failed",
      payload: {},
    }).state;
    expect(failed.visible).toBe("failed");
    expect(failed.retryVisible).toBe(true);
    expect(failed.stopVisible).toBe(false);
    const stopped = applyRunEvent(s1, {
      seq: 2,
      type: "run.cancelled",
      payload: {},
    }).state;
    expect(stopped.visible).toBe("stopped");
    expect(stopped.retryVisible).toBe(false);
  });

  it("maps real V1 and V2 RunResult rows to answer parts", () => {
    // V1 historical M0/M1 row: text only, no citations.
    const v1 = runResultToAnswerParts({ version: 1, text: "legacy answer" });
    expect(v1).toEqual([{ text: "legacy answer", citations: [] }]);
    // V2 M2 row: exact part-to-citations mapping of the nested answer.
    const v2 = runResultToAnswerParts({
      version: 2,
      text: "a\n\nb",
      answer: {
        version: 1,
        parts: [
          { text: "a", citations: ["r1", "r2"] },
          { text: "b", citations: [] },
        ],
      },
    });
    expect(v2).toEqual([
      { text: "a", citations: ["r1", "r2"] },
      { text: "b", citations: [] },
    ]);
    // Unknown/invalid shapes never crash: no parts, citations dropped.
    expect(runResultToAnswerParts({})).toEqual([]);
    expect(runResultToAnswerParts({ version: 2, text: "x" })).toEqual([]);
    expect(runResultToAnswerParts(null)).toEqual([]);
    expect(
      applyRunEvent(INITIAL_RUN_VIEW, {
        seq: 1,
        type: "run.completed",
        payload: { result: { version: 1, text: "legacy" } },
      }).state.answer,
    ).toEqual([{ text: "legacy", citations: [] }]);
  });

  it("accept response carries turnId + run.id (client retry/send contract)", async () => {
    // Regression: the client parses the exact contracts `PostMessageResponse`
    // `{ turnId, run: { id } }` (there is no top-level `runId`). A shape
    // drift here silently breaks send/retry subscribe + Turn tracking.
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const res = await f.app.request(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          ...headers(),
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      const parsed = PostMessageResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.sessionId).toBe(sessionId);
        expect(typeof parsed.data.turnId).toBe("string");
        expect(typeof parsed.data.run.id).toBe("string");
        expect(parsed.data.run.status).toBe("queued");
        // No top-level `runId`: the client reads `run.id` (exact contract).
        expect("runId" in body).toBe(false);
      }
    } finally {
      f.close();
    }
  });

  it("gap catch-up converges: re-apply after fill advances the cursor", () => {
    // Regression for the serialized gap path: a gap event reports
    // needs-catchup without applying; once the missing seq is filled, the
    // same event re-applies and the cursor advances (persist-after-apply).
    const s1 = applyRunEvent(INITIAL_RUN_VIEW, {
      seq: 1,
      type: "run.started",
      payload: {},
    }).state;
    const gapEvent = { seq: 3, type: "run.completed", payload: {} };
    const gap = applyRunEvent(s1, gapEvent);
    expect(gap.outcome.kind).toBe("needs-catchup");
    expect(gap.state.cursor).toBe(1);
    const filled = applyRunEvent(s1, {
      seq: 2,
      type: "model.step.started",
      payload: {},
    });
    expect(filled.outcome.kind).toBe("applied");
    const second = applyRunEvent(filled.state, gapEvent);
    expect(second.outcome.kind).toBe("applied");
    expect(second.state.cursor).toBe(3);
    expect(second.state.visible).toBe("answered");
  });

  it("cancel_requested is non-terminal: stays active until run.cancelled", () => {
    // Regression for HEAD fix (§11.5/§16.2/§16.6 exact): cancel_requested
    // already shows「停止しました」but must NOT release the run — the view
    // stays generating with stop offered; only run.cancelled is terminal.
    const s1 = applyRunEvent(INITIAL_RUN_VIEW, {
      seq: 1,
      type: "run.started",
      payload: {},
    }).state;
    const requested = applyRunEvent(s1, {
      seq: 2,
      type: "run.cancel_requested",
      payload: {},
    });
    expect(requested.outcome.kind).toBe("applied");
    expect(requested.state.cursor).toBe(2);
    expect(requested.state.visible).toBe("generating");
    expect(requested.state.notice).toBe("停止しました");
    expect(requested.state.stopVisible).toBe(true);
    expect(requested.state.retryVisible).toBe(false);
    // Fallback poll continuation invariant: stopVisible true means the run
    // is still active, so the JSON status poll must keep polling (the
    // terminal check is `!stopVisible`, never the notice text).
    expect(requested.state.stopVisible).toBe(true);
    const terminal = applyRunEvent(requested.state, {
      seq: 3,
      type: "run.cancelled",
      payload: {},
    });
    expect(terminal.outcome.kind).toBe("applied");
    expect(terminal.state.visible).toBe("stopped");
    expect(terminal.state.notice).toBe("停止しました");
    expect(terminal.state.stopVisible).toBe(false);
    expect(terminal.state.retryVisible).toBe(false);
  });

  it("SSR shell exposes the composer live-region for cancel notices", async () => {
    // Regression for HEAD page.ts fix: the client renders cancel notices
    // into #composer-notice (aria-live polite); without that node the
    //「停止しました」/「停止できませんでした」notice has no target.
    const f = await makeApp();
    try {
      const res = await f.app.request("/", { headers: headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="composer-notice"');
      expect(html).toContain("aria-live");
    } finally {
      f.close();
    }
  });
});

describe("M3 client frozen-request + unbounded fallback source contract", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    join(here, "..", "src", "ui", "client.ts"),
    "utf8",
  );

  it("freezes key+body once: resend reuses pendingRequest without refetch", () => {
    // Regression for HEAD frozen-resend fix (§16.7/§9 exact): the reference
    // context is fetched once into the frozen pendingRequest; resend() must
    // reuse it as-is so the replay body hash stays stable.
    expect(source).toContain("private pendingRequest");
    expect(source).toContain("fetchUiContext");
    const resendStart = source.indexOf("async resend()");
    expect(resendStart).toBeGreaterThan(-1);
    const resendBody = source.slice(resendStart, resendStart + 800);
    expect(resendBody).toContain("pendingRequest");
    expect(resendBody).not.toContain("fetchUiContext");
  });

  it("fallback poll is unbounded: no tick cap, disposes on new run, absorbs transient errors", () => {
    // Regression for HEAD unbounded-fallback fix (§16.7): the poll runs
    // until terminal or disposal, never a fixed 60-tick cutoff, and never
    // cancels the run on stream loss.
    expect(source).not.toContain("tick < 60");
    expect(source).toContain("POLL_MAX_ERROR_STREAK");
    expect(source).toContain("POLL_INTERVAL_MS");
    const pollStart = source.indexOf("private async pollFallback");
    expect(pollStart).toBeGreaterThan(-1);
    const pollBody = source.slice(pollStart, pollStart + 2500);
    expect(pollBody).toContain("activeRunId !== runId");
    expect(pollBody).toContain("stopVisible");
  });
});
