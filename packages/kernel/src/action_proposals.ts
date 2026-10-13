// C17 first half: in-memory calendar.reschedule proposal stager + exact
// transaction commit hook (§18, migration 0007 action_proposals).
//
// Design (C17 step 1 — service only, no broker/agent wiring yet):
//
// - `createActionProposalStager(...)` owns an in-memory
//   `Map<runId, staged proposal>` of immutable staged content. At most ONE
//   proposal may be staged per Agent Run at a time (MAX 1 perRun); stager
//   entries expire after PROPOSAL_TTL_MS (15 minutes, stager clock) and are
//   pruned lazily.
//
// - `stage()` performs ALL concrete failure-closed prechecks against the
//   exact C16 SQL columns: a running Agent Run, its session target bound EXACTLY
//   to a session reference of kind calendar with matching connector/resource/
//   snapshot, a fresh snapshot whose normalized event status is not `deleted`,
//   and a start<end temporal range that preserves timed/all-day semantics
//   (both date-only OR both full instants; class mixing is rejected). The
//   exact instant/range grammar stays in the connector port as in search.
//
// - Staged content is hashed with the existing canonical helpers
//   (`canonicalJsonString` + `sha256Hex`) over the EXACT immutable content
//   (tool, input, target triple, expectedRevision, preview). The deterministic
//   preview is a start/end-only summary line; provider ids never appear in
//   any staged preview returned or persisted.
//
// - `commitStaged(runId, now)` is public but ONLY safely callable inside the
//   repository's own `completeRun` transaction. It revalidates the target
//   relation (exact reference/connector/resource/snapshot and expected
//   revision), the one-pending-proposal-per-session rule, run liveness and
//   expiry, then inserts the action_proposals row and emits the
//   `action.proposed` event through the repository event callback supplied at
//   construction (same signature as the repository `appendEventInTx`
//   helper). The stager never opens its own transaction and is never its own
//   terminal state: any failure throws before/without completing the caller's
//   transaction, so a rollback leaves NO persisted proposal. commitStaged
//   never consumes the staged entry: the repository acknowledges it (via
//   removeStaged) only AFTER the outer transaction commits, so a rollback
//   preserves the stage and a committed completion clears it.
//   `removeStaged()` also discards staged content for failed/cancelled runs.
//
// - `writeEnabled` defaults to FALSE and must be explicitly opted in via
//   repository construction wiring; the stager refuses to stage or commit
//   otherwise.

