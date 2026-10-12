/**
 * C12 functional calendar adapter: binds the pure input mapper + response
 * normalizers to a REAL, already-validated `McpConnector` read binding.
 *
 * SCOPE / CONTRACTS:
 * - `search` maps one logical `calendar.search` input through the exact
 *   `mapCalendarSearchRequest` (trusted single-calendar selection + the
 *   PER-CALL frozen IANA zone supplied by the caller) and decodes EXACTLY ONE
 *   upstream page through the existing page decoder (no auto-pagination; the
 *   opaque cursor is forwarded verbatim).
 * - `get` calls the EXACT configured `get-event` read binding with the private
 *   target and decodes through the existing `normalizeGetResult` (normalized
 *   fixed error codes only).
 * - Binding trust/identity is NOT re-implemented here: `McpConnector` already
 *   enforces the reviewed `read` policy, the config/definition hash link, the
 *   wire identity and the live tools/list schema hash. A call the connector
 *   refuses surfaces as its fixed normalized code.
 *
 * FROZEN TIME ZONE (per Turn/call):
 * The zone is NOT captured at construction. The kernel resolves it from the
 * immutable Turn frozen context and passes it on every `search` call, so a
 * stale/global zone can never be sent. `get` needs no zone.
 *
 * PRIVATE TARGET / IDENTITY (C12-07):
 * The normalized Snapshot/`NormalizedEvent` is an opaque `canonicalKey` over
 * (connectorInstanceId, calendarId, eventId) and deliberately carries NO
 * upstream provider IDs. Refresh therefore cannot derive an upstream
 * `get-event` target from the public snapshot. `search` returns, alongside the
 * normalized events, the host-private upstream targets for exactly the events
 * it produced (from the same single parse). The kernel persists those targets
 * in its own non-public store INSIDE the same observation transaction (same
 * running-status/CAS recheck), so a cancelled/late/failed call never writes a
 * target and no target write can bypass the cancellation/transaction
 * invariant. Provider IDs never appear in
 * the returned public events, the Snapshot/body, model-facing output or any
 * fixed error code.
 *
 * DELETION (C11): neither path infers or synthesizes a `deleted` status; a
 * get is a read, never deletion proof.
 */

import type {
  CallResult,
  McpConnector,
  McpErrorCode,
} from "@companion/connector-mcp";
import {
  type NormalizeGetResult,
  type NormalizeSearchPageResult,
  normalizeGetResult,
  normalizeSearchPage,
} from "./normalize.js";
import {
  type CalendarSelection,
  mapCalendarSearchRequest,
} from "./searchInput.js";

/** Candidate upstream tool names (configurable, defaults are the candidate's). */
export interface CalendarAdapterTools {
  readonly list: string;
  readonly search: string;
  readonly get: string;
}

/** Default upstream tool names for the readonly candidate fork surface. */
export const DEFAULT_CALENDAR_ADAPTER_TOOLS: CalendarAdapterTools = {
  list: "list-events",
  search: "search-events",
  get: "get-event",
};

/**
 * PRIVATE upstream get target. Contains provider IDs; it MUST never be placed
 * in `NormalizedEvent`, the Snapshot/body, model-facing output or a fixed
 * error code. All fields are plain non-empty strings so the kernel may persist
 * it durably in its own private storage and pass it back to `get`.
 */
export interface CalendarGetTarget {
  readonly calendarId: string;
  readonly eventId: string;
  readonly account?: string;
}

/** One private canonicalKey -> target mapping produced by a search page. */
export interface CalendarPrivateTarget {
  readonly canonicalKey: string;
  readonly target: CalendarGetTarget;
}

/** Cooperative cancellation options shared by both calls. */
export interface CalendarCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * `search` options: cooperative cancellation plus the PER-CALL frozen IANA
 * zone from the Turn frozen context. The zone is required and never read from
 * a clock, environment or construction-time global.
 */
export interface CalendarSearchCallOptions extends CalendarCallOptions {
  readonly timeZone: string;
}

export interface CalendarConnectorOptions {
  /** Stored `connector_instances.id` this adapter is bound to. */
  readonly connectorInstanceId: string;
  /** Already-constructed, policy-validated MCP connector. */
  readonly connector: McpConnector;
  /** Trusted single-calendar HOST selection (never model-controlled). */
  readonly selection: CalendarSelection;
  /** Exact configured read binding names; defaults to the candidate names. */
  readonly tools?: Partial<CalendarAdapterTools>;
}

/**
 * One-page search outcome: the existing normalized events/cursor PLUS the
 * host-private targets for exactly those events. `targets` is provider
 * identity and must stay host-side.
 */
export type CalendarSearchResult =
  | ({
      ok: true;
      events: NormalizeSearchPageResult["events"];
      cursor?: string;
    } & { targets: readonly CalendarPrivateTarget[] })
  | { ok: false; code: McpErrorCode };

