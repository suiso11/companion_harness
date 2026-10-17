import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";
import { SourceRevisionSchema } from "./references.js";

/**
 * M5 Action contracts (§18, C16): immutable ActionProposal, ActionExecution,
 * one-shot ActionExecutionGrant, ActionReceipt, the exact
 * `calendar.reschedule` input (start / end fields ONLY), the strict
 * approve/reject/202 HTTP DTOs, and the seven non-terminal Action RunEvent
 * payloads (envelope registries live in `./events.js`).
 *
 * EXTRA (contracts only — no service/DB implementation yet):
 *
 * AMBIGUITY (plan §18.3 gives exact proposal fields but no preview
 * sub-schema): the deterministic connector-generated preview is bounded to a
 * single strict `{ summary }` object. Secrets and upstream ids are never
 * present; §18.8 structural-summary payloads carry internal proposal /
 * execution ids (allowed) but no other raw ids, content, or secrets.
 */

/** The only write tool in M5 (§18.1). Editable fields: start / end only. */
export const CALENDAR_RESCHEDULE_TOOL_NAME = "calendar.reschedule" as const;
export const CalendarRescheduleToolNameSchema = z.literal(
  CALENDAR_RESCHEDULE_TOOL_NAME,
);

/**
 * M6 opt-in creation tool (agreed extension of §18.1, normal TIMED events
 * only). Exact input: `{ title, start, end }` ONLY — no allDay, attendees,
 * description, recurrence, delete, or edit options. Unknown keys rejected.
 * The host-owned Calendar/account/connector selection is NEVER model input:
 * the tool carries no calendar/account/provider ids.
 */
export const CALENDAR_CREATE_TOOL_NAME = "calendar.create" as const;
export const CalendarCreateToolNameSchema = z.literal(
  CALENDAR_CREATE_TOOL_NAME,
);

/** Discriminated write-tool union (M5 reschedule + M6 opt-in create). */
export const ActionToolNameSchema = z.union([
  CalendarRescheduleToolNameSchema,
  CalendarCreateToolNameSchema,
]);
export type ActionToolName = z.infer<typeof ActionToolNameSchema>;

/**
 * Exact `calendar.reschedule` input: start / end fields ONLY (§18.1).
 * No create / delete / title / description / attendee fields exist and
 * unknown keys are rejected. Exact instant grammar stays in the connector
 * port (opaque non-empty strings here, `calendar_range_invalid` there).
 */
export const CalendarRescheduleToolInputSchema = z
  .strictObject({
    start: z.string().min(1).max(128),
    end: z.string().min(1).max(128),
  })
  .superRefine((value, ctx) => {
    // Cheap structural pre-check only; exact instant/range validation stays
    // in the connector port, mirroring `calendar.search`.
    if (value.start === value.end) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });
export type CalendarRescheduleToolInput = z.infer<
  typeof CalendarRescheduleToolInputSchema
>;

/**
 * Exact `calendar.create` input: `{ title, start, end }` ONLY (M6, normal
 * TIMED creation). Title is a bounded non-empty Unicode string (user
 * semantics preserved verbatim); start/end are opaque non-empty strings
 * here with exact RFC3339-explicit-offset / positive-duration validation in
 * the connector port (mirroring `calendar.reschedule`). No allDay,
 * attendees, description, recurrence, or provider ids exist here and unknown
 * keys are rejected.
 */
export const CalendarCreateToolInputSchema = z
  .strictObject({
    title: z.string().min(1).max(256),
    start: z.string().min(1).max(128),
    end: z.string().min(1).max(128),
  })
  .superRefine((value, ctx) => {
    if (value.start === value.end) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });
export type CalendarCreateToolInput = z.infer<
  typeof CalendarCreateToolInputSchema
>;

/** Discriminated approved-input union (per-tool exact shape). */
export const ActionToolInputSchema = z.union([
  CalendarRescheduleToolInputSchema,
  CalendarCreateToolInputSchema,
]);
export type ActionToolInput = z.infer<typeof ActionToolInputSchema>;

/** Proposal lifecycle status (§18.3). Expiry is a repository-time check. */
export const ActionProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export type ActionProposalStatus = z.infer<typeof ActionProposalStatusSchema>;

/** ActionExecution status transition vocabulary (exact §18.5). */
export const ActionExecutionStatusSchema = z.enum([
  "queued",
  "preflight",
  "executing",
  "succeeded",
  "succeeded_unverified",
  "blocked_stale",
  "failed",
  "unknown",
]);
export type ActionExecutionStatus = z.infer<typeof ActionExecutionStatusSchema>;

