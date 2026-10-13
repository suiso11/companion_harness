// C19-C20 deterministic Action strategy (`m5-action` RunStrategy, §18.5/§18.6).
//
// The ONLY model-free RunStrategy in M5: it executes exactly one approval-turn
// `calendar.reschedule` Action Run through the concrete kernel
// ActionExecutionService (startActionRun -> runActionPreflight -> the exact
// one-shot grant gate -> the single external write AFTER the committed marker
// -> authoritative read-back -> finishActionExecution). No model path, no
// fake/noop terminal, no resend.
//
// Exact boundaries implemented:
//
// - `CalendarActionWritePort` — the exact dependency-inverted WRITE port: an
//   explicit readonly `capability` ({tool: 'calendar.reschedule',
//   editableFields exactly ['start','end'], connectorInstanceId,
//   writeEnabled}) validated BEFORE the gate/preflight consumes anything, and
//   one `update(request)` classified exactly as `succeeded` /
//   `definite_failure` / `unknown`. No real provider lives here; hosts inject
//   their own deterministic port. A rejected/throwing `update` after the
//   marker is exactly `unknown` (never `definite_failure`, never a retry).
//
// - `createActionStrategy(options)` — returns the `RunStrategy`. It:
//   1. validates the read+write ports and the binding BEFORE pickup (zero
//      grant consumption happens without an enabled binding),
//   2. picks the run up and runs the authoritative preflight (which may
//      atomically persist blocked_stale / preflight_failed / grant-denied
//      outcomes — the strategy then returns the ACTUAL PERSISTED RunResult
//      read back from `runs.result_json`, never a generic fake),
//   3. on `granted`: resolves the proposal input + host-private target
//      reference hostside, calls the port `update` EXACTLY ONCE (after the
//      committed external-call marker), maps only the connector's own
//      three-value return; exceptions after the gate are `unknown`,
//   4. on connector `succeeded`: performs the §18.7 authoritative read-back
//      through the SAME injected read port and verifies the intended
//      normalized start/end, the same target identity
//      (connectorInstanceId + resourceCanonicalKey) and a non-deleted event;
//      any mismatch or port failure maps to `succeeded_unverified` — never a
//      fabricated verified claim (finishVerifiedTerminal fails closed on a
//      deleted observation accordingly),
//   5. finishes via `finishActionExecution` (running CAS + receipt + events
//      + terminal in the exact same transactions each outcome already
//      implements) and returns the ACTUAL RunResult it persisted.
//
// No `await` ever spans an open DB transaction: port reads/writes happen
// strictly outside transactions, exactly like the preflight step.

import {
  CALENDAR_RESCHEDULE_TOOL_NAME,
  CalendarRescheduleToolInputSchema,
  parseRunResult,
  UuidSchema,
} from "@companion/contracts";
import type { RunResult } from "@companion/contracts";
import { z } from "zod";
import type Database from "better-sqlite3";
import {
  ActionAuthoritativeObservationSchema,
  type ActionExecutionService,
  type ActionFinishRequest,
  type ActionFinishResult,
  type ActionPreflightReadPort,
  type CommittedGrantMeta,
} from "./action_executions.js";
import type {
  RunStrategy,
  RunStrategyContext,
} from "./strategy.js";
import { StrategyError } from "./strategy.js";
import type { CalendarGetTarget } from "./calendar_tools.js";
import { RepositoryValidationError } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Exact injected write port (capability + one classified update)        */
/* ------------------------------------------------------------------ */

/** Exact injected write capability: start/end ONLY, enabled binding. */
export const CalendarActionWriteCapabilitySchema = z
  .strictObject({
    tool: z.literal(CALENDAR_RESCHEDULE_TOOL_NAME),
    /** Exactly these two editable fields, in this order — nothing else. */
    editableFields: z.tuple([z.literal("start"), z.literal("end")]),
    connectorInstanceId: UuidSchema,
    writeEnabled: z.literal(true),
  })
  .refine(
    (value) =>
      value.writeEnabled === true && value.connectorInstanceId.length === 36,
    { message: "write capability must be explicitly enabled" },
  );
export type CalendarActionWriteCapability = z.infer<
  typeof CalendarActionWriteCapabilitySchema
>;

