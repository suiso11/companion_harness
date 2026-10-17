// AV05 notification runtime: permanent consumer-behavior proof (real temp
// SQLite + real app HTTP, no mocks, no echo/source-text assertions).
//
// Proves over the ACTUAL Hono app + kernel repository + notification
// projector:
// - a new session's FIRST completed shadow job notifies once (question),
//   reads never ack, and the explicit ack lifecycle is strict (same-key
//   replay 200, drift 409, foreign 404, strict `{}` body, strict queries);
// - a paused control still delivers an URGENT `unknown` receipt notice
//   while ordinary chat keeps working (202);
// - >100 notices replay exactly once across HTTP forward pages AND the
//   durable SSE feed (`seq > cursor ASC`, reconnect dedupe by seq);
// - deadline alerts fire exactly once, survive STOP/resume with no
//   expired catchup, drop on task cancel, and a newly created past
//   deadline logs once;
// - production shutdown ends an open feed BEFORE the DB close (no
//   closed-DB error, no read timer leak).

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotBodySchema } from "@companion/contracts";
import {
  calendarEventBodyText,
  canonicalJsonString,
  closeKernelDatabase,
  createActionExecutionService,
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
import { type StartedServer, startServer } from "../src/bootstrap.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  createNotificationService,
  type NotificationService,
  wrapRepoWithNotifications,
} from "../src/notification_service.js";

const T0 = 1_700_001_000_000;

type Handle = ReturnType<typeof openKernelDatabase>;

interface Fixture extends CreatedServerApp {
  close: () => void;
  handle: Handle;
  repo: KernelRepository;
  service: NotificationService;
  sessionId: string;
  otherId: string;
  setNow: (value: number) => void;
}

async function makeFixture(startNow: number): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const base = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true },
  });
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-notify-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger } = createCollectingLogger("debug");
  let nowValue = startNow;
  const now = (): number => nowValue;
  const service = createNotificationService({
    db: handle.raw,
    repo: base,
    logger,
    now,
  });
  const repo = wrapRepoWithNotifications(base, service);
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  service.start();
  const first = repo.createSession({ key: randomUUID(), now: T0 });
  const second = repo.createSession({ key: randomUUID(), now: T0 + 1 });
  return {
    ...created,
    close: () => closeKernelDatabase(handle),
    handle,
    repo,
    service,
    sessionId: first.body.sessionId,
    otherId: second.body.sessionId,
    setNow: (value: number) => {
      nowValue = value;
    },
  };
}

async function settle(service: NotificationService): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!service.busy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!service.busy) return;
    }
    if (Date.now() - start > 8000) {
      throw new Error("notification service did not settle");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}

/** Seed one explicit user goal so the frozen context carries sP labels. */
function seedPurpose(
  repo: KernelRepository,
  sessionId: string,
  scope: string,
  now: number,
): void {
  repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: `goal for ${scope}`,
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now },
  );
}

/** Request + claim + fenced-complete one explicit job with an ask output. */
function completeAskJob(
  repo: KernelRepository,
  sessionId: string,
  scope: string,
  now: number,
): void {
  const requested = repo.requestShadowDeliberation(
    sessionId,
    { scope },
    { key: randomUUID(), now },
  );
  const claimed = repo.claimShadowJob(
    sessionId,
    requested.body.id,
    { owner: "worker-1", expectedVersion: 1 },
    { now: now + 1 },
  );
  const purposes = (claimed.context?.purposes ?? []).map((p) => p.label);
  const done = repo.completeShadowJob(
    sessionId,
    requested.body.id,
    {
      decision: "ask",
      evidenceIds: purposes.length > 0 ? purposes : ["sP1"],
      reason: "needs the owner to confirm",
      proposedAction: null,
      completion: "owner confirms",
      stopConditions: ["owner answers"],
      uncertainty: "medium",
      counterargument: "waiting could stall",
    },
    { expectedVersion: 2, leaseOwner: "worker-1", now: now + 2 },
  );
  expect(done.outcome).toBe("completed");
}

const CALENDAR_EVENT_BODY = calendarEventBodyText({
  canonicalKey: "cal|cal1|evt1",
  status: "confirmed",
  title: "Event",
  start: "2026-01-01T10:00:00Z",
  end: "2026-01-01T11:00:00Z",
  allDayEndExclusive: true,
  sourceRevision: "src@1",
  revisionBasis: "etag",
} as const);

function snapshotBodyJson(): string {
  return canonicalJsonString(
    SnapshotBodySchema.parse({ version: 1, text: CALENDAR_EVENT_BODY }),
  );
}

