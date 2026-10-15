// Conversation-memory service (server-owned remind integration).
//
// Ownership: this module drives the Companion side of the durable
// event -> remember -> feedback pipeline plus bounded automatic
// cultivation (idle `maintain.distill`). The remind CLI (child process) is
// the ONLY remind interface: Companion never opens, imports, or reads the
// remind DB (see memory_cli.ts). All durable state lives in the Companion
// `memory_outbox` / `memory_exposures` / `memory_grants` tables; the CLI
// idempotency key always equals the outbox job's stable key, so a crash or
// unknown-outcome replay reuses the same key and never mints a duplicate
// write. Stable keys are deterministic v4-shaped UUIDs
// (`stableMemoryJobKey`): re-enqueueing the same logical write dedups
// instead of duplicating.
//
// Lifecycle:
// - Disabled by default: no MemoryConfig means no service, no recall hook,
//   no jobs, no timers (M0/M1/M2 behavior preserved exactly).
// - `start()` drains crash-recovered pending jobs and arms the idle distill
//   timer. `stop()` (shutdown) cancels the timer, aborts in-flight CLI
//   calls, and awaits their termination: no orphaned child survives.
// - Foreground work (intake/completion/cancel via `notifyForeground`)
//   preempts an in-flight idle drain: in-flight CLI calls are hard-killed
//   and their jobs return to pending with bounded backoff (durable retry,
//   never infinite: `failMemoryJob` caps attempts, then the job stays
//   failed). Only one idle drain is ever in flight (single flight); idle
//   distill is never duplicated while a distill job is still pending.
// - `onRunCompleted(runId)` runs after the engine durably completes a run.
//   It enforces authoritative guards BEFORE any CLI call: the run must be
//   `completed` with a result AND the turn's current selection must still be
//   this run (a superseded retry never cultivates). Cancelled/stopped runs
//   never reach extraction or feedback. Extraction itself cannot mutate a
//   run: it only reads the frozen turn/result and calls the LOCAL gateway.
// - Feedback is granted ONLY for structural `mN` citations present in the
//   ACCEPTED completed answer's citation arrays (never prose, never mere
//   exposure or textual mention). Each cited `mN` must resolve to a
//   same-run exposure with a matching scope; cross-run or cross-scope
//   citations grant nothing and send no feedback.
// - Structured AI extraction runs through the EXISTING local model gateway
//   (no new service, no provisioning, no network sends beyond the
//   configured loopback gateway). A missing gateway, a timeout, or any
//   invalid extraction JSON conservatively yields NO memory (fail-closed
//   cultivation, fail-open answering: the run itself is never affected).
//
// Logging: fixed codes plus numeric sizes/durations and run ids only (via
// the server logger's whitelisted fields). No conversation text, scopes,
// paths, CLI bodies, or raw errors are ever logged.

import { createHash } from "node:crypto";
import {
  collectCitedMemoryOrdinals,
  type KernelRepository,
} from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import type { ServerLogger } from "./logger.js";
import {
  callMemoryCli,
  type MemoryCliAddress,
  type MemoryCliEnvelope,
  MemoryCliError,
} from "./memory_cli.js";

/** Long-budget deadline for one idle distill CLI call (bounded, abortable). */
export const MEMORY_DISTILL_TIMEOUT_MS = 120_000;
/** Max outbox jobs executed per drain tick (bounded work). */
export const MEMORY_DRAIN_BATCH = 5;
/** Max CLI attempts per outbox job before it stays failed (no infinite retry). */
export const MEMORY_JOB_MAX_ATTEMPTS = 8;
/** Bounds for extraction inputs/outputs (code points). */
export const MEMORY_EXTRACT_INPUT_MAX_CP = 2000;
export const MEMORY_EXTRACT_BODY_MAX_CP = 2000;
export const MEMORY_EXTRACT_MAX_ITEMS = 8;
export const MEMORY_EVENT_BODY_MAX_CP = 4000;
export const MEMORY_RECALL_QUERY_MAX_CP = 500;
/** Fixed provenance source stamped on Companion-written events/records. */
export const MEMORY_PROVENANCE_SOURCE = "companion:conversation";
/** Fixed audit runId marker for pre-answer recall calls (never a real run). */
export const MEMORY_RECALL_RUN_MARKER = "companion-recall";
/**
 * Explicit management bounds (closed, deterministic).
 *
 * - Search returns at most 8 opaque handles (`m1..mN` in CLI order);
 *   queries are 1..500 code points; correction replacements are 1..2000.
 * - Handles are valid only within the (sessionId, searchId) that created
 *   them: cross-session/cross-scope use fails closed, and historical
 *   snapshots are never rebound to latest memory.
 * - Fixed remind reason codes for explicit user actions: retire stages
 *   `NO_LONGER_USEFUL`, reactivate stages `USER_REQUESTED`. Corrections
 *   always use `kind: "correction"` (never faked as remember/link, never
 *   retired via feedback).
 */
export const MEMORY_SEARCH_LIMIT_MAX = 8;
export const MEMORY_SEARCH_QUERY_MAX_CP = 500;
export const MEMORY_CORRECTION_BODY_MAX_CP = 2000;
export const MEMORY_RETIRE_REASON = "NO_LONGER_USEFUL";
export const MEMORY_REACTIVATE_REASON = "USER_REQUESTED";
export const MEMORY_CORRECT_KIND = "correction";
/** Closed extraction kinds (remind RECORD_KINDS subset we ever write). */
const EXTRACT_KINDS: ReadonlySet<string> = new Set([
  "user_fact",
  "model_inference",
  "summary",
]);

/** Fixed extraction system instruction (deterministic, no conversation). */
export const MEMORY_EXTRACT_SYSTEM_PROMPT =
  "Extract durable memories from the conversation as strict JSON only. " +
  "Respond with exactly one JSON object of the form " +
  '{"memories":[{"body":"...","kind":"..."}]} where kind is one of ' +
  "user_fact, model_inference, summary. " +
  "Include only stable user facts, durable preferences, or decisions worth " +
  "remembering across sessions. Exclude greetings, chit-chat, and anything " +
  "already quoted verbatim. At most 8 items. No prose, no markdown, JSON only.";

export interface MemoryServiceOptions {
  readonly address: MemoryCliAddress;
  readonly scope: string;
  readonly recallLimit: number;
  readonly idleMs: number;
  readonly repo: KernelRepository;
  /** Existing LOCAL gateway for structured extraction; null means no extraction. */
  readonly gateway: ModelGateway | null;
  /** Model identifier sent with extraction chat requests (1..256 chars). */
  readonly model: string;
  readonly logger?: ServerLogger;
  readonly now?: () => number;
  /** Injectable CLI call (tests). Defaults to the real bounded client. */
  readonly cliCall?: typeof callMemoryCli;
  /** Injectable distill deadline (tests). Defaults to MEMORY_DISTILL_TIMEOUT_MS. */
  readonly distillTimeoutMs?: number;
}

