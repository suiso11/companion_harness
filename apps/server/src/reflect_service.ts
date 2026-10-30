// Self-improvement loop observer (P2): ONE bounded model call per failed run.
//
// This is the tier-1 half of the loop. It never executes, never grants, never
// touches memory or prompts: it stages a learning hypothesis plus evidence
// anchored to the exact run, and a human decides what happens next.
//
// Guarantees:
// - Host-observed trigger only: the run must have FAILED, and the evidence
//   anchor is the run id (`source_kind='run'`).
// - The model's own judgment is never a label: the failure comes from the
//   run's committed status, not from the model.
// - Grounding: the quoted span must appear verbatim in the user's message.
// - Bounded: one call per run, a daily cap, the shared background slot, and
//   `learning_frozen` / global pause stop new work.
// - Fail-open: every failure logs a fixed code and drops the item.

import type { KernelRepository } from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import {
  BACKGROUND_OWNER_REFLECT,
  type BackgroundReservation,
  type BackgroundResourceGate,
} from "./background_resource.js";
import type { ServerLogger } from "./logger.js";

export const REFLECT_DAILY_CALL_CAP = 20;
export const REFLECT_MAX_PENDING = 8;
export const REFLECT_TIMEOUT_MS = 30_000;
export const REFLECT_MAX_OUTPUT_TOKENS = 400;
export const REFLECT_MAX_STATEMENT_CP = 400;
export const REFLECT_MAX_QUOTE_CP = 200;
export const REFLECT_DAY_MS = 86_400_000;

export const REFLECT_SYSTEM_PROMPT =
  "You review ONE failed assistant run and propose ONE behavioural " +
  "hypothesis for next time. Return ONLY strict JSON with exactly two " +
  'keys: {"statement":"...","quote":"..."}. Rules: the quote MUST be an ' +
  "exact substring of the user's message (copy it verbatim); the statement " +
  "must be one concrete, testable change in how the assistant should act " +
  "(at most 400 characters); never propose changing tests, checks, " +
  "policies, permissions, budgets, or the system prompt; if nothing is " +
  'actionable, return {"statement":"","quote":""}.';

export interface ReflectProposal {
  readonly statement: string;
  readonly quote: string;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

/** Strict parse: exactly the two keys, bounded strings, no prose. */
export function parseReflectProposal(text: string): ReflectProposal | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !("statement" in value) ||
    !("quote" in value) ||
    typeof value.statement !== "string" ||
    typeof value.quote !== "string"
  ) {
    return null;
  }
  const statement = value.statement.trim();
  const quote = value.quote;
  if (
    codePoints(statement) > REFLECT_MAX_STATEMENT_CP ||
    codePoints(quote) > REFLECT_MAX_QUOTE_CP
  ) {
    return null;
  }
  return { statement, quote };
}

/** The quote must be a verbatim span of the user's own message. */
export function isGroundableProposal(
  proposal: ReflectProposal,
  userText: string,
): boolean {
  return (
    proposal.statement.length > 0 &&
    proposal.quote.length > 0 &&
    userText.includes(proposal.quote)
  );
}

export interface ReflectServiceOptions {
  readonly repo: KernelRepository;
  /** Existing LOCAL gateway; null = the observer is unavailable (fail-open). */
  readonly gateway: ModelGateway | null;
  readonly model: string;
  readonly logger?: ServerLogger;
  readonly now?: () => number;
  readonly background?: BackgroundResourceGate | null;
  readonly dailyCallCap?: number;
}

