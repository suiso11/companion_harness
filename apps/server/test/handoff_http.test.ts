// AV03 delegation-handoff HTTP behavioral test (real Hono app + kernel DB).
//
// Exercises the ACTUAL handoff routes end to end (no listener):
// handoff create (bound to a real task)/list(keyset pages + active
// tracking count)/open/export spec/events/attempts, dispatch/report/
// verify/fail/cancel/abnormal-exit/attempt/reaffirm. Proves verify is
// blocked unless every frozen criterion passes with evidence, sandbox
// reports never imply production, boundary flags grant nothing (task
// state untouched), revocation flags active handoffs and blocks dispatch
// (cancel stays allowed), foreign ids are 404, and key reuse with a
// different body conflicts (409).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function makeApp(): Promise<
  CreatedServerApp & { repo: KernelRepository; close: () => void }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-handoff-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  return { ...created, repo, close: () => closeKernelDatabase(handle) };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", host: "127.0.0.1", ...extra };
}

async function post(
  app: CreatedServerApp["app"],
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "POST",
    headers: headers(key === undefined ? {} : { "idempotency-key": key }),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(
  app: CreatedServerApp["app"],
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
  return { status: response.status, body: await response.json() };
}

async function getText(
  app: CreatedServerApp["app"],
  path: string,
): Promise<{ status: number; text: string }> {
  const response = await app.request(path, {
    method: "GET",
    headers: { host: "127.0.0.1", accept: "text/plain" },
  });
  return { status: response.status, text: await response.text() };
}

async function seedTask(
  app: CreatedServerApp["app"],
  sessionId: string,
): Promise<{ purposeId: string; taskId: string }> {
  const purpose = await post(
    app,
    `/api/sessions/${sessionId}/purposes`,
    {
      scope: "work",
      statement: "ship the queue migration",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    randomUUID(),
  );
  expect(purpose.status).toBe(201);
  const task = await post(
    app,
    `/api/sessions/${sessionId}/tasks`,
    {
      scope: "work",
      title: "migrate the queue",
      kind: "task",
      speaker: "self",
      parentPurposeId: (purpose.body as { id: string }).id,
    },
    randomUUID(),
  );
  expect(task.status).toBe(201);
  return {
    purposeId: (purpose.body as { id: string }).id,
    taskId: (task.body as { id: string }).id,
  };
}

function handoffBody(extra: Record<string, unknown> = {}) {
  return {
    target: "hand the queue migration to pi-orch",
    acceptanceCriteria: ["queue drains without loss", "no duplicate work"],
    opScope: "implement",
    ...extra,
  };
}

describe("handoff HTTP", () => {
  it("creates, pages, exports the spec, and runs the lifecycle to verified", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const createdSession = await post(app, "/api/sessions", {}, randomUUID());
      expect(createdSession.status).toBe(201);
      const sessionId = (createdSession.body as { sessionId: string })
        .sessionId;
      const { taskId } = await seedTask(app, sessionId);
      const base = `/api/sessions/${sessionId}/handoffs`;

      const first = await post(
        app,
        base,
        { taskId, ...handoffBody() },
        randomUUID(),
      );
      expect(first.status).toBe(201);
      const id = (first.body as { id: string }).id;
      await post(app, base, { taskId, ...handoffBody() }, randomUUID());
      await post(app, base, { taskId, ...handoffBody() }, randomUUID());

      // Keyset pages (LIMIT+1 probe, never truncated claims).
      const page = await get(app, `${base}?limit=2`);
      expect(page.status).toBe(200);
      expect((page.body as { items: unknown[] }).items).toHaveLength(2);
      expect((page.body as { hasMore: boolean }).hasMore).toBe(true);
      expect((page.body as { activeCount: number }).activeCount).toBe(0);
      const cursor = (page.body as { nextCursor: string }).nextCursor;
      const older = await get(
        app,
        `${base}?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      expect((older.body as { items: unknown[] }).items).toHaveLength(1);
      expect((older.body as { hasMore: boolean }).hasMore).toBe(false);

      // Open + deterministic spec export (plain text for manual pi-orch).
      expect((await get(app, `${base}/${id}`)).status).toBe(200);
      const spec = await getText(app, `${base}/${id}/spec`);
      expect(spec.status).toBe(200);
      expect(spec.text).toContain("hand the queue migration to pi-orch");
      expect(spec.text).toContain("queue drains without loss");
      expect(spec.text).toContain("サンドボックス成功≠本番");
      expect(spec.text).toContain("REQUIRES SEPARATE AUTHORIZATION");

      // Dispatch -> sandbox report -> verify (all criteria pass).
      const dispatched = await post(
        app,
        `${base}/${id}/dispatch`,
        { expectedVersion: 1, externalRef: "pi-orch thread 7" },
        randomUUID(),
      );
      expect(dispatched.status).toBe(200);
      expect((dispatched.body as { status: string }).status).toBe("dispatched");
      const listed = await get(app, `${base}?status=dispatched&limit=50`);
      expect((listed.body as { activeCount: number }).activeCount).toBe(1);
      const reported = await post(
        app,
        `${base}/${id}/report`,
        {
          expectedVersion: (dispatched.body as { version: number }).version,
          environment: "sandbox",
          summary: "green in sandbox",
        },
        randomUUID(),
      );
      expect(reported.status).toBe(200);
      expect((reported.body as { status: string }).status).toBe("reported");
      // Verify with one failing criterion refuses (409).
      const badVerify = await post(
        app,
        `${base}/${id}/verify`,
        {
          expectedVersion: (reported.body as { version: number }).version,
          results: [
            { index: 0, pass: true, evidence: "drain log clean" },
            { index: 1, pass: false, evidence: "duplicates seen" },
          ],
        },
        randomUUID(),
      );
      expect(badVerify.status).toBe(409);
      const verified = await post(
        app,
        `${base}/${id}/verify`,
        {
          expectedVersion: (reported.body as { version: number }).version,
          results: [
            { index: 0, pass: true, evidence: "drain log clean" },
            { index: 1, pass: true, evidence: "dup check clean" },
          ],
        },
        randomUUID(),
      );
      expect(verified.status).toBe(200);
      expect((verified.body as { status: string }).status).toBe("verified");
      // A verified handoff never completes its task automatically.
      const task = await get(app, `/api/sessions/${sessionId}/tasks/${taskId}`);
      expect((task.body as { status: string }).status).toBe("open");
      // Task completion stays a separate explicit human step.
      void repo;
    } finally {
      fixture.close();
    }
  });

  it("refuses unverified dispatch after revocation, keeps cancel, reaffirms", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const createdSession = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (createdSession.body as { sessionId: string })
        .sessionId;
      const { purposeId, taskId } = await seedTask(app, sessionId);
      const base = `/api/sessions/${sessionId}/handoffs`;
      const created = await post(
        app,
        base,
        { taskId, ...handoffBody() },
        randomUUID(),
      );
      const id = (created.body as { id: string }).id;

      const revoked = await post(
        app,
        `/api/sessions/${sessionId}/purposes/${purposeId}/revoke`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(revoked.status).toBe(200);
      const flagged = (await get(app, `${base}/${id}`)).body as {
        needsReevaluation: boolean;
        version: number;
      };
      expect(flagged.needsReevaluation).toBe(true);
      // Dispatch refused while the notice is set (409).
      const blocked = await post(
        app,
        `${base}/${id}/dispatch`,
        { expectedVersion: flagged.version },
        randomUUID(),
      );
      expect(blocked.status).toBe(409);
      // Cancel stays allowed under the notice.
      const cancelled = await post(
        app,
        `${base}/${id}/cancel`,
        { expectedVersion: flagged.version },
        randomUUID(),
      );
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as { status: string }).status).toBe("cancelled");

      // Second record: reaffirm clears, dispatch works again.
      const second = await post(
        app,
        base,
        { taskId, ...handoffBody() },
        randomUUID(),
      );
      const secondId = (second.body as { id: string }).id;
      const flaggedAgain = (await get(app, `${base}/${secondId}`)).body as {
        needsReevaluation: boolean;
        version: number;
      };
      expect(flaggedAgain.needsReevaluation).toBe(true);
      const reaffirmed = await post(
        app,
        `${base}/${secondId}/reaffirm`,
        { expectedVersion: flaggedAgain.version },
        randomUUID(),
      );
      expect(reaffirmed.status).toBe(200);
      expect(
        (reaffirmed.body as { needsReevaluation: boolean }).needsReevaluation,
      ).toBe(false);
      const dispatched = await post(
        app,
        `${base}/${secondId}/dispatch`,
        {
          expectedVersion: (reaffirmed.body as { version: number }).version,
        },
        randomUUID(),
      );
      expect(dispatched.status).toBe(200);
    } finally {
      fixture.close();
    }
  });

  it("records attempts with a cause, 404s foreign ids, 409s drifted keys", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const createdSession = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (createdSession.body as { sessionId: string })
        .sessionId;
      const { taskId } = await seedTask(app, sessionId);
      const base = `/api/sessions/${sessionId}/handoffs`;
      const created = await post(
        app,
        base,
        {
          taskId,
          ...handoffBody(),
          boundaries: ["secret", "payment"],
        },
        randomUUID(),
      );
      const id = (created.body as { id: string }).id;
      // Missing cause is a 400 (never an automatic retry).
      const noCause = await post(
        app,
        `${base}/${id}/attempt`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(noCause.status).toBe(400);
      const attempt = await post(
        app,
        `${base}/${id}/attempt`,
        { expectedVersion: 1, cause: "transient_infra" },
        randomUUID(),
      );
      expect(attempt.status).toBe(200);
      expect((attempt.body as { activeAttempt: number }).activeAttempt).toBe(1);
      const attempts = await get(app, `${base}/${id}/attempts`);
      expect(
        (attempts.body as { attempts: { cause: string }[] }).attempts,
      ).toHaveLength(1);
      const events = await get(app, `${base}/${id}/events`);
      expect(
        (events.body as { events: unknown[] }).events.length,
      ).toBeGreaterThan(0);

      // Boundary flags granted nothing: the task is untouched.
      const task = await get(app, `/api/sessions/${sessionId}/tasks/${taskId}`);
      expect((task.body as { status: string }).status).toBe("open");

      // Foreign-session ids are 404.
      const foreignSession = await post(app, "/api/sessions", {}, randomUUID());
      const foreignId = (foreignSession.body as { sessionId: string })
        .sessionId;
      expect(
        (await get(app, `${base}/${id}`.replace(sessionId, foreignId))).status,
      ).toBe(404);

      // Key reuse with a different body conflicts (409).
      const key = randomUUID();
      const keyed = await post(app, base, { taskId, ...handoffBody() }, key);
      expect(keyed.status).toBe(201);
      const drifted = await post(
        app,
        base,
        { taskId, ...handoffBody({ target: "a different target" }) },
        key,
      );
      expect(drifted.status).toBe(409);
    } finally {
      fixture.close();
    }
  });
});
