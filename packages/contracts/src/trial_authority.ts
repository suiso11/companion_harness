import { z } from "zod";
import { AutonomyScopeSchema } from "./autonomy.js";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";

/**
 * Schema12 AUTONOMY TRIAL AUTHORITY domain (DATA-only stage, explicit grant).
 *
 * A trial proposal is DATA only. One human approval creates ONE grant +
 * execution UUID (BEGIN IMMEDIATE); UNIQUE(proposal_id) prevents double
 * approve under different keys. Claim consumes the grant and persists the
 * immutable frozen request/launch intent BEFORE any provider runs.
 * Manual task state stays separate (`trialOutcome`); trials NEVER
 * auto-complete tasks/goals, apply hosts, or write calendar/memory.
 */

export const TrialOperationSchema = z.enum([
  "investigate",
  "implement",
  "verify",
  "maintenance_trial",
]);
export type TrialOperation = z.infer<typeof TrialOperationSchema>;

/** Structured constraint rule: ONLY kind=constraint purposes may carry one. */
export const ConstraintRuleSchema = z.strictObject({
  denyWorkspace: z.array(z.string().min(1).max(128)).default([]),
  denyOperation: z.array(TrialOperationSchema).default([]),
  denyWritePath: z
    .array(
      z.strictObject({
        workspaceAlias: z.string().min(1).max(128),
        literalPrefix: z.string().min(1).max(512),
      }),
    )
    .default([]),
});
export type ConstraintRule = z.infer<typeof ConstraintRuleSchema>;

/** Wire mode accepted by the downstream executor: read-only vs write. */
export const TrialWireModeSchema = z.enum(["read_only", "write"]);
export type TrialWireMode = z.infer<typeof TrialWireModeSchema>;

export const TRIAL_OPERATIONS_READONLY: TrialOperation[] = [
  "investigate",
  "verify",
];

export function trialOperationIsReadOnly(op: TrialOperation): boolean {
  return op === "investigate" || op === "verify";
}

export const TrialProposalStatusSchema = z.enum([
  "staged",
  "granted",
  "expired",
  "invalidated",
]);
export type TrialProposalStatus = z.infer<typeof TrialProposalStatusSchema>;

export const TrialGrantStatusSchema = z.enum([
  "queued",
  "claimed",
  "revoked",
  "consumed",
  "interrupted",
]);
export type TrialGrantStatus = z.infer<typeof TrialGrantStatusSchema>;

export const TrialStageRequestSchema = z.strictObject({
  taskId: UuidSchema,
  objective: z.string().min(1).max(8192),
  acceptance: z.array(z.string().min(1).max(1024)).min(1).max(16),
  literalPatchPaths: z.array(z.string().min(1).max(512)).min(1).max(16),
  operation: TrialOperationSchema,
  readOnlyMode: z.boolean(),
  expiry: z.string().min(1).max(128),
  possibleExternalDataConsent: z.boolean(),
  objectiveResourceCaps: z.strictObject({
    timeoutMs: z.number().int().min(1000).max(3600000),
    maxOutputBytes: z.number().int().min(1024).max(268435456),
  }),
  requiredChecks: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]{1,64}$/),
    )
    .min(1)
    .max(16),
});
export type TrialStageRequest = z.infer<typeof TrialStageRequestSchema>;

export const TrialProposalViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  taskId: UuidSchema,
  goalId: UuidSchema.nullable(),
  goalVersion: z.number().int().min(1).nullable(),
  taskVersion: z.number().int().min(1),
  objective: z.string().min(1).max(2000),
  acceptance: z.array(z.string()),
  literalPatchPaths: z.array(z.string()),
  operation: TrialOperationSchema,
  readOnlyMode: z.boolean(),
  expiry: z.string(),
  possibleExternalDataConsent: z.boolean(),
  timeoutMs: z.number().int(),
  maxOutputBytes: z.number().int(),
  requiredChecks: z.array(z.string()),
  status: TrialProposalStatusSchema,
  createdAt: UnixMsSchema,
  /** FROZEN staged binding: alias + profile snapshot summary persisted in
   * trial_proposals (workspace_alias / profile_json). Nullable = legacy
   * unbound row staged before these columns existed (UI shows 'unbound',
   * approve already fails closed for them). Never invented on read. */
  workspaceAlias: z
    .string()
    .regex(/^[a-z0-9_-]{1,64}$/)
    .nullable(),
  profile: z
    .strictObject({
      configFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .nullable(),
});
export type TrialProposalView = z.infer<typeof TrialProposalViewSchema>;