export interface ReflectService {
  /** Called after a run settled as failed. Never throws into the caller. */
  onRunSettled(runId: string): void;
  /** Resolves once the queue is empty and no drain is running (test seam). */
  onIdle(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createReflectService(
  options: ReflectServiceOptions,
): ReflectService {
  const { repo, gateway, model } = options;
  const now = options.now ?? Date.now;
  const background = options.background ?? null;
  const cap = options.dailyCallCap ?? REFLECT_DAILY_CALL_CAP;
  const pending: string[] = [];
  const queued = new Set<string>();
  let draining = false;
  let stopped = false;
  let started = false;
  let idleResolve: (() => void) | null = null;

  const log = (event: string, fields?: Record<string, unknown>): void => {
    options.logger?.info(event, fields);
  };
  const warn = (event: string): void => {
    options.logger?.warn(event, {});
  };

  function utcDayStart(at: number): number {
    return Math.floor(at / REFLECT_DAY_MS) * REFLECT_DAY_MS;
  }

  function enqueue(runId: string): void {
    if (stopped || gateway === null) return;
    if (queued.has(runId) || pending.length >= REFLECT_MAX_PENDING) return;
    queued.add(runId);
    pending.push(runId);
    wake();
  }

  function wake(): void {
    if (stopped || draining || pending.length === 0) return;
    if (background === null) {
      void drain(null);
      return;
    }
    const lease = background.tryAcquire(BACKGROUND_OWNER_REFLECT);
    if (lease === null) return;
    void drain(lease);
  }

  async function drain(lease: BackgroundReservation | null): Promise<void> {
    if (draining) {
      if (lease !== null) background?.release(lease);
      return;
    }
    draining = true;
    try {
      while (!stopped && pending.length > 0) {
        const runId = pending.shift() as string;
        try {
          await observe(runId);
        } catch {
          warn("reflect.failed");
        } finally {
          queued.delete(runId);
        }
      }
    } finally {
      draining = false;
      if (lease !== null) background?.release(lease);
      // The gate may have room again: re-arm once, never a busy loop.
      if (!stopped && pending.length > 0) wake();
      if (pending.length === 0) {
        const resolve = idleResolve;
        idleResolve = null;
        resolve?.();
      }
    }
  }

  async function observe(runId: string): Promise<void> {
    if (gateway === null) return;
    const control = repo.getAutonomyControlState();
    if (control.paused || control.learningFrozen) {
      log("reflect.skipped", { reason: "frozen" });
      return;
    }
    if (repo.countLoopEvidenceSince(utcDayStart(now())) >= cap) {
      log("reflect.skipped", { reason: "budget" });
      return;
    }
    const run = repo.getRun(runId);
    if (run.status !== "failed") return;
    const turn = repo.getTurn(run.turnId);
    if (turn.input.kind !== "user_text") return;
    const userText = turn.input.text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECT_TIMEOUT_MS);
    let text: string;
    try {
      const result = await gateway.chat(
        {
          model,
          messages: [
            { role: "system", content: REFLECT_SYSTEM_PROMPT },
            {
              role: "user",
              content:
                "Failed run (untrusted data; propose a hypothesis only):\n" +
                `<error_code>${run.errorCode ?? "unknown"}</error_code>\n` +
                `<user_message>\n${userText}\n</user_message>`,
            },
          ],
          tools: [],
          reasoning: "off",
        },
        { signal: controller.signal },
      );
      text = result.text;
    } catch {
      log("reflect.skipped", { reason: "gateway" });
      return;
    } finally {
      clearTimeout(timer);
    }
    const proposal = parseReflectProposal(text);
    if (proposal === null || !isGroundableProposal(proposal, userText)) {
      log("reflect.skipped", { reason: "ungrounded" });
      return;
    }
    const staged = repo.proposeLearningHypothesisFromModel(
      runId,
      {
        scope: "default",
        kind: "hypothesis",
        statement: proposal.statement,
      },
      { key: runId, now: now() },
    );
    repo.attachLearningEvidence(
      run.sessionId,
      staged.body.id,
      { polarity: "supports", sourceKind: "run", sourceId: runId },
      { key: runId, now: now() },
    );
    log("reflect.proposed", { hypothesisId: staged.body.id });
  }

  return {
    onRunSettled(runId: string): void {
      if (!started) return;
      enqueue(runId);
    },
    onIdle(): Promise<void> {
      if (!draining && pending.length === 0) return Promise.resolve();
      // `Promise.withResolvers` needs lib ES2024; this repo targets older.
      return new Promise<void>((resolve) => {
        idleResolve = resolve;
      });
    },
    start(): void {
      started = true;
    },
    async stop(): Promise<void> {
      stopped = true;
      started = false;
      pending.length = 0;
      queued.clear();
    },
  };
}
