// T2 (PR20 review PRRC_kwDOUNdW7s79uYSd) synthetic Hono smoke over real SQLite:
// create/stage/approve -> GET idempotency lookup -> drain -> same approval
// replay shows one execution/grant and the same 202. No mocked forwarding:
// the repository + Hono app run against a real in-memory kernel DB.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposalApproveScope, SnapshotBodySchema } from "@companion/contracts";
import {
  calendarEventBodyText,
  canonicalJsonString,
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const OPEN_RANGE = {
  end: "2026-02-01T11:00:00.000Z",
  start: "2026-02-01T10:00:00.000Z",
};

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  raw: Database.Database;
  close: () => void;
}

async function makeApp(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-approve-replay-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "error",
  });
  const repo = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true },
  });
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, actionsEnabled: true });
  return {
    ...created,
    repo,
    raw: handle.raw,
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

async function getJson(
  app: CreatedServerApp["app"],
  path: string,
): Promise<Response> {
  return app.request(path, { headers: { host: "127.0.0.1" } });
}

function count(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
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

async function seedProposal(
  f: Fixture,
): Promise<{ sessionId: string; proposalId: string; hash: string }> {
  const sessionId = f.repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
  const posted = f.repo.postMessage(
    sessionId,
    { text: "reschedule please" },
    { key: randomUUID(), now: T0 },
  ).body;
  await f.repo.startRun(posted.run.id, { now: T0 + 1 });

  const connectorId = generateId();
  const resourceId = generateId();
  const snapshotId = generateId();
  const refId = generateId();
  f.raw
    .prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'calendar', 'c', '{}', 1)",
    )
    .run(connectorId);
  f.raw
    .prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|cal1|evt1', 'Event', 1, 1)",
    )
    .run(resourceId, connectorId);
  f.raw
    .prepare(
      "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 'src@1', 'hash@1', ?, 10, 1, 1)",
    )
    .run(snapshotId, resourceId, snapshotBodyJson());
  f.raw
    .prepare(
      "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
    )
    .run(refId, sessionId, resourceId, snapshotId);

  const staged = f.repo.actionProposalsStager?.stage(posted.run.id, {
    targetRefId: refId,
    ...OPEN_RANGE,
  });
  if (staged === undefined) {
    throw new Error("staging unavailable");
  }
  f.repo.completeRun(
    posted.run.id,
    { version: 1, text: "here is the plan" },
    { now: T0 + 2 },
  );
  const events = f.repo.getEvents(sessionId, posted.run.id, {
    after: 0,
    limit: 50,
  });
  const proposed = events.events.find((e) => e.type === "action.proposed") as
    | { payload: { proposalId: string } }
    | undefined;
  if (proposed === undefined) {
    throw new Error("expected a committed proposal");
  }
  return {
    sessionId,
    proposalId: proposed.payload.proposalId,
    hash: staged.hash,
  };
}

describe("proposal approval idempotency lookup + draining replay (T2)", () => {
  it("same-key hash mismatch is 409 with no extra Turn/Run/Grant/events", async () => {
    const f = await makeApp();
    try {
      const { sessionId, proposalId, hash } = await seedProposal(f);
      const path = `/api/sessions/${sessionId}/proposals/${proposalId}/approve`;
      const key = randomUUID();
      const first = await postJson(
        f.app,
        path,
        { proposalHash: hash },
        { "idempotency-key": key },
      );
      expect(first.status).toBe(202);
      const before = {
        turns: count(f.raw, "turns"),
        runs: count(f.raw, "runs"),
        idem: count(f.raw, "api_idempotency"),
        executions: count(f.raw, "action_executions"),
        grants: count(f.raw, "action_execution_grants"),
        events: count(f.raw, "run_events"),
      };
      const mismatch = await postJson(
        f.app,
        path,
        { proposalHash: "0".repeat(64) },
        { "idempotency-key": key },
      );
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "idempotency key already used",
        },
      });
      expect(count(f.raw, "turns")).toBe(before.turns);
      expect(count(f.raw, "runs")).toBe(before.runs);
      expect(count(f.raw, "api_idempotency")).toBe(before.idem);
      expect(count(f.raw, "action_executions")).toBe(before.executions);
      expect(count(f.raw, "action_execution_grants")).toBe(before.grants);
      expect(count(f.raw, "run_events")).toBe(before.events);
    } finally {
      f.close();
    }
  });

  it("create/stage/approve -> lookup -> drain replay keeps one execution/grant and the same 202; fresh drain approval is 503 without persistence", async () => {
    const f = await makeApp();
    try {
      const { sessionId, proposalId, hash } = await seedProposal(f);
      const path = `/api/sessions/${sessionId}/proposals/${proposalId}/approve`;
      const key = randomUUID();
      const first = await postJson(
        f.app,
        path,
        { proposalHash: hash },
        { "idempotency-key": key },
      );
      expect(first.status).toBe(202);
      const firstBody = await first.json();

      const scope = proposalApproveScope(proposalId);
      const lookup = await getJson(
        f.app,
        `/api/sessions/${sessionId}/idempotency/${key}?scope=${encodeURIComponent(scope)}`,
      );
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toEqual({
        found: true,
        status: 202,
        body: firstBody,
      });

      const before = {
        turns: count(f.raw, "turns"),
        runs: count(f.raw, "runs"),
        idem: count(f.raw, "api_idempotency"),
        executions: count(f.raw, "action_executions"),
        grants: count(f.raw, "action_execution_grants"),
        events: count(f.raw, "run_events"),
      };
      expect(before.executions).toBe(1);
      expect(before.grants).toBe(1);

      f.controls.markDraining();

      const replay = await postJson(
        f.app,
        path,
        { proposalHash: hash },
        { "idempotency-key": key },
      );
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(firstBody);
      expect(count(f.raw, "turns")).toBe(before.turns);
      expect(count(f.raw, "runs")).toBe(before.runs);
      expect(count(f.raw, "api_idempotency")).toBe(before.idem);
      expect(count(f.raw, "action_executions")).toBe(1);
      expect(count(f.raw, "action_execution_grants")).toBe(1);
      expect(count(f.raw, "run_events")).toBe(before.events);

      // Fresh approval during drain: 503 with Retry-After, nothing persisted.
      const freshKey = randomUUID();
      const fresh = await postJson(
        f.app,
        path,
        { proposalHash: hash },
        { "idempotency-key": freshKey },
      );
      expect(fresh.status).toBe(503);
      expect(fresh.headers.get("retry-after")).toBe("5");
      expect(count(f.raw, "api_idempotency")).toBe(before.idem);
      expect(count(f.raw, "action_executions")).toBe(1);
      expect(count(f.raw, "action_execution_grants")).toBe(1);
    } finally {
      f.close();
    }
  });
});
