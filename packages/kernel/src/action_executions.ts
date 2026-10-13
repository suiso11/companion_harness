// C19 Action transactional boundaries (§18.5/§18.6, exact decisions from
// db8db5d): concrete kernel Action execution service around the committed
// M5 tables (migration 0007) — NO strategy, NO external write, NO model path.
//
// Exact boundaries implemented:
//
// - `startActionRun(...)` — ATOMIC PICKUP: a single BEGIN IMMEDIATE moves the
//   Action Run `queued -> running` AND the ActionExecution `queued ->
//   preflight` together, then appends `run.started` + `action.preflight_started`
//   on the same `runs.event_seq` chain in the same transaction (§18.5). The
//   impossible pair (queued Run without a queued execution) fails closed with
//   `database_state_invalid`. A queued execution + running Run can never exist
//   on valid data because both transitions share one transaction.
//
// - `runActionPreflight(...)` reads the AUTHORITATIVE observation through an
//   injected READ-ONLY port (called with NO open transaction; no write
//   binding is ever selected or consulted here). The port's normalized
//   trusted observation is validated against the closed §18.1 target binding
//   and then its SOURCE REVISION KEY (source_revision else content hash,
//   §18.3) is compared against the proposal `expectedRevision` BEFORE any
//   local fresh materialization (exact §18.5 agreed order). No local integer
//   `resource_snapshots.revision` is ever compared.
//
//   - Stale key mismatch or a `deleted` authoritative event: execution
//     `blocked_stale` + blocked_stale receipt + `action.preflight_blocked` +
//     `action.execution_finished` + Action Run `completed` — ZERO external
//     writes and ZERO snapshot materialization in one transaction. The
//     `blocked_stale` receipt's `preflight_snapshot_id` is the proposal's
//     immutable `based_on_snapshot_id` (zero write, so no fresh snapshot can
//     exist for a blocked outcome; the DDL requires a non-NULL snapshot id).
//   - Port read failure (`unavailable` / `timeout` / `schema_invalid`) or a
//     returned observation that fails closed validation: execution `failed`
//     (`action_preflight_failed`) + `failed` receipt + non-terminal
//     `action.preflight_failed` strictly BEFORE terminal `run.failed`, all in
//     one transaction, zero writes, no retry.
//   - Matching key: the trusted observation is materialized as a FRESH
//     Snapshot + new rN through the SAME database's existing ReferenceManager
//     (`presentObservations` with `freshness: 'refresh'`, §14.2) — the exact
//     existing reference model, not a new persistence path.
//
// - `consumeActionGrant(...)` — the ONE-SHOT gate: a single transaction that
//   verifies the EXACT grant provenance (execution id, proposal id,
//   proposalHash, tool, recomputed inputHash over the stored canonical
//   proposal input), requires Run `running` + execution `preflight` +
//   `external_call_started_at IS NULL`, CASes the grant consumption
//   (`consumed_at IS NULL`, at most once) AND the execution to `executing`
//   with the `external_call_started_at` marker AND appends
//   `action.execution_started`, then COMMITS. Return value is the exact
//   committed gate; the caller may only issue its external write AFTER a
//   committed `granted: true` (DB-commit-first, §18.6). NO external side
//   effect ever happens inside this (or any) service transaction. Any
//   provenance contradiction is an impossible state and fails closed with
//   `database_state_invalid` (whole transaction rolls back, nothing spent).
//
// - `finishActionExecution(runId, result, now)` — C20 EXECUTING -> TERMINAL
//   (§18.6 normal connector-return map + §18.7 read-back): exactly one
//   transaction commits the execution CAS + receipt + non-terminal
//   `action.execution_finished` + Action Run terminal + terminal RunEvent,
//   with the verified fresh result Snapshot/rN materialized INSIDE that same
//   outer transaction through the SAME-DB ReferenceManager (`onApplied`
//   same-transaction hook; never before the terminal transaction). Verified
//   `succeeded` only: receipt observed_revision + result_snapshot_id + an
//   exact RunResult citing the ACTUAL fresh rN. `succeeded_unverified` keeps
//   observed/result NULL (no verified claim); `definite_failure` -> fixed
//   safe `action_write_failed`; `unknown` -> run failed too. No retry.
//
// - DEFAULT DENY (§18.8): anything that is not the exact verified grant
//   triplet on a running, preflight-stage execution is denied with a precise
//   `granted: false` reason and zero writes. There is deliberately NO model
//   path, NO fake/noop strategy, and NO event-loop execution here: the
//   deterministic ActionStrategy (next slice C19-C20) integrates by calling
//   `startActionRun`, `runActionPreflight`, then the external write, and
//   later the separate terminal-facility APIs.

