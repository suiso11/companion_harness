// C18 focused proposal decision tests (§18.4, service-first slice):
//
// Wired repository + headline Hono routes over a real (unstarted) engine.
// Approve is keyed and idempotent (exactly one 202 stored response, one
// action_approval Turn + queued Action Run + execution + grant); reject is
// keyless and state-idempotent with no Run at all; hash mismatch and
// foreign-session ownership are fixed 409/404; decisions project into
// session history as `action_approval` / `action_rejection` items.
//
// NOTE: verification runs are queued for the NOT-YET-REGISTERED m5-action
// strategy — pickup selects registered strategies only, so no external
// call can happen anywhere in this slice.

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
  /** The real raw better-sqlite3 connection (needs prepare/close). */
  raw: Database.Database;
  close: () => void;
}

async function makeApp(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-proposals-")),
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

/** The exact stored `body_json` shape ReferenceManager writes (SnapshotBody wrapper). */
function snapshotBodyJson(): string {
  return canonicalJsonString(
    SnapshotBodySchema.parse({ version: 1, text: CALENDAR_EVENT_BODY }),
  );
}

/** Real Agent Run (running) that owns the proposal, via the public repo. */
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

  // Durable calendar target binding (same strict fixture shape as the C17
  // stager tests): connector → resource → snapshot → session reference.
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

describe("C18 proposal decisions", () => {
  it("approve is keyed exactly-once: 202 stored body, one decision Turn, queued action Run, execution+grant, idempotent replay", async () => {
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
      const body = (await first.json()) as {
        proposalId: string;
        executionId: string;
        runId: string;
        status: string;
      };
      expect(body).toEqual({
        proposalId,
        executionId: body.executionId,
        runId: body.runId,
        status: "queued",
      });

      // Replay with the same key + same body: exact stored 202, no new Turn.
      const replay = await postJson(
        f.app,
        path,
        { proposalHash: hash },
        { "idempotency-key": key },
      );
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(body);

      // Queued Action Run on the decision Turn (no runtime: stays queued).
      const turn = f.repo
        .getHistory(sessionId, { limit: 10 })
        .items.find((i) => i.kind === "action_approval");
      expect(turn).not.toBeUndefined();
      const statusResponse = await getJson(
        f.app,
        `/api/sessions/${sessionId}/runs/${body.runId}/status`,
      );
      expect(statusResponse.status).toBe(200);

      const listResponse = await getJson(
        f.app,
        `/api/sessions/${sessionId}/proposals`,
      );
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()) as {
        proposals: Array<{ status: string }>;
      };
      expect(list.proposals[0]?.status).toBe("approved");
    } finally {
      f.close();
    }
  });

  it("reject is keyless and state-idempotent with exactly one rejection Turn and no Run", async () => {
    const f = await makeApp();
    try {
      const { sessionId, proposalId, hash } = await seedProposal(f);
      const path = `/api/sessions/${sessionId}/proposals/${proposalId}/reject`;
      const first = await postJson(f.app, path, { proposalHash: hash });
      expect(first.status).toBe(200);
      const body = (await first.json()) as {
        proposalId: string;
        status: string;
        decisionTurnId: string;
        resolvedAt: number;
      };
      expect(body.status).toBe("rejected");

      const second = await postJson(f.app, path, { proposalHash: hash });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(body);

      const items = f.repo.getHistory(sessionId, { limit: 10 }).items;
      const rejections = items.filter((i) => i.kind === "action_rejection");
      expect(rejections.length).toBe(1);
      const approval = items.some((i) => i.kind === "action_approval");
      expect(approval).toBe(false);
    } finally {
      f.close();
    }
  });

  it("hash mismatch, terminal replay conflicts and foreign-session ownership are fixed 409/404", async () => {
    const f = await makeApp();
    try {
      const { sessionId, proposalId, hash } = await seedProposal(f);

      // Wrong hash → 409 proposal_hash_mismatch.
      const mismatch = await postJson(
        f.app,
        `/api/sessions/${sessionId}/proposals/${proposalId}/reject`,
        { proposalHash: "0".repeat(64) },
      );
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({
        error: {
          code: "proposal_hash_mismatch",
          message: "proposal hash mismatch",
        },
      });

      // Reject first; then approve past-terminal → 409 proposal_state_conflict.
      const rejected = await postJson(
        f.app,
        `/api/sessions/${sessionId}/proposals/${proposalId}/reject`,
        {
          proposalHash: hash,
        },
      );
      expect(rejected.status).toBe(200);
      const late = await postJson(
        f.app,
        `/api/sessions/${sessionId}/proposals/${proposalId}/approve`,
        { proposalHash: hash },
        { "idempotency-key": randomUUID() },
      );
      expect(late.status).toBe(409);
      expect(await late.json()).toEqual({
        error: {
          code: "proposal_state_conflict",
          message: "proposal state conflict",
        },
      });

      // Foreign session path never probes: 404.
      const otherSession = f.repo.createSession({ key: randomUUID(), now: T0 })
        .body.sessionId;
      const foreign = await postJson(
        f.app,
        `/api/sessions/${otherSession}/proposals/${proposalId}/reject`,
        { proposalHash: hash },
      );
      expect(foreign.status).toBe(404);
    } finally {
      f.close();
    }
  });
});

