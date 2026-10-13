// M4 (C12) Calendar tool integration: a kernel-owned, dependency-inverted
// Calendar connector port + the `calendar.search` ToolBroker registration.
//
// DEPENDENCY INVERSION: the kernel NEVER imports `@companion/connector-*`.
// Callers inject a `CalendarConnectorPort` (structural subset of the real
// adapter surface) bound to a stored `connector_instances` row of kind
// `calendar`. The factory validates binding ownership/kind by id only.
//
// IDENTITY / PRIVACY (C12-07): normalized events carry an OPAQUE canonicalKey
// over (connectorInstanceId, calendarId, eventId); provider ids are never in
// the Snapshot/body, model-facing output, public DTO or a fixed error. The
// adapter returns host-private targets alongside the decoded page; the kernel
// persists them in a NON-PUBLIC store INSIDE the SAME `ReferenceManager`
// running-status/CAS observation transaction (through `onApplied`), so a
// cancelled/late/failed call never writes a target and a committed observation
// can never commit without its target.
//
// All observation/snapshot/rN allocation is delegated to the single existing
// `ReferenceManager` (C12-08); this module never writes those tables.

// C13: the search handler consumes the per-Turn frozen temporal context
// (now + IANA timeZone) read from the immutable `turns.frozen_context` on
// every call; Retry reuses the same frozen values (no recomputation) and the
// connector port receives both fields unchanged (§17.4, §9 blockers 2/3).