import type { RunResult, RunStatus } from "@companion/contracts";
import {
  buildRunResultV2,
  CalendarEventStatusSchema,
  CalendarRescheduleToolInputSchema,
  isTerminalStatus,
  parseRunResult,
  SourceRevisionSchema,
  UuidSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { z } from "zod";
import type {
  CalendarConnectorPort,
  CalendarGetPortResult,
  CalendarGetTarget,
  CalendarTargetStore,
} from "./calendar_tools.js";
import { toCalendarObservation } from "./calendar_tools.js";
import { canonicalJsonString, sha256Hex } from "./canonical.js";
import {
  ActionNotCancellableError,
  DatabaseStateInvalidError,
  KernelStorageError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import type { ReferenceManager } from "./reference_manager.js";
import { appendEventInTx, withImmediate } from "./repository.js";

/* ------------------------------------------------------------------ */
/* Authoritative observation port (read-only, injected)                 */
/* ------------------------------------------------------------------ */

/**
 * One AUTHORITATIVE normalized Calendar observation delivered by the
 * injected read-only port. Trusted content: the connector owns provider
 * normalization; the kernel owns hashing (NFC text -> content hash) and the
 * source revision key derivation (`sourceRevision` else content hash).
 */
export const ActionAuthoritativeObservationSchema = z.strictObject({
  connectorInstanceId: UuidSchema,
  /** Exact canonical key of the proposal target resource (no provider ids). */
  resourceCanonicalKey: z.string().min(1).max(512),
  /** Normalized display title (NFC, trimmed) or none. */
  title: z.string().max(128).nullable(),
  /**
   * Normalized event body text; the kernel NFC-normalizes before hashing so
   * the derived key matches exactly what a fresh materialization stores.
   */
  text: z.string().max(1_048_576),
  /** Opaque upstream revision signal (NULL = content-hash fallback). */
  sourceRevision: SourceRevisionSchema.nullable(),
  /** Exact normalized 4-value event status (§17.4); `deleted` blocks. */
  eventStatus: CalendarEventStatusSchema,
  /** Authority read clock (ms). */
  observedAt: z.number().int().min(0),
});
export type ActionAuthoritativeObservation = z.infer<
  typeof ActionAuthoritativeObservationSchema
>;

/**
 * Result of the preflight authoritative read. Failures are classified by
 * the port (never leaked raw); every class maps to the same atomic
 * preflight-failed terminal below.
 */
export type ActionPreflightRead =
  | { status: "ok"; observation: ActionAuthoritativeObservation }
  | { status: "unavailable" | "timeout" | "schema_invalid" };

/**
 * Read-only preflight port. `read` MUST be called with NO open transaction
 * (it is the only service step that touches the connector) and MUST NOT
 * perform any external write or OAuth/pin binding. Resolves with a trusted
 * normalized observation or a classified failure; rejecting is NOT a valid
 * result channel — the orchestrator classifies a rejection as a
 * `preflight_failed` terminal ONLY while the execution is still in the
 * unmarkered preflight stage (late observation writes nothing, §18.6).
 */
export interface ActionPreflightReadPort {
  read(
    request: {
      connectorInstanceId: string;
      targetResourceId: string;
      basedOnSnapshotId: string;
    },
    signal?: AbortSignal,
  ): Promise<ActionPreflightRead>;
}

export interface ActionExecutionServiceOptions {
  readonly db: Database.Database;
  /**
   * Existing ReferenceManager on the SAME database: fresh preflight
   * Snapshot / rN materialization uses its exact reference model. Optional
   * ONLY for boundaries that never materialize anything (the pre-marker
   * cancellation boundary); every materializing API requires it.
   */
  readonly referenceManager?: ReferenceManager;
  /** Deterministic clock; defaults to Date.now(). */
  readonly clock?: () => number;
  /** Required for `runActionPreflight`; the other APIs work without it. */
  readonly preflightRead?: ActionPreflightReadPort;
}

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

/**
 * C21 recovery/drain cause: startup restart recovery or a graceful drain.
 * The cause is only recorded on the recovery event payloads; the state
 * disposition is EXACTLY the same for both.
 */
export type ActionRecoveryCause = "restart_recovery" | "drain";

/**
 * Fixed safe code for a pre-marker action execution abandoned by
 * recovery/drain: the external write was NEVER issued (no committed
 * `external_call_started_at` marker), so nothing local may claim a result.
 */
const ACTION_RECOVERY_PRE_MARKER_ERROR_CODE =
  "action_recovery_abandoned_before_write";

/** Exact per-run outcome of `recoverAbandonedActionRun`. */
export type ActionRunRecoveryResult =
  | {
      applied: true;
      runStatus: "abandoned";
      executionStatus: "failed" | "unknown";
    }
  | { applied: false; runStatus: string };

/** Aggregate, fail-closed result of `validateAndRecoverActionRuns`. */
export interface ActionRecoverySummary {
  /** Pairs left exactly as found (queued pickup pairs + valid terminals). */
  unchanged: number;
  /** Running + unmarkered preflight pairs settled failed + abandoned. */
  recoveredPreMarker: number;
  /** Running + markered executing pairs settled unknown + abandoned. */
  recoveredPostMarker: number;
}

export type ActionPickupResult =
  | { applied: true; executionId: string }
  | { applied: false; reason: "run_not_queued"; status: string };

export type ActionPreflightTerminalBase =
  | { applied: true; executionId: string; eventSeq: number }
  | { applied: false; reason: "run_not_running" | "execution_not_preflight" };

export type ActionPreflightFailedTerminal =
  | (ActionPreflightTerminalBase & {
      applied: true;
      preflightRevision: null;
      preflightSnapshotId: null;
    })
  | { applied: false; reason: "run_not_running" | "execution_not_preflight" };

export type ActionPreflightBlockedTerminal =
  | (ActionPreflightTerminalBase & {
      applied: true;
      preflightRevision: string;
      preflightSnapshotId: string;
    })
  | { applied: false; reason: "run_not_running" | "execution_not_preflight" };

export type ActionPreflightMaterializeResult =
  | { applied: true; referenceId: string; snapshotId: string }
  | {
      applied: false;
      reason: "run_not_running" | "presentation_refused";
      status: string;
    };

export interface CommittedGrantMeta {
  executionId: string;
  proposalId: string;
  proposalHash: string;
  tool: "calendar.reschedule";
  inputHash: string;
  consumedAt: number;
}

/** The exact committed gate returned by `consumeActionGrant`. */
export type ActionGrantGate =
  | { granted: true; grant: CommittedGrantMeta }
  | {
      granted: false;
      reason:
        | "run_not_running"
        | "execution_not_preflight"
        | "grant_consumed"
        | "grant_missing"
        | "proposal_not_approved";
    };

/** Fixed safe redacted code for a connector `definite_failure` return. */
const ACTION_WRITE_FAILED_ERROR_CODE = "action_write_failed";

/** Fixed safe run-level code for a `definite_failure`/`unknown` Action Run. */
const ACTION_RUN_FAILED_ERROR_CODE = "execution_failed";

/**
 * Fixed safe contract code (§18.5) recorded on an execution cancelled while
 * it was still BEFORE the committed `external_call_started_at` marker: the
 * external write was never issued, so nothing local may claim "stopped".
 */
const ACTION_CANCELLED_BEFORE_WRITE_ERROR_CODE =
  "action_cancelled_before_write";

/**
 * Exact outcome of the pre-marker cancellation boundary.
 *
 * - `cancelled`: ONE transaction committed run `cancelled` + execution
 *   `failed` (`action_cancelled_before_write`, `finished_at`) + a `failed`
 *   receipt + `run.cancelled`; the grant stays UNCONSUMED and no external
 *   call ever happened.
 * - `run_terminal`: the run was already terminal; its ACTUAL status is
 *   returned unchanged and NOTHING was written.
 *
 * A committed marker is NOT a result: it throws the fixed
 * `ActionNotCancellableError` (409 `action_not_cancellable`) with no state
 * change. A missing/foreign run throws `RepositoryNotFoundError` (404).
 */
export type ActionCancelResult =
  | {
      applied: true;
      runStatus: "cancelled";
      executionId: string;
      executionStatus: "failed";
      eventSeq: number;
    }
  | {
      applied: false;
      reason: "run_terminal";
      runStatus: string;
      executionStatus: string | null;
    };

type ActionFinishOutcomeKind =
  | "succeeded"
  | "succeeded_unverified"
  | "failed"
  | "unknown";

/**
 * Exact connector-return terminal request (§18.6 three-value map):
 * `succeeded` MUST carry the actual verified post-write authoritative
 * normalized observation plus the preflight refs (revision key + snapshot id
 * from the committed preflight materialization). A write timeout/disconnect
 * after the marker is `unknown`; a definite provider failure is `failed`.
 * No retry ever follows.
 */
export type ActionFinishRequest =
  | {
      outcome: "succeeded";
      observation: ActionAuthoritativeObservation;
      preflightRevision: string | null;
      preflightSnapshotId: string | null;
    }
  | {
      outcome: "succeeded_unverified" | "failed" | "unknown";
      preflightRevision?: string | null;
      preflightSnapshotId?: string | null;
    };

export type ActionFinishResult =
  | {
      applied: true;
      executionId: string;
      outcome: ActionFinishOutcomeKind;
      executionStatus: ActionFinishOutcomeKind;
      runStatus: "completed" | "failed";
      observedRevision: string | null;
      resultSnapshotId: string | null;
      /** Actual fresh result rN (UUID) — verified succeeded only. */
      referenceId: string | null;
      eventSeq: number;
      runResult: RunResult;
    }
  | {
      applied: false;
      reason: "run_not_running" | "execution_not_executing";
    };

export type ActionPreflightOutcome =
  | {
      outcome: "granted";
      grant: CommittedGrantMeta;
      preflightReferenceId: string;
      preflightSnapshotId: string;
    }
  | {
      outcome: "blocked_stale";
      executionId: string;
      reason: "stale" | "deleted";
      preflightRevision: string;
      preflightSnapshotId: string;
    }
  | {
      outcome: "preflight_failed";
      executionId: string;
      portRead: Exclude<ActionPreflightRead["status"], "ok">;
    }
  | {
      outcome: "skipped";
      status: string;
      runStatus: string;
    };

function nowMs(value?: number): number {
  return value ?? Date.now();
}

function requireId(id: unknown, what: string): string {
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  }
  return id;
}

interface RawActionRun {
  id: string;
  turn_id: string;
  session_id: string;
  attempt: number;
  status: string;
  select_on_success: number;
  event_seq: number;
}

interface RawExecution {
  id: string;
  session_id: string;
  proposal_id: string;
  approval_turn_id: string;
  action_run_id: string;
  status: string;
  external_call_started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
}

interface RawProposal {
  id: string;
  session_id: string;
  tool: string;
  connector_instance_id: string;
  input_json: string;
  target_ref_id: string;
  target_resource_id: string;
  based_on_snapshot_id: string;
  expected_revision: string;
  preview_json: string;
  hash: string;
  status: string;
}

/**
 * Create the concrete Action execution boundary service. All boundaries are
 * the repository's own atomic `BEGIN IMMEDIATE` semantics; every function
 * either commits atomically or writes nothing.
 */
export function createActionExecutionService(
  options: ActionExecutionServiceOptions,
) {
  const { db, referenceManager } = options;
  const preflightReadPort = options.preflightRead;
  const clock = options.clock ?? (() => Date.now());
  void clock; // deterministic clock reserved for C19-C20 runtime timing loops

  function readRawRun(runId: string): RawActionRun | null {
    return (
      (db
        .prepare(
          "SELECT id, turn_id, session_id, attempt, status, select_on_success, event_seq FROM runs WHERE id = ?",
        )
        .get(runId) as RawActionRun | undefined) ?? null
    );
  }

  function readExecutionByRun(runId: string): RawExecution | null {
    return (
      (db
        .prepare("SELECT * FROM action_executions WHERE action_run_id = ?")
        .get(runId) as RawExecution | undefined) ?? null
    );
  }

  function readProposal(proposalId: string): RawProposal | null {
    return (
      (db
        .prepare("SELECT * FROM action_proposals WHERE id = ?")
        .get(proposalId) as RawProposal | undefined) ?? null
    );
  }

  function assertActionRun(runId: string): RawActionRun {
    const row = readRawRun(runId);
    if (row === null) {
      throw new RepositoryNotFoundError(`run ${runId} not found`);
    }
    return row;
  }

  /* ---------------------------------------------------------------- */
  /* 1) ATOMIC PICKUP (§18.5): queued run + queued execution ->          */
  /*    running + preflight, with run.started + action.preflight_started */
  /*    appended together in the same transaction.                       */
  /* ---------------------------------------------------------------- */
  function startActionRun(
    runId: string,
    transition: { now?: number } = {},
  ): ActionPickupResult {
    const id = requireId(runId, "runId");
    const now = nowMs(transition.now);
    return withImmediate(db, () => {
      const run = assertActionRun(id);
      if (run.status !== "queued") {
        return {
          applied: false as const,
          reason: "run_not_queued" as const,
          status: run.status,
        };
      }
      const execution = readExecutionByRun(id);
      if (execution === null || execution.status !== "queued") {
        throw new DatabaseStateInvalidError(
          `queued action run ${id} has no queued execution (impossible pair)`,
        );
      }
      const movedRun = db
        .prepare(
          "UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(now, id);
      if (movedRun.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent pickup conflict; retry the transition",
        );
      }
      const movedExecution = db
        .prepare(
          "UPDATE action_executions SET status = 'preflight', updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(now, execution.id);
      if (movedExecution.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent execution pickup conflict; retry the transition",
        );
      }
      const startedSeq = appendEventInTx(
        db,
        id,
        run.event_seq,
        "run.started",
        { attempt: run.attempt },
        now,
      );
      appendEventInTx(
        db,
        id,
        startedSeq,
        "action.preflight_started",
        { executionId: execution.id },
        now,
      );
      return { applied: true as const, executionId: execution.id };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Shared precheck for preflight terminals: run running + execution    */
  /* preflight with no marker. Terminal state mutations fall out via     */
  /* CAS; any contradiction of the required pair fails closed.           */
  /* ---------------------------------------------------------------- */
  function requirePreflightStage(runId: string): {
    run: RawActionRun;
    execution: RawExecution;
    proposal: RawProposal;
  } {
    const run = assertActionRun(runId);
    if (run.status !== "running") {
      throw new DatabaseStateInvalidError(
        `action run ${runId} must be running during preflight stage`,
      );
    }
    const execution = readExecutionByRun(runId);
    if (
      execution === null ||
      execution.status !== "preflight" ||
      execution.external_call_started_at !== null ||
      execution.finished_at !== null
    ) {
      throw new DatabaseStateInvalidError(
        `action run ${runId} is not in the unmarkered preflight stage (impossible state)`,
      );
    }
    const proposal = readProposal(execution.proposal_id);
    if (proposal === null || proposal.status !== "approved") {
      throw new DatabaseStateInvalidError(
        `execution ${execution.id} has no approved proposal (impossible state)`,
      );
    }
    return { run, execution, proposal };
  }

  /** Safe receipt summary: the deterministic provider-id-free preview. */
  function receiptSummary(proposal: RawProposal): string {
    return proposal.preview_json;
  }

  function insertReceipt(part: {
    executionId: string;
    sessionId: string;
    proposal: RawProposal;
    outcome:
      | "blocked_stale"
      | "failed"
      | "succeeded"
      | "succeeded_unverified"
      | "unknown";
    preflightRevision: string | null;
    preflightSnapshotId: string | null;
    /** Verified-only post-write observation fields (NULL otherwise). */
    observedRevision?: string | null;
    resultSnapshotId?: string | null;
    now: number;
  }): void {
    db.prepare(
      `INSERT INTO action_receipts (execution_id, session_id, proposal_id, proposal_hash, outcome,
         preflight_revision, preflight_snapshot_id, observed_revision, result_snapshot_id, summary_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      part.executionId,
      part.sessionId,
      part.proposal.id,
      part.proposal.hash,
      part.outcome,
      part.preflightRevision,
      part.preflightSnapshotId,
      part.observedRevision ?? null,
      part.resultSnapshotId ?? null,
      receiptSummary(part.proposal),
      part.now,
    );
  }

  /* ---------------------------------------------------------------- */
  /* 2a) ATOMIC PREFLIGHT-FAILED TERMINAL (§18.5): execution failed      */
  /*     (action_preflight_failed) + failed receipt + non-terminal       */
  /*     action.preflight_failed STRICTLY BEFORE run.failed — one tx,    */
  /*     zero external writes, no retry.                                 */
  /* ---------------------------------------------------------------- */
  function recordActionPreflightFailure(
    runId: string,
    transition: { now?: number } = {},
  ): ActionPreflightFailedTerminal {
    const id = requireId(runId, "runId");
    const now = nowMs(transition.now);
    return withImmediate(db, () => {
      const run = assertActionRun(id);
      if (run.status !== "running") {
        return {
          applied: false as const,
          reason: "run_not_running" as const,
        };
      }
      let preflight: ReturnType<typeof requirePreflightStage>;
      try {
        preflight = requirePreflightStage(id);
      } catch {
        // Run running but not preflight-stage: impossible state, fail closed.
        throw new DatabaseStateInvalidError(
          `action run ${id} is not in the unmarkered preflight stage (impossible state)`,
        );
      }
      const moved = db
        .prepare(
          `UPDATE action_executions SET status = 'failed',
             error_code = 'action_preflight_failed', finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'preflight' AND external_call_started_at IS NULL AND finished_at IS NULL`,
        )
        .run(now, now, preflight.execution.id);
      if (moved.changes !== 1) {
        return {
          applied: false as const,
          reason: "execution_not_preflight" as const,
        };
      }
      insertReceipt({
        executionId: preflight.execution.id,
        sessionId: preflight.execution.session_id,
        proposal: preflight.proposal,
        outcome: "failed",
        preflightRevision: null,
        preflightSnapshotId: null,
        now,
      });
      // Non-terminal event strictly BEFORE the terminal run.failed.
      const seq = appendEventInTx(
        db,
        id,
        run.event_seq,
        "action.preflight_failed",
        {
          executionId: preflight.execution.id,
          errorCode: "action_preflight_failed",
        },
        now,
      );
      const movedRun = db
        .prepare(
          "UPDATE runs SET status = 'failed', error_code = 'execution_failed', finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(now, id);
      if (movedRun.changes !== 1) {
        // The receipt/event inserts above roll back with this throw.
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent terminal conflict; retry the transition",
        );
      }
      appendEventInTx(
        db,
        id,
        seq,
        "run.failed",
        { errorCode: "execution_failed" },
        now,
      );
      return {
        applied: true as const,
        executionId: preflight.execution.id,
        preflightRevision: null,
        preflightSnapshotId: null,
        eventSeq: seq + 1,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 2b) ATOMIC BLOCKED-STALE TERMINAL (§18.5): zero write. Execution    */
  /*     blocked_stale + blocked_stale receipt (preflight key + the      */
  /*     proposal's based_on_snapshot_id) + action.preflight_blocked +    */
  /*     action.execution_finished + Action Run COMPLETED (not failed).  */
  /* ---------------------------------------------------------------- */
  function recordActionPreflightBlocked(
    runId: string,
    details: {
      reason: "stale" | "deleted";
      preflightRevision: string;
      now?: number;
    },
  ): ActionPreflightBlockedTerminal {
    const id = requireId(runId, "runId");
    const now = nowMs(details.now);
    const preflightRevision = SourceRevisionSchema.parse(
      details.preflightRevision,
    );
    if (details.reason !== "stale" && details.reason !== "deleted") {
      throw new RepositoryValidationError("block reason must be stale|deleted");
    }
    return withImmediate(db, () => {
      const run = assertActionRun(id);
      if (run.status !== "running") {
        return {
          applied: false as const,
          reason: "run_not_running" as const,
        };
      }
      const preflight = requirePreflightStage(id);
      const blockedSnapshotId = preflight.proposal.based_on_snapshot_id;
      const moved = db
        .prepare(
          `UPDATE action_executions SET status = 'blocked_stale',
             finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'preflight' AND external_call_started_at IS NULL AND finished_at IS NULL`,
        )
        .run(now, now, preflight.execution.id);
      if (moved.changes !== 1) {
        return {
          applied: false as const,
          reason: "execution_not_preflight" as const,
        };
      }
      insertReceipt({
        executionId: preflight.execution.id,
        sessionId: preflight.execution.session_id,
        proposal: preflight.proposal,
        outcome: "blocked_stale",
        preflightRevision,
        preflightSnapshotId: blockedSnapshotId,
        now,
      });
      let seq = appendEventInTx(
        db,
        id,
        run.event_seq,
        "action.preflight_blocked",
        {
          executionId: preflight.execution.id,
          preflightRevision,
          preflightSnapshotId: blockedSnapshotId,
        },
        now,
      );
      seq = appendEventInTx(
        db,
        id,
        seq,
        "action.execution_finished",
        { executionId: preflight.execution.id, outcome: "blocked_stale" },
        now,
      );
      const safeResult = parseRunResult({
        version: 1,
        text: `calendar.reschedule blocked (source changed; proposalId=${preflight.proposal.id})`,
      });
      const movedRun = db
        .prepare(
          "UPDATE runs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(JSON.stringify(safeResult), now, id);
      if (movedRun.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent terminal conflict; retry the transition",
        );
      }
      appendEventInTx(
        db,
        id,
        seq,
        "run.completed",
        { result: safeResult },
        now,
      );
      if (run.select_on_success === 1) {
        db.prepare(
          "INSERT INTO turn_selections (turn_id, run_id, selected_at) VALUES (?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET run_id = excluded.run_id, selected_at = excluded.selected_at",
        ).run(run.turn_id, id, now);
      }
      return {
        applied: true as const,
        executionId: preflight.execution.id,
        preflightRevision,
        preflightSnapshotId: blockedSnapshotId,
        eventSeq: seq + 2,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 2c) FRESH PRE-MARKER MATERIALIZATION (§18.5): only a MATCHING       */
  /*     authoritative observation reaches here (compare happened        */
  /*     BEFORE in the caller). Uses the SAME-DB ReferenceManager        */
  /*     refresh path (§14.2): new Snapshot + new rN, run still running; */
  /*     a refused presentation loses the race with zero changes.        */
  /* ---------------------------------------------------------------- */
  function materializeActionPreflightSnapshot(
    runId: string,
    observation: {
      connectorInstanceId: string;
      resourceCanonicalKey: string;
      title: string | null;
      text: string;
      sourceRevision: string | null;
      observedAt: number;
    },
    materialize: { now?: number } = {},
  ): ActionPreflightMaterializeResult {
    const id = requireId(runId, "runId");
    // Read-only prechecks OUTSIDE any transaction: the ReferenceManager
    // opens its own short transaction with the same running-CAS rule.
    const run = assertActionRun(id);
    if (run.status !== "running") {
      return {
        applied: false as const,
        reason: "run_not_running" as const,
        status: run.status,
      };
    }
    const execution = readExecutionByRun(id);
    if (
      execution === null ||
      execution.status !== "preflight" ||
      execution.external_call_started_at !== null
    ) {
      throw new DatabaseStateInvalidError(
        `action run ${id} is not in the unmarkered preflight stage (impossible state)`,
      );
    }
    const proposal = readProposal(execution.proposal_id);
    if (proposal === null || proposal.status !== "approved") {
      throw new DatabaseStateInvalidError(
        `execution ${execution.id} has no approved proposal (impossible state)`,
      );
    }
    const resource = db
      .prepare(
        "SELECT canonical_key FROM resources WHERE id = ? AND connector_instance_id = ?",
      )
      .get(proposal.target_resource_id, proposal.connector_instance_id) as
      | { canonical_key: string }
      | undefined;
    if (resource === undefined) {
      throw new DatabaseStateInvalidError(
        "proposal target resource binding missing (impossible state)",
      );
    }
    // Fail CLOSED: an observation that does not bind the exact proposal
    // target triple can never be materialized.
    if (
      observation.connectorInstanceId !== proposal.connector_instance_id ||
      observation.resourceCanonicalKey !== resource.canonical_key
    ) {
      throw new DatabaseStateInvalidError(
        "authoritative observation does not bind the proposal target (fail closed)",
      );
    }
    if (referenceManager === undefined) {
      throw new RepositoryValidationError(
        "this boundary requires an injected referenceManager",
      );
    }
    const presented = referenceManager.presentObservations(
      run.session_id,
      id,
      [
        {
          connectorInstanceId: observation.connectorInstanceId,
          canonicalKey: observation.resourceCanonicalKey,
          title: observation.title,
          text: observation.text,
          sourceRevision: observation.sourceRevision,
          observedAt: nowMs(materialize.now ?? observation.observedAt),
        },
      ],
      { freshness: "refresh", now: nowMs(materialize.now) },
    );
    if (!presented.applied) {
      return {
        applied: false as const,
        reason: "presentation_refused" as const,
        status: presented.status,
      };
    }
    if (presented.references.length !== 1) {
      throw new DatabaseStateInvalidError(
        "preflight presentation did not yield exactly one fresh rN (impossible state)",
      );
    }
    const fresh = presented.references[0] as {
      referenceId: string;
      snapshotId: string;
    };
    return {
      applied: true as const,
      referenceId: fresh.referenceId,
      snapshotId: fresh.snapshotId,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 3) EXACT GRANT GATE (§18.5/§18.6): one-shot consumed_at CAS +       */
  /*    executing + external_call_started_at + action.execution_started  */
  /*    committed together; the caller's external write may only follow  */
  /*    a COMMITTED granted gate. Default deny otherwise.                */
  /* ---------------------------------------------------------------- */
  function consumeActionGrant(
    runId: string,
    gate: { now?: number } = {},
  ): ActionGrantGate {
    const id = requireId(runId, "runId");
    const now = nowMs(gate.now);
    return withImmediate(db, () => {
      const run = assertActionRun(id);
      // Pre-marker cancel contention: a run that lost the race to a cancel
      // CAS (cancelled, failed, cancelled-requested, terminal) never grants.
      if (run.status !== "running") {
        return { granted: false as const, reason: "run_not_running" as const };
      }
      const execution = readExecutionByRun(id);
      if (execution === null) {
        throw new DatabaseStateInvalidError(
          `action run ${id} has no execution (impossible state)`,
        );
      }
      if (
        execution.status !== "preflight" ||
        execution.external_call_started_at !== null
      ) {
        return {
          granted: false as const,
          reason: "execution_not_preflight" as const,
        };
      }
      const proposal = readProposal(execution.proposal_id);
      if (proposal === null || proposal.status !== "approved") {
        return {
          granted: false as const,
          reason: "proposal_not_approved" as const,
        };
      }
      const grant = db
        .prepare("SELECT * FROM action_execution_grants WHERE execution_id = ?")
        .get(execution.id) as
        | {
            execution_id: string;
            session_id: string;
            proposal_id: string;
            proposal_hash: string;
            tool: string;
            input_hash: string;
            consumed_at: number | null;
          }
        | undefined;
      if (grant === undefined) {
        return { granted: false as const, reason: "grant_missing" as const };
      }
      // EXACT provenance verification (§18.5 few fields): execution id +
      // proposal id + proposal hash + tool + recomputed input hash. Any
      // contradiction is a fail-closed impossible state.
      if (
        grant.execution_id !== execution.id ||
        grant.proposal_id !== proposal.id ||
        grant.session_id !== run.session_id ||
        grant.proposal_hash !== proposal.hash ||
        grant.tool !== proposal.tool
      ) {
        throw new DatabaseStateInvalidError(
          "grant provenance does not match the execution/proposal (fail closed)",
        );
      }
      const proposedInput = CalendarRescheduleToolInputSchema.parse(
        JSON.parse(proposal.input_json) as unknown,
      );
      const inputHash = sha256Hex(canonicalJsonString(proposedInput));
      if (inputHash !== grant.input_hash) {
        throw new DatabaseStateInvalidError(
          "grant input hash does not match the proposal input (fail closed)",
        );
      }
      // One-shot consumption CAS (consumed_at IS NULL, at most once).
      const consumed = db
        .prepare(
          "UPDATE action_execution_grants SET consumed_at = ? WHERE execution_id = ? AND consumed_at IS NULL",
        )
        .run(now, execution.id);
      if (consumed.changes !== 1) {
        return { granted: false as const, reason: "grant_consumed" as const };
      }
      // Executing + external marker CAS (same transaction as the consume).
      const marked = db
        .prepare(
          `UPDATE action_executions SET status = 'executing',
             external_call_started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'preflight' AND external_call_started_at IS NULL AND finished_at IS NULL`,
        )
        .run(now, now, execution.id);
      if (marked.changes !== 1) {
        // Losing here rolls back the consumption too (same transaction).
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent marker conflict; retry the transition",
        );
      }
      appendEventInTx(
        db,
        id,
        run.event_seq,
        "action.execution_started",
        { executionId: execution.id },
        now,
      );
      return {
        granted: true as const,
        grant: {
          executionId: execution.id,
          proposalId: proposal.id,
          proposalHash: proposal.hash,
          tool: proposal.tool as "calendar.reschedule",
          inputHash: grant.input_hash,
          consumedAt: now,
        },
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 3c) PRE-MARKER CANCELLATION BOUNDARY (§18.5): the ONE cancellation  */
  /*     boundary for an Action Run. Ownership first (404), a terminal   */
  /*     run returns its ACTUAL status unchanged (200, zero writes), and  */
  /*     only a run whose execution is still queued/preflight with        */
  /*     `external_call_started_at IS NULL` may cancel — in ONE           */
  /*     transaction: run `cancelled` + execution `failed`               */
  /*     (`action_cancelled_before_write`, `finished_at`) + `failed`     */
  /*     receipt + `action.execution_finished` + `run.cancelled`.        */
  /*     A committed marker is NEVER "cancelled after the fact": it      */
  /*     throws the fixed `action_not_cancellable` with zero writes.     */
  /*     The grant row is untouched (stays unconsumed) and NO external   */
  /*     call is issued from here (DB-commit-first, §18.6).               */
  /* ---------------------------------------------------------------- */
  function cancelActionRun(
    sessionId: string,
    runId: string,
    now?: number,
  ): ActionCancelResult {
    const session = requireId(sessionId, "sessionId");
    const id = requireId(runId, "runId");
    const at = nowMs(now);
    return withImmediate(db, () => {
      // Ownership BEFORE any state inspection: a run owned by another
      // session is indistinguishable from a missing one (404).
      const run = assertActionRun(id);
      if (run.session_id !== session) {
        throw new RepositoryNotFoundError(
          `run ${id} not found in session ${session}`,
        );
      }
      const execution = readExecutionByRun(id);
      // Terminal runs report their ACTUAL status; nothing is mutated and
      // no new event is appended (cancel stays idempotent).
      if (isTerminalStatus(run.status as RunStatus)) {
        return {
          applied: false as const,
          reason: "run_terminal" as const,
          runStatus: run.status,
          executionStatus: execution?.status ?? null,
        };
      }
      if (execution === null) {
        throw new DatabaseStateInvalidError(
          `action run ${id} has no execution (impossible state)`,
        );
      }
      // The committed marker is the hard stop: the external call may have
      // started, so a cancel would be a lie. Fixed 409, zero writes.
      if (execution.external_call_started_at !== null) {
        throw new ActionNotCancellableError(id);
      }
      if (
        (execution.status !== "queued" && execution.status !== "preflight") ||
        execution.finished_at !== null
      ) {
        throw new DatabaseStateInvalidError(
          `action run ${id} is not in a cancellable pre-marker stage (impossible state)`,
        );
      }
      const proposal = readProposal(execution.proposal_id);
      if (proposal === null) {
        throw new DatabaseStateInvalidError(
          `execution ${execution.id} has no proposal (impossible state)`,
        );
      }
      // Run CAS first: queued settles directly to `cancelled`; a running or
      // already cancel_requested pre-marker run also settles immediately —
      // there is no in-flight external work left to drain.
      const movedRun = db
        .prepare(
          `UPDATE runs SET status = 'cancelled', cancel_requested_at = ?, finished_at = ?
           WHERE id = ? AND status IN ('queued', 'running', 'cancel_requested') AND finished_at IS NULL`,
        )
        .run(at, at, id);
      if (movedRun.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent cancellation conflict; retry the transition",
        );
      }
      // Execution CAS: the grant transaction CASes
      // `status='preflight' AND external_call_started_at IS NULL` and
      // CONSUMES the grant in the same transaction, so exactly one of the
      // two wins; losing here rolls the run update back with this throw.
      const movedExecution = db
        .prepare(
          `UPDATE action_executions SET status = 'failed',
             error_code = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued', 'preflight')
             AND external_call_started_at IS NULL AND finished_at IS NULL`,
        )
        .run(ACTION_CANCELLED_BEFORE_WRITE_ERROR_CODE, at, at, execution.id);
      if (movedExecution.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent cancellation conflict; retry the transition",
        );
      }
      insertReceipt({
        executionId: execution.id,
        sessionId: execution.session_id,
        proposal,
        outcome: "failed",
        preflightRevision: null,
        preflightSnapshotId: null,
        now: at,
      });
      // Non-terminal execution event strictly BEFORE the terminal
      // run.cancelled (same journal chain, same transaction).
      const seq = appendEventInTx(
        db,
        id,
        run.event_seq,
        "action.execution_finished",
        {
          executionId: execution.id,
          outcome: "failed",
        },
        at,
      );
      const eventSeq = appendEventInTx(db, id, seq, "run.cancelled", {}, at);
      return {
        applied: true as const,
        runStatus: "cancelled",
        executionId: execution.id,
        executionStatus: "failed" as const,
        eventSeq,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 3b) C20 EXECUTING -> TERMINAL (§18.6 normal connector map + §18.7   */
  /*     read-back): one atomic outer transaction per outcome that       */
  /*     commits execution CAS + receipt + action.execution_finished +   */
  /*     Run terminal + terminal RunEvent together, with the verified    */
  /*     fresh result Snapshot/rN materialized INSIDE that same outer    */
  /*     transaction (through the SAME-DB ReferenceManager via its       */
  /*     `onApplied` same-transaction hook) — never before it.           */
  /* ---------------------------------------------------------------- */

  type ActionFinishOutcomeKind =
    | "succeeded"
    | "succeeded_unverified"
    | "failed"
    | "unknown";

  /**
   * Exact connector-return terminal request (§18.6 three-value map):
   * `succeeded` MUST carry the actual verified post-write authoritative
   * normalized observation plus the preflight refs (revision key +
   * snapshot id from the committed preflight materialization). A write
   * timeout/disconnect after the marker is `unknown`; a definite provider
   * failure is `failed`. No retry ever follows.
   */
  function actionRunResultText(
    outcome: ActionFinishOutcomeKind,
    proposal: RawProposal,
  ): string {
    switch (outcome) {
      case "succeeded":
        return `calendar.reschedule succeeded (verified; proposalId=${proposal.id})`;
      case "succeeded_unverified":
        return `calendar.reschedule finished but not verified — confirm on the external calendar (proposalId=${proposal.id})`;
      case "failed":
        return `calendar.reschedule failed (definite_failure; proposalId=${proposal.id})`;
      case "unknown":
        return `calendar.reschedule result unknown — confirm on the external calendar (proposalId=${proposal.id})`;
    }
  }

  function assertExecutingStage(id: string): {
    execution: RawExecution;
    proposal: RawProposal;
  } {
    const execution = readExecutionByRun(id);
    if (
      execution === null ||
      execution.status !== "executing" ||
      execution.external_call_started_at === null ||
      execution.finished_at !== null
    ) {
      throw new DatabaseStateInvalidError(
        `action run ${id} is not in the markered executing stage (impossible state)`,
      );
    }
    const proposal = readProposal(execution.proposal_id);
    if (proposal === null || proposal.status !== "approved") {
      throw new DatabaseStateInvalidError(
        `execution ${execution.id} has no approved proposal (impossible state)`,
      );
    }
    return { execution, proposal };
  }

  function finishPlainTerminal(
    id: string,
    outcome: Exclude<ActionFinishOutcomeKind, "succeeded">,
    preflightRevision: string | null,
    preflightSnapshotId: string | null,
    now: number,
  ): ActionFinishResult {
    return withImmediate(db, () => {
      const run = assertActionRun(id);
      if (run.status !== "running") {
        return {
          applied: false as const,
          reason: "run_not_running" as const,
        };
      }
      const stage = assertExecutingStage(id);
      const moved = db
        .prepare(
          `UPDATE action_executions SET status = ?,
             error_code = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'executing' AND external_call_started_at IS NOT NULL AND finished_at IS NULL`,
        )
        .run(
          outcome,
          outcome === "failed" ? ACTION_WRITE_FAILED_ERROR_CODE : null,
          now,
          now,
          stage.execution.id,
        );
      if (moved.changes !== 1) {
        return {
          applied: false as const,
          reason: "execution_not_executing" as const,
        };
      }
      insertReceipt({
        executionId: stage.execution.id,
        sessionId: stage.execution.session_id,
        proposal: stage.proposal,
        outcome,
        preflightRevision,
        preflightSnapshotId,
        now,
      });
      let seq = (
        db.prepare("SELECT event_seq FROM runs WHERE id = ?").get(id) as {
          event_seq: number;
        }
      ).event_seq;
      seq = appendEventInTx(
        db,
        id,
        seq,
        "action.execution_finished",
        { executionId: stage.execution.id, outcome },
        now,
      );
      const runResult = parseRunResult({
        version: 1,
        text: actionRunResultText(outcome, stage.proposal),
      });
      const runStatus: "completed" | "failed" =
        outcome === "succeeded_unverified" ? "completed" : "failed";
      const runUpdate =
        runStatus === "completed"
          ? db
              .prepare(
                "UPDATE runs SET status = 'completed', result_json = ?, error_code = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
              )
              .run(JSON.stringify(runResult), now, id)
          : db
              .prepare(
                "UPDATE runs SET status = 'failed', error_code = ?, result_json = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
              )
              .run(ACTION_RUN_FAILED_ERROR_CODE, now, id);
      if (runUpdate.changes !== 1) {
        // The execution/receipt/event writes above roll back with this throw.
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent terminal conflict; retry the transition",
        );
      }
      appendEventInTx(
        db,
        id,
        seq,
        runStatus === "completed" ? "run.completed" : "run.failed",
        runStatus === "completed"
          ? { result: runResult }
          : { errorCode: ACTION_RUN_FAILED_ERROR_CODE },
        now,
      );
      if (runStatus === "completed" && run.select_on_success === 1) {
        db.prepare(
          "INSERT INTO turn_selections (turn_id, run_id, selected_at) VALUES (?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET run_id = excluded.run_id, selected_at = excluded.selected_at",
        ).run(run.turn_id, id, now);
      }
      return {
        applied: true as const,
        executionId: stage.execution.id,
        outcome,
        executionStatus: outcome,
        runStatus,
        observedRevision: null,
        resultSnapshotId: null,
        referenceId: null,
        eventSeq: (
          db.prepare("SELECT event_seq FROM runs WHERE id = ?").get(id) as {
            event_seq: number;
          }
        ).event_seq,
        runResult,
      };
    });
  }

  function finishVerifiedTerminal(
    id: string,
    observationRaw: ActionAuthoritativeObservation,
    preflightRevision: string | null,
    preflightSnapshotId: string | null,
    now: number,
  ): ActionFinishResult {
    let observation: z.infer<typeof ActionAuthoritativeObservationSchema>;
    try {
      observation = ActionAuthoritativeObservationSchema.parse(observationRaw);
    } catch {
      throw new RepositoryValidationError(
        "verified result observation does not parse (fail closed)",
      );
    }
    // The outer prechecks read the authoritative stage OUTSIDE any
    // transaction; presentObservations opens the ONE outer transaction that
    // also holds the terminal commits via its same-transaction `onApplied`
    // hook — so the fresh rN is never created outside the terminal tx.
    const run = assertActionRun(id);
    if (run.status !== "running") {
      return { applied: false as const, reason: "run_not_running" as const };
    }
    const stage = assertExecutingStage(id);
    const proposal = stage.proposal;
    const resource = db
      .prepare(
        "SELECT canonical_key FROM resources WHERE id = ? AND connector_instance_id = ?",
      )
      .get(proposal.target_resource_id, proposal.connector_instance_id) as
      | { canonical_key: string }
      | undefined;
    if (resource === undefined) {
      throw new DatabaseStateInvalidError(
        "proposal target resource binding missing (impossible state)",
      );
    }
    if (
      observation.connectorInstanceId !== proposal.connector_instance_id ||
      observation.resourceCanonicalKey !== resource.canonical_key
    ) {
      throw new RepositoryValidationError(
        "verified result observation does not bind the proposal target (fail closed)",
      );
    }
    // A post-write authoritative read showing the event deleted does NOT
    // verify the write; it maps to succeeded_unverified (never a fake
    // verified claim, never a retry).
    if (observation.eventStatus === "deleted") {
      return finishPlainTerminal(
        id,
        "succeeded_unverified",
        preflightRevision,
        preflightSnapshotId,
        now,
      );
    }
    const observedKey =
      observation.sourceRevision ??
      sha256Hex(observation.text.normalize("NFC"));
    interface CommittedVerifiedTerminal {
      executionId: string;
      observedRevision: string;
      resultSnapshotId: string;
      referenceId: string;
      eventSeq: number;
      runResult: RunResult;
    }
    const box: { value?: CommittedVerifiedTerminal } = {};
    if (referenceManager === undefined) {
      throw new RepositoryValidationError(
        "this boundary requires an injected referenceManager",
      );
    }
    const presented = referenceManager.presentObservations(
      run.session_id,
      id,
      [
        {
          connectorInstanceId: observation.connectorInstanceId,
          canonicalKey: observation.resourceCanonicalKey,
          title: observation.title,
          text: observation.text,
          sourceRevision: observation.sourceRevision,
          observedAt: now,
        },
      ],
      {
        freshness: "refresh",
        now,
        onApplied: (presentedRefs) => {
          // Same outer transaction (after rN + reference.presented).
          if (presentedRefs.references.length !== 1) {
            throw new DatabaseStateInvalidError(
              "verified read-back did not materialize exactly one fresh rN (impossible state)",
            );
          }
          const fresh = presentedRefs.references[0];
          if (fresh === undefined) {
            throw new DatabaseStateInvalidError(
              "verified read-back did not materialize exactly one fresh rN (impossible state)",
            );
          }
          const committedStage = assertExecutingStage(id);
          const moved = db
            .prepare(
              `UPDATE action_executions SET status = 'succeeded',
                 finished_at = ?, updated_at = ?
               WHERE id = ? AND status = 'executing' AND external_call_started_at IS NOT NULL AND finished_at IS NULL`,
            )
            .run(now, now, committedStage.execution.id);
          if (moved.changes !== 1) {
            throw new DatabaseStateInvalidError(
              "executing CAS lost inside the terminal transaction (impossible state)",
            );
          }
          insertReceipt({
            executionId: committedStage.execution.id,
            sessionId: committedStage.execution.session_id,
            proposal: committedStage.proposal,
            outcome: "succeeded",
            preflightRevision,
            preflightSnapshotId,
            observedRevision: observedKey,
            resultSnapshotId: fresh.snapshotId,
            now,
          });
          let seq = (
            db.prepare("SELECT event_seq FROM runs WHERE id = ?").get(id) as {
              event_seq: number;
            }
          ).event_seq;
          seq = appendEventInTx(
            db,
            id,
            seq,
            "action.execution_finished",
            { executionId: committedStage.execution.id, outcome: "succeeded" },
            now,
          );
          // Exact valid RunResult: safe deterministic summary text citing
          // the ACTUAL fresh result rN (no fake fallback anywhere).
          const runResult = buildRunResultV2({
            version: 1,
            parts: [
              {
                text: actionRunResultText("succeeded", committedStage.proposal),
                citations: [`r${fresh.ordinal}`],
              },
            ],
          });
          const movedRun = db
            .prepare(
              "UPDATE runs SET status = 'completed', result_json = ?, error_code = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(JSON.stringify(runResult), now, id);
          if (movedRun.changes !== 1) {
            // Everything above rolls back with this throw.
            throw new KernelStorageError(
              "kernel_concurrent_conflict",
              "concurrent terminal conflict; retry the transition",
            );
          }
          appendEventInTx(
            db,
            id,
            seq,
            "run.completed",
            { result: runResult },
            now,
          );
          if (run.select_on_success === 1) {
            db.prepare(
              "INSERT INTO turn_selections (turn_id, run_id, selected_at) VALUES (?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET run_id = excluded.run_id, selected_at = excluded.selected_at",
            ).run(run.turn_id, id, now);
          }
          box.value = {
            executionId: committedStage.execution.id,
            observedRevision: observedKey,
            resultSnapshotId: fresh.snapshotId,
            referenceId: fresh.referenceId,
            eventSeq: (
              db.prepare("SELECT event_seq FROM runs WHERE id = ?").get(id) as {
                event_seq: number;
              }
            ).event_seq,
            runResult,
          };
        },
      },
    );
    if (!presented.applied) {
      return {
        applied: false as const,
        reason: "run_not_running" as const,
      };
    }
    if (box.value === undefined) {
      throw new DatabaseStateInvalidError(
        "verified terminal committed without its stage (fail closed)",
      );
    }
    const committed: CommittedVerifiedTerminal = box.value;
    return {
      applied: true as const,
      executionId: committed.executionId,
      outcome: "succeeded",
      executionStatus: "succeeded",
      runStatus: "completed",
      observedRevision: committed.observedRevision,
      resultSnapshotId: committed.resultSnapshotId,
      referenceId: committed.referenceId,
      eventSeq: committed.eventSeq,
      runResult: committed.runResult,
    };
  }

  /**
   * C20 terminal API: mapping a committed post-marker connector return to
   * the atomic write-back terminal. The caller's external write has already
   * happened OUTSIDE any transaction (DB-commit-first, §18.6); only its
   * classified result enters here. Each outcome is exactly one transaction:
   * execution CAS + receipt + `action.execution_finished` + Run terminal +
   * terminal RunEvent (and, verified-succeeded only, the fresh result
   * Snapshot/rN via the SAME-DB ReferenceManager inside the SAME outer
   * transaction). No retry.
   */
  function finishActionExecution(
    runId: string,
    result: ActionFinishRequest,
    transition: { now?: number } = {},
  ): ActionFinishResult {
    const id = requireId(runId, "runId");
    const now = nowMs(transition.now);
    if (result.outcome === "succeeded") {
      return finishVerifiedTerminal(
        id,
        result.observation,
        result.preflightRevision ?? null,
        result.preflightSnapshotId ?? null,
        now,
      );
    }
    return finishPlainTerminal(
      id,
      result.outcome,
      result.preflightRevision ?? null,
      result.preflightSnapshotId ?? null,
      now,
    );
  }

  /* ---------------------------------------------------------------- */
  /* 4) ORCHESTRATOR: one preflight step with the exact §18.5 order      */
  /*    (compare BEFORE materialize). No transaction is held across the  */
  /*    port read or the ReferenceManager materialize: each remaining    */
  /*    terminal/gate step is its own atomic transaction.                */
  /* ---------------------------------------------------------------- */
  function runActionPreflight(
    runId: string,
    step: { now?: number; signal?: AbortSignal } = {},
  ): Promise<ActionPreflightOutcome> {
    const port = preflightReadPort;
    if (port === undefined) {
      return Promise.reject(
        new RepositoryValidationError(
          "runActionPreflight requires an injected preflightRead port",
        ),
      );
    }
    try {
      return Promise.resolve(runActionPreflightSync(runId, step));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Promise-based authoritative preflight read + compare-before-materialize.
   * The port read happens BEFORE any transaction with an AbortSignal
   * propagated to the port. A read rejection is mapped to the fixed
   * `preflight_failed` terminal ONLY while the execution is still running +
   * unmarkered preflight; a late resolution/response after the stage moved
   * (cancel race) writes NOTHING beyond the normal skipped outcome — the
   * observation is dropped. Transaction helpers stay synchronous and no
   * `await` ever spans an open DB transaction.
   */
  async function runActionPreflightSync(
    runId: string,
    step: { now?: number; signal?: AbortSignal } = {},
  ): Promise<ActionPreflightOutcome> {
    const port = preflightReadPort as ActionPreflightReadPort;
    if (port === undefined) {
      throw new RepositoryValidationError(
        "runActionPreflight requires an injected preflightRead port",
      );
    }
    const id = requireId(runId, "runId");
    const run = assertActionRun(id);
    const execution = readExecutionByRun(id);
    const stage =
      execution?.status === "preflight" &&
      execution.external_call_started_at === null;
    if (run.status !== "running" || !stage) {
      return {
        outcome: "skipped" as const,
        status: execution === null ? run.status : execution.status,
        runStatus: run.status,
      };
    }
    const proposal = readProposal(execution.proposal_id);
    if (proposal === null || proposal.status !== "approved") {
      throw new DatabaseStateInvalidError(
        "execution has no approved proposal (impossible state)",
      );
    }
    // Async authoritative read OUTSIDE any transaction; signal propagated.
    let read: ActionPreflightRead;
    try {
      read = await port.read(
        {
          connectorInstanceId: proposal.connector_instance_id,
          targetResourceId: proposal.target_resource_id,
          basedOnSnapshotId: proposal.based_on_snapshot_id,
        },
        step.signal,
      );
    } catch {
      // Rejecting is not a result channel: map to the fixed failure terminal
      // ONLY if still running/preflight (the late observation writes none).
      return runPreflightFailedTerminal("unavailable", step, id);
    }
    if (read.status !== "ok") {
      return runPreflightFailedTerminal(read.status, step, id);
    }
    // Trusted observation validation (fail closed with the same
    // classification/terminal as a port schema failure).
    let observation: z.infer<typeof ActionAuthoritativeObservationSchema>;
    try {
      observation = ActionAuthoritativeObservationSchema.parse(
        read.observation,
      );
    } catch {
      return runPreflightFailedTerminal("schema_invalid", step, id);
    }
    // EXACT compare BEFORE materialize (§18.5): source revision key =
    // source_revision else NFC content hash; only the fresh matching
    // observation materializes.
    const observedKey =
      observation.sourceRevision ??
      sha256Hex(observation.text.normalize("NFC"));
    if (observation.eventStatus === "deleted") {
      return finishBlocked("deleted", observedKey);
    }
    if (observedKey !== proposal.expected_revision) {
      return finishBlocked("stale", observedKey);
    }
    // Matching key: materialize fresh snapshot / rN through the SAME-DB
    // ReferenceManager; then the one-shot gate.
    const materialized = materializeActionPreflightSnapshot(id, observation, {
      now: nowMs(step.now),
    });
    if (!materialized.applied) {
      return {
        outcome: "skipped" as const,
        status:
          materialized.reason === "run_not_running"
            ? materialized.status
            : `presentation_refused:${materialized.status as string}`,
        runStatus:
          materialized.reason === "run_not_running"
            ? materialized.status
            : run.status,
      };
    }
    const gate = consumeActionGrant(id, { now: nowMs(step.now) });
    if (!gate.granted) {
      return {
        outcome: "skipped" as const,
        status: `grant_denied:${gate.reason}`,
        runStatus: "NOT_RUN",
      };
    }
    return {
      outcome: "granted" as const,
      grant: gate.grant,
      preflightReferenceId: materialized.referenceId,
      preflightSnapshotId: materialized.snapshotId,
    };

    function finishBlocked(
      reason: "stale" | "deleted",
      preflightRevision: string,
    ): ActionPreflightOutcome {
      const blocked = recordActionPreflightBlocked(id, {
        reason,
        preflightRevision,
        now: nowMs(step.now),
      });
      if (!blocked.applied) {
        return {
          outcome: "skipped" as const,
          status: "terminal",
          runStatus: "terminal",
        };
      }
      return {
        outcome: "blocked_stale" as const,
        executionId: blocked.executionId,
        reason,
        preflightRevision: blocked.preflightRevision,
        preflightSnapshotId: blocked.preflightSnapshotId,
      };
    }

    /** Fixed preflight-failed terminal; skipped if the stage moved. */
    function runPreflightFailedTerminal(
      portRead: Exclude<ActionPreflightRead["status"], "ok">,
      opts: { now?: number },
      runId: string,
    ): ActionPreflightOutcome {
      // Re-check the authoritative stage before the fixed failure write: a
      // late read rejection after a cancel/terminal race must write nothing.
      const currentRun = readRawRun(runId);
      const currentExecution = readExecutionByRun(runId);
      const stillPreflight =
        currentExecuteStatus(currentExecution) === "preflight" &&
        currentExecution?.external_call_started_at === null &&
        currentExecution.finished_at === null &&
        currentRun?.status === "running";
      if (!stillPreflight) {
        return {
          outcome: "skipped" as const,
          status: currentExecution?.status ?? "terminal",
          runStatus: currentRun?.status ?? "terminal",
        };
      }
      const failed = recordActionPreflightFailure(runId, {
        now: nowMs(opts.now),
      });
      if (!failed.applied) {
        return {
          outcome: "skipped" as const,
          status: "terminal",
          runStatus: "terminal",
        };
      }
      return {
        outcome: "preflight_failed" as const,
        executionId: failed.executionId,
        portRead,
      };
    }
  }

  function currentExecuteStatus(execution: RawExecution | null): string | null {
    if (execution === null) {
      return null;
    }
    const row = db
      .prepare("SELECT status FROM action_executions WHERE id = ?")
      .get(execution.id) as { status: string } | undefined;
    return row?.status ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* 5) Narrow status view for the next deterministic ActionStrategy      */
  /*    runtime (no broad reads).                                        */
  /* ---------------------------------------------------------------- */
  function getActionRunView(runId: string): {
    run: { id: string; status: string; eventSeq: number; sessionId: string };
    execution: {
      id: string;
      status: string;
      proposalId: string;
      externalCallStartedAt: number | null;
      finishedAt: number | null;
    } | null;
    grant: {
      proposalId: string;
      proposalHash: string;
      tool: string;
      inputHash: string;
      consumedAt: number | null;
    } | null;
    receipt: {
      outcome: string;
      preflightRevision: string | null;
      preflightSnapshotId: string | null;
      observedRevision: string | null;
      resultSnapshotId: string | null;
    } | null;
  } {
    const id = requireId(runId, "runId");
    const run = assertActionRun(id);
    const execution = readExecutionByRun(id);
    const grant =
      execution === null
        ? null
        : (db
            .prepare(
              "SELECT proposal_id, proposal_hash, tool, input_hash, consumed_at FROM action_execution_grants WHERE execution_id = ?",
            )
            .get(execution.id) as
            | {
                proposal_id: string;
                proposal_hash: string;
                tool: string;
                input_hash: string;
                consumed_at: number | null;
              }
            | undefined);
    const receipt =
      execution === null
        ? null
        : (db
            .prepare(
              "SELECT outcome, preflight_revision, preflight_snapshot_id, observed_revision, result_snapshot_id FROM action_receipts WHERE execution_id = ?",
            )
            .get(execution.id) as
            | {
                outcome: string;
                preflight_revision: string | null;
                preflight_snapshot_id: string | null;
                observed_revision: string | null;
                result_snapshot_id: string | null;
              }
            | undefined);
    return {
      run: {
        id: run.id,
        status: run.status,
        eventSeq: run.event_seq,
        sessionId: run.session_id,
      },
      execution:
        execution === null
          ? null
          : {
              id: execution.id,
              status: execution.status,
              proposalId: execution.proposal_id,
              externalCallStartedAt: execution.external_call_started_at,
              finishedAt: execution.finished_at,
            },
      grant:
        grant === undefined || grant === null
          ? null
          : {
              proposalId: grant.proposal_id,
              proposalHash: grant.proposal_hash,
              tool: grant.tool,
              inputHash: grant.input_hash,
              consumedAt: grant.consumed_at,
            },
      receipt:
        receipt === undefined || receipt === null
          ? null
          : {
              outcome: receipt.outcome,
              preflightRevision: receipt.preflight_revision,
              preflightSnapshotId: receipt.preflight_snapshot_id,
              observedRevision: receipt.observed_revision,
              resultSnapshotId: receipt.result_snapshot_id,
            },
    };
  }

  /* ---------------------------------------------------------------- */
  /* 6) C21 FAIL-CLOSED ACTION RECOVERY / DRAIN (§18.6).               */
  /*    Every Action Run pair (runs row + its ONE action_executions   */
  /*    row) is VALIDATED against the EXACT matrix below and NOTHING  */
  /*    is inferred: an unlisted combination is an impossible state   */
  /*    and throws (DatabaseStateInvalidError) with ZERO writes.      */
  /*                                                                   */
  /*      run queued   + exec queued      + marker NULL    -> unchanged */
  /*      run running  + exec preflight   + marker NULL    -> failed   */
  /*                                        receipt + run abandoned   */
  /*                                        (no retry, no resend)    */
  /*      run running  + exec executing   + marker NOTNULL -> unknown  */
  /*                                        receipt + run abandoned   */
  /*                                        (no retry, no resend)    */
  /*      valid terminal exec + terminal run (incl. an ALREADY       */
  /*      recovered failed/unknown + abandoned pair)     -> unchanged */
  /*      ANY other combination                -> database_state_invalid */
  /*                                                                   */
  /*    Validation of ALL pairs completes BEFORE the first mutation    */
  /*    and the whole validation+mutation set runs in ONE transaction, */
  /*    so an impossible pair anywhere leaves the database untouched.   */
  /* ---------------------------------------------------------------- */

  type RecoveryClassification =
    | { kind: "unchanged" }
    | { kind: "abandon_pre_marker" }
    | { kind: "abandon_post_marker" };

  const TERMINAL_EXECUTION_STATUSES = new Set([
    "succeeded",
    "succeeded_unverified",
    "blocked_stale",
    "failed",
    "unknown",
  ]);

  function readReceiptOutcome(executionId: string): string | null {
    const row = db
      .prepare("SELECT outcome FROM action_receipts WHERE execution_id = ?")
      .get(executionId) as { outcome: string } | undefined;
    return row?.outcome ?? null;
  }

  function readGrantConsumedAt(executionId: string): number | null | undefined {
    const row = db
      .prepare(
        "SELECT consumed_at FROM action_execution_grants WHERE execution_id = ?",
      )
      .get(executionId) as { consumed_at: number | null } | undefined;
    return row?.consumed_at;
  }

  /**
   * Exact matrix classification. Throws `DatabaseStateInvalidError` for
   * anything the lifecycle can never produce; never repairs and never
   * guesses a disposition.
   */
  function classifyActionPair(
    run: RawActionRun,
    execution: RawExecution,
  ): RecoveryClassification {
    const markered = execution.external_call_started_at !== null;
    const finished = execution.finished_at !== null;
    if (run.status === "queued") {
      // Pickup pair: requeued on the next pass, never swept.
      if (
        execution.status === "queued" &&
        !markered &&
        !finished &&
        execution.error_code === null
      ) {
        return { kind: "unchanged" };
      }
      throw new DatabaseStateInvalidError(
        `queued action run ${run.id} has a non-queued execution ${execution.id} (impossible state)`,
      );
    }
    if (run.status === "running") {
      if (execution.status === "preflight" && !markered && !finished) {
        return { kind: "abandon_pre_marker" };
      }
      if (execution.status === "executing" && markered && !finished) {
        return { kind: "abandon_post_marker" };
      }
      throw new DatabaseStateInvalidError(
        `running action run ${run.id} has execution ${execution.id} in stage ${execution.status} (impossible state)`,
      );
    }
    if (isTerminalStatus(run.status as RunStatus)) {
      // A terminal execution MUST be finished, its marker must agree with
      // its status, its receipt MUST exist with the matching outcome and a
      // post-marker terminal MUST have consumed its grant. This is also
      // the idempotency check for an ALREADY recovered pair.
      if (!TERMINAL_EXECUTION_STATUSES.has(execution.status) || !finished) {
        throw new DatabaseStateInvalidError(
          `terminal action run ${run.id} has non-terminal execution ${execution.id} (impossible state)`,
        );
      }
      const markerRequired =
        execution.status === "succeeded" ||
        execution.status === "succeeded_unverified" ||
        execution.status === "unknown";
      if (markerRequired !== markered) {
        throw new DatabaseStateInvalidError(
          `execution ${execution.id} marker disagrees with terminal status ${execution.status} (impossible state)`,
        );
      }
      if (execution.error_code === null && execution.status === "failed") {
        throw new DatabaseStateInvalidError(
          `failed execution ${execution.id} has no error code (impossible state)`,
        );
      }
      if (readReceiptOutcome(execution.id) !== execution.status) {
        throw new DatabaseStateInvalidError(
          `terminal execution ${execution.id} has no matching receipt (impossible state)`,
        );
      }
      if (markered && readGrantConsumedAt(execution.id) === null) {
        throw new DatabaseStateInvalidError(
          `markered execution ${execution.id} has an unconsumed grant (impossible state)`,
        );
      }
      return { kind: "unchanged" };
    }
    // cancel_requested (or any non-terminal, non-queued status) is never
    // produced by the Action lifecycle: the cancel boundary settles the run
    // inside the same transaction.
    throw new DatabaseStateInvalidError(
      `action run ${run.id} in status ${run.status} cannot be recovered (impossible state)`,
    );
  }

  /**
   * Apply a NON-unchanged classification: execution CAS + receipt +
   * `action.execution_finished` + run `abandoned` (+ `run.abandoned`
   * event) in the caller's open transaction. Never requeues, never
   * retries, never resends, and never consumes a grant.
   */
  function applyRecoveryAbandon(
    run: RawActionRun,
    execution: RawExecution,
    plan: RecoveryClassification,
    cause: ActionRecoveryCause,
    now: number,
  ): void {
    if (plan.kind === "unchanged") {
      return;
    }
    const outcome = plan.kind === "abandon_pre_marker" ? "failed" : "unknown";
    const proposal = readProposal(execution.proposal_id);
    if (proposal === null) {
      throw new DatabaseStateInvalidError(
        `execution ${execution.id} has no proposal (impossible state)`,
      );
    }
    // Execution CAS first: a grant transaction CASes the marker in the same
    // transaction it consumes the grant, so exactly one side wins and the
    // loser throws and rolls the whole transaction back.
    const movedExecution = db
      .prepare(
        `UPDATE action_executions SET status = ?, error_code = ?, finished_at = ?, updated_at = ?
         WHERE id = ?
           AND status = ?
           AND external_call_started_at IS ${plan.kind === "abandon_pre_marker" ? "NULL" : "NOT NULL"}
           AND finished_at IS NULL`,
      )
      .run(
        outcome,
        plan.kind === "abandon_pre_marker"
          ? ACTION_RECOVERY_PRE_MARKER_ERROR_CODE
          : null,
        now,
        now,
        execution.id,
        execution.status,
      );
    if (movedExecution.changes !== 1) {
      throw new KernelStorageError(
        "kernel_concurrent_conflict",
        "concurrent recovery conflict; retry the transition",
      );
    }
    insertReceipt({
      executionId: execution.id,
      sessionId: execution.session_id,
      proposal,
      outcome,
      preflightRevision: null,
      preflightSnapshotId: null,
      now,
    });
    let seq = (
      db.prepare("SELECT event_seq FROM runs WHERE id = ?").get(run.id) as {
        event_seq: number;
      }
    ).event_seq;
    seq = appendEventInTx(
      db,
      run.id,
      seq,
      "action.execution_finished",
      // The frozen `action.execution_finished` payload is exactly
      // { executionId, outcome }; the recovery/drain cause is carried by the
      // `run.abandoned` payload appended below (never smuggled in here).
      { executionId: execution.id, outcome },
      now,
    );
    const movedRun = db
      .prepare(
        `UPDATE runs SET status = 'abandoned', finished_at = ?
         WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
      )
      .run(now, run.id);
    if (movedRun.changes !== 1) {
      // Execution/receipt/event writes above roll back with this throw.
      throw new KernelStorageError(
        "kernel_concurrent_conflict",
        "concurrent recovery conflict; retry the transition",
      );
    }
    appendEventInTx(db, run.id, seq, "run.abandoned", { cause }, now);
  }

  /**
   * Whole-database Action recovery/drain entry point. ONE transaction:
   * read every Action Run pair, classify ALL of them, and only then apply
   * the abandonments. An impossible pair anywhere throws with ZERO writes.
   */
  function validateAndRecoverActionRuns(
    cause: ActionRecoveryCause,
    now?: number,
  ): ActionRecoverySummary {
    const at = nowMs(now);
    return withImmediate(db, () => {
      const pairs = db
        .prepare(
          `SELECT r.id, r.turn_id, r.session_id, r.attempt, r.status,
                  r.select_on_success, r.event_seq
             FROM runs r
             JOIN action_executions e ON e.action_run_id = r.id
            WHERE r.strategy = 'm5-action'
            ORDER BY r.created_at ASC, r.id ASC`,
        )
        .all() as RawActionRun[];
      // Validation pass: NOTHING is written before every pair is proven.
      const plans: Array<{
        run: RawActionRun;
        execution: RawExecution;
        plan: RecoveryClassification;
      }> = [];
      for (const run of pairs) {
        const execution = readExecutionByRun(run.id);
        if (execution === null) {
          throw new DatabaseStateInvalidError(
            `action run ${run.id} has no execution (impossible state)`,
          );
        }
        plans.push({
          run,
          execution,
          plan: classifyActionPair(run, execution),
        });
      }
      // Mutation pass.
      const summary: ActionRecoverySummary = {
        unchanged: 0,
        recoveredPreMarker: 0,
        recoveredPostMarker: 0,
      };
      for (const { run, execution, plan } of plans) {
        if (plan.kind === "unchanged") {
          summary.unchanged += 1;
          continue;
        }
        applyRecoveryAbandon(run, execution, plan, cause, at);
        if (plan.kind === "abandon_pre_marker") {
          summary.recoveredPreMarker += 1;
        } else {
          summary.recoveredPostMarker += 1;
        }
      }
      return summary;
    });
  }

  /**
   * Single-run safe disposition for the ENGINE generic orphan/watchdog
   * fallback: exactly the same matrix as `validateAndRecoverActionRuns`
   * for one pair, in one transaction. A non-running run is left for the
   * recovery/drain sweep; anything impossible throws fail-closed.
   */
  function recoverAbandonedActionRun(
    runId: string,
    cause: ActionRecoveryCause,
    now?: number,
  ): ActionRunRecoveryResult {
    const id = requireId(runId, "runId");
    const at = nowMs(now);
    return withImmediate(db, () => {
      const run = assertActionRun(id);
      if (run.status !== "running") {
        return { applied: false as const, runStatus: run.status };
      }
      const execution = readExecutionByRun(id);
      if (execution === null) {
        throw new DatabaseStateInvalidError(
          `action run ${id} has no execution (impossible state)`,
        );
      }
      const plan = classifyActionPair(run, execution);
      if (plan.kind === "unchanged") {
        return { applied: false as const, runStatus: run.status };
      }
      applyRecoveryAbandon(run, execution, plan, cause, at);
      return {
        applied: true as const,
        runStatus: "abandoned" as const,
        executionStatus:
          plan.kind === "abandon_pre_marker"
            ? ("failed" as const)
            : ("unknown" as const),
      };
    });
  }

  return {
    startActionRun,
    recordActionPreflightFailure,
    recordActionPreflightBlocked,
    materializeActionPreflightSnapshot,
    consumeActionGrant,
    cancelActionRun,
    finishActionExecution,
    runActionPreflight,
    getActionRunView,
    validateAndRecoverActionRuns,
    recoverAbandonedActionRun,
  };
}

export type ActionExecutionService = ReturnType<
  typeof createActionExecutionService
>;

/* ------------------------------------------------------------------ */
/* Authoritative read adapter over the EXISTING Calendar binding        */
/* ------------------------------------------------------------------ */

/** Display-title bound accepted by ActionAuthoritativeObservationSchema. */
const MAX_ACTION_OBSERVATION_TITLE = 128;

/**
 * Map a fixed Calendar/MCP failure code onto the closed
 * `ActionPreflightRead` classification. Unknown codes fail closed as
 * `unavailable`; no raw code, message or provider detail is ever returned.
 */
function classifyCalendarReadCode(code: string): ActionPreflightRead {
  switch (code) {
    case "mcp_schema_mismatch":
    case "calendar_response_invalid":
    case "calendar_range_invalid":
      return { status: "schema_invalid" };
    default:
      // mcp_unavailable, mcp_binding_not_allowed, calendar_upstream_error,
      // connection resets, unknown codes: never distinguishable as data.
      return { status: "unavailable" };
  }
}

export interface CalendarActionReadPortOptions {
  /** Raw better-sqlite3 handle (same database, no open transaction here). */
  readonly db: Database.Database;
  /** EXISTING read-only Calendar binding (same instance as the action). */
  readonly binding: CalendarConnectorPort;
  /** Durable private canonicalKey -> get target store (production store). */
  readonly targetStore: CalendarTargetStore;
  /** Authority clock; defaults to Date.now(). */
  readonly now?: () => number;
}

/**
 * Build the concrete {@link ActionPreflightReadPort} over the EXISTING
 * Calendar binding and durable private target store — no second read path,
 * no OAuth/pin binding, no external write.
 *
 * Exact boundaries:
 * - resolves `targetResourceId` through the durable private store only; no
 *   provider id ever appears in a request, result or error,
 * - converts the SAME normalized event through the existing
 *   `toCalendarObservation` conversion (identical NFC/hash normalization to
 *   the persisted Snapshot/rN), so the derived source-revision key compares
 *   exactly like a materialized observation,
 * - a genuine `deleted` event is passed through as the authoritative
 *   `deleted` observation (the service blocks it) — nothing is ever
 *   synthesized, defaulted or deleted locally,
 * - respects abort: an already-aborted call NEVER reaches the connector,
 * - classifies every failure into the closed read vocabulary.
 */
export function createCalendarActionReadPort(
  options: CalendarActionReadPortOptions,
): ActionPreflightReadPort {
  const { db, binding, targetStore } = options;
  const now = options.now ?? (() => Date.now());
  return {
    async read(request, signal): Promise<ActionPreflightRead> {
      // Abort is respected BEFORE any upstream call (no read is issued).
      if (signal?.aborted === true) {
        throw new RepositoryValidationError("calendar action read aborted");
      }
      const row = db
        .prepare(
          "SELECT canonical_key FROM resources WHERE id = ? AND connector_instance_id = ?",
        )
        .get(request.targetResourceId, request.connectorInstanceId) as
        | { canonical_key: string }
        | undefined;
      if (row === undefined) {
        return { status: "schema_invalid" };
      }
      let target: CalendarGetTarget | undefined;
      try {
        target = targetStore.get(row.canonical_key);
      } catch {
        return { status: "schema_invalid" };
      }
      if (target === undefined) {
        return { status: "schema_invalid" };
      }
      let result: CalendarGetPortResult;
      try {
        result = await binding.get(target, {
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return { status: "unavailable" };
      }
      if (!result.ok) {
        return classifyCalendarReadCode(result.code);
      }
      const event = result.event;
      // Exact same-target binding: an observation for another resource or
      // another connector instance can NEVER verify this execution.
      if (
        event.canonicalKey !== row.canonical_key ||
        binding.connectorInstanceId !== request.connectorInstanceId
      ) {
        return { status: "schema_invalid" };
      }
      const observation = toCalendarObservation(
        event,
        binding.connectorInstanceId,
        now(),
      );
      const title = observation.title;
      return {
        status: "ok",
        observation: {
          connectorInstanceId: binding.connectorInstanceId,
          resourceCanonicalKey: event.canonicalKey,
          title:
            title === null
              ? null
              : title.slice(0, MAX_ACTION_OBSERVATION_TITLE),
          text: observation.text.normalize("NFC"),
          sourceRevision: observation.sourceRevision ?? null,
          // Real upstream status, including a genuine `deleted` (which the
          // service blocks as stale) — never synthesized locally.
          eventStatus: event.status,
          observedAt: observation.observedAt,
        },
      };
    },
  };
}

export interface CalendarActionTargetResolverOptions {
  readonly db: Database.Database;
  readonly targetStore: CalendarTargetStore;
}

/**
 * Durable host-private `canonicalKey` -> get-target resolver for the Action
 * strategy: the SAME private store the search path writes, so no public id,
 * model input or provider id is ever needed to address the write target.
 */
export function createCalendarActionTargetResolver(
  options: CalendarActionTargetResolverOptions,
): (canonicalKey: string) => CalendarGetTarget | undefined {
  const { db, targetStore } = options;
  const statement = db.prepare(
    "SELECT 1 AS present FROM resources WHERE canonical_key = ? LIMIT 1",
  );
  return (canonicalKey: string): CalendarGetTarget | undefined => {
    const row = statement.get(canonicalKey) as { present: number } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return targetStore.get(canonicalKey);
  };
}
