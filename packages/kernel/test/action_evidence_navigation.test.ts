// M5 action evidence navigation: the ORIGINAL-only BEFORE citation label
// (`targetCitation`) rides the server-owned execution view AND the action
// history projection, resolved from the proposal's OWN immutable
// `target_ref_id` plus session ownership — never from preview prose, never
// a new upstream read, never a rewritten receipt/hash.
//
// Real SQLite service lifecycle only (repository + concrete
// ActionExecutionService on the same connection): no mocked forwarding, no
// seeded history. Covers: pending proposals expose the original label with
// the hash untouched; live/failed/unknown/unverified/blocked terminals keep
// the original label with no fabricated AFTER result citation; verified
// succeeded keeps the original label AND cites a physically distinct fresh
// rN; wrong-session reads fail closed with no citation info; ordinary
// `user_text` history carries no such field at all.

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

interface EvidenceFixture {
  handle: ReturnType<typeof openKernelDatabase>;
  repo: ReturnType<typeof createKernelRepository>;
  service: ReturnType<typeof createActionExecutionService>;
  sessionId: string;
  proposalId: string;
  proposalHash: string;
  runId: string;
  executionId: string;
  close: () => void;
}

async function makeEvidenceFixture(): Promise<EvidenceFixture> {
  const dir = mkdtempSync(join(tmpdir(), "action-evidence-nav-"));
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
    proposalHash: staged.hash,
    runId: approved.body.runId,
    executionId: approved.body.executionId,
    close,
  };
}

interface ApprovalSelection {
  runId: string;
  runStatus: string;
  finishedAt: number | null;
  result: unknown;
  receipt: { outcome: string; summary: { summary: string } } | null;
  executionStatus: string | null;
  targetCitation?: unknown;
}

function approvalSelection(fx: EvidenceFixture): ApprovalSelection | null {
  const items = fx.repo.getHistory(fx.sessionId, { limit: 10 }).items;
  const item = items.find((i) => i.kind === "action_approval") as
    | { kind: "action_approval"; selectedRun: ApprovalSelection | null }
    | undefined;
  if (item === undefined) {
    throw new Error("expected an action_approval history item");
  }
  return item.selectedRun;
}

function driveVerifiedSucceeded(fx: EvidenceFixture): void {
  expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
    true,
  );
  expect(fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 }).granted).toBe(
    true,
  );
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
        fx.handle.raw.prepare("SELECT id FROM resource_snapshots LIMIT 1").get() as {
          id: string;
        }
      ).id,
    },
    { now: T0 + 7 },
  );
  expect(finished.applied).toBe(true);
}

