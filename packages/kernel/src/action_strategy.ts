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

import type { RunResult } from "@companion/contracts";
import {
  CALENDAR_RESCHEDULE_TOOL_NAME,
  CalendarRescheduleToolInputSchema,
  parseRunResult,
  UuidSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ActionAuthoritativeObservationSchema,
  type ActionExecutionService,
  type ActionFinishRequest,
  type ActionFinishResult,
  type ActionPreflightReadPort,
  type CommittedGrantMeta,
} from "./action_executions.js";
import type { CalendarGetTarget } from "./calendar_tools.js";
import { RepositoryValidationError } from "./errors.js";
import type { RunStrategy, RunStrategyContext } from "./strategy.js";
import { StrategyError } from "./strategy.js";

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

/**
 * T6 ID-free fallback preview: the deterministic stored preview summary
 * without the internal tool-name prefix and without any UUID. Used only
 * when no persisted `result_json` exists (failed/unknown runs persist
 * none); structured audit fields keep all IDs.
 */
function readRenderedPreviewForRun(
  db: Database.Database,
  runId: string,
): string {
  try {
    const row = db
      .prepare(
        `SELECT ap.preview_json FROM action_executions ae
         JOIN action_proposals ap ON ap.id = ae.proposal_id
         WHERE ae.action_run_id = ?`,
      )
      .get(runId) as { preview_json: string } | undefined;
    if (row === undefined) {
      return "schedule update";
    }
    const parsed = JSON.parse(row.preview_json) as unknown;
    const summary =
      typeof parsed === "object" &&
      parsed !== null &&
      "summary" in parsed &&
      typeof (parsed as { summary: unknown }).summary === "string"
        ? (parsed as { summary: string }).summary
        : "";
    const withoutTool = summary.startsWith("calendar.reschedule:")
      ? summary.slice("calendar.reschedule:".length).trim()
      : summary.trim();
    return withoutTool.length > 0 ? withoutTool : "schedule update";
  } catch {
    return "schedule update";
  }
}

/** T6 ID-free safe outcome fragment for the in-memory fallback result. */
function safeFallbackOutcomeText(outcome: string): string {
  switch (outcome) {
    case "succeeded":
      return "verified and confirmed";
    case "succeeded_unverified":
      return "finished but not verified — please check the external calendar";
    case "blocked_stale":
      return "not applied (source changed) — please check manually";
    case "unknown":
      return "result unknown — please check the external calendar";
    default:
      return "failed — please check manually";
  }
}

/** Normalized intended instants: NFC only (port owns instant grammar). */
function normalizeInstant(value: string): string {
  return value.normalize("NFC");
}

// Strict RFC3339 instant grammar shared with the readonly normalization
// (`packages/connector-calendar/src/time.ts` `parseTimedInstant` plus the
// minute-precision form the dedicated write port accepts in
// `rescheduleWrite.ts` `isStrictCalendarInstant`): explicit `Z`/`±HH:MM`
// offset only, real calendar validation (leap years, month lengths,
// component and offset bounds), NO `Date.parse` permissiveness (rollover
// like `2023-02-30` -> March 2 must reject, never verify). The kernel owns
// this copy so the dependency-inverted direction stays intact
// (kernel never imports `@companion/connector-*`); the convention —
// same instant, strict grammar, invalid fails closed — is defined once in
// the connector and mirrored exactly here.
const STRICT_INSTANT_SECONDS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const STRICT_INSTANT_MINUTES =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

function strictDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** Year-safe UTC epoch ms (`Date.UTC` maps years 0..99 to 1900..1999). */
function strictUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  if (year >= 100) {
    return Date.UTC(year, month - 1, day, hour, minute, second, ms);
  }
  const fixed = new Date(0);
  fixed.setUTCFullYear(year, month - 1, day);
  fixed.setUTCHours(hour, minute, second, ms);
  return fixed.getTime();
}

/**
 * Strict explicit-offset RFC3339 instant to epoch ms, or `undefined`.
 * All-day DATE strings, offset-less strings and impossible calendar values
 * are all `undefined` (fail closed) — never parsed loosely.
 */