import type { CalendarRescheduleToolInput } from "@companion/contracts";
import {
  ActionProposedPayloadSchema,
  CALENDAR_RESCHEDULE_TOOL_NAME,
  CalendarRescheduleToolInputSchema,
  PROPOSAL_TTL_MS,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import type { z } from "zod";

/** Payload type mirroring the C16 strictObject schema (contracts export). */
type ActionProposedPayload = z.infer<typeof ActionProposedPayloadSchema>;

import { canonicalJsonString, generateId, sha256Hex } from "./canonical.js";
import {
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";

/**
 * Narrow repository event callback interface supplied at construction.
 * Signature mirrors the repository's private `appendEventInTx` helper
 * exactly: the caller must run it inside its OWN open transaction. Same
 * expected-previous-seq CAS semantics (conflict => concurrent conflict error,
 * caller rolls back and retries the whole transition).
 */
export interface ActionProposalEventSink {
  appendEventTx(
    runId: string,
    expectedPrevSeq: number,
    type: "action.proposed",
    payload: ActionProposedPayload,
    now: number,
  ): number;
}

export interface ActionProposalStagerOptions {
  /** Raw better-sqlite3 handle (same repository database). */
  db: Database.Database;
  /** Default FALSE: staging/commits are refused unless explicitly true. */
  writeEnabled?: boolean;
  /** Deterministic clock; defaults to Date.now(). */
  clock?: () => number;
  /** Required repository event callback (above). */
  events: ActionProposalEventSink;
}

/** Safe staged-proposal preview: never carries provider ids. */
export interface StagedProposedContent {
  runId: string;
  sessionId: string;
  sourceTurnId: string;
  tool: typeof CALENDAR_RESCHEDULE_TOOL_NAME;
  input: CalendarRescheduleToolInput;
  targetRefId: string;
  targetResourceId: string;
  basedOnSnapshotId: string;
  connectorInstanceId: string;
  expectedRevision: string;
  preview: { summary: string };
  hash: string;
  createdAt: number;
  expiresAt: number;
}

export interface CommittedProposal extends StagedProposedContent {
  proposalId: string;
  status: "pending";
  eventSeq: number;
}

export interface ActionProposalStager {
  /** Concrete staging (interfaces above); throws RepositoryValidationError. */
  stage(
    runId: string,
    input: { targetRefId: string; start: string; end: string },
  ): StagedProposedContent;
  /** Current staged content for `runId` (pruned when expired), or null. */
  getStaged(runId: string): StagedProposedContent | null;
  /** Discard staged content (failed/cancelled runs). Idempotent. */
  removeStaged(runId: string): boolean;
  /**
   * COMMIT HOOK: call ONLY from within the repository `completeRun`
   * transaction. Revalidates and inserts the row + event; any failure throws
   * in the caller's transaction and a rollback persists nothing.
   *
   * C17 lifecycle fix: commitStaged does NOT consume the staged entry. The
   * in-memory entry is acknowledged (removed) by the CALLER only after the
   * OUTER transaction commits successfully, so a rollback preserves the
   * stage for a retry and a committed completion clears it exactly once.
   */
  commitStaged(runId: string, now: number): CommittedProposal;
}

interface TargetRow {
  readonly refId: string;
  readonly resourceId: string;
  readonly snapshotId: string;
  readonly connectorInstanceId: string;
  readonly kind: string;
  readonly sourceRevision: string | null;
  readonly contentHash: string;
  readonly bodyJson: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}(?![T\s+/])/;

/** Classify a proposed boundary string: all-day (`date`) or timed (`instant`). */
function boundaryClass(value: string): "date" | "instant" {
  if (DATE_ONLY_RE.test(value)) {
    return "date";
  }
  return "instant";
}

/** Parse a boundary into comparable ms. All-day: local midnight semantics. */
function parseBoundaryMs(value: string, kind: "date" | "instant"): number {
  // Date-only strings keep whole-day semantics: compare as UTC midnight.
  const ms =
    kind === "date" ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RepositoryValidationError(
      "start/end must be a valid instant or date-only range boundary",
    );
  }
  return ms;
}

/**
 * Temporal range check preserving timed/all-day semantics: boundaries must be
 * the same class (both date-only = all-day, or both full instants = timed);
 * mixing a date-only with an instant boundary is invalid. start < end.
 */
function validateRange(start: string, end: string): void {
  const startClass = boundaryClass(start);
  const endClass = boundaryClass(end);
  if (startClass !== endClass) {
    throw new RepositoryValidationError(
      "start/end boundary classes must match (both date-only (all-day) or both instants (timed))",
    );
  }
  const startMs = parseBoundaryMs(start, startClass);
  const endMs = parseBoundaryMs(end, endClass);
  if (endMs <= startMs) {
    throw new RepositoryValidationError("start must be before end");
  }
}

function loadTarget(
  db: Database.Database,
  sessionId: string,
  targetRefId: string,
): TargetRow {
  const row = db
    .prepare(
      `SELECT sr.id AS ref_id, sr.resource_id, sr.snapshot_id,
              r.connector_instance_id, ci.kind,
              rs.source_revision, rs.content_hash, rs.body_json
       FROM session_references sr
       JOIN resources r ON r.id = sr.resource_id
       JOIN connector_instances ci ON ci.id = r.connector_instance_id
       JOIN resource_snapshots rs ON rs.id = sr.snapshot_id
       WHERE sr.session_id = ? AND sr.id = ?`,
    )
    .get(sessionId, targetRefId) as
    | {
        ref_id: string;
        resource_id: string;
        snapshot_id: string;
        connector_instance_id: string;
        kind: string;
        source_revision: string | null;
        content_hash: string;
        body_json: string;
      }
    | undefined;
  if (row === undefined) {
    throw new RepositoryValidationError(
      "target must be an exact Calendar session reference of this run's session",
    );
  }
  return {
    refId: row.ref_id,
    resourceId: row.resource_id,
    snapshotId: row.snapshot_id,
    connectorInstanceId: row.connector_instance_id,
    kind: row.kind,
    sourceRevision: row.source_revision,
    contentHash: row.content_hash,
    bodyJson: row.body_json,
  };
}

function freshSnapshotRevision(target: TargetRow): {
  expected: string;
  eventStatus: string;
} | null {
  let body: unknown;
  try {
    body = JSON.parse(target.bodyJson) as unknown;
  } catch {
    throw new RepositoryValidationError(
      "target snapshot body is not valid normalized JSON",
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("status" in body) ||
    typeof (body as { status: unknown }).status !== "string"
  ) {
    throw new RepositoryValidationError(
      "target snapshot body is not a normalized Calendar event",
    );
  }
  const eventStatus = (body as { status: string }).status;
  // Fresh snapshot: a deleted event snapshot can never back a reschedule.
  if (eventStatus === "deleted") {
    return null;
  }
  // Source revision key: source_revision when present else content hash.
  return {
    expected: target.sourceRevision ?? target.contentHash,
    eventStatus,
  };
}

export function createActionProposalStager(
  options: ActionProposalStagerOptions,
): ActionProposalStager {
  const { db, events } = options;
  const writeEnabled = options.writeEnabled === true;
  const clock = options.clock ?? (() => Date.now());
  /** Immutable staged proposals; at most one per run. */
  const staged = new Map<string, StagedProposedContent>();

  function requireWriteEnabled(): void {
    if (!writeEnabled) {
      throw new RepositoryValidationError(
        "action proposal staging requires explicit writeEnabled",
      );
    }
  }

  function loadRun(runId: string): {
    id: string;
    sessionId: string;
    turnId: string;
    status: string;
    eventSeq: number;
  } {
    const row = db
      .prepare(
        "SELECT id, session_id, turn_id, status, event_seq FROM runs WHERE id = ?",
      )
      .get(runId) as
      | {
          id: string;
          session_id: string;
          turn_id: string;
          status: string;
          event_seq: number;
        }
      | undefined;
    if (row === undefined) {
      throw new RepositoryNotFoundError(`run ${runId} not found`);
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      status: row.status,
      eventSeq: row.event_seq,
    };
  }

  function pruneExpired(now: number): void {
    for (const [key, value] of staged) {
      if (now >= value.expiresAt) {
        staged.delete(key);
      }
    }
  }

  const stager: ActionProposalStager = {
    stage(runId, input) {
      requireWriteEnabled();
      const now = clock();
      pruneExpired(now);
      const parsed = CalendarRescheduleToolInputSchema.parse({
        start: str(input.start),
        end: str(input.end),
      });
      const targetRefId = validateTargetRefId(input.targetRefId);
      validateRange(parsed.start, parsed.end);
      const run = loadRun(runId);
      if (run.status !== "running") {
        throw new RepositoryValidationError(
          "action proposal can only be staged on a running run",
        );
      }
      if (staged.has(runId)) {
        throw new RepositoryValidationError(
          "at most one proposal may be staged per run",
        );
      }
      const target = loadTarget(db, run.sessionId, targetRefId);
      if (target.kind !== "calendar") {
        throw new RepositoryValidationError(
          "action proposal target must be a Calendar connector resource",
        );
      }
      const fresh = freshSnapshotRevision(target);
      if (fresh === null) {
        throw new RepositoryValidationError(
          "target snapshot event is deleted; staging requires a fresh snapshot",
        );
      }
      // Deterministic start/end-only preview (no provider ids, no content).
      const preview = {
        summary: `${CALENDAR_RESCHEDULE_TOOL_NAME}: start=${parsed.start} end=${parsed.end}`,
      };
      const expectedRevision = fresh.expected;
      // Exact immutable content hash via the canonical helpers.
      const hash = sha256Hex(
        canonicalJsonString({
          tool: CALENDAR_RESCHEDULE_TOOL_NAME,
          input: { start: parsed.start, end: parsed.end },
          target: {
            refId: target.refId,
            resourceId: target.resourceId,
            snapshotId: target.snapshotId,
          },
          expectedRevision,
          preview,
        }),
      );
      const entry: StagedProposedContent = {
        runId,
        sessionId: run.sessionId,
        sourceTurnId: run.turnId,
        tool: CALENDAR_RESCHEDULE_TOOL_NAME,
        input: { start: parsed.start, end: parsed.end },
        targetRefId: target.refId,
        targetResourceId: target.resourceId,
        basedOnSnapshotId: target.snapshotId,
        connectorInstanceId: target.connectorInstanceId,
        expectedRevision,
        preview,
        hash,
        createdAt: now,
        expiresAt: now + PROPOSAL_TTL_MS,
      };
      staged.set(runId, entry);
      return { ...entry, input: { ...entry.input } };
    },

    getStaged(runId) {
      const entry = staged.get(runId);
      const now = clock();
      if (entry === undefined) {
        return null;
      }
      if (now >= entry.expiresAt) {
        staged.delete(runId);
        return null;
      }
      return { ...entry, input: { ...entry.input } };
    },

    removeStaged(runId) {
      return staged.delete(runId);
    },

    // ---------------------------------------------------------------------------
    // COMMIT HOOK. Must be invoked from the caller's open transaction only;
    // never commits on its own. Any throw must be handled by the caller's
    // rollback so NO proposal row / event survives.
    commitStaged(runId, now) {
      requireWriteEnabled();
      const entry = staged.get(runId);
      if (entry === undefined) {
        throw new RepositoryNotFoundError(
          `no staged proposal for run ${runId}`,
        );
      }
      if (now >= entry.expiresAt) {
        staged.delete(runId);
        throw new RepositoryValidationError("staged proposal expired");
      }
      // Revalidate run liveness (non-terminal running inside the caller tx).
      const run = loadRun(runId);
      if (run.status !== "running") {
        throw new RepositoryValidationError(
          "action proposal commit requires a still-running run",
        );
      }
      if (
        run.sessionId !== entry.sessionId ||
        run.turnId !== entry.sourceTurnId
      ) {
        throw new RepositoryValidationError(
          "staged provenance no longer matches the run",
        );
      }
      // Revalidate target relation exactly (reference/connector/resource/
      // snapshot triple + expected source revision).
      const target = loadTarget(db, run.sessionId, entry.targetRefId);
      if (
        target.refId !== entry.targetRefId ||
        target.resourceId !== entry.targetResourceId ||
        target.snapshotId !== entry.basedOnSnapshotId ||
        target.connectorInstanceId !== entry.connectorInstanceId ||
        target.kind !== "calendar" ||
        (target.sourceRevision ?? target.contentHash) !== entry.expectedRevision
      ) {
        throw new RepositoryValidationError(
          "target relation changed since staging",
        );
      }
      if (freshSnapshotRevision(target) === null) {
        throw new RepositoryValidationError(
          "target snapshot event is deleted; commit requires a fresh snapshot",
        );
      }
      // Revalidate one pending proposal per session (within the caller tx so a
      // concurrent commit cannot slip between the check and the insert).
      const pending = db
        .prepare(
          "SELECT id FROM action_proposals WHERE session_id = ? AND status = 'pending'",
        )
        .get(run.sessionId) as { id: string } | undefined;
      if (pending !== undefined) {
        throw new RepositoryValidationError(
          "at most one pending proposal per session",
        );
      }
      const proposalId = generateId();
      db.prepare(
        `INSERT INTO action_proposals (
           id, session_id, source_turn_id, source_run_id, decision_turn_id,
           tool, connector_instance_id, input_json, target_ref_id,
           target_resource_id, based_on_snapshot_id, expected_revision,
           preview_json, hash, status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        proposalId,
        entry.sessionId,
        entry.sourceTurnId,
        runId,
        entry.tool,
        entry.connectorInstanceId,
        canonicalJsonString(entry.input),
        entry.targetRefId,
        entry.targetResourceId,
        entry.basedOnSnapshotId,
        entry.expectedRevision,
        canonicalJsonString(entry.preview),
        entry.hash,
        entry.createdAt,
        entry.expiresAt,
      );
      // Exact §18.8 origin: action.proposed belongs to the originating Agent
      // Run (pre-terminal). Same CAS semantics as repository appends.
      const payload = ActionProposedPayloadSchema.parse({
        proposalId,
        proposalHash: entry.hash,
        tool: entry.tool,
      });
      const eventSeq = events.appendEventTx(
        runId,
        run.eventSeq,
        "action.proposed",
        payload,
        now,
      );
      // ROLLBACK-SAFE LIFECYCLE (C17): the entry stays staged here. The
      // repository caller acknowledges (removeStaged) ONLY after the outer
      // transaction commits, so:
      // - a rollback of completeRun preserves the stage for a retry, and
      // - a committed completion clears it before any new stage().
      // Double-commit inside one tx is still blocked by the exact
      // one-pending-proposal-per-session recheck above (within the same
      // caller transaction, the pending insert is visible to the check).
      return {
        ...entry,
        input: { ...entry.input },
        proposalId,
        status: "pending",
        eventSeq,
      };
    },
  };
  return stager;
}

// Small helpers: opaque structural strings (targetRefId) are validated for
// non-empty shape only; exact UUID ownership is proven by the target SQL join.
function validateTargetRefId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new RepositoryValidationError(
      "targetRefId must be a non-empty reference id",
    );
  }
  return value;
}

function str(value: unknown): string {
  if (typeof value !== "string") {
    throw new RepositoryValidationError(
      "start/end must be strings (calendar.reschedule input)",
    );
  }
  return value;
}

// C17 second half: proposal-only `calendar.reschedule` ToolBroker
// registration (broker + agent advertisement wiring).
//
/**
 * PROPOSAL-ONLY registration (§18.1, C17): `calendar.reschedule` is a
 * `write`-category tool whose sole model-reachable behavior STAGES a
 * proposal. No external write, OAuth flow, adoption or provider API call
 * ever happens here and dedicated Action execution stays unavailable.
 *
 * - Allowed ONLY from the normal agent origin (`AGENT_TOOL_ORIGIN`): any
 *   other origin is denied with the fixed `tool_denied` code.
 * - The stager is the single MAX-1-per-run cap and charges its budget
 *   through the ordinary broker pipeline (budget_reserve first); a second
 *   staged (or already-pending) proposal fails with the fixed
 *   `action_preflight_failed` code. No raw validation text is returned to
 *   the model.
 * - The model-facing output is the deterministic, provider-id-free staged
 *   shape `{ staged: true, start, end }`; the model can never spoof or
 *   approve: no approve/reject tool exists for it, and the staged candidate
 *   is committed only by the repository's own terminal CAS transaction.
 * - Dedup is `always_bypass` on purpose: a repeat request re-enters the
 *   handler and surfaces the concrete MAX-1 staging rejection instead of
 *   silently reusing the first staged preview.
 */
import { AGENT_TOOL_ORIGIN } from "./agent.js";
import {
  ToolError,
  type ToolHandlerContext,
  type ToolRegistration,
  type ToolSchema,
} from "./broker.js";

/**
 * Build the proposal-only `calendar.reschedule` registration, FAIL CLOSED
 * against a non-enabled stager: without explicit `writeEnabled` the
 * descriptor can never be registered half-enabled (the factory asks the
 * stager to enforce its own gate, and any later staging still rechecks it).
 * The stager must be the caller's single shared instance (owned by the
 * repository composition), never a per-call copy, so the MAX-1-per-run cap
 * and the commit hook address the exact same staged entry.
 */
export function createCalendarRescheduleProposalRegistration(options: {
  stager: ActionProposalStager;
}): ToolRegistration {
  const { stager } = options;
  return {
    descriptor: {
      name: CALENDAR_RESCHEDULE_TOOL_NAME,
      version: 1,
      title: "Propose calendar event reschedule",
      description:
        "Propose (stage, never execute) a start/end-only reschedule of an already-found Calendar event; approval happens outside the model",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: CalendarRescheduleAgentInputSchema,
    outputSchema: CalendarRescheduleAgentOutputSchema,
    dedupMode: "always_bypass",
    proposalOnly: true,
    handler: (async (
      input: CalendarRescheduleAgentInput,
      ctx: ToolHandlerContext,
    ) => {
      // Proposal-only from the normal agent origin; nothing else stages.
      if (ctx.origin !== AGENT_TOOL_ORIGIN) {
        throw new ToolError("tool_denied");
      }
      try {
        stager.stage(ctx.runId, {
          targetRefId: input.referenceId,
          start: input.start,
          end: input.end,
        });
      } catch (error) {
        if (error instanceof ToolError) {
          throw error;
        }
        // Raw validation text never reaches the model: fixed code only.
        throw new ToolError("action_preflight_failed");
      }
      return { staged: true, start: input.start, end: input.end };
    }) as ToolRegistration["handler"],
    // Deterministic identity output: no ids, no content, no mutable status.
    normalize: (raw) => ({
      normalized: raw,
      observations: 0,
      modelFacing: raw,
    }),
  };
}

/** Closed agent input shape: rN-translated referenceId + start/end only. */
export interface CalendarRescheduleAgentInput {
  referenceId: string;
  start: string;
  end: string;
}

/** Closed agent output shape: staged marker + exact start/end echoes. */
export interface CalendarRescheduleAgentOutput {
  staged: true;
  start: string;
  end: string;
}

const CalendarRescheduleAgentInputSchema: ToolSchema<CalendarRescheduleAgentInput> =
  {
    parse(data: unknown): CalendarRescheduleAgentInput {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("calendar.reschedule input must be an object");
      }
      const record = data as Record<string, unknown>;
      const allowed = new Set(["referenceId", "start", "end"]);
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          throw new Error("unknown calendar.reschedule input field");
        }
      }
      const sp = (value: unknown, what: string): string => {
        if (
          typeof value !== "string" ||
          value.length < 1 ||
          value.length > 128
        ) {
          throw new Error(`${what} must be a 1..128 character string`);
        }
        return value;
      };
      return {
        referenceId: sp(record.referenceId, "referenceId"),
        start: sp(record.start, "start"),
        end: sp(record.end, "end"),
      };
    },
  };

const CalendarRescheduleAgentOutputSchema: ToolSchema<CalendarRescheduleAgentOutput> =
  {
    parse(data: unknown): CalendarRescheduleAgentOutput {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("calendar.reschedule output must be an object");
      }
      const record = data as Record<string, unknown>;
      if (record.staged !== true) {
        throw new Error("calendar.reschedule output must be a staged marker");
      }
      const echo = (value: unknown, what: string): string => {
        if (
          typeof value !== "string" ||
          value.length < 1 ||
          value.length > 128
        ) {
          throw new Error(`staged ${what} echo invalid`);
        }
        return value;
      };
      return {
        staged: true,
        start: echo(record.start, "start"),
        end: echo(record.end, "end"),
      };
    },
  };
