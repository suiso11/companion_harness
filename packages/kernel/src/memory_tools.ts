// Explicit conversation-memory management tools (kernel-owned registrations).
//
// DEPENDENCY INVERSION: the kernel NEVER spawns the remind CLI and never
// reads a remind DB. Callers inject a server-owned `MemoryManagePort`
// (structural only, implemented by the Companion memory service over the
// trusted startup scope). The port performs reads through the real CLI and
// stages mutations ONLY as durable outbox rows + operation rows: handler
// execution never performs an actual CLI mutation (the broker handler only
// stages; the service drain executes).
//
// TOOLS (static, `version: 1`, strict closed schemas):
// - `memory.search` (`category: "read"`): explicit user-directed search
//   over active+retired (archived/superseded excluded per remind
//   `record.search`). No heat, no reactivation, no feedback exposure: the
//   port persists an immutable per-handle snapshot and returns opaque
//   session-scoped `mN` handles, never raw canonical record ids.
// - `memory.correct` / `memory.retire` / `memory.reactivate`
//   (`category: "write"`, `proposalOnly: true`): the EXISTING staging-only
//   broker mechanism (same family as the C17 proposal-only registration)
//   reused WITHOUT permitting arbitrary external write tools or any
//   Calendar/action gate bypass. The closed port exposes ONLY these three
//   fixed ops with fixed reason codes/kind; the handler stages exactly one
//   durable operation (NEW raw source event + real `record.correct` for
//   corrections, direct retire/reactivate otherwise) and never executes it.
//   A staged mutation is queued, never applied: callers must read the
//   operation status before claiming anything changed.
//
// TARGET BINDING (fail-closed, no guessing, no keyword heuristics):
// - A mutation binds a single explicit UI-selected target
//   (`searchId` + `handle`) OR a uniquely resolved same-scope search
//   target (exactly one candidate in the referenced search and no
//   explicit handle). Multiple candidates without an explicit user
//   selection return `needs_clarification` and stage NOTHING, even if the
//   model arbitrarily chose one.
// - Raw record ids are never accepted from the model; cross-session,
//   cross-scope, and current-run handle smuggling fail closed. Stored
//   handles resolve server-side to source id + status/revision snapshot;
//   a fresh `record.get` rejects superseded/stale targets, and historical
//   `mN` snapshots are never rebound to latest memory.
//
// HANDLE LIFETIME (explicit, deterministic, no HMAC): a handle is valid
// only within the (sessionId, searchId) that created it. Handles are
// `m1..mN` in deterministic search order; the snapshot (record id,
// snippet, status) is immutable; every mutation re-reads the CURRENT
// record before staging and rejects actionable-state mismatches. Cross-
// session handle use fails closed (`target_not_found`).
//
// BUDGETS: ordinary tools sharing the EXISTING broker budgets
// (`maxToolRequestsPerRun: 8`) and the agent's 8 model steps / bounded
// per-call timeout. No new budget, no new step class. Outputs are bounded
// (at most 8 hits, snippets at most 512 code points, fixed status enums).

import { z } from "zod";
import { ToolError, type ToolRegistration } from "./broker.js";
import type { KernelRepository } from "./repository.js";

/* ------------------------------------------------------------------ */
/* Dependency-inverted server-owned port (kernel owns this shape)      */
/* ------------------------------------------------------------------ */

/** One opaque search hit (no raw canonical ids cross this boundary). */
export interface MemoryManageSearchHit {
  readonly handle: string;
  readonly snippet: string;
  readonly status: "active" | "retired";
}

export interface MemoryManageSearchResult {
  readonly searchId: string;
  readonly hits: readonly MemoryManageSearchHit[];
}

/** Closed staged-mutation outcome (staged = queued, never applied). */
export type MemoryManageStageResult =
  | {
      readonly status: "staged";
      readonly operationId: string;
      readonly operationStatus: "pending" | "acked" | "failed";
    }
  | {
      readonly status:
        | "needs_clarification"
        | "target_not_found"
        | "state_conflict";
      readonly candidates: readonly MemoryManageSearchHit[];
    };

/** Narrow closed management surface: exactly the four real ops. */
export interface MemoryManagePort {
  search(
    input: { sessionId: string; runId: string; query: string; limit: number },
    options?: { signal?: AbortSignal },
  ): Promise<MemoryManageSearchResult>;
  stage(
    input: {
      sessionId: string;
      runId: string;
      kind: "record.correct" | "record.retire" | "record.reactivate";
      searchId: string;
      handle?: string;
      correctionBody?: string;
      idempotencyKey: string;
      /**
       * Server-known caller origin. The kernel handler ALWAYS passes false
       * (model origin, hardcoded — never read from model args). Only the
       * trusted USER UI path (server HTTP route) passes true.
       */
      trustedSelection: boolean;
    },
    options?: { signal?: AbortSignal },
  ): Promise<MemoryManageStageResult>;
}