export type CalendarActionWriteRequest = {
  /** The EXACT committed gate meta returned by `consumeActionGrant`. */
  readonly grant: CommittedGrantMeta;
  /** Must equal `grant`-bound proposal tool + connector instance. */
  readonly connectorInstanceId: string;
  readonly tool: typeof CALENDAR_RESCHEDULE_TOOL_NAME;
  /** Normalized (NFC) intended start/end instants, start/end fields ONLY. */
  readonly start: string;
  readonly end: string;
  /** Host-private target reference resolved before the call (no public ids). */
  readonly targetResourceId: string;
  readonly targetCanonicalKey: string;
  readonly target: CalendarGetTarget;
  readonly signal?: AbortSignal | undefined;
};

/** Exact three-value connector return for ONE write. No partial success. */
export type CalendarWriteOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "definite_failure" }
  | { readonly status: "unknown" };

/**
 * The exact injected CalendarActionWritePort. The host chose the connector
 * implementation; the kernel consumes nothing until the committed grant gate.
 * `update` MUST be called at most once per executes/grant and MUST NOT retry.
 */
export interface CalendarActionWritePort {
  readonly capability: CalendarActionWriteCapability;
  update(
    request: CalendarActionWriteRequest,
    signal?: AbortSignal,
  ): Promise<CalendarWriteOutcome>;
}

/* ------------------------------------------------------------------ */
/* Strategy options                                                      */
/* ------------------------------------------------------------------ */

/** Host-private canonicalKey -> `get`-target resolution (same-DB store). */
export type CalendarTargetResolver = (
  canonicalKey: string,
) => CalendarGetTarget | undefined;

export interface ActionStrategyOptions {
  readonly db: Database.Database;
  readonly service: ActionExecutionService;
  /** Required §18.5 read port (preflight AND §18.7 read-back). */
  readonly preflightRead: ActionPreflightReadPort;
  /** Required explicit write port; disabled/unknown bindings are refused. */
  readonly writePort: CalendarActionWritePort;
  /** Durable host-private target resolver (calendar_get_targets store). */
  readonly resolveTarget: CalendarTargetResolver;
}