export interface MemoryService {
  /** Pre-answer recall hook for the agent (fail-open: never throws). */
  readonly recallHook: {
    readonly scope: string;
    recall(
      query: string,
      signal: AbortSignal,
    ): Promise<
      ReadonlyArray<{ recordId: string; recallId: string; snippet: string }>
    >;
  };
  /** Foreground activity: preempts an in-flight idle drain. */
  notifyForeground(): void;
  /** Post-settlement hook: only completed + currently-selected runs cultivate. */
  onRunCompleted(runId: string): void;
  start(): void;
  stop(): Promise<void>;
  /** Execute one bounded drain tick (startup recovery + tests). */
  drainOnce(): Promise<{ executed: number }>;
  /**
   * Explicit user-directed search over active+retired (archived/superseded
   * excluded by remind `record.search`). Persists an immutable per-handle
   * snapshot and returns opaque session-scoped `mN` handles, never raw
   * canonical ids. Search never heats, reactivates, or grants feedback:
   * explicit search/open/mere UI display never calls `record.feedback`.
   */
  searchMemories(input: {
    sessionId: string;
    runId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<MemorySearchResult>;
  /**
   * Confirmation detail for one bound handle: the immutable cited snapshot
   * (what the user/model saw) kept DISTINCT from the CURRENT
   * content/provenance/status re-read live via `record.get`. Never heats.
   */
  getMemoryDetail(input: {
    sessionId: string;
    searchId: string;
    handle: string;
  }): Promise<MemoryDetailResult>;
  /**
   * Stage one management mutation through the durable outbox (queued, never
   * applied here). Corrections chain a NEW raw source `event.append`
   * carrying the user's actual replacement, then a real `record.correct`
   * preserving old history (replay recovers the event first, never
   * duplicate revisions). Ambiguous targets stage NOTHING.
   */
  stageMemoryMutation(input: {
    sessionId: string;
    runId: string;
    kind: "record.correct" | "record.retire" | "record.reactivate";
    searchId: string;
    handle?: string;
    correctionBody?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    /**
     * Server-known caller origin. True ONLY for the trusted USER UI
     * selection path (HTTP route hardcodes it); the model tool path always
     * passes false (hardcoded in bootstrap, never read from model args).
     * A model-controlled flag must never set this.
     */
    trustedSelection?: boolean;
  }): Promise<MemoryStageOutcome>;
  /** Durable 202-ack operation status read (session-ownership enforced). */
  getMemoryOperation(
    sessionId: string,
    operationId: string,
  ): MemoryOperationStatus | null;
}

/** One opaque search hit: handle + snippet + status (no raw ids). */
export interface MemorySearchHit {
  readonly handle: string;
  readonly snippet: string;
  readonly status: "active" | "retired";
}

export interface MemorySearchResult {
  readonly searchId: string;
  readonly hits: readonly MemorySearchHit[];
}

/** Immutable cited snapshot kept distinct from the live current record. */
export interface MemoryDetailResult {
  readonly snapshot: MemorySearchHit & { readonly searchId: string };
  readonly current: {
    readonly body: string;
    readonly kind: string;
    readonly status: string;
    readonly revision: number;
    readonly source: string;
    readonly observedAt: string;
    readonly createdAt: string;
  };
  /** True when the live status moved since the snapshot was cited. */
  readonly stale: boolean;
}

export type MemoryStageOutcome =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly status: "pending" | "acked" | "failed";
      readonly deduplicated: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "needs_clarification"
        | "target_not_found"
        | "state_conflict"
        | "validation_error"
        | "service_unavailable"
        | "idempotency_conflict";
      readonly candidates?: readonly MemorySearchHit[];
    };

export interface MemoryOperationStatus {
  readonly operationId: string;
  readonly kind: "record.correct" | "record.retire" | "record.reactivate";
  readonly recordRevision: number | null;
  readonly status: "pending" | "acked" | "failed";
}

/** Fixed management failure (code only, never values). */
export class MemoryManageError extends Error {
  readonly code:
    | "needs_clarification"
    | "target_not_found"
    | "state_conflict"
    | "validation_error"
    | "service_unavailable"
    | "idempotency_conflict";

  constructor(code: MemoryManageError["code"]) {
    super(code);
    this.name = "MemoryManageError";
    this.code = code;
  }
}

/** Fixed management cancellation (cooperative abort, preemption/shutdown). */
export class MemoryManageCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "MemoryManageCancelled";
  }
}

interface ExtractedMemory {
  readonly body: string;
  readonly kind: string;
}

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

function sliceCodePoints(text: string, max: number): string {
  if (max < 0) {
    return "";
  }
  return Array.from(text).slice(0, max).join("");
}

/**
 * Stable v4-shaped UUID for one logical outbox write, derived from
 * SHA-256 over a domain-separated key. Passes `isUuidV4` (version and
 * variant nibbles forced) and the remind key charset, so the SAME logical
 * write always reuses the SAME outbox + CLI idempotency key across crash
 * replays and follow-up re-enqueues: never a duplicate write.
 */