export interface MemoryToolsOptions {
  readonly repo: KernelRepository;
  readonly port: MemoryManagePort;
}

/* ------------------------------------------------------------------ */
/* Closed tool schemas (strict, model-facing handles only)              */
/* ------------------------------------------------------------------ */

const HANDLE_PATTERN = /^m[1-9][0-9]*$/;

/**
 * User-facing text bound in Unicode code points (not UTF-16 units): Zod
 * `.max()` counts UTF-16 code units and would reject valid astral-plane
 * input. Server storage enforces the same code-point budgets.
 */
function codePointsMax(maxCp: number): (value: string) => boolean {
  return (value: string): boolean => Array.from(value).length <= maxCp;
}

export const MemorySearchToolInputSchema = z.strictObject({
  query: z.string().min(1).refine(codePointsMax(500)),
  limit: z.number().int().min(1).max(8).default(5),
  searchId: z.string().min(1).max(256).optional(),
});

export const MemorySearchToolOutputSchema = z.strictObject({
  searchId: z.string().min(1),
  hits: z
    .array(
      z.strictObject({
        handle: z.string().regex(HANDLE_PATTERN),
        snippet: z.string().min(1).refine(codePointsMax(512)),
        status: z.enum(["active", "retired"]),
      }),
    )
    .max(8),
});

/**
 * Closed per-tool staging schemas (runtime enforcement mirrors the
 * advertised agent schemas): `memory.correct` REQUIRES `correctionBody`
 * (1..2000 code points); `memory.retire`/`memory.reactivate` MUST NOT
 * accept it (strict object without the property, so a supplied body is
 * rejected before staging).
 */
export const MemoryCorrectToolInputSchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  handle: z.string().regex(HANDLE_PATTERN).optional(),
  correctionBody: z.string().min(1).refine(codePointsMax(2000)),
});

export const MemoryRetireToolInputSchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  handle: z.string().regex(HANDLE_PATTERN).optional(),
});

/** Legacy shared staging schema (retained for compatibility checks). */
export const MemoryStageToolInputSchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  handle: z.string().regex(HANDLE_PATTERN).optional(),
  correctionBody: z.string().min(1).refine(codePointsMax(2000)).optional(),
});

export const MemoryStageToolOutputSchema = z.strictObject({
  status: z.enum([
    "staged",
    "needs_clarification",
    "target_not_found",
    "state_conflict",
  ]),
  operationId: z.string().min(1).max(256).optional(),
  operationStatus: z.enum(["pending", "acked", "failed"]).optional(),
  candidates: z
    .array(
      z.strictObject({
        handle: z.string().regex(HANDLE_PATTERN),
        snippet: z.string().min(1).refine(codePointsMax(512)),
        status: z.enum(["active", "retired"]),
      }),
    )
    .max(8)
    .optional(),
});

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

/** Map a fixed port failure to a closed broker `ToolError` code. */
export function mapMemoryPortCode(code: string): ToolError {
  switch (code) {
    case "service_unavailable":
    case "validation_error":
      return new ToolError("execution_failed");
    case "cancelled":
      return new ToolError("execution_cancelled");
    default:
      return new ToolError("execution_failed");
  }
}

/**
 * Build the `memory.search` read registration over an injected server-owned
 * port. Same-scope/deterministic: the port enforces the trusted startup
 * scope; the kernel never sees raw canonical ids.
 */
