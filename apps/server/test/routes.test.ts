// Server route tests via Hono app.request (no listener).
//
// Uses an in-memory kernel DB plus a real (unstarted) RunEngine so cancel
// keeps DB-first ordering. Strategies are injected fakes only where the
// repository needs terminal runs; production code registers no model.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  generateId,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger, type ServerLogRecord } from "../src/logger.js";

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } };
  raw: { close: () => void; open: boolean };
  records: ServerLogRecord[];
  close: () => void;
}

async function makeApp(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-routes-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger, records } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  return {
    ...created,
    repo,
    db: handle.raw as unknown as Fixture["db"],
    raw: handle.raw as unknown as Fixture["raw"],
    records,
    close: () => closeKernelDatabase(handle),
  };
}

function postHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    host: "127.0.0.1",
    ...extra,
  };
}

async function postJson(
  app: CreatedServerApp["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: postHeaders(headers),
    body: JSON.stringify(body),
  });
}

function count(db: Fixture["db"], table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

describe("sessions + messages + idempotency", () => {
  it("creates a session and replays the same key", async () => {
    const f = await makeApp();
    try {
      const key = randomUUID();
      const first = await postJson(f.app, "/api/sessions", {});
      void first;
      const withKey = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": key },
        body: "{}",
      });
      expect(withKey.status).toBe(201);
      const created = (await withKey.json()) as { sessionId: string };
      const replay = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": key },
        body: "{}",
      });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(created);

      const missing = await postJson(f.app, "/api/sessions", {});
      expect(missing.status).toBe(400);
      const bad = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": "not-a-uuid" },
        body: "{}",
      });
      expect(bad.status).toBe(400);
      expect(count(f.db, "api_idempotency")).toBe(1);
    } finally {
      f.close();
    }
  });

  it("posts a message, replays it, and conflicts on key reuse", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const key = randomUUID();
      const headers = { ...postHeaders(), "idempotency-key": key };
      const first = await f.app.request(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hello" }),
      });
      expect(first.status).toBe(202);
      const accepted = (await first.json()) as {
        turnId: string;
        run: { id: string };
      };
      const replay = await f.app.request(
        `/api/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "hello" }),
        },
      );
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(accepted);
      const conflict = await f.app.request(
        `/api/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "different" }),
        },
      );
      expect(conflict.status).toBe(409);
      expect((await conflict.json()) as unknown).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "idempotency key already used",
        },
      });
      expect(count(f.db, "turns")).toBe(1);
      // Active run present: a second message is session_busy and not persisted.
      const busy = await postJson(
        f.app,
        `/api/sessions/${sessionId}/messages`,
        { text: "again" },
        { "idempotency-key": randomUUID() },
      );
      expect(busy.status).toBe(409);
      expect(
        ((await busy.json()) as { error: { code: string } }).error.code,
      ).toBe("session_busy");
      expect(count(f.db, "turns")).toBe(1);
      expect(count(f.db, "api_idempotency")).toBe(2);
      void accepted;
    } finally {
      f.close();
    }
  });

  it("rejects unknown sessions and blank text without persisting", async () => {
    const f = await makeApp();
    try {
      const ghost = randomUUID();
      const res = await postJson(
        f.app,
        `/api/sessions/${ghost}/messages`,
        { text: "hi" },
        {
          "idempotency-key": randomUUID(),
        },
      );
      expect(res.status).toBe(404);
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const blank = await postJson(
        f.app,
        `/api/sessions/${sessionId}/messages`,
        { text: "   " },
        { "idempotency-key": randomUUID() },
      );
      expect(blank.status).toBe(400);
      expect(count(f.db, "api_idempotency")).toBe(1);
    } finally {
      f.close();
    }
  });
});

