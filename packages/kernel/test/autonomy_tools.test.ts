// Normal-agent readonly autonomy tools: consumer-boundary regressions.
//
// Proves through the REAL kernel repository + ToolBroker (in-memory DB):
// - ownership: a run reads ONLY its own session's records (foreign ids
//   fail closed as `execution_failed`, never a distinct 404 leak; lists
//   exclude foreign sessions);
// - scope filter applies BEFORE the limit (in-scope records are never
//   hidden behind newest-first truncation of other scopes) with truthful
//   `hasMore` (limit+1 probe, never an `all` claim);
// - lists return BOUNDED SNIPPETS with an explicit `truncated` flag;
//   `open` returns the full original PLUS separately stored
//   interpretation/provenance/scope/status and REAL timestamps (never
//   invented dates);
// - reads NEVER mutate: purpose/task rows, versions, and statuses are
//   identical before and after every list/open call; no grants conferred.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAgentToolDefinitions,
  closeKernelDatabase,
  createAutonomyReadRegistrations,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_003_000_000;
const CTX = { origin: "test-origin", caller: "test-caller" };

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  const other = repo.createSession({ key: randomUUID(), now: T0 + 1 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId as string,
    otherId: other.body.sessionId as string,
  };
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  now: number,
): string {
  const posted = repo.postMessage(
    sessionId,
    { text: "hello" },
    { key: randomUUID(), now },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: now + 1 });
  return runId;
}

function goalBody(statement: string, extra: Record<string, unknown> = {}) {
  return {
    scope: "health",
    statement,
    kind: "goal",
    explicit: true,
    sourceKind: "user",
    ...extra,
  };
}