interface RawProposalForStrategy {
  id: string;
  session_id: string;
  tool: string;
  connector_instance_id: string;
  input_json: string;
  target_resource_id: string;
  target_ref_id: string;
  based_on_snapshot_id: string;
  expected_revision: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/* Narrow hostside helpers (single indexed reads; no transactions)       */
/* ------------------------------------------------------------------ */

function readProposalForRun(
  db: Database.Database,
  runId: string,
): RawProposalForStrategy {
  const row = db
    .prepare(
      `SELECT ap.id, ap.session_id, ap.tool, ap.connector_instance_id,
              ap.input_json, ap.target_resource_id, ap.target_ref_id,
              ap.based_on_snapshot_id, ap.expected_revision, ap.status
       FROM action_executions ae
       JOIN action_proposals ap ON ap.id = ae.proposal_id
       WHERE ae.action_run_id = ?`,
    )
    .get(runId) as RawProposalForStrategy | undefined;
  if (row === undefined) {
    throw new RepositoryValidationError(
      `action run ${runId} has no proposal (impossible state)`,
    );
  }
  return row;
}

function readTargetCanonicalKey(
  db: Database.Database,
  proposal: RawProposalForStrategy,
): string {
  const row = db
    .prepare(
      "SELECT canonical_key FROM resources WHERE id = ? AND connector_instance_id = ?",
    )
    .get(proposal.target_resource_id, proposal.connector_instance_id) as
    | { canonical_key: string }
    | undefined;
  if (row === undefined) {
    throw new RepositoryValidationError(
      "proposal target resource binding missing (impossible state)",
    );
  }
  return row.canonical_key;
}

function readRunResultJson(
  db: Database.Database,
  runId: string,
): RunResult | null {
  const row = db
    .prepare("SELECT result_json FROM runs WHERE id = ?")
    .get(runId) as { result_json: string | null } | undefined;
  if (row === undefined || row.result_json === null) {
    return null;
  }
  return parseRunResult(JSON.parse(row.result_json) as unknown);
}

/** Normalized intended instants: NFC only (port owns instant grammar). */
function normalizeInstant(value: string): string {
  return value.normalize("NFC");
}

/**
 * Exact normalized-boundary comparison of the intended start/end against the
 * observed canonical event body. The observation body is the SAME canonical
 * JSON the kernel materializes (`calendarEventBodyText`), so it is parsed as
 * STRICT JSON and the two boundary fields are compared as whole EXACT values
 * — never as substrings (a substring test could match a different field value
 * that merely contains the intended one, e.g. `"start":"2024-01-01T09:00"`).
 * Any parse/field failure yields false (unverified), never a partial claim.
 */
function boundariesMatch(
  text: string,
  start: string,
  end: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const body = parsed as { start?: unknown; end?: unknown };
  return body.start === start && body.end === end;
}

/* ------------------------------------------------------------------ */
/* The strategy                                                          */
/* ------------------------------------------------------------------ */

/**
 * Create the deterministic `m5-action` RunStrategy. Exactly one approval-turn
 * external write per grant, resolved and verified against the SAME-DB
 * reference model; every terminal outcome is the transaction of the concrete
 * ActionExecutionService (no generic terminalization, no synthetic result).
 */
export function createActionStrategy(
  options: ActionStrategyOptions,
): RunStrategy & { readonly strategyName: "m5-action" } {
  const { db, service, preflightRead, writePort, resolveTarget } = options;

  const runStrategy: RunStrategy = async (ctx: RunStrategyContext): Promise<RunResult> => {
    const runId = UuidSchema.parse(ctx.run.id);

    // 0) Pickup WITHOUT any consumption decision: the atomic pickup itself
    //    consumes nothing; capability/proposal binding validation happens
    //    before the preflight read and its grant gate below.
    if (options.preflightRead === undefined) {
      throw new RepositoryValidationError(
        "action strategy requires the injected preflight/read port",
      );
    }
    const pickup = service.startActionRun(runId);
    if (!pickup.applied) {
      return withPersisted(runId);
    }

    // 1) EXACT binding validation BEFORE preflight/gate: nothing is consumed
    //    unless the write capability is enabled and this run's proposal binds
    //    the EXACT same connector + tool. A non-binding capability fails
    //    closed through the REAL preflight-failure terminal (failed receipt +
    //    run.failed, zero consumption, zero writes) — never a synthetic noop.
    const capability = (() => {
      try {
        return CalendarActionWriteCapabilitySchema.parse(writePort.capability);
      } catch {
        return null;
      }
    })();
    const proposal = readProposalForRun(db, runId);
    const bindingExact =
      capability !== null &&
      proposal.status === "approved" &&
      proposal.tool === CALENDAR_RESCHEDULE_TOOL_NAME &&
      proposal.connector_instance_id === capability.connectorInstanceId;
    if (!bindingExact) {
      const failed = service.recordActionPreflightFailure(runId);
      if (failed.applied) {
        return withPersisted(runId);
      }
      throw new StrategyError("execution_failed");
    }

    // 3) Authoritative preflight + one-shot committed gate in one step.
    const preflight = await service.runActionPreflight(runId, {
      signal: ctx.signal,
    });
    if (preflight.outcome !== "granted") {
      // blocked_stale/preflight_failed/skipped: the exact real terminal is
      // already persisted; return the ACTUAL persisted RunResult.
      return withPersisted(runId);
    }
    const grant = preflight.grant;

    // 4) Hostside resolution AFTER the committed marker, BEFORE the write:
    //    intended normalized instants + host-private target reference.
    const proposedInput = CalendarRescheduleToolInputSchema.parse(
      JSON.parse(proposal.input_json) as unknown,
    );
    const start = normalizeInstant(proposedInput.start);
    const end = normalizeInstant(proposedInput.end);
    if (start.length === 0 || end.length === 0) {
      throw new RepositoryValidationError(
        "proposal start/end instants are empty (impossible state)",
      );
    }
    const targetCanonicalKey = readTargetCanonicalKey(db, proposal);
    const target = resolveTarget(targetCanonicalKey);
    if (target === undefined) {
      return finish({
        outcome: "succeeded_unverified",
        preflightRevision: unverifiedPreflightRevisionOf(proposal),
        preflightSnapshotId: preflight.preflightSnapshotId,
      });
    }

    // 5) THE single external write, exactly once, after the marker commit;
    //    ONLY the port's own three-value return is classified — any
    //    rejection/throw after the gate maps to `unknown`.
    let write: CalendarWriteOutcome;
    try {
      write = await writePort.update(
        {
          grant,
          connectorInstanceId: capability.connectorInstanceId,
          tool: CALENDAR_RESCHEDULE_TOOL_NAME,
          start,
          end,
          targetResourceId: proposal.target_resource_id,
          targetCanonicalKey,
          target,
          signal: ctx.signal,
        },
        ctx.signal,
      );
    } catch {
      write = { status: "unknown" } as const;
    }
    const plainFinish = (outcome: "failed" | "unknown"): RunResult =>
      finish({
        outcome,
        preflightRevision: unverifiedPreflightRevisionOf(proposal),
        preflightSnapshotId: preflight.preflightSnapshotId,
      });
    if (write.status !== "succeeded") {
      return plainFinish(write.status === "definite_failure" ? "failed" : "unknown");
    }

    // 6) §18.7 authoritative read-back: SAME read port, SAME execution.
    //    Verified **only when** the fresh observation binds the same target
    //    identity, is non-deleted, and carries the intended normalized
    //    start/end. Any mismatch or port failure is succeeded_unverified —
    //    never a fabricated verified claim and never a resend.
    const unverifiedFinish = (): RunResult =>
      finish({
        outcome: "succeeded_unverified",
        preflightRevision: proposal.expected_revision,
        preflightSnapshotId: preflight.preflightSnapshotId,
      });
    let readback: Awaited<ReturnType<ActionPreflightReadPort["read"]>>;
    try {
      readback = await preflightRead.read(
        {
          connectorInstanceId: capability.connectorInstanceId,
          targetResourceId: proposal.target_resource_id,
          basedOnSnapshotId: proposal.based_on_snapshot_id,
        },
        ctx.signal,
      );
    } catch {
      return unverifiedFinish();
    }
    if (readback.status !== "ok") {
      return unverifiedFinish();
    }
    let observation: z.infer<typeof ActionAuthoritativeObservationSchema>;
    try {
      observation = ActionAuthoritativeObservationSchema.parse(
        readback.observation,
      );
    } catch {
      return unverifiedFinish();
    }
    const verified =
      observation.connectorInstanceId === capability.connectorInstanceId &&
      observation.resourceCanonicalKey === targetCanonicalKey &&
      observation.eventStatus !== "deleted" &&
      boundariesMatch(observation.text, start, end);
    if (!verified) {
      return plainFinish("unknown");
    }
    return finish({
      outcome: "succeeded",
      observation,
      // The committed preflight materialization happened only after the
      // observed-revision key matched, so the preflight revision is exactly
      // the proposal's expected_revision.
      preflightRevision: proposal.expected_revision,
      preflightSnapshotId: preflight.preflightSnapshotId,
    });

    /* ----- helpers ----- */

    /** Finish through the ONE concrete terminal facility; verbatim result. */
    function finish(request: ActionFinishRequest): RunResult {
      const finished = service.finishActionExecution(runId, request);
      return resultOf(finished);
    }

    /** The actual persisted RunResult (parse the stored candidate). */
    function withPersisted(id: string): RunResult {
      const persisted = readRunResultJson(db, id);
      if (persisted !== null) {
        return persisted;
      }
      // Failed runs persist no result_json: cite the ACTUAL outcome via the
      // receipt view (real persisted state, not a fabricated success).
      const view = service.getActionRunView(id);
      const outcome =
        view.receipt?.outcome ?? view.execution?.status ?? "failed";
      return parseRunResult({
        version: 1,
        text: `calendar.reschedule ${outcome} (proposalId=${view.execution?.proposalId ?? "unknown"})`,
      });
    }

    function resultOf(finished: ActionFinishResult): RunResult {
      if (finished.applied) {
        return finished.runResult;
      }
      return withPersisted(runId);
    }
  }

  const strategy = runStrategy as RunStrategy & {
    readonly strategyName: "m5-action";
  };
  Object.defineProperty(strategy, "strategyName", {
    value: "m5-action" as const,
    enumerable: true,
  });
  return strategy;
}

/**
 * The preflight materialization already carries the proposal's
 * `expected_revision` as the fresh preflight key, so the finish plain
 * terminals cite THAT exact revision key (never a preview-derived value).
 */
function unverifiedPreflightRevisionOf(
  proposal: RawProposalForStrategy,
): string {
  return proposal.expected_revision;
}