describe("retry + cancel + history + events + lookup", () => {
  async function settledConversation(): Promise<{
    f: Fixture;
    sessionId: string;
    turnId: string;
    runId: string;
    key: string;
  }> {
    const f = await makeApp();
    const sessionId = f.repo.createSession({
      key: randomUUID(),
      now: 1790000000000,
    }).body.sessionId;
    const key = randomUUID();
    const posted = f.repo.postMessage(
      sessionId,
      { text: "question" },
      { key, now: 1790000000000 },
    ).body;
    f.repo.startRun(posted.run.id, { now: 1790000000001 });
    f.repo.completeRun(
      posted.run.id,
      { version: 1, text: "answer" },
      { now: 1790000000002 },
    );
    return { f, sessionId, turnId: posted.turnId, runId: posted.run.id, key };
  }

  it("retries a terminal turn and enforces ownership", async () => {
    const { f, sessionId, turnId } = await settledConversation();
    try {
      const retry = await postJson(
        f.app,
        `/api/sessions/${sessionId}/turns/${turnId}/retries`,
        {},
        { "idempotency-key": randomUUID() },
      );
      expect(retry.status).toBe(202);
      const body = (await retry.json()) as { run: { attempt: number } };
      expect(body.run.attempt).toBe(2);
      const other = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const foreign = await postJson(
        f.app,
        `/api/sessions/${other}/turns/${turnId}/retries`,
        {},
        { "idempotency-key": randomUUID() },
      );
      expect(foreign.status).toBe(404);
    } finally {
      f.close();
    }
  });

  it("cancels queued directly and is state-idempotent on terminal runs", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "q" },
        {
          key: randomUUID(),
          now: 1790000000000,
        },
      ).body;
      const cancel = await postJson(
        f.app,
        `/api/sessions/${sessionId}/runs/${posted.run.id}/cancel`,
        {},
      );
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({
        run: { id: posted.run.id, status: "cancelled" },
      });
      const again = await postJson(
        f.app,
        `/api/sessions/${sessionId}/runs/${posted.run.id}/cancel`,
        {},
      );
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        run: { id: posted.run.id, status: "cancelled" },
      });
      const missing = await postJson(
        f.app,
        `/api/sessions/${sessionId}/runs/${randomUUID()}/cancel`,
        {},
      );
      expect(missing.status).toBe(404);
    } finally {
      f.close();
    }
  });

  it("reports cancel_requested for running runs", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "q" },
        {
          key: randomUUID(),
          now: 1790000000000,
        },
      ).body;
      f.repo.startRun(posted.run.id, { now: 1790000000001 });
      const cancel = await postJson(
        f.app,
        `/api/sessions/${sessionId}/runs/${posted.run.id}/cancel`,
        {},
      );
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({
        run: { id: posted.run.id, status: "cancel_requested" },
      });
    } finally {
      f.close();
    }
  });

  it("serves history projection with exclusive cursors", async () => {
    const { f, sessionId } = await settledConversation();
    try {
      const history = await f.app.request(
        `/api/sessions/${sessionId}/history`,
        {
          headers: { host: "127.0.0.1" },
        },
      );
      expect(history.status).toBe(200);
      const body = (await history.json()) as {
        items: Array<{
          text: string;
          selectedRun: { result: { text: string } } | null;
        }>;
        hasMore: boolean;
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.text).toBe("question");
      expect(body.items[0]?.selectedRun?.result.text).toBe("answer");
      expect(body.hasMore).toBe(false);
      const empty = await f.app.request(
        `/api/sessions/${sessionId}/history?beforePosition=1`,
        {
          headers: { host: "127.0.0.1" },
        },
      );
      expect(((await empty.json()) as { items: unknown[] }).items).toHaveLength(
        0,
      );
      const bad = await f.app.request(
        `/api/sessions/${sessionId}/history?limit=101`,
        {
          headers: { host: "127.0.0.1" },
        },
      );
      expect(bad.status).toBe(400);
    } finally {
      f.close();
    }
  });

  it("serves events with after-exclusive + nextAfter semantics", async () => {
    const { f, sessionId, runId } = await settledConversation();
    try {
      const page = await f.app.request(
        `/api/sessions/${sessionId}/runs/${runId}/events?after=0&limit=50`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(page.status).toBe(200);
      const body = (await page.json()) as {
        events: Array<{ seq: number }>;
        nextAfter: number;
        hasMore: boolean;
        terminal: boolean;
      };
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.nextAfter).toBe(body.events[body.events.length - 1]?.seq);
      expect(body.terminal).toBe(true);
      const tail = await f.app.request(
        `/api/sessions/${sessionId}/runs/${runId}/events?after=${body.nextAfter}`,
        { headers: { host: "127.0.0.1" } },
      );
      const tailBody = (await tail.json()) as {
        events: unknown[];
        nextAfter: number;
      };
      expect(tailBody.events).toHaveLength(0);
      expect(tailBody.nextAfter).toBe(body.nextAfter);
      const bad = await f.app.request(
        `/api/sessions/${sessionId}/runs/${runId}/events?after=-1`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(bad.status).toBe(400);
      const other = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const foreign = await f.app.request(
        `/api/sessions/${other}/runs/${runId}/events`,
        {
          headers: { host: "127.0.0.1" },
        },
      );
      expect(foreign.status).toBe(404);
    } finally {
      f.close();
    }
  });

  it("looks up idempotency with session ownership", async () => {
    const { f, sessionId, key } = await settledConversation();
    try {
      const scope = `session:${sessionId}:message`;
      const found = await f.app.request(
        `/api/sessions/${sessionId}/idempotency/${key}?scope=${encodeURIComponent(scope)}`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(found.status).toBe(200);
      const foundBody = (await found.json()) as {
        found: boolean;
        status: number;
      };
      expect(foundBody.found).toBe(true);
      expect(foundBody.status).toBe(202);
      const absent = await f.app.request(
        `/api/sessions/${sessionId}/idempotency/${randomUUID()}?scope=${encodeURIComponent(scope)}`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(await absent.json()).toEqual({
        found: false,
        code: "resend_required",
      });
      // sessions:create lookup must match the path session.
      const createKey = randomUUID();
      const created = f.repo.createSession({
        key: createKey,
        now: 1790000000000,
      }).body;
      const okLookup = await f.app.request(
        `/api/sessions/${created.sessionId}/idempotency/${createKey}?scope=sessions:create`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(((await okLookup.json()) as { found: boolean }).found).toBe(true);
      const wrongSession = await f.app.request(
        `/api/sessions/${sessionId}/idempotency/${createKey}?scope=sessions:create`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(wrongSession.status).toBe(404);
      const noScope = await f.app.request(
        `/api/sessions/${sessionId}/idempotency/${key}`,
        {
          headers: { host: "127.0.0.1" },
        },
      );
      expect(noScope.status).toBe(400);
    } finally {
      f.close();
    }
  });
});

describe("host, mutation security, health, drain", () => {
  it("enforces strict Host and same-origin mutations without CORS", async () => {
    const f = await makeApp();
    try {
      const badHost = await f.app.request("/health/live", {
        headers: { host: "evil.example" },
      });
      expect(badHost.status).toBe(400);
      const evil = await postJson(
        f.app,
        "/api/sessions",
        {},
        {
          origin: "https://evil.example",
          "idempotency-key": randomUUID(),
        },
      );
      expect(evil.status).toBe(403);
      const nullOrigin = await postJson(
        f.app,
        "/api/sessions",
        {},
        {
          origin: "null",
          "idempotency-key": randomUUID(),
        },
      );
      expect(nullOrigin.status).toBe(403);
      const textType = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...postHeaders(),
          "content-type": "text/plain",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(textType.status).toBe(400);
      // Missing Origin is accepted as a local CLI-style request.
      const cli = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(cli.status).toBe(201);
      expect(cli.headers.get("access-control-allow-origin")).toBeNull();
      expect(cli.headers.get("access-control-allow-credentials")).toBeNull();
    } finally {
      f.close();
    }
  });

  it("serves exact health and drain admission without persistence", async () => {
    const f = await makeApp();
    try {
      expect(
        await (
          await f.app.request("/health/live", {
            headers: { host: "127.0.0.1" },
          })
        ).json(),
      ).toEqual({ status: "live" });
      expect(
        await (
          await f.app.request("/health/ready", {
            headers: { host: "127.0.0.1" },
          })
        ).json(),
      ).toEqual({ status: "ready" });
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const before = count(f.db, "api_idempotency");
      f.controls.markDraining();
      const live = await f.app.request("/health/live", {
        headers: { host: "127.0.0.1" },
      });
      expect(live.status).toBe(200);
      const ready = await f.app.request("/health/ready", {
        headers: { host: "127.0.0.1" },
      });
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "not_ready",
        code: "server_shutting_down",
      });
      const rejected = await postJson(
        f.app,
        `/api/sessions/${sessionId}/messages`,
        { text: "late" },
        { "idempotency-key": randomUUID() },
      );
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("5");
      expect(
        ((await rejected.json()) as { error: { code: string } }).error.code,
      ).toBe("server_shutting_down");
      expect(count(f.db, "api_idempotency")).toBe(before);
    } finally {
      f.close();
    }
  });

  it("never logs message text or response content", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const secret = `secret-text-${randomUUID()}`;
      await postJson(
        f.app,
        `/api/sessions/${sessionId}/messages`,
        { text: secret },
        {
          "idempotency-key": randomUUID(),
        },
      );
      const dumped = JSON.stringify(f.records);
      expect(dumped).not.toContain(secret);
      expect(dumped).not.toContain("companion.sqlite");
      for (const record of f.records) {
        expect(Object.keys(record).sort()).toEqual(
          expect.arrayContaining(["code", "level", "ts"]),
        );
      }
    } finally {
      f.close();
    }
  });
});