function parseStrictInstantMs(value: string): number | undefined {
  const seconds = STRICT_INSTANT_SECONDS.exec(value);
  if (seconds !== null) {
    const year = Number(seconds[1]);
    const month = Number(seconds[2]);
    const day = Number(seconds[3]);
    const hour = Number(seconds[4]);
    const minute = Number(seconds[5]);
    const second = Number(seconds[6]);
    if (month < 1 || month > 12) return undefined;
    if (day < 1 || day > strictDaysInMonth(year, month)) return undefined;
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    // Milliseconds are exactly the first three decimal digits,
    // right-padded (float parsing could round up into the next second).
    const fraction = seconds[7] as string | undefined;
    const ms =
      fraction !== undefined ? Number(fraction.slice(1, 4).padEnd(3, "0")) : 0;
    const zone = seconds[8] as string;
    let offsetMs = 0;
    if (zone !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const offsetHour = Number(zone.slice(1, 3));
      const offsetMinute = Number(zone.slice(4, 6));
      if (offsetHour > 23 || offsetMinute > 59) return undefined;
      offsetMs = sign * (offsetHour * 60 + offsetMinute) * 60_000;
    }
    const epochMs =
      strictUtcMs(year, month, day, hour, minute, second, ms) - offsetMs;
    return Number.isFinite(epochMs) ? epochMs : undefined;
  }
  const minutes = STRICT_INSTANT_MINUTES.exec(value);
  if (minutes === null) return undefined;
  const year = Number(minutes[1]);
  const month = Number(minutes[2]);
  const day = Number(minutes[3]);
  const hour = Number(minutes[4]);
  const minute = Number(minutes[5]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > strictDaysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  const zone = minutes[6] as string;
  let offsetMs = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    offsetMs = sign * (offsetHour * 60 + offsetMinute) * 60_000;
  }
  const epochMs = strictUtcMs(year, month, day, hour, minute, 0, 0) - offsetMs;
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

/**
 * Exact normalized-boundary comparison of the intended start/end against the
 * observed canonical event body. The observation body is the SAME canonical
 * JSON the kernel materializes (`calendarEventBodyText`), so it is parsed as
 * STRICT JSON and the two boundary fields are compared as whole values —
 * never as substrings (a substring test could match a different field value
 * that merely contains the intended one, e.g. `"start":"2024-01-01T09:00"`).
 *
 * Representation-independent: the approved proposal stores the intended
 * instants exactly as staged (e.g. `2026-10-16T15:00:00+09:00`) while the
 * readonly normalization canonicalizes timed bounds to UTC
 * (`2026-10-16T06:00:00.000Z`), so the comparison is SAME-INSTANT (epoch
 * ms) under the strict grammar above — an offset/millis representation
 * difference is NOT a content mismatch. Any parse/field failure yields
 * false (unverified), never a partial claim.
 */
function boundariesMatch(text: string, start: string, end: string): boolean {
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
  if (typeof body.start !== "string" || typeof body.end !== "string") {
    return false;
  }
  if (body.start === start && body.end === end) {
    return true;
  }
  const observedStart = parseStrictInstantMs(body.start);
  const observedEnd = parseStrictInstantMs(body.end);
  const intendedStart = parseStrictInstantMs(start);
  const intendedEnd = parseStrictInstantMs(end);
  if (
    observedStart === undefined ||
    observedEnd === undefined ||
    intendedStart === undefined ||
    intendedEnd === undefined
  ) {
    return false;
  }
  return observedStart === intendedStart && observedEnd === intendedEnd;
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

  const runStrategy: RunStrategy = async (
    ctx: RunStrategyContext,
  ): Promise<RunResult> => {
    const runId = UuidSchema.parse(ctx.run.id);

    // 0) Pickup WITHOUT any consumption decision: the atomic pickup itself
    //    consumes nothing; capability/proposal binding validation happens
    //    before the preflight read and its grant gate below.
    if (options.preflightRead === undefined) {
      throw new RepositoryValidationError(
        "action strategy requires the injected preflight/read port",
      );
    }
    // Pickup is ATOMIC and IDEMPOTENT from the strategy's point of view: the
    // generic scheduler may already have performed the real pickup through
    // `repository.startRun` (which dispatches to this same service) BEFORE
    // launching the configured strategy. In that case `startActionRun`
    // correctly reports `applied:false` (the pair already moved
    // running + preflight) and the strategy MUST NOT pick up again nor
    // abandon the run: it continues from the durable pickup. Only a pair
    // that is genuinely not at the pickup stage (terminal, still queued, or
    // no execution at all) returns the actual persisted state.
    const pickup = service.startActionRun(runId);
    if (!pickup.applied) {
      const view = service.getActionRunView(runId);
      const alreadyPickedUp =
        view.run.status === "running" &&
        view.execution?.status === "preflight" &&
        view.execution.externalCallStartedAt === null;
      if (!alreadyPickedUp) {
        return withPersisted(runId);
      }
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

    // 2) HOSTSIDE TARGET RESOLUTION BEFORE the grant gate: the host-private
    //    target reference is resolved (same durable `resolveTarget` store)
    //    BEFORE `runActionPreflight` can consume the one-shot grant. A
    //    missing target fails through the EXACT real preflight-failure
    //    terminal (failed receipt + run.failed, no marker, UNCONSUMED grant,
    //    zero writes) — the write is never attempted, so a success result is
    //    never claimed for an unattempted write.
    const targetCanonicalKey = readTargetCanonicalKey(db, proposal);
    const resolvedTarget = resolveTarget(targetCanonicalKey);
    if (resolvedTarget === undefined) {
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
    const target = resolvedTarget;

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
      return plainFinish(
        write.status === "definite_failure" ? "failed" : "unknown",
      );
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
      // The connector ITSELF reported `succeeded`, so the write left this
      // process; only the authoritative read-back failed to confirm it. That
      // is exactly `succeeded_unverified` (§18.7) — reporting `unknown` here
      // would misread a committed write as a possibly-not-happened one and
      // drive the readback into the wrong readback/notification branch.
      // Only a connector-returned `unknown` (or a pre-write failure) may ever
      // finish as `unknown`; a write the port already called `succeeded` is
      // never downgraded.
      return unverifiedFinish();
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
      // receipt view (real persisted state, not a fabricated success) with
      // ID-free rendered text (preview + safe outcome only).
      const view = service.getActionRunView(id);
      const outcome =
        view.receipt?.outcome ?? view.execution?.status ?? "failed";
      return parseRunResult({
        version: 1,
        text: `${readRenderedPreviewForRun(db, id)} — ${safeFallbackOutcomeText(outcome)}`,
      });
    }

    function resultOf(finished: ActionFinishResult): RunResult {
      if (finished.applied) {
        return finished.runResult;
      }
      return withPersisted(runId);
    }
  };

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