/** Frozen launch intent shared with the future bridge builder.
 * Wire-exact subset of the companion request: NO domain `operation` key
 * (operation stays on the immutable proposal/grant for constraint checks).
 * Bounds mirror the companion wire ceiling so over-wire input fails BEFORE
 * human approval/consume, never after claim. */
export const TrialLaunchRequestSchema = z.strictObject({
  version: z.literal(1),
  executionId: UuidSchema,
  taskHash: Sha256HexSchema,
  configFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  workspaceAlias: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  /** Actual executor wire mode: ONLY 'read_only' | 'write'. */
  mode: TrialWireModeSchema,
  purpose: z.strictObject({
    statement: z.string().min(1).max(4096),
    scope: AutonomyScopeSchema,
  }),
  objective: z.string().min(1).max(8192),
  relevantPaths: z.array(z.string().min(1).max(512)).min(1).max(16),
  acceptance: z.array(z.string().min(1).max(1024)).min(1).max(16),
  requiredChecks: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]{1,64}$/),
    )
    .min(1)
    .max(16),
  constraints: z.array(z.string().min(1).max(1024)).max(16),
  budget: z.strictObject({
    timeoutMs: z.number().int().min(1000).max(3600000),
    maxOutputBytes: z.number().int().min(1024).max(268435456),
  }),
  externalModelConsent: z.boolean(),
});
export type TrialLaunchRequest = z.infer<typeof TrialLaunchRequestSchema>;

export const TrialGrantViewSchema = z.strictObject({
  executionId: UuidSchema,
  proposalId: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  status: TrialGrantStatusSchema,
  cancelRequested: z.boolean(),
  controlGeneration: z.number().int().min(1),
  createdAt: UnixMsSchema,
});
export type TrialGrantView = z.infer<typeof TrialGrantViewSchema>;

export const TrialClaimResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("replay"),
    grant: TrialGrantViewSchema,
    request: TrialLaunchRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("result"),
    grant: TrialGrantViewSchema,
    request: TrialLaunchRequestSchema,
    applied: z.boolean(),
  }),
]);
export type TrialClaimResult = z.infer<typeof TrialClaimResultSchema>;

/** Trusted injected profile snapshot (pre-probed in-memory, never body flags). */
export const TrialProfileSnapshotSchema = z.strictObject({
  available: z.boolean(),
  enabled: z.boolean(),
  /** Mandatory checks: strict non-empty, unique, no inferred defaults. */
  mandatoryChecks: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]{1,64}$/),
    )
    .min(1)
    .max(16),
  configFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  currentModel: z.string().min(1).max(256),
  disclosedWholeRepoRead: z.boolean(),
  /** Explicit numeric operator caps bounding every staged request.
   * Floors are the wire minimums: a profile below them cannot serve any
   * valid wire request and must stay unavailable for new grants. */
  timeoutMs: z.number().int().min(1000).max(3600000),
  maxOutputBytes: z.number().int().min(1024).max(268435456),
});
export type TrialProfileSnapshot = z.infer<typeof TrialProfileSnapshotSchema>;

/* ------------------------------------------------------------------ */
/* Internal execution-lifecycle DTOs (Root service only, never browser */
/* injectable, never body flags).                                      */
/* ------------------------------------------------------------------ */

/** Known native frontend worker birth identity persisted BEFORE any payload.
 * processStartTicks is the Linux process start tick counter (canonical
 * decimal TEXT, never wall-clock, always required); bootId is the Linux
 * boot ID. */