describe("M0 review regressions", () => {
  it("enforces byte-bounded streaming bodies (early length + UTF-8 bytes)", async () => {
    const f = await makeApp();
    try {
      const bigText = "a".repeat(300_000);
      const oversized = await postJson(
        f.app,
        "/api/sessions",
        { text: "ignored" },
        { "idempotency-key": randomUUID() },
      );
      void oversized;
      // Char-count would pass but UTF-8 bytes exceed the 256KiB cap:
      // multibyte body must be rejected by byte length, not char length.
      const multi = `é`.repeat(200_000);
      const multiRes = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...postHeaders(),
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ unexpected: multi }),
      });
      expect(multiRes.status).toBe(400);
      // Declared Content-Length beyond the cap fails without streaming.
      const lied = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          ...postHeaders(),
          "idempotency-key": randomUUID(),
          "content-length": String(300_000),
        },
        body: "{}",
      });
      expect(lied.status).toBe(400);
      // Oversized actual body is rejected and never persisted.
      const before = count(f.db, "api_idempotency");
      const huge = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": randomUUID() },
        body: JSON.stringify({ unexpected: bigText }),
      });
      expect(huge.status).toBe(400);
      expect(count(f.db, "api_idempotency")).toBe(before);
      void bigText;
    } finally {
      f.close();
    }
  });

  it("rejects non-object cancel bodies strictly", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "q" },
        { key: randomUUID(), now: 1790000000000 },
      ).body;
      for (const body of [`[]`, `5`, `"x"`, `null`, `{"unknown":1}`]) {
        const res = await f.app.request(
          `/api/sessions/${sessionId}/runs/${posted.run.id}/cancel`,
          { method: "POST", headers: postHeaders(), body },
        );
        expect(res.status).toBe(400);
      }
      const ok = await postJson(
        f.app,
        `/api/sessions/${sessionId}/runs/${posted.run.id}/cancel`,
        {},
      );
      expect(ok.status).toBe(200);
    } finally {
      f.close();
    }
  });

  it("rejects unknown or duplicated query keys", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "q" },
        { key: randomUUID(), now: 1790000000000 },
      ).body;
      const unknownHistory = await f.app.request(
        `/api/sessions/${sessionId}/history?bogus=1`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(unknownHistory.status).toBe(400);
      const dupHistory = await f.app.request(
        `/api/sessions/${sessionId}/history?limit=10&limit=10`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(dupHistory.status).toBe(400);
      const dupEvents = await f.app.request(
        `/api/sessions/${sessionId}/runs/${posted.run.id}/events?after=0&after=0`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(dupEvents.status).toBe(400);
      const unknownEvents = await f.app.request(
        `/api/sessions/${sessionId}/runs/${posted.run.id}/events?after=0&extra=1`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(unknownEvents.status).toBe(400);
      const scope = `session:${sessionId}:message`;
      const dupLookup = await f.app.request(
        `/api/sessions/${sessionId}/idempotency/${randomUUID()}?scope=${encodeURIComponent(scope)}&scope=${encodeURIComponent(scope)}`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(dupLookup.status).toBe(400);
      const unknownLookup = await f.app.request(
        `/api/sessions/${sessionId}/idempotency/${randomUUID()}?scope=${encodeURIComponent(scope)}&other=1`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(unknownLookup.status).toBe(400);
      // Exact known behavior still works.
      const okHistory = await f.app.request(
        `/api/sessions/${sessionId}/history?limit=10`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(okHistory.status).toBe(200);
    } finally {
      f.close();
    }
  });

  it("distinguishes browser-like missing-Origin from CLI-style requests", async () => {
    const f = await makeApp();
    try {
      const browserLike = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          "idempotency-key": randomUUID(),
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
        },
        body: "{}",
      });
      expect(browserLike.status).toBe(403);
      expect(
        ((await browserLike.json()) as { error: { code: string } }).error.code,
      ).toBe("validation_error");
      const cli = await f.app.request("/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(cli.status).toBe(201);
      expect(cli.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      f.close();
    }
  });

  it("maps internal failures to fixed 500 internal_error", async () => {
    const f = await makeApp();
    try {
      const broken = {
        ...f.repo,
        getHistory: () => {
          throw new Error("boom with secret detail");
        },
      };
      const { createApp: makeBrokenApp } = await import("../src/app.js");
      const { loadServerConfig: loadConfig } = await import("../src/config.js");
      const { createCollectingLogger: collect } = await import(
        "../src/logger.js"
      );
      const config = loadConfig({
        COMPANION_DB_PATH: join(
          mkdtempSync(join(tmpdir(), "companion-500-")),
          "db.sqlite",
        ),
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "3000",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "error",
      });
      const { logger } = collect("error");
      const { default: __unused } = await import("node:crypto").catch(() => ({
        default: undefined,
      }));
      void __unused;
      const created = makeBrokenApp({
        config,
        repo: broken as unknown as typeof f.repo,
        engine: {
          cancel: () => ({ status: "cancelled" }),
          shutdown: async () => ({ abandoned: 0, cancelled: 0 }),
        },
        logger,
      });
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      void sessionId;
      // Use a session known to the real DB through the broken app's repo
      // wrapper: any getHistory call now throws an unexpected error.
      const res = await created.app.request(
        `/api/sessions/${sessionId}/history`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("internal_error");
      expect(JSON.stringify(body)).not.toContain("boom");
    } finally {
      f.close();
    }
  });

  it("requires the path session to exist for sessions:create lookups", async () => {
    const f = await makeApp();
    try {
      const ghost = randomUUID();
      const ghostLookup = await f.app.request(
        `/api/sessions/${ghost}/idempotency/${randomUUID()}?scope=sessions:create`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(ghostLookup.status).toBe(404);
    } finally {
      f.close();
    }
  });

  it("replays the exact stored status and body", async () => {
    const f = await makeApp();
    try {
      const key = randomUUID();
      const first = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": key },
        body: "{}",
      });
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      const replay = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": key },
        body: "{}",
      });
      // Must use the stored out.status, not a hard-coded replacement.
      expect(replay.status).toBe(first.status);
      expect(await replay.json()).toEqual(firstBody);
    } finally {
      f.close();
    }
  });

  it("rejects invalid UTF-8 JSON bodies as validation_error", async () => {
    const f = await makeApp();
    try {
      const before = count(f.db, "api_idempotency");
      // Lone continuation byte / truncated sequence: fatal TextDecoder must throw.
      const invalid = new Uint8Array([
        0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d,
      ]);
      const res = await f.app.request("/api/sessions", {
        method: "POST",
        headers: { ...postHeaders(), "idempotency-key": randomUUID() },
        body: Buffer.from(invalid),
      });
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("validation_error");
      expect(count(f.db, "api_idempotency")).toBe(before);
    } finally {
      f.close();
    }
  });

  it("exposes no HTTP maintenance routes (CLI only)", async () => {
    const f = await makeApp();
    try {
      for (const path of [
        "/api/backups",
        "/api/backup",
        "/api/restore",
        "/api/maintenance/backup",
      ]) {
        const get = await f.app.request(path, {
          headers: { host: "127.0.0.1" },
        });
        expect(get.status).toBe(404);
        const post = await f.app.request(path, {
          method: "POST",
          headers: { ...postHeaders(), "idempotency-key": randomUUID() },
          body: "{}",
        });
        expect(post.status).toBe(404);
      }
    } finally {
      f.close();
    }
  });
});