export function stableMemoryJobKey(...parts: Array<string | number>): string {
  const digest = createHash("sha256")
    .update(`memory-job:${parts.join(":")}`)
    .digest("hex");
  const chars = digest.split("");
  chars[12] = "4";
  const variant = Number.parseInt(chars[16] as string, 16) & 0x3;
  chars[16] = (["8", "9", "a", "b"] as const)[variant] ?? "8";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function hasControlCode(text: string): boolean {
  for (const unit of text) {
    const code = unit.codePointAt(0) ?? 0;
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict extraction-output validation: exact `{ memories: [...] }` shape,
 * at most MEMORY_EXTRACT_MAX_ITEMS items, each an exact `{ body, kind }`
 * object with a 1..MEMORY_EXTRACT_BODY_MAX_CP body and a closed kind.
 * Unknown keys, wrong types, and over-bound items are dropped (never
 * repaired); zero valid items yields no memory.
 */
export function parseExtractionOutput(text: string): ExtractedMemory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "memories") {
    return [];
  }
  const list = parsed.memories;
  if (!Array.isArray(list)) {
    return [];
  }
  const out: ExtractedMemory[] = [];
  for (const item of list.slice(0, MEMORY_EXTRACT_MAX_ITEMS)) {
    if (!isRecord(item)) {
      continue;
    }
    const itemKeys = Object.keys(item);
    if (
      itemKeys.length !== 2 ||
      !itemKeys.includes("body") ||
      !itemKeys.includes("kind")
    ) {
      continue;
    }
    const { body, kind } = item as { body?: unknown; kind?: unknown };
    if (
      typeof body !== "string" ||
      typeof kind !== "string" ||
      !EXTRACT_KINDS.has(kind)
    ) {
      continue;
    }
    const size = countCodePoints(body);
    if (size < 1 || size > MEMORY_EXTRACT_BODY_MAX_CP) {
      continue;
    }
    let clean = true;
    for (const unit of body) {
      const code = unit.codePointAt(0) ?? 0;
      if (
        (code >= 0x00 && code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
        (code >= 0x7f && code <= 0x9f)
      ) {
        clean = false;
        break;
      }
    }
    if (!clean) {
      continue;
    }
    out.push({ body, kind });
  }
  return out;
}

/** Validate recall response data: closed shape, bounded items. */
function parseRecallData(data: Record<string, unknown> | null): {
  recallId: string;
  items: Array<{ id: string; snippet: string }>;
} | null {
  if (data === null || typeof data.recallId !== "string") {
    return null;
  }
  const recallId = data.recallId;
  if (
    recallId.length < 1 ||
    recallId.length > 256 ||
    hasControlCode(recallId)
  ) {
    return null;
  }
  const rawItems = data.items;
  if (!Array.isArray(rawItems)) {
    return null;
  }
  const items: Array<{ id: string; snippet: string }> = [];
  for (const item of rawItems.slice(0, 8)) {
    if (!isRecord(item)) {
      continue;
    }
    const { id, snippet } = item as { id?: unknown; snippet?: unknown };
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 256 ||
      typeof snippet !== "string" ||
      snippet.length < 1 ||
      countCodePoints(snippet) > 512
    ) {
      continue;
    }
    items.push({ id, snippet });
  }
  return { recallId, items };
}

export function createMemoryService(
  options: MemoryServiceOptions,
): MemoryService {
  const { address, scope, recallLimit, idleMs, repo, gateway, model } = options;
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const cliCall = options.cliCall ?? callMemoryCli;
  const distillTimeoutMs =
    options.distillTimeoutMs ?? MEMORY_DISTILL_TIMEOUT_MS;

  let started = false;
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let drainInFlight: Promise<{ executed: number }> | null = null;
  let idleDrainAbort: AbortController | null = null;
  /** Last completed run anchoring run-agnostic idle distill (real ids only). */
  let lastCompletedRun: {
    sessionId: string;
    runId: string;
    turnId: string;
  } | null = null;
  /** In-process pending distill job id (never duplicated while pending). */
  let pendingDistillJobId: string | null = null;
  /** In-flight explicit staging count: stop() waits for zero (no post-stop writes). */
  let pendingStagings = 0;

  function throwIfStagingCancelled(signal?: AbortSignal): void {
    if (isAborted(signal)) {
      throw new MemoryManageCancelled();
    }
    if (stopped) {
      throw new MemoryManageCancelled();
    }
  }

  const log = (
    level: "info" | "warn" | "error",
    code: string,
    fields?: {
      runId?: string;
      bytes?: number;
      durationMs?: number;
      attempt?: number;
      status?: number;
    },
  ): void => {
    try {
      logger?.[level](code, fields);
    } catch {
      // Logging never fails memory work.
    }
  };

  function armIdleTimer(): void {
    if (!started || stopped) {
      return;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(
      () => {
        idleTimer = undefined;
        void runIdleDistill().catch(() => undefined);
      },
      Math.max(idleMs, 1),
    );
    if (
      idleTimer !== undefined &&
      typeof (idleTimer as unknown as { unref?: unknown }).unref === "function"
    ) {
      (idleTimer as unknown as { unref(): void }).unref();
    }
  }

  function notifyForeground(): void {
    // Foreground preemption: abort an in-flight idle drain so recall and
    // completion work take priority. Aborted jobs are NOT acked: they stay
    // pending with bounded backoff (durable retry, never infinite).
    const inFlight = idleDrainAbort;
    if (inFlight !== null) {
      try {
        inFlight.abort();
      } catch {
        // Best effort.
      }
    }
    armIdleTimer();
  }

  /**
   * Execute one outbox job via the CLI. Returns true when the job reached a
   * durable disposition for this tick (acked, or failed-terminally), false
   * when it stays pending for a later tick (transient: bounded backoff).
   */
  async function executeJob(
    job: { id: string; kind: string; requestJson: string; attempts: number },
    signal?: AbortSignal,
  ): Promise<boolean> {
    let request: unknown;
    try {
      request = JSON.parse(job.requestJson);
    } catch {
      try {
        // Atomic: terminal job failure mirrors into any bound operation, so
        // operation polling ends `failed`, never indefinite `pending`.
        repo.failMemoryJobWithOperationMirror(job.id, "bad_request", {
          maxAttempts: 1,
          now: now(),
        });
      } catch {
        // Best effort.
      }
      return true;
    }
    if (
      !isRecord(request) ||
      typeof request.op !== "string" ||
      !isRecord(request.params)
    ) {
      try {
        repo.failMemoryJobWithOperationMirror(job.id, "bad_request", {
          maxAttempts: 1,
          now: now(),
        });
      } catch {
        // Best effort.
      }
      return true;
    }
    const op = request.op;
    const params = request.params as Record<string, unknown>;
    // The outbox row's stable key IS the CLI key (crash-replay stability).
    let rowKey: string;
    try {
      const row = repo.getMemoryJob(job.id);
      if (row === null) {
        return true;
      }
      rowKey = row.idempotencyKey;
    } catch {
      return false;
    }
    const startedAt = now();
    let envelope: MemoryCliEnvelope;
    try {
      envelope = await cliCall(
        address,
        op,
        params,
        op === "record.recall" ? undefined : rowKey,
        {
          ...(op === "maintain.distill" ? { timeoutMs: distillTimeoutMs } : {}),
          ...(signal !== undefined ? { signal } : {}),
        },
      );
    } catch (error) {
      // Aborted by foreground preemption/shutdown: NOT a failure, NOT an
      // attempt worth counting twice — bounded backoff rearm, still pending.
      if (isAborted(signal)) {
        try {
          repo.failMemoryJob(job.id, "cli_preempted", {
            maxAttempts: MEMORY_JOB_MAX_ATTEMPTS,
            now: now(),
          });
        } catch {
          // Best effort.
        }
        return false;
      }
      const failure =
        error instanceof MemoryCliError ? error.cliCode : "cli_unavailable";
      // Transport/timeout/malformed CLI answers are transient: bounded
      // backoff rearm, never infinite. `cli_limit`/`cli_bad_request` are
      // caller bugs: terminal after the same cap instead of looping forever.
      const terminal = failure === "cli_limit" || failure === "cli_bad_request";
      try {
        // Atomic mirror: an exhausted transient (8 attempts) or a terminal
        // caller bug flips BOTH the job and any bound operation (source or
        // final mutation) to `failed` together — never pending forever.
        const outcome = repo.failMemoryJobWithOperationMirror(job.id, failure, {
          maxAttempts: terminal ? 1 : MEMORY_JOB_MAX_ATTEMPTS,
          now: now(),
        });
        void outcome;
      } catch {
        // Best effort: the next drain tick retries the claim.
      }
      log("warn", "memory.job_transient", {
        durationMs: Math.max(now() - startedAt, 0),
        attempt: job.attempts + 1,
      });
      return terminal;
    }
    const durationMs = Math.max(now() - startedAt, 0);
    if (envelope.ok) {
      // Chain follow-ups BEFORE the source ack lands, atomically: a
      // correction-event ack fans out to its single real `record.correct`
      // plus the operation rebind in ONE transaction. Any follow-up failure
      // propagates (no ack): the next tick replays the event under the same
      // stable key (remind dedups) and recovers the follow-up. A swallowed
      // failure here would ack the source while the chain is lost.
      try {
        enqueueManagementFollowUps(request);
      } catch {
        // Follow-up not durable: keep the source pending for retry.
        return false;
      }
      try {
        repo.ackMemoryJob(job.id, { now: now() });
        if (pendingDistillJobId === job.id) {
          pendingDistillJobId = null;
        }
        // Mirror durable 202-ack operation status for management writes
        // only: event/remember/feedback/distill jobs own no operation row,
        // and a correction's event job must NOT mark its operation acked
        // (the operation flips only when its real correct/retire/reactivate
        // job acks; the event->correct rebinding happens in the follow-up).
        if (
          op === "record.correct" ||
          op === "record.retire" ||
          op === "record.reactivate"
        ) {
          try {
            repo.setMemoryOperationStatusByJob(job.id, "acked", {
              now: now(),
            });
          } catch {
            // Best effort: the next status read still sees the acked job.
          }
        }
      } catch {
        // Ack/follow-up failure keeps the job pending: the next tick
        // replays with the same stable key (remind dedups, no duplicate).
        return false;
      }
      log("info", "memory.job_acked", { durationMs });
      return true;
    }
    // Domain rejections: same-key conflicts, BAD_REQUEST, FORBIDDEN_SCOPE,
    // NOT_FOUND, LIMIT_EXCEEDED fail terminally (bounded, no retry storm).
    // TIMEOUT/STORE_UNAVAILABLE are transient: bounded backoff rearm.
    const transient =
      envelope.code === "TIMEOUT" || envelope.code === "STORE_UNAVAILABLE";
    try {
      // Atomic mirror: terminal domain rejections (CONFLICT from a lost
      // correction race, NOT_FOUND, scope mismatch) fail the staged
      // operation together with the job — never silently retried into a
      // different revision. Exhausted transients flip together too. The UI
      // must refresh from a new explicit search, not guess a retry.
      repo.failMemoryJobWithOperationMirror(job.id, "cli_rejected", {
        maxAttempts: transient ? MEMORY_JOB_MAX_ATTEMPTS : 1,
        now: now(),
      });
      if (pendingDistillJobId === job.id && !transient) {
        pendingDistillJobId = null;
      }
    } catch {
      // Best effort.
    }
    log("warn", "memory.job_rejected", { durationMs });
    return !transient;
  }

  /**
   * Durable chain follow-ups, enqueued BEFORE the event ack lands (same
   * tick): an acked event.append fans out to its remember jobs AND to its
   * single correction job when the event is a NEW raw correction source.
   * Stable keys make crash replays dedup instead of duplicating: an
   * append-unknown-outcome replay recovers the event first and the correct
   * second, never minting duplicate revisions. THROWS when the correction
   * follow-up cannot be made durable so the caller keeps the source pending
   * (never acks a source whose chain is lost); remember fan-out stays
   * best-effort per item.
   */
  function enqueueManagementFollowUps(request: Record<string, unknown>): void {
    if (request.op !== "event.append") {
      return;
    }
    const chain = request.chain;
    if (!isRecord(chain)) {
      return;
    }
    enqueueRememberChainMemories(request, chain);
    // Throwing: a lost correction follow-up must block the source ack.
    enqueueCorrectChainCorrection(request, chain);
  }

  /**
   * Durable chain follow-up, enqueued BEFORE the event ack lands (same
   * tick): an acked event.append fans out to its remember jobs. Stable keys
   * make crash replays dedup instead of duplicating.
   */
  function enqueueRememberChainMemories(
    request: Record<string, unknown>,
    chain: Record<string, unknown>,
  ): void {
    const { eventId, sessionId, runId, turnId, provenance, memories } =
      chain as {
        eventId?: unknown;
        sessionId?: unknown;
        runId?: unknown;
        turnId?: unknown;
        provenance?: unknown;
        memories?: unknown;
      };
    if (
      typeof eventId !== "string" ||
      typeof sessionId !== "string" ||
      typeof runId !== "string" ||
      !isRecord(provenance) ||
      !Array.isArray(memories)
    ) {
      return;
    }
    // Crash-replay scope stability: the follow-up remember keeps the QUEUED
    // event payload's scope, never the current config scope (a restart may
    // change config before the replayed drain runs).
    const queuedParams = isRecord(request.params)
      ? (request.params as Record<string, unknown>)
      : null;
    const queuedScope = queuedParams?.scope;
    const followScope =
      typeof queuedScope === "string" && queuedScope.length >= 1
        ? queuedScope
        : scope;
    const at = now();
    let index = 0;
    for (const memory of memories) {
      if (!isRecord(memory)) {
        continue;
      }
      const { body, kind } = memory as { body?: unknown; kind?: unknown };
      if (
        typeof body !== "string" ||
        typeof kind !== "string" ||
        !EXTRACT_KINDS.has(kind) ||
        countCodePoints(body) < 1 ||
        countCodePoints(body) > MEMORY_EXTRACT_BODY_MAX_CP
      ) {
        continue;
      }
      try {
        repo.enqueueMemoryJob(
          "record.remember",
          sessionId,
          runId,
          followScope,
          stableMemoryJobKey("remember", runId, index),
          JSON.stringify({
            op: "record.remember",
            params: {
              body,
              kind,
              provenance,
              scope: followScope,
              tags: [],
              links: [],
              sourceRefs: [eventId],
              runId,
            },
          }),
          {
            ...(typeof turnId === "string" ? { turnId } : {}),
            now: at,
          },
        );
      } catch {
        // Best effort per item: one bad item never blocks its siblings.
      }
      index += 1;
    }
  }

  /**
   * Correction chain: an acked NEW raw correction-source event fans out to
   * exactly one real `record.correct` (new revision + old `active ->
   * superseded` in one CLI txn, old history preserved). The correct job
   * uses its own stable key (derived from the staging key, never reminted),
   * so an append-unknown-outcome replay recovers the event first and the
   * correct second without duplicate revisions. The staged operation row is
   * rebound from the event job to the correct job so its 202-ack status
   * flips only when the REAL correction acks. ATOMIC + THROWING: the
   * correct-job enqueue and the operation rebind commit in ONE repository
   * transaction with payload-identity validation; any failure (including a
   * drifted preexisting payload) throws so the caller does NOT ack the
   * source event, and an idempotent retry under the same key recovers.
   */
  function enqueueCorrectChainCorrection(
    request: Record<string, unknown>,
    chain: Record<string, unknown>,
  ): void {
    const correct = chain.correct;
    if (!isRecord(correct)) {
      return;
    }
    const {
      recordId,
      body,
      provenance,
      sourceEventId,
      correctJobKey,
      clientKey,
      sessionId,
      runId,
      turnId,
    } = correct as {
      recordId?: unknown;
      body?: unknown;
      provenance?: unknown;
      sourceEventId?: unknown;
      correctJobKey?: unknown;
      clientKey?: unknown;
      sessionId?: unknown;
      runId?: unknown;
      turnId?: unknown;
    };
    if (
      typeof recordId !== "string" ||
      typeof body !== "string" ||
      !isRecord(provenance) ||
      typeof sourceEventId !== "string" ||
      typeof correctJobKey !== "string" ||
      typeof clientKey !== "string" ||
      typeof sessionId !== "string" ||
      typeof runId !== "string"
    ) {
      return;
    }
    if (
      countCodePoints(body) < 1 ||
      countCodePoints(body) > MEMORY_CORRECTION_BODY_MAX_CP
    ) {
      return;
    }
    const queuedParams = isRecord(request.params)
      ? (request.params as Record<string, unknown>)
      : null;
    const queuedScope = queuedParams?.scope;
    const followScope =
      typeof queuedScope === "string" && queuedScope.length >= 1
        ? queuedScope
        : scope;
    const at = now();
    // Atomic follow-up + rebind with payload-identity validation. A
    // preexisting correct job with a drifted body is a conflict (throws);
    // a missing operation row throws (fail closed, never a silent orphan).
    // Both throw so the source event stays pending and the retry recovers.
    repo.bindCorrectionFollowupAtomic(
      {
        sessionId,
        runId,
        scope: followScope,
        correctJobKey,
        correctRequestJson: JSON.stringify({
          op: "record.correct",
          params: {
            recordId,
            body,
            kind: MEMORY_CORRECT_KIND,
            provenance,
            scope: followScope,
            sourceRefs: [sourceEventId],
            runId,
          },
        }),
        ...(typeof turnId === "string" ? { turnId } : {}),
        clientKey,
      },
      { now: at },
    );
  }

  /**
   * One bounded drain tick over due jobs (single flight: concurrent callers
   * share the in-flight tick). Aborts between jobs on preemption/shutdown.
   */
  function drainOnce(signal?: AbortSignal): Promise<{ executed: number }> {
    if (drainInFlight !== null) {
      return drainInFlight;
    }
    const tick = (async (): Promise<{ executed: number }> => {
      let executed = 0;
      for (let round = 0; round < MEMORY_DRAIN_BATCH; round += 1) {
        if (stopped || isAborted(signal)) {
          break;
        }
        let due: Array<{
          id: string;
          kind: string;
          requestJson: string;
          attempts: number;
        }>;
        try {
          due = repo
            .claimDueMemoryJobs(MEMORY_DRAIN_BATCH, now())
            .map((job) => ({
              id: job.id,
              kind: job.kind,
              requestJson: job.requestJson,
              attempts: job.attempts,
            }));
        } catch {
          break;
        }
        if (due.length === 0) {
          break;
        }
        for (const job of due) {
          if (stopped || isAborted(signal)) {
            break;
          }
          const settled = await executeJob(job, signal);
          void settled;
          executed += 1;
        }
        if (due.length < MEMORY_DRAIN_BATCH) {
          break;
        }
      }
      return { executed };
    })();
    drainInFlight = tick;
    const release = (): void => {
      if (drainInFlight === tick) {
        drainInFlight = null;
      }
    };
    tick.then(release, release);
    return tick;
  }

  /**
   * One bounded idle cultivation batch (single flight): when no foreground
   * backlog is due and no distill is pending, enqueue one `maintain.distill`
   * anchored to the last completed run (real ids only; skipped with no run
   * context yet), then drain. A degraded (model-unavailable) distill answer
   * acks normally with zero writes: cultivation degrades, answering never
   * fails.
   */
  async function runIdleDistill(): Promise<void> {
    if (!started || stopped) {
      return;
    }
    if (idleDrainAbort !== null) {
      return;
    }
    if (pendingDistillJobId !== null) {
      try {
        const pending = repo.getMemoryJob(pendingDistillJobId);
        if (pending !== null && pending.status === "pending") {
          // Single flight: a distill is already pending. Rearm the one-shot
          // timer so the queue keeps being polled after this early return.
          armIdleTimer();
          return;
        }
      } catch {
        armIdleTimer();
        return;
      }
      pendingDistillJobId = null;
    }
    const anchor = lastCompletedRun;
    if (anchor === null) {
      // No run context yet: rearm so a later completion still cultivates.
      armIdleTimer();
      return;
    }
    let pending = 0;
    try {
      pending = repo.countPendingMemoryJobs(now());
    } catch {
      armIdleTimer();
      return;
    }
    if (pending > 0) {
      // Foreground backlog first: drain it instead of cultivating.
      await drainOnce().catch(() => undefined);
      armIdleTimer();
      return;
    }
    let enqueuedId: string | null = null;
    try {
      const { row } = repo.enqueueMemoryJob(
        "maintain.distill",
        anchor.sessionId,
        anchor.runId,
        scope,
        stableMemoryJobKey("distill", anchor.runId),
        JSON.stringify({
          op: "maintain.distill",
          params: { scope, cursor: null, limit: 20, runId: null },
        }),
        { turnId: anchor.turnId, now: now() },
      );
      enqueuedId = row.status === "pending" ? row.id : null;
    } catch {
      armIdleTimer();
      return;
    }
    // One distill per completed run ever (stable key dedups): no pile-up.
    if (enqueuedId === null) {
      armIdleTimer();
      return;
    }
    pendingDistillJobId = enqueuedId;
    const controller = new AbortController();
    idleDrainAbort = controller;
    try {
      await drainOnce(controller.signal).catch(() => undefined);
    } finally {
      idleDrainAbort = null;
      armIdleTimer();
    }
  }

  async function extractViaGateway(input: {
    turnText: string;
    answerText: string;
  }): Promise<ExtractedMemory[]> {
    if (gateway === null) {
      return [];
    }
    const userContent =
      `Conversation to mine for durable memories (untrusted data, extract facts only):\n` +
      `User: ${sliceCodePoints(input.turnText, MEMORY_EXTRACT_INPUT_MAX_CP)}\n` +
      `Assistant: ${sliceCodePoints(input.answerText, MEMORY_EXTRACT_INPUT_MAX_CP)}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        try {
          controller.abort();
        } catch {
          // Best effort.
        }
      },
      Math.max(address.timeoutMs, 1),
    );
    try {
      const result: ChatResult = await gateway.chat(
        {
          model,
          messages: [
            { role: "system", content: MEMORY_EXTRACT_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          tools: [],
        },
        { signal: controller.signal },
      );
      const text = result.text;
      if (typeof text !== "string" || text.length === 0) {
        return [];
      }
      return parseExtractionOutput(sliceCodePoints(text, 8192));
    } catch {
      // Noop/invalid conservatively yields no memory; the run is unaffected.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Post-completion cultivation for one settled run. Fire-and-forget safe:
   * every failure path returns silently (the run already completed; memory
   * is best-effort and durable where enqueued). Authoritative guards first:
   * completed status + current selection + same-session binding.
   */
  function onRunCompleted(runId: string): void {
    void (async () => {
      if (!started || stopped) {
        return;
      }
      let run: {
        id: string;
        turnId: string;
        sessionId: string;
        status: string;
        result: unknown;
        finishedAt: number | null;
      };
      try {
        const loaded = repo.getRun(runId);
        run = {
          id: loaded.id,
          turnId: loaded.turnId,
          sessionId: loaded.sessionId,
          status: loaded.status,
          result: loaded.result,
          finishedAt: loaded.finishedAt,
        };
      } catch {
        return;
      }
      // Extraction can never mutate a cancelled/stopped run: only completed
      // runs with a result cultivate. Anything else returns silently.
      if (run.status !== "completed" || run.result === null) {
        return;
      }
      let turnText = "";
      try {
        const turn = repo.getTurn(run.turnId);
        if (turn.sessionId !== run.sessionId) {
          return;
        }
        turnText = turn.input.kind === "user_text" ? turn.input.text : "";
      } catch {
        return;
      }
      // Current-selection check: a superseded retry (no longer selected)
      // never cultivates, even when completed.
      try {
        const selection = repo.getSelection(run.turnId);
        if (selection === null || selection.runId !== run.id) {
          return;
        }
      } catch {
        return;
      }
      lastCompletedRun = {
        sessionId: run.sessionId,
        runId: run.id,
        turnId: run.turnId,
      };
      const result = run.result as {
        version?: unknown;
        text?: unknown;
        answer?: unknown;
      };
      const answerText = typeof result.text === "string" ? result.text : "";
      if (answerText.length === 0) {
        return;
      }
      // Feedback first (gateway-independent): only structural mN citations
      // from the ACCEPTED answer's citation arrays. V1 results carry no
      // answer and therefore never yield feedback.
      try {
        enqueueFeedbackJobs(run, result.answer);
      } catch {
        // Best effort: feedback never fails completion.
      }
      // Structured extraction (gateway-dependent, conservative noop).
      const memories = await extractViaGateway({
        turnText,
        answerText,
      });
      if (memories.length === 0) {
        log("info", "memory.extract_empty", { runId: run.id });
        await drainOnce().catch(() => undefined);
        return;
      }
      // Authoritative recheck AFTER the async gateway call: selection,
      // completion, and shutdown may have changed while awaited. A
      // superseded retry or a stopped service never enqueues.
      if (!started || stopped) {
        return;
      }
      try {
        const fresh = repo.getRun(runId);
        if (
          fresh.status !== "completed" ||
          fresh.result === null ||
          fresh.sessionId !== run.sessionId ||
          fresh.turnId !== run.turnId
        ) {
          return;
        }
        const freshSelection = repo.getSelection(fresh.turnId);
        if (freshSelection === null || freshSelection.runId !== fresh.id) {
          return;
        }
      } catch {
        return;
      }
      const observedAt =
        run.finishedAt !== null && Number.isFinite(run.finishedAt)
          ? new Date(run.finishedAt).toISOString()
          : new Date(now()).toISOString();
      const eventId = `evt-${run.id}`;
      const eventBody = sliceCodePoints(
        `User: ${turnText}\nAssistant: ${answerText}`,
        MEMORY_EVENT_BODY_MAX_CP,
      );
      const provenance = {
        source: MEMORY_PROVENANCE_SOURCE,
        observedAt,
      };
      try {
        repo.enqueueMemoryJob(
          "event.append",
          run.sessionId,
          run.id,
          scope,
          stableMemoryJobKey("event", run.id),
          JSON.stringify({
            op: "event.append",
            params: {
              eventId,
              sessionId: run.sessionId,
              turnId: run.turnId,
              body: eventBody,
              provenance,
              scope,
              runId: run.id,
            },
            chain: {
              eventId,
              sessionId: run.sessionId,
              runId: run.id,
              turnId: run.turnId,
              provenance,
              memories: memories.map((memory) => ({
                body: memory.body,
                kind: memory.kind,
              })),
            },
          }),
          { turnId: run.turnId, now: now() },
        );
      } catch {
        return;
      }
      log("info", "memory.event_queued", {
        runId: run.id,
        bytes: eventBody.length,
      });
      await drainOnce().catch(() => undefined);
    })().catch(() => undefined);
  }

  /**
   * Cite-gated feedback: ONLY real accepted completed-answer memory
   * citations yield feedback. Reads the answer's citation arrays (never
   * prose, never exposure/text mention), resolves each cited mN against
   * THIS run's exposure snapshot with matching scope, binds the grant, and
   * enqueues one stable feedback job per recall id.
   */
  function enqueueFeedbackJobs(
    run: { id: string; sessionId: string },
    answer: unknown,
  ): void {
    if (!isRecord(answer) || !Array.isArray(answer.parts)) {
      return;
    }
    let ordinals: number[];
    try {
      ordinals = collectCitedMemoryOrdinals(
        answer as Parameters<typeof collectCitedMemoryOrdinals>[0],
      );
    } catch {
      return;
    }
    if (ordinals.length === 0) {
      return;
    }
    let exposures: Array<{
      recallId: string;
      recordId: string;
      citation: string;
      scope: string;
    }>;
    try {
      exposures = repo.listMemoryExposures(run.id).map((exposure) => ({
        recallId: exposure.recallId,
        recordId: exposure.recordId,
        citation: exposure.citation,
        scope: exposure.scope,
      }));
    } catch {
      return;
    }
    const byCitation = new Map(exposures.map((item) => [item.citation, item]));
    const byRecall = new Map<string, Set<string>>();
    for (const ordinal of ordinals) {
      const exposure = byCitation.get(`m${ordinal}`);
      // Same-run exposure with matching scope only: cross-run, cross-scope,
      // or uncited exposures grant nothing and send no feedback.
      if (exposure === undefined || exposure.scope !== scope) {
        continue;
      }
      try {
        repo.grantMemoryCitation({
          runId: run.id,
          citation: exposure.citation,
          recordId: exposure.recordId,
          recallId: exposure.recallId,
          sessionId: run.sessionId,
          scope,
        });
      } catch {
        continue;
      }
      let set = byRecall.get(exposure.recallId);
      if (set === undefined) {
        set = new Set<string>();
        byRecall.set(exposure.recallId, set);
      }
      set.add(exposure.recordId);
    }
    const at = now();
    for (const [recallId, recordIds] of byRecall) {
      if (recordIds.size === 0) {
        continue;
      }
      try {
        repo.enqueueMemoryJob(
          "record.feedback",
          run.sessionId,
          run.id,
          scope,
          stableMemoryJobKey("feedback", run.id, recallId),
          JSON.stringify({
            op: "record.feedback",
            params: {
              recallId,
              recordIds: [...recordIds].sort(),
              scope,
              runId: run.id,
            },
          }),
          { now: at },
        );
      } catch {
        // Best effort per recall: siblings still enqueue.
      }
    }
  }

  const recallHook = {
    scope,
    recall: async (
      query: string,
      signal: AbortSignal,
    ): Promise<
      ReadonlyArray<{ recordId: string; recallId: string; snippet: string }>
    > => {
      if (!started || stopped || signal.aborted) {
        return [];
      }
      const trimmed = sliceCodePoints(query, MEMORY_RECALL_QUERY_MAX_CP);
      if (trimmed.length === 0) {
        return [];
      }
      let envelope: MemoryCliEnvelope;
      try {
        envelope = await cliCall(
          address,
          "record.recall",
          {
            query: trimmed,
            scope,
            runId: MEMORY_RECALL_RUN_MARKER,
            limit: recallLimit,
          },
          undefined,
          { signal },
        );
      } catch {
        // Fail-open: every recall failure yields a memoryless response.
        return [];
      }
      if (!envelope.ok) {
        return [];
      }
      const parsed = parseRecallData(envelope.data);
      if (parsed === null) {
        return [];
      }
      return parsed.items.map((item) => ({
        recordId: item.id,
        recallId: parsed.recallId,
        snippet: item.snippet,
      }));
    },
  };

  /* ---------------------------------------------------------------- */
  /* Explicit management: search / detail / staged mutations           */
  /* ---------------------------------------------------------------- */
  //
  // All four behaviors share one closed shape discipline:
  // - `record.search` is the ONLY explicit-search op (active+retired;
  //   archived/superseded excluded by remind itself). Search and detail
  //   NEVER call `record.feedback`: explicit search/open/mere UI display
  //   never heats, never reactivates, never grants.
  // - Handles are opaque session-scoped `mN` labels (`m1..mN` in CLI
  //   order) bound to exactly one (searchId, recordId) snapshot row.
  //   Raw canonical ids never cross the model/UI boundary; stored handles
  //   resolve server-side to source id + snapshot, and every mutation
  //   re-reads the CURRENT record before staging, rejecting
  //   superseded/stale targets. Historical snapshots are never rewritten
  //   (INSERT OR IGNORE) and never silently rebound to latest memory.
  // - Mutations stage through the narrow durable outbox only (this module
  //   never fakes a correction as remember/link, never retires via
  //   feedback, never physically deletes or transiently hides). A mutation
  //   binds a single explicit UI-selected target OR a uniquely resolved
  //   same-scope search target; multiple candidates without an explicit
  //   user selection return `needs_clarification` and stage NOTHING.

  /** Validate one explicit-search response item (fail-closed per item). */
  function parseSearchItems(data: Record<string, unknown> | null): {
    searchId: string;
    items: Array<{
      id: string;
      snippet: string;
      status: string;
      revision: number | null;
    }>;
  } | null {
    if (data === null || typeof data.searchId !== "string") {
      return null;
    }
    const searchId = data.searchId;
    if (
      searchId.length < 1 ||
      searchId.length > 256 ||
      hasControlCode(searchId)
    ) {
      return null;
    }
    const rawItems = data.items;
    if (!Array.isArray(rawItems)) {
      return null;
    }
    const items: Array<{
      id: string;
      snippet: string;
      status: string;
      revision: number | null;
    }> = [];
    for (const item of rawItems.slice(0, MEMORY_SEARCH_LIMIT_MAX)) {
      if (!isRecord(item)) {
        continue;
      }
      const { id, snippet, status, revision } = item as {
        id?: unknown;
        snippet?: unknown;
        status?: unknown;
        revision?: unknown;
      };
      if (
        typeof id !== "string" ||
        id.length < 1 ||
        id.length > 256 ||
        hasControlCode(id) ||
        typeof snippet !== "string" ||
        snippet.length < 1 ||
        countCodePoints(snippet) > 512 ||
        (status !== "active" && status !== "retired")
      ) {
        continue;
      }
      // Real per-record version snapshot when the CLI supplies it; null is
      // a valid unknown that later stages safely upgrade from the fresh
      // `record.get` (never guessed, never rebound silently).
      let snapshotRevision: number | null = null;
      if (revision !== undefined && revision !== null) {
        if (
          typeof revision !== "number" ||
          !Number.isInteger(revision) ||
          revision < 1 ||
          revision > 1_000_000
        ) {
          continue;
        }
        snapshotRevision = revision;
      }
      items.push({ id, snippet, status, revision: snapshotRevision });
    }
    return { searchId, items };
  }

  /** Validate one `record.get` response record (closed shape, bounded). */
  function parseRecordDetail(data: Record<string, unknown> | null): {
    id: string;
    body: string;
    kind: string;
    status: string;
    revision: number;
    source: string;
    observedAt: string;
    createdAt: string;
    scope: string;
  } | null {
    if (data === null || !isRecord(data.record)) {
      return null;
    }
    const record = data.record as Record<string, unknown>;
    const { id, body, kind, status, revision, createdAt, scope } = record as {
      id?: unknown;
      body?: unknown;
      kind?: unknown;
      status?: unknown;
      revision?: unknown;
      createdAt?: unknown;
      scope?: unknown;
    };
    const provenance = record.provenance as unknown;
    // Remind nests provenance as { source, observedAt } in remember/correct
    // but flattens get responses to `source`/`observedAt` top-level fields
    // (see live probe): accept both shapes, never reject a real record.
    let source: unknown;
    let observedAt: unknown;
    if (isRecord(provenance)) {
      source = provenance.source;
      observedAt = provenance.observedAt;
    } else {
      source = record.source;
      observedAt = record.observedAt;
    }
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 256 ||
      hasControlCode(id) ||
      typeof body !== "string" ||
      countCodePoints(body) < 1 ||
      countCodePoints(body) > MEMORY_EVENT_BODY_MAX_CP ||
      typeof kind !== "string" ||
      kind.length < 1 ||
      kind.length > 64 ||
      typeof status !== "string" ||
      typeof revision !== "number" ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      typeof source !== "string" ||
      source.length < 1 ||
      source.length > 512 ||
      typeof observedAt !== "string" ||
      observedAt.length < 1 ||
      observedAt.length > 128 ||
      typeof createdAt !== "string" ||
      createdAt.length < 1 ||
      typeof scope !== "string" ||
      scope.length < 1
    ) {
      return null;
    }
    return {
      id,
      body,
      kind,
      status,
      revision,
      source,
      observedAt,
      createdAt,
      scope,
    };
  }

  function requestHashForManagement(parts: Record<string, unknown>): string {
    const digest = createHash("sha256")
      .update(`memory-manage:${JSON.stringify(parts)}`)
      .digest("hex");
    return digest;
  }

  function isUuidLike(value: string): boolean {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    );
  }

  /**
   * Resolve a management target server-side. Returns the bound snapshot
   * (fixed record id, never rebound) or a fail-closed outcome.
   *
   * Caller origin is server-known (`trustedSelection`): true ONLY for the
   * trusted USER UI selection path (HTTP route hardcodes it). The model
   * tool path always passes false (hardcoded in bootstrap, never derived
   * from model args — a model-controlled flag can never set trusted).
   * - Trusted UI: an exact `handle` binds that snapshot; a missing handle
   *   binds ONLY a single-candidate search, else `needs_clarification`.
   * - Model (untrusted): a missing handle binds ONLY a single-candidate
   *   search (with a fresh `record.get` validation by the caller); ANY
   *   multi-candidate search returns `needs_clarification` and stages
   *   NOTHING — even when the model supplied an explicit `m1`.
   */
  function resolveManagementTarget(
    sessionId: string,
    searchId: string,
    handle: string | undefined,
    trustedSelection: boolean,
  ):
    | { readonly bound: { recordId: string; status: string; snippet: string } }
    | {
        readonly refused: "needs_clarification" | "target_not_found";
        readonly candidates?: readonly MemorySearchHit[];
      } {
    let header: ReturnType<typeof repo.getMemorySearch>;
    try {
      header = repo.getMemorySearch(searchId);
    } catch {
      return { refused: "target_not_found" };
    }
    // Session binding: a handle is valid only within the session whose
    // search created it. Cross-session/scope smuggling fails closed with
    // the same fixed code (no existence oracle across sessions).
    if (header === null || header.sessionId !== sessionId) {
      return { refused: "target_not_found" };
    }
    if (header.scope !== scope) {
      return { refused: "target_not_found" };
    }
    let items: ReturnType<typeof repo.listMemorySearchItems>;
    try {
      items = repo.listMemorySearchItems(searchId);
    } catch {
      return { refused: "target_not_found" };
    }
    if (items.length === 0) {
      return { refused: "target_not_found" };
    }
    // Untrusted (model) origin: multi-candidate searches NEVER bind — not
    // even with an explicit model-supplied handle. The model must ask the
    // user for clarification; only an exactly-one-candidate search binds
    // (fresh-validated by the caller afterwards).
    if (!trustedSelection && items.length > 1) {
      return {
        refused: "needs_clarification",
        candidates: items.map((entry) => ({
          handle: entry.handle,
          snippet: entry.snippet,
          status: entry.status as "active" | "retired",
        })),
      };
    }
    if (handle !== undefined) {
      const item = items.find((entry) => entry.handle === handle) ?? null;
      if (item === null) {
        return { refused: "target_not_found" };
      }
      return {
        bound: {
          recordId: item.recordId,
          status: item.status,
          snippet: item.snippet,
        },
      };
    }
    if (items.length === 1 && items[0] !== undefined) {
      const only = items[0];
      return {
        bound: {
          recordId: only.recordId,
          status: only.status,
          snippet: only.snippet,
        },
      };
    }
    return {
      refused: "needs_clarification",
      candidates: items.map((entry) => ({
        handle: entry.handle,
        snippet: entry.snippet,
        status: entry.status as "active" | "retired",
      })),
    };
  }

  /** Fresh `record.get` before staging (rejects superseded/stale targets). */
  async function freshRecordForStaging(
    recordId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly current: NonNullable<ReturnType<typeof parseRecordDetail>> }
    | { readonly failed: "target_not_found" | "service_unavailable" }
  > {
    let envelope: MemoryCliEnvelope;
    try {
      envelope = await cliCall(
        address,
        "record.get",
        { id: recordId, scope },
        undefined,
        { ...(signal !== undefined ? { signal } : {}) },
      );
    } catch {
      return { failed: "service_unavailable" };
    }
    if (!envelope.ok) {
      // NOT_FOUND / FORBIDDEN_SCOPE / BAD_REQUEST: the target cannot be
      // managed (never guessed, never rebound). TIMEOUT/STORE_UNAVAILABLE
      // are transient: surface unavailable so the caller retries same-key.
      if (
        envelope.code === "TIMEOUT" ||
        envelope.code === "STORE_UNAVAILABLE"
      ) {
        return { failed: "service_unavailable" };
      }
      return { failed: "target_not_found" };
    }
    const parsed = parseRecordDetail(envelope.data);
    if (parsed === null || parsed.scope !== scope) {
      return { failed: "target_not_found" };
    }
    return { current: parsed };
  }

  async function searchMemories(input: {
    sessionId: string;
    runId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<MemorySearchResult> {
    throwIfStagingCancelled(input.signal);
    const trimmed = sliceCodePoints(
      input.query.trim(),
      MEMORY_SEARCH_QUERY_MAX_CP,
    );
    if (trimmed.length === 0) {
      throw new MemoryManageError("validation_error");
    }
    const limit =
      input.limit === undefined
        ? MEMORY_SEARCH_LIMIT_MAX
        : Math.trunc(input.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MEMORY_SEARCH_LIMIT_MAX
    ) {
      throw new MemoryManageError("validation_error");
    }
    let envelope: MemoryCliEnvelope;
    try {
      envelope = await cliCall(
        address,
        "record.search",
        {
          query: trimmed,
          scope,
          limit,
          runId: input.runId,
        },
        undefined,
        { ...(input.signal !== undefined ? { signal: input.signal } : {}) },
      );
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
    throwIfStagingCancelled(input.signal);
    if (!envelope.ok) {
      throw new MemoryManageError(
        envelope.code === "TIMEOUT" || envelope.code === "STORE_UNAVAILABLE"
          ? "service_unavailable"
          : "validation_error",
      );
    }
    const parsed = parseSearchItems(envelope.data);
    if (parsed === null) {
      throw new MemoryManageError("service_unavailable");
    }
    // No heat, no reactivation, no feedback: the search response is
    // persisted as an IMMUTABLE snapshot only (INSERT OR IGNORE keeps the
    // first rows on replay), carrying the REAL per-record version/status
    // snapshot when the CLI supplies it (nullable unknown otherwise).
    // Handles are deterministic `m1..mN` in CLI order, scoped to this
    // (sessionId, searchId); raw canonical ids stay server-side and never
    // cross the model/UI boundary.
    const hits: MemorySearchHit[] = parsed.items.map((item, index) => ({
      handle: `m${index + 1}`,
      snippet: item.snippet,
      status: item.status as "active" | "retired",
    }));
    try {
      throwIfStagingCancelled(input.signal);
      repo.recordMemorySearch(
        {
          searchId: parsed.searchId,
          sessionId: input.sessionId,
          runId: input.runId,
          scope,
          query: trimmed,
          items: parsed.items.map((item, index) => ({
            handle: `m${index + 1}`,
            recordId: item.id,
            revision: item.revision,
            status: item.status,
            snippet: item.snippet,
          })),
        },
        { now: now() },
      );
    } catch (error) {
      if (error instanceof MemoryManageCancelled) {
        throw error;
      }
      throw new MemoryManageError("service_unavailable");
    }
    // Re-read the stored rows so a redelivered searchId returns the FIRST
    // (historical) snapshot, never a rebound rewrite. The stored rows are
    // authoritative: a length mismatch means the handles were NOT durably
    // persisted, so fail closed instead of returning live fallback handles
    // that would not resolve. Every returned handle MUST resolve afterwards.
    let stored: ReturnType<typeof repo.listMemorySearchItems>;
    try {
      stored = repo.listMemorySearchItems(parsed.searchId);
    } catch {
      throw new MemoryManageError("service_unavailable");
    }
    throwIfStagingCancelled(input.signal);
    if (stored.length !== hits.length) {
      throw new MemoryManageError("service_unavailable");
    }
    return {
      searchId: parsed.searchId,
      hits: stored.map((entry) => ({
        handle: entry.handle,
        snippet: entry.snippet,
        status: entry.status as "active" | "retired",
      })),
    };
  }

  async function getMemoryDetail(input: {
    sessionId: string;
    searchId: string;
    handle: string;
  }): Promise<MemoryDetailResult> {
    // Confirmation detail is a trusted UI read: the exact selected handle
    // binds (multi-candidate searches keep every handle resolvable).
    const resolved = resolveManagementTarget(
      input.sessionId,
      input.searchId,
      input.handle,
      true,
    );
    if ("refused" in resolved) {
      throw new MemoryManageError("target_not_found");
    }
    const fresh = await freshRecordForStaging(resolved.bound.recordId);
    if ("failed" in fresh) {
      throw new MemoryManageError(fresh.failed);
    }
    // Confirmation UI: the cited snapshot (what was shown) stays DISTINCT
    // from the live current record. Opening/detail never heats or grants.
    return {
      snapshot: {
        searchId: input.searchId,
        handle: input.handle,
        snippet: resolved.bound.snippet,
        status: resolved.bound.status as "active" | "retired",
      },
      current: {
        body: fresh.current.body,
        kind: fresh.current.kind,
        status: fresh.current.status,
        revision: fresh.current.revision,
        source: fresh.current.source,
        observedAt: fresh.current.observedAt,
        createdAt: fresh.current.createdAt,
      },
      stale: resolved.bound.status !== fresh.current.status,
    };
  }

  async function stageMemoryMutation(input: {
    sessionId: string;
    runId: string;
    kind: "record.correct" | "record.retire" | "record.reactivate";
    searchId: string;
    handle?: string;
    correctionBody?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    trustedSelection?: boolean;
  }): Promise<MemoryStageOutcome> {
    const trusted = input.trustedSelection === true;
    pendingStagings += 1;
    try {
      throwIfStagingCancelled(input.signal);
      if (!isUuidLike(input.idempotencyKey)) {
        return { ok: false, code: "validation_error" };
      }
      const key = input.idempotencyKey.toLowerCase();
      if (
        input.kind === "record.correct" &&
        (input.correctionBody === undefined ||
          countCodePoints(input.correctionBody) < 1 ||
          countCodePoints(input.correctionBody) > MEMORY_CORRECTION_BODY_MAX_CP)
      ) {
        return { ok: false, code: "validation_error" };
      }
      if (
        input.kind !== "record.correct" &&
        input.correctionBody !== undefined
      ) {
        return { ok: false, code: "validation_error" };
      }
      const resolved = resolveManagementTarget(
        input.sessionId,
        input.searchId,
        input.handle,
        trusted,
      );
      if ("refused" in resolved) {
        return resolved.refused === "needs_clarification"
          ? {
              ok: false,
              code: "needs_clarification",
              candidates: resolved.candidates ?? [],
            }
          : { ok: false, code: "target_not_found" };
      }
      // Immutable request identity (session/scope/action/target/body — NO
      // mutable live fields such as the fresh revision): the same key with
      // the same body replays the ORIGINAL stored status even after the
      // target state moved on; a drifted body is a 409. This lookup runs
      // BEFORE the live `record.get` + actionability gate so an exact
      // replay after a successful correct can never fail as superseded.
      const reasonCode =
        input.kind === "record.retire"
          ? MEMORY_RETIRE_REASON
          : input.kind === "record.reactivate"
            ? MEMORY_REACTIVATE_REASON
            : undefined;
      const requestHash = requestHashForManagement({
        kind: input.kind,
        sessionId: input.sessionId,
        scope,
        recordId: resolved.bound.recordId,
        ...(input.correctionBody !== undefined
          ? { body: input.correctionBody }
          : {}),
        ...(reasonCode !== undefined ? { reasonCode } : {}),
      });
      try {
        const existing = repo.getMemoryOperationByKey(key);
        if (existing !== null) {
          if (existing.requestHash !== requestHash) {
            return { ok: false, code: "idempotency_conflict" };
          }
          if (
            existing.sessionId !== input.sessionId ||
            existing.kind !== input.kind ||
            existing.recordId !== resolved.bound.recordId
          ) {
            return { ok: false, code: "idempotency_conflict" };
          }
          return {
            ok: true,
            operationId: existing.id,
            status: existing.status,
            deduplicated: true,
          };
        }
      } catch {
        return { ok: false, code: "service_unavailable" };
      }
      // Live freshness gate AFTER the replay lookup: the fresh `record.get`
      // (with the caller's AbortSignal forwarded) rejects superseded/stale
      // targets for NEW keys only; replays above already returned.
      let fresh: Awaited<ReturnType<typeof freshRecordForStaging>>;
      try {
        fresh = await freshRecordForStaging(
          resolved.bound.recordId,
          input.signal,
        );
      } catch {
        return { ok: false, code: "service_unavailable" };
      }
      // Cooperative cancellation: recheck aborted/stopped immediately after
      // the awaited read and again right before the atomic stage — never
      // stage post-stop or post-abort work.
      try {
        throwIfStagingCancelled(input.signal);
      } catch {
        throw new MemoryManageCancelled();
      }
      if ("failed" in fresh) {
        return { ok: false, code: fresh.failed };
      }
      const current = fresh.current;
      // Authoritative run recheck for the model (untrusted) path: the
      // staging run must still exist in this session after the awaited
      // read; a vanished/foreign run fails closed with no staging.
      try {
        const stagingRun = repo.getRun(input.runId);
        if (stagingRun.sessionId !== input.sessionId) {
          return { ok: false, code: "target_not_found" };
        }
        if (!trusted) {
          const status = stagingRun.status;
          if (
            status !== "queued" &&
            status !== "running" &&
            status !== "cancel_requested" &&
            status !== "completed"
          ) {
            throw new MemoryManageCancelled();
          }
        }
      } catch (error) {
        if (error instanceof MemoryManageCancelled) {
          throw error;
        }
        return { ok: false, code: "target_not_found" };
      }
      // Actionable-state gate (fresh read, never the snapshot): corrections
      // require a live `active` record (a retired/superseded/archived base is
      // a state conflict, never silently rebound); retire requires `active`
      // (already-retired replays stay idempotent through the CLI); reactivate
      // requires `retired` (already-active replays stay idempotent).
      if (input.kind === "record.correct" && current.status !== "active") {
        return { ok: false, code: "state_conflict" };
      }
      if (
        input.kind === "record.retire" &&
        current.status !== "active" &&
        current.status !== "retired"
      ) {
        return { ok: false, code: "state_conflict" };
      }
      if (
        input.kind === "record.reactivate" &&
        current.status !== "retired" &&
        current.status !== "active"
      ) {
        return { ok: false, code: "state_conflict" };
      }
      // Final pre-stage gate: no post-stop/post-abort writes — the atomic
      // repository stage below is synchronous, so this check stands
      // immediately before it.
      try {
        throwIfStagingCancelled(input.signal);
      } catch {
        throw new MemoryManageCancelled();
      }
      const at = now();
      try {
        if (input.kind === "record.correct") {
          return await stageCorrection({
            sessionId: input.sessionId,
            runId: input.runId,
            recordId: resolved.bound.recordId,
            body: input.correctionBody as string,
            revision: current.revision,
            key,
            requestHash,
            searchId: input.searchId,
            handle: input.handle ?? null,
            at,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          });
        }
        const jobKey =
          input.kind === "record.retire"
            ? stableMemoryJobKey("retire", key)
            : stableMemoryJobKey("reactivate", key);
        const params =
          input.kind === "record.retire"
            ? { id: resolved.bound.recordId, scope, reasonCode }
            : { id: resolved.bound.recordId, scope, reasonCode };
        const requestJson = JSON.stringify({ op: input.kind, params });
        const staged = repo.stageMemoryMutationAtomic(
          {
            jobKind: input.kind,
            jobSessionId: input.sessionId,
            jobRunId: input.runId,
            jobScope: scope,
            jobKey,
            requestJson,
            operation: {
              kind: input.kind,
              sessionId: input.sessionId,
              runId: input.runId,
              searchId: input.searchId,
              handle: input.handle ?? null,
              recordId: resolved.bound.recordId,
              revision: current.revision,
              idempotencyKey: key,
              requestHash,
            },
          },
          { now: at },
        );
        return {
          ok: true,
          operationId: staged.operation.id,
          status: staged.operation.status,
          deduplicated: staged.deduplicated,
        };
      } catch (error) {
        if (error instanceof MemoryManageCancelled) {
          throw error;
        }
        // IdempotencyConflictError carries request-specific state, so detect
        // by its fixed class name (no values): same key + drifted body, or
        // a preexisting outbox payload with a different body.
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { name?: unknown }).name === "IdempotencyConflictError"
        ) {
          return { ok: false, code: "idempotency_conflict" };
        }
        return { ok: false, code: "service_unavailable" };
      }
    } finally {
      pendingStagings -= 1;
    }
  }

  /**
   * Stage a correction as a NEW raw source event first (the user's actual
   * replacement, stable provenance + stable event id), chained to the real
   * `record.correct`. The operation row starts bound to the event job and
   * is rebound to the correct job when the event acks.
   */
  async function stageCorrection(input: {
    sessionId: string;
    runId: string;
    recordId: string;
    body: string;
    revision: number;
    key: string;
    requestHash: string;
    searchId: string;
    handle: string | null;
    at: number;
    signal?: AbortSignal;
  }): Promise<MemoryStageOutcome> {
    throwIfStagingCancelled(input.signal);
    let turnId: string;
    try {
      const run = repo.getRun(input.runId);
      if (run.sessionId !== input.sessionId) {
        return { ok: false, code: "target_not_found" };
      }
      turnId = run.turnId;
    } catch {
      return { ok: false, code: "target_not_found" };
    }
    const compactKey = input.key.replace(/-/g, "");
    const sourceEventId = `evt-${compactKey}`;
    const eventJobKey = stableMemoryJobKey("correct-event", input.key);
    const correctJobKey = stableMemoryJobKey("correct", input.key);
    const observedAt = new Date(input.at).toISOString();
    const provenance = {
      source: MEMORY_PROVENANCE_SOURCE,
      observedAt,
    };
    const eventBody = sliceCodePoints(input.body, MEMORY_EVENT_BODY_MAX_CP);
    try {
      throwIfStagingCancelled(input.signal);
      // Single atomic transaction: the source event job + the operation
      // row commit together with payload-identity validation, so a crash
      // can never leave a runnable write with no operation, and a drifted
      // retry can never bind a new-body operation to an old payload.
      const staged = repo.stageMemoryMutationAtomic(
        {
          jobKind: "event.append",
          jobSessionId: input.sessionId,
          jobRunId: input.runId,
          jobScope: scope,
          jobKey: eventJobKey,
          requestJson: JSON.stringify({
            op: "event.append",
            params: {
              eventId: sourceEventId,
              sessionId: input.sessionId,
              turnId,
              body: eventBody,
              provenance,
              scope,
              runId: input.runId,
            },
            chain: {
              correct: {
                recordId: input.recordId,
                body: input.body,
                provenance,
                sourceEventId,
                correctJobKey,
                clientKey: input.key,
                sessionId: input.sessionId,
                runId: input.runId,
                turnId,
              },
            },
          }),
          jobTurnId: turnId,
          operation: {
            kind: "record.correct",
            sessionId: input.sessionId,
            runId: input.runId,
            searchId: input.searchId,
            handle: input.handle,
            recordId: input.recordId,
            revision: input.revision,
            idempotencyKey: input.key,
            requestHash: input.requestHash,
          },
        },
        { now: input.at },
      );
      return {
        ok: true,
        operationId: staged.operation.id,
        status: staged.operation.status,
        deduplicated: staged.deduplicated,
      };
    } catch (error) {
      if (error instanceof MemoryManageCancelled) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "IdempotencyConflictError"
      ) {
        return { ok: false, code: "idempotency_conflict" };
      }
      return { ok: false, code: "service_unavailable" };
    }
  }

  function getMemoryOperation(
    sessionId: string,
    operationId: string,
  ): MemoryOperationStatus | null {
    let row: ReturnType<typeof repo.getMemoryOperation>;
    try {
      row = repo.getMemoryOperation(operationId);
    } catch {
      return null;
    }
    if (row === null || row.sessionId !== sessionId) {
      return null;
    }
    return {
      operationId: row.id,
      kind: row.kind,
      recordRevision: row.revision,
      status: row.status,
    };
  }

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    // Crash recovery: drain jobs left pending by an interrupted process
    // with the same stable keys (remind dedups replays, no duplicates).
    void drainOnce()
      .catch(() => undefined)
      .finally(() => {
        armIdleTimer();
      });
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    // Abort an in-flight idle drain and await its termination: no orphaned
    // child survives shutdown. Foreground completion drains (unabortable)
    // finish naturally since drainOnce always settles.
    const inFlight = idleDrainAbort;
    if (inFlight !== null) {
      try {
        inFlight.abort();
      } catch {
        // Best effort.
      }
    }
    const active = drainInFlight;
    if (active !== null) {
      await active.catch(() => undefined);
    }
    // Track pending explicit stagings: an in-flight stageMemoryMutation
    // observes `stopped` via throwIfStagingCancelled after its awaited read
    // and immediately before its atomic write, so no post-stop write lands.
    // Await their settlement here (bounded) — never fire-and-forget.
    const deadline = Date.now() + 5000;
    while (pendingStagings > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    recallHook,
    notifyForeground,
    onRunCompleted,
    start,
    stop,
    drainOnce: () => drainOnce(),
    searchMemories,
    getMemoryDetail,
    stageMemoryMutation,
    getMemoryOperation,
  };
}
