// T1+T6 regression: approval history projects the ACTUAL owned Action
// execution + receipt INDEPENDENT of `turn_selections`, and completed Action
// RunResult text is ID-free.
//
// Real SQLite service lifecycle only (repository + concrete
// ActionExecutionService on the same connection): no mocked forwarding, no
// seeded history, no UI bypass. Covers failed / unknown / pre-marker
// cancelled / recovered-abandoned terminals (receipt retained,
// `selectedRun` non-null with `result: null`, zero `turn_selections` rows)
// and completed terminals (blocked_stale + succeeded_unverified + verified
// succeeded: ID-free result text, fresh rN citation preserved, completed-only
// selection intact). A regular failed user_text turn stays unselected.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotBodySchema } from "@companion/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { calendarEventBodyText } from "../src/calendar_tools.js";
import { canonicalJsonString } from "../src/canonical.js";
import {
  BUNDLED_SCHEMA_VERSION,
  closeKernelDatabase,
  createActionExecutionService,
  createKernelRepository,
  createReferenceManager,
  generateId,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

interface ApprovedFixture {
  handle: ReturnType<typeof openKernelDatabase>;
  repo: ReturnType<typeof createKernelRepository>;
  service: ReturnType<typeof createActionExecutionService>;
  sessionId: string;
  proposalId: string;
  runId: string;
  executionId: string;
  close: () => void;
}

async function makeApprovedFixture(): Promise<ApprovedFixture> {
  const dir = mkdtempSync(join(tmpdir(), "action-history-receipt-"));
  tempRoots.push(dir);
  const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
  const migrated = await migrateKernelDatabase({
    db: handle.raw,
    targetVersion: BUNDLED_SCHEMA_VERSION,
    migrationsDir: MIGRATIONS_DIR,
  });
  if (migrated.toVersion !== BUNDLED_SCHEMA_VERSION) {
    throw new Error("migration failed");
  }
  const repo = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true },
  });
  const service = createActionExecutionService({
    db: handle.raw,
    referenceManager: createReferenceManager(handle.raw),
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
  // The manual reference consumes ordinal 1: advance the allocator so a
  // later fresh materialization cannot collide with it.
  handle.raw
    .prepare("UPDATE sessions SET next_reference_ordinal = 2 WHERE id = ?")
    .run(sessionId);

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
    {
      now: T0 + 2,
    },
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
  const close = () => closeKernelDatabase(handle);
  return {
    handle,
    repo,
    service,
    sessionId,
    proposalId: proposed.payload.proposalId,
    runId: approved.body.runId,
    executionId: approved.body.executionId,
    close,
  };
}

function approvalItem(fx: ApprovedFixture) {
  const items = fx.repo.getHistory(fx.sessionId, { limit: 10 }).items;
  const item = items.find((i) => i.kind === "action_approval") as
    | {
        kind: "action_approval";
        turnId: string;
        selectedRun: {
          runId: string;
          attempt: number;
          runStatus: string;
          finishedAt: number | null;
          result: unknown;
          receipt: {
            outcome: string;
            summary: { summary: string };
          } | null;
          executionStatus: string | null;
        } | null;
      }
    | undefined;
  if (item === undefined) {
    throw new Error("expected an action_approval history item");
  }
  return item;
}

/** Completed-only selection rows for the APPROVAL turn itself (T1). */
function approvalSelectionRows(
  fx: ApprovedFixture,
  approvalTurnId: string,
): number {
  return (
    fx.handle.raw
      .prepare("SELECT COUNT(*) AS n FROM turn_selections WHERE turn_id = ?")
      .get(approvalTurnId) as { n: number }
  ).n;
}

function visibleTextOf(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return "";
  }
  const record = result as { version?: unknown; text?: unknown };
  return typeof record.text === "string" ? record.text : "";
}

