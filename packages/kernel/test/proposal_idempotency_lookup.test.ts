// T2 (PR20 review PRRC_kwDOUNdW7s79uYSd): proposal:approve idempotency lookup.
// The contracts scope `proposal:<uuid>:approve` is accepted, so the owned
// session lookup must return the stored approval instead of 404, and a
// foreign/missing proposal must 404 before any lookup. Same-key hash
// mismatch is a 409 with no extra Turn/Run/Grant/events.
import { randomUUID } from "node:crypto";
import { proposalApproveScope, SnapshotBodySchema } from "@companion/contracts";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { calendarEventBodyText } from "../src/calendar_tools.js";
import { canonicalJsonString, generateId } from "../src/canonical.js";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
} from "../src/errors.js";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const OPEN_RANGE = {
  end: "2026-02-01T11:00:00.000Z",
  start: "2026-02-01T10:00:00.000Z",
};

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

function count(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

async function seedApproved(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: ReturnType<typeof createKernelRepository>;
  sessionId: string;
  proposalId: string;
  hash: string;
  key: string;
  body: unknown;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true },
  });
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
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
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|cal1|evt1', 'Event', 1, 1)",
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

  const staged = repo.actionProposalsStager?.stage(posted.run.id, {
    targetRefId: refId,
    ...OPEN_RANGE,
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
  const key = randomUUID();
  const approved = repo.approveProposal(
    sessionId,
    proposed.payload.proposalId,
    { proposalHash: staged.hash },
    { key, now: T0 + 3 },
  );
  expect(approved.replayed).toBe(false);
  expect(approved.status).toBe(202);
  return {
    handle,
    repo,
    sessionId,
    proposalId: proposed.payload.proposalId,
    hash: staged.hash,
    key,
    body: approved.body,
  };
}

describe("proposal approve idempotency lookup (T2)", () => {
  it("returns the stored approval for the owning session", async () => {
    const f = await seedApproved();
    try {
      const scope = proposalApproveScope(f.proposalId);
      const found = f.repo.lookupIdempotencyForSession(
        f.sessionId,
        f.key,
        scope,
      );
      expect(found).toEqual({ found: true, status: 202, body: f.body });
      const missing = f.repo.lookupIdempotencyForSession(
        f.sessionId,
        randomUUID(),
        scope,
      );
      expect(missing).toEqual({ found: false, code: "resend_required" });
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("404s a foreign session or a missing proposal before lookup", async () => {
    const f = await seedApproved();
    try {
      const scope = proposalApproveScope(f.proposalId);
      const other = f.repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      expect(() =>
        f.repo.lookupIdempotencyForSession(other, f.key, scope),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        f.repo.lookupIdempotencyForSession(
          f.sessionId,
          f.key,
          proposalApproveScope(randomUUID()),
        ),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("conflicts on same-key hash mismatch with no extra Turn/Run/Grant/events", async () => {
    const f = await seedApproved();
    try {
      const before = {
        turns: count(f.handle.raw, "turns"),
        runs: count(f.handle.raw, "runs"),
        idem: count(f.handle.raw, "api_idempotency"),
        executions: count(f.handle.raw, "action_executions"),
        grants: count(f.handle.raw, "action_execution_grants"),
        events: count(f.handle.raw, "run_events"),
      };
      expect(() =>
        f.repo.approveProposal(
          f.sessionId,
          f.proposalId,
          { proposalHash: "0".repeat(64) },
          { key: f.key, now: T0 + 4 },
        ),
      ).toThrow(IdempotencyConflictError);
      expect(count(f.handle.raw, "turns")).toBe(before.turns);
      expect(count(f.handle.raw, "runs")).toBe(before.runs);
      expect(count(f.handle.raw, "api_idempotency")).toBe(before.idem);
      expect(count(f.handle.raw, "action_executions")).toBe(before.executions);
      expect(count(f.handle.raw, "action_execution_grants")).toBe(
        before.grants,
      );
      expect(count(f.handle.raw, "run_events")).toBe(before.events);
    } finally {
      closeKernelDatabase(f.handle);
    }
  });
});
