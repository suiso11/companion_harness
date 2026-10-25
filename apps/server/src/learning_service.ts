// Conversation learning service.
//
// Lifecycle: independent of the remind memory integration. When
// COMPANION_LEARNING_JSON is set, every authoritatively accepted completed
// selected turn is reflected on once through the existing LOCAL gateway.
// The extraction is bounded, strictly parsed, and fail-open: a missing or
// unavailable gateway, invalid JSON, timeout, or shutdown simply produces no
// reflection candidates. Nothing is trusted automatically; all extracted
// items stay pending until an operator approves their exact content hash.
//
// Retrieval: only APPROVED lessons for the SAME session, and only when the
// current request is genuinely relevant (shared content tokens). The agent
// renders them as untrusted user-role advisory data, never as system
// instructions. Applications are durably recorded for operator inspection.

import { createHash } from "node:crypto";
import {
  createLearningStore,
  type KernelRepository,
  type LearningCandidate,
  type LearningKind,
  type LearningProposalRow,
  type LearningStore,
  learningContentHash,
  selectLessonsForPromptBlock,
} from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import {
  BACKGROUND_OWNER_LEARNING_EXTRACTION,
  type BackgroundReservation,
  type BackgroundResourceGate,
} from "./background_resource.js";
import type { ServerLogger } from "./logger.js";

export const LEARNING_EXTRACT_INPUT_MAX_CP = 2000;
export const LEARNING_EXTRACT_OUTPUT_MAX_CP = 8192;
export const LEARNING_MAX_RETRIEVED = 3;
export const LEARNING_RETRIEVAL_MIN_SCORE = 1;
export const LEARNING_EXTRACT_TIMEOUT_MS = 5_000;
/** Bounded deferral while one shared background slot is busy. */
export const LEARNING_SLOT_RETRY_DELAY_MS = 100;
export const LEARNING_SLOT_MAX_ATTEMPTS = 20;

export const LEARNING_EXTRACT_SYSTEM_PROMPT =
  "You extract durable lessons from one accepted conversation turn as strict " +
  "JSON only. Respond with exactly one JSON object of the form " +
  '{"lessons":[{"kind":"observation|user_confirmed_feedback|model_inference","lesson":"...","evidence":"...","applicability":"..."}]}. ' +
  "observation: a grounded factual observation about what happened. " +
  "user_confirmed_feedback: the user explicitly corrected, rejected, or " +
  "confirmed an approach; evidence MUST be an exact quote from the user's " +
  "message. model_inference: a cautious inferred lesson; it is never trusted " +
  "as fact. evidence MUST be an exact quote from the user or assistant text. " +
  "applicability: a short condition describing when the lesson may help. " +
  "Capture user corrections, mistakes to avoid, and useful successful " +
  "approaches only. Exclude greetings, chit-chat, secrets, and anything not " +
  "grounded in the provided text. At most 5 items. No prose, no markdown, " +
  "JSON only.";

const KINDS = new Set<string>([
  "observation",
  "user_confirmed_feedback",
  "model_inference",
]);
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "you",
  "your",
  "are",
  "was",
  "were",
  "have",
  "has",
  "can",
  "will",
  "not",
  "but",
  "from",
  "they",
  "them",
  "then",
  "than",
  "into",
  "about",
  "when",
  "where",
  "what",
  "how",
  "why",
  "should",
  "could",
  "would",
  "please",
  "thanks",
  "hello",
  "there",
  "here",
  "just",
  "very",
  "really",
  "want",
  "need",
  "make",
  "made",
  "using",
  "used",
  "also",
  "some",
  "more",
]);
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export interface LearningServiceOptions {
  readonly storePath: string;
  readonly repo: KernelRepository;
  /** Existing LOCAL gateway; null means extraction is unavailable (fail-open). */
  readonly gateway: ModelGateway | null;
  readonly model: string;
  readonly logger?: ServerLogger;
  readonly now?: () => number;
  readonly store?: LearningStore;
  /**
   * Shared server-owned background admission (bootstrap-injected). When
   * present, extraction runs only while this unit can hold the single
   * background model slot; a busy/closed gate skips this turn's optional
   * reflection (fail-open, no gateway call).
   */
  readonly background?: BackgroundResourceGate | null;
}