/** Get outcome: exactly the existing normalizer result (fixed codes only). */
export type CalendarGetResult = NormalizeGetResult;

/** Dependency-inverted port shape the kernel can consume structurally. */
export interface CalendarConnectorPort {
  readonly connectorInstanceId: string;
  search(
    input: unknown,
    options: CalendarSearchCallOptions,
  ): Promise<CalendarSearchResult>;
  get(
    target: CalendarGetTarget,
    options?: CalendarCallOptions,
  ): Promise<CalendarGetResult>;
}

/** Full adapter: the port plus the trusted single-calendar selection. */
export interface CalendarConnector extends CalendarConnectorPort {
  readonly selection: CalendarSelection;
}

function isValidTarget(value: unknown): value is CalendarGetTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as {
    calendarId?: unknown;
    eventId?: unknown;
    account?: unknown;
  };
  if (typeof target.calendarId !== "string" || target.calendarId.length === 0) {
    return false;
  }
  if (typeof target.eventId !== "string" || target.eventId.length === 0) {
    return false;
  }
  if (
    target.account !== undefined &&
    (typeof target.account !== "string" || target.account.length === 0)
  ) {
    return false;
  }
  return true;
}

/**
 * Create the functional calendar adapter over an already-validated
 * `McpConnector`. No I/O, no clock, no env read at construction; every
 * upstream failure is mapped to a fixed normalized code.
 */
export function createCalendarConnector(
  options: CalendarConnectorOptions,
): CalendarConnector {
  const tools: CalendarAdapterTools = {
    ...DEFAULT_CALENDAR_ADAPTER_TOOLS,
    ...options.tools,
  };
  const connectorInstanceId = options.connectorInstanceId;
  const connector = options.connector;
  const selection = options.selection;

  async function search(
    input: unknown,
    callOptions: CalendarSearchCallOptions,
  ): Promise<CalendarSearchResult> {
    let request: ReturnType<typeof mapCalendarSearchRequest>;
    try {
      // Exact trusted mapper: strict model input, trusted selection, the
      // PER-CALL frozen zone. Any invalid input/selection/zone is the fixed
      // range code.
      request = mapCalendarSearchRequest(
        input,
        selection,
        callOptions?.timeZone ?? "",
      );
    } catch {
      return { ok: false, code: "calendar_range_invalid" };
    }
    const operation = request.upstreamTool;
    const upstreamTool =
      operation === "search-events" ? tools.search : tools.list;
    let call: CallResult;
    try {
      // Exactly one upstream page; the connector enforces the validated read
      // binding and never auto-resends.
      call = await connector.callTool(
        upstreamTool,
        request.arguments,
        callOptions?.signal,
      );
    } catch {
      return { ok: false, code: "mcp_unavailable" };
    }
    const page = await normalizeSearchPage(call, {
      connectorInstanceId,
      calendarId: selection.calendarId,
      requestedLimit: request.arguments.pageSize,
      operation,
    });
    if (!page.ok) return page;
    // Private targets are derived from the SAME single page parse as the
    // normalized events, so a target can never diverge from or outlive its
    // event. Only the public selection account is attached.
    const targets: CalendarPrivateTarget[] = page.targets.map((entry) => ({
      canonicalKey: entry.canonicalKey,
      target: {
        calendarId: entry.calendarId,
        eventId: entry.eventId,
        ...(selection.account !== undefined
          ? { account: selection.account }
          : {}),
      },
    }));
    return page.cursor !== undefined
      ? { ok: true, events: page.events, cursor: page.cursor, targets }
      : { ok: true, events: page.events, targets };
  }

  async function get(
    target: CalendarGetTarget,
    callOptions?: CalendarCallOptions,
  ): Promise<CalendarGetResult> {
    if (!isValidTarget(target)) {
      return { ok: false, code: "calendar_range_invalid" };
    }
    // Single-calendar HOST binding: only the trusted selection is reachable.
    if (target.calendarId !== selection.calendarId) {
      return { ok: false, code: "calendar_range_invalid" };
    }
    const args = {
      eventId: target.eventId,
      calendarId: target.calendarId,
      ...(target.account !== undefined ? { account: target.account } : {}),
    };
    let call: CallResult;
    try {
      // Exact configured read binding. A get is a read; it is never treated as
      // deletion proof and can never synthesize a `deleted` status.
      call = await connector.callTool(tools.get, args, callOptions?.signal);
    } catch {
      return { ok: false, code: "mcp_unavailable" };
    }
    return normalizeGetResult(call, {
      connectorInstanceId,
      calendarId: target.calendarId,
    });
  }

  return {
    connectorInstanceId,
    selection,
    search,
    get,
  };
}
