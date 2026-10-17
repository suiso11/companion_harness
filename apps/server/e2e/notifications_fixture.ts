// AV05 notification per-test fixture server (real production UI/server,
// throwaway file DB, NO model).
//
// Boots the REAL Hono createApp + kernel repository + notification projector
// on a temp file DB (fresh per spawn). Notices are seeded through REAL
// kernel calls (purpose + shadow request/claim/complete, or the real M5
// unknown-receipt path with a synthetic calendar seed — never real Google,
// never a real model). The control channel below is fixture setup only;
// every assertion drives the REAL UI/API (same-origin fetch from the page,
// real Origin + Idempotency-Key headers). Route interception in specs only
// holds/drops REAL responses, never synthesizes bodies.
//
// Control endpoints:
//   POST /notify-test/session {} -> { sessionId } (real repo.createSession)
//   POST /notify-test/ask { sessionId, scope } -> real ask completion
//   POST /notify-test/urgent-unknown { sessionId } -> real unknown receipt
//   POST /notify-test/bulk { sessionId, count, scopePrefix } -> N asks
//   POST /notify-test/settle {} -> waits until the projector is idle
//   POST /notify-test/deadline { sessionId, scope } -> real task deadline notice
//   POST /notify-test/task-complete-latest { sessionId } -> real task terminal

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { loadUiAssets } from "../src/bootstrap.js";
import { loadServerConfig } from "../src/config.js";
import { createStdServerLogger } from "../src/logger.js";
import {
  createNotificationService,
  wrapRepoWithNotifications,
} from "../src/notification_service.js";

const T0 = 1_700_001_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

const dir = mkdtempSync(join(tmpdir(), "companion-notify-e2e-"));
const dbPath = join(dir, "companion.sqlite");

const config = loadServerConfig({
  COMPANION_DB_PATH: dbPath,
  COMPANION_HOST: "127.0.0.1",
  COMPANION_PORT: "0",
  COMPANION_TIME_ZONE: "UTC",
  COMPANION_LOG_LEVEL: "error",
});
const logger = createStdServerLogger("error");

const handle = openKernelDatabase(dbPath);
await migrateKernelDatabase({ db: handle.raw });
const base = createKernelRepository(handle.raw, {
  actionProposals: { writeEnabled: true },
});
const service = createNotificationService({
  db: handle.raw,
  repo: base,
  logger,
});
const repo = wrapRepoWithNotifications(base, service);
const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
service.start();

const { app } = createApp({
  config,
  repo,
  engine,
  logger,
  assets: loadUiAssets(),
});

async function settle(): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!service.busy) {
      await new Promise((r) => setTimeout(r, 20));
      if (!service.busy) return;
    }
    if (Date.now() - start > 15_000)
      throw new Error("projector did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function ensureControlUnpaused(): void {
  try {
    const control = repo.getAutonomyControlState();
    if (!control.paused) return;
    try {
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: control.version },
        { key: randomUUID(), now: Date.now() },
      );
    } catch {
      // Best effort: a version race just means someone else resumed.
    }
  } catch {
    // Best effort: first control read may fail before init.
  }
}