export const TrialWorkerBootSchema = z.strictObject({
  executionId: UuidSchema,
  sessionId: UuidSchema.optional(),
  pid: z.number().int().min(1).max(4294967295),
  bootId: z.string().min(1).max(128),
  processStartTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
  startedAt: UnixMsSchema,
  observedAt: UnixMsSchema.optional(),
});
export type TrialWorkerBoot = z.infer<typeof TrialWorkerBootSchema>;

/** Trusted runtime observation port (a structural trusted-caller argument
 * constructed ONLY by the trusted Root service caller, never by a public
 * body, never a body field; not a proof of kernel scope by itself — kernel
 * re-checks authority/profile/fence from the DB. scopeState is the actual
 * unit state; frontendSettled reports native-frontend settled state. Every
 * field is REQUIRED: omission never bypasses a check. */
export const TrialScopeStateSchema = z.enum(["active", "gone", "unknown"]);
export type TrialScopeState = z.infer<typeof TrialScopeStateSchema>;
export const TrustedRuntimeObservationSchema = z.strictObject({
  scopeState: TrialScopeStateSchema,
  frontendSettled: z.boolean(),
  pid: z.number().int().min(1).max(4294967295),
  bootId: z.string().min(1).max(128),
  processStartTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
  remainingRuntimeMs: z.number().int().min(1).max(3600000),
  timeoutMs: z.number().int().min(1000).max(3600000),
  maxOutputBytes: z.number().int().min(1024).max(268435456),
  foregroundGateOpen: z.boolean(),
  observedAt: UnixMsSchema,
});
export type TrustedRuntimeObservation = z.infer<
  typeof TrustedRuntimeObservationSchema
>;

/** Minimal strict wire result proof for an authorized done. */
export const TrialWireResultSchema = z.strictObject({
  executionId: UuidSchema,
  taskHash: Sha256HexSchema,
  exitCode: z.literal(0),
  checks: z
    .array(
      z.strictObject({ id: z.string().min(1).max(64), ok: z.literal(true) }),
    )
    .min(1)
    .max(16),
  outputMatched: z.literal(true),
  noTimeout: z.literal(true),
});
export type TrialWireResult = z.infer<typeof TrialWireResultSchema>;

/** Durable per-workspace-alias unknown fence (global by alias). */
export const TrialAliasFenceSchema = z.strictObject({
  workspaceAlias: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  executionId: UuidSchema,
  taskHash: Sha256HexSchema.nullable(),
  pid: z.number().int().min(1).max(4294967295).nullable(),
  bootId: z.string().max(128).nullable(),
  reason: z.string().min(1).max(256),
  createdAt: UnixMsSchema,
  clearedAt: UnixMsSchema.nullable(),
});
export type TrialAliasFence = z.infer<typeof TrialAliasFenceSchema>;

/** One-use launch permit minted by the Root service after trusted checks.
 * One ISSUE immediately consumes: consumedAt is always set (= issuedAt),
 * never left NULL for later use. */
export const TrialLaunchPermitSchema = z.strictObject({
  permitId: UuidSchema,
  executionId: UuidSchema,
  sessionId: UuidSchema,
  issuedAt: UnixMsSchema,
  consumedAt: UnixMsSchema,
});
export type TrialLaunchPermit = z.infer<typeof TrialLaunchPermitSchema>;

/** Trusted validated worker result / quiescence record. Host-observed facts
 * stay separate from authorized acceptance: `authorized` is true ONLY for a
 * fully verified done; late/invalid provider done persists observed
 * (authorized=false) without consuming the grant. */
export const TrialWorkerOutcomeSchema = z.strictObject({
  executionId: UuidSchema,
  sessionId: UuidSchema,
  succeeded: z.boolean(),
  quiescent: z.boolean(),
  authorized: z.boolean(),
  taskHash: Sha256HexSchema.nullable(),
  detail: z.string().min(1).max(2000),
  recordedAt: UnixMsSchema,
});
export type TrialWorkerOutcome = z.infer<typeof TrialWorkerOutcomeSchema>;