describe("T1 approval history retains the actual receipt for every terminal", () => {
  it("preflight failure: receipt failed, selectedRun non-null with result null, zero selections", async () => {
    const fx = await makeApprovedFixture();
    try {
      const picked = fx.service.startActionRun(fx.runId, { now: T0 + 4 });
      expect(picked.applied).toBe(true);
      const failed = fx.service.recordActionPreflightFailure(fx.runId, {
        now: T0 + 5,
      });
      expect(failed.applied).toBe(true);

      const item = approvalItem(fx);
      expect(item.selectedRun).not.toBeNull();
      expect(item.selectedRun?.runStatus).toBe("failed");
      expect(item.selectedRun?.result).toBeNull();
      expect(item.selectedRun?.receipt?.outcome).toBe("failed");
      expect(
        typeof item.selectedRun?.receipt?.summary.summary === "string" &&
          item.selectedRun.receipt.summary.summary.length > 0,
      ).toBe(true);
      expect(item.selectedRun?.executionStatus).toBe("failed");
      // Completed-only selection untouched: no fabricated selection.
      expect(approvalSelectionRows(fx, item.turnId)).toBe(0);
    } finally {
      fx.close();
    }
  });

  it("post-marker unknown: receipt unknown, result null, zero selections", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      const gate = fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 });
      expect(gate.granted).toBe(true);
      const finished = fx.service.finishActionExecution(
        fx.runId,
        { outcome: "unknown" },
        { now: T0 + 6 },
      );
      expect(finished.applied).toBe(true);

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("failed");
      expect(item.selectedRun?.result).toBeNull();
      expect(item.selectedRun?.receipt?.outcome).toBe("unknown");
      expect(item.selectedRun?.executionStatus).toBe("unknown");
      expect(approvalSelectionRows(fx, item.turnId)).toBe(0);
    } finally {
      fx.close();
    }
  });

  it("pre-marker cancel: run cancelled with failed receipt, zero selections", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      const cancelled = fx.service.cancelActionRun(
        fx.sessionId,
        fx.runId,
        T0 + 5,
      );
      expect(cancelled.applied).toBe(true);
      expect(cancelled.runStatus).toBe("cancelled");

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("cancelled");
      expect(item.selectedRun?.result).toBeNull();
      expect(item.selectedRun?.receipt?.outcome).toBe("failed");
      expect(approvalSelectionRows(fx, item.turnId)).toBe(0);
    } finally {
      fx.close();
    }
  });

  it("recovered abandoned pre-marker: receipt failed, result null, zero selections", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      const summary = fx.service.validateAndRecoverActionRuns(
        "restart_recovery",
        T0 + 5,
      );
      expect(summary.recoveredPreMarker).toBe(1);

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("abandoned");
      expect(item.selectedRun?.result).toBeNull();
      expect(item.selectedRun?.receipt?.outcome).toBe("failed");
      expect(item.selectedRun?.executionStatus).toBe("failed");
      expect(approvalSelectionRows(fx, item.turnId)).toBe(0);
    } finally {
      fx.close();
    }
  });

  it("recovered abandoned post-marker: receipt unknown, result null", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(
        fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 }).granted,
      ).toBe(true);
      const summary = fx.service.validateAndRecoverActionRuns("drain", T0 + 6);
      expect(summary.recoveredPostMarker).toBe(1);

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("abandoned");
      expect(item.selectedRun?.result).toBeNull();
      expect(item.selectedRun?.receipt?.outcome).toBe("unknown");
      expect(approvalSelectionRows(fx, item.turnId)).toBe(0);
    } finally {
      fx.close();
    }
  });

  it("regular failed user_text turn stays unselected with no result", async () => {
    const fx = await makeApprovedFixture();
    try {
      const sessionId = fx.repo.createSession({ key: randomUUID(), now: T0 })
        .body.sessionId;
      const posted = fx.repo.postMessage(
        sessionId,
        { text: "plain question" },
        { key: randomUUID(), now: T0 },
      ).body;
      await fx.repo.startRun(posted.run.id, { now: T0 + 1 });
      fx.repo.failRun(posted.run.id, "execution_failed", { now: T0 + 2 });
      const items = fx.repo.getHistory(sessionId, { limit: 10 }).items;
      expect(items[0]?.kind).toBe("user_text");
      expect(items[0]?.selectedRun).toBeNull();
    } finally {
      fx.close();
    }
  });
});

