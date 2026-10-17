import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";
import { AutonomyScopeSchema } from "./autonomy.js";

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
  objective: z.string().min(1).max(2000),
  acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20),
  literalPatchPaths: z.array(z.string().min(1).max(512)).min(1).max(50),
  operation: TrialOperationSchema,
  readOnlyMode: z.boolean(),
  expiry: z.string().min(1).max(128),
  possibleExternalDataConsent: z.boolean(),
  objectiveResourceCaps: z.strictObject({
    timeoutMs: z.number().int().min(1).max(600000),
    maxOutputBytes: z.number().int().min(1).max(10000000),
  }),
  requiredChecks: z.array(z.string().min(1).max(128)).max(20),
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
});
export type TrialProposalView = z.infer<typeof TrialProposalViewSchema>;

/** Frozen launch intent shared with the future bridge builder. */
export const TrialLaunchRequestSchema = z.strictObject({
  version: z.literal(1),
  executionId: UuidSchema,
  taskHash: Sha256HexSchema,
  configFingerprint: z.string().min(1).max(256),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  workspaceAlias: z.string().min(1).max(128),
  mode: TrialOperationSchema,
  purpose: z.strictObject({
    statement: z.string().min(1),
    scope: AutonomyScopeSchema,
  }),
  objective: z.string().min(1),
  relevantPaths: z.array(z.string()),
  acceptance: z.array(z.string()),
  requiredChecks: z.array(z.string()),
  constraints: z.array(z.string()),
  budget: z.strictObject({
    timeoutMs: z.number().int().min(1),
    maxOutputBytes: z.number().int().min(1),
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
  mandatoryChecks: z.array(z.string().min(1).max(128)),
  configFingerprint: z.string().min(1).max(256),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  currentModel: z.string().min(1).max(256),
  disclosedWholeRepoRead: z.boolean(),
});
export type TrialProfileSnapshot = z.infer<typeof TrialProfileSnapshotSchema>;
