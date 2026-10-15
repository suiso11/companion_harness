// M1 reference tools (§14.2, §14.4-§14.6): kernel-owned ToolBroker
// registrations for `markdown.search` / `reference.open` /
// `reference.refresh` / `reference.related`.
//
// DEPENDENCY INVERSION: the kernel NEVER imports the connector package.
// Callers inject a `MarkdownConnectorPort` (structural subset of the
// connector surface) bound to a stored `connector_instances` row. The factory
// validates binding ownership/kind (`kind = 'markdown'`) by id only and never
// reads or stores absolute paths (`config_json` is never inspected).
//
// FLOWS (all `category: "read"`, static, `version: 1`, strict contracts):
// - search: external `search()` first, map hits to `ResourceObservation`
//   (standard then wiki link metadata), `presentObservations` with freshness
//   `normal` REGARDLESS of the search input `freshness` (input freshness only
//   drives Broker dedup via `input_freshness`), return contract output with
//   query-specific snippets plus all `skipped`. Post-read cancel/terminal
//   (`applied: false` or aborted signal) throws `execution_cancelled` with no
//   materialization of the cancelled call (earlier committed calls persist).
// - open: stored `getReferenceDetail` + `presentStored` only; no connector
//   call; returns the stored full body.
// - refresh: resolve the owned reference to connector/canonical key from
//   stored DB metadata (`resources` row for the reference's resource),
//   external `readCanonical` OUTSIDE any transaction, then
//   `presentObservations` with freshness `refresh` (same bytes always yield a
//   new Snapshot+rN). Registration uses `dedupMode: "always_bypass"` so
//   identical logical args always execute.
// - related: Markdown-origin references stay stored-only
//   (`getRelatedStored` then `presentStored`; no connector read; the generic
//   same-connector link-graph path is unchanged and never weakened).
//   Calendar-origin references explore the cross-source flow instead
//   (§17.8): a deterministic READ-ONLY Markdown search derived from the
//   stored normalized Calendar title, mapped to observations and
//   `presentObservations`ed with freshness `normal` so the hits materialize
//   as real rN references through the ordinary M1 pathways. Zero hits, an
//   underivable title, or a Calendar-only deployment (no Markdown binding)
//   return an honest empty `references` (never a fake cross-source claim).
//   No Markdown write ever happens and no link row is written
//   cross-connector.
//
// NORMALIZERS count search hits / open one / refresh one / related refs as
// observations and return ONLY the contract output as model-facing.
//
// ERRORS map connector fixed M1 codes to `ToolError`, `ReferenceNotFound`
// to `reference_not_found`, aborts to `execution_cancelled`, and any
// malformed/internal failure to fixed safe codes only (never raw text/paths).
//
// TWO-PHASE NOTE (M1, acknowledged): the handler's ReferenceManager
// transaction commits first; Broker output/cumulative validation runs AFTER
// (in `executePhysical` normalization + `reserveCumulative`). An oversized or
// schema-invalid output therefore leaves its Snapshot/rN/`reference.presented`
// materialized while the tool result is `failed`/`discarded`. M1 does NOT
// redesign the two-phase commit; tests assert the materialization persists.
import {
  MarkdownSearchToolInputSchema,
  MarkdownSearchToolOutputSchema,
  ReferenceOpenToolInputSchema,
  ReferenceOpenToolOutputSchema,
  ReferenceRefreshToolInputSchema,
  ReferenceRefreshToolOutputSchema,
  ReferenceRelatedToolInputSchema,
  ReferenceRelatedToolOutputSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { ToolError, type ToolRegistration } from "./broker.js";
import {
  type CalendarConnectorBinding,
  type CalendarGetPortResult,
  type CalendarTargetStore,
  createCalendarSearchRegistration,
  createInMemoryCalendarTargetStore,
  deriveCalendarRelatedQuery,
  mapCalendarCode,
  toCalendarObservation,
} from "./calendar_tools.js";
import { isUuidV4 } from "./canonical.js";
import { ReferenceNotFoundError, RepositoryValidationError } from "./errors.js";
import type {
  ReferenceManager,
  ResourceObservation,
} from "./reference_manager.js";
import type { KernelRepository } from "./repository.js";

/* ------------------------------------------------------------------ */
/* Dependency-inverted connector port (kernel owns this shape)          */
/* ------------------------------------------------------------------ */

/** Standard link as exposed through the port (path-free). */
export interface MarkdownPortStandardLink {
  readonly status: "resolved" | "unresolved";
  readonly canonicalKey?: string;
}

/** Wiki link as exposed through the port (path-free candidates). */
export interface MarkdownPortWikiLink {
  readonly status: "resolved" | "ambiguous" | "unresolved";
  readonly candidates: readonly string[];
  readonly canonicalKey?: string;
}

/** One search hit through the port (query-specific snippet + full text). */
export interface MarkdownPortSearchHit {
  readonly canonicalKey: string;
  readonly title: string;
  readonly snippet: string;
  readonly text: string;
  readonly sourceRevision: string;
  readonly standardLinks: readonly MarkdownPortStandardLink[];
  readonly wikiLinks: readonly MarkdownPortWikiLink[];
}

/** One skipped file through the port (closed reason union). */
export interface MarkdownPortSkipped {
  readonly canonicalKey: string;
  readonly reason: "file_too_large" | "invalid_utf8";
}

/** Search result through the port. */
export interface MarkdownPortSearchResult {
  readonly hits: readonly MarkdownPortSearchHit[];
  readonly skipped: readonly MarkdownPortSkipped[];
}

/** Canonical document through the port. */
export interface MarkdownPortDocument {
  readonly canonicalKey: string;
  readonly title: string;
  readonly text: string;
  readonly sourceRevision: string;
  readonly snippet: string;
  readonly standardLinks: readonly MarkdownPortStandardLink[];
  readonly wikiLinks: readonly MarkdownPortWikiLink[];
}

/**
 * Dependency-inverted Markdown connector surface. Structural only: the kernel
 * never imports the connector package; any object with these two methods
 * satisfies the port (the real connector is assignable). Both methods accept
 * an optional `{ signal }` for cooperative cancellation; connectors that
 * predate the signal argument remain assignable (fewer parameters), and the
 * kernel always passes `ctx.signal` so cancellable connectors abort early
 * while non-cooperative ones are still discarded post-hoc via the aborted
 * check before `presentObservations`.
 */
export interface MarkdownConnectorPort {
  search(
    input: { query: string; limit: number },
    options?: { signal?: AbortSignal },
  ): Promise<MarkdownPortSearchResult>;
  readCanonical(
    canonicalKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<MarkdownPortDocument>;
}

/** One validated binding: stored instance id + live port (no paths). */
export interface MarkdownConnectorBinding {
  readonly connectorInstanceId: string;
  readonly connector: MarkdownConnectorPort;
}

/** Factory options: db + repo + ReferenceManager + binding(s) + clock. */
export interface CreateM1ToolRegistrationsOptions {
  readonly db: Database.Database;
  readonly repo: KernelRepository;
  readonly referenceManager: ReferenceManager;
  readonly bindings: readonly MarkdownConnectorBinding[];
  /**
   * Optional single trusted Calendar binding (C12). When present a
   * `calendar.search` registration is added and `reference.refresh` dispatches
   * Calendar resources through the same single factory by stored connector
   * kind. Absent => exact M1 Markdown-only behavior.
   */
  readonly calendarBinding?: CalendarConnectorBinding;
  /**
   * Private Calendar target resolution. Defaults to an in-memory store (tests
   * only); the production server MUST inject the durable SQLite store.
   */
  readonly calendarTargetStore?: CalendarTargetStore;
  readonly clock?: { now(): number };
}

function requirePort(
  connector: MarkdownConnectorPort,
  what: string,
): MarkdownConnectorPort {
  if (
    typeof connector !== "object" ||
    connector === null ||
    typeof (connector as { search?: unknown }).search !== "function" ||
    typeof (connector as { readCanonical?: unknown }).readCanonical !==
      "function"
  ) {
    throw new RepositoryValidationError(
      `${what} must expose search/readCanonical`,
    );
  }
  return connector;
}

function mapToToolError(error: unknown, signal?: AbortSignal): ToolError {
  if (signal?.aborted) {
    return new ToolError("execution_cancelled");
  }
  if (error instanceof ToolError) {
    return error;
  }
  if (error instanceof ReferenceNotFoundError) {
    return new ToolError("reference_not_found");
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (
        code === "markdown_vault_too_large" ||
        code === "markdown_path_unsafe" ||
        code === "markdown_read_failed" ||
        code === "markdown_read_changed" ||
        code === "reference_not_found" ||
        code === "output_too_large" ||
        code === "invalid_input"
      ) {
        return new ToolError(code);
      }
      if (code === "reference_not_found") {
        return new ToolError("reference_not_found");
      }
      if (code === "execution_cancelled") {
        return new ToolError("execution_cancelled");
      }
    }
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || /abort/i.test(error.name)) {
      return new ToolError("execution_cancelled");
    }
  }
  return new ToolError("execution_failed");
}