/* M5 owned-receipt fixture: the EXISTING stager + approval + execution
 * path driven to a real `unknown` terminal (synthetic calendar seed,
 * never real Google). */
async function driveUnknownReceipt(
  repo: KernelRepository,
  handle: Handle,
  sessionId: string,
): Promise<void> {
  const service = createActionExecutionService({
    db: handle.raw,
    referenceManager: createReferenceManager(handle.raw),
  });
  const posted = repo.postMessage(
    sessionId,
    { text: "reschedule please" },
    { key: randomUUID(), now: T0 },
  ).body;
  await repo.startRun(posted.run.id, { now: T0 + 1 });
  const connectorId = generateId();
  const resourceId = generateId();
  const snapshotId = generateId();
  const refId = generateId();
  handle.raw
    .prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'calendar', 'c', '{}', 1)",
    )
    .run(connectorId);
  handle.raw
    .prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|cal1|evt1', 'Event', 2, 1)",
    )
    .run(resourceId, connectorId);
  handle.raw
    .prepare(
      "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 'src@1', 'hash@1', ?, 10, 1, 1)",
    )
    .run(snapshotId, resourceId, snapshotBodyJson());
  handle.raw
    .prepare(
      "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
    )
    .run(refId, sessionId, resourceId, snapshotId);
  handle.raw
    .prepare("UPDATE sessions SET next_reference_ordinal = 2 WHERE id = ?")
    .run(sessionId);
  const staged = repo.actionProposalsStager?.stage(posted.run.id, {
    targetRefId: refId,
    end: "2026-02-01T11:00:00.000Z",
    start: "2026-02-01T10:00:00.000Z",
  });
  if (staged === undefined) {
    throw new Error("staging unavailable");
  }
  repo.completeRun(
    posted.run.id,
    { version: 1, text: "here is the plan" },
    { now: T0 + 2 },
  );
  const events = repo.getEvents(sessionId, posted.run.id, {
    after: 0,
    limit: 50,
  });
  const proposed = events.events.find((e) => e.type === "action.proposed") as
    | { payload: { proposalId: string } }
    | undefined;
  if (proposed === undefined) {
    throw new Error("expected a committed proposal");
  }
  const approved = repo.approveProposal(
    sessionId,
    proposed.payload.proposalId,
    { proposalHash: staged.hash },
    { key: randomUUID(), now: T0 + 3 },
  );
  expect(
    service.startActionRun(approved.body.runId, { now: T0 + 4 }).applied,
  ).toBe(true);
  expect(
    service.consumeActionGrant(approved.body.runId, { now: T0 + 5 }).granted,
  ).toBe(true);
  const finished = service.finishActionExecution(
    approved.body.runId,
    { outcome: "unknown" },
    { now: T0 + 6 },
  );
  expect(finished.applied).toBe(true);
}

