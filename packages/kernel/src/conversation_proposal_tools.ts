// Normal-agent conversation-record tools (kernel-owned registrations).
//
// Two LOCAL-WRITE tools over the runtime session's OWNED conversation:
// `purpose.propose` / `task.propose` (single-dot names).
// The owned session, source run, source turn, and source quote are ALL
// derived server-side from `ctx.runId` (never from model args): the model
// supplies only the strict draft input (scope/draft-kind/kind/quote/
// interpretation, plus the parent for task drafts). The source must be the
// CURRENT ordinary `user_text` turn body; action approval/rejection (or any
// non-text) turns fail closed.
//
// WRITE GUARANTEES (consumer-boundary, pinned by regressions):
// - Each handler stages ONE durable draft through the repository facade and
//   adopts it in the SAME call, so the conversation's goal/task exists
//   immediately (the only human gate for autonomy is the trial approval).
//   The proposal row is kept as the audit trail. No grant, no calendar
//   write, no notification, and the stop control is never touched. Source
//   kind stays `model`/`self` (inference, never a user instruction and
//   never an actual permission grant: a `permission` purpose-kind is a
//   CLAIM).
// - Model tools accept NO date fields at all (strict objects reject
//   `deadline` / `validFrom` / `validUntil`): tasks are created with a NULL
//   deadline and purposes with a NULL window. Model date invention is
//   structurally impossible.
// - Draft kind is explicit (casual/wish/problem/task/deadline): a casual
//   remark stays a casual draft (no mandatory taskization); a model
//   do-nothing writes nothing.
// - Task drafts REQUIRE a parent purpose id + expected version (same
//   session/scope, active, checked at stage and re-checked at adopt). The
//   model can never auto-pick a parent. Purpose drafts accept no parent
//   fields.
// - Ordinary repeated calls with identical input replay the existing draft
//   (broker normal dedup within a run; semantic exact-input-hash dedup
//   across runs). Bounded: at most 20 pending drafts per session (borrowed
//   tool-list cap, not a budget); no budget widening.

import {
  ConversationDraftKindSchema,
  PurposeInterpretationSchema,
  PurposeKindSchema,
  TaskKindSchema,
  UuidSchema,
} from "@companion/contracts";
import { z } from "zod";
import { AGENT_TOOL_ORIGIN } from "./agent.js";
import { ToolError, type ToolRegistration } from "./broker.js";
import type { KernelRepository } from "./repository.js";

export interface ConversationProposalToolsOptions {
  readonly repo: KernelRepository;
}

function codePointsMax(maxCp: number): (value: string) => boolean {
  return (value: string): boolean => Array.from(value).length <= maxCp;
}

const ScopeSchema = z.string().min(1).max(128);

export const PurposeProposeToolInputSchema = z.strictObject({
  scope: ScopeSchema,
  draftKind: ConversationDraftKindSchema,
  purposeKind: PurposeKindSchema,
  sourceQuote: z.string().min(1).refine(codePointsMax(2000), {
    message: "sourceQuote over 2000 code points",
  }),
  interpretation: PurposeInterpretationSchema,
});

export const TaskProposeToolInputSchema = z.strictObject({
  scope: ScopeSchema,
  draftKind: ConversationDraftKindSchema,
  taskKind: TaskKindSchema,
  sourceQuote: z.string().min(1).max(256),
  interpretation: PurposeInterpretationSchema,
  parentPurposeId: UuidSchema,
  expectedParentVersion: z.number().int().min(1),
});

export const ProposalCreatedToolOutputSchema = z.strictObject({
  status: z.literal("created"),
  target: z.enum(["purpose", "task"]),
  id: UuidSchema,
  scope: ScopeSchema,
  version: z.number().int().min(1),
});

/** Model-facing result of `purpose.propose` / `task.propose`. */
export interface ProposalCreatedToolOutput {
  readonly status: "created";
  readonly target: "purpose" | "task";
  readonly id: string;
  readonly scope: string;
  readonly version: number;
}

function toCreatedOutput(
  target: "purpose" | "task",
  record: { id: string; scope: string; version: number },
): ProposalCreatedToolOutput {
  return {
    status: "created",
    target,
    id: record.id,
    scope: record.scope,
    version: record.version,
  };
}

/**
 * Stage the model draft and adopt it immediately in the SAME call: the
 * single human gate for autonomy is the trial approval, not adoption of the
 * records a conversation produced. The staged proposal row is kept as the
 * audit trail; the created purpose/task is what the model reports.
 */
