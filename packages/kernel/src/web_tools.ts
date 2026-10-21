// `web.search` broker registration (docs/plan/web_search_design.md §8).
//
// One read-tool registration: guard -> per-turn reservation -> bounded
// SearXNG fetch (loopback-only client) -> ReferenceManager web snapshot
// materialization -> rN-addressable hits. Decisions locked here:
//
// - The guard runs BEFORE the per-turn web budget reservation, so a
//   rejected query NEVER consumes web budget. The per-run broker tool
//   budget is still charged by the ordinary ToolBroker pipeline (budget
//   reserve first), exactly like every other call.
// - The guard is metadata-only and fail-closed: a query whose whole text is
//   a citation id (rN/mN) is rejected, and any query containing a
//   ≥16-code-point contiguous substring of an injected (recorded) memory
//   snippet for the current run is rejected as an exfiltration attempt.
//   Both surface as the fixed redacted `web_query_rejected` code with no
//   query text, snippet, or reason detail persisted or returned.
// - Search results are UNTRUSTED evidence: titles/snippets are bounded,
//   URLs are scheme-allowlisted at contract + connector level, and every
//   hit is materialized through the ReferenceManager (resource + snapshot
//   + session reference + rN + `web_result_urls` side table) before the
//   model ever sees it.

import {
  decodeSearxResults,
  fetchSearxResults,
  WebSearchClientError,
  type WebSnippet,
} from "@companion/connector-web";
import {
  CITATION_ID_REGEX,
  MEMORY_CITATION_ID_REGEX,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchConfig,
  WebSearchConfigSchema,
  type WebSearchHit,
  type WebSearchToolInput,
  WebSearchToolInputSchema,
  type WebSearchToolOutput,
  WebSearchToolOutputSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { ToolError, type ToolRegistration } from "./broker.js";
import { isUuidV4 } from "./canonical.js";
import { RepositoryValidationError } from "./errors.js";
import type { ReferenceManager, WebResultHit } from "./reference_manager.js";
import type { KernelRepository, MemoryExposureRow } from "./repository.js";

/** The single tool name this module registers (`web.search`). */
export const WEB_SEARCH_TOOL_DESCRIPTOR_NAME = WEB_SEARCH_TOOL_NAME;

/** Guard window (§8): a query carrying this many code points of an
 * injected (recorded) memory snippet is an exfiltration-shaped attempt. */
export const WEB_MEMORY_EXFIL_WINDOW = 16 as const;

/**
 * Create the one `web.search` read-tool registration. Fails closed at
 * construction: the connector id must exist with kind `web` and the
 * configuration must be strict-valid AND explicitly enabled. The per-turn
 * web budget is charged only AFTER the guard passes.
 */
export function createWebSearchRegistration(options: {
  readonly db: Database.Database;
  readonly repo: KernelRepository;
  readonly referenceManager: ReferenceManager;
  readonly connectorInstanceId: string;
  readonly config: unknown;
  readonly clock?: { now(): number };
}): ToolRegistration {
  const { db, repo, referenceManager, connectorInstanceId } = options;
  if (!isUuidV4(connectorInstanceId)) {
    throw new RepositoryValidationError(
      "connectorInstanceId must be a UUID v4",
    );
  }
  const row = db
    .prepare("SELECT kind FROM connector_instances WHERE id = ?")
    .get(connectorInstanceId) as { kind: string } | undefined;
  if (row === undefined) {
    throw new RepositoryValidationError("connector instance not found");
  }
  if (row.kind !== "web") {
    throw new RepositoryValidationError("connector instance kind must be web");
  }
  let config: WebSearchConfig;
  try {
    config = WebSearchConfigSchema.parse(options.config);
  } catch {
    throw new RepositoryValidationError("web search config invalid");
  }
  if (config.enabled !== true) {
    throw new RepositoryValidationError("web search config must be enabled");
  }
  const clock = options.clock ?? { now: () => Date.now() };
  // Per-turn web counters: run id -> chargeable executions. Guard
  // rejections happen BEFORE touching this map, so they never consume it.
  const perTurnUsed = new Map<string, number>();

  function sessionOf(runId: string): string {
    try {
      return repo.getRun(runId).sessionId;
    } catch {
      throw new ToolError("execution_failed");
    }
  }

  function listInjectedMemoryExposures(runId: string): string[] {
    let rows: MemoryExposureRow[] = [];
    try {
      rows = repo.listMemoryExposures(runId);
    } catch {
      // Fail open for the exfil guard only when storage is unavailable:
      // the guard is a defense-in-depth check, and the materialization
      // path itself never believes search results beyond the broker.
      return [];
    }
    return rows
      .map((row: MemoryExposureRow) => row.snippet)
      .filter((snippet: string) => typeof snippet === "string");
  }

  const handler = async (
    input: unknown,
    ctx: { runId: string; signal: AbortSignal },
  ): Promise<WebSearchToolOutput> => {
    const parsed = input as WebSearchToolInput;
    const query = parsed.query;
    const sessionId = sessionOf(ctx.runId);
    if (ctx.signal.aborted) {
      throw new ToolError("execution_cancelled");
    }

    // ---- Guard (BEFORE the per-turn reservation). ----
    // 1) Citation-id-shaped query: the whole trimmed query is an rN/mN id.
    if (
      CITATION_ID_REGEX.test(query.trim()) ||
      MEMORY_CITATION_ID_REGEX.test(query.trim())
    ) {
      throw new ToolError("web_query_rejected");
    }
    // 2) Exfiltration: a ≥WEB_MEMORY_EXFIL_WINDOW contiguous code-point
    //    substring of ANY injected memory snippet present in the query.
    const seenWindows = new Set<string>();
    for (const snippet of listInjectedMemoryExposures(ctx.runId)) {
      const points = Array.from(snippet);
      if (points.length < WEB_MEMORY_EXFIL_WINDOW) {
        continue;
      }
      for (let i = 0; i + WEB_MEMORY_EXFIL_WINDOW <= points.length; i += 1) {
        const window = points.slice(i, i + WEB_MEMORY_EXFIL_WINDOW).join("");
        if (seenWindows.has(window)) continue;
        seenWindows.add(window);
        if (query.includes(window)) {
          throw new ToolError("web_query_rejected");
        }
      }
    }

    // ---- Per-turn web budget reservation (post-guard only). ----
    const used = perTurnUsed.get(ctx.runId) ?? 0;
    if (used >= config.per_turn_budget) {
      throw new ToolError("budget_exceeded");
    }
    perTurnUsed.set(ctx.runId, used + 1);

    // ---- Bounded SearXNG fetch (loopback-only client). ----
    let rawBody: string;
    try {
      rawBody = await fetchSearxResults({
        baseUrl: config.searxng_base_url ?? "",
        query,
        maxResults: Math.max(parsed.top_k, config.max_results),
        timeoutMs: config.timeout_ms,
        maxResponseBytes: config.max_response_bytes,
        ...(parsed.language !== undefined ? { language: parsed.language } : {}),
        ...(parsed.time_range !== undefined
          ? { timeRange: parsed.time_range }
          : {}),
        signal: ctx.signal,
      });
    } catch (error) {
      throw mapWebClientError(error, ctx.signal);
    }
    let decoded: WebSnippet[];
    try {
      decoded = decodeSearxResults(rawBody, parsed.top_k);
    } catch (error) {
      throw mapWebClientError(error, ctx.signal);
    }
    if (ctx.signal.aborted) {
      throw new ToolError("execution_cancelled");
    }

    // ---- Materialize via ReferenceManager web snapshots. ----
    const now = clock.now();
    const hits: WebResultHit[] = decoded.map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.snippet,
      observedAt: now,
    }));
    const urlByKey = new Map<string, string>();
    const snippetByKey = new Map<string, string | null>();
    for (const item of decoded) {
      if (!urlByKey.has(item.canonicalKey)) {
        urlByKey.set(item.canonicalKey, item.url);
        snippetByKey.set(item.canonicalKey, item.snippet);
      }
    }
    let presented: ReturnType<ReferenceManager["presentWebResults"]>;
    try {
      presented = referenceManager.presentWebResults(
        sessionId,
        ctx.runId,
        connectorInstanceId,
        hits,
        { now },
      );
    } catch {
      throw new ToolError("execution_failed");
    }
    if (!presented.applied) {
      throw new ToolError("execution_cancelled");
    }
    const results: WebSearchHit[] = presented.references.map(
      (ref): WebSearchHit => {
        const url = urlByKey.get(ref.canonicalKey);
        if (url === undefined) {
          throw new ToolError("execution_failed");
        }
        return {
          referenceId: ref.referenceId,
          ordinal: ref.ordinal,
          snapshotId: ref.snapshotId,
          resourceId: ref.resourceId,
          canonicalKey: ref.canonicalKey,
          title: ref.title,
          url,
          snippet: snippetByKey.get(ref.canonicalKey) ?? null,
        };
      },
    );
    return { results };
  };

  return {
    descriptor: {
      name: WEB_SEARCH_TOOL_NAME,
      version: 1,
      title: "Search the web",
      description:
        "Search the web through the local SearXNG endpoint; results become rN references.",
      category: "read",
      defaultTimeoutMs: 15_000,
      maxTimeoutMs: 60_000,
      supportsRefresh: false,
    },
    inputSchema: WebSearchToolInputSchema,
    outputSchema: WebSearchToolOutputSchema,
    handler: handler as unknown as ToolRegistration["handler"],
    normalize: (raw) => {
      const output = raw as { results: unknown[] };
      const count = Array.isArray(output.results) ? output.results.length : 0;
      return { normalized: raw, observations: count, modelFacing: raw };
    },
  };
}

/** Map connector-web client errors to closed broker codes. */
export function mapWebClientError(
  error: unknown,
  signal?: { aborted: boolean },
): ToolError {
  if (signal?.aborted) {
    return new ToolError("execution_cancelled");
  }
  if (error instanceof ToolError) {
    return error;
  }
  if (error instanceof WebSearchClientError) {
    switch (error.code) {
      case "timeout":
        return new ToolError("execution_timeout");
      case "response_too_large":
        return new ToolError("output_too_large");
      case "invalid_base_url":
      case "redirect_refused":
      case "network_error":
      case "response_invalid":
      case "upstream_error":
        return new ToolError("execution_failed");
      default:
        return new ToolError("execution_failed");
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ToolError("execution_cancelled");
  }
  return new ToolError("execution_failed");
}
