// Normal-agent conversation-proposal tools (kernel-owned registrations).
//
// Two PROPOSAL-ONLY staging tools over the runtime session's OWNED
// conversation: `purpose.propose` / `task.propose` (single-dot names).
// The owned session, source run, source turn, and source quote are ALL
// derived server-side from `ctx.runId` (never from model args): the model
// supplies only the strict draft input (scope/draft-kind/kind/quote/
// interpretation, plus the explicit parent for task drafts). The source
// must be the CURRENT ordinary `user_text` turn body; action
// approval/rejection (or any non-text) turns fail closed.
//
// PROPOSAL-ONLY GUARANTEES (consumer-boundary, pinned by regressions):
// - Handlers stage EXACTLY ONE durable pending draft through the repository
//   facade (server-derived source, exact-substring quote, explicit-parent
//   checks). They create NO purpose, NO task, NO grant, NO calendar write,
//   NO notification, and never touch the stop control. Source kind is
//   hardcoded `model` (inference, never a user instruction and never an
//   actual permission grant: a staged `permission` purpose-kind is a CLAIM).
// - Model tools accept NO date fields at all (strict objects reject
//   `deadline` / `validFrom` / `validUntil` before staging): task drafts
//   adopt with a NULL deadline and purpose drafts with a NULL window
//   unless the trusted human supplies an explicit strict value at accept
//   time. Model date invention is structurally impossible.
// - Draft kind is explicit (casual/wish/problem/task/deadline): a casual
//   remark stays a casual draft (no mandatory taskization); a model
//   do-nothing stages nothing.
// - Task drafts REQUIRE an explicit parent purpose id + expected version
//   (same session/scope, active, checked at stage and re-checked at
//   adopt). The model can never auto-pick a parent. Purpose drafts accept
//   no parent fields.
// - Ordinary repeated calls with identical input replay the existing
//   pending draft (broker normal dedup within a run; semantic
//   exact-input-hash dedup across runs). A meaningfully new source stages
//   a new draft. Bounded: at most 20 pending drafts per session (borrowed
//   tool-list cap, not a budget); no budget widening.

import {
  ConversationDraftKindSchema,
  type ConversationProposalView,
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

export const ProposalStageToolOutputSchema = z.strictObject({
  proposalId: UuidSchema,
  scope: ScopeSchema,
  target: z.enum(["purpose", "task"]),
  draftKind: ConversationDraftKindSchema,
  status: z.literal("pending"),
  version: z.number().int().min(1),
});

function toStageOutput(view: ConversationProposalView): {
  proposalId: string;
  scope: string;
  target: "purpose" | "task";
  draftKind: "casual" | "wish" | "problem" | "task" | "deadline";
  status: "pending";
  version: number;
} {
  if (view.status !== "pending") {
    throw new ToolError("execution_failed");
  }
  return {
    proposalId: view.id,
    scope: view.scope,
    target: view.target,
    draftKind: view.draftKind,
    status: "pending",
    version: view.version,
  };
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
        "Stage (never create) one inferred purpose draft quoting the current user message verbatim with a separate interpretation. Human adoption happens outside the model; a staged permission kind is only a claim, never capability.",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: PurposeProposeToolInputSchema,
    outputSchema: ProposalStageToolOutputSchema,
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
        const staged = repo.stageConversationProposalFromModel(
          ctx.runId,
          {
            target: "purpose",
            scope: parsed.scope,
            draftKind: parsed.draftKind,
            purposeKind: parsed.purposeKind,
            sourceQuote: parsed.sourceQuote,
            interpretation: parsed.interpretation,
          },
          { key: ctx.callId },
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return toStageOutput(staged.body);
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
        "Stage (never create) one inferred task draft quoting the current user message verbatim with a separate interpretation under an explicit parent purpose. Human adoption happens outside the model; no deadline is ever staged.",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: TaskProposeToolInputSchema,
    outputSchema: ProposalStageToolOutputSchema,
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
        const staged = repo.stageConversationProposalFromModel(
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
          { key: ctx.callId },
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return toStageOutput(staged.body);
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
