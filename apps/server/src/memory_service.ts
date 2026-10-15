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
        repo.failMemoryJob(job.id, "bad_request", {
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
        repo.failMemoryJob(job.id, "bad_request", {
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
        repo.failMemoryJob(job.id, failure, {
          maxAttempts: terminal ? 1 : MEMORY_JOB_MAX_ATTEMPTS,
          now: now(),
        });
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
      try {
        enqueueRememberFollowUps(request);
        repo.ackMemoryJob(job.id, { now: now() });
        if (pendingDistillJobId === job.id) {
          pendingDistillJobId = null;
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
      repo.failMemoryJob(job.id, "cli_rejected", {
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
   * Durable chain follow-up, enqueued BEFORE the event ack lands (same
   * tick): an acked event.append fans out to its remember jobs. Stable keys
   * make crash replays dedup instead of duplicating.
   */
  function enqueueRememberFollowUps(request: Record<string, unknown>): void {
    if (request.op !== "event.append") {
      return;
    }
    const chain = request.chain;
    if (!isRecord(chain)) {
      return;
    }
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
  }

  return {
    recallHook,
    notifyForeground,
    onRunCompleted,
    start,
    stop,
    drainOnce: () => drainOnce(),
  };
}