describe("action evidence navigation (original BEFORE label)", () => {
  it("execution view exposes the original rN with the proposal hash untouched", async () => {
    const fx = await makeEvidenceFixture();
    try {
      const view = fx.repo.getProposalExecution(fx.sessionId, fx.proposalId);
      expect(view.proposalStatus).toBe("approved");
      expect(view.runId).toBe(fx.runId);
      expect(view.receipt).toBeNull();
      // ORIGINAL-only BEFORE label from the owned immutable target.
      expect(view.targetCitation).toBe("r1");
      // No rewrite: the durable proposal hash is byte-identical.
      const listed = fx.repo.listProposals(fx.sessionId);
      expect(listed.proposals.find((p) => p.proposalId === fx.proposalId)?.hash).toBe(
        fx.proposalHash,
      );
    } finally {
      fx.close();
    }
  });

  it("live execution keeps the original label with no receipt and no result", async () => {
    const fx = await makeEvidenceFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      const view = fx.repo.getProposalExecution(fx.sessionId, fx.proposalId);
      expect(view.receipt).toBeNull();
      expect(view.targetCitation).toBe("r1");
      const selection = approvalSelection(fx);
      expect(selection).not.toBeNull();
      expect(selection?.receipt).toBeNull();
      expect(selection?.targetCitation).toBe("r1");
    } finally {
      fx.close();
    }
  });

  it("failed and unknown terminals keep the original label with a null result (no fabricated AFTER)", async () => {
    const fx = await makeEvidenceFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(
        fx.service.recordActionPreflightFailure(fx.runId, { now: T0 + 5 })
          .applied,
      ).toBe(true);
      const failed = approvalSelection(fx);
      expect(failed?.receipt?.outcome).toBe("failed");
      expect(failed?.result).toBeNull();
      expect(failed?.targetCitation).toBe("r1");
      expect(
        fx.repo.getProposalExecution(fx.sessionId, fx.proposalId)
          .targetCitation,
      ).toBe("r1");
    } finally {
      fx.close();
    }
  });

  it("unknown terminal keeps the original label with a null result", async () => {
    const fx = await makeEvidenceFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 }).granted).toBe(
        true,
      );
      expect(
        fx.service.finishActionExecution(
          fx.runId,
          { outcome: "unknown" },
          { now: T0 + 6 },
        ).applied,
      ).toBe(true);
      const selection = approvalSelection(fx);
      expect(selection?.receipt?.outcome).toBe("unknown");
      expect(selection?.result).toBeNull();
      expect(selection?.targetCitation).toBe("r1");
    } finally {
      fx.close();
    }
  });

  it("unverified and blocked terminals carry citation-less results plus the original label", async () => {
    const fx = await makeEvidenceFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(fx.service.consumeActionGrant(fx.runId, { now: T0 + 5 }).granted).toBe(
        true,
      );
      expect(
        fx.service.finishActionExecution(
          fx.runId,
          { outcome: "succeeded_unverified" },
          { now: T0 + 6 },
        ).applied,
      ).toBe(true);
      const selection = approvalSelection(fx);
      expect(selection?.receipt?.outcome).toBe("succeeded_unverified");
      // V1 results carry no citations by construction: no verifiable AFTER.
      expect((selection?.result as { version?: unknown } | null)?.version).toBe(
        1,
      );
      expect(selection?.targetCitation).toBe("r1");
    } finally {
      fx.close();
    }
  });

  it("blocked_stale terminal carries a citation-less result plus the original label", async () => {
    const fx = await makeEvidenceFixture();
    try {
      expect(fx.service.startActionRun(fx.runId, { now: T0 + 4 }).applied).toBe(
        true,
      );
      expect(
        fx.service.recordActionPreflightBlocked(fx.runId, {
          reason: "stale",
          preflightRevision: "src@2",
          now: T0 + 5,
        }).applied,
      ).toBe(true);
      const selection = approvalSelection(fx);
      expect(selection?.receipt?.outcome).toBe("blocked_stale");
      expect((selection?.result as { version?: unknown } | null)?.version).toBe(
        1,
      );
      expect(selection?.targetCitation).toBe("r1");
    } finally {
      fx.close();
    }
  });

  it("verified succeeded keeps the distinct original BEFORE and fresh AFTER labels", async () => {
    const fx = await makeEvidenceFixture();
    try {
      driveVerifiedSucceeded(fx);
      const selection = approvalSelection(fx);
      expect(selection?.receipt?.outcome).toBe("succeeded");
      // ORIGINAL BEFORE label is preserved untouched.
      expect(selection?.targetCitation).toBe("r1");
      // The verified AFTER is a physically distinct fresh rN from the
      // authoritative read-back — never the staged original.
      const result = selection?.result as {
        version: number;
        answer?: { parts: Array<{ text: string; citations: string[] }> };
      } | null;
      expect(result?.version).toBe(2);
      const after =
        result?.answer?.parts.flatMap((p) => p.citations) ?? [];
      expect(after.length).toBe(1);
      expect(after[0]).toMatch(/^r[1-9][0-9]*$/);
      expect(after[0]).not.toBe("r1");
      expect(after[0]).not.toBe(selection?.targetCitation);
      const view = fx.repo.getProposalExecution(fx.sessionId, fx.proposalId);
      expect(view.targetCitation).toBe("r1");
      expect(view.receipt?.outcome).toBe("succeeded");
    } finally {
      fx.close();
    }
  });

  it("wrong-session execution read fails closed with no citation info", async () => {
    const fx = await makeEvidenceFixture();
    try {
      const other = fx.repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      let message = "";
      try {
        fx.repo.getProposalExecution(other, fx.proposalId);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/r[1-9][0-9]*/);
      expect(message).not.toContain(fx.sessionId);
    } finally {
      fx.close();
    }
  });

  it("ordinary user_text history carries no evidence label field at all", async () => {
    const fx = await makeEvidenceFixture();
    try {
      const sessionId = fx.repo.createSession({ key: randomUUID(), now: T0 })
        .body.sessionId;
      const posted = fx.repo.postMessage(
        sessionId,
        { text: "plain question" },
        { key: randomUUID(), now: T0 },
      ).body;
      await fx.repo.startRun(posted.run.id, { now: T0 + 1 });
      fx.repo.completeRun(
        posted.run.id,
        { version: 1, text: "plain answer" },
        { now: T0 + 2 },
      );
      const items = fx.repo.getHistory(sessionId, { limit: 10 }).items;
      expect(items[0]?.kind).toBe("user_text");
      const selected = (
        items[0] as unknown as { selectedRun: Record<string, unknown> | null }
      ).selectedRun;
      expect(selected).not.toBeNull();
      // Discriminated shape: the field is omitted, never a null shim.
      expect("targetCitation" in (selected as Record<string, unknown>)).toBe(
        false,
      );
    } finally {
      fx.close();
    }
  });
});