function toObservationLinks(
  standard: readonly MarkdownPortStandardLink[],
  wiki: readonly MarkdownPortWikiLink[],
): NonNullable<ResourceObservation["links"]> {
  const links: Array<{
    kind: "standard" | "wiki";
    status: "resolved" | "ambiguous" | "unresolved";
    candidates: readonly string[];
  }> = [];
  for (const entry of standard) {
    if (entry.status === "resolved" && typeof entry.canonicalKey === "string") {
      links.push({
        kind: "standard",
        status: "resolved",
        candidates: [entry.canonicalKey],
      });
    } else if (entry.status === "unresolved") {
      links.push({ kind: "standard", status: "unresolved", candidates: [] });
    } else {
      throw new ToolError("execution_failed");
    }
  }
  for (const entry of wiki) {
    if (entry.status === "resolved") {
      const single =
        entry.canonicalKey !== undefined
          ? [entry.canonicalKey]
          : [...entry.candidates];
      if (single.length !== 1) {
        throw new ToolError("execution_failed");
      }
      links.push({ kind: "wiki", status: "resolved", candidates: single });
    } else if (entry.status === "ambiguous") {
      links.push({
        kind: "wiki",
        status: "ambiguous",
        candidates: [...entry.candidates],
      });
    } else if (entry.status === "unresolved") {
      links.push({ kind: "wiki", status: "unresolved", candidates: [] });
    } else {
      throw new ToolError("execution_failed");
    }
  }
  return links;
}