describe("notifications runtime (real SQLite + app HTTP)", () => {
  it("projects the first completion; reads stay pure; ack is strict and owned", async () => {
    const fx = await makeFixture(T0);
    try {
      seedPurpose(fx.repo, fx.sessionId, "health", T0 + 5);
      fx.repo.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 6 },
      );
      completeAskJob(fx.repo, fx.sessionId, "health", T0 + 20);
      await settle(fx.service);
      expect(fx.service.getDiagnostic()).toBeNull();

      const listed = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect(listed.status).toBe(200);
      const listBody = listed.body as {
        items: Array<{
          id: string;
          seq: number;
          kind: string;
          outdated: boolean;
        }>;
        latestSeq: number;
        unreadCount: number;
        hasMore: boolean;
        nextBefore: null;
      };
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0]?.kind).toBe("question");
      expect(listBody.items[0]?.seq).toBe(1);
      expect(listBody.items[0]?.outdated).toBe(false);
      expect(listBody.latestSeq).toBe(1);
      expect(listBody.unreadCount).toBe(1);
      expect(listBody.hasMore).toBe(false);
      const noticeId = listBody.items[0]?.id as string;

      // Pure-read detail + history: no ack side effect.
      const history = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/history`,
      );
      expect(history.status).toBe(200);
      expect((history.body as { ack: null }).ack).toBeNull();
      const relist = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((relist.body as { unreadCount: number }).unreadCount).toBe(1);

      // Strict ack: body must be exactly {}.
      const badBody = await post(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/ack`,
        { job: "nope" },
        randomUUID(),
      );
      expect(badBody.status).toBe(400);
      const noKey = await post(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/ack`,
        {},
      );
      expect(noKey.status).toBe(400);

      // Explicit ack records the receipt (201) and reads it back.
      const key = randomUUID();
      const acked = await post(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/ack`,
        {},
        key,
      );
      expect(acked.status).toBe(201);
      expect(
        (acked.body as { status: string; notificationId: string }).status,
      ).toBe("acknowledged");
      const after = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/history`,
      );
      expect((after.body as { ack: { key: string } }).ack.key).toBe(key);
      // Reading the record changed nothing about the ack itself.
      const unread = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((unread.body as { unreadCount: number }).unreadCount).toBe(0);

      // Same-key replay is 200; drift is 409 with the fixed code.
      const replay = await post(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/ack`,
        {},
        key,
      );
      expect(replay.status).toBe(200);
      const drift = await post(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/${noticeId}/ack`,
        {},
        randomUUID(),
      );
      expect(drift.status).toBe(409);
      expect((drift.body as { error: { code: string } }).error.code).toBe(
        "notification_key_conflict",
      );

      // Foreign session: 404 on detail and ack (never 403, never leak).
      const foreignDetail = await get(
        fx.app,
        `/api/sessions/${fx.otherId}/notifications/${noticeId}`,
      );
      expect(foreignDetail.status).toBe(404);
      const foreignAck = await post(
        fx.app,
        `/api/sessions/${fx.otherId}/notifications/${noticeId}/ack`,
        {},
        randomUUID(),
      );
      expect(foreignAck.status).toBe(404);

      // Strict query gate on the feed.
      const badQuery = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications?surprise=1`,
      );
      expect(badQuery.status).toBe(400);
    } finally {
      fx.close();
    }
  });

  it("delivers an URGENT unknown receipt while paused; chat still works", async () => {
    const fx = await makeFixture(T0);
    try {
      // Fresh control is STOP (paused): no unpause anywhere here.
      const control = await get(fx.app, "/api/autonomy/control");
      expect((control.body as { paused: boolean }).paused).toBe(true);
      // A real owned `unknown` receipt projects URGENT while paused.
      // (Driven before any chat: the receipt fixture owns the session's
      // single run slot while it stages + approves + executes.)
      await driveUnknownReceipt(fx.repo, fx.handle, fx.sessionId);
      await settle(fx.service);
      expect(fx.service.getDiagnostic()).toBeNull();
      const listed = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications?limit=100`,
      );
      expect(listed.status).toBe(200);
      const items = (
        listed.body as {
          items: Array<{ priority: string; kind: string; sourceKind: string }>;
        }
      ).items;
      const urgent = items.filter((item) => item.priority === "urgent");
      expect(urgent).toHaveLength(1);
      expect(urgent[0]?.kind).toBe("commitment");
      expect(urgent[0]?.sourceKind).toBe("action_receipt");
      // The projection degraded nothing: ordinary chat still admits
      // while paused, even after the projection ran.
      const chat = await post(
        fx.app,
        `/api/sessions/${fx.sessionId}/messages`,
        { text: "hello while stopped" },
        randomUUID(),
      );
      expect(chat.status).toBe(202);
    } finally {
      fx.close();
    }
  });

  it("replays >100 notices exactly once across forward pages and the SSE feed", async () => {
    const fx = await makeFixture(T0);
    try {
      fx.repo.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 2 },
      );
      // 105 distinct completed shadow jobs (distinct scopes => distinct
      // semantic fingerprints). Ingest consumes them in cursor-advanced
      // 50-row source batches (~5 rows per job lifecycle), and ONE
      // production drain tick re-sweeps while cursors advance — so a
      // single wake converges all 105 exactly once, with no unrelated
      // wake needed in between.
      for (let i = 0; i < 105; i += 1) {
        const scope = `bulk-${i}`;
        seedPurpose(fx.repo, fx.sessionId, scope, T0 + 10 + i);
        completeAskJob(fx.repo, fx.sessionId, scope, T0 + 1000 + i * 10);
      }
      fx.service.wake();
      await settle(fx.service);
      {
        const probe = await get(
          fx.app,
          `/api/sessions/${fx.sessionId}/notifications/forward?after=0&limit=100`,
        );
        expect((probe.body as { latestSeq: number }).latestSeq).toBe(105);
      }
      expect(fx.service.getDiagnostic()).toBeNull();

      // HTTP forward paging: no hidden cap, truthful hasMore/nextAfter.
      const first = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/forward?after=0&limit=100`,
      );
      expect(first.status).toBe(200);
      const firstBody = first.body as {
        items: Array<{ seq: number }>;
        latestSeq: number;
        hasMore: boolean;
        nextAfter: number;
      };
      expect(firstBody.items).toHaveLength(100);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextAfter).toBe(100);
      const second = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/forward?after=100&limit=100`,
      );
      expect(second.status).toBe(200);
      const secondBody = second.body as {
        items: Array<{ seq: number }>;
        hasMore: boolean;
        nextAfter: null;
      };
      expect(secondBody.items).toHaveLength(5);
      expect(secondBody.hasMore).toBe(false);
      expect(secondBody.nextAfter).toBeNull();
      const union = [
        ...firstBody.items.map((item) => item.seq),
        ...secondBody.items.map((item) => item.seq),
      ];
      expect(union).toEqual(Array.from({ length: 105 }, (_, i) => i + 1));

      // History paging agrees from the newest end (no hidden 50 cap).
      const history = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications?limit=100`,
      );
      expect(history.status).toBe(200);
      const historyBody = history.body as {
        items: Array<{ seq: number }>;
        hasMore: boolean;
        nextBefore: number;
      };
      expect(historyBody.items).toHaveLength(100);
      expect(historyBody.hasMore).toBe(true);
      expect(historyBody.nextBefore).toBe(6);
      const tail = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications?limit=100&beforeSeq=6`,
      );
      expect((tail.body as { items: unknown[] }).items).toHaveLength(5);

      // Durable SSE replay from after=0 delivers every seq exactly once
      // (never a latest-100 window filtered client-side).
      const stream = await fx.app.request(
        `/api/sessions/${fx.sessionId}/notifications/feed/stream?after=0`,
        { method: "GET", headers: { host: "127.0.0.1" } },
      );
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      const seen: number[] = [];
      const decoder = new TextDecoder();
      let pending = "";
      const deadline = Date.now() + 8000;
      const active = reader as ReadableStreamDefaultReader<Uint8Array>;
      try {
        while (seen.length < 105 && Date.now() < deadline) {
          const chunk = await active.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let boundary = pending.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const idLine = frame
              .split("\n")
              .find((line) => line.startsWith("id: "));
            const eventLine = frame
              .split("\n")
              .find((line) => line.startsWith("event: "));
            if (idLine !== undefined && eventLine === "event: notification") {
              seen.push(Number(idLine.slice("id: ".length)));
            }
            boundary = pending.indexOf("\n\n");
          }
        }
      } finally {
        await active.cancel();
      }
      expect(seen).toEqual(Array.from({ length: 105 }, (_, i) => i + 1));
    } finally {
      fx.close();
    }
  });

  it("fires deadline alerts exactly once across stop/resume with no expired catchup", async () => {
    const fx = await makeFixture(T0);
    try {
      fx.repo.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: randomUUID(), now: T0 },
      );
      const created = fx.repo.createAutonomyTask(
        fx.sessionId,
        {
          scope: "bills",
          title: "pay the bill",
          kind: "task",
          speaker: "user",
          deadline: new Date(T0 + 60_000).toISOString().replace(".000Z", "Z"),
        },
        { key: randomUUID(), now: T0 + 1 },
      );
      const taskId = (created.body as { id: string }).id;
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
      await settle(fx.service);
      const empty = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((empty.body as { items: unknown[] }).items).toHaveLength(0);

      // Due: exactly one alert; a second drain records nothing new.
      // (Wake AFTER the clock move: the drain reads the service clock.)
      fx.setNow(T0 + 120_000);
      fx.service.wake();
      await settle(fx.service);
      const due = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((due.body as { items: unknown[] }).items).toHaveLength(1);
      await settle(fx.service);
      const still = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((still.body as { latestSeq: number }).latestSeq).toBe(1);

      // STOP holds routines: advancing the clock records nothing new.
      const paused = await get(fx.app, "/api/autonomy/control");
      const version = (paused.body as { version: number }).version;
      fx.repo.setAutonomyControlState(
        { paused: true, expectedVersion: version },
        { key: randomUUID(), now: T0 + 130_000 },
      );
      fx.setNow(T0 + 240_000);
      fx.service.wake();
      await settle(fx.service);
      const held = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((held.body as { latestSeq: number }).latestSeq).toBe(1);

      // Resume does NOT catch up the old past deadline (task untouched
      // since before the resume): still exactly one.
      const resumed = await get(fx.app, "/api/autonomy/control");
      const version2 = (resumed.body as { version: number }).version;
      fx.repo.setAutonomyControlState(
        { paused: false, expectedVersion: version2 },
        { key: randomUUID(), now: T0 + 250_000 },
      );
      fx.setNow(T0 + 300_000);
      fx.service.wake();
      await settle(fx.service);
      const noCatchup = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((noCatchup.body as { latestSeq: number }).latestSeq).toBe(1);

      // A newly created explicit PAST deadline logs once (new state).
      fx.repo.createAutonomyTask(
        fx.sessionId,
        {
          scope: "bills",
          title: "late fee",
          kind: "task",
          speaker: "user",
          deadline: new Date(T0 + 260_000).toISOString().replace(".000Z", "Z"),
        },
        { key: randomUUID(), now: T0 + 310_000 },
      );
      await settle(fx.service);
      const logged = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((logged.body as { latestSeq: number }).latestSeq).toBe(2);

      // Terminal cancel drops only ITS derived schedule row: no new
      // alert, and nothing remains pending (the late fee already alerted
      // exactly once, so the timer query honestly reports null instead of
      // re-arming on the notified due).
      const task = fx.repo.getAutonomyTask(fx.sessionId, taskId);
      fx.repo.cancelAutonomyTask(
        fx.sessionId,
        taskId,
        { expectedVersion: task.version },
        { key: randomUUID(), now: T0 + 320_000 },
      );
      await settle(fx.service);
      const cancelled = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect((cancelled.body as { latestSeq: number }).latestSeq).toBe(2);
      expect(fx.repo.getNextDeadline(fx.sessionId).deadline).toBeNull();
      expect(fx.service.getDiagnostic()).toBeNull();
      expect(fx.service.getDiagnostic()).toBeNull();
    } finally {
      fx.close();
    }
  });

  it("production server over real HTTP Origin ends an open feed before the DB close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-notify-prod-"));
    let started: StartedServer | undefined;
    try {
      const env: NodeJS.ProcessEnv = {
        COMPANION_DB_PATH: join(dir, "db.sqlite"),
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "0",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "error",
      };
      started = await startServer({ env, drainMs: 500 });
      const base = `http://127.0.0.1:${started.port}`;
      expect(started.notifications).not.toBeNull();
      expect(started.notifications?.getDiagnostic()).toBeNull();

      // Smoke over real HTTP with the exact same-origin Origin: create a
      // session, read the empty durable feed + cursor + forward page.
      const created = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: base,
        },
        body: "{}",
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };
      const listed = await fetch(
        `${base}/api/sessions/${sessionId}/notifications`,
      );
      expect(listed.status).toBe(200);
      expect(
        ((await listed.json()) as { items: unknown[] }).items,
      ).toHaveLength(0);
      const cursor = await fetch(
        `${base}/api/sessions/${sessionId}/notifications/feed/cursor`,
      );
      expect(cursor.status).toBe(200);
      const forward = await fetch(
        `${base}/api/sessions/${sessionId}/notifications/forward?after=0&limit=100`,
      );
      expect(forward.status).toBe(200);

      // Open the durable feed, then shut down production: the synchronous
      // drain gate ends the open stream BEFORE the DB close (no
      // closed-DB error, no read-timer leak), and shutdown resolves.
      const stream = await fetch(
        `${base}/api/sessions/${sessionId}/notifications/feed/stream?after=0`,
        { headers: { origin: base } },
      );
      expect(stream.status).toBe(200);
      expect(stream.body).not.toBeNull();
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      const closing = started.shutdown("test");
      const first = await reader.read();
      expect(first.done).toBe(true);
      await closing;
      started = undefined;
      await expect(fetch(`${base}/health/live`)).rejects.toThrow();
    } finally {
      if (started !== undefined) {
        await started.shutdown("test-teardown");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("production reads use the trusted server clock and safe-integer cursors", async () => {
    const fx = await makeFixture(T0);
    try {
      // Untrusted `?now=` overrides are strict 400 on every read path.
      for (const path of [
        `/api/sessions/${fx.sessionId}/notifications?now=${T0}`,
        `/api/sessions/${fx.sessionId}/notifications?limit=10&now=${T0}`,
        `/api/sessions/${fx.sessionId}/notifications/forward?after=0&now=${T0}`,
        `/api/sessions/${fx.sessionId}/notifications/${randomUUID()}/history?now=${T0}`,
      ]) {
        const res = await get(fx.app, path);
        expect(res.status).toBe(400);
      }
      // Unsafe integer cursors are 400 (no SQLite-unsafe magnitudes).
      const unsafe = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications?beforeSeq=9007199254740993`,
      );
      expect(unsafe.status).toBe(400);
      const unsafeForward = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications/forward?after=9007199254740993`,
      );
      expect(unsafeForward.status).toBe(400);
      // Trusted-clock reads still work without any `now` key.
      const ok = await get(
        fx.app,
        `/api/sessions/${fx.sessionId}/notifications`,
      );
      expect(ok.status).toBe(200);
    } finally {
      fx.close();
    }
  });
});