describe("M5 decision-turn retry denial (§18.4/§18.6)", () => {
  function rowCounts(f: Fixture): Record<string, number> {
    const count = (table: string): number =>
      (
        f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    return {
      turns: count("turns"),
      runs: count("runs"),
      runEvents: count("run_events"),
      executions: count("action_executions"),
      grants: count("action_execution_grants"),
      idempotency: count("api_idempotency"),
    };
  }

  async function retryTurn(
    f: Fixture,
    sessionId: string,
    turnId: string,
  ): Promise<Response> {
    return postJson(
      f.app,
      `/api/sessions/${sessionId}/turns/${turnId}/retries`,
      {},
      { "idempotency-key": randomUUID() },
    );
  }

  it("retry on the approval Turn is 400 with no new Run/events/execution/grant, while queued and after terminal cancel", async () => {
    const f = await makeApp();
    try {
      const { sessionId, proposalId, hash } = await seedProposal(f);
      const approved = await postJson(
        f.app,
        `/api/sessions/${sessionId}/proposals/${proposalId}/approve`,
        { proposalHash: hash },
        { "idempotency-key": randomUUID() },
      );
      expect(approved.status).toBe(202);
      const approvedBody = (await approved.json()) as { runId: string };
      const approvalTurnId = (
        f.repo
          .getHistory(sessionId, { limit: 10 })
          .items.find((i) => i.kind === "action_approval") as
          | { turnId: string }
          | undefined
      )?.turnId;
      expect(typeof approvalTurnId).toBe("string");

      // While the Action Run is still queued: the kind denial fires before
      // the session-busy admission, so no misleading 409 and no mutation.
      const beforeQueued = rowCounts(f);
      const deniedQueued = await retryTurn(f, sessionId, approvalTurnId ?? "");
      expect(deniedQueued.status).toBe(400);
      expect(await deniedQueued.json()).toEqual({
        error: {
          code: "validation_error",
          message: "request validation failed",
        },
      });
      expect(rowCounts(f)).toEqual(beforeQueued);

      // Settle the Action Run pre-marker (exact cancel boundary, zero
      // writes), then retry the now-terminal approval: still 400, still no
      // new Run/events/execution/grant — a failed/unknown/abandoned Action
      // is never re-executed through the generic retry.
      f.repo.cancelRun(sessionId, approvedBody.runId, { now: Date.now() });
      const beforeTerminal = rowCounts(f);
      const deniedTerminal = await retryTurn(
        f,
        sessionId,
        approvalTurnId ?? "",
      );
      expect(deniedTerminal.status).toBe(400);
      expect(await deniedTerminal.json()).toEqual({
        error: {
          code: "validation_error",
          message: "request validation failed",
        },
      });
      expect(rowCounts(f)).toEqual(beforeTerminal);

      // The approval projection is untouched: one decision Turn, one Action
      // Run, one execution + one unconsumed grant, zero external writes.
      const items = f.repo.getHistory(sessionId, { limit: 10 }).items;
      expect(items.filter((i) => i.kind === "action_approval").length).toBe(1);
      const view = f.repo.getProposalExecution(sessionId, proposalId);
      expect(view.runId).toBe(approvedBody.runId);
    } finally {
      f.close();
    }
  });

  it("retry on the rejection Turn is 400 with no new Run and the rejection intact", async () => {
    const f = await makeApp();
    try {
      const { sessionId, proposalId, hash } = await seedProposal(f);
      const rejected = await postJson(
        f.app,
        `/api/sessions/${sessionId}/proposals/${proposalId}/reject`,
        { proposalHash: hash },
      );
      expect(rejected.status).toBe(200);
      const rejectedBody = (await rejected.json()) as {
        decisionTurnId: string;
      };

      const before = rowCounts(f);
      const denied = await retryTurn(f, sessionId, rejectedBody.decisionTurnId);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({
        error: {
          code: "validation_error",
          message: "request validation failed",
        },
      });
      // A second key is denied the same way: the denial persists nothing to
      // replay, and the rejection stays exactly one Turn with no Run.
      const deniedAgain = await retryTurn(
        f,
        sessionId,
        rejectedBody.decisionTurnId,
      );
      expect(deniedAgain.status).toBe(400);
      expect(rowCounts(f)).toEqual(before);

      const items = f.repo.getHistory(sessionId, { limit: 10 }).items;
      expect(items.filter((i) => i.kind === "action_rejection").length).toBe(1);
      expect(items.some((i) => i.kind === "action_approval")).toBe(false);
      const view = f.repo.getProposalExecution(sessionId, proposalId);
      expect(view.runId).toBeNull();
      expect(view.status).toBeNull();
    } finally {
      f.close();
    }
  });

  it("user_text retry still queues a new Run on the same Turn", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({ key: randomUUID(), now: T0 })
        .body.sessionId;
      const sent = await postJson(
        f.app,
        `/api/sessions/${sessionId}/messages`,
        { text: "hello" },
        { "idempotency-key": randomUUID() },
      );
      expect(sent.status).toBe(202);
      const sentBody = (await sent.json()) as {
        turnId: string;
        run: { id: string };
      };
      await f.repo.startRun(sentBody.run.id, { now: T0 + 1 });
      f.repo.completeRun(
        sentBody.run.id,
        { version: 1, text: "hi" },
        { now: T0 + 2 },
      );

      const runsBefore = (
        f.raw.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }
      ).n;
      const retried = await retryTurn(f, sessionId, sentBody.turnId);
      expect(retried.status).toBe(202);
      const retriedBody = (await retried.json()) as {
        turnId: string;
        run: { id: string; attempt: number; status: string };
      };
      expect(retriedBody.turnId).toBe(sentBody.turnId);
      expect(retriedBody.run.status).toBe("queued");
      expect(retriedBody.run.id).not.toBe(sentBody.run.id);
      expect(
        (f.raw.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number })
          .n,
      ).toBe(runsBefore + 1);
    } finally {
      f.close();
    }
  });
});