/** Final receipt outcome vocabulary (exact §18.7). */
export const ActionReceiptOutcomeSchema = z.enum([
  "succeeded",
  "succeeded_unverified",
  "blocked_stale",
  "failed",
  "unknown",
]);
export type ActionReceiptOutcome = z.infer<typeof ActionReceiptOutcomeSchema>;

/**
 * Fixed safe redacted Action error codes (§18.5/§18.6): preflight
 * authoritative-read failure, cancel accepted before the external marker,
 * definite connector `definite_failure` write terminal, restart-recovery /
 * drain abandonment of an execution that never reached the external marker,
 * and fail-closed impossible-state detection. No raw errors pass.
 */
export const M5_ACTION_ERROR_CODES = [
  "action_preflight_failed",
  "action_cancelled_before_write",
  "action_write_failed",
  "action_recovery_abandoned_before_write",
  "database_state_invalid",
] as const;
export type M5ActionErrorCode = (typeof M5_ACTION_ERROR_CODES)[number];
export const M5ActionErrorCodeSchema = z.enum(M5_ACTION_ERROR_CODES);

/** Proposal validity window: expires exactly 15 minutes after creation. */
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

/** Deterministic safe preview: a single bounded summary line (see above). */
export const ActionProposalPreviewSchema = z.strictObject({
  summary: z.string().min(1).max(1024),
});
export type ActionProposalPreview = z.infer<typeof ActionProposalPreviewSchema>;

/**
 * Immutable ActionProposal (exact §18.3 fields + M6 create extension). Only
 * status / resolvedAt / decisionTurnId may ever be written by a repository;
 * input, target, expectedRevision, preview, and hash are immutable content.
 *
 * M6 create rows carry NO existing-event target: `targetRefId`,
 * `targetResourceId`, `basedOnSnapshotId`, and `expectedRevision` are NULL
 * for `calendar.create` (there is no source event, no etag, no preflight
 * snapshot — never a fake placeholder). `calendar.reschedule` rows keep all
 * four NON-NULL exactly as in M5.
 */
export const ActionProposalSchema = z
  .strictObject({
    id: UuidSchema,
    sessionId: UuidSchema,
    sourceTurnId: UuidSchema,
    sourceRunId: UuidSchema,
    decisionTurnId: UuidSchema.nullable(),
    tool: ActionToolNameSchema,
    connectorInstanceId: UuidSchema,
    input: ActionToolInputSchema,
    targetRefId: UuidSchema.nullable(),
    targetResourceId: UuidSchema.nullable(),
    basedOnSnapshotId: UuidSchema.nullable(),
    /** Source revision key (`source_revision` if present else content hash). */
    expectedRevision: SourceRevisionSchema.nullable(),
    preview: ActionProposalPreviewSchema,
    /** Normalized exact content hash (UI button + approval binding). */
    hash: Sha256HexSchema,
    status: ActionProposalStatusSchema,
    createdAt: UnixMsSchema,
    expiresAt: UnixMsSchema,
  })
  .refine((value) => value.expiresAt === value.createdAt + PROPOSAL_TTL_MS, {
    message: "expiresAt must be createdAt + 15min",
    path: ["expiresAt"],
  })
  .superRefine((value, ctx) => {
    if (value.tool === CALENDAR_RESCHEDULE_TOOL_NAME) {
      if (
        value.targetRefId === null ||
        value.targetResourceId === null ||
        value.basedOnSnapshotId === null ||
        value.expectedRevision === null
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "calendar.reschedule proposals require a full existing-event target",
        });
      }
      // Tool/input coupling: a reschedule row must carry the exact
      // reschedule input shape (a create `{ title, start, end }` input is
      // rejected by the strict reschedule schema's unknown-key rule).
      if (!CalendarRescheduleToolInputSchema.safeParse(value.input).success) {
        ctx.addIssue({
          code: "custom",
          message: "calendar.reschedule proposals require a start/end input",
          path: ["input"],
        });
      }
    } else {
      if (
        value.targetRefId !== null ||
        value.targetResourceId !== null ||
        value.basedOnSnapshotId !== null ||
        value.expectedRevision !== null
      ) {
        ctx.addIssue({
          code: "custom",
          message: "calendar.create proposals carry no existing-event target",
        });
      }
      // Tool/input coupling: a create row must carry the exact create
      // input shape (a reschedule `{ start, end }` input is rejected by
      // the strict create schema's missing-title rule).
      if (!CalendarCreateToolInputSchema.safeParse(value.input).success) {
        ctx.addIssue({
          code: "custom",
          message: "calendar.create proposals require a title/start/end input",
          path: ["input"],
        });
      }
    }
  });
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

