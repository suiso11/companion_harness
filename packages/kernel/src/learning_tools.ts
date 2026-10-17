// Normal-agent learning tools (kernel-owned registrations).
//
// Three tools over the runtime session's OWNED learning state:
// `learning.list` / `learning.open` (STRICTLY READ-ONLY, no Markdown memory
// needed) and `learning.propose` (PROPOSAL-ONLY staging). The owned session
// is derived from `ctx.runId` via the existing requireOwnedRun pattern
// (repo.getRun); the model NEVER supplies a session id, so foreign-session
// records are unreachable by construction and foreign ids fail closed as
// `execution_failed` (404 is never leaked as a distinct signal).
//
// READ-ONLY / PROPOSAL-ONLY GUARANTEES (consumer-boundary, pinned by
// regressions):
// - `learning.list` / `learning.open` call ONLY the existing SELECT readers
//   (repo `listLearningHypotheses` / `getLearningHypothesis`, exact
//   `toHypothesisView` mapper). They never mutate hypotheses, evidence,
//   purposes, tasks, grants, calendar, memory, or ToolBroker budgets
//   (ordinary `category: "read"` tools sharing the EXISTING broker budgets).
// - Every read item is EXPLICITLY labeled a hypothesis (kind + status +
//   per-polarity evidence counts): a `refuted` row is NEVER presented as
//   supported/fact, and no read path can promote a status.
// - `learning.propose` stages EXACTLY ONE durable pending hypothesis
//   through the repository facade (server-derived run/turn source, ordinary
//   `user_text` only, staged pending). It creates NO purpose, NO task, NO
//   grant, NO control/budget change, NO notification, and never touches the
//   stop control. Source origin is hardcoded `model` (inference, never a
//   user instruction and never an actual permission grant). The model
//   supplies NO status/source fields (strict input rejects them): staged
//   records are `open` + pending and REQUIRE explicit human accept/reject.
// - Model tools can NEVER set a status or attach evidence: no transition /
//   evidence / accept / reject registration exists here (human HTTP only).

import {
  DEFAULT_SEARCH_LIMIT,
  type LearningHypothesisKind,
  LearningHypothesisKindSchema,
  type LearningHypothesisStatus,
  LearningHypothesisStatusSchema,
  type LearningHypothesisView,
  MAX_SEARCH_LIMIT,
  UuidSchema,
} from "@companion/contracts";
import { z } from "zod";
import { AGENT_TOOL_ORIGIN } from "./agent.js";
import { ToolError, type ToolRegistration } from "./broker.js";
import type { KernelRepository } from "./repository.js";

export interface LearningToolsOptions {
  readonly repo: KernelRepository;
}

/** Derive the owned (sessionId, runId) from the calling run (existing pattern). */
function requireOwnedRun(
  repo: KernelRepository,
  runId: string,
): { sessionId: string; runId: string } {
  try {
    const run = repo.getRun(runId);
    return { sessionId: run.sessionId, runId: run.id };
  } catch {
    throw new ToolError("execution_failed");
  }
}

/** Truncate to maxCp code points with an explicit truncation flag. */
function snippetOf(
  text: string,
  maxCp: number,
): { snippet: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= maxCp) {
    return { snippet: text, truncated: false };
  }
  return { snippet: points.slice(0, maxCp).join(""), truncated: true };
}

/** Bounded list-input bound (existing search-limit family). */
const ListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_SEARCH_LIMIT)
  .default(DEFAULT_SEARCH_LIMIT);

const LearningScopeFilterSchema = z.string().min(1).max(128);

export const LearningListToolInputSchema = z.strictObject({
  scope: LearningScopeFilterSchema.optional(),
  status: LearningHypothesisStatusSchema.optional(),
  kind: LearningHypothesisKindSchema.optional(),
  limit: ListLimitSchema,
});

export const LearningListToolOutputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        hypothesisId: UuidSchema,
        scope: LearningScopeFilterSchema,
        kind: LearningHypothesisKindSchema,
        /** Explicit hypothesis label: never presented as fact. */
        status: LearningHypothesisStatusSchema,
        staged: z.boolean(),
        needsReevaluation: z.boolean(),
        supports: z.number().int().min(0),
        refutes: z.number().int().min(0),
        neutral: z.number().int().min(0),
        snippet: z.string(),
        truncated: z.boolean(),
        version: z.number().int().min(1),
      }),
    )
    .max(MAX_SEARCH_LIMIT),
  hasMore: z.boolean(),
});

export const LearningOpenToolInputSchema = z.strictObject({
  hypothesisId: UuidSchema,
});