export interface LearningService {
  readonly recallHook: {
    recall(input: {
      sessionId: string;
      runId: string;
      query: string;
      signal: AbortSignal;
    }): Promise<
      ReadonlyArray<{
        id: string;
        kind: string;
        lesson: string;
        evidence: string;
        applicability: string;
        provenance: string;
      }>
    >;
  };
  /** Post-settlement hook: only completed + currently-selected runs reflect. */
  onRunCompleted(runId: string): void;
  readonly store: LearningStore;
  /** Latest approved proposals for one session (operator/test inspection). */
  listApproved(sessionId: string): readonly LearningProposalRow[];
  start(): void;
  stop(): Promise<void>;
}

interface ParsedLesson {
  readonly kind: LearningKind;
  readonly lesson: string;
  readonly evidence: string;
  readonly applicability: string;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function hasControl(value: string): boolean {
  for (const unit of value) {
    const code = unit.codePointAt(0) ?? 0;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function bounded(value: unknown, min: number, max: number): string | null {
  if (
    typeof value !== "string" ||
    countCodePoints(value) < min ||
    countCodePoints(value) > max ||
    value.includes("\0") ||
    hasControl(value)
  ) {
    return null;
  }
  return value;
}

/**
 * Strict extraction parser. Returns null for malformed output (no record is
 * fabricated), [] only for a valid empty list, and bounded valid items
 * otherwise. Grounding is enforced separately by the caller.
 */
export function parseLearningExtraction(text: string): ParsedLesson[] | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.lessons)) {
    return null;
  }
  const items = record.lessons;
  if (items.length > 5) return null;
  const out: ParsedLesson[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }
    const candidate = item as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 4 ||
      !("kind" in candidate) ||
      !("lesson" in candidate) ||
      !("evidence" in candidate) ||
      !("applicability" in candidate)
    ) {
      return null;
    }
    if (typeof candidate.kind !== "string" || !KINDS.has(candidate.kind)) {
      return null;
    }
    const lesson = bounded(candidate.lesson, 1, 500);
    const evidence = bounded(candidate.evidence, 1, 500);
    const applicability = bounded(candidate.applicability, 1, 300);
    if (lesson === null || evidence === null || applicability === null) {
      return null;
    }
    out.push({
      kind: candidate.kind as LearningKind,
      lesson,
      evidence,
      applicability,
    });
  }
  return out;
}

/**
 * Extract the accepted assistant text from a completed run result without
 * inventing any content. V1 rows carry `{version:1,text}`; V2 rows carry the
 * validated StructuredAnswer in `answer` alongside the same rendered `text`.
 * The structured parts are authoritative when present (the exact accepted
 * answer), and V1 falls back to its persisted text.
 */
export function completedAnswerText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const record = result as {
    text?: unknown;
    answer?: unknown;
  };
  const answer = record.answer;
  if (typeof answer === "object" && answer !== null) {
    const parts = (answer as { parts?: unknown }).parts;
    if (Array.isArray(parts) && parts.length > 0) {
      const texts: string[] = [];
      for (const part of parts) {
        if (
          typeof part !== "object" ||
          part === null ||
          typeof (part as { text?: unknown }).text !== "string"
        ) {
          texts.length = 0;
          break;
        }
        texts.push((part as { text: string }).text);
      }
      if (texts.length > 0 && texts.every((text) => text.length > 0)) {
        return texts.join("\n\n");
      }
    }
  }
  return typeof record.text === "string" ? record.text : "";
}

function grounded(
  item: ParsedLesson,
  turnText: string,
  answerText: string,
): boolean {
  // Evidence is an EXACT quote: case, whitespace, and punctuation must match
  // the accepted turn text (or the assistant answer for non-user-feedback).
  if (item.evidence.length === 0) return false;
  if (item.kind === "user_confirmed_feedback") {
    return turnText.includes(item.evidence);
  }
  return turnText.includes(item.evidence) || answerText.includes(item.evidence);
}

function relevanceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu)) {
    const token = match[0];
    if (STOPWORDS.has(token)) continue;
    if (CJK_PATTERN.test(token)) {
      const chars = Array.from(token);
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.add(`${chars[index]}${chars[index + 1]}`);
      }
    } else {
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Genuine-relevance rule: at least two shared content tokens, or one shared
 * token of at least six characters. This keeps an unrelated request from
 * receiving lessons merely because both mention a short generic word.
 */
export function lessonRelevanceScore(query: string, lesson: string): number {
  const queryTokens = relevanceTokens(query);
  const lessonTokens = relevanceTokens(lesson);
  let shared = 0;
  let longest = 0;
  for (const token of queryTokens) {
    if (lessonTokens.has(token)) {
      shared += 1;
      longest = Math.max(longest, token.length);
    }
  }
  if (shared >= 2) return shared;
  if (shared === 1 && longest >= 6) return shared;
  return 0;
}

export function createLearningService(
  options: LearningServiceOptions,
): LearningService {
  const now = options.now ?? Date.now;
  const store =
    options.store ??
    createLearningStore({
      path: options.storePath,
      clock: { now },
    });
  const gateway = options.gateway;
  const model = options.model;
  const logger = options.logger;
  const background = options.background ?? null;
  let started = false;
  let stopped = false;
  /** Gateway calls currently running; stop() aborts and awaits them. */
  const inFlightControllers = new Set<AbortController>();
  const inFlightTasks = new Set<Promise<void>>();
  /** Per-process completed-notification dedup (durable dedup is the store). */
  const attemptedRuns = new Set<string>();
  /** Deferral waiters woken by stop() or by a background-slot release. */
  const pendingSlotWaiters = new Set<() => void>();

  function log(
    level: "info" | "warn",
    code: string,
    fields: Record<string, string | number | undefined> = {},
  ): void {
    try {
      if (level === "info") logger?.info(code, fields);
      else logger?.warn(code, fields);
    } catch {
      // Logging never affects learning.
    }
  }

  /**
   * Wait for one background-slot release (or a bounded retry tick). Finite:
   * a wake fires at most once per release, and stop() wakes every waiter so
   * a deferred extraction is dropped instead of delaying shutdown.
   */
  function waitForSlotSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        pendingSlotWaiters.delete(finish);
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe?.();
        resolve();
      };
      pendingSlotWaiters.add(finish);
      if (background !== null) unsubscribe = background.onSettled(finish);
      timer = setTimeout(finish, LEARNING_SLOT_RETRY_DELAY_MS);
      // Never keep the process alive just to retry an optional reflection.
      timer.unref?.();
    });
  }

  /**
   * Shared admission with deferral. Memory extraction is scheduled from the
   * same completion hook and can grab the single slot first; instead of
   * dropping this optional reflection, wait for its release (bounded) and
   * retry. Foreground activity, a closed gate, or stop() still drops it.
   */
  async function admitExtraction(): Promise<{
    readonly admitted: boolean;
    readonly lease: BackgroundReservation | null;
  }> {
    for (let attempt = 0; attempt < LEARNING_SLOT_MAX_ATTEMPTS; attempt += 1) {
      if (!started || stopped) return { admitted: false, lease: null };
      if (background?.closed === true) {
        log("info", "learning.extract_skipped_closed", { status: 0 });
        return { admitted: false, lease: null };
      }
      // Foreground preemption: a user run that became active before
      // admission wins the shared resource; never call the gateway beside it.
      try {
        if (options.repo.hasActiveShadowBlock()) {
          log("info", "learning.extract_skipped_foreground", { status: 0 });
          return { admitted: false, lease: null };
        }
      } catch {
        return { admitted: false, lease: null };
      }
      if (background === null) return { admitted: true, lease: null };
      const lease = background.tryAcquire(BACKGROUND_OWNER_LEARNING_EXTRACTION);
      if (lease !== null) return { admitted: true, lease };
      if (attempt === 0) {
        log("info", "learning.extract_deferred", { status: 0 });
      }
      await waitForSlotSignal();
    }
    if (!stopped) {
      log("info", "learning.extract_skipped_busy", { status: 0 });
    }
    return { admitted: false, lease: null };
  }

  async function extract(
    turnText: string,
    answerText: string,
  ): Promise<ParsedLesson[] | null> {
    if (gateway === null) return null;
    const admission = await admitExtraction();
    if (!admission.admitted) return null;
    const lease = admission.lease;
    if (stopped) {
      if (lease !== null) background?.release(lease);
      return null;
    }
    const controller = new AbortController();
    inFlightControllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    try {
      // Bounded extraction: the timer aborts the gateway call AND settles the
      // race even when a malformed gateway ignores the signal. An explicit
      // stop() abort likewise settles immediately.
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // Best effort.
          }
          reject(new Error("learning extraction timed out"));
        }, LEARNING_EXTRACT_TIMEOUT_MS);
      });
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("learning extraction aborted")),
          { once: true },
        );
      });
      const result: ChatResult = await Promise.race([
        gateway.chat(
          {
            model,
            messages: [
              { role: "system", content: LEARNING_EXTRACT_SYSTEM_PROMPT },
              {
                role: "user",
                content:
                  "Accepted conversation turn (untrusted data; extract groundable lessons only):\n" +
                  `User: ${turnText.slice(0, LEARNING_EXTRACT_INPUT_MAX_CP)}\n` +
                  `Assistant: ${answerText.slice(0, LEARNING_EXTRACT_INPUT_MAX_CP)}`,
              },
            ],
            tools: [],
            reasoning: "off",
          },
          { signal: controller.signal },
        ),
        timedOut,
        aborted,
      ]);
      if (typeof result.text !== "string" || result.text.length === 0) {
        return null;
      }
      return parseLearningExtraction(
        result.text.slice(0, LEARNING_EXTRACT_OUTPUT_MAX_CP),
      );
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlightControllers.delete(controller);
      if (lease !== null) background?.release(lease);
    }
  }

  async function reflect(runId: string): Promise<void> {
    if (!started || stopped) return;
    let run: {
      id: string;
      turnId: string;
      sessionId: string;
      status: string;
      result: unknown;
      finishedAt: number | null;
    };
    try {
      const loaded = options.repo.getRun(runId);
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
    if (run.status !== "completed" || run.result === null) return;
    // Durable dedup: a run is reflected at most once, including after restart
    // or a repeated completion notification that arrives after capture.
    try {
      if (store.findReflectionByRun(run.id) !== null) return;
    } catch {
      return;
    }
    let turnText = "";
    try {
      const turn = options.repo.getTurn(run.turnId);
      if (turn.sessionId !== run.sessionId) return;
      turnText = turn.input.kind === "user_text" ? turn.input.text : "";
    } catch {
      return;
    }
    try {
      const selection = options.repo.getSelection(run.turnId);
      if (selection === null || selection.runId !== run.id) return;
    } catch {
      return;
    }
    const answerText = completedAnswerText(run.result);
    if (turnText.length === 0 || answerText.length === 0) return;
    const parsed = await extract(turnText, answerText);
    if (parsed === null) {
      log("info", "learning.extract_empty", { runId: run.id });
      return;
    }
    // Authoritative recheck AFTER the async gateway call.
    if (!started || stopped) return;
    try {
      const fresh = options.repo.getRun(runId);
      if (
        fresh.status !== "completed" ||
        fresh.result === null ||
        fresh.sessionId !== run.sessionId ||
        fresh.turnId !== run.turnId
      ) {
        return;
      }
      const freshSelection = options.repo.getSelection(fresh.turnId);
      if (freshSelection === null || freshSelection.runId !== fresh.id) {
        return;
      }
      if (store.findReflectionByRun(fresh.id) !== null) return;
    } catch {
      return;
    }
    const groundedItems = parsed.filter((item) =>
      grounded(item, turnText, answerText),
    );
    const seen = new Set<string>();
    const candidates: LearningCandidate[] = [];
    for (const item of groundedItems) {
      const hash = learningContentHash(item);
      if (seen.has(hash)) continue;
      seen.add(hash);
      candidates.push(item);
    }
    try {
      const captured = store.captureReflection({
        sessionId: run.sessionId,
        runId: run.id,
        turnId: run.turnId,
        candidates,
        now: now(),
      });
      log("info", "learning.reflected", {
        runId: run.id,
        status: captured.proposals.length,
      });
    } catch {
      log("warn", "learning.reflect_failed", { runId: run.id });
    }
  }

  function onRunCompleted(runId: string): void {
    if (!started || stopped) return;
    // Dedup repeated notifications before any gateway call starts.
    if (attemptedRuns.has(runId)) return;
    attemptedRuns.add(runId);
    const task = (async () => {
      await reflect(runId);
    })();
    inFlightTasks.add(task);
    const settle = (): void => {
      inFlightTasks.delete(task);
    };
    void task.then(settle, settle);
  }

  async function recall(input: {
    sessionId: string;
    runId: string;
    query: string;
    signal: AbortSignal;
  }): Promise<
    ReadonlyArray<{
      id: string;
      kind: string;
      lesson: string;
      evidence: string;
      applicability: string;
      provenance: string;
    }>
  > {
    if (stopped || input.signal.aborted) return [];
    let approved: readonly LearningProposalRow[];
    try {
      approved = store.listApprovedForSession(input.sessionId);
    } catch {
      return [];
    }
    const scored: Array<{ row: LearningProposalRow; score: number }> = [];
    for (const row of approved) {
      const score = lessonRelevanceScore(
        input.query,
        `${row.lesson} ${row.applicability}`,
      );
      if (score >= LEARNING_RETRIEVAL_MIN_SCORE) {
        scored.push({ row, score });
      }
    }
    scored.sort(
      (a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt,
    );
    const selected = scored.slice(0, LEARNING_MAX_RETRIEVED);
    const out: Array<{
      id: string;
      kind: string;
      lesson: string;
      evidence: string;
      applicability: string;
      provenance: string;
    }> = [];
    for (const { row } of selected) {
      if (input.signal.aborted) return [];
      out.push({
        id: row.id,
        kind: row.kind,
        lesson: row.lesson,
        evidence: row.evidence,
        applicability: row.applicability,
        provenance: `accepted_completed_turn run=${row.runId} turn=${row.turnId}`,
      });
    }
    // Record applications ONLY for the exact whole-lesson prefix the agent's
    // advisory block retains after its fixed 4096-character budget; dropped
    // lessons were never shown to the model, so they are not "applied".
    const retained = selectLessonsForPromptBlock(out);
    for (const lesson of retained) {
      try {
        store.recordApplication({
          sessionId: input.sessionId,
          runId: input.runId,
          proposalId: lesson.id,
          now: now(),
        });
      } catch {
        // Application audit is best-effort; the lesson itself is still safe.
      }
    }
    return [...retained];
  }

  return {
    recallHook: { recall },
    onRunCompleted,
    store,
    listApproved(sessionId) {
      return store.listApprovedForSession(sessionId);
    },
    start() {
      started = true;
      stopped = false;
    },
    async stop() {
      stopped = true;
      started = false;
      // Drop deferred extractions immediately: they are optional reflection
      // and must not hold shutdown open for a bounded retry tick.
      for (const wake of [...pendingSlotWaiters]) {
        try {
          wake();
        } catch {
          // Best effort.
        }
      }
      for (const controller of [...inFlightControllers]) {
        try {
          controller.abort();
        } catch {
          // Best effort.
        }
      }
      // Quiesce: every started reflection task settles before the store closes,
      // so no late capture can touch a closed handle.
      await Promise.allSettled([...inFlightTasks]);
      try {
        store.close();
      } catch {
        // Best effort.
      }
    },
  };
}

/** Deterministic identifier helper used only in tests/messages (never a key). */
export function learningDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
