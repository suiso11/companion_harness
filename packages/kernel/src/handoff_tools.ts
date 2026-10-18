// Normal-agent handoff tools (kernel-owned registrations).
//
// Two STRICTLY READ-ONLY tools over the runtime session's OWNED handoff
// records: `handoff.list` / `handoff.open` (NO model write tool exists
// anywhere: only the human HTTP API creates, dispatches, verifies, or
// records attempts). The owned session is derived from `ctx.runId` via
// the existing requireOwnedRun pattern (repo.getRun); the model NEVER
// supplies a session id, so foreign-session records are unreachable by
// construction and foreign ids fail closed as `execution_failed` (404 is
// never leaked as a distinct signal).
//
// READ-ONLY GUARANTEES (consumer-boundary, pinned by regressions):
// - `handoff.list` / `handoff.open` call ONLY the existing SELECT readers
//   (repo `listHandoffs` / `getHandoff`, exact view mapper). They never
//   mutate handoffs, attempts, purposes, tasks, grants, calendar, memory,
//   or ToolBroker budgets (ordinary `category: "read"` tools sharing the
//   EXISTING broker budgets).
// - Frozen acceptance criteria are quoted verbatim: the model can never
//   weaken them (no verify/transition/attempt registration exists here;
//   verification is human HTTP only).
// - Boundary flags and budget labels are surfaced as RECORDED CLAIMS
//   only: reading them grants nothing, and sandbox claims never imply
//   production.

import {
  DEFAULT_SEARCH_LIMIT,
  HandoffStatusSchema,
  MAX_SEARCH_LIMIT,
  UuidSchema,
} from "@companion/contracts";
import { z } from "zod";
import { ToolError, type ToolRegistration } from "./broker.js";
import type { KernelRepository } from "./repository.js";

export interface HandoffToolsOptions {
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

export const HandoffListToolInputSchema = z.strictObject({
  status: HandoffStatusSchema.optional(),
  limit: ListLimitSchema,
});

export const HandoffListToolOutputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        handoffId: UuidSchema,
        taskId: UuidSchema,
        opScope: z.enum(["investigate", "implement"]),
        /** Frozen lifecycle state (model can never change it). */
        status: HandoffStatusSchema,
        needsReevaluation: z.boolean(),
        activeAttempt: z.number().int().min(0),
        criteriaCount: z.number().int().min(0),
        snippet: z.string(),
        truncated: z.boolean(),
        version: z.number().int().min(1),
      }),
    )
    .max(MAX_SEARCH_LIMIT),
  hasMore: z.boolean(),
  /**
   * Session-owned ACTIVE (dispatched/reported) handoff count. Tracking
   * only: no numeric limit is invented or enforced anywhere.
   */
  activeCount: z.number().int().min(0),
});

export const HandoffOpenToolInputSchema = z.strictObject({
  handoffId: UuidSchema,
});

export const HandoffOpenToolOutputSchema = z.strictObject({
  handoffId: UuidSchema,
  taskId: UuidSchema,
  opScope: z.enum(["investigate", "implement"]),
  target: z.string(),
  /** Frozen criteria verbatim (never weakened; model cannot verify). */
  acceptanceCriteria: z.array(z.string()),
  budgetLabel: z.string().nullable(),
  /** Recorded claims only: each REQUIRES SEPARATE AUTHORIZATION. */
  boundaries: z.array(z.string()),
  /** Frozen lifecycle state (model can never change it). */
  status: HandoffStatusSchema,
  needsReevaluation: z.boolean(),
  activeAttempt: z.number().int().min(0),
  reportEnvironment: z.string().nullable(),
  reportSummary: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const SNIPPET_CP = 200;

/**
 * Build the read-only handoff registrations. Read handlers derive the
 * owned session from `ctx.runId` (never from model args) and perform
 * SELECT-only reads. No write/propose/verify registration exists here.
 */
export function createHandoffRegistrations(
  options: HandoffToolsOptions,
): ToolRegistration[] {
  const { repo } = options;

  const handoffList: ToolRegistration = {
    descriptor: {
      name: "handoff.list",
      version: 1,
      title: "List owned handoffs",
      description:
        "Read-only list of the current session's own delegation handoffs with frozen lifecycle states. Records only; model cannot create, dispatch, or verify.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: HandoffListToolInputSchema,
    outputSchema: HandoffListToolOutputSchema,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      const parsed = HandoffListToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const owned = requireOwnedRun(repo, ctx.runId);
      try {
        const out = repo.listHandoffs(owned.sessionId, {
          limit: parsed.limit,
          ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        });
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return {
          items: out.items.map((row) => {
            const cut = snippetOf(row.target, SNIPPET_CP);
            return {
              handoffId: row.id,
              taskId: row.taskId,
              opScope: row.opScope,
              status: row.status,
              needsReevaluation: row.needsReevaluation,
              activeAttempt: row.activeAttempt,
              criteriaCount: row.acceptanceCriteria.length,
              snippet: cut.snippet,
              truncated: cut.truncated,
              version: row.version,
            };
          }),
          hasMore: out.hasMore,
          activeCount: out.activeCount,
        };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { items: unknown[] };
      const count = Array.isArray(output.items) ? output.items.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };

  const handoffOpen: ToolRegistration = {
    descriptor: {
      name: "handoff.open",
      version: 1,
      title: "Open an owned handoff",
      description:
        "Read-only full view of one owned delegation handoff: frozen target, criteria, scope, budget labels, boundary claims, lifecycle state. Context only; never capability.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: HandoffOpenToolInputSchema,
    outputSchema: HandoffOpenToolOutputSchema,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      const parsed = HandoffOpenToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const owned = requireOwnedRun(repo, ctx.runId);
      try {
        // Ownership-first: a foreign id throws here and maps to the same
        // fixed code as any other failure (no 404 leak, no second store).
        const view = repo.getHandoff(owned.sessionId, parsed.handoffId);
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        return {
          handoffId: view.id,
          taskId: view.taskId,
          opScope: view.opScope,
          target: view.target,
          acceptanceCriteria: [...view.acceptanceCriteria],
          budgetLabel: view.budgetLabel,
          boundaries: [...view.boundaries],
          status: view.status,
          needsReevaluation: view.needsReevaluation,
          activeAttempt: view.activeAttempt,
          reportEnvironment: view.reportEnvironment,
          reportSummary: view.reportSummary,
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

  return [handoffList, handoffOpen];
}