export const LearningOpenToolOutputSchema = z.strictObject({
  hypothesisId: UuidSchema,
  scope: LearningScopeFilterSchema,
  kind: LearningHypothesisKindSchema,
  statement: z.string(),
  /** Explicit hypothesis label: never presented as fact. */
  status: LearningHypothesisStatusSchema,
  staged: z.boolean(),
  needsReevaluation: z.boolean(),
  supports: z.number().int().min(0),
  refutes: z.number().int().min(0),
  neutral: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const LearningProposeToolInputSchema = z.strictObject({
  scope: LearningScopeFilterSchema,
  kind: LearningHypothesisKindSchema,
  statement: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= 2000, {
      message: "statement over 2000 code points",
    }),
});

export const LearningProposeToolOutputSchema = z.strictObject({
  hypothesisId: UuidSchema,
  scope: LearningScopeFilterSchema,
  kind: LearningHypothesisKindSchema,
  status: z.literal("open"),
  staged: z.literal(true),
  version: z.number().int().min(1),
});

const SNIPPET_CP = 200;

/**
 * Build the learning registrations. Read handlers derive the owned session
 * from `ctx.runId` (never from model args) and perform SELECT-only reads;
 * the propose handler stages exactly one durable pending hypothesis.
 */
export function createLearningRegistrations(
  options: LearningToolsOptions,
): ToolRegistration[] {
  const { repo } = options;

  const learningList: ToolRegistration = {
    descriptor: {
      name: "learning.list",
      version: 1,
      title: "List owned hypotheses",
      description:
        "Read-only list of the current session's own learning hypotheses with explicit hypothesis labels (kind, status, evidence counts). Hypotheses are context, never facts; refuted stays refuted.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: LearningListToolInputSchema,
    outputSchema: LearningListToolOutputSchema,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      const parsed = LearningListToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const owned = requireOwnedRun(repo, ctx.runId);
      let rows: LearningHypothesisView[];
      try {
        rows = repo.listLearningHypotheses(owned.sessionId, {
          limit: 100,
          ...(parsed.status !== undefined ? { status: parsed.status } : {}),
          ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
        }).items;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const filtered = rows.filter(
        (row) =>
          (parsed.scope === undefined || row.scope === parsed.scope) &&
          (parsed.status === undefined || row.status === parsed.status) &&
          (parsed.kind === undefined || row.kind === parsed.kind),
      );
      const window = filtered.slice(0, parsed.limit + 1);
      const hasMore = window.length > parsed.limit;
      return {
        items: window.slice(0, parsed.limit).map((row) => {
          const cut = snippetOf(row.statement, SNIPPET_CP);
          return {
            hypothesisId: row.id,
            scope: row.scope,
            kind: row.kind as LearningHypothesisKind,
            status: row.status as LearningHypothesisStatus,
            staged: row.staged,
            needsReevaluation: row.needsReevaluation,
            supports: row.evidenceCounts.supports,
            refutes: row.evidenceCounts.refutes,
            neutral: row.evidenceCounts.neutral,
            snippet: cut.snippet,
            truncated: cut.truncated,
            version: row.version,
          };
        }),
        hasMore,
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { items: unknown[] };
      const count = Array.isArray(output.items) ? output.items.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };

  const learningOpen: ToolRegistration = {
    descriptor: {
      name: "learning.open",
      version: 1,
      title: "Open an owned hypothesis",
      description:
        "Read-only full view of one owned learning hypothesis with its explicit label (kind, status, evidence counts). Context only, never fact; never capability.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: LearningOpenToolInputSchema,
    outputSchema: LearningOpenToolOutputSchema,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      const parsed = LearningOpenToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const owned = requireOwnedRun(repo, ctx.runId);
      try {
        // Ownership-first: a foreign id throws here and maps to the same
        // fixed code as any other failure (no 404 leak, no second store).
        const view = repo.getLearningHypothesis(
          owned.sessionId,
          parsed.hypothesisId,
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return {
          hypothesisId: view.id,
          scope: view.scope,
          kind: view.kind,
          statement: view.statement,
          status: view.status,
          staged: view.staged,
          needsReevaluation: view.needsReevaluation,
          supports: view.evidenceCounts.supports,
          refutes: view.evidenceCounts.refutes,
          neutral: view.evidenceCounts.neutral,
          version: view.version,
          createdAt: view.createdAt,
          updatedAt: view.updatedAt,
        };
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

  const learningPropose: ToolRegistration = {
    descriptor: {
      name: "learning.propose",
      version: 1,
      title: "Propose a learning hypothesis",
      description:
        "Stage (never adopt) one learning hypothesis from the current user message as pending. Human accept/reject happens outside the model; staging creates no purpose, task, grant, or notification.",
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: LearningProposeToolInputSchema,
    outputSchema: LearningProposeToolOutputSchema,
    proposalOnly: true,
    handler: (async (input: unknown, ctx) => {
      if (ctx.origin !== AGENT_TOOL_ORIGIN) {
        throw new ToolError("tool_denied");
      }
      const parsed = LearningProposeToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      try {
        const staged = repo.proposeLearningHypothesisFromModel(
          ctx.runId,
          {
            scope: parsed.scope,
            kind: parsed.kind,
            statement: parsed.statement,
          },
          { key: ctx.callId },
        );
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        if (staged.body.status !== "open" || staged.body.staged !== true) {
          throw new ToolError("execution_failed");
        }
        return {
          hypothesisId: staged.body.id,
          scope: staged.body.scope,
          kind: staged.body.kind,
          status: "open" as const,
          staged: true as const,
          version: staged.body.version,
        };
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

  return [learningList, learningOpen, learningPropose];
}