import {
  CalendarSearchToolInputSchema,
  CalendarSearchToolOutputSchema,
  MAX_SEARCH_QUERY_CODE_POINTS,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { ToolError, type ToolRegistration } from "./broker.js";
import { canonicalJsonString, sha256Hex } from "./canonical.js";
import {
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import type {
  ReferenceManager,
  ResourceObservation,
} from "./reference_manager.js";
import type { KernelRepository } from "./repository.js";

/* ------------------------------------------------------------------ */
/* Dependency-inverted Calendar port (kernel owns this shape)           */
/* ------------------------------------------------------------------ */

/** PRIVATE upstream get target. Provider ids never leave the host store. */
export interface CalendarGetTarget {
  readonly calendarId: string;
  readonly eventId: string;
  readonly account?: string;
}

/**
 * Structural normalized Calendar event consumed by the kernel. Identical in
 * shape to the connector's `NormalizedEvent`; the kernel owns this copy so it
 * stays connector-agnostic.
 */
export interface CalendarNormalizedEvent {
  readonly schemaVersion?: 1 | undefined;
  readonly canonicalKey: string;
  readonly status: "confirmed" | "tentative" | "cancelled" | "deleted";
  readonly title: string;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly start: string;
  readonly end: string;
  readonly allDayEndExclusive: boolean;
  readonly sourceUpdatedAt?: string | undefined;
  readonly sourceRevision: string;
  readonly revisionBasis: "etag" | "source-updated" | "normalized-hash";
  readonly sensitivity?: "personal" | undefined;
}

/** Host-private canonicalKey -> target mapping produced by one search page. */
export interface CalendarPrivateTarget {
  readonly canonicalKey: string;
  readonly target: CalendarGetTarget;
}

export type CalendarSearchPortResult =
  | {
      readonly ok: true;
      readonly events: readonly CalendarNormalizedEvent[];
      readonly cursor?: string;
      readonly targets: readonly CalendarPrivateTarget[];
    }
  | { readonly ok: false; readonly code: string };

export type CalendarGetPortResult =
  | { readonly ok: true; readonly event: CalendarNormalizedEvent }
  | { readonly ok: false; readonly code: string };

/**
 * Per-call frozen temporal context (§17.4): resolved from the immutable Turn
 * frozen context. `timeZone` is the IANA zone and `now` is the frozen Turn
 * instant; every `calendar.search` call carries both, and a Retry (new Run on
 * the SAME Turn) reuses the original values without recomputation.
 */
export interface CalendarSearchCallOptions {
  readonly signal?: AbortSignal;
  readonly timeZone: string;
  readonly now: number;
}

export interface CalendarCallOptions {
  readonly signal?: AbortSignal;
}

/** Dependency-inverted Calendar connector surface (structural only). */
export interface CalendarConnectorPort {
  readonly connectorInstanceId: string;
  search(
    input: unknown,
    options: CalendarSearchCallOptions,
  ): Promise<CalendarSearchPortResult>;
  get(
    target: CalendarGetTarget,
    options?: CalendarCallOptions,
  ): Promise<CalendarGetPortResult>;
}

/** One validated binding: stored instance id + live port (no provider ids). */
export interface CalendarConnectorBinding {
  readonly connectorInstanceId: string;
  readonly connector: CalendarConnectorPort;
}

/* ------------------------------------------------------------------ */
/* Private target store (durable in production)                         */
/* ------------------------------------------------------------------ */

/**
 * Host-private canonicalKey -> get target resolution. Synchronous by design
 * (the kernel repository is synchronous). The production server injects the
 * SQLite-backed {@link createDurableCalendarTargetStore}; the in-memory store
 * is a TEST default only and never production persistence.
 */
export interface CalendarTargetStore {
  get(canonicalKey: string): CalendarGetTarget | undefined;
  put(canonicalKey: string, target: CalendarGetTarget): void;
}

/** In-memory default (TESTS ONLY; never inject in production). */
export function createInMemoryCalendarTargetStore(): CalendarTargetStore {
  const map = new Map<string, CalendarGetTarget>();
  return {
    get: (key) => map.get(key),
    put: (key, target) => {
      map.set(key, target);
    },
  };
}

function validTarget(value: unknown): value is CalendarGetTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as {
    calendarId?: unknown;
    eventId?: unknown;
    account?: unknown;
  };
  return (
    typeof target.calendarId === "string" &&
    target.calendarId.length > 0 &&
    target.calendarId.length <= 512 &&
    typeof target.eventId === "string" &&
    target.eventId.length > 0 &&
    target.eventId.length <= 1024 &&
    (target.account === undefined ||
      (typeof target.account === "string" &&
        target.account.length > 0 &&
        target.account.length <= 512))
  );
}

/**
 * SQLite-backed durable target store (survives restart). One atomic
 * INSERT..ON CONFLICT statement per put; provider ids stay in this private
 * table and are never returned by any DTO.
 */
export function createDurableCalendarTargetStore(
  db: Database.Database,
): CalendarTargetStore {
  return {
    get(canonicalKey) {
      const row = db
        .prepare(
          "SELECT target_json FROM calendar_get_targets WHERE canonical_key = ?",
        )
        .get(canonicalKey) as { target_json: string } | undefined;
      if (row === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.target_json);
      } catch {
        throw new RepositoryValidationError("stored calendar target invalid");
      }
      if (!validTarget(parsed)) {
        throw new RepositoryValidationError("stored calendar target invalid");
      }
      return {
        calendarId: parsed.calendarId,
        eventId: parsed.eventId,
        ...(parsed.account !== undefined ? { account: parsed.account } : {}),
      };
    },
    put(canonicalKey, target) {
      if (!validTarget(target)) {
        throw new RepositoryValidationError("calendar target invalid");
      }
      // Sorted-key canonical JSON keeps idempotent writes byte-stable.
      const json = canonicalJsonString(target);
      db.prepare(
        `INSERT INTO calendar_get_targets (canonical_key, target_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(canonical_key) DO UPDATE SET target_json = excluded.target_json, updated_at = excluded.updated_at`,
      ).run(canonicalKey, json, Date.now());
    },
  };
}

/* ------------------------------------------------------------------ */
/* Observation conversion                                               */
/* ------------------------------------------------------------------ */

/** Max revision signal accepted by ReferenceManager (SourceRevisionSchema). */
const MAX_SOURCE_REVISION = 256;
/** Max display title accepted by ReferenceManager (ReferenceTitleSchema). */
const MAX_OBSERVATION_TITLE = 512;

