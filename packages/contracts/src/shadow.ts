import { z } from "zod";
import { AutonomyScopeSchema } from "./autonomy.js";
import { UnixMsSchema, UuidSchema } from "./ids.js";

/**
 * AV02 shadow-deliberation durable core contracts (kernel-internal handoff).
 *
 * A SHADOW job reasons ABOUT policy state but NEVER executes: model
 * proposals never become execution authority. There is NO grant, permission,
 * budget, bypass, calendar, ToolBroker, child-process, or device field
 * anywhere in these contracts — `z.strictObject` rejects such unknown
 * fields outright. A recorded `permission` purpose stays a CLAIM: the CODE
 * policy mapping (`ShadowPolicyCodeSchema`) records `missing_grant` /
 * `wish_not_command` / `external_no_authority`, but a recorded permission
 * NEVER becomes a grant and NOTHING here can trigger execution.
 *
 * Borrowed bounds (documented, not newly measured): reason/uncertainty/
 * counterargument/completion caps at 500 code points (borrowed from the
 * fixed API error message cap); evidence-id list max 32 (borrowed from the
 * memory candidate cap family); task-draft title 256 (borrowed from the
 * `calendar.create` title cap); list limits default 50 / max 100 (borrowed
 * from history pagination); scope strings cap at 128 (borrowed from the
 * strategy-name length cap). No new model / threshold / authority settings
 * are introduced here; there is no model-selection field at all.
 */

function codePointsMax(maxCp: number): (value: string) => boolean {
  return (value: string): boolean => Array.from(value).length <= maxCp;
}

/** Durable shadow-job source kind (policy change vs explicit request). */
export const ShadowJobKindSchema = z.enum([
  "policy_change",
  "explicit_request",
]);
export type ShadowJobKind = z.infer<typeof ShadowJobKindSchema>;

/**
 * Durable shadow-job lifecycle. `pending` awaits a worker claim; `claimed`
 * freezes full context + epochs under a lease; `completed` stores a
 * validated MODEL decision SEPARATE from the CODE policy (shadow only, zero
 * execution); `held`/`failed`/`cancelled` are terminal for that job — new
 * work always arrives as a NEW job, never a bulk replay.
 */
export const ShadowJobStatusSchema = z.enum([
  "pending",
  "claimed",
  "completed",
  "held",
  "failed",
  "cancelled",
]);
export type ShadowJobStatus = z.infer<typeof ShadowJobStatusSchema>;

/**
 * CODE-computed policy for a completed job (never model-chosen, never a
 * grant): `missing_grant` / `wish_not_command` / `external_no_authority`
 * name why an `execute` proposal stays unexecuted (a recorded permission
 * CLAIM never removes `missing_grant`: there is no runtime grant anywhere
 * in the shadow core); `needs_clarification` / `no_action` mirror `ask` /
 * `do-nothing`; `shadow_only` mirrors `hold`.
 */
export const ShadowPolicyCodeSchema = z.enum([
  "shadow_only",
  "missing_grant",
  "wish_not_command",
  "external_no_authority",
  "needs_clarification",
  "no_action",
]);
export type ShadowPolicyCode = z.infer<typeof ShadowPolicyCodeSchema>;

/**
 * Fixed REDACTED hold/fence reasons (closed set, no free text, no user
 * content): late completions are HELD with one of these, never failed
 * noisily and never retried implicitly.
 */
export const ShadowHoldReasonSchema = z.enum([
  "control_paused",
  "control_version_drift",
  "scope_epoch_drift",
  "target_changed",
  "target_inapplicable",
  "lease_expired",
  "lease_mismatch",
  "aborted_foreground",
  "context_too_large",
  "requested_while_paused",
  "restart_interrupted",
]);
export type ShadowHoldReason = z.infer<typeof ShadowHoldReasonSchema>;

/** Fixed REDACTED failure codes (closed set, no free text, no user content). */
export const ShadowFailCodeSchema = z.enum([
  "model_error",
  "gateway_empty",
  "aborted",
]);
export type ShadowFailCode = z.infer<typeof ShadowFailCodeSchema>;

/* ------------------------------------------------------------------ */
/* Strict MODEL output schema                                           */
/* ------------------------------------------------------------------ */

/**
 * MODEL decision vocabulary. `execute` NEVER executes: it only records a
 * proposal for the CODE policy to classify (always `_noexecution` or a
 * named non-authority code). `do-nothing` is genuinely representable (with
 * a null action), never a fake failure fallback.
 */
export const ShadowDecisionSchema = z.enum([
  "execute",
  "hold",
  "ask",
  "do-nothing",
]);
export type ShadowDecision = z.infer<typeof ShadowDecisionSchema>;