function countRows(
  handle: ReturnType<typeof openKernelDatabase>,
  table: string,
): number {
  const row = handle.raw
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

async function setup() {
  const made = await makeRepo();
  const broker = createToolBroker({
    db: made.handle.raw,
    repo: made.repo,
    registrations: createAutonomyReadRegistrations({ repo: made.repo }),
  });
  return { ...made, broker };
}

describe("autonomy readonly tools", () => {
  it("registers exactly the four readonly tools", async () => {
    const { handle, broker } = await setup();
    try {
      expect([...broker.toolNames()].sort()).toEqual([
        "purpose.list",
        "purpose.open",
        "task.list",
        "task.open",
      ]);
      // Consumer surface: the normal agent actually advertises all four
      // (closed schemas, no silent skip by the allowlist gate).
      const advertised = buildAgentToolDefinitions(broker.describeTools());
      expect(advertised.map((tool) => tool.name).sort()).toEqual([
        "answer.submit",
        "purpose.list",
        "purpose.open",
        "task.list",
        "task.open",
      ]);
      for (const tool of advertised) {
        expect(tool.parameters).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("purpose list scopes before limit with truthful hasMore and snippets", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      // 25 other-scope records push newest-first unscoped lists…
      for (let i = 0; i < 25; i += 1) {
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "other",
            statement: `other goal ${i}`,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now: T0 + 10 + i },
        );
      }
      const longStatement = `x${"y".repeat(300)}`;
      const p1 = repo.createAutonomyPurpose(sessionId, goalBody("short goal"), {
        key: randomUUID(),
        now: T0 + 100,
      });
      repo.createAutonomyPurpose(
        sessionId,
        goalBody(longStatement, { interpretation: "model guess" }),
        { key: randomUUID(), now: T0 + 101 },
      );
      repo.createAutonomyPurpose(sessionId, goalBody("third goal"), {
        key: randomUUID(),
        now: T0 + 102,
      });
      void p1;
      // …yet the scoped list finds ALL in-scope records (scope BEFORE limit).
      const scoped = await broker.invoke(
        runId,
        "purpose.list",
        { scope: "health", limit: 10 },
        CTX,
      );
      expect(scoped.result.actualOutcome).toBe("succeeded");
      const scopedOut = scoped.modelFacing as {
        items: {
          snippet: string;
          truncated: boolean;
          scope: string;
        }[];
        hasMore: boolean;
      };
      expect(scopedOut.items).toHaveLength(3);
      expect(scopedOut.hasMore).toBe(false);
      expect(scopedOut.items.every((item) => item.scope === "health")).toBe(
        true,
      );
      const long = scopedOut.items.find((item) => item.truncated === true);
      expect(long).toBeDefined();
      expect(Array.from(long?.snippet ?? "")).toHaveLength(200);
      expect(long?.snippet).toBe(
        Array.from(longStatement).slice(0, 200).join(""),
      );
      const shorts = scopedOut.items.filter((item) => item.truncated === false);
      expect(shorts.map((item) => item.snippet).sort()).toEqual([
        "short goal",
        "third goal",
      ]);
      // Pagination is truthful: 3 records, limit 2 -> 2 + hasMore.
      const page = await broker.invoke(
        runId,
        "purpose.list",
        { scope: "health", limit: 2 },
        CTX,
      );
      const pageOut = page.modelFacing as {
        items: unknown[];
        hasMore: boolean;
      };
      expect(pageOut.items).toHaveLength(2);
      expect(pageOut.hasMore).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("purpose open returns the full original plus provenance and real times", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      const created = repo.createAutonomyPurpose(
        sessionId,
        goalBody("walk every morning", {
          interpretation: "prefers morning walks",
          validFrom: "2026-01-01T00:00:00+00:00",
        }),
        { key: randomUUID(), now: T0 + 50 },
      );
      const out = await broker.invoke(
        runId,
        "purpose.open",
        { purposeId: created.body.id },
        CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const view = out.modelFacing as Record<string, unknown>;
      expect(view.statement).toBe("walk every morning");
      expect(view.interpretation).toBe("prefers morning walks");
      expect(view.kind).toBe("goal");
      expect(view.explicit).toBe(true);
      expect(view.sourceKind).toBe("user");
      expect(view.scope).toBe("health");
      expect(view.status).toBe("active");
      // Real stored timestamps, never invented dates.
      expect(view.createdAt).toBe(T0 + 50);
      expect(view.updatedAt).toBe(T0 + 50);
      expect(view.validFrom).toBe("2026-01-01T00:00:00+00:00");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("status/kind filters narrow before pagination", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      const keep = repo.createAutonomyPurpose(
        sessionId,
        goalBody("active goal"),
        { key: randomUUID(), now: T0 + 10 },
      );
      const gone = repo.createAutonomyPurpose(
        sessionId,
        goalBody("revoked goal"),
        { key: randomUUID(), now: T0 + 11 },
      );
      repo.revokeAutonomyPurpose(
        sessionId,
        gone.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 12 },
      );
      const active = await broker.invoke(
        runId,
        "purpose.list",
        { scope: "health", status: "active", limit: 10 },
        CTX,
      );
      const activeOut = active.modelFacing as {
        items: { purposeId: string }[];
        hasMore: boolean;
      };
      expect(activeOut.items.map((i) => i.purposeId)).toEqual([keep.body.id]);
      expect(activeOut.hasMore).toBe(false);
      const revoked = await broker.invoke(
        runId,
        "purpose.list",
        { scope: "health", status: "revoked", limit: 10 },
        CTX,
      );
      const revokedOut = revoked.modelFacing as {
        items: { purposeId: string }[];
        hasMore: boolean;
      };
      expect(revokedOut.items.map((i) => i.purposeId)).toEqual([gone.body.id]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("filtered-empty lists report unfilteredTotal and availableScopes", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      repo.createAutonomyPurpose(
        sessionId,
        goalBody("stabilize the trial feature", { scope: "default" }),
        { key: randomUUID(), now: T0 + 10 },
      );
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "default",
          title: "show trial failure reasons",
          kind: "task",
          speaker: "user",
        },
        { key: randomUUID(), now: T0 + 11 },
      );
      // A model-invented scope must not read as "no records exist".
      const purposeEmpty = await broker.invoke(
        runId,
        "purpose.list",
        { scope: "personal", limit: 10 },
        CTX,
      );
      expect(purposeEmpty.result.actualOutcome).toBe("succeeded");
      const purposeOut = purposeEmpty.modelFacing as {
        items: unknown[];
        hasMore: boolean;
        appliedFilters: Record<string, unknown>;
        unfilteredTotal?: number;
        availableScopes?: string[];
      };
      expect(purposeOut.items).toEqual([]);
      expect(purposeOut.hasMore).toBe(false);
      expect(purposeOut.appliedFilters).toEqual({ scope: "personal" });
      expect(purposeOut.unfilteredTotal).toBe(1);
      expect(purposeOut.availableScopes).toEqual(["default"]);
      // A wrong kind under the RIGHT scope is still explained.
      const kindEmpty = await broker.invoke(
        runId,
        "purpose.list",
        { scope: "default", kind: "preference", limit: 10 },
        CTX,
      );
      const kindOut = kindEmpty.modelFacing as {
        items: unknown[];
        unfilteredTotal?: number;
      };
      expect(kindOut.items).toEqual([]);
      expect(kindOut.unfilteredTotal).toBe(1);
      // task.list mirrors the same contract.
      const taskEmpty = await broker.invoke(
        runId,
        "task.list",
        { scope: "personal", limit: 10 },
        CTX,
      );
      const taskOut = taskEmpty.modelFacing as {
        items: unknown[];
        appliedFilters: Record<string, unknown>;
        unfilteredTotal?: number;
        availableScopes?: string[];
      };
      expect(taskOut.items).toEqual([]);
      expect(taskOut.appliedFilters).toEqual({ scope: "personal" });
      expect(taskOut.unfilteredTotal).toBe(1);
      expect(taskOut.availableScopes).toEqual(["default"]);
      // With no filters the summary fields stay absent (never noise).
      const all = await broker.invoke(
        runId,
        "purpose.list",
        { limit: 20 },
        CTX,
      );
      const allOut = all.modelFacing as Record<string, unknown>;
      expect(allOut.appliedFilters).toEqual({});
      expect("unfilteredTotal" in allOut).toBe(false);
      expect("availableScopes" in allOut).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("foreign sessions are unreachable and never leak", async () => {
    const { handle, repo, broker, sessionId, otherId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      const foreign = repo.createAutonomyPurpose(
        otherId,
        goalBody("foreign goal"),
        { key: randomUUID(), now: T0 + 10 },
      );
      const open = await broker.invoke(
        runId,
        "purpose.open",
        { purposeId: foreign.body.id },
        CTX,
      );
      expect(open.result.actualOutcome).toBe("failed");
      const listed = await broker.invoke(
        runId,
        "purpose.list",
        { limit: 20 },
        CTX,
      );
      const listedOut = listed.modelFacing as {
        items: { purposeId: string }[];
        hasMore: boolean;
      };
      expect(listedOut.items.some((i) => i.purposeId === foreign.body.id)).toBe(
        false,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("task list/open mirror purpose boundaries with parent and deadline", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      const parent = repo.createAutonomyPurpose(
        sessionId,
        goalBody("parent goal"),
        { key: randomUUID(), now: T0 + 10 },
      );
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "prepare the weekly review",
          body: "gather notes first",
          kind: "task",
          speaker: "user",
          deadline: "2026-02-01T09:00:00+00:00",
          parentPurposeId: parent.body.id,
        },
        { key: randomUUID(), now: T0 + 11 },
      );
      const listed = await broker.invoke(
        runId,
        "task.list",
        { scope: "health", limit: 10 },
        CTX,
      );
      const listedOut = listed.modelFacing as {
        items: { taskId: string; snippet: string; truncated: boolean }[];
        hasMore: boolean;
      };
      expect(listedOut.items).toHaveLength(1);
      expect(listedOut.items[0]?.taskId).toBe(task.body.id);
      expect(listedOut.items[0]?.truncated).toBe(false);
      expect(listedOut.hasMore).toBe(false);
      const opened = await broker.invoke(
        runId,
        "task.open",
        { taskId: task.body.id },
        CTX,
      );
      const view = opened.modelFacing as Record<string, unknown>;
      expect(view.title).toBe("prepare the weekly review");
      expect(view.body).toBe("gather notes first");
      expect(view.parentPurposeId).toBe(parent.body.id);
      expect(view.deadline).toBe("2026-02-01T09:00:00+00:00");
      expect(view.createdAt).toBe(T0 + 11);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reads never mutate purposes/tasks or confer grants", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, T0);
      const created = repo.createAutonomyPurpose(
        sessionId,
        goalBody("stable goal", { kind: "permission" }),
        { key: randomUUID(), now: T0 + 10 },
      );
      const before = {
        purposes: countRows(handle, "autonomy_purposes"),
        tasks: countRows(handle, "autonomy_tasks"),
        purpose: repo.getAutonomyPurpose(sessionId, created.body.id),
      };
      await broker.invoke(runId, "purpose.list", { limit: 20 }, CTX);
      await broker.invoke(
        runId,
        "purpose.open",
        { purposeId: created.body.id },
        CTX,
      );
      await broker.invoke(runId, "task.list", { limit: 20 }, CTX);
      const after = {
        purposes: countRows(handle, "autonomy_purposes"),
        tasks: countRows(handle, "autonomy_tasks"),
        purpose: repo.getAutonomyPurpose(sessionId, created.body.id),
      };
      expect(after.purposes).toBe(before.purposes);
      expect(after.tasks).toBe(before.tasks);
      expect(after.purpose).toEqual(before.purpose);
      // A permission CLAIM stays a claim: status/version untouched.
      expect(after.purpose.status).toBe("active");
      expect(after.purpose.version).toBe(1);
      expect(after.purpose.kind).toBe("permission");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
