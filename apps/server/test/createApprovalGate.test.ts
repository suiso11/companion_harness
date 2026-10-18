// r4295943304: per-tool HTTP approval gate (server-side regression).
//
// The approve route resolves the OWNED proposal FIRST (bounded read, no
// mutation) and then admits ONLY that proposal tool's own surface BEFORE
// any repository mutation/grant/queue:
//   - `calendar.create` rows require `createEnabled`,
//   - `calendar.reschedule` rows require `actionsEnabled`,
//   - anything else (or a disabled tool) is refused with fixed 409
//     `action_execution_disabled` carrying no ids or content,
//   - foreign/unknown proposals stay 404, and the keyed idempotent 202
//     replay still works through the gate.
//
// A pending create staged before a restart is therefore refused after
// `createEnabled` is turned off even while reschedule stays enabled, and
// vice versa. In-memory DB + direct `createApp` (no listen, no transport).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotBodySchema } from "@companion/contracts";
import {
  calendarEventBodyText,
  canonicalJsonString,
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
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
const CREATE_INPUT = {
  title: "Gate review",
  start: "2026-03-01T10:00:00Z",
  end: "2026-03-01T11:00:00Z",
};
const RESCHEDULE_RANGE = {
  end: "2026-02-01T11:00:00.000Z",
  start: "2026-02-01T10:00:00.000Z",
};

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  raw: Database.Database;
  connectorId: string;
  close: () => void;
}

async function makeApp(
  actionsEnabled: boolean,
  createEnabled: boolean,
): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-approval-gate-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "error",
  });
  const repo = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true, createEnabled: true },
  });
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({
    config,
    repo,
    engine,
    actionsEnabled,
    createEnabled,
  });
  const connectorId = createReferenceManager(
    handle.raw,
  ).ensureCalendarConnectorInstance("calendar-fake-binding", "primary", {
    now: T0,
  }).id;
  return {
    ...created,
    repo,
    raw: handle.raw,
    connectorId,
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

async function approve(
  f: Fixture,
  sessionId: string,
  proposalId: string,
  hash: string,
  key: string,
): Promise<{ status: number; body: string }> {
  const response = await postJson(
    f.app,
    `/api/sessions/${sessionId}/proposals/${proposalId}/approve`,
    { proposalHash: hash },
    { "idempotency-key": key },
  );
  return { status: response.status, body: await response.text() };
}

/** Stage a real pending `calendar.create` proposal via the public repo. */
async function seedCreate(
  f: Fixture,
  now: number,
): Promise<{ sessionId: string; proposalId: string; hash: string }> {
  const sessionId = f.repo.createSession({ key: randomUUID(), now }).body
    .sessionId;
  const posted = f.repo.postMessage(
    sessionId,
    { text: "create please" },
    { key: randomUUID(), now },
  ).body;
  await f.repo.startRun(posted.run.id, { now: now + 1 });
  const staged = f.repo.actionProposalsStager?.stageCreate(
    posted.run.id,
    CREATE_INPUT,
    { connectorInstanceId: f.connectorId },
  );
  if (staged === undefined) {
    throw new Error("create staging unavailable");
  }
  f.repo.completeRun(
    posted.run.id,
    { version: 1, text: "here is the create plan" },
    { now: now + 2 },
  );
  const events = f.repo.getEvents(sessionId, posted.run.id, {
    after: 0,
    limit: 50,
  });
  const proposed = events.events.find((e) => e.type === "action.proposed") as
    | { payload: { proposalId: string } }
    | undefined;
  if (proposed === undefined) {
    throw new Error("expected a committed create proposal");
  }
  return {
    sessionId,
    proposalId: proposed.payload.proposalId,
    hash: staged.hash,
  };
}

/** Stage a real pending `calendar.reschedule` proposal via the public repo. */
async function seedReschedule(
  f: Fixture,
  now: number,
): Promise<{ sessionId: string; proposalId: string; hash: string }> {
  const sessionId = f.repo.createSession({ key: randomUUID(), now }).body
    .sessionId;
  const posted = f.repo.postMessage(
    sessionId,
    { text: "reschedule please" },
    { key: randomUUID(), now },
  ).body;
  await f.repo.startRun(posted.run.id, { now: now + 1 });

  const bodyText = calendarEventBodyText({
    canonicalKey: "cal|primary|evt1",
    status: "confirmed",
    title: "Event",
    start: "2026-01-01T10:00:00Z",
    end: "2026-01-01T11:00:00Z",
    allDayEndExclusive: true,
    sourceRevision: "src@1",
    revisionBasis: "etag",
  } as const);
  const snapshotBody = canonicalJsonString(
    SnapshotBodySchema.parse({ version: 1, text: bodyText }),
  );
  const resourceId = generateId();
  const snapshotId = generateId();
  const refId = generateId();
  f.raw
    .prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|primary|evt1', 'Event', 1, 1)",
    )
    .run(resourceId, f.connectorId);
  f.raw
    .prepare(
      "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 'src@1', 'hash@1', ?, 10, 1, 1)",
    )
    .run(snapshotId, resourceId, snapshotBody);
  f.raw
    .prepare(
      "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
    )
    .run(refId, sessionId, resourceId, snapshotId);

  const staged = f.repo.actionProposalsStager?.stage(posted.run.id, {
    targetRefId: refId,
    ...RESCHEDULE_RANGE,
  });
  if (staged === undefined) {
    throw new Error("reschedule staging unavailable");
  }
  f.repo.completeRun(
    posted.run.id,
    { version: 1, text: "here is the plan" },
    { now: now + 2 },
  );
  const events = f.repo.getEvents(sessionId, posted.run.id, {
    after: 0,
    limit: 50,
  });
  const proposed = events.events.find((e) => e.type === "action.proposed") as
    | { payload: { proposalId: string } }
    | undefined;
  if (proposed === undefined) {
    throw new Error("expected a committed reschedule proposal");
  }
  return {
    sessionId,
    proposalId: proposed.payload.proposalId,
    hash: staged.hash,
  };
}

