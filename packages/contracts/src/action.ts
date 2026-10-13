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
export const CalendarRescheduleToolNameSchema =
  z.literal(CALENDAR_RESCHEDULE_TOOL_NAME);

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
 * Immutable ActionProposal (exact §18.3 fields). Only status / resolvedAt /
 * decisionTurnId may ever be written by a repository; input, target,
 * expectedRevision, preview, and hash are immutable content.
 */
export const ActionProposalSchema = z
  .strictObject({
    id: UuidSchema,
    sessionId: UuidSchema,
    sourceTurnId: UuidSchema,
    sourceRunId: UuidSchema,
    decisionTurnId: UuidSchema.nullable(),
    tool: CalendarRescheduleToolNameSchema,
    connectorInstanceId: UuidSchema,
    input: CalendarRescheduleToolInputSchema,
    targetRefId: UuidSchema,
    targetResourceId: UuidSchema,
    basedOnSnapshotId: UuidSchema,
    /** Source revision key (`source_revision` if present else content hash). */
    expectedRevision: SourceRevisionSchema,
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
  tool: CalendarRescheduleToolNameSchema,
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
export type ProposalRejectRequest = z.infer<
  typeof ProposalRejectRequestSchema
>;

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
export const ProposalSummarySchema = z.strictObject({
  proposalId: UuidSchema,
  tool: CalendarRescheduleToolNameSchema,
  input: CalendarRescheduleToolInputSchema,
  preview: ActionProposalPreviewSchema,
  hash: Sha256HexSchema,
  status: ActionProposalStatusSchema,
  createdAt: UnixMsSchema,
  expiresAt: UnixMsSchema,
  resolvedAt: UnixMsSchema.nullable(),
  decisionTurnId: UuidSchema.nullable(),
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
export type ProposalRejectResponse = z.infer<typeof ProposalRejectResponseSchema>;

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
  tool: CalendarRescheduleToolNameSchema,
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
