// C12 Calendar tool integration regressions (dependency-inverted port).
//
// These drive the REAL kernel ToolBroker + ReferenceManager + SQLite store
// through the `calendar.search` / `reference.open` / `reference.refresh`
// registrations with a deterministic in-memory Calendar port. The port is a
// structural `CalendarConnectorPort`, never the connector package (dependency
// inversion is preserved). The genuine-SDK end-to-end smoke lives in
// @companion/connector-calendar/test/c12-smoke.test.ts.

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CalendarConnectorPort,
  type CalendarGetPortResult,
  type CalendarGetTarget,
  type CalendarNormalizedEvent,
  type CalendarSearchPortResult,
  type CalendarTargetStore,
  buildAgentToolDefinitions,
  closeKernelDatabase,
  createDurableCalendarTargetStore,
  createInMemoryCalendarTargetStore,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  type KernelRepository,
  type MarkdownConnectorPort,
  migrateKernelDatabase,
  openKernelDatabase,
  ToolError,
} from "../src/index.js";

const T0 = 1790000000000;
const CTX = { origin: "test-origin", caller: "test-caller" };
const CALENDAR_ID = "primary";
const ACCOUNT = "host-account";

interface FakeEvent {
  eventId: string;
  calendarId: string;
  status: "confirmed" | "tentative" | "cancelled" | "deleted";
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDayEndExclusive: boolean;
  sourceRevision: string;
}

function fakeEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    eventId: "evt-a",
    calendarId: CALENDAR_ID,
    status: "confirmed",
    title: "Standup",
    start: "2026-10-01T09:00:00.000Z",
    end: "2026-10-01T10:00:00.000Z",
    allDayEndExclusive: false,
    sourceRevision: '"etag-1"',
    ...overrides,
  };
}

/** Opaque C12 canonical key over (connectorInstanceId, calendarId, eventId). */
function calendarKey(
  connectorInstanceId: string,
  calendarId: string,
  eventId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([connectorInstanceId, calendarId, eventId]))
    .digest("hex");
  return `calendar:${digest}`;
}

function normalized(
  event: FakeEvent,
  connectorInstanceId: string,
): CalendarNormalizedEvent {
  return {
    schemaVersion: 1,
    canonicalKey: calendarKey(
      connectorInstanceId,
      event.calendarId,
      event.eventId,
    ),
    status: event.status,
    title: event.title,
    ...(event.description !== undefined
      ? { description: event.description }
      : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    start: event.start,
    end: event.end,
    allDayEndExclusive: event.allDayEndExclusive,
    sourceRevision: event.sourceRevision,
    revisionBasis: "etag",
    sensitivity: "personal",
  };
}

interface FakeCalendarPort extends CalendarConnectorPort {
  readonly searchCalls: Array<{
    input: unknown;
    timeZone: string;
    now: number;
  }>;
  readonly getCalls: CalendarGetTarget[];
}

function makeFakeCalendarPort(options: {
  connectorInstanceId: string;
  events: FakeEvent[];
  cursor?: string;
  extraTargets?: Array<{ canonicalKey: string; eventId: string }>;
  getImpl?: (target: CalendarGetTarget) => CalendarGetPortResult;
}): FakeCalendarPort {
  const { connectorInstanceId, events } = options;
  const searchCalls: Array<{
    input: unknown;
    timeZone: string;
    now: number;
  }> = [];
  const getCalls: CalendarGetTarget[] = [];
  const byEventId = new Map(events.map((event) => [event.eventId, event]));
  return {
    connectorInstanceId,
    searchCalls,
    getCalls,
    async search(input, callOptions) {
      searchCalls.push({
        input,
        timeZone: callOptions.timeZone,
        now: callOptions.now,
      });
      const normalizedEvents = events.map((event) =>
        normalized(event, connectorInstanceId),
      );
      const targets = events.map((event) => ({
        canonicalKey: calendarKey(
          connectorInstanceId,
          event.calendarId,
          event.eventId,
        ),
        target: { calendarId: event.calendarId, eventId: event.eventId },
      }));
      for (const extra of options.extraTargets ?? []) {
        targets.push({
          canonicalKey: extra.canonicalKey,
          target: { calendarId: CALENDAR_ID, eventId: extra.eventId },
        });
      }
      return options.cursor !== undefined
        ? {
            ok: true,
            events: normalizedEvents,
            targets,
            cursor: options.cursor,
          }
        : { ok: true, events: normalizedEvents, targets };
    },
    async get(target) {
      getCalls.push(target);
      if (options.getImpl !== undefined) {
        return options.getImpl(target);
      }
      const event = byEventId.get(target.eventId);
      if (event === undefined) {
        return { ok: false, code: "calendar_upstream_error" };
      }
      return { ok: true, event: normalized(event, connectorInstanceId) };
    },
  };
}

type PortFactory = (connectorInstanceId: string) => CalendarConnectorPort;

function eventsFactory(events: FakeEvent[]): PortFactory {
  return (id) => makeFakeCalendarPort({ connectorInstanceId: id, events });
}

async function setupCalendarStack(options: {
  events: FakeEvent[];
  portFactory?: PortFactory;
  targetStore?: CalendarTargetStore;
  now?: number;
  budgets?: { maxToolRequestsPerRun?: number };
}): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
  manager: ReturnType<typeof createReferenceManager>;
  broker: ReturnType<typeof createToolBroker>;
  port: FakeCalendarPort;
  connectorRowId: string;
  targetStore: CalendarTargetStore;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const manager = createReferenceManager(handle.raw);
  const connectorRow = manager.ensureCalendarConnectorInstance(
    "host-calendar",
    CALENDAR_ID,
    { account: ACCOUNT, now: T0 },
  );
  const port = (options.portFactory ?? eventsFactory(options.events))(
    connectorRow.id,
  ) as FakeCalendarPort;
  const targetStore =
    options.targetStore ?? createInMemoryCalendarTargetStore();
  const regs = createM1ToolRegistrations({
    db: handle.raw,
    repo,
    referenceManager: manager,
    bindings: [],
    calendarBinding: { connectorInstanceId: connectorRow.id, connector: port },
    calendarTargetStore: targetStore,
    clock: { now: () => options.now ?? T0 + 100 },
  });
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations: regs,
    ...(options.budgets !== undefined ? { budgets: options.budgets } : {}),
  });
  return {
    handle,
    repo,
    manager,
    broker,
    port,
    connectorRowId: connectorRow.id,
    targetStore,
  };
}

