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
  type CalendarTargetStore,
  closeKernelDatabase,
  createDurableCalendarTargetStore,
  createInMemoryCalendarTargetStore,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
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
  readonly searchCalls: Array<{ input: unknown; timeZone: string }>;
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
  const searchCalls: Array<{ input: unknown; timeZone: string }> = [];
  const getCalls: CalendarGetTarget[] = [];
  const byEventId = new Map(events.map((event) => [event.eventId, event]));
  return {
    connectorInstanceId,
    searchCalls,
    getCalls,
    async search(input, callOptions) {
      searchCalls.push({ input, timeZone: callOptions.timeZone });
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