export function createMemorySearchRegistration(
  options: MemoryToolsOptions,
): ToolRegistration {
  const { repo, port } = options;
  return {
    descriptor: {
      name: "memory.search",
      version: 1,
      title: "Search conversation memories",
      description:
        "Explicit user-directed memory search over active and retired memories (archived and superseded excluded). Returns opaque mN handles; searching never changes, reactivates, or heats anything.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: MemorySearchToolInputSchema,
    outputSchema: MemorySearchToolOutputSchema,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      const parsed = MemorySearchToolInputSchema.parse(input);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const owned = requireOwnedRun(repo, ctx.runId);
      let result: MemoryManageSearchResult;
      try {
        result = await port.search(
          {
            sessionId: owned.sessionId,
            runId: owned.runId,
            query: parsed.query,
            limit: parsed.limit,
          },
          { signal: ctx.signal },
        );
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      return {
        searchId: result.searchId,
        hits: result.hits.map((hit) => ({
          handle: hit.handle,
          snippet: hit.snippet,
          status: hit.status,
        })),
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { hits: unknown[] };
      const count = Array.isArray(output.hits) ? output.hits.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };
}

function createMemoryStageRegistration(
  kind: "record.correct" | "record.retire" | "record.reactivate",
  title: string,
  description: string,
  options: MemoryToolsOptions,
): ToolRegistration {
  const { repo, port } = options;
  const toolName =
    kind === "record.correct"
      ? "memory.correct"
      : kind === "record.retire"
        ? "memory.retire"
        : "memory.reactivate";
  // Per-tool runtime schema: correct REQUIRES correctionBody, retire/
  // reactivate REJECT it (no such property under strictObject).
  const inputSchema =
    kind === "record.correct"
      ? MemoryCorrectToolInputSchema
      : MemoryRetireToolInputSchema;
  return {
    descriptor: {
      name: toolName,
      version: 1,
      title,
      description,
      category: "write",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema,
    outputSchema: MemoryStageToolOutputSchema,
    // Staging-only (same family as the C17 proposal-only mechanism): the
    // handler stages a durable outbox operation and never performs any
    // external write. This reuses the existing staging gate WITHOUT
    // permitting arbitrary external write tools or Calendar gate bypass:
    // the closed port exposes only this fixed op with fixed reason codes.
    proposalOnly: true,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      // Per-tool strict parsing: correct without correctionBody throws
      // here; retire/reactivate WITH correctionBody throws here (unknown
      // key under strictObject). Handler guards below are defense-in-depth.
      const parsed = (inputSchema as typeof MemoryCorrectToolInputSchema).parse(
        input,
      ) as {
        searchId: string;
        handle?: string;
        correctionBody?: string;
      };
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const owned = requireOwnedRun(repo, ctx.runId);
      if (kind === "record.correct" && parsed.correctionBody === undefined) {
        throw new ToolError("execution_failed");
      }
      if (kind !== "record.correct" && parsed.correctionBody !== undefined) {
        throw new ToolError("execution_failed");
      }
      let result: MemoryManageStageResult;
      try {
        // Narrow scoped staging callback: the port stages exactly this one
        // closed op through the durable outbox. No actual CLI mutation runs
        // in this handler; the service drain executes it later. A mutation
        // binds a single explicit UI-selected target (searchId + handle) or
        // a uniquely resolved same-scope search target; multiple candidates
        // without an explicit handle return needs_clarification with
        // NOTHING staged, even if the model arbitrarily chose one.
        result = await port.stage(
          {
            sessionId: owned.sessionId,
            runId: owned.runId,
            kind,
            searchId: parsed.searchId,
            ...(parsed.handle !== undefined ? { handle: parsed.handle } : {}),
            ...(parsed.correctionBody !== undefined
              ? { correctionBody: parsed.correctionBody }
              : {}),
            // Deterministic per-call staging key: the broker call id is
            // stable per tool call within the run audit, so a redelivered
            // handler call replays the same staged operation instead of
            // staging a duplicate. Random per-attempt keys are never minted.
            idempotencyKey: ctx.callId,
            // Untrusted model origin, HARDCODED server-side: model args can
            // never set this flag. Multi-candidate searches therefore stage
            // NOTHING even when the model supplies an explicit handle.
            trustedSelection: false,
          },
          { signal: ctx.signal },
        );
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      if (result.status === "staged") {
        return {
          status: "staged" as const,
          operationId: result.operationId,
          operationStatus: result.operationStatus,
        };
      }
      return {
        status: result.status,
        candidates: result.candidates.map((hit) => ({
          handle: hit.handle,
          snippet: hit.snippet,
          status: hit.status,
        })),
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      return { normalized: raw, observations: 0, modelFacing: raw };
    },
  };
}

/**
 * Build the three staging-only mutation registrations. Handlers stage via
 * the narrow closed port only; no external write ever runs here.
 */
export function createMemoryStageRegistrations(
  options: MemoryToolsOptions,
): ToolRegistration[] {
  return [
    createMemoryStageRegistration(
      "record.correct",
      "Stage a memory correction",
      "Stage (queue, not apply) a correction of one explicitly selected memory: a new raw source event plus a real record.correct preserving history. Requires the user's replacement text and a single explicit mN target, or exactly one search candidate.",
      options,
    ),
    createMemoryStageRegistration(
      "record.retire",
      "Stage a memory retirement",
      "Stage (queue, not apply) retirement of one explicitly selected memory (reversible, never deletion). Requires a single explicit mN target, or exactly one search candidate; ambiguous targets need user clarification.",
      options,
    ),
    createMemoryStageRegistration(
      "record.reactivate",
      "Stage a memory reactivation",
      "Stage (queue, not apply) reactivation of one explicitly selected retired memory. Requires a single explicit mN target, or exactly one search candidate; ambiguous targets need user clarification.",
      options,
    ),
  ];
}