function stageAndCreate(
  repo: KernelRepository,
  runId: string,
  request: Record<string, unknown>,
  callId: string,
): ProposalCreatedToolOutput {
  const sessionId = repo.getRun(runId).sessionId;
  const staged = repo.stageConversationProposalFromModel(runId, request, {
    key: callId,
  });
  if (staged.body.status === "accepted") {
    // Semantic replay of an already-adopted draft: return the SAME record
    // instead of creating a duplicate.
    const targetId = staged.body.acceptedTargetId;
    if (targetId === null) {
      throw new ToolError("execution_failed");
    }
    const record =
      staged.body.target === "purpose"
        ? repo.getAutonomyPurpose(sessionId, targetId)
        : repo.getAutonomyTask(sessionId, targetId);
    return toCreatedOutput(staged.body.target, record);
  }
  const accepted = repo.acceptConversationProposal(
    sessionId,
    staged.body.id,
    { expectedVersion: staged.body.version },
    { key: callId },
  );
  const created = accepted.body.purpose ?? accepted.body.task;
  if (created === null) {
    throw new ToolError("execution_failed");
  }
  return toCreatedOutput(staged.body.target, created);
}

/**
 * Build the two proposal-only staging registrations. Every handler derives
 * the owned session + source run/turn/quote server-side from `ctx.runId`
 * (never from model args) and stages exactly one durable pending draft.
 */
export function createConversationProposalRegistrations(
  options: ConversationProposalToolsOptions,
): ToolRegistration[] {
  const { repo } = options;

  const purposePropose: ToolRegistration = {
    descriptor: {
      name: "purpose.propose",
      version: 1,
      title: "Propose a purpose draft",
      description:
        "Call when the user asks for something concrete that has no existing goal to attach to (or explicitly wants a new goal). Finds an active goal first with purpose.list. Creates ONE inferred goal immediately: sourceQuote MUST be an exact substring appearing exactly once in the user's current message, with a separate interpretation. A permission kind is only a claim, never capability. Tell the user the goal was recorded; trials still need their approval.",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: PurposeProposeToolInputSchema,
    outputSchema: ProposalCreatedToolOutputSchema,
    proposalOnly: true,
    handler: (async (input: unknown, ctx) => {
      if (ctx.origin !== AGENT_TOOL_ORIGIN) {
        throw new ToolError("tool_denied");
      }
      const parsed = PurposeProposeToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      try {
        const created = stageAndCreate(
          repo,
          ctx.runId,
          {
            target: "purpose",
            scope: parsed.scope,
            draftKind: parsed.draftKind,
            purposeKind: parsed.purposeKind,
            sourceQuote: parsed.sourceQuote,
            interpretation: parsed.interpretation,
          },
          ctx.callId,
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return created;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
    }) as ToolRegistration["handler"],
    normalize: (raw) => ({
      normalized: raw,
      observations: 1,
      modelFacing: raw,
    }),
  };

  const taskPropose: ToolRegistration = {
    descriptor: {
      name: "task.propose",
      version: 1,
      title: "Propose a task draft",
      description:
        "Call when the user asks to do/track something concrete and purpose.list shows a fitting active goal. First read purpose.open for parentPurposeId + expectedParentVersion, then create ONE inferred task under that goal. sourceQuote MUST be an exact substring appearing exactly once in the user's current message; no deadline is ever set. Tell the user the task was recorded; a trial still needs their approval.",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: TaskProposeToolInputSchema,
    outputSchema: ProposalCreatedToolOutputSchema,
    proposalOnly: true,
    handler: (async (input: unknown, ctx) => {
      if (ctx.origin !== AGENT_TOOL_ORIGIN) {
        throw new ToolError("tool_denied");
      }
      const parsed = TaskProposeToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      try {
        const created = stageAndCreate(
          repo,
          ctx.runId,
          {
            target: "task",
            scope: parsed.scope,
            draftKind: parsed.draftKind,
            taskKind: parsed.taskKind,
            sourceQuote: parsed.sourceQuote,
            interpretation: parsed.interpretation,
            parentPurposeId: parsed.parentPurposeId,
            expectedParentVersion: parsed.expectedParentVersion,
          },
          ctx.callId,
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return created;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
    }) as ToolRegistration["handler"],
    normalize: (raw) => ({
      normalized: raw,
      observations: 1,
      modelFacing: raw,
    }),
  };

  return [purposePropose, taskPropose];
}
