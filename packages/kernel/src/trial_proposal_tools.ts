// Normal-agent trial-proposal tool (kernel-owned registration).
//
// One PROPOSAL-ONLY staging tool over the runtime session's OWNED trial
// authority: `trial.propose` (single-dot name). The owned session is
// derived server-side from `ctx.runId` (never from model args), and the
// frozen operator profile + workspace alias come from the registration
// options (never from model args). The model supplies only the draft
// objective/acceptance/paths/operation plus a bounded expiry in minutes.
//
// PROPOSAL-ONLY GUARANTEES:
// - The handler stages EXACTLY ONE durable `staged` trial proposal through
//   the SAME repository staging function the human HTTP route uses
//   (`repo.stageTrial` -> `stageTrialProposal`). No grant, no execution,
//   no approval, no workspace write, and no control mutation happens here.
// - `readOnlyMode` is DERIVED from the operation (never model input);
//   resource caps and required checks are the frozen profile ceilings and
//   mandatory set (never model input). The workspace alias is frozen.
// - The explicit-user-goal authority rule is unchanged: staging under a
//   self/external goal fails and returns a fixed model-facing error code
//   (`requires_explicit_user_goal`) instead of throwing, so the model can
//   explain the refusal. Human approval remains the only grant path.
// - Retries with the same `ctx.callId` replay the same staged proposal
//   (repository idempotency scope), so a retried tool call cannot stage a
//   second draft.

import {
  TrialOperationSchema,
  type TrialProfileSnapshot,
  type TrialProposalView,
  trialOperationIsReadOnly,
  UuidSchema,
} from "@companion/contracts";
import { z } from "zod";
import { AGENT_TOOL_ORIGIN } from "./agent.js";
import { ToolError, type ToolRegistration } from "./broker.js";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import type { KernelRepository } from "./repository.js";

export interface TrialProposalToolsOptions {
  readonly repo: KernelRepository;
  /** Frozen operator profile snapshot (availability + ceilings + checks). */
  readonly profile: TrialProfileSnapshot;
  /** Frozen workspace alias the proposal stages under. */
  readonly workspaceAlias: string;
  /** Server clock; expiry is converted in whole seconds from this instant. */
  readonly now?: () => number;
}

export const TrialProposeToolInputSchema = z.strictObject({
  taskId: UuidSchema,
  objective: z.string().min(1).max(8192),
  acceptance: z.array(z.string().min(1).max(1024)).min(1).max(16),
  literalPatchPaths: z.array(z.string().min(1).max(512)).min(1).max(16),
  operation: TrialOperationSchema,
  expiryMinutes: z.number().int().min(10).max(1440),
  possibleExternalDataConsent: z.boolean().default(false),
});

export const TrialProposeToolOutputSchema = z.strictObject({
  status: z.enum(["staged", "rejected"]),
  proposalId: UuidSchema.optional(),
  taskId: UuidSchema,
  goalId: UuidSchema.nullable().optional(),
  operation: TrialOperationSchema,
  readOnlyMode: z.boolean(),
  expiry: z.string().optional(),
  workspaceAlias: z.string().nullable().optional(),
  errorCode: z.string().optional(),
});

type TrialProposeToolOutput = z.infer<typeof TrialProposeToolOutputSchema>;

/** Whole-second RFC3339 instant (Date#toISOString at a floored second). */
function wholeSecondInstant(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** Fixed, non-sensitive model-facing code for a failed stage. */
function stageFailureCode(error: unknown): string {
  if (error instanceof IdempotencyConflictError) {
    return "idempotency_conflict";
  }
  if (error instanceof RepositoryNotFoundError) {
    return "task_not_found";
  }
  if (error instanceof RepositoryValidationError) {
    const message = error.message;
    if (message.includes("requires explicit user goal")) {
      return "requires_explicit_user_goal";
    }
    if (message.includes("not active/applicable")) {
      return "goal_not_active";
    }
    if (message.includes("task has no parent goal")) {
      return "task_has_no_goal";
    }
    return "invalid_request";
  }
  return "execution_failed";
}

function stagedOutput(view: TrialProposalView): TrialProposeToolOutput {
  return {
    status: "staged",
    proposalId: view.id,
    taskId: view.taskId,
    goalId: view.goalId,
    operation: view.operation,
    readOnlyMode: view.readOnlyMode,
    expiry: view.expiry,
    workspaceAlias: view.workspaceAlias,
  };
}

/**
 * Build the proposal-only `trial.propose` registration. The session comes
 * from the calling run; profile/alias/checks/caps come from the frozen
 * server config; nothing security-relevant is model input.
 */
export function createTrialProposalRegistrations(
  options: TrialProposalToolsOptions,
): ToolRegistration[] {
  const { repo, profile, workspaceAlias, now } = options;
  const clock = now ?? Date.now;

  const trialPropose: ToolRegistration = {
    descriptor: {
      name: "trial.propose",
      version: 1,
      title: "Propose a workspace trial",
      description:
        "Stage (never run) one workspace trial proposal against an open task under an explicit user goal. Use when the user asks to actually try something in the sandbox. Staging grants nothing: the human must approve it in 試行の提案. Authority failures return a fixed code such as requires_explicit_user_goal.",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: TrialProposeToolInputSchema,
    outputSchema: TrialProposeToolOutputSchema,
    proposalOnly: true,
    handler: (async (input: unknown, ctx) => {
      if (ctx.origin !== AGENT_TOOL_ORIGIN) {
        throw new ToolError("tool_denied");
      }
      const parsed = TrialProposeToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const run = repo.getRun(ctx.runId);
      const nowMs = clock();
      const readOnlyMode = trialOperationIsReadOnly(parsed.operation);
      try {
        const staged = repo.stageTrial(
          run.sessionId,
          {
            taskId: parsed.taskId,
            objective: parsed.objective,
            acceptance: [...parsed.acceptance],
            literalPatchPaths: [...parsed.literalPatchPaths],
            operation: parsed.operation,
            readOnlyMode,
            expiry: wholeSecondInstant(nowMs + parsed.expiryMinutes * 60_000),
            possibleExternalDataConsent: parsed.possibleExternalDataConsent,
            objectiveResourceCaps: {
              timeoutMs: profile.timeoutMs,
              maxOutputBytes: profile.maxOutputBytes,
            },
            requiredChecks: [...profile.mandatoryChecks],
          },
          {
            key: ctx.callId,
            now: nowMs,
            profile,
            workspaceAlias,
          },
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return stagedOutput(staged.body);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        return {
          status: "rejected",
          taskId: parsed.taskId,
          operation: parsed.operation,
          readOnlyMode,
          errorCode: stageFailureCode(error),
        } satisfies TrialProposeToolOutput;
      }
    }) as ToolRegistration["handler"],
    normalize: (raw) => ({
      normalized: raw,
      observations: 1,
      modelFacing: raw,
    }),
  };

  return [trialPropose];
}