/** At most one pending Proposal exists per session (§18.3). */
export const MAX_PENDING_PROPOSALS_PER_SESSION = 1 as const;

/**
 * ActionExecution state row (exact §18.5 statuses; marker/terminal CHECK
 * wordings from §18.3 DDL are enforced by the DB, not duplicated here).
 */
export const ActionExecutionSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  proposalId: UuidSchema,
  approvalTurnId: UuidSchema,
  actionRunId: UuidSchema,
  status: ActionExecutionStatusSchema,
  externalCallStartedAt: UnixMsSchema.nullable(),
  finishedAt: UnixMsSchema.nullable(),
  errorCode: M5ActionErrorCodeSchema.nullable(),
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type ActionExecution = z.infer<typeof ActionExecutionSchema>;

/**
 * One-shot exact grant for a single write (§18.5): consumed at most once
 * via `consumedAt IS NULL` CAS; valid only for the granted single write.
 */
export const ActionExecutionGrantSchema = z.strictObject({
  executionId: UuidSchema,
  sessionId: UuidSchema,
  proposalId: UuidSchema,
  proposalHash: Sha256HexSchema,
  tool: ActionToolNameSchema,
  inputHash: Sha256HexSchema,
  consumedAt: UnixMsSchema.nullable(),
  createdAt: UnixMsSchema,
});
export type ActionExecutionGrant = z.infer<typeof ActionExecutionGrantSchema>;

/**
 * ActionReceipt (exact §18.7 items). `succeeded` requires observed +
 * result snapshot; `blocked_stale` keeps preflight revision + snapshot;
 * `failed` / `unknown` / `succeeded_unverified` carry neither observation.
 */
export const ActionReceiptSchema = z
  .strictObject({
    executionId: UuidSchema,
    sessionId: UuidSchema,
    proposalId: UuidSchema,
    proposalHash: Sha256HexSchema,
    outcome: ActionReceiptOutcomeSchema,
    preflightRevision: SourceRevisionSchema.nullable(),
    preflightSnapshotId: UuidSchema.nullable(),
    observedRevision: SourceRevisionSchema.nullable(),
    resultSnapshotId: UuidSchema.nullable(),
    summary: ActionProposalPreviewSchema,
    createdAt: UnixMsSchema,
  })
  .refine(
    (value) => {
      const observedSet = value.observedRevision !== null;
      const resultSet = value.resultSnapshotId !== null;
      switch (value.outcome) {
        case "succeeded":
          return observedSet && resultSet;
        case "blocked_stale":
          return (
            value.preflightRevision !== null &&
            value.preflightSnapshotId !== null &&
            !observedSet &&
            !resultSet
          );
        case "succeeded_unverified":
        case "failed":
        case "unknown":
          return !observedSet && !resultSet;
      }
    },
    { message: "receipt observation fields contradict the outcome" },
  );
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

/* ------------------------------------------------------------------ */
/* Proposal HTTP DTOs (§18.4)                                          */
/* ------------------------------------------------------------------ */

/** Exact approve request body: `{ proposalHash }` only. */
export const ProposalApproveRequestSchema = z.strictObject({
  proposalHash: Sha256HexSchema,
});
export type ProposalApproveRequest = z.infer<
  typeof ProposalApproveRequestSchema
>;

/** Exact reject request body: `{ proposalHash }` only (keyless). */
export const ProposalRejectRequestSchema = z.strictObject({
  proposalHash: Sha256HexSchema,
});
export type ProposalRejectRequest = z.infer<typeof ProposalRejectRequestSchema>;

/** Exact successful approve response: `202` + this strict body. */
export const ProposalApprove202ResponseSchema = z.strictObject({
  proposalId: UuidSchema,
  executionId: UuidSchema,
  runId: UuidSchema,
  status: z.literal("queued"),
});
export type ProposalApprove202Response = z.infer<
  typeof ProposalApprove202ResponseSchema
>;

/** Approve Idempotency-Key scope (validated id must be a UUID v4). */
export function proposalApproveScope(proposalId: string): string {
  return `proposal:${UuidSchema.parse(proposalId)}:approve`;
}

/* ------------------------------------------------------------------ */
/* Proposal list + rejection DTOs (C18 exact, §18.4)                   */
/* ------------------------------------------------------------------ */

/**
 * Session-scoped proposal summary (GET /proposals item). Structural only:
 * the exact immutable content the approval UI renders (hash-backed buttons,
 * §18.9) plus the mutable decision state. Raw provider ids never appear
 * (`preview` is the deterministic start/end-only summary line).
 */