function newRunningRun(
  repo: KernelRepository,
  now = T0,
  timeZone?: string,
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "calendar please" },
    {
      key: randomUUID(),
      now,
      ...(timeZone !== undefined ? { timeZone } : {}),
    },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function counts(db: ReturnType<typeof openKernelDatabase>["raw"]) {
  const n = (sql: string) =>
    (db.prepare(sql).get() as unknown as { n: number }).n;
  return {
    resources: n("SELECT COUNT(*) AS n FROM resources"),
    snapshots: n("SELECT COUNT(*) AS n FROM resource_snapshots"),
    references: n("SELECT COUNT(*) AS n FROM session_references"),
    sets: n("SELECT COUNT(*) AS n FROM reference_sets"),
    targets: n("SELECT COUNT(*) AS n FROM calendar_get_targets"),
    presented: n(
      "SELECT COUNT(*) AS n FROM run_events WHERE type = 'reference.presented'",
    ),
  };
}

const SEARCH_INPUT = {
  start: "2026-10-01T00:00:00+09:00",
  end: "2026-10-01T23:59:59+09:00",
  limit: 10,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // best effort
    }
  }
});

describe("C12 Calendar search registration (broker + SQLite)", () => {
  it("C12-01 forwards the frozen Turn zone, one page, and the verbatim cursor", async () => {
    const { handle, repo, broker, port } = await setupCalendarStack({
      events: [fakeEvent()],
      portFactory: (id) =>
        makeFakeCalendarPort({
          connectorInstanceId: id,
          events: [fakeEvent()],
          cursor: "opaque-cursor-1",
        }),
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo, T0, "Asia/Tokyo");
    const out = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(out.result.actualOutcome).toBe("succeeded");
    expect(port.searchCalls).toHaveLength(1);
    expect(port.searchCalls[0]?.timeZone).toBe("Asia/Tokyo");
    const normalizedOut = out.normalized as {
      cursor?: string;
      hits: unknown[];
    };
    expect(normalizedOut.cursor).toBe("opaque-cursor-1");
    expect(normalizedOut.hits).toHaveLength(1);
  });

  it("C12-02 reuses the same revision/content but materializes a new Snapshot+rN on change", async () => {
    const events = [fakeEvent()];
    const { handle, repo, broker } = await setupCalendarStack({ events });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const first = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const firstHit = (
      first.normalized as {
        hits: Array<{ referenceId: string; snapshotId: string }>;
      }
    ).hits[0] as { referenceId: string; snapshotId: string };
    // Bypass run dedup but keep the SAME content+revision: session reuse.
    const same = await broker.invoke(runId, "calendar.search", SEARCH_INPUT, {
      ...CTX,
      freshness: "refresh",
    });
    const sameHit = (
      same.normalized as {
        hits: Array<{ referenceId: string; snapshotId: string }>;
      }
    ).hits[0] as { referenceId: string; snapshotId: string };
    expect(sameHit.snapshotId).toBe(firstHit.snapshotId);
    expect(sameHit.referenceId).toBe(firstHit.referenceId);
    // Change the revision only: a new Snapshot + rN even with identical body.
    events[0] = { ...(events[0] as FakeEvent), sourceRevision: '"etag-2"' };
    const changed = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      {
        ...CTX,
        freshness: "refresh",
      },
    );
    const changedHit = (
      changed.normalized as {
        hits: Array<{ referenceId: string; snapshotId: string }>;
      }
    ).hits[0] as { referenceId: string; snapshotId: string };
    expect(changedHit.snapshotId).not.toBe(firstHit.snapshotId);
    expect(changedHit.referenceId).not.toBe(firstHit.referenceId);
  });

  it("C12-03 explicit refresh with identical contents yields a new Snapshot+rN and rereads upstream", async () => {
    const { handle, repo, broker, port } = await setupCalendarStack({
      events: [fakeEvent()],
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const searched = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const hit = (
      searched.normalized as { hits: Array<{ referenceId: string }> }
    ).hits[0] as { referenceId: string };
    const snapshotsBefore = counts(handle.raw).snapshots;
    const refreshed = await broker.invoke(
      runId,
      "reference.refresh",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(refreshed.result.actualOutcome).toBe("succeeded");
    const view = refreshed.normalized as {
      referenceId: string;
      snapshotId: string;
    };
    expect(view.referenceId).not.toBe(hit.referenceId);
    expect(counts(handle.raw).snapshots).toBe(snapshotsBefore + 1);
    // Exact stored mapping: the private target is resolved by canonical key and
    // passed back verbatim (the port supplies the account when configured).
    expect(port.getCalls).toHaveLength(1);
    expect(port.getCalls[0]).toEqual({
      calendarId: CALENDAR_ID,
      eventId: "evt-a",
    });
  });

  it("C12-04 stored open returns the full body with no upstream read", async () => {
    const { handle, repo, broker, port } = await setupCalendarStack({
      events: [fakeEvent()],
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const searched = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const hit = (
      searched.normalized as { hits: Array<{ referenceId: string }> }
    ).hits[0] as { referenceId: string };
    const searchesBefore = port.searchCalls.length;
    const getsBefore = port.getCalls.length;
    const opened = await broker.invoke(
      runId,
      "reference.open",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(opened.result.actualOutcome).toBe("succeeded");
    const body = (opened.normalized as { body: { text: string } }).body;
    expect(body.text).toContain("Standup");
    expect(port.searchCalls).toHaveLength(searchesBefore);
    expect(port.getCalls).toHaveLength(getsBefore);
  });

  it("C12-07 a late-cancelled observation writes no Snapshot/rN/set/target/event", async () => {
    let cancel: (() => void) | undefined;
    const events = [fakeEvent()];
    const portFactory: PortFactory = (id) => {
      const base = makeFakeCalendarPort({
        connectorInstanceId: id,
        events,
      });
      const original = base.search.bind(base);
      base.search = async (input, options) => {
        // Cancel AFTER the external result is ready but BEFORE presentation.
        cancel?.();
        return original(input, options);
      };
      return base;
    };
    const { handle, repo, broker, targetStore, connectorRowId } =
      await setupCalendarStack({ events, portFactory });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId, sessionId } = newRunningRun(repo);
    cancel = () => repo.cancelRun(sessionId, runId, { now: T0 + 5 });
    const before = counts(handle.raw);
    const out = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(out.result.actualOutcome).toBe("cancelled");
    expect(out.result.errorCode).toBe("execution_cancelled");
    const after = counts(handle.raw);
    expect(after.snapshots).toBe(before.snapshots);
    expect(after.references).toBe(before.references);
    expect(after.sets).toBe(before.sets);
    expect(after.targets).toBe(before.targets);
    expect(after.presented).toBe(before.presented);
    expect(
      targetStore.get(calendarKey(connectorRowId, CALENDAR_ID, "evt-a")),
    ).toBeUndefined();
  });

  it("C12-07 a throwing target write rolls back the whole observation transaction", async () => {
    const failing: CalendarTargetStore = {
      get: () => undefined,
      put: () => {
        throw new Error("private target store failure");
      },
    };
    const { handle, repo, broker } = await setupCalendarStack({
      events: [fakeEvent()],
      targetStore: failing,
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const before = counts(handle.raw);
    const out = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(out.result.actualOutcome).toBe("failed");
    expect(out.result.errorCode).toBe("execution_failed");
    const after = counts(handle.raw);
    // The public Snapshot/rN/set/event rows and the private target write are
    // in one transaction: a target failure commits NOTHING.
    expect(after.snapshots).toBe(before.snapshots);
    expect(after.references).toBe(before.references);
    expect(after.sets).toBe(before.sets);
    expect(after.presented).toBe(before.presented);
    expect(after.resources).toBe(before.resources);
    expect(after.targets).toBe(before.targets);
  });

  it("C12-08 rejects a calendar binding whose stored instance kind is not calendar", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    const manager = createReferenceManager(handle.raw);
    const markdown = manager.ensureMarkdownConnectorInstance("vault", 1, {
      now: T0,
    });
    const port = makeFakeCalendarPort({
      connectorInstanceId: markdown.id,
      events: [fakeEvent()],
    });
    expect(() =>
      createM1ToolRegistrations({
        db: handle.raw,
        repo,
        referenceManager: manager,
        bindings: [],
        calendarBinding: {
          connectorInstanceId: markdown.id,
          connector: port,
        },
      }),
    ).toThrow(/kind must be calendar/);
    closeKernelDatabase(handle);
  });

  it("C12-08 never guesses a missing private target for refresh", async () => {
    const { handle, repo, broker, manager, connectorRowId } =
      await setupCalendarStack({ events: [fakeEvent()] });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const searched = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const hit = (
      searched.normalized as { hits: Array<{ referenceId: string }> }
    ).hits[0] as { referenceId: string };
    // A rebuilt stack uses an empty private store: the opaque key alone can
    // never synthesize a provider target, so refresh fails closed.
    const port = makeFakeCalendarPort({
      connectorInstanceId: connectorRowId,
      events: [fakeEvent()],
    });
    const brokerNoTarget = createToolBroker({
      db: handle.raw,
      repo,
      registrations: createM1ToolRegistrations({
        db: handle.raw,
        repo,
        referenceManager: manager,
        bindings: [],
        calendarBinding: {
          connectorInstanceId: connectorRowId,
          connector: port,
        },
        calendarTargetStore: createInMemoryCalendarTargetStore(),
      }),
    });
    const missing = await brokerNoTarget.invoke(
      runId,
      "reference.refresh",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(missing.result.actualOutcome).toBe("failed");
    expect(missing.result.errorCode).toBe("reference_not_found");
    expect(port.getCalls).toHaveLength(0);
  });
});

describe("C12 private target durability and provenance", () => {
  it("C12-05 survives a process restart and refresh rereads from the durable store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c12-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "kernel.sqlite");
    let runId = "";
    let referenceId = "";
    // Phase 1: search commits the private target inside the observation tx.
    {
      const handle = openKernelDatabase(dbPath);
      await migrateKernelDatabase({ db: handle.raw });
      const repo = createKernelRepository(handle.raw);
      const manager = createReferenceManager(handle.raw);
      const row = manager.ensureCalendarConnectorInstance(
        "host-calendar",
        CALENDAR_ID,
        { account: ACCOUNT, now: T0 },
      );
      const port = makeFakeCalendarPort({
        connectorInstanceId: row.id,
        events: [fakeEvent()],
      });
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: createM1ToolRegistrations({
          db: handle.raw,
          repo,
          referenceManager: manager,
          bindings: [],
          calendarBinding: { connectorInstanceId: row.id, connector: port },
          calendarTargetStore: createDurableCalendarTargetStore(handle.raw),
          clock: { now: () => T0 + 100 },
        }),
      });
      const run = newRunningRun(repo);
      runId = run.runId;
      const searched = await broker.invoke(
        runId,
        "calendar.search",
        SEARCH_INPUT,
        CTX,
      );
      expect(searched.result.actualOutcome).toBe("succeeded");
      referenceId = (
        searched.normalized as { hits: Array<{ referenceId: string }> }
      ).hits[0]?.referenceId as string;
      expect(counts(handle.raw).targets).toBe(1);
      closeKernelDatabase(handle);
    }
    // Phase 2: fresh connections; only durable SQLite carries the target.
    {
      const handle = openKernelDatabase(dbPath);
      await migrateKernelDatabase({ db: handle.raw });
      const repo = createKernelRepository(handle.raw);
      const manager = createReferenceManager(handle.raw);
      const row = (
        handle.raw
          .prepare("SELECT id FROM connector_instances WHERE kind = 'calendar'")
          .get() as { id: string }
      ).id;
      const freshPort = makeFakeCalendarPort({
        connectorInstanceId: row,
        events: [fakeEvent()],
      });
      const targetStore = createDurableCalendarTargetStore(handle.raw);
      expect(targetStore.get(calendarKey(row, CALENDAR_ID, "evt-a"))).toEqual({
        calendarId: CALENDAR_ID,
        eventId: "evt-a",
      });
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: createM1ToolRegistrations({
          db: handle.raw,
          repo,
          referenceManager: manager,
          bindings: [],
          calendarBinding: { connectorInstanceId: row, connector: freshPort },
          calendarTargetStore: targetStore,
          clock: { now: () => T0 + 200 },
        }),
      });
      // The run is still `running` across the restart (no engine recovery).
      const refreshed = await broker.invoke(
        runId,
        "reference.refresh",
        { referenceId },
        CTX,
      );
      expect(refreshed.result.actualOutcome).toBe("succeeded");
      expect(freshPort.getCalls).toHaveLength(1);
      closeKernelDatabase(handle);
    }
  });

  it("C12-08 output carries opaque provenance and no provider ids; only presented targets persist", async () => {
    const { handle, repo, broker, targetStore, connectorRowId } =
      await setupCalendarStack({
        events: [fakeEvent()],
        portFactory: (id) =>
          makeFakeCalendarPort({
            connectorInstanceId: id,
            events: [fakeEvent()],
            extraTargets: [
              { canonicalKey: "calendar:deadbeef", eventId: "not-presented" },
            ],
          }),
      });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo, T0, "Asia/Tokyo");
    const out = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(out.result.actualOutcome).toBe("succeeded");
    const hit = (
      out.normalized as {
        hits: Array<{
          canonicalKey: string;
          resourceId: string;
          snapshotId: string;
          referenceId: string;
          ordinal: number;
        }>;
      }
    ).hits[0] as {
      canonicalKey: string;
      resourceId: string;
      snapshotId: string;
      referenceId: string;
      ordinal: number;
    };
    expect(hit.canonicalKey).toMatch(/^calendar:[0-9a-f]{64}$/);
    expect(hit.referenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(hit.ordinal).toBe(1);
    // Provider ids never appear in the model-facing output.
    const serialized = JSON.stringify(out.modelFacing);
    expect(serialized).not.toContain("evt-a");
    expect(serialized).not.toContain(CALENDAR_ID);
    expect(serialized).not.toContain(ACCOUNT);
    // Provenance: the committed Snapshot binds the opaque key to the fixed
    // connector instance and carries the upstream revision as source_revision.
    const snapshot = handle.raw
      .prepare(
        "SELECT s.source_revision AS source_revision, r.canonical_key AS canonical_key, r.connector_instance_id AS instance_id FROM resource_snapshots s JOIN resources r ON r.id = s.resource_id WHERE s.id = ?",
      )
      .get(hit.snapshotId) as {
      source_revision: string;
      canonical_key: string;
      instance_id: string;
    };
    expect(snapshot.canonical_key).toBe(hit.canonicalKey);
    expect(snapshot.instance_id).toBe(connectorRowId);
    expect(snapshot.source_revision).toBe('"etag-1"');
    // Only the presented key's target is stored; the extra is ignored.
    expect(
      targetStore.get(calendarKey(connectorRowId, CALENDAR_ID, "evt-a")),
    ).toEqual({ calendarId: CALENDAR_ID, eventId: "evt-a" });
    expect(targetStore.get("calendar:deadbeef")).toBeUndefined();
  });

  it("C12-06 a failed/omitted follow-up keeps the prior Snapshot and stored open", async () => {
    const { handle, repo, broker, port, targetStore, connectorRowId } =
      await setupCalendarStack({ events: [fakeEvent()] });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const first = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const hit = (first.normalized as { hits: Array<{ referenceId: string }> })
      .hits[0] as { referenceId: string };
    const snapshotsAfterFirst = counts(handle.raw).snapshots;
    // Failed upstream on a fresh run: retained history, no tombstone.
    const failingRun = newRunningRun(repo, T0 + 500).runId;
    port.search = async () => ({ ok: false, code: "calendar_upstream_error" });
    const failed = await broker.invoke(
      failingRun,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(failed.result.actualOutcome).toBe("failed");
    expect(failed.result.errorCode).toBe("calendar_upstream_error");
    expect(counts(handle.raw).snapshots).toBe(snapshotsAfterFirst);
    // Omitted (empty) page: still retained, no deletion.
    port.search = async () => ({ ok: true, events: [], targets: [] });
    const omittedRun = newRunningRun(repo, T0 + 900).runId;
    const omitted = await broker.invoke(
      omittedRun,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(omitted.result.actualOutcome).toBe("succeeded");
    expect(counts(handle.raw).snapshots).toBe(snapshotsAfterFirst);
    // The original reference still opens with its original body.
    const opened = await broker.invoke(
      runId,
      "reference.open",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(opened.result.actualOutcome).toBe("succeeded");
    expect(
      (opened.normalized as { body: { text: string } }).body.text,
    ).toContain("Standup");
    expect(JSON.stringify(opened.modelFacing).toLowerCase()).not.toContain(
      "deleted",
    );
    // The committed private target is untouched by the failed/omitted attempts.
    expect(
      targetStore.get(calendarKey(connectorRowId, CALENDAR_ID, "evt-a")),
    ).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* C13 broker/exposure/frozen-time integration                          */
/* ------------------------------------------------------------------ */

/** Deterministic fake Markdown port for the mixed cross-source session. */
function makeFakeMarkdownPort(
  files: Readonly<Record<string, { title: string; text: string; revision: string }>>,
): MarkdownConnectorPort & {
  readonly searchQueries: string[];
  readonly readCalls: string[];
} {
  const searchQueries: string[] = [];
  const readCalls: string[] = [];
  return {
    searchQueries,
    readCalls,
    async search(input) {
      const query = (input as { query: string }).query;
      searchQueries.push(query);
      const file = files[query];
      if (file === undefined) {
        return { hits: [], skipped: [] };
      }
      return {
        hits: [
          {
            canonicalKey: `vault/${query}.md`,
            title: file.title,
            text: file.text,
            sourceRevision: file.revision,
            snippet: file.title,
            standardLinks: [],
            wikiLinks: [],
          },
        ],
        skipped: [],
      };
    },
    async readCanonical(canonicalKey) {
      readCalls.push(canonicalKey);
      // Not reached by these scenarios (open/related are stored-only).
      throw new ToolError("execution_failed");
    },
  };
}

async function setupMixedStack(options: {
  events: FakeEvent[];
  markdownFiles: Record<
    string,
    { title: string; text: string; revision: string }
  >;
}): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
  broker: ReturnType<typeof createToolBroker>;
  port: FakeCalendarPort;
  markdownPort: ReturnType<typeof makeFakeMarkdownPort>;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const manager = createReferenceManager(handle.raw);
  const markdownRow = manager.ensureMarkdownConnectorInstance("vault", 1, {
    now: T0,
  });
  const calendarRow = manager.ensureCalendarConnectorInstance(
    "host-calendar",
    CALENDAR_ID,
    { account: ACCOUNT, now: T0 },
  );
  const port = makeFakeCalendarPort({
    connectorInstanceId: calendarRow.id,
    events: options.events,
  });
  const markdownPort = makeFakeMarkdownPort(options.markdownFiles);
  const regs = createM1ToolRegistrations({
    db: handle.raw,
    repo,
    referenceManager: manager,
    bindings: [{ connectorInstanceId: markdownRow.id, connector: markdownPort }],
    calendarBinding: { connectorInstanceId: calendarRow.id, connector: port },
    calendarTargetStore: createInMemoryCalendarTargetStore(),
    clock: { now: () => T0 + 100 },
  });
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations: regs,
  });
  return { handle, repo, broker, port, markdownPort };
}

describe("C13 broker exposure / frozen context / cross-source", () => {
  it("C13-01 advertises exactly one model-visible calendar.search descriptor; individual upstream tools are never exposed (C13-08 read-only)", async () => {
    const { handle, broker } = await setupCalendarStack({
      events: [fakeEvent()],
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const descriptor = broker
      .describeTools()
      .find((d) => d.name === "calendar.search");
    expect(descriptor).toBeDefined();
    // C13-08: read-only category only; the connector-internal upstream tools
    // (`list-events`/`search-events`/`get-event`) never become descriptors.
    expect(descriptor?.category).toBe("read");
    const tools = buildAgentToolDefinitions(broker.describeTools());
    expect(tools.filter((t) => t.name === "calendar.search")).toHaveLength(1);
    expect(
      tools.some((t) =>
        /(^|\.)(list-events|search-events|get-event)(\.|$)/.test(t.name),
      ),
    ).toBe(false);
    const featured = tools.find((t) => t.name === "calendar.search");
    expect(featured?.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 256 },
        start: { type: "string", minLength: 1, maxLength: 128 },
        end: { type: "string", minLength: 1, maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
        cursor: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["start", "end"],
      additionalProperties: false,
    });
    // The advertised parameters stay closed and without a freshness field:
    // the Calendar input contract has none.
    const params = featured?.parameters as
      | { properties: Record<string, unknown> }
      | undefined;
    expect(params?.properties?.freshness).toBeUndefined();
  });

  it("C13-02 budget reserves first; dedup reuse still reserves; an over-budget call is blocked before classify/validate/execute", async () => {
    const { handle, repo, broker, port } = await setupCalendarStack({
      events: [fakeEvent()],
      budgets: { maxToolRequestsPerRun: 2 },
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const { runId } = newRunningRun(repo);
    const first = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(first.result.actualOutcome).toBe("succeeded");
    const second = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    // Same canonical query fingerprint in the same Run: dedup reuse...
    expect(second.result.actualOutcome).toBe("deduplicated");
    expect(second.result.reusedFromCallId).not.toBeNull();
    // ...but the reservation happens before dedup (2/2 budget used).
    expect(port.searchCalls).toHaveLength(1);
    // The third request is exhausted exactly at budget_reserve: blocked
    // before classify/dedup/execute with the fixed metadata-only code.
    const third = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(third.result.actualOutcome).toBe("failed");
    expect(third.result.errorCode).toBe("budget_exceeded");
    expect(third.pipeline[0]).toBe("budget_reserve");
    expect(port.searchCalls).toHaveLength(1);
  });

  it("C13-03 a stalled upstream call times out with the fixed audit code and materializes nothing", async () => {
    const { handle, repo, broker, port } = await setupCalendarStack({
      events: [fakeEvent()],
    });
    cleanups.push(() => closeKernelDatabase(handle));
    // Dedup reuse stays transparent (covered above); here a fresh Run calls
    // upstream once and stalls: the broker composes timeout and detaches.
    port.search = (_input, callOptions) =>
      new Promise<CalendarSearchPortResult>((resolve) => {
        callOptions.signal?.addEventListener(
          "abort",
          () => {
            resolve({ ok: false, code: "mcp_unavailable" });
          },
          { once: true },
        );
      });
    const { runId } = newRunningRun(repo, T0 + 300);
    const before = counts(handle.raw).snapshots;
    const timed = await broker.invoke(runId, "calendar.search", SEARCH_INPUT, {
      ...CTX,
      timeoutMs: 25,
    });
    expect(timed.result.actualOutcome).toBe("timed_out");
    expect(timed.result.errorCode).toBe("execution_timeout");
    // No Snapshot/rN/reference/target ever materialized for the stalled call.
    expect(counts(handle.raw).snapshots).toBe(before);
    expect(counts(handle.raw).targets).toBe(0);
    // The port resolved only on the composed abort (no dangling handler).
    expect(port.searchCalls).toHaveLength(1);
  });

  it("C13-04/05 a Retry reuses the SAME frozen Turn zone+instant without recomputation; only explicit new-Run retries call upstream", async () => {
    const { handle, repo, broker, port } = await setupCalendarStack({
      events: [fakeEvent()],
    });
    cleanups.push(() => closeKernelDatabase(handle));
    const { sessionId, runId } = newRunningRun(repo, T0, "Asia/Tokyo");
    const first = await broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(first.result.actualOutcome).toBe("succeeded");
    // Settle attempt 1 so the session is not busy for the explicit retry.
    repo.failRun(runId, "execution_failed", { now: T0 + 10 });
    const turnId = repo.getRun(runId).turnId;
    const frozen = repo.getTurn(turnId).frozenContext;
    expect(frozen.temporal.timeZone).toBe("Asia/Tokyo");
    expect(frozen.temporal.now).toBe(T0);
    // Explicit Retry (§17.4): a NEW Run on the immutable Turn; no automatic
    // logical resend happened inside the first run (exactly one upstream call).
    expect(port.searchCalls).toHaveLength(1);
    const retry = repo.postRetry(sessionId, turnId, {
      key: randomUUID(),
      now: T0 + 600_000,
    });
    expect(retry.body.run.attempt).toBe(2);
    repo.startRun(retry.body.run.id, { now: T0 + 600_001 });
    const second = await broker.invoke(
      retry.body.run.id,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(second.result.actualOutcome).toBe("succeeded");
    // Both attempts consumed the IDENTICAL frozen temporal context; the
    // immutable Turn row was never recomputed or rewritten.
    expect(port.searchCalls).toHaveLength(2);
    expect(port.searchCalls[0]).toEqual({
      input: SEARCH_INPUT,
      timeZone: "Asia/Tokyo",
      now: T0,
    });
    expect(port.searchCalls[1]).toEqual(port.searchCalls[0]);
    expect(repo.getTurn(turnId).frozenContext).toEqual(frozen);
  });

  it("C13-06/07 mixed Calendar/Markdown references share one session sequence; Calendar-origin related/open are stored-only; a failed call adds no stale evidence", async () => {
    const { handle, repo, broker, port, markdownPort } = await setupMixedStack({
      events: [fakeEvent()],
      markdownFiles: {
        "standup notes": {
          title: "Standup notes",
          text: "Notes for the calendar sync.",
          revision: "rev-a",
        },
        "retro minutes": {
          title: "Retro minutes",
          text: "Minutes of the retro.",
          revision: "rev-b",
        },
      },
    });
    cleanups.push(() => closeKernelDatabase(handle));
    // One session, three runs, three sources interleaved.
    const r1 = newRunningRun(repo);
    const md1 = await broker.invoke(
      r1.runId,
      "markdown.search",
      { query: "standup notes", limit: 10, freshness: "normal" },
      CTX,
    );
    const r2 = newRunningRun(repo, T0 + 200);
    const cal = await broker.invoke(
      r2.runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const r3 = newRunningRun(repo, T0 + 400);
    const md2 = await broker.invoke(
      r3.runId,
      "markdown.search",
      { query: "retro minutes", limit: 10, freshness: "normal" },
      CTX,
    );
    // Mixed Calendar/Markdown references share ONE ordered session sequence.
    const md1Hit = (md1.normalized as { hits: Array<{ ordinal: number }> })
      .hits[0] as { ordinal: number };
    const calHit = (
      cal.normalized as {
        hits: Array<{ referenceId: string; ordinal: number; status: string }>;
      }
    ).hits[0] as { referenceId: string; ordinal: number; status: string };
    const md2Hit = (md2.normalized as { hits: Array<{ ordinal: number }> })
      .hits[0] as { ordinal: number };
    expect(md1Hit.ordinal).toBe(1);
    expect(calHit.ordinal).toBe(2);
    expect(md2Hit.ordinal).toBe(3);
    expect(calHit.status).toBe("confirmed");
    expect(calHit.referenceId).toMatch(/^[0-9a-f-]{36}$/);
    const upstreamBefore =
      port.searchCalls.length +
      port.getCalls.length +
      markdownPort.searchQueries.length +
      markdownPort.readCalls.length;
    // Stored-only open across the mixed set: Calendar-origin reference opens
    // without any upstream read.
    const opened = await broker.invoke(
      r3.runId,
      "reference.open",
      { referenceId: calHit.referenceId },
      CTX,
    );
    expect(opened.result.actualOutcome).toBe("succeeded");
    expect((opened.normalized as { body: { text: string } }).body.text).toContain(
      "Standup",
    );
    expect((opened.normalized as { canonicalKey: string }).canonicalKey).toMatch(
      /^calendar:[0-9a-f]{64}$/,
    );
    // Calendar-origin reference.related: deterministic stored link-graph read
    // (calendar snapshots carry no links and invent no Markdown rNs).
    const related = await broker.invoke(
      r3.runId,
      "reference.related",
      { referenceId: calHit.referenceId, limit: 20 },
      CTX,
    );
    expect((related.normalized as { references: unknown[] }).references).toEqual(
      [],
    );
    // Neither stored-only flow read upstream.
    expect(
      port.searchCalls.length +
        port.getCalls.length +
        markdownPort.searchQueries.length +
        markdownPort.readCalls.length,
    ).toBe(upstreamBefore);
    // C13-07: a failed calendar call audits only the fixed code and never
    // adds stale/uncited references or rewrites prior evidence.
    const referencesBefore = counts(handle.raw).references;
    port.search = async () => ({ ok: false, code: "calendar_upstream_error" });
    const r4 = newRunningRun(repo, T0 + 800);
    const failed = await broker.invoke(
      r4.runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(failed.result.actualOutcome).toBe("failed");
    expect(failed.result.errorCode).toBe("calendar_upstream_error");
    expect(counts(handle.raw).references).toBe(referencesBefore);
    // Prior references remain openable exactly as before the failure.
    const stillOpen = await broker.invoke(
      r4.runId,
      "reference.open",
      { referenceId: calHit.referenceId },
      CTX,
    );
    expect(stillOpen.result.actualOutcome).toBe("succeeded");
  });
});