describe("T6 completed Action results carry ID-free text with the fresh citation", () => {
  it("blocked_stale: completed with ID-free result and one selection", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      const blocked = fx.service.recordActionPreflightBlocked(fx.runId, {
        reason: "stale",
        preflightRevision: "src@2",
        now: T0 + 5,
      });
      expect(blocked.applied).toBe(true);

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("completed");
      expect(item.selectedRun?.receipt?.outcome).toBe("blocked_stale");
      const text = visibleTextOf(item.selectedRun?.result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("calendar.reschedule");
      expect(text).not.toContain(fx.proposalId);
      expect(text).not.toContain(fx.executionId);
      expect(text).not.toContain(fx.runId);
      expect(approvalSelectionRows(fx, item.turnId)).toBe(1);
    } finally {
      fx.close();
    }
  });

  it("succeeded_unverified: completed with ID-free result and one selection", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(
        fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 }).granted,
      ).toBe(true);
      const finished = fx.service.finishActionExecution(
        fx.runId,
        { outcome: "succeeded_unverified" },
        { now: T0 + 6 },
      );
      expect(finished.applied).toBe(true);

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("completed");
      expect(item.selectedRun?.receipt?.outcome).toBe("succeeded_unverified");
      const text = visibleTextOf(item.selectedRun?.result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("calendar.reschedule");
      expect(text).not.toContain(fx.proposalId);
      expect(text).not.toContain(fx.executionId);
      expect(text).not.toContain(fx.runId);
      expect(approvalSelectionRows(fx, item.turnId)).toBe(1);
    } finally {
      fx.close();
    }
  });

  it("verified succeeded: ID-free V2 text citing the ACTUAL fresh rN", async () => {
    const fx = await makeApprovedFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(
        fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 }).granted,
      ).toBe(true);
      const finished = fx.service.finishActionExecution(
        fx.runId,
        {
          outcome: "succeeded",
          observation: {
            connectorInstanceId: (
              fx.handle.raw
                .prepare(
                  "SELECT connector_instance_id AS id FROM resources LIMIT 1",
                )
                .get() as { id: string }
            ).id,
            resourceCanonicalKey: "cal|cal1|evt1",
            title: "Event",
            // Post-write body: a NEW revision carrying the intended
            // boundaries (never the staged snapshot bytes, so the fresh
            // materialization cannot collide with the based snapshot).
            text: calendarEventBodyText({
              canonicalKey: "cal|cal1|evt1",
              status: "confirmed",
              title: "Event",
              start: OPEN_RANGE.start,
              end: OPEN_RANGE.end,
              allDayEndExclusive: true,
              sourceRevision: "src@2",
              revisionBasis: "etag",
            } as const),
            sourceRevision: "src@2",
            eventStatus: "confirmed",
            observedAt: T0 + 6,
          },
          preflightRevision: "src@1",
          preflightSnapshotId: (
            fx.handle.raw
              .prepare("SELECT id FROM resource_snapshots LIMIT 1")
              .get() as { id: string }
          ).id,
        },
        { now: T0 + 7 },
      );
      expect(finished.applied).toBe(true);

      const item = approvalItem(fx);
      expect(item.selectedRun?.runStatus).toBe("completed");
      expect(item.selectedRun?.receipt?.outcome).toBe("succeeded");
      const result = item.selectedRun?.result as {
        version: number;
        text: string;
        answer?: { parts: Array<{ text: string; citations: string[] }> };
      } | null;
      expect(result?.version).toBe(2);
      expect(result?.text).not.toContain("calendar.reschedule");
      expect(result?.text).not.toContain(fx.proposalId);
      expect(result?.text).not.toContain(fx.executionId);
      expect(result?.text).not.toContain(fx.runId);
      const citations = result?.answer?.parts.flatMap((p) => p.citations) ?? [];
      expect(citations.length).toBe(1);
      expect(citations[0]).toMatch(/^r\d+$/);
      expect(approvalSelectionRows(fx, item.turnId)).toBe(1);
    } finally {
      fx.close();
    }
  });
});