function completeAskJob(sessionId: string, scope: string): void {
  const at = Date.now();
  try {
    repo.createAutonomyPurpose(
      sessionId,
      {
        scope,
        statement: `goal for ${scope}`,
        kind: "goal",
        explicit: true,
        sourceKind: "user",
      },
      { key: randomUUID(), now: at },
    );
  } catch {
    // Duplicate scope is fine: the question source is the shadow job.
  }
  ensureControlUnpaused();
  const requested = repo.requestShadowDeliberation(
    sessionId,
    { scope },
    { key: randomUUID(), now: at + 1 },
  );
  const claimed = repo.claimShadowJob(
    sessionId,
    requested.body.id,
    { owner: "worker-1", expectedVersion: 1 },
    { now: at + 2 },
  );
  const purposes = (claimed.context?.purposes ?? []).map((p) => p.label);
  repo.completeShadowJob(
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
    { expectedVersion: 2, leaseOwner: "worker-1", now: at + 3 },
  );
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

async function driveUnknownReceipt(sessionId: string): Promise<void> {
  const actionService = createActionExecutionService({
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
    .run(
      snapshotId,
      resourceId,
      canonicalJsonString(
        SnapshotBodySchema.parse({ version: 1, text: CALENDAR_EVENT_BODY }),
      ),
    );
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
  if (staged === undefined) throw new Error("staging unavailable");
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
  if (proposed === undefined) throw new Error("expected a committed proposal");
  const approved = repo.approveProposal(
    sessionId,
    proposed.payload.proposalId,
    { proposalHash: staged.hash },
    { key: randomUUID(), now: T0 + 3 },
  );
  actionService.startActionRun(approved.body.runId, { now: T0 + 4 });
  actionService.consumeActionGrant(approved.body.runId, { now: T0 + 5 });
  actionService.finishActionExecution(
    approved.body.runId,
    { outcome: "unknown" },
    { now: T0 + 6 },
  );
}

const appServer = serve(
  { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
  (info) => {
    // eslint-disable-next-line no-console
    console.log(`notify-fixture-ready http://127.0.0.1:${info.port}`);
  },
);

const control = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => {});
    req.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "POST" && url.pathname === "/notify-test/session") {
        const created = repo.createSession({
          key: randomUUID(),
          now: Date.now(),
        });
        await settle();
        json(200, { sessionId: created.body.sessionId });
        return;
      }
      if (req.method === "POST" && url.pathname === "/notify-test/ask") {
        const body = (raw === "" ? {} : JSON.parse(raw)) as {
          sessionId?: unknown;
          scope?: unknown;
        };
        if (typeof body.sessionId !== "string") throw new Error("bad session");
        const scope =
          typeof body.scope === "string" && body.scope.length > 0
            ? body.scope
            : "health";
        completeAskJob(body.sessionId, scope);
        await settle();
        json(200, { ok: true });
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname === "/notify-test/urgent-unknown"
      ) {
        const body = (raw === "" ? {} : JSON.parse(raw)) as {
          sessionId?: unknown;
        };
        if (typeof body.sessionId !== "string") throw new Error("bad session");
        await driveUnknownReceipt(body.sessionId);
        await settle();
        json(200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/notify-test/bulk") {
        const body = (raw === "" ? {} : JSON.parse(raw)) as {
          sessionId?: unknown;
          count?: unknown;
          scopePrefix?: unknown;
        };
        if (typeof body.sessionId !== "string") throw new Error("bad session");
        const count =
          typeof body.count === "number" &&
          Number.isSafeInteger(body.count) &&
          body.count > 0 &&
          body.count <= 120
            ? body.count
            : 60;
        const prefix =
          typeof body.scopePrefix === "string" && body.scopePrefix.length > 0
            ? body.scopePrefix
            : "bulk";
        for (let i = 0; i < count; i += 1) {
          completeAskJob(body.sessionId, `${prefix}-${i}`);
        }
        await settle();
        json(200, { ok: true, count });
        return;
      }
      if (req.method === "POST" && url.pathname === "/notify-test/settle") {
        await settle();
        json(200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/notify-test/deadline") {
        const body = (raw === "" ? {} : JSON.parse(raw)) as {
          sessionId?: unknown;
          scope?: unknown;
        };
        if (typeof body.sessionId !== "string") throw new Error("bad session");
        const scope =
          typeof body.scope === "string" && body.scope.length > 0
            ? body.scope
            : "bills";
        ensureControlUnpaused();
        repo.createAutonomyTask(
          body.sessionId,
          {
            scope,
            title: `pay ${scope}`,
            kind: "task",
            speaker: "user",
            deadline: new Date(Date.now() + 1500).toISOString(),
          },
          { key: randomUUID(), now: Date.now() },
        );
        // Let the single deadline timer fire, then converge the drain.
        await new Promise((r) => setTimeout(r, 4000));
        await settle();
        json(200, { ok: true });
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname === "/notify-test/task-complete-latest"
      ) {
        const body = (raw === "" ? {} : JSON.parse(raw)) as {
          sessionId?: unknown;
        };
        if (typeof body.sessionId !== "string") throw new Error("bad session");
        const listed = repo.listAutonomyTasks(body.sessionId, {}) as {
          items: Array<{ id: string; status: string; version: number }>;
        };
        const open = listed.items.find(
          (t) => t.status !== "completed" && t.status !== "cancelled",
        );
        if (open === undefined) throw new Error("no open task");
        repo.completeAutonomyTask(
          body.sessionId,
          open.id,
          { expectedVersion: open.version },
          { key: randomUUID(), now: Date.now() },
        );
        await settle();
        json(200, { ok: true, taskId: open.id });
        return;
      }
      json(404, { error: "unknown" });
    } catch (error) {
      json(500, {
        error: error instanceof Error ? error.message : "fixture failed",
      });
    }
  },
);

control.listen(0, "127.0.0.1", () => {
  const address = control.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  // eslint-disable-next-line no-console
  console.log(`notify-fixture-control http://127.0.0.1:${port}`);
});

async function shutdown(): Promise<void> {
  try {
    await service.stop();
  } catch {
    // Best effort.
  }
  try {
    appServer.close();
  } catch {
    // Best effort.
  }
  try {
    control.close();
  } catch {
    // Best effort.
  }
  try {
    closeKernelDatabase(handle);
  } catch {
    // Best effort.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