export const ProposalSummarySchema = z
  .strictObject({
    proposalId: UuidSchema,
    tool: ActionToolNameSchema,
    input: ActionToolInputSchema,
    preview: ActionProposalPreviewSchema,
    hash: Sha256HexSchema,
    status: ActionProposalStatusSchema,
    createdAt: UnixMsSchema,
    expiresAt: UnixMsSchema,
    resolvedAt: UnixMsSchema.nullable(),
    decisionTurnId: UuidSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    // Tool/input coupling (same rule as `ActionProposalSchema`): the
    // summary must carry the exact per-tool input shape, so contract
    // consumers can never accept an impossible tool/input combination.
    const expected =
      value.tool === CALENDAR_RESCHEDULE_TOOL_NAME
        ? CalendarRescheduleToolInputSchema.safeParse(value.input)
        : CalendarCreateToolInputSchema.safeParse(value.input);
    if (!expected.success) {
      ctx.addIssue({
        code: "custom",
        message:
          value.tool === CALENDAR_RESCHEDULE_TOOL_NAME
            ? "calendar.reschedule proposals require a start/end input"
            : "calendar.create proposals require a title/start/end input",
        path: ["input"],
      });
    }
  });
export type ProposalSummary = z.infer<typeof ProposalSummarySchema>;

/** Max proposal summaries served in one list page (bounded read). */
export const MAX_PROPOSAL_LIST_ITEMS = 100;

export const ProposalsListResponseSchema = z.strictObject({
  proposals: z.array(ProposalSummarySchema).max(MAX_PROPOSAL_LIST_ITEMS),
});
export type ProposalsListResponse = z.infer<typeof ProposalsListResponseSchema>;

/**
 * Exact reject response (keyless, state-idempotent): the deterministic
 * rejected state. Repeat rejects return the SAME body (exactly one
 * `action_rejection` Turn ever exists) with 200; a body never mutates.
 */
export const ProposalRejectResponseSchema = z.strictObject({
  proposalId: UuidSchema,
  status: z.literal("rejected"),
  decisionTurnId: UuidSchema,
  resolvedAt: UnixMsSchema,
});
export type ProposalRejectResponse = z.infer<
  typeof ProposalRejectResponseSchema
>;

/* ------------------------------------------------------------------ */
/* Execution / receipt view (C22 approval UX reads, §18.5/§18.7)       */
/* ------------------------------------------------------------------ */

/**
 * Safe receipt projection for the approval UX: the final outcome plus the
 * deterministic safe summary ONLY. Observation fields (revision keys,
 * snapshot ids) are deliberately absent — they are technical state the UI
 * never needs and must never render.
 */
export const ActionReceiptViewSchema = z.strictObject({
  outcome: ActionReceiptOutcomeSchema,
  summary: ActionProposalPreviewSchema,
  createdAt: UnixMsSchema,
});
export type ActionReceiptView = z.infer<typeof ActionReceiptViewSchema>;

/**
 * ORIGINAL-only session citation label (BEFORE evidence navigation).
 *
 * Display metadata resolved from the proposal's OWN immutable
 * `target_ref_id` plus session ownership: the `rN` ordinal of the exact
 * staged source SessionReference. It is the pre-write (BEFORE) snapshot
 * reference and NEVER a verified AFTER claim, NEVER a new model evidence
 * grant, and NEVER parsed from preview prose. Raw provider ids / UUID
 * snapshot ids are never exposed through this label.
 */
export const ActionTargetCitationSchema = z
  .string()
  .min(2)
  .max(11)
  .regex(/^r[1-9][0-9]*$/, {
    message: "target citation must be a session rN label (e.g. r1)",
  });
export type ActionTargetCitation = z.infer<typeof ActionTargetCitationSchema>;

/**
 * Session-scoped execution + receipt read for ONE proposal (C22). Carries
 * the actual persisted execution status, whether the external-call marker is
 * committed (the exact Stop boundary: cancel is only possible before it),
 * and the receipt once terminal. A proposal that was never approved has
 * `runId`/`status`/`receipt` null and `markerCommitted` false.
 */