/**
 * Frozen job-context evidence label. Namespaces are disjoint from normal
 * conversation references (`rN`/`mN`): `sP` = purpose records, `sT` = task
 * records, `sM` = permission-claim excerpts, `sF` = prior failure codes,
 * `sR` = REAL retrieved memory snippets frozen at claim (never a claim of
 * "no memory exists": `[]` from recall means no available evidence),
 * `sQ` = the explicit request text frozen at claim (UNTRUSTED requester
 * data, reasoned about but never obeyed; present only for explicit-request
 * jobs created with a `reason`).
 * Arbitrary source ids / foreign-session ids / free-form citations are
 * rejected: evidence MUST be one of the labels frozen into the job context.
 */
export const ShadowEvidenceIdSchema = z.string().regex(/^s[PTMFRQ][1-9]\d*$/, {
  message: "evidence id must be sP/sT/sM/sF/sR/sQ + N",
});
export type ShadowEvidenceId = z.infer<typeof ShadowEvidenceIdSchema>;

/** Descriptive proposed-action kind (structured description only). */
export const ShadowActionKindSchema = z.enum(["local_task", "message", "none"]);
export type ShadowActionKind = z.infer<typeof ShadowActionKindSchema>;

/**
 * LOCAL task draft: an explicit local entity sketch, never a calendar
 * event. `deadline` is accepted ONLY when it matches the EXPLICIT deadline
 * of a task ACTUALLY cited in `evidenceIds` (no creative calendar dates,
 * no window-as-deadline, no borrowing an uncited task's date); the match
 * is enforced by the kernel at completion time.
 */
export const ShadowTaskDraftSchema = z.strictObject({
  title: z.string().min(1).max(256),
  body: z
    .string()
    .min(1)
    .refine(codePointsMax(2000), { message: "body over 2000 code points" })
    .optional(),
  deadline: z.string().min(1).max(128).optional(),
});
export type ShadowTaskDraft = z.infer<typeof ShadowTaskDraftSchema>;

/**
 * Nullable structured proposed action: descriptive kind + summary +
 * optional LOCAL task draft. Strict: grant/permission/budget/bypass or any
 * other unknown field is rejected.
 */
export const ShadowProposedActionSchema = z.strictObject({
  kind: ShadowActionKindSchema,
  summary: z
    .string()
    .min(1)
    .refine(codePointsMax(500), { message: "summary over 500 code points" }),
  taskDraft: ShadowTaskDraftSchema.optional(),
});
export type ShadowProposedAction = z.infer<typeof ShadowProposedActionSchema>;

/**
 * Strict MODEL output: decision + evidence ids + BRIEF reason (bounded, not
 * chain-of-thought) + nullable proposed action + completion/stop conditions
 * + uncertainty + counterargument. Combination validity: `execute` requires
 * a non-null action; `do-nothing` requires a null action; `hold`/`ask`
 * allow either. Unknown fields (grant/permission/budget/bypass/…) are
 * rejected by strictness.
 */