/**
 * Deterministic, provider-id-free snapshot text for one normalized event.
 * Stable key order (canonical JSON) so identical events hash identically.
 */
export function calendarEventBodyText(event: CalendarNormalizedEvent): string {
  return canonicalJsonString({
    status: event.status,
    title: event.title,
    ...(event.description !== undefined
      ? { description: event.description }
      : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    start: event.start,
    end: event.end,
    allDayEndExclusive: event.allDayEndExclusive,
  });
}

/** Convert one normalized event to a ReferenceManager observation. */
export function toCalendarObservation(
  event: CalendarNormalizedEvent,
  connectorInstanceId: string,
  observedAt: number,
): ResourceObservation {
  const title =
    event.title.length === 0
      ? null
      : event.title.slice(0, MAX_OBSERVATION_TITLE);
  // Bound the opaque revision to the accepted width; hash only when longer so
  // distinct long etags/revisions still compare unequal.
  const sourceRevision =
    event.sourceRevision.length <= MAX_SOURCE_REVISION
      ? event.sourceRevision
      : sha256Hex(event.sourceRevision);
  return {
    connectorInstanceId,
    canonicalKey: event.canonicalKey,
    title,
    text: calendarEventBodyText(event),
    sourceRevision,
    observedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Calendar-origin related Markdown exploration (C13-06 fix)            */
/* ------------------------------------------------------------------ */

/**
 * Deterministic bounded Markdown query derived from a stored normalized
 * Calendar title (the stable canonical evidence, §17.8 cross-source flow).
 *
 * The stored `resources.title` is already NFC-normalized by the
 * ReferenceManager; re-normalization is idempotent. The derivation is pure
 * and deterministic: NFC, exact `String.trim()` of leading/trailing
 * whitespace, then a code-point truncation to the EXACT Markdown search
 * query bound (1..256 code points, `MAX_SEARCH_QUERY_CODE_POINTS`), so the
 * result always satisfies the existing `SearchQuerySchema` semantics and no
 * bounded query rule is invented here.
 *
 * `null` means "nothing derivable" (absent or whitespace-only title): the
 * caller MUST NOT search and must return zero related references instead of
 * guessing a query. No upstream/provider id, path or secret can enter the
 * query: only the stored display title is used.
 */
export function deriveCalendarRelatedQuery(
  title: string | null,
): string | null {
  if (typeof title !== "string" || title.length === 0) {
    return null;
  }
  const trimmed = title.normalize("NFC").trim();
  if (trimmed.length === 0) {
    return null;
  }
  return Array.from(trimmed)
    .slice(0, MAX_SEARCH_QUERY_CODE_POINTS)
    .join("");
}

/* ------------------------------------------------------------------ */
/* calendar.search registration                                         */
/* ------------------------------------------------------------------ */

export interface CreateCalendarSearchRegistrationOptions {
  readonly repo: KernelRepository;
  readonly referenceManager: ReferenceManager;
  readonly binding: CalendarConnectorBinding;
  readonly targetStore: CalendarTargetStore;
  readonly clock?: { now(): number };
}

function requireCalendarPort(
  connector: CalendarConnectorPort,
  what: string,
): CalendarConnectorPort {
  if (
    typeof connector !== "object" ||
    connector === null ||
    typeof (connector as { search?: unknown }).search !== "function" ||
    typeof (connector as { get?: unknown }).get !== "function"
  ) {
    throw new RepositoryValidationError(`${what} must expose search/get`);
  }
  return connector;
}

/**
 * Build the `calendar.search` registration over an already-validated binding.
 * The frozen temporal context (now + IANA timeZone) is read per call from the
 * Run's immutable Turn frozen context, never from construction state; Retry
 * on the same Turn reuses the original values (§17.4). Host-private targets
 * are persisted through the `presentObservations` transaction itself (inside
 * its running-status/CAS recheck), so targets and their Snapshot/rN commit or
 * roll back together (cancelled/late/failed calls write none).
 */
export function createCalendarSearchRegistration(
  options: CreateCalendarSearchRegistrationOptions,
): ToolRegistration {
  const { repo, referenceManager, binding, targetStore } = options;
  requireCalendarPort(binding.connector, "calendar connector binding");
  const clock = options.clock ?? { now: () => Date.now() };
  const connector = binding.connector;

  function frozenTemporal(runId: string): { now: number; timeZone: string } {
    try {
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
      // Frozen at Turn creation; never recomputed, rewritten or defaulted
      // per Run (Retry reuses this exact object through the stored row).
      return turn.frozenContext.temporal;
    } catch (error) {
      if (error instanceof RepositoryNotFoundError) {
        throw new ToolError("execution_failed");
      }
      throw new ToolError("execution_failed");
    }
  }

  return {
    descriptor: {
      name: "calendar.search",
      version: 1,
      title: "Search calendar events",
      description:
        "One-page Calendar search with Snapshot materialization (frozen zone)",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: true,
    },
    inputSchema: CalendarSearchToolInputSchema,
    outputSchema: CalendarSearchToolOutputSchema,
    dedupMode: "normal",
    handler: (async (input: unknown, ctx) => {
      const sessionId = repo.getRun(ctx.runId).sessionId;
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const temporal = frozenTemporal(ctx.runId);
      let result: CalendarSearchPortResult;
      try {
        result = await connector.search(input, {
          signal: ctx.signal,
          timeZone: temporal.timeZone,
          now: temporal.now,
        });
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      if (!result.ok) {
        throw mapCalendarCode(result.code);
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const now = clock.now();
      const observations = result.events.map((event) =>
        toCalendarObservation(event, binding.connectorInstanceId, now),
      );
      const statusByKey = new Map(
        result.events.map((event) => [event.canonicalKey, event.status]),
      );
      const targetByKey = new Map(
        result.targets.map((entry) => [entry.canonicalKey, entry.target]),
      );
      let presented: ReturnType<ReferenceManager["presentObservations"]>;
      try {
        presented = referenceManager.presentObservations(
          sessionId,
          ctx.runId,
          observations,
          {
            freshness: "normal",
            now,
            // Durable private target writes happen INSIDE the observation
            // transaction, after the running-status/CAS recheck. A cancelled/
            // terminal run never reaches this callback and a throw here rolls
            // back both the public rows and every target write, so targets and
            // their Snapshot/rN are always atomic (no late post-commit write).
            onApplied: ({ references }) => {
              for (const ref of references) {
                const target = targetByKey.get(ref.canonicalKey);
                if (target !== undefined) {
                  targetStore.put(ref.canonicalKey, target);
                }
              }
            },
          },
        );
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      if (!presented.applied) {
        // Cancelled/terminal: the transaction (and the onApplied target
        // writes) never committed, so no target outlives the observation.
        throw new ToolError("execution_cancelled");
      }
      // Model-facing output: structural ids + display fields + snippet only.
      const hits = presented.references.map((ref) => ({
        referenceId: ref.referenceId,
        ordinal: ref.ordinal,
        snapshotId: ref.snapshotId,
        resourceId: ref.resourceId,
        canonicalKey: ref.canonicalKey,
        title: ref.title,
        status: statusByKey.get(ref.canonicalKey) ?? "confirmed",
        snippet: ref.snippet,
      }));
      return result.cursor !== undefined
        ? { hits, cursor: result.cursor }
        : { hits };
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { hits: unknown[] };
      const count = Array.isArray(output.hits) ? output.hits.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };
}

/** Map a fixed Calendar/MCP code to a closed broker `ToolError` code. */
export function mapCalendarCode(code: string): ToolError {
  switch (code) {
    case "mcp_unavailable":
    case "mcp_binding_not_allowed":
    case "mcp_schema_mismatch":
    case "calendar_response_invalid":
    case "calendar_upstream_error":
    case "calendar_range_invalid":
      return new ToolError(code);
    default:
      return new ToolError("execution_failed");
  }
}