describe("per-tool approval gate (r4295943304)", () => {
  it("create-only gate: create approves with idempotent replay, reschedule 409s with no ids, unknown stays 404", async () => {
    const f = await makeApp(false, true);
    try {
      const create = await seedCreate(f, T0);
      const reschedule = await seedReschedule(f, T0 + 100);

      // The enabled tool approves and the keyed replay is verbatim.
      const key = randomUUID();
      const first = await approve(
        f,
        create.sessionId,
        create.proposalId,
        create.hash,
        key,
      );
      expect(first.status).toBe(202);
      const replay = await approve(
        f,
        create.sessionId,
        create.proposalId,
        create.hash,
        key,
      );
      expect(replay.status).toBe(202);
      expect(replay.body).toBe(first.body);

      // The disabled tool is refused BEFORE any mutation: fixed 409, no ids.
      const refused = await approve(
        f,
        reschedule.sessionId,
        reschedule.proposalId,
        reschedule.hash,
        randomUUID(),
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toContain("action_execution_disabled");
      expect(refused.body).not.toContain(reschedule.proposalId);
      expect(refused.body).not.toContain(reschedule.hash);
      // Refused before mutation: the proposal is still pending, no run queued.
      const listed = f.repo.listProposals(reschedule.sessionId);
      expect(
        listed.proposals.find((p) => p.proposalId === reschedule.proposalId)
          ?.status,
      ).toBe("pending");
      expect(
        f.repo
          .getHistory(reschedule.sessionId, { limit: 10 })
          .items.some((item) => item.kind === "action_approval"),
      ).toBe(false);

      // Foreign/unknown proposals stay 404 (ownership preserved).
      const unknown = await approve(
        f,
        create.sessionId,
        randomUUID(),
        "a".repeat(64),
        randomUUID(),
      );
      expect(unknown.status).toBe(404);
    } finally {
      f.close();
    }
  });

  it("reschedule-only gate: reschedule approves, create 409s with no ids", async () => {
    const f = await makeApp(true, false);
    try {
      const create = await seedCreate(f, T0);
      const reschedule = await seedReschedule(f, T0 + 100);

      const ok = await approve(
        f,
        reschedule.sessionId,
        reschedule.proposalId,
        reschedule.hash,
        randomUUID(),
      );
      expect(ok.status).toBe(202);

      const refused = await approve(
        f,
        create.sessionId,
        create.proposalId,
        create.hash,
        randomUUID(),
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toContain("action_execution_disabled");
      expect(refused.body).not.toContain(create.proposalId);
      expect(refused.body).not.toContain(create.hash);
      const listed = f.repo.listProposals(create.sessionId);
      expect(
        listed.proposals.find((p) => p.proposalId === create.proposalId)
          ?.status,
      ).toBe("pending");
    } finally {
      f.close();
    }
  });

  it("both gates off: both tools 409 with zero mutation", async () => {
    const f = await makeApp(false, false);
    try {
      const create = await seedCreate(f, T0);
      const reschedule = await seedReschedule(f, T0 + 100);

      for (const seeded of [create, reschedule]) {
        const refused = await approve(
          f,
          seeded.sessionId,
          seeded.proposalId,
          seeded.hash,
          randomUUID(),
        );
        expect(refused.status).toBe(409);
        expect(refused.body).toContain("action_execution_disabled");
      }
      expect(f.repo.listProposals(create.sessionId).proposals[0]?.status).toBe(
        "pending",
      );
      expect(
        f.repo.listProposals(reschedule.sessionId).proposals[0]?.status,
      ).toBe("pending");
    } finally {
      f.close();
    }
  });
});