export const ShadowModelOutputSchema = z
  .strictObject({
    decision: ShadowDecisionSchema,
    evidenceIds: z.array(ShadowEvidenceIdSchema).min(1).max(32),
    reason: z.string().min(1).refine(codePointsMax(500), {
      message: "reason over 500 code points (brief, not chain-of-thought)",
    }),
    proposedAction: ShadowProposedActionSchema.nullable(),
    completion: z.string().min(1).refine(codePointsMax(500), {
      message: "completion over 500 code points",
    }),
    stopConditions: z
      .array(
        z.string().min(1).refine(codePointsMax(200), {
          message: "stop condition over 200 code points",
        }),
      )
      .min(1)
      .max(8),
    uncertainty: z.string().min(1).refine(codePointsMax(500), {
      message: "uncertainty over 500 code points",
    }),
    counterargument: z.string().min(1).refine(codePointsMax(500), {
      message: "counterargument over 500 code points",
    }),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const id of value.evidenceIds) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate evidence id ${id}`,
        });
      }
      seen.add(id);
    }
    if (value.decision === "execute" && value.proposedAction === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "execute requires a non-null proposedAction",
      });
    }
    if (value.decision === "do-nothing" && value.proposedAction !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "do-nothing requires a null proposedAction",
      });
    }
  });
export type ShadowModelOutput = z.infer<typeof ShadowModelOutputSchema>;

/* ------------------------------------------------------------------ */
/* Frozen job-context DTO (stored at claim, fenced at completion)       */
/* ------------------------------------------------------------------ */

/** One frozen purpose record: ORIGINAL statement vs interpretation kept apart. */
export const ShadowContextPurposeSchema = z.strictObject({
  label: ShadowEvidenceIdSchema,
  id: UuidSchema,
  version: z.number().int().min(1),
  status: z.enum(["active", "superseded", "revoked", "achieved"]),
  kind: z.string().min(1),
  /** `explicit` = explicit user statement; `inferred` = model inference record. */
  explicitness: z.enum(["explicit", "inferred"]),
  /** `user` / `self` / `external` provenance (wish/self/external reasoned, not obeyed). */
  source: z.string().min(1),
  scope: AutonomyScopeSchema,
  statement: z.string().min(1),
  interpretation: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  supersededBy: UuidSchema.nullable(),
  /** Trusted time applicability at claim (`active` + window at `capturedAt`). */
  applicableAtClaim: z.boolean(),
});
export type ShadowContextPurpose = z.infer<typeof ShadowContextPurposeSchema>;

/** One frozen task record with its lifecycle version. */
export const ShadowContextTaskSchema = z.strictObject({
  label: ShadowEvidenceIdSchema,
  id: UuidSchema,
  version: z.number().int().min(1),
  status: z.enum(["open", "in_progress", "held", "completed", "cancelled"]),
  kind: z.string().min(1),
  speaker: z.string().min(1),
  title: z.string().min(1),
  /** Bounded operative detail (already ≤2000 code points at the source). */
  body: z.string().nullable().default(null),
  deadline: z.string().nullable(),
  parentPurposeId: UuidSchema.nullable(),
  /** Reconsideration condition (held tasks only; null otherwise). */
  reconsiderTrigger: z.string().nullable().default(null),
});
export type ShadowContextTask = z.infer<typeof ShadowContextTaskSchema>;

/** One frozen permission-CLAIM excerpt (unranked; NEVER a grant). */
export const ShadowContextClaimSchema = z.strictObject({
  label: ShadowEvidenceIdSchema,
  purposeId: UuidSchema,
  statement: z.string().min(1),
});
export type ShadowContextClaim = z.infer<typeof ShadowContextClaimSchema>;

/** One frozen prior-failure code (task hold reasons + earlier shadow holds). */
export const ShadowContextFailureSchema = z.strictObject({
  label: ShadowEvidenceIdSchema,
  code: z.string().min(1),
});
export type ShadowContextFailure = z.infer<typeof ShadowContextFailureSchema>;

/**
 * One frozen REAL retrieved-memory snippet (bounded server-side
 * provenance; canonical record ids never cross the model/UI boundary).
 * Constructed ONLY by the server at claim from `recallHook` output.
 */
export const ShadowContextMemorySchema = z.strictObject({
  label: ShadowEvidenceIdSchema,
  snippet: z.string().min(1).refine(codePointsMax(512), {
    message: "memory snippet over 512 code points",
  }),
});
export type ShadowContextMemory = z.infer<typeof ShadowContextMemorySchema>;

/**
 * Frozen full job context: every active policy record (or an HONEST
 * `context_too_large` hold instead of silently dropping permissions /
 * constraints), explicit deadlines verbatim, conflict pairs, control +
 * scope epochs captured at claim.
 */
export const ShadowJobContextSchema = z.strictObject({
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  purposes: z.array(ShadowContextPurposeSchema),
  tasks: z.array(ShadowContextTaskSchema),
  conflictPairs: z.array(z.tuple([UuidSchema, UuidSchema])),
  /** Currently-applicable `constraint`-kind purpose ids (complete list, unranked). */
  activeConstraintIds: z.array(UuidSchema),
  /** Currently-applicable `permission`-kind CLAIM excerpts (complete list, unranked; never grants). */
  permissionClaims: z.array(ShadowContextClaimSchema),
  /** EXPLICIT TASK deadlines only (applicability windows are never deadlines; drafts must cite the task). */
  explicitDeadlines: z.array(z.string().min(1).max(128)),
  priorFailures: z.array(ShadowContextFailureSchema),
  /**
   * REAL retrieved-memory snippets frozen at claim (server-constructed
   * `sR` labels only). Defaults to `[]` so pre-memory stored contexts
   * still parse: `[]` means no available evidence, never "no memory
   * exists". No feedback/heat/mutation ever derives from this list.
   */
  memories: z.array(ShadowContextMemorySchema).max(8).default([]),
  /**
   * UNTRUSTED explicit-request text frozen at claim (citable ONLY as
   * `sQ1`; reasoned about, never obeyed). Null for policy-change jobs and
   * for explicit requests created without a `reason`. Defaults to null so
   * pre-reason stored contexts still parse.
   */
  requestReason: z.string().min(1).max(500).nullable().default(null),
  claimControlVersion: z.number().int().min(1),
  claimScopeEpoch: z.number().int().min(1),
  capturedAt: UnixMsSchema,
});
export type ShadowJobContext = z.infer<typeof ShadowJobContextSchema>;

/* ------------------------------------------------------------------ */
/* Job DTOs                                                             */
/* ------------------------------------------------------------------ */

export const ShadowJobViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  kind: ShadowJobKindSchema,
  status: ShadowJobStatusSchema,
  triggerEvent: z.string().min(1).max(128),
  triggerId: UuidSchema.nullable(),
  /** Stable caller key for explicit requests (null for policy-change jobs). */
  requestKey: UuidSchema.nullable(),
  /** Epochs captured at enqueue (informational; claim epochs fence). */
  controlVersion: z.number().int().min(1),
  scopeEpoch: z.number().int().min(1),
  /** Epochs frozen at claim (completion CAS fences these). */
  claimControlVersion: z.number().int().min(1).nullable(),
  claimScopeEpoch: z.number().int().min(1).nullable(),
  version: z.number().int().min(1),
  leaseOwner: z.string().min(1).max(128).nullable(),
  leaseExpiresAt: UnixMsSchema.nullable(),
  /** CODE policy (set on completion only; never model-chosen). */
  policyCode: ShadowPolicyCodeSchema.nullable(),
  holdReason: ShadowHoldReasonSchema.nullable(),
  failCode: ShadowFailCodeSchema.nullable(),
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type ShadowJobView = z.infer<typeof ShadowJobViewSchema>;

export const ShadowJobListResponseSchema = z.strictObject({
  items: z.array(ShadowJobViewSchema).max(100),
});
export type ShadowJobListResponse = z.infer<typeof ShadowJobListResponseSchema>;

export const ShadowJobEventSchema = z.strictObject({
  seq: z.number().int().min(1),
  event: z.enum([
    "enqueued",
    "claimed",
    "completed",
    "held",
    "failed",
    "cancelled",
    "superseded",
  ]),
  fromStatus: ShadowJobStatusSchema.nullable(),
  toStatus: ShadowJobStatusSchema,
  note: z.string().max(500).nullable(),
  createdAt: UnixMsSchema,
});
export type ShadowJobEvent = z.infer<typeof ShadowJobEventSchema>;

export const ShadowJobEventsResponseSchema = z.strictObject({
  jobId: UuidSchema,
  events: z.array(ShadowJobEventSchema),
});
export type ShadowJobEventsResponse = z.infer<
  typeof ShadowJobEventsResponseSchema
>;

/**
 * Deliberation read envelope for `GET .../shadow-jobs/:jobId/context`:
 * the frozen claim-time context PLUS the stored MODEL decision (null
 * until a fenced completion stores one). The decision is a frozen
 * record shown NEXT TO the CODE policy (`ShadowJobView.policyCode`);
 * it never confers execution authority.
 */
export const ShadowJobDeliberationSchema = z.strictObject({
  context: ShadowJobContextSchema,
  modelDecision: ShadowModelOutputSchema.nullable(),
});
export type ShadowJobDeliberation = z.infer<typeof ShadowJobDeliberationSchema>;

/** Durable inbox row (session-owned; paused-time rows are skipped, never replayed). */
export const ShadowInboxItemSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  kind: ShadowJobKindSchema,
  triggerEvent: z.string().min(1).max(128),
  triggerId: UuidSchema.nullable(),
  controlVersion: z.number().int().min(1),
  scopeEpoch: z.number().int().min(1),
  disposition: z.enum(["recorded", "consumed", "skipped"]),
  jobId: UuidSchema.nullable(),
  createdAt: UnixMsSchema,
});
export type ShadowInboxItem = z.infer<typeof ShadowInboxItemSchema>;

/* ------------------------------------------------------------------ */
/* Request DTOs (kernel-internal; HTTP comes from a later worker)       */
/* ------------------------------------------------------------------ */

/** Explicit deliberation request: scope-bound, never a timer/poll/catchup. */
export const ShadowExplicitRequestSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  reason: z
    .string()
    .min(1)
    .refine(codePointsMax(500), { message: "reason over 500 code points" })
    .optional(),
});
export type ShadowExplicitRequest = z.infer<typeof ShadowExplicitRequestSchema>;

/** Foreground abort / fence hold (fixed redacted reason only). */
export const ShadowHoldRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  reason: ShadowHoldReasonSchema,
});
export type ShadowHoldRequest = z.infer<typeof ShadowHoldRequestSchema>;

/** Terminal failure marker (fixed redacted code only). */
export const ShadowFailRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  code: ShadowFailCodeSchema,
});
export type ShadowFailRequest = z.infer<typeof ShadowFailRequestSchema>;

/** Explicit-request idempotency scope: one key space per owning session. */
export function shadowRequestScope(sessionId: string): string {
  return `session:${UuidSchema.parse(sessionId)}:shadow-request`;
}

/** Fixed shadow error codes (transport mapping is a later-service concern). */
export const ShadowErrorCodeSchema = z.enum([
  "shadow_version_conflict",
  "shadow_state_conflict",
  "shadow_lease_conflict",
]);
export type ShadowErrorCode = z.infer<typeof ShadowErrorCodeSchema>;