describe("M1 stored-only references", () => {
  const T0 = 1790000000000;
  async function seededRefs(f: Fixture): Promise<{
    sessionId: string;
    referenceId: string;
    setId: string;
    secret: string;
  }> {
    const sessionId = f.repo.createSession({
      key: randomUUID(),
      now: T0,
    }).body.sessionId;
    const posted = f.repo.postMessage(
      sessionId,
      { text: "q" },
      { key: randomUUID(), now: T0 },
    ).body;
    f.repo.startRun(posted.run.id, { now: T0 + 1 });
    const manager = createReferenceManager(
      f.raw as unknown as Parameters<typeof createReferenceManager>[0],
    );
    const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
      now: T0,
    });
    const secret = `stored-secret-${randomUUID()}`;
    const presented = manager.presentObservations(
      sessionId,
      posted.run.id,
      [
        {
          connectorInstanceId: connector.id,
          canonicalKey: "notes/a.md",
          title: "A",
          text: secret,
          sourceRevision: "rev-1",
          observedAt: T0,
        },
      ],
      { freshness: "normal", now: T0 + 2 },
    );
    if (!presented.applied || presented.setId === null) {
      throw new Error("expected presentation to apply");
    }
    const referenceId = presented.references[0]?.referenceId;
    if (referenceId === undefined) {
      throw new Error("expected a presented reference");
    }
    return { sessionId, referenceId, setId: presented.setId, secret };
  }

  function getHeaders(): Record<string, string> {
    return { host: "127.0.0.1" };
  }

  async function putContext(
    app: CreatedServerApp["app"],
    path: string,
    body: unknown,
  ): Promise<Response> {
    return app.request(path, {
      method: "PUT",
      headers: { ...postHeaders() },
      body: JSON.stringify(body),
    });
  }

  it("serves stored GETs with saved bodies and creates no events/grants", async () => {
    const f = await makeApp();
    try {
      const { sessionId, referenceId, setId, secret } = await seededRefs(f);
      const eventsBefore = count(f.db, "run_events");
      const grantsBefore = count(f.db, "evidence_grants");
      const list = await f.app.request(
        `/api/sessions/${sessionId}/references`,
        { headers: getHeaders() },
      );
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as {
        items: Array<{ id: string; ordinal: number }>;
      };
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0]?.id).toBe(referenceId);
      const detail = await f.app.request(
        `/api/sessions/${sessionId}/references/${referenceId}`,
        { headers: getHeaders() },
      );
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as {
        reference: { id: string; sessionId: string };
        body: { version: number; text: string };
      };
      expect(detailBody.reference.id).toBe(referenceId);
      expect(detailBody.reference.sessionId).toBe(sessionId);
      expect(detailBody.body).toEqual({ version: 1, text: secret });
      const set = await f.app.request(
        `/api/sessions/${sessionId}/reference-sets/${setId}`,
        { headers: getHeaders() },
      );
      expect(set.status).toBe(200);
      const context = await f.app.request(
        `/api/sessions/${sessionId}/reference-context`,
        { headers: getHeaders() },
      );
      expect(context.status).toBe(200);
      expect(await context.json()).toEqual({ version: 1, items: [] });
      expect(count(f.db, "run_events")).toBe(eventsBefore);
      expect(count(f.db, "evidence_grants")).toBe(grantsBefore);
    } finally {
      f.close();
    }
  });

  it("updates reference-context via CAS and maps M1 errors without leaks", async () => {
    const f = await makeApp();
    try {
      const { sessionId, referenceId, secret } = await seededRefs(f);
      const path = `/api/sessions/${sessionId}/reference-context`;
      const first = await putContext(f.app, path, {
        version: 1,
        items: [referenceId],
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ version: 2, items: [referenceId] });
      const conflict = await putContext(f.app, path, {
        version: 1,
        items: [],
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: {
          code: "reference_version_conflict",
          message: "reference version conflict",
        },
      });
      const foreign = generateId();
      const invalid = await putContext(f.app, path, {
        version: 2,
        items: [foreign],
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: { code: "invalid_reference", message: "invalid reference" },
      });
      const unknownRef = await f.app.request(
        `/api/sessions/${sessionId}/references/${generateId()}`,
        { headers: getHeaders() },
      );
      expect(unknownRef.status).toBe(404);
      const unknownBody = (await unknownRef.json()) as {
        error: { code: string; message: string };
      };
      expect(unknownBody).toEqual({
        error: { code: "reference_not_found", message: "reference not found" },
      });
      expect(JSON.stringify(unknownBody)).not.toContain(secret);
      const other = f.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      const cross = await f.app.request(
        `/api/sessions/${other}/references/${referenceId}`,
        { headers: getHeaders() },
      );
      expect(cross.status).toBe(404);
      expect(
        ((await cross.json()) as { error: { code: string } }).error.code,
      ).toBe("reference_not_found");
      const unknownSet = await f.app.request(
        `/api/sessions/${sessionId}/reference-sets/${generateId()}`,
        { headers: getHeaders() },
      );
      expect(unknownSet.status).toBe(404);
      expect(
        ((await unknownSet.json()) as { error: { code: string } }).error.code,
      ).toBe("reference_not_found");
    } finally {
      f.close();
    }
  });

  it("rejects bad UUIDs, query keys, and non-strict PUT bodies", async () => {
    const f = await makeApp();
    try {
      const { sessionId, referenceId } = await seededRefs(f);
      const badSession = await f.app.request(
        `/api/sessions/not-a-uuid/references`,
        { headers: getHeaders() },
      );
      expect(badSession.status).toBe(400);
      const badRef = await f.app.request(
        `/api/sessions/${sessionId}/references/nope`,
        { headers: getHeaders() },
      );
      expect(badRef.status).toBe(400);
      for (const target of [
        `/api/sessions/${sessionId}/references?bogus=1`,
        `/api/sessions/${sessionId}/references/${referenceId}?extra=1`,
        `/api/sessions/${sessionId}/reference-context?x=1`,
      ]) {
        const res = await f.app.request(target, { headers: getHeaders() });
        expect(res.status).toBe(400);
      }
      const dupLimited = await f.app.request(
        `/api/sessions/${sessionId}/references?limit=10&limit=10`,
        { headers: getHeaders() },
      );
      expect(dupLimited.status).toBe(400);
      const path = `/api/sessions/${sessionId}/reference-context`;
      for (const body of [
        `[]`,
        `5`,
        `"x"`,
        `null`,
        `{"unknown":1}`,
        `{}`,
        `{"version":2}`,
      ]) {
        const res = await f.app.request(path, {
          method: "PUT",
          headers: postHeaders(),
          body,
        });
        expect(res.status).toBe(400);
      }
      const dupItems = await putContext(f.app, path, {
        version: 1,
        items: [referenceId, referenceId],
      });
      expect(dupItems.status).toBe(400);
      expect(
        ((await dupItems.json()) as { error: { code: string } }).error.code,
      ).toBe("invalid_reference");
      const textType = await f.app.request(path, {
        method: "PUT",
        headers: { ...postHeaders(), "content-type": "text/plain" },
        body: JSON.stringify({ version: 1, items: [] }),
      });
      expect(textType.status).toBe(400);
      const withQuery = await putContext(f.app, `${path}?bogus=1`, {
        version: 1,
        items: [],
      });
      expect(withQuery.status).toBe(400);
    } finally {
      f.close();
    }
  });

  it("exposes no direct POST search/open/refresh/related routes", async () => {
    const f = await makeApp();
    try {
      const { sessionId, referenceId } = await seededRefs(f);
      // No POST route exists for any search/open/refresh/related shape.
      for (const target of [
        `/api/sessions/${sessionId}/references/search`,
        `/api/sessions/${sessionId}/references/${referenceId}/open`,
        `/api/sessions/${sessionId}/references/${referenceId}/refresh`,
        `/api/sessions/${sessionId}/references/${referenceId}/related`,
        `/api/sessions/${sessionId}/references/open`,
        `/api/sessions/${sessionId}/references/refresh`,
        `/api/sessions/${sessionId}/references/related`,
      ]) {
        const post = await postJson(f.app, target, {});
        expect(post.status).toBe(404);
      }
      // Non-UUID verbs under /references collide with :referenceId and fail
      // UUID validation (400); deeper unknown subpaths match nothing (404).
      for (const target of [
        `/api/sessions/${sessionId}/references/search`,
        `/api/sessions/${sessionId}/references/open`,
        `/api/sessions/${sessionId}/references/refresh`,
        `/api/sessions/${sessionId}/references/related`,
      ]) {
        const get = await f.app.request(target, { headers: getHeaders() });
        expect(get.status).toBe(400);
      }
      for (const target of [
        `/api/sessions/${sessionId}/references/${referenceId}/open`,
        `/api/sessions/${sessionId}/references/${referenceId}/refresh`,
        `/api/sessions/${sessionId}/references/${referenceId}/related`,
      ]) {
        const get = await f.app.request(target, { headers: getHeaders() });
        expect(get.status).toBe(404);
      }
    } finally {
      f.close();
    }
  });
});