export const ProposalExecutionViewSchema = z.strictObject({
  proposalId: UuidSchema,
  proposalStatus: ActionProposalStatusSchema,
  runId: UuidSchema.nullable(),
  status: ActionExecutionStatusSchema.nullable(),
  /** True once `external_call_started_at` is committed (§18.5 marker). */
  markerCommitted: z.boolean(),
  /**
   * True only while an execution is live AND the marker is not committed:
   * the exact contextual-Stop boundary. Never true after the marker and
   * never true for a terminal execution.
   */
  cancellable: z.boolean(),
  /** Fixed safe redacted code when the execution failed; null otherwise. */
  errorCode: M5ActionErrorCodeSchema.nullable(),
  receipt: ActionReceiptViewSchema.nullable(),
  /**
   * ORIGINAL-only session citation label (BEFORE evidence navigation),
   * resolved from the proposal's OWN immutable `target_ref_id` plus session
   * ownership. Present even before any execution exists (proposal metadata,
   * not execution state). The verified AFTER citation (if any) comes only
   * from the authoritative `run.result` via `runResultToAnswerParts` when
   * the outcome is `succeeded` — never from this field.
   */
  targetCitation: ActionTargetCitationSchema,
});
export type ProposalExecutionView = z.infer<typeof ProposalExecutionViewSchema>;

/* ------------------------------------------------------------------ */
/* M5 Action RunEvent payloads (§18.8, non-final extension)            */
/* ------------------------------------------------------------------ */

/** Exact M5 action event types — seven non-terminal types, no `rejected`. */
export const M5_ACTION_EVENT_TYPES = [
  "action.proposed",
  "action.approved",
  "action.preflight_started",
  "action.preflight_failed",
  "action.preflight_blocked",
  "action.execution_started",
  "action.execution_finished",
] as const;
export type M5ActionEventType = (typeof M5_ACTION_EVENT_TYPES)[number];
export const M5ActionEventTypeSchema = z.enum(M5_ACTION_EVENT_TYPES);

/**
 * Origin mapping (§18.8): `action.proposed` belongs to the originating
 * Agent Run (before terminal); all six remaining types belong to the
 * deterministic Action Run (`action.approved` is an Action Run event,
 * never an Agent Run event). There is deliberately NO `action.rejected`
 * RunEvent — rejection is proposal state + `action_rejection` Turn only.
 */
export const ActionProposedPayloadSchema = z.strictObject({
  proposalId: UuidSchema,
  proposalHash: Sha256HexSchema,
  tool: ActionToolNameSchema,
});

export const ActionApprovedPayloadSchema = z.strictObject({
  proposalId: UuidSchema,
  proposalHash: Sha256HexSchema,
  executionId: UuidSchema,
});

export const ActionPreflightStartedPayloadSchema = z.strictObject({
  executionId: UuidSchema,
});

export const ActionPreflightFailedPayloadSchema = z.strictObject({
  executionId: UuidSchema,
  errorCode: M5ActionErrorCodeSchema,
});

export const ActionPreflightBlockedPayloadSchema = z.strictObject({
  executionId: UuidSchema,
  preflightRevision: SourceRevisionSchema,
  preflightSnapshotId: UuidSchema,
});

export const ActionExecutionStartedPayloadSchema = z.strictObject({
  executionId: UuidSchema,
});

export const ActionExecutionFinishedPayloadSchema = z.strictObject({
  executionId: UuidSchema,
  outcome: ActionReceiptOutcomeSchema,
});

/* ------------------------------------------------------------------ */
/* M6 calendar.create stable client event id (Google events.insert `id`) */
/* ------------------------------------------------------------------ */

/**
 * Stable Google client-assigned event id for exactly one approved
 * `calendar.create` execution. Derived deterministically from the immutable
 * execution id (UUID without dashes: 32 lowercase hex chars) BEFORE dispatch
 * and never model input. Hex `[0-9a-f]` is a strict subset of Google's
 * allowed base32hex `[a-v0-9]` alphabet and 32 chars sit inside the 5..1024
 * length bound, so the derived id is always provider-legal. One execution
 * owns exactly one id; one consumed grant performs exactly one insert with
 * it. Repeated approval of the same hash/key returns the original run, so
 * the same id is never re-inserted.
 */
export const CREATE_STABLE_EVENT_ID_LENGTH = 32 as const;
export const CreateStableEventIdSchema = z
  .string()
  .min(5)
  .max(1024)
  .regex(/^[a-v0-9]+$/, {
    message: "stable create event id must be Google base32hex, 5..1024 chars",
  });
export type CreateStableEventId = z.infer<typeof CreateStableEventIdSchema>;

/**
 * Derive the stable insert id for an approved create execution. Throws on a
 * non-UUID execution id (fail closed, never a guessed id).
 */
export function deriveCreateEventId(executionId: string): string {
  const id = UuidSchema.parse(executionId).toLowerCase().replace(/-/g, "");
  return CreateStableEventIdSchema.parse(id);
}