/**
 * Create the four M1 ToolBroker registrations. Validates every binding's
 * connector instance ownership/kind (`SELECT kind ... WHERE id = ?` must be
 * `'markdown'`) without reading/storing paths. No HTTP endpoints, no M2
 * Agent/EvidenceGrant.
 *
 * M1 ARCHITECTURE (exact): exactly one Markdown connector binding is
 * required. That single connector instance owns all configured roots
 * (multi-root vaults live inside the one connector); passing zero bindings
 * or more than one binding is rejected rather than silently ignoring extra
 * connectors (the factory previously searched only the first binding, which
 * silently dropped the rest).
 */
export function createM1ToolRegistrations(
  options: CreateM1ToolRegistrationsOptions,
): readonly ToolRegistration[] {
  const { db, repo, referenceManager } = options;
  if (
    db === undefined ||
    repo === undefined ||
    referenceManager === undefined
  ) {
    throw new RepositoryValidationError(
      "db, repo, and referenceManager are required",
    );
  }
  const bindings = options.bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > 1) {
    throw new RepositoryValidationError(
      "exactly one markdown connector binding is allowed (one connector owns all roots)",
    );
  }
  const clock = options.clock ?? { now: () => Date.now() };
  const byId = new Map<string, MarkdownConnectorPort>();
  for (const binding of bindings) {
    if (!isUuidV4(binding.connectorInstanceId)) {
      throw new RepositoryValidationError(
        "connectorInstanceId must be a UUID v4",
      );
    }
    requirePort(binding.connector, "connector binding");
    if (byId.has(binding.connectorInstanceId)) {
      throw new RepositoryValidationError("duplicate connector binding");
    }
    // Ownership/kind check by id only; never inspect config_json (no paths).
    const row = db
      .prepare("SELECT kind FROM connector_instances WHERE id = ?")
      .get(binding.connectorInstanceId) as { kind: string } | undefined;
    if (row === undefined) {
      throw new RepositoryValidationError("connector instance not found");
    }
    if (row.kind !== "markdown") {
      throw new RepositoryValidationError(
        "connector instance kind must be markdown",
      );
    }
    byId.set(binding.connectorInstanceId, binding.connector);
  }
  // Optional single Calendar binding (C12). Validated by id/kind only; the
  // private per-event targets live in the injected store, never here.
  const calendarBinding = options.calendarBinding;
  if (calendarBinding !== undefined) {
    if (!isUuidV4(calendarBinding.connectorInstanceId)) {
      throw new RepositoryValidationError(
        "calendar connectorInstanceId must be a UUID v4",
      );
    }
    if (
      typeof calendarBinding.connector !== "object" ||
      calendarBinding.connector === null ||
      typeof (calendarBinding.connector as { search?: unknown }).search !==
        "function" ||
      typeof (calendarBinding.connector as { get?: unknown }).get !== "function"
    ) {
      throw new RepositoryValidationError(
        "calendar connector binding must expose search/get",
      );
    }
    if (byId.has(calendarBinding.connectorInstanceId)) {
      throw new RepositoryValidationError("duplicate connector binding");
    }
    const row = db
      .prepare("SELECT kind FROM connector_instances WHERE id = ?")
      .get(calendarBinding.connectorInstanceId) as { kind: string } | undefined;
    if (row === undefined) {
      throw new RepositoryValidationError("connector instance not found");
    }
    if (row.kind !== "calendar") {
      throw new RepositoryValidationError(
        "connector instance kind must be calendar",
      );
    }
  }
  if (bindings.length === 0 && calendarBinding === undefined) {
    throw new RepositoryValidationError(
      "exactly one connector binding is required (one connector owns all roots)",
    );
  }
  const calendarTargetStore =
    options.calendarTargetStore ?? createInMemoryCalendarTargetStore();
  // M1 uses the single binding as the search/default vault. The one
  // connector owns every configured root; multi-root fan-out inside the
  // connector stays deterministic with per-hit owning connectorInstanceId.
  const defaultBinding = bindings[0] as MarkdownConnectorBinding | undefined;

  function sessionOf(runId: string): string {
    try {
      return repo.getRun(runId).sessionId;
    } catch {
      throw new ToolError("execution_failed");
    }
  }

  const search: ToolRegistration = {
    descriptor: {
      name: "markdown.search",
      version: 1,
      title: "Search Markdown vault",
      description:
        "Deterministic Markdown search with Snapshot materialization",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: true,
    },
    inputSchema: MarkdownSearchToolInputSchema,
    outputSchema: MarkdownSearchToolOutputSchema,
    dedupMode: "input_freshness",
    handler: (async (input: unknown, ctx) => {
      const binding = defaultBinding;
      if (binding === undefined) {
        throw new ToolError("execution_failed");
      }
      const parsed = input as {
        query: string;
        limit: number;
        freshness: string;
      };
      const sessionId = sessionOf(ctx.runId);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      // External discovery/read FIRST, outside any DB transaction.
      // ctx.signal is passed through so cooperative connectors abort early;
      // the post-call aborted check below still discards results from
      // non-cooperative connectors before any materialization.
      let result: MarkdownPortSearchResult;
      try {
        result = await binding.connector.search(
          {
            query: parsed.query,
            limit: parsed.limit,
          },
          { signal: ctx.signal },
        );
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const now = clock.now();
      const observations: ResourceObservation[] = [];
      const snippetByKey = new Map<string, string>();
      try {
        for (const hit of result.hits ?? []) {
          if (
            typeof hit.canonicalKey !== "string" ||
            typeof hit.title !== "string" ||
            typeof hit.text !== "string" ||
            typeof hit.sourceRevision !== "string" ||
            typeof hit.snippet !== "string"
          ) {
            throw new ToolError("execution_failed");
          }
          const links = toObservationLinks(
            hit.standardLinks ?? [],
            hit.wikiLinks ?? [],
          );
          observations.push({
            connectorInstanceId: binding.connectorInstanceId,
            canonicalKey: hit.canonicalKey,
            title: hit.title,
            text: hit.text,
            sourceRevision: hit.sourceRevision,
            observedAt: now,
            links,
          });
          snippetByKey.set(hit.canonicalKey, hit.snippet);
        }
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      // Always `normal`: input freshness only drives Broker dedup bypass, never
      // re-materialization semantics here.
      let presented: Awaited<
        ReturnType<ReferenceManager["presentObservations"]>
      >;
      try {
        presented = referenceManager.presentObservations(
          sessionId,
          ctx.runId,
          observations,
          { freshness: "normal", now },
        );
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (!presented.applied) {
        throw new ToolError("execution_cancelled");
      }
      const hits = presented.references.map((ref) => ({
        referenceId: ref.referenceId,
        ordinal: ref.ordinal,
        snapshotId: ref.snapshotId,
        resourceId: ref.resourceId,
        canonicalKey: ref.canonicalKey,
        title: ref.title,
        snippet: snippetByKey.get(ref.canonicalKey) ?? ref.snippet,
      }));
      const skipped = [...(result.skipped ?? [])].map((entry) => {
        if (
          typeof entry.canonicalKey !== "string" ||
          (entry.reason !== "file_too_large" && entry.reason !== "invalid_utf8")
        ) {
          throw new ToolError("execution_failed");
        }
        return { canonicalKey: entry.canonicalKey, reason: entry.reason };
      });
      return { hits, skipped };
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { hits: unknown[] };
      const count = Array.isArray(output.hits) ? output.hits.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };

  const open: ToolRegistration = {
    descriptor: {
      name: "reference.open",
      version: 1,
      title: "Open stored reference",
      description: "Present a saved Snapshot only (no external read)",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: ReferenceOpenToolInputSchema,
    outputSchema: ReferenceOpenToolOutputSchema,
    handler: (async (input: unknown, ctx) => {
      const parsed = input as { referenceId: string };
      const sessionId = sessionOf(ctx.runId);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      // Saved repository detail only; no connector call by construction.
      let detail: Awaited<ReturnType<KernelRepository["getReferenceDetail"]>>;
      try {
        detail = repo.getReferenceDetail(sessionId, parsed.referenceId);
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      let presented: Awaited<ReturnType<ReferenceManager["presentStored"]>>;
      try {
        presented = referenceManager.presentStored(
          sessionId,
          ctx.runId,
          [parsed.referenceId],
          { now: clock.now() },
        );
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (!presented.applied) {
        throw new ToolError("execution_cancelled");
      }
      const view = presented.references[0];
      if (view === undefined) {
        throw new ToolError("execution_failed");
      }
      return {
        referenceId: view.referenceId,
        ordinal: view.ordinal,
        snapshotId: view.snapshotId,
        resourceId: view.resourceId,
        canonicalKey: view.canonicalKey,
        title: view.title,
        snippet: view.snippet,
        body: detail.body,
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => ({
      normalized: raw,
      observations: 1,
      modelFacing: raw,
    }),
  };

  const refresh: ToolRegistration = {
    descriptor: {
      name: "reference.refresh",
      version: 1,
      title: "Refresh stored reference",
      description: "Reread an owned reference; always a new Snapshot+rN",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: true,
    },
    inputSchema: ReferenceRefreshToolInputSchema,
    outputSchema: ReferenceRefreshToolOutputSchema,
    dedupMode: "always_bypass",
    handler: (async (input: unknown, ctx) => {
      const parsed = input as { referenceId: string };
      const sessionId = sessionOf(ctx.runId);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      // Resolve the owned reference to connector/canonical key AND the stored
      // connector kind so refresh dispatches to the right connector surface.
      let connectorInstanceId: string;
      let canonicalKey: string;
      let kind: string;
      try {
        const detail = repo.getReferenceDetail(sessionId, parsed.referenceId);
        const row = db
          .prepare(
            "SELECT connector_instance_id, canonical_key FROM resources WHERE id = ?",
          )
          .get(detail.resource.id) as
          | { connector_instance_id: string; canonical_key: string }
          | undefined;
        if (row === undefined) {
          throw new ToolError("reference_not_found");
        }
        connectorInstanceId = row.connector_instance_id;
        canonicalKey = row.canonical_key;
        const instance = db
          .prepare("SELECT kind FROM connector_instances WHERE id = ?")
          .get(connectorInstanceId) as { kind: string } | undefined;
        if (instance === undefined) {
          throw new ToolError("reference_not_found");
        }
        kind = instance.kind;
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      const now = clock.now();
      let observation: ResourceObservation;
      if (kind === "calendar") {
        // Calendar dispatch: private target from the non-public store, then an
        // exact `get-event` read. open stays stored-only; only refresh reads.
        const calendarPort = calendarBinding?.connector;
        if (
          calendarPort === undefined ||
          calendarBinding?.connectorInstanceId !== connectorInstanceId
        ) {
          throw new ToolError("reference_not_found");
        }
        const target = calendarTargetStore.get(canonicalKey);
        if (target === undefined) {
          // Never guess provider ids: without the private target a Calendar
          // reference cannot be re-read (stored open remains available).
          throw new ToolError("reference_not_found");
        }
        let got: CalendarGetPortResult;
        try {
          got = await calendarPort.get(target, { signal: ctx.signal });
        } catch (error) {
          throw mapToToolError(error, ctx.signal);
        }
        if (!got.ok) {
          throw mapCalendarCode(got.code);
        }
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        observation = toCalendarObservation(
          got.event,
          connectorInstanceId,
          now,
        );
      } else {
        const port = byId.get(connectorInstanceId);
        if (port === undefined) {
          throw new ToolError("reference_not_found");
        }
        // External readCanonical OUTSIDE any transaction, with cooperative
        // cancellation via ctx.signal.
        let doc: MarkdownPortDocument;
        try {
          doc = await port.readCanonical(canonicalKey, { signal: ctx.signal });
        } catch (error) {
          throw mapToToolError(error, ctx.signal);
        }
        if (ctx.signal.aborted) {
          throw new ToolError("execution_cancelled");
        }
        try {
          if (
            typeof doc.title !== "string" ||
            typeof doc.text !== "string" ||
            typeof doc.sourceRevision !== "string"
          ) {
            throw new ToolError("execution_failed");
          }
          observation = {
            connectorInstanceId,
            canonicalKey,
            title: doc.title,
            text: doc.text,
            sourceRevision: doc.sourceRevision,
            observedAt: now,
            links: toObservationLinks(
              doc.standardLinks ?? [],
              doc.wikiLinks ?? [],
            ),
          };
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError("execution_failed");
        }
      }
      // Freshness `refresh` so identical bytes still yield Snapshot+rN.
      let presented: Awaited<
        ReturnType<ReferenceManager["presentObservations"]>
      >;
      try {
        presented = referenceManager.presentObservations(
          sessionId,
          ctx.runId,
          [observation],
          { freshness: "refresh", now },
        );
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (!presented.applied) {
        throw new ToolError("execution_cancelled");
      }
      const view = presented.references[0];
      if (view === undefined) {
        throw new ToolError("execution_failed");
      }
      return {
        referenceId: view.referenceId,
        ordinal: view.ordinal,
        snapshotId: view.snapshotId,
        resourceId: view.resourceId,
        canonicalKey: view.canonicalKey,
        title: view.title,
        snippet: view.snippet,
        body: { version: 1, text: observation.text.normalize("NFC") },
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => ({
      normalized: raw,
      observations: 1,
      modelFacing: raw,
    }),
  };

  const related: ToolRegistration = {
    descriptor: {
      name: "reference.related",
      version: 1,
      title: "Related references",
      description:
        "Markdown origin: stored link-graph neighbors only (no external read). Calendar origin: deterministic read-only Markdown search from the event title.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: ReferenceRelatedToolInputSchema,
    outputSchema: ReferenceRelatedToolOutputSchema,
    handler: (async (input: unknown, ctx) => {
      const parsed = input as { referenceId: string; limit: number };
      const sessionId = sessionOf(ctx.runId);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      // Resolve the base reference's connector kind from stored metadata
      // (never external I/O) so the two flows stay explicit and disjoint.
      let baseKind: string;
      let baseResourceId: string;
      try {
        const base = db
          .prepare(
            `SELECT r.id AS resource_id, ci.kind AS kind
               FROM session_references sr
               JOIN resources r ON r.id = sr.resource_id
               JOIN connector_instances ci ON ci.id = r.connector_instance_id
              WHERE sr.session_id = ? AND sr.id = ?`,
          )
          .get(sessionId, parsed.referenceId) as
          | { resource_id: string; kind: string }
          | undefined;
        if (base === undefined) {
          throw new ToolError("reference_not_found");
        }
        baseKind = base.kind;
        baseResourceId = base.resource_id;
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }

      if (baseKind !== "calendar") {
        // Generic SAME-CONNECTOR stored link-graph path (M1, unchanged).
        // Stored-only graph read; no connector call by construction.
        let stored: Awaited<ReturnType<ReferenceManager["getRelatedStored"]>>;
        try {
          stored = referenceManager.getRelatedStored(
            sessionId,
            parsed.referenceId,
            parsed.limit,
          );
        } catch (error) {
          throw mapToToolError(error, ctx.signal);
        }
        let presented: Awaited<ReturnType<ReferenceManager["presentStored"]>>;
        try {
          presented = referenceManager.presentStored(
            sessionId,
            ctx.runId,
            stored.map((entry) => entry.referenceId),
            { now: clock.now() },
          );
        } catch (error) {
          throw mapToToolError(error, ctx.signal);
        }
        if (!presented.applied) {
          throw new ToolError("execution_cancelled");
        }
        return {
          references: stored.map((entry) => ({
            referenceId: entry.referenceId,
            ordinal: entry.ordinal,
            snapshotId: entry.snapshotId,
            resourceId: entry.resourceId,
            canonicalKey: entry.canonicalKey,
            title: entry.title,
          })),
        };
      }

      // Calendar-origin cross-source exploration (C13-06/07, §17.8):
      // Calendar snapshots carry no link rows (ReferenceManager links are
      // SAME-CONNECTOR by construction, so `getRelatedStored` is provably
      // empty here), and a deterministic empty result is NOT cross-source
      // exploration. The deliberate flow is a real, deterministic, bounded
      // READ-ONLY Markdown search derived from the stored normalized
      // Calendar title, materialized through the ordinary
      // presentObservations/rN pathways. No Markdown writes; no link row is
      // written cross-connector (same-connector identity is never weakened).
      const markdownBinding = defaultBinding;
      if (markdownBinding === undefined) {
        // Calendar-only deployment: no configured Markdown binding means no
        // exploration surface; the honest result is zero references.
        return { references: [] };
      }
      let title: string | null;
      try {
        const row = db
          .prepare("SELECT title FROM resources WHERE id = ?")
          .get(baseResourceId) as { title: string | null } | undefined;
        title = row?.title ?? null;
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      const query = deriveCalendarRelatedQuery(title);
      if (query === null) {
        // No derivable bounded query (absent/blank title): honest empty.
        return { references: [] };
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      // Existing Markdown search pathway with the bounded query semantics
      // (query 1..256 code points via the derivation above, limit from the
      // validated input). Cooperative cancellation via ctx.signal.
      let result: MarkdownPortSearchResult;
      try {
        result = await markdownBinding.connector.search(
          { query, limit: parsed.limit },
          { signal: ctx.signal },
        );
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const now = clock.now();
      const observations: ResourceObservation[] = [];
      try {
        for (const hit of result.hits ?? []) {
          if (
            typeof hit.canonicalKey !== "string" ||
            typeof hit.title !== "string" ||
            typeof hit.text !== "string" ||
            typeof hit.sourceRevision !== "string"
          ) {
            throw new ToolError("execution_failed");
          }
          observations.push({
            connectorInstanceId: markdownBinding.connectorInstanceId,
            canonicalKey: hit.canonicalKey,
            title: hit.title,
            text: hit.text,
            sourceRevision: hit.sourceRevision,
            observedAt: now,
            links: toObservationLinks(
              hit.standardLinks ?? [],
              hit.wikiLinks ?? [],
            ),
          });
        }
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("execution_failed");
      }
      // Freshness `normal`: repeated related calls on unchanged documents
      // reuse the session snapshot (no snapshot inflation); changed content
      // materializes a fresh Snapshot + rN through the ordinary pathway.
      let presented: Awaited<
        ReturnType<ReferenceManager["presentObservations"]>
      >;
      try {
        presented = referenceManager.presentObservations(
          sessionId,
          ctx.runId,
          observations,
          { freshness: "normal", now },
        );
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (!presented.applied) {
        throw new ToolError("execution_cancelled");
      }
      return {
        references: presented.references.map((ref) => ({
          referenceId: ref.referenceId,
          ordinal: ref.ordinal,
          snapshotId: ref.snapshotId,
          resourceId: ref.resourceId,
          canonicalKey: ref.canonicalKey,
          title: ref.title,
        })),
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { references: unknown[] };
      const count = Array.isArray(output.references)
        ? output.references.length
        : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };

  const registrations: ToolRegistration[] = [];
  if (defaultBinding !== undefined) {
    registrations.push(search);
  }
  registrations.push(open, refresh, related);
  if (calendarBinding !== undefined) {
    registrations.push(
      createCalendarSearchRegistration({
        repo,
        referenceManager,
        binding: calendarBinding,
        targetStore: calendarTargetStore,
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
      }),
    );
  }
  return registrations;
}

/** Alias for orchestrators expecting the `M1` prefix. */
export const createM1ReferenceTools = createM1ToolRegistrations;
