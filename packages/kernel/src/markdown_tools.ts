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
// - related: `getRelatedStored` then `presentStored`; no connector read;
//   returns the `references` contract.
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
import { isUuidV4 } from "./canonical.js";
import {
  ReferenceNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import type { ReferenceManager, ResourceObservation } from "./reference_manager.js";
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
 * satisfies the port (the real connector is assignable).
 */
export interface MarkdownConnectorPort {
  search(input: { query: string; limit: number }): Promise<MarkdownPortSearchResult>;
  readCanonical(canonicalKey: string): Promise<MarkdownPortDocument>;
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
    typeof (connector as { readCanonical?: unknown }).readCanonical !== "function"
  ) {
    throw new RepositoryValidationError(`${what} must expose search/readCanonical`);
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
): ResourceObservation["links"] {
  const links: Array<{
    kind: "standard" | "wiki";
    status: "resolved" | "ambiguous" | "unresolved";
    candidates: readonly string[];
  }> = [];
  for (const entry of standard) {
    if (entry.status === "resolved" && typeof entry.canonicalKey === "string") {
      links.push({ kind: "standard", status: "resolved", candidates: [entry.canonicalKey] });
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
      links.push({ kind: "wiki", status: "ambiguous", candidates: [...entry.candidates] });
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
 */
export function createM1ToolRegistrations(
  options: CreateM1ToolRegistrationsOptions,
): readonly ToolRegistration[] {
  const { db, repo, referenceManager } = options;
  if (db === undefined || repo === undefined || referenceManager === undefined) {
    throw new RepositoryValidationError("db, repo, and referenceManager are required");
  }
  const bindings = options.bindings;
  if (!Array.isArray(bindings) || bindings.length < 1) {
    throw new RepositoryValidationError("at least one connector binding is required");
  }
  const clock = options.clock ?? { now: () => Date.now() };
  const byId = new Map<string, MarkdownConnectorPort>();
  for (const binding of bindings) {
    if (!isUuidV4(binding.connectorInstanceId)) {
      throw new RepositoryValidationError("connectorInstanceId must be a UUID v4");
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
      throw new RepositoryValidationError("connector instance kind must be markdown");
    }
    byId.set(binding.connectorInstanceId, binding.connector);
  }
  // M1 uses the first binding as the search/default vault. Multi-vault fan-out
  // stays deterministic: every hit carries its owning connectorInstanceId, and
  // observations preserve hit order. Single-vault deployments pass one binding.
  const defaultBinding = bindings[0] as MarkdownConnectorBinding;

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
      description: "Deterministic Markdown search with Snapshot materialization",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: true,
    },
    inputSchema: MarkdownSearchToolInputSchema,
    outputSchema: MarkdownSearchToolOutputSchema,
    dedupMode: "input_freshness",
    handler: (async (input: unknown, ctx) => {
      const parsed = input as { query: string; limit: number; freshness: string };
      const sessionId = sessionOf(ctx.runId);
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      // External discovery/read FIRST, outside any DB transaction.
      let result: MarkdownPortSearchResult;
      try {
        result = await defaultBinding.connector.search({
          query: parsed.query,
          limit: parsed.limit,
        });
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
            connectorInstanceId: defaultBinding.connectorInstanceId,
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
    normalize: (raw) => ({ normalized: raw, observations: 1, modelFacing: raw }),
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
      // Resolve the owned reference to connector/canonical key from stored DB
      // metadata (ownership checked via getReferenceDetail first).
      let connectorInstanceId: string;
      let canonicalKey: string;
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
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      const port = byId.get(connectorInstanceId);
      if (port === undefined) {
        throw new ToolError("reference_not_found");
      }
      // External readCanonical OUTSIDE any transaction.
      let doc: MarkdownPortDocument;
      try {
        doc = await port.readCanonical(canonicalKey);
      } catch (error) {
        throw mapToToolError(error, ctx.signal);
      }
      if (ctx.signal.aborted) {
        throw new ToolError("execution_cancelled");
      }
      const now = clock.now();
      let observation: ResourceObservation;
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
        body: { version: 1, text: doc.text.normalize("NFC") },
      };
    }) as ToolRegistration["handler"],
    normalize: (raw) => ({ normalized: raw, observations: 1, modelFacing: raw }),
  };

  const related: ToolRegistration = {
    descriptor: {
      name: "reference.related",
      version: 1,
      title: "Related stored references",
      description: "Stored link-graph neighbors only (no external read)",
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
    }) as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { references: unknown[] };
      const count = Array.isArray(output.references) ? output.references.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };

  return [search, open, refresh, related];
}

/** Alias for orchestrators expecting the `M1` prefix. */
export const createM1ReferenceTools = createM1ToolRegistrations;