describe("drain re-check + idempotent replay", () => {
  it("replays stored message responses during drain; fresh/conflict get 503", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const key = randomUUID();
      const headers = { ...postHeaders(), "idempotency-key": key };
      const path = `/api/sessions/${sessionId}/messages`;
      const first = await f.app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hello" }),
      });
      expect(first.status).toBe(202);
      const firstBody = await first.json();
      const turnsBefore = count(f.db, "turns");
      const idemBefore = count(f.db, "api_idempotency");
      f.controls.markDraining();
      // Stored replay wins over 503: exact status and body preserved.
      const replay = await f.app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hello" }),
      });
      expect(replay.status).toBe(first.status);
      expect(await replay.json()).toEqual(firstBody);
      expect(count(f.db, "turns")).toBe(turnsBefore);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
      // Fresh key during drain: 503 with Retry-After, nothing persisted.
      const fresh = await postJson(
        f.app,
        path,
        { text: "late" },
        { "idempotency-key": randomUUID() },
      );
      expect(fresh.status).toBe(503);
      expect(fresh.headers.get("retry-after")).toBe("5");
      expect(
        ((await fresh.json()) as { error: { code: string } }).error.code,
      ).toBe("server_shutting_down");
      expect(count(f.db, "turns")).toBe(turnsBefore);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
      // Same key but different body (request-hash mismatch): there is no
      // stored response for this request, so 503 — never 409 and never a
      // mismatched replay.
      const conflict = await f.app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "different" }),
      });
      expect(conflict.status).toBe(503);
      expect(count(f.db, "turns")).toBe(turnsBefore);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
    } finally {
      f.close();
    }
  });

  it("replays stored retry responses during drain; fresh gets 503", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "question" },
        { key: randomUUID(), now: 1790000000000 },
      ).body;
      f.repo.startRun(posted.run.id, { now: 1790000000001 });
      f.repo.completeRun(
        posted.run.id,
        { version: 1, text: "answer" },
        { now: 1790000000002 },
      );
      const key = randomUUID();
      const path = `/api/sessions/${sessionId}/turns/${posted.turnId}/retries`;
      const headers = { ...postHeaders(), "idempotency-key": key };
      const first = await f.app.request(path, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(first.status).toBe(202);
      const firstBody = await first.json();
      const runsBefore = count(f.db, "runs");
      const idemBefore = count(f.db, "api_idempotency");
      f.controls.markDraining();
      // Stored replay wins over 503: exact status and body preserved, and
      // no second run is queued.
      const replay = await f.app.request(path, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(replay.status).toBe(first.status);
      expect(await replay.json()).toEqual(firstBody);
      expect(count(f.db, "runs")).toBe(runsBefore);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
      // Fresh key during drain: 503, nothing queued or persisted.
      const fresh = await postJson(
        f.app,
        path,
        {},
        { "idempotency-key": randomUUID() },
      );
      expect(fresh.status).toBe(503);
      expect(fresh.headers.get("retry-after")).toBe("5");
      expect(
        ((await fresh.json()) as { error: { code: string } }).error.code,
      ).toBe("server_shutting_down");
      expect(count(f.db, "runs")).toBe(runsBefore);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
    } finally {
      f.close();
    }
  });

  it("rejects a message whose body was still streaming when draining began", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const idemBefore = count(f.db, "api_idempotency");
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const init = {
        method: "POST",
        headers: postHeaders({ "idempotency-key": randomUUID() }),
        body: stream.readable,
        duplex: "half",
      } as unknown as RequestInit;
      const pending = f.app.request(
        `/api/sessions/${sessionId}/messages`,
        init,
      );
      // Drain begins while the handler is parked awaiting the body: the
      // post-validation re-check just before queueing must reject.
      f.controls.markDraining();
      await writer.write(
        new TextEncoder().encode(JSON.stringify({ text: "late" })),
      );
      await writer.close();
      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(count(f.db, "turns")).toBe(0);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
    } finally {
      f.close();
    }
  });

  it("rejects a retry whose body was still streaming when draining began", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "question" },
        { key: randomUUID(), now: 1790000000000 },
      ).body;
      f.repo.startRun(posted.run.id, { now: 1790000000001 });
      f.repo.completeRun(
        posted.run.id,
        { version: 1, text: "answer" },
        { now: 1790000000002 },
      );
      const runsBefore = count(f.db, "runs");
      const idemBefore = count(f.db, "api_idempotency");
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const init = {
        method: "POST",
        headers: postHeaders({ "idempotency-key": randomUUID() }),
        body: stream.readable,
        duplex: "half",
      } as unknown as RequestInit;
      const pending = f.app.request(
        `/api/sessions/${sessionId}/turns/${posted.turnId}/retries`,
        init,
      );
      // Drain begins while the handler is parked awaiting the body: the
      // post-validation re-check just before queueing must reject.
      f.controls.markDraining();
      await writer.write(new TextEncoder().encode("{}"));
      await writer.close();
      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(count(f.db, "runs")).toBe(runsBefore);
      expect(count(f.db, "api_idempotency")).toBe(idemBefore);
    } finally {
      f.close();
    }
  });
});
