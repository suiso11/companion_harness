// M0 ToolBroker: the sole boundary for model-caused tool calls
// (plan §3, §9 blockers 3/5/6, §10 tool_calls, §12.4, §13.1 M0.4, §13.3).
//
// - Static registry only: registrations are supplied and finalized at
//   construction; there is no model-controlled or dynamic registration.
//   Descriptors are serializable contracts (ToolDescriptor); Zod
//   input/output schemas, handlers, and normalizers are kernel-owned.
// - Fixed pipeline order (observable via `onStep` and the returned
//   `pipeline` trace): budget_reserve -> classify -> validate -> dedup ->
//   execute -> normalize -> audit. Every logical request reaching the
//   broker reserves budget FIRST (atomic `runs.tool_requests_used` CAS),
//   before unknown/denied/invalid/dedup decisions. Budget exhaustion
//   itself never increments past the cap.
// - M0 read-only policy (default-deny): only `category: "read"` tools
//   execute; write / sensitive / unclassified / unknown tools are denied
//   and never execute. `allowedTools` further restricts per call.
// - Metadata-only audit: `tool_calls` rows and `tool.requested` /
//   `tool.completed` events carry hashes/digests/fixed codes/metadata
//   only. Raw args/results/content/errors are never stored.
// - Dedup is same-Run only, keyed on the post-Zod-defaults canonical JSON
//   fingerprint: in-flight coalescing shares physical work (each logical
//   request still consumes budget), completed successes are reused,
//   `freshness: "refresh"` always bypasses and executes. No cross-run
//   reuse. No automatic retries.
// - Bounded physical concurrency (per-run 3, process 8 by default):
//   excess physical calls queue FIFO (per-run order preserved), never
//   dropped for exceeding the caps.
// - Size/observation budgets: per-call input (32KiB), normalized output
//   (256KiB), model-facing output (64KiB), per-run cumulative model output
//   (128KiB), per-call observations (20), per-run cumulative observations
//   (50). Excess is rejected, never silently truncated.
// - Timeout composition: effective timeout = min(requested, descriptor
//   default/max, global max); default 15s, hard max 60s. The broker stops
//   awaiting non-cooperative handlers at timeout/cancel (detachment); a
//   late handler report only updates the audit row
//   (`reported_outcome`/`result_disposition = "discarded"`) and never
//   appends a RunEvent after terminal.
// - Terminal finality: `tool.requested`/`tool.completed` events are
//   appended only while the Run is nonterminal. A physical success that
//   lands after terminal is recorded as actual `cancelled` with the
//   handler's report preserved and disposition `discarded`.

import {
  type ActualOutcome,
  isTerminalStatus,
  parseRunEventPayload,
  parseToolErrorCode,
  type ReportedOutcome,
  type ResultDisposition,
  RUN_EVENT_SCHEMA_VERSION,
  type RunStatus,
  TOOL_BUDGET_DEFAULTS,
  type ToolDescriptor,
  ToolDescriptorSchema,
  type ToolResult,
  ToolResultSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { canonicalJsonString, generateId, sha256Hex } from "./canonical.js";
import {
  KernelStorageError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import type { KernelRepository } from "./repository.js";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Fixed pipeline step names, in pipeline order. */
export type PipelineStep =
  | "budget_reserve"
  | "classify"
  | "validate"
  | "dedup"
  | "execute"
  | "normalize"
  | "audit";

/** The fixed pipeline order (budget first, audit last). */
export const BROKER_PIPELINE_ORDER: readonly PipelineStep[] = [
  "budget_reserve",
  "classify",
  "validate",
  "dedup",
  "execute",
  "normalize",
  "audit",
] as const;

/** Minimal structural schema shape (the kernel never imports zod). */
export interface ToolSchema<T = unknown> {
  parse(data: unknown): T;
}

/** Freshness hint: `refresh` bypasses dedup and always executes. */
export type ToolFreshness = "normal" | "refresh";

/**
 * Kernel-owned static dedup mode (exact closed type, default `normal`).
 *
 * - `normal` (default): `freshness: "refresh"` in the caller context bypasses
 *   dedup; otherwise same-Run fingerprint reuse/coalescing applies.
 * - `always_bypass`: every call bypasses dedup and executes (used by
 *   `reference.refresh`, which always materializes a new Snapshot+rN).
 * - `input_freshness`: the validated/defaulted input `freshness` field also
 *   bypasses dedup (used by `markdown.search`, so input `freshness: "refresh"`
 *   bypasses even when the caller context omitted it).
 *
 * The effective freshness is computed ONLY after input validation/defaulting
 * and drives both the dedup lookup and `HandlerContext.freshness`. Caller
 * `freshness: "refresh"` always bypasses regardless of mode (preserved).
 */
export type ToolDedupMode = "normal" | "always_bypass" | "input_freshness";

/** Handler context: run/call identity plus the composed AbortSignal. */
export interface ToolHandlerContext {
  readonly runId: string;
  readonly callId: string;
  readonly callIndex: number;
  readonly tool: string;
  readonly signal: AbortSignal;
  readonly origin: string;
  readonly caller: string;
  readonly freshness: ToolFreshness;
}

/** Kernel-owned handler: raw output (or a rejected promise on failure). */
export type ToolHandler = (
  input: never,
  ctx: ToolHandlerContext,
) => Promise<unknown>;

/** Normalized physical output with observation/model-facing accounting. */
export interface NormalizedToolOutput {
  readonly normalized: unknown;
  readonly observations: number;
  readonly modelFacing: unknown;
}

/** Kernel-owned normalizer (raw handler output -> audited output). */
export type ToolNormalizer = (
  raw: unknown,
  ctx: { readonly input: unknown },
) => NormalizedToolOutput | Promise<NormalizedToolOutput>;

/** Static registration: serializable descriptor + kernel-owned runtime. */
export interface ToolRegistration {
  readonly descriptor: ToolDescriptor;
  readonly inputSchema: ToolSchema;
  readonly outputSchema: ToolSchema;
  readonly handler: ToolHandler;
  readonly normalize?: ToolNormalizer;
  /**
   * Static dedup mode (exact closed type). Omitted means `normal` (default
   * behavior unchanged). `always_bypass` and `input_freshness` bypass dedup
   * via the effective-freshness path computed after input validation.
   */
  readonly dedupMode?: ToolDedupMode;
}

/** Per-call invocation context (origin/caller/allowedTools/AbortSignal). */
export interface ToolInvokeContext {
  readonly origin: string;
  readonly caller: string;
  readonly allowedTools?: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly freshness?: ToolFreshness;
}

/** Budget set (defaults are the exact §9 blocker 6 values). */
export interface ToolBrokerBudgets {
  readonly maxToolRequestsPerRun: number;
  readonly maxConcurrentPerRun: number;
  readonly maxConcurrentProcess: number;
  readonly maxInputBytesPerCall: number;
  readonly maxNormalizedOutputBytesPerCall: number;
  readonly maxModelFacingOutputBytesPerCall: number;
  readonly maxModelFacingOutputBytesPerRun: number;
  readonly maxObservationsPerCall: number;
  readonly maxObservationsPerRun: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
}

/** Step observer used to assert the fixed pipeline order in tests. */
export interface PipelineStepInfo {
  readonly runId: string;
  readonly tool: string;
  readonly callIndex: number;
}

export interface ToolBrokerOptions {
  readonly db: Database.Database;
  readonly repo: KernelRepository;
  readonly registrations: readonly ToolRegistration[];
  readonly budgets?: Partial<ToolBrokerBudgets>;
  readonly clock?: { now(): number };
  readonly onStep?: (step: PipelineStep, info: PipelineStepInfo) => void;
}

/** Caller-visible result: typed audit outcome plus delivered data. */
export interface BrokerCallResult {
  readonly result: ToolResult;
  /** Normalized output on success (or dedup reuse); null otherwise. */
  readonly normalized: unknown;
  /** Model-facing projection on success (or dedup reuse); null otherwise. */
  readonly modelFacing: unknown;
  /** Ordered pipeline steps actually traversed by this request. */
  readonly pipeline: readonly PipelineStep[];
}

/** Fixed-code handler failure (raw errors are never stored). */
export class ToolError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message?: string) {
    const code = parseToolErrorCode(errorCode);
    super(message ?? code);
    this.name = "ToolError";
    this.errorCode = code;
  }
}

/**
 * Fixed synthetic audit name for invalid tool-name requests. It is a valid
 * `namespace.verb` value so tool_calls / run_events / ToolResult stay
 * schema-valid while the arbitrary invalid text is never persisted,
 * returned, logged, or embedded in errors.
 */
const INVALID_TOOL_AUDIT_NAME = "invalid.request" as const;

/** Local `namespace.verb` check mirroring contracts ToolNameSchema (no raw text in errors). */
const TOOL_NAME_PATTERN =
  /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+(?:_[a-z0-9]+)*$/;

function isValidToolNameFormat(name: string): boolean {
  return name.length >= 1 && name.length <= 128 && TOOL_NAME_PATTERN.test(name);
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Best-effort fingerprint for pre-validation args (metadata only). */
function fingerprintRawArgs(tool: string, rawArgs: unknown): string {
  try {
    return sha256Hex(canonicalJsonString(rawArgs) ?? "undefined");
  } catch {
    return sha256Hex(`unserializable:${tool}:${typeof rawArgs}`);
  }
}

function mapHandlerError(error: unknown): {
  code: string;
  cancelLike: boolean;
} {
  if (error instanceof ToolError) {
    return {
      code: error.errorCode,
      cancelLike: error.errorCode === "execution_cancelled",
    };
  }
  return { code: "execution_failed", cancelLike: false };
}

type AbortKind = "timeout" | "cancel" | null;

/** Reads the abort flag through a call boundary (closure-set values). */
function wasTimeout(kind: AbortKind): boolean {
  return kind === "timeout";
}

/** FIFO counting semaphore with abortable waiters. */
class Slot {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      return Promise.resolve(false);
    }
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = (): void => {
        this.active += 1;
        resolve(true);
      };
      this.waiters.push(grant);
      signal.addEventListener(
        "abort",
        () => {
          const index = this.waiters.indexOf(grant);
          if (index >= 0) {
            this.waiters.splice(index, 1);
            resolve(false);
          }
        },
        { once: true },
      );
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }
}

interface CallRef {
  readonly callId: string;
  readonly callIndex: number;
}

interface FinalOutcome {
  readonly actualOutcome: ActualOutcome;
  readonly reportedOutcome: ReportedOutcome | null;
  readonly disposition: ResultDisposition;
  readonly errorCode: string | null;
  readonly resultDigest: string | null;
  readonly reusedFromCallId: string | null;
  readonly normalized: unknown;
  readonly modelFacing: unknown;
  /** Carried for coalesced budget charging; never persisted directly. */
  readonly modelBytesForBudget?: number;
  /** Carried for coalesced budget charging; never persisted directly. */
  readonly observationsForBudget?: number;
}

/** Physical work passed all per-call checks; cumulative/terminal pending. */
interface PendingSuccess {
  readonly normalized: unknown;
  readonly modelFacing: unknown;
  readonly observations: number;
  readonly modelBytes: number;
  readonly resultDigest: string;
}

type PhysicalSettlement =
  | { kind: "failed"; final: FinalOutcome }
  | { kind: "pending"; pending: PendingSuccess };

type LeaderSettlement =
  | { accepted: true; final: FinalOutcome }
  | { accepted: false; final: FinalOutcome };

interface DedupInflight {
  readonly status: "inflight";
  readonly leaderCallId: string;
  readonly promise: Promise<LeaderSettlement>;
}

interface DedupDone {
  readonly status: "done";
  readonly leaderCallId: string;
  readonly normalized: unknown;
  readonly modelFacing: unknown;
  readonly modelBytes: number;
  readonly observations: number;
  readonly resultDigest: string;
}

type DedupEntry = DedupInflight | DedupDone;

function deniedOutcome(): FinalOutcome {
  return {
    actualOutcome: "denied",
    reportedOutcome: null,
    disposition: "none",
    errorCode: "tool_denied",
    resultDigest: null,
    reusedFromCallId: null,
    normalized: null,
    modelFacing: null,
  };
}

function invalidOutcome(): FinalOutcome {
  return {
    actualOutcome: "invalid",
    reportedOutcome: null,
    disposition: "none",
    errorCode: "invalid_input",
    resultDigest: null,
    reusedFromCallId: null,
    normalized: null,
    modelFacing: null,
  };
}

function timeoutOutcome(): FinalOutcome {
  return {
    actualOutcome: "timed_out",
    reportedOutcome: null,
    disposition: "none",
    errorCode: "execution_timeout",
    resultDigest: null,
    reusedFromCallId: null,
    normalized: null,
    modelFacing: null,
  };
}

function cancelOutcome(reported: ReportedOutcome | null): FinalOutcome {
  return {
    actualOutcome: "cancelled",
    reportedOutcome: reported,
    disposition: "none",
    errorCode: "execution_cancelled",
    resultDigest: null,
    reusedFromCallId: null,
    normalized: null,
    modelFacing: null,
  };
}

function outputInvalidOutcome(
  reported: ReportedOutcome,
  digest: string | null,
): FinalOutcome {
  return {
    actualOutcome: "failed",
    reportedOutcome: reported,
    disposition: "none",
    errorCode: "output_invalid",
    resultDigest: digest,
    reusedFromCallId: null,
    normalized: null,
    modelFacing: null,
  };
}

function outputTooLargeOutcome(
  reported: ReportedOutcome,
  digest: string | null,
): FinalOutcome {
  return {
    actualOutcome: "failed",
    reportedOutcome: reported,
    disposition: "discarded",
    errorCode: "output_too_large",
    resultDigest: digest,
    reusedFromCallId: null,
    normalized: null,
    modelFacing: null,
  };
}

function digestOf(value: unknown): string | null {
  try {
    return sha256Hex(canonicalJsonString(value));
  } catch {
    return null;
  }
}

/** Defensive copy so cached/delivered payloads never share references. */
function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

function defaultNormalizer(raw: unknown): NormalizedToolOutput {
  if (Array.isArray(raw)) {
    return { normalized: raw, observations: raw.length, modelFacing: raw };
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    Array.isArray((raw as { observations?: unknown }).observations)
  ) {
    const list = (raw as { observations: unknown[] }).observations;
    return { normalized: raw, observations: list.length, modelFacing: raw };
  }
  return { normalized: raw, observations: 0, modelFacing: raw };
}

function defaultBudgets(): ToolBrokerBudgets {
  return { ...TOOL_BUDGET_DEFAULTS };
}

function requirePositiveInt(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new RepositoryValidationError(`${what} must be an integer >= 1`);
  }
  return value as number;
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositoryValidationError(`${what} must be a non-empty string`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* ToolBroker                                                          */
/* ------------------------------------------------------------------ */

export class ToolBroker {
  private readonly db: Database.Database;
  private readonly repo: KernelRepository;
  private readonly registry = new Map<string, ToolRegistration>();
  private readonly budgets: ToolBrokerBudgets;
  private readonly clock: { now(): number };
  private readonly onStep:
    | ((step: PipelineStep, info: PipelineStepInfo) => void)
    | undefined;

  private readonly processSlot: Slot;
  private readonly perRunSlots = new Map<string, Slot>();
  private readonly dedup = new Map<string, Map<string, DedupEntry>>();
  private readonly cumulative = new Map<
    string,
    { modelBytes: number; observations: number }
  >();

  constructor(options: ToolBrokerOptions) {
    if (options.db === undefined || options.repo === undefined) {
      throw new RepositoryValidationError("ToolBroker requires db and repo");
    }
    this.db = options.db;
    this.repo = options.repo;
    const base = defaultBudgets();
    const over = options.budgets ?? {};
    this.budgets = {
      maxToolRequestsPerRun:
        over.maxToolRequestsPerRun === undefined
          ? base.maxToolRequestsPerRun
          : requirePositiveInt(
              over.maxToolRequestsPerRun,
              "maxToolRequestsPerRun",
            ),
      maxConcurrentPerRun:
        over.maxConcurrentPerRun === undefined
          ? base.maxConcurrentPerRun
          : requirePositiveInt(over.maxConcurrentPerRun, "maxConcurrentPerRun"),
      maxConcurrentProcess:
        over.maxConcurrentProcess === undefined
          ? base.maxConcurrentProcess
          : requirePositiveInt(
              over.maxConcurrentProcess,
              "maxConcurrentProcess",
            ),
      maxInputBytesPerCall:
        over.maxInputBytesPerCall === undefined
          ? base.maxInputBytesPerCall
          : requirePositiveInt(
              over.maxInputBytesPerCall,
              "maxInputBytesPerCall",
            ),
      maxNormalizedOutputBytesPerCall:
        over.maxNormalizedOutputBytesPerCall === undefined
          ? base.maxNormalizedOutputBytesPerCall
          : requirePositiveInt(
              over.maxNormalizedOutputBytesPerCall,
              "maxNormalizedOutputBytesPerCall",
            ),
      maxModelFacingOutputBytesPerCall:
        over.maxModelFacingOutputBytesPerCall === undefined
          ? base.maxModelFacingOutputBytesPerCall
          : requirePositiveInt(
              over.maxModelFacingOutputBytesPerCall,
              "maxModelFacingOutputBytesPerCall",
            ),
      maxModelFacingOutputBytesPerRun:
        over.maxModelFacingOutputBytesPerRun === undefined
          ? base.maxModelFacingOutputBytesPerRun
          : requirePositiveInt(
              over.maxModelFacingOutputBytesPerRun,
              "maxModelFacingOutputBytesPerRun",
            ),
      maxObservationsPerCall:
        over.maxObservationsPerCall === undefined
          ? base.maxObservationsPerCall
          : requirePositiveInt(
              over.maxObservationsPerCall,
              "maxObservationsPerCall",
            ),
      maxObservationsPerRun:
        over.maxObservationsPerRun === undefined
          ? base.maxObservationsPerRun
          : requirePositiveInt(
              over.maxObservationsPerRun,
              "maxObservationsPerRun",
            ),
      defaultTimeoutMs:
        over.defaultTimeoutMs === undefined
          ? base.defaultTimeoutMs
          : requirePositiveInt(over.defaultTimeoutMs, "defaultTimeoutMs"),
      maxTimeoutMs:
        over.maxTimeoutMs === undefined
          ? base.maxTimeoutMs
          : requirePositiveInt(over.maxTimeoutMs, "maxTimeoutMs"),
    };
    this.clock = options.clock ?? { now: () => Date.now() };
    this.onStep = options.onStep;
    this.processSlot = new Slot(this.budgets.maxConcurrentProcess);

    // Static registry: validated once, frozen, no mutators exposed.
    const seen = new Set<string>();
    for (const reg of options.registrations) {
      const descriptor = ToolDescriptorSchema.parse(reg.descriptor);
      if (seen.has(descriptor.name)) {
        throw new RepositoryValidationError(
          `duplicate tool registration: ${descriptor.name}`,
        );
      }
      seen.add(descriptor.name);
      if (typeof reg.inputSchema?.parse !== "function") {
        throw new RepositoryValidationError(
          `tool ${descriptor.name} inputSchema must expose parse()`,
        );
      }
      if (typeof reg.outputSchema?.parse !== "function") {
        throw new RepositoryValidationError(
          `tool ${descriptor.name} outputSchema must expose parse()`,
        );
      }
      if (typeof reg.handler !== "function") {
        throw new RepositoryValidationError(
          `tool ${descriptor.name} handler must be a function`,
        );
      }
      if (reg.normalize !== undefined && typeof reg.normalize !== "function") {
        throw new RepositoryValidationError(
          `tool ${descriptor.name} normalize must be a function`,
        );
      }
      if (
        reg.dedupMode !== undefined &&
        reg.dedupMode !== "normal" &&
        reg.dedupMode !== "always_bypass" &&
        reg.dedupMode !== "input_freshness"
      ) {
        throw new RepositoryValidationError(
          `tool ${descriptor.name} dedupMode must be normal|always_bypass|input_freshness`,
        );
      }
      this.registry.set(descriptor.name, {
        descriptor,
        inputSchema: reg.inputSchema,
        outputSchema: reg.outputSchema,
        handler: reg.handler,
        ...(reg.normalize === undefined ? {} : { normalize: reg.normalize }),
        ...(reg.dedupMode === undefined ? {} : { dedupMode: reg.dedupMode }),
      });
    }
  }

  /** Registered tool names (read-only snapshot). */
  toolNames(): readonly string[] {
    return [...this.registry.keys()];
  }

  /** Effective budgets (read-only copy). */
  getBudgets(): ToolBrokerBudgets {
    return { ...this.budgets };
  }

  /** Current slot usage (for queueing tests). */
  getSlotUsage(): {
    processActive: number;
    perRunActive: Record<string, number>;
  } {
    const perRunActive: Record<string, number> = {};
    for (const [runId, slot] of this.perRunSlots) {
      perRunActive[runId] = slot.inUse;
    }
    return { processActive: this.processSlot.inUse, perRunActive };
  }

  /** Drop cached dedup/cumulative/slot state for a run (hygiene only). */
  clearRunState(runId: string): void {
    this.dedup.delete(runId);
    this.cumulative.delete(runId);
    this.perRunSlots.delete(runId);
  }

  /* ------------------------------------------------------------ */
  /* Main entry point                                              */
  /* ------------------------------------------------------------ */

  async invoke(
    runId: string,
    tool: string,
    args: unknown,
    context: ToolInvokeContext,
  ): Promise<BrokerCallResult> {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new RepositoryValidationError("runId must be a non-empty string");
    }
    if (typeof tool !== "string" || tool.length === 0) {
      throw new RepositoryValidationError("tool must be a non-empty string");
    }
    const origin = requireNonEmpty(context.origin, "origin");
    const caller = requireNonEmpty(context.caller, "caller");
    if (context.allowedTools !== undefined) {
      if (!Array.isArray(context.allowedTools)) {
        throw new RepositoryValidationError(
          "allowedTools must be an array of strings",
        );
      }
      for (const entry of context.allowedTools) {
        if (typeof entry !== "string") {
          throw new RepositoryValidationError(
            "allowedTools must be an array of strings",
          );
        }
      }
    }
    if (context.timeoutMs !== undefined) {
      if (
        typeof context.timeoutMs !== "number" ||
        !Number.isFinite(context.timeoutMs) ||
        context.timeoutMs <= 0
      ) {
        throw new RepositoryValidationError(
          "timeoutMs must be a positive finite number",
        );
      }
    }
    const freshness: ToolFreshness = context.freshness ?? "normal";
    if (freshness !== "normal" && freshness !== "refresh") {
      throw new RepositoryValidationError(
        'freshness must be "normal" or "refresh"',
      );
    }

    // Name validity is computed safely here (pure, no persistence), but
    // rejection/audit occurs only after budget reservation and running
    // eligibility below. Invalid text never persists: every audit/event/
    // result/log path uses `auditTool` (a fixed valid synthetic name).
    const requestedTool = tool;
    const nameValid = isValidToolNameFormat(requestedTool);
    const auditTool = nameValid ? requestedTool : INVALID_TOOL_AUDIT_NAME;

    const trace: PipelineStep[] = [];
    const callIndexHolder: { callIndex: number } = { callIndex: 0 };
    const note = (step: PipelineStep): void => {
      trace.push(step);
      this.onStep?.(step, {
        runId,
        tool: auditTool,
        callIndex: callIndexHolder.callIndex,
      });
    };

    // ---- Step 1: atomic budget reservation (first, always). ----
    note("budget_reserve");
    const arrivalHash = fingerprintRawArgs(auditTool, args);
    if (!this.reserveBudget(runId)) {
      const call = this.insertCallRow(runId, auditTool, arrivalHash);
      callIndexHolder.callIndex = call.callIndex;
      const budgetFinal: FinalOutcome = {
        actualOutcome: "failed",
        reportedOutcome: null,
        disposition: "none",
        errorCode: "budget_exceeded",
        resultDigest: null,
        reusedFromCallId: null,
        normalized: null,
        modelFacing: null,
      };
      // Begun-non-running budget exhaustion audits with no RunEvents.
      if (!this.isRunning(runId)) {
        return this.finishFastAuditOnly(
          runId,
          auditTool,
          call,
          budgetFinal,
          trace,
        );
      }
      return this.finishFast(runId, auditTool, call, budgetFinal, trace);
    }
    const call = this.insertCallRow(runId, auditTool, arrivalHash);
    callIndexHolder.callIndex = call.callIndex;

    // ---- Running-only eligibility: budget is already reserved (first),
    // but queued / cancel_requested / terminal runs never execute and
    // never receive cached output. Ineligible calls audit as cancelled
    // before any further pipeline work, with no RunEvents. The
    // tool.requested event is emitted only after confirmed running
    // eligibility.
    if (!this.isRunning(runId)) {
      return this.finishFastAuditOnly(
        runId,
        auditTool,
        call,
        cancelOutcome(null),
        trace,
      );
    }
    // Durable requested event with the post-Zod args hash: persistence
    // failure rejects here so physical work can never occur without the
    // durable requested event. Rejection/unknown/denied/invalid paths emit
    // the requested event with the best-available hash (arrival hash before
    // validation, post-Zod hash after) before their completed commit. Only
    // a run that left running (non-running audit-only) may omit events.

    // ---- Step 2: classification (allowlist + read-only default-deny). ----
    // Invalid `namespace.verb` names are rejected here as fixed
    // invalid_input with the synthetic audit name; valid-format unknown
    // names fall through to the unknown_tool path in validate.
    note("classify");
    if (!nameValid) {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(runId, auditTool, call, invalidOutcome(), trace);
    }
    const reg = this.registry.get(requestedTool);
    if (
      context.allowedTools !== undefined &&
      !context.allowedTools.includes(requestedTool)
    ) {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(runId, auditTool, call, deniedOutcome(), trace);
    }
    if (reg !== undefined && reg.descriptor.category !== "read") {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(runId, auditTool, call, deniedOutcome(), trace);
    }

    // ---- Step 3: descriptor + input validation. ----
    note("validate");
    if (reg === undefined) {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(
        runId,
        auditTool,
        call,
        {
          actualOutcome: "unknown",
          reportedOutcome: null,
          disposition: "none",
          errorCode: "unknown_tool",
          resultDigest: null,
          reusedFromCallId: null,
          normalized: null,
          modelFacing: null,
        },
        trace,
      );
    }
    let input: unknown;
    try {
      input = reg.inputSchema.parse(args);
    } catch {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(runId, auditTool, call, invalidOutcome(), trace);
    }
    let canonicalInput: string;
    try {
      canonicalInput = canonicalJsonString(input);
    } catch {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(runId, auditTool, call, invalidOutcome(), trace);
    }
    if (byteLengthUtf8(canonicalInput) > this.budgets.maxInputBytesPerCall) {
      this.appendRequested(runId, auditTool, call, arrivalHash);
      return this.finishFast(runId, auditTool, call, invalidOutcome(), trace);
    }
    const argsHash = sha256Hex(canonicalInput);
    this.updateArgsHash(call.callId, argsHash);
    // Requested event carries the post-Zod canonical hash (never raw args).
    this.appendRequested(runId, auditTool, call, argsHash);

    // ---- Step 4: dedup (same run, post-defaults fingerprint). ----
    // Effective freshness is computed ONLY after validated/defaulted input:
    // caller `refresh` always bypasses (preserved); `always_bypass` always
    // bypasses; `input_freshness` bypasses when the defaulted input
    // `freshness` is `refresh` even if the caller context omitted it.
    // The effective value drives both the lookup below and HandlerContext.
    note("dedup");
    const key = `${auditTool}:${argsHash}`;
    const dedupMode: ToolDedupMode = reg.dedupMode ?? "normal";
    let inputFreshness: ToolFreshness = "normal";
    if (
      typeof input === "object" &&
      input !== null &&
      (input as { freshness?: unknown }).freshness === "refresh"
    ) {
      inputFreshness = "refresh";
    }
    const effectiveFreshness: ToolFreshness =
      freshness === "refresh"
        ? "refresh"
        : dedupMode === "always_bypass"
          ? "refresh"
          : dedupMode === "input_freshness" && inputFreshness === "refresh"
            ? "refresh"
            : "normal";
    if (effectiveFreshness !== "refresh") {
      const prior = this.dedup.get(runId)?.get(key);
      if (prior !== undefined && prior.status === "done") {
        // Running-only delivery: a run that left `running` while this
        // request was in flight never receives cached output.
        if (!this.isRunning(runId)) {
          return this.finishFast(
            runId,
            auditTool,
            call,
            cancelOutcome(null),
            trace,
          );
        }
        // Every delivered dedup reuse consumes cumulative budgets and is
        // marked accepted with the leader digest; over-budget duplicates
        // are rejected with null payloads.
        const reservation = this.reserveCumulative(
          runId,
          prior.modelBytes,
          prior.observations,
        );
        if (reservation !== "ok") {
          const over =
            reservation === "model"
              ? outputTooLargeOutcome("succeeded", prior.resultDigest)
              : outputInvalidOutcome("succeeded", prior.resultDigest);
          return this.finishFast(runId, auditTool, call, over, trace);
        }
        return this.finishFast(
          runId,
          auditTool,
          call,
          {
            actualOutcome: "deduplicated",
            reportedOutcome: null,
            disposition: "accepted",
            errorCode: null,
            resultDigest: prior.resultDigest,
            reusedFromCallId: prior.leaderCallId,
            normalized: cloneValue(prior.normalized),
            modelFacing: cloneValue(prior.modelFacing),
          },
          trace,
        );
      }
      if (prior !== undefined && prior.status === "inflight") {
        const waited = await this.awaitLeader(
          prior.promise,
          context.signal,
          this.effectiveTimeout(reg, context.timeoutMs),
        );
        if (waited.kind === "timeout") {
          return this.finishFast(
            runId,
            auditTool,
            call,
            timeoutOutcome(),
            trace,
          );
        }
        if (waited.kind === "aborted") {
          return this.finishFast(
            runId,
            auditTool,
            call,
            cancelOutcome(null),
            trace,
          );
        }
        const leader = waited.settlement;
        // A run that left `running` during coalesced wait never receives
        // the leader output.
        if (!this.isRunning(runId)) {
          return this.finishFast(
            runId,
            auditTool,
            call,
            cancelOutcome(null),
            trace,
          );
        }
        if (leader.accepted) {
          const reservation = this.reserveCumulative(
            runId,
            leader.final.modelBytesForBudget ?? 0,
            leader.final.observationsForBudget ?? 0,
          );
          if (reservation !== "ok") {
            const over =
              reservation === "model"
                ? outputTooLargeOutcome("succeeded", leader.final.resultDigest)
                : outputInvalidOutcome("succeeded", leader.final.resultDigest);
            return this.finishFast(runId, auditTool, call, over, trace);
          }
          return this.finishFast(
            runId,
            auditTool,
            call,
            {
              actualOutcome: "deduplicated",
              reportedOutcome: null,
              disposition: "accepted",
              errorCode: null,
              resultDigest: leader.final.resultDigest,
              reusedFromCallId: prior.leaderCallId,
              normalized: cloneValue(leader.final.normalized),
              modelFacing: cloneValue(leader.final.modelFacing),
            },
            trace,
          );
        }
        // Leader failed/timed out/was cancelled: mirror the physical fate.
        return this.finishFast(
          runId,
          auditTool,
          call,
          {
            actualOutcome: leader.final.actualOutcome,
            reportedOutcome: leader.final.reportedOutcome,
            disposition: "none",
            errorCode: leader.final.errorCode,
            resultDigest: null,
            reusedFromCallId: null,
            normalized: null,
            modelFacing: null,
          },
          trace,
        );
      }
    }

    // ---- Steps 5-6: execution + normalization/output validation. ----
    const effectiveTimeoutMs = this.effectiveTimeout(reg, context.timeoutMs);
    const leaderPromise = this.runLeaderCall({
      runId,
      tool: auditTool,
      reg,
      input,
      call,
      origin,
      caller,
      freshness: effectiveFreshness,
      callerSignal: context.signal,
      timeoutMs: effectiveTimeoutMs,
      dedupKey: key,
      trace,
      note,
    });
    // Register the in-flight entry synchronously (no awaits between the
    // dedup lookup above and this write), so concurrent same-fingerprint
    // requests coalesce deterministically.
    let perRun = this.dedup.get(runId);
    if (perRun === undefined) {
      perRun = new Map<string, DedupEntry>();
      this.dedup.set(runId, perRun);
    }
    perRun.set(key, {
      status: "inflight",
      leaderCallId: call.callId,
      promise: leaderPromise,
    });
    const settlement = await leaderPromise;
    return this.finalizeResult(auditTool, call, settlement.final, trace);
  }

  /* ------------------------------------------------------------ */
  /* Pipeline stages                                               */
  /* ------------------------------------------------------------ */

  /** Single-statement CAS increment; never passes the cap. */
  private reserveBudget(runId: string): boolean {
    const moved = this.db
      .prepare(
        "UPDATE runs SET tool_requests_used = tool_requests_used + 1 WHERE id = ? AND tool_requests_used < ?",
      )
      .run(runId, this.budgets.maxToolRequestsPerRun);
    if (moved.changes === 1) {
      return true;
    }
    const row = this.db
      .prepare("SELECT id FROM runs WHERE id = ?")
      .get(runId) as { id: string } | undefined;
    if (row === undefined) {
      throw new RepositoryNotFoundError(`run ${runId} not found`);
    }
    return false;
  }

  private insertCallRow(
    runId: string,
    tool: string,
    argsHash: string,
  ): CallRef {
    // Synchronous SELECT MAX + INSERT with no awaits: single-thread atomic.
    const now = this.clock.now();
    const current = this.db
      .prepare(
        "SELECT COALESCE(MAX(call_index), 0) AS max_index FROM tool_calls WHERE run_id = ?",
      )
      .get(runId) as { max_index: number };
    const callIndex = (current.max_index ?? 0) + 1;
    const callId = generateId();
    this.db
      .prepare(
        "INSERT INTO tool_calls (id, run_id, call_index, lifecycle_status, tool, args_hash, reported_outcome, actual_outcome, result_disposition, reused_from_call_id, error_code, result_digest, requested_at, started_at, reported_at, actual_finished_at, created_at) VALUES (?, ?, ?, 'requested', ?, ?, NULL, NULL, 'none', NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)",
      )
      .run(callId, runId, callIndex, tool, argsHash, now, now);
    return { callId, callIndex };
  }

  private updateArgsHash(callId: string, argsHash: string): void {
    this.db
      .prepare("UPDATE tool_calls SET args_hash = ? WHERE id = ?")
      .run(argsHash, callId);
  }

  private updateRowFinished(callId: string, final: FinalOutcome): void {
    const now = this.clock.now();
    this.db
      .prepare(
        "UPDATE tool_calls SET lifecycle_status = 'finished', reported_outcome = ?, actual_outcome = ?, result_disposition = ?, reused_from_call_id = ?, error_code = ?, result_digest = ?, reported_at = ?, actual_finished_at = ? WHERE id = ?",
      )
      .run(
        final.reportedOutcome,
        final.actualOutcome,
        final.disposition,
        final.reusedFromCallId,
        final.errorCode,
        final.resultDigest,
        now,
        now,
        callId,
      );
  }

  private appendRequested(
    runId: string,
    tool: string,
    call: CallRef,
    argsHash: string,
  ): void {
    // Requested events require confirmed running eligibility: queued /
    // cancel_requested / terminal beginnings (and lost running races)
    // audit with no RunEvents. While the run is still running, the
    // requested event is durable-or-reject: a persistence failure
    // propagates so classification/execution can never occur without it.
    if (!this.isRunning(runId)) {
      return;
    }
    try {
      this.repo.appendToolEvent(runId, "tool.requested", {
        callId: call.callId,
        callIndex: call.callIndex,
        tool,
        argsHash,
      });
    } catch (error) {
      // Lost running race (now terminal/non-running): audit-only.
      if (!this.isRunning(runId)) {
        return;
      }
      if (error instanceof KernelStorageError) {
        throw error;
      }
      if (
        error instanceof RepositoryNotFoundError ||
        error instanceof RepositoryValidationError
      ) {
        throw error;
      }
      throw new KernelStorageError(
        "kernel_storage_failed",
        "tool audit commit failed",
      );
    }
  }

  private isTerminal(runId: string): boolean {
    try {
      return isTerminalStatus(this.repo.getRun(runId).status);
    } catch {
      return true;
    }
  }

  private runStatus(runId: string): RunStatus | null {
    try {
      return this.repo.getRun(runId).status;
    } catch {
      return null;
    }
  }

  /** Running-only: only `running` runs may execute or receive output. */
  private isRunning(runId: string): boolean {
    return this.runStatus(runId) === "running";
  }

  /**
   * Atomic final commit: the tool_calls finished update and the
   * tool.completed event commit or roll back together while the run is
   * running. After the run leaves `running` (queued / cancel_requested /
   * terminal, including races observed mid-commit) only the metadata
   * audit update runs and no event is appended. A running storage
   * failure (including exhausted event-seq conflict retries) never
   * falls back to audit-only completion: the row/event changes are
   * rolled back and a fixed KernelStorageError propagates.
   * Raw args/results/errors are never written.
   */
  private commitFinished(
    runId: string,
    tool: string,
    call: CallRef,
    final: FinalOutcome,
  ): void {
    if (!this.isRunning(runId)) {
      this.updateRowFinished(call.callId, final);
      return;
    }
    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch {
        // Cannot begin (busy); fall through to terminal check / retry.
        if (this.isTerminal(runId)) {
          this.updateRowFinished(call.callId, final);
          return;
        }
        continue;
      }
      let committed = false;
      try {
        const row = this.db
          .prepare("SELECT status, event_seq FROM runs WHERE id = ?")
          .get(runId) as { status: string; event_seq: number } | undefined;
        if (row === undefined) {
          throw new RepositoryNotFoundError(`run ${runId} not found`);
        }
        if (row.status !== "running") {
          this.db.exec("ROLLBACK");
          this.updateRowFinished(call.callId, final);
          return;
        }
        const now = this.clock.now();
        this.db
          .prepare(
            "UPDATE tool_calls SET lifecycle_status = 'finished', reported_outcome = ?, actual_outcome = ?, result_disposition = ?, reused_from_call_id = ?, error_code = ?, result_digest = ?, reported_at = ?, actual_finished_at = ? WHERE id = ?",
          )
          .run(
            final.reportedOutcome,
            final.actualOutcome,
            final.disposition,
            final.reusedFromCallId,
            final.errorCode,
            final.resultDigest,
            now,
            now,
            call.callId,
          );
        const payload = parseRunEventPayload("tool.completed", {
          callId: call.callId,
          callIndex: call.callIndex,
          tool,
          actualOutcome: final.actualOutcome,
          reportedOutcome: final.reportedOutcome,
          disposition: final.disposition,
          errorCode: final.errorCode,
          resultDigest: final.resultDigest,
          reusedFromCallId: final.reusedFromCallId,
        });
        const next = row.event_seq + 1;
        const moved = this.db
          .prepare(
            "UPDATE runs SET event_seq = ? WHERE id = ? AND event_seq = ?",
          )
          .run(next, runId, row.event_seq);
        if (moved.changes !== 1) {
          throw new KernelStorageError(
            "kernel_concurrent_conflict",
            "concurrent event append conflict; retry the transition",
          );
        }
        this.db
          .prepare(
            "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            runId,
            next,
            RUN_EVENT_SCHEMA_VERSION,
            "tool.completed",
            JSON.stringify(payload),
            now,
          );
        this.db.exec("COMMIT");
        committed = true;
        return;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Best effort; the original error carries the failure.
        }
        // Non-running observed after rollback: audit-only late update only.
        if (!this.isRunning(runId)) {
          this.updateRowFinished(call.callId, final);
          return;
        }
        if (
          error instanceof KernelStorageError &&
          error.code === "kernel_concurrent_conflict"
        ) {
          lastConflict = error;
          if (attempt < 4) {
            continue;
          }
          throw error;
        }
        if (error instanceof KernelStorageError) {
          throw error;
        }
        if (
          error instanceof RepositoryNotFoundError ||
          error instanceof RepositoryValidationError
        ) {
          throw error;
        }
        // Nonterminal storage failure: row/event rolled back, no
        // audit-only fallback; propagate a fixed storage failure.
        throw new KernelStorageError(
          "kernel_storage_failed",
          "tool audit commit failed",
        );
      } finally {
        if (!committed) {
          try {
            if (
              (this.db as unknown as { inTransaction?: boolean })
                .inTransaction === true
            ) {
              this.db.exec("ROLLBACK");
            }
          } catch {
            // Best effort.
          }
        }
      }
    }
    // Bounded retries exhausted while still nonterminal: propagate a
    // fixed conflict failure with row/event rolled back.
    if (!this.isRunning(runId)) {
      this.updateRowFinished(call.callId, final);
      return;
    }
    if (lastConflict instanceof KernelStorageError) {
      throw lastConflict;
    }
    throw new KernelStorageError(
      "kernel_concurrent_conflict",
      "concurrent event append conflict; retry the transition",
    );
  }

  private effectiveTimeout(
    reg: ToolRegistration,
    requested: number | undefined,
  ): number {
    const descriptorDefault =
      reg.descriptor.defaultTimeoutMs ?? this.budgets.defaultTimeoutMs;
    const descriptorMax =
      reg.descriptor.maxTimeoutMs ?? this.budgets.maxTimeoutMs;
    const wanted = requested ?? descriptorDefault;
    return Math.max(
      1,
      Math.min(wanted, descriptorMax, this.budgets.maxTimeoutMs),
    );
  }

  private awaitLeader(
    promise: Promise<LeaderSettlement>,
    signal: AbortSignal | undefined,
    timeoutMs?: number,
  ): Promise<
    | { kind: "settled"; settlement: LeaderSettlement }
    | { kind: "aborted" }
    | { kind: "timeout" }
  > {
    if (signal === undefined && timeoutMs === undefined) {
      return promise.then(
        (settlement) => ({ kind: "settled" as const, settlement }),
        () => ({ kind: "aborted" as const }),
      );
    }
    if (signal?.aborted === true) {
      return Promise.resolve({ kind: "aborted" as const });
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (
        value:
          | { kind: "settled"; settlement: LeaderSettlement }
          | { kind: "aborted" }
          | { kind: "timeout" },
      ): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish({ kind: "aborted" });
      const onTimeout = (): void => finish({ kind: "timeout" });
      if (timeoutMs !== undefined) {
        timer = setTimeout(onTimeout, Math.max(1, timeoutMs));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (settlement) => {
          finish({ kind: "settled", settlement });
        },
        () => {
          finish({ kind: "aborted" });
        },
      );
    });
  }

  /** Leader task: physical execution, settlement, cache, and audit. */
  private async runLeaderCall(args: {
    runId: string;
    tool: string;
    reg: ToolRegistration;
    input: unknown;
    call: CallRef;
    origin: string;
    caller: string;
    freshness: ToolFreshness;
    callerSignal: AbortSignal | undefined;
    timeoutMs: number;
    dedupKey: string;
    trace: PipelineStep[];
    note: (step: PipelineStep) => void;
  }): Promise<LeaderSettlement> {
    const physical = await this.executePhysical(args);
    const { runId, tool, call, dedupKey } = args;

    if (physical.kind === "failed") {
      // A failed in-flight entry must not poison the cache: any freshness
      // drops our entry so a later separately requested logical call may
      // execute anew. This never retries the original call.
      const perRun = this.dedup.get(runId);
      const current = perRun?.get(dedupKey);
      if (
        current !== undefined &&
        current.status === "inflight" &&
        current.leaderCallId === call.callId
      ) {
        perRun?.delete(dedupKey);
      }
      args.note("audit");
      this.commitFinished(runId, tool, call, physical.final);
      return { accepted: false, final: physical.final };
    }

    const pending = physical.pending;
    // Non-running landing: the handler produced a value the run can no
    // longer use. Preserve the report, mark discarded, emit no event when
    // terminal (audit-only) and no delivery when queued/cancel_requested.
    // The in-flight entry is dropped so later running calls may execute.
    if (!this.isRunning(runId)) {
      const final: FinalOutcome = {
        actualOutcome: "cancelled",
        reportedOutcome: "succeeded",
        disposition: "discarded",
        errorCode: "execution_cancelled",
        resultDigest: pending.resultDigest,
        reusedFromCallId: null,
        normalized: null,
        modelFacing: null,
      };
      const perRun = this.dedup.get(runId);
      const current = perRun?.get(dedupKey);
      if (
        current !== undefined &&
        current.status === "inflight" &&
        current.leaderCallId === call.callId
      ) {
        perRun?.delete(dedupKey);
      }
      args.note("audit");
      this.commitFinished(runId, tool, call, final);
      return { accepted: false, final };
    }

    // Cumulative reservation is a single synchronous check-and-add.
    const reservation = this.reserveCumulative(
      runId,
      pending.modelBytes,
      pending.observations,
    );
    if (reservation !== "ok") {
      const final =
        reservation === "model"
          ? outputTooLargeOutcome("succeeded", pending.resultDigest)
          : outputInvalidOutcome("succeeded", pending.resultDigest);
      const perRun = this.dedup.get(runId);
      const current = perRun?.get(dedupKey);
      if (
        current !== undefined &&
        current.status === "inflight" &&
        current.leaderCallId === call.callId
      ) {
        perRun?.delete(dedupKey);
      }
      args.note("audit");
      this.commitFinished(runId, tool, call, final);
      return { accepted: false, final };
    }

    const final: FinalOutcome = {
      actualOutcome: "succeeded",
      reportedOutcome: "succeeded",
      disposition: "accepted",
      errorCode: null,
      resultDigest: pending.resultDigest,
      reusedFromCallId: null,
      normalized: cloneValue(pending.normalized),
      modelFacing: cloneValue(pending.modelFacing),
      modelBytesForBudget: pending.modelBytes,
      observationsForBudget: pending.observations,
    };
    // Publish the dedup entry only after the durable audit commit succeeds:
    // a failed commit must not leave reusable cache behind. commitFinished
    // throws on running storage failure, so the publish below runs only on
    // success; on throw the in-flight entry is dropped for hygiene.
    args.note("audit");
    try {
      this.commitFinished(runId, tool, call, final);
    } catch (error) {
      const perRun = this.dedup.get(runId);
      const current = perRun?.get(dedupKey);
      if (
        current !== undefined &&
        current.status === "inflight" &&
        current.leaderCallId === call.callId
      ) {
        perRun?.delete(dedupKey);
      }
      throw error;
    }
    const perRun = this.dedup.get(runId);
    const current = perRun?.get(dedupKey);
    if (
      current !== undefined &&
      current.status === "inflight" &&
      current.leaderCallId === call.callId
    ) {
      perRun?.set(dedupKey, {
        status: "done",
        leaderCallId: call.callId,
        normalized: cloneValue(pending.normalized),
        modelFacing: cloneValue(pending.modelFacing),
        modelBytes: pending.modelBytes,
        observations: pending.observations,
        resultDigest: pending.resultDigest,
      });
    }
    return { accepted: true, final };
  }

  /** Steps 5-6: bounded execution plus strict output validation. */
  private async executePhysical(args: {
    runId: string;
    tool: string;
    reg: ToolRegistration;
    input: unknown;
    call: CallRef;
    origin: string;
    caller: string;
    freshness: ToolFreshness;
    callerSignal: AbortSignal | undefined;
    timeoutMs: number;
    trace: PipelineStep[];
    note: (step: PipelineStep) => void;
  }): Promise<PhysicalSettlement> {
    const { runId, tool, reg, input, call } = args;

    // Running-only check before any physical work: queued /
    // cancel_requested / terminal runs never execute; the
    // late-arrival contract applies instead.
    if (!this.isRunning(runId)) {
      args.note("execute");
      args.note("normalize");
      return { kind: "failed", final: cancelOutcome(null) };
    }

    args.note("execute");
    const callController = new AbortController();
    let abortKind: "timeout" | "cancel" | null = null;
    const onCallerAbort = (): void => {
      if (abortKind === null) {
        abortKind = "cancel";
        callController.abort();
      }
    };
    if (args.callerSignal?.aborted === true) {
      abortKind = "cancel";
      callController.abort();
    } else {
      args.callerSignal?.addEventListener("abort", onCallerAbort, {
        once: true,
      });
    }
    const timer = setTimeout(() => {
      if (abortKind === null) {
        abortKind = "timeout";
        callController.abort();
      }
    }, args.timeoutMs);
    const cleanupTimer = (): void => {
      clearTimeout(timer);
      args.callerSignal?.removeEventListener("abort", onCallerAbort);
    };

    // Bounded physical concurrency: per-run slot first (FIFO preserves
    // caller-visible per-run order), then the process-wide slot. Queued
    // waiters abort on timeout/cancel instead of executing late. The
    // composed deadline covers this queue wait, the handler, and the
    // async normalizer below.
    let perRunSlot = this.perRunSlots.get(runId);
    if (perRunSlot === undefined) {
      perRunSlot = new Slot(this.budgets.maxConcurrentPerRun);
      this.perRunSlots.set(runId, perRunSlot);
    }
    const gotRunSlot = await perRunSlot.acquire(callController.signal);
    if (!gotRunSlot) {
      cleanupTimer();
      args.note("normalize");
      return {
        kind: "failed",
        final: wasTimeout(abortKind) ? timeoutOutcome() : cancelOutcome(null),
      };
    }
    const gotProcessSlot = await this.processSlot.acquire(
      callController.signal,
    );
    if (!gotProcessSlot) {
      perRunSlot.release();
      cleanupTimer();
      args.note("normalize");
      return {
        kind: "failed",
        final: wasTimeout(abortKind) ? timeoutOutcome() : cancelOutcome(null),
      };
    }

    // A run that left `running` while queued must not execute.
    if (!this.isRunning(runId) || callController.signal.aborted) {
      perRunSlot.release();
      this.processSlot.release();
      cleanupTimer();
      args.note("normalize");
      return {
        kind: "failed",
        final: wasTimeout(abortKind) ? timeoutOutcome() : cancelOutcome(null),
      };
    }

    const now = this.clock.now();
    this.db
      .prepare(
        "UPDATE tool_calls SET lifecycle_status = 'running', started_at = ? WHERE id = ?",
      )
      .run(now, call.callId);

    const handlerCtx: ToolHandlerContext = {
      runId,
      callId: call.callId,
      callIndex: call.callIndex,
      tool,
      signal: callController.signal,
      origin: args.origin,
      caller: args.caller,
      freshness: args.freshness,
    };

    let handlerPromise: Promise<unknown>;
    try {
      handlerPromise = Promise.resolve().then(() =>
        reg.handler(input as never, handlerCtx),
      );
    } catch (error) {
      handlerPromise = Promise.reject(error);
    }

    // Detachment: slots stay held until the detached handler settles so
    // physical concurrency caps account for abandoned work. Late handler
    // reports are attached only on the detached path below and only fill
    // an unset reported_outcome as discarded (never overwriting a
    // cooperative report), never emitting events.
    let slotsReleased = false;
    const releaseSlots = (): void => {
      if (slotsReleased) return;
      slotsReleased = true;
      perRunSlot.release();
      this.processSlot.release();
    };
    const attachDetachedLateReport = (): void => {
      handlerPromise.then(
        () => {
          try {
            this.lateReport(call.callId, "succeeded", true);
          } finally {
            releaseSlots();
          }
        },
        (error: unknown) => {
          try {
            const mapped = mapHandlerError(error);
            this.lateReport(
              call.callId,
              mapped.cancelLike ? "cancelled" : "failed",
              true,
            );
          } finally {
            releaseSlots();
          }
        },
      );
    };

    const raced = await Promise.race<{
      settled: boolean;
      value?: unknown;
      error?: unknown;
    }>([
      handlerPromise.then(
        (value) => ({ settled: true as const, value }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      new Promise<{ settled: boolean }>((resolve) => {
        if (callController.signal.aborted) {
          resolve({ settled: false });
        } else {
          callController.signal.addEventListener(
            "abort",
            () => resolve({ settled: false }),
            {
              once: true,
            },
          );
        }
      }),
    ]);

    if (!raced.settled || callController.signal.aborted) {
      args.note("normalize");
      // Detached: keep slots until the handler settles; the timer itself
      // can be cleared. Normalize is skipped entirely.
      attachDetachedLateReport();
      cleanupTimer();
      return {
        kind: "failed",
        final: wasTimeout(abortKind) ? timeoutOutcome() : cancelOutcome(null),
      };
    }

    if ("error" in raced) {
      const mapped = mapHandlerError(raced.error);
      args.note("normalize");
      cleanupTimer();
      releaseSlots();
      if (mapped.cancelLike) {
        return { kind: "failed", final: cancelOutcome("cancelled") };
      }
      return {
        kind: "failed",
        final: {
          actualOutcome: "failed",
          reportedOutcome: "failed",
          disposition: "none",
          errorCode: mapped.code,
          resultDigest: null,
          reusedFromCallId: null,
          normalized: null,
          modelFacing: null,
        },
      };
    }

    // ---- Step 6: normalization + strict output validation, still under
    // the composed timeout/cancel deadline. A non-cooperative async
    // normalizer is detached: the broker returns timeout/cancel without
    // waiting for it, but slots stay held until it settles. The handler
    // had produced a value, so the detached settlement preserves
    // reported `succeeded` with disposition `discarded`.
    args.note("normalize");
    const raw = raced.value;
    let normalizedOutput: NormalizedToolOutput;
    try {
      const normalizer = reg.normalize ?? defaultNormalizer;
      const normalizerPromise: Promise<NormalizedToolOutput> =
        Promise.resolve().then(() => normalizer(raw, { input }));
      const normRaced = await Promise.race<{
        settled: boolean;
        value?: NormalizedToolOutput;
      }>([
        normalizerPromise.then(
          (value) => ({ settled: true as const, value }),
          () => ({ settled: true as const }),
        ),
        new Promise<{ settled: boolean }>((resolve) => {
          if (callController.signal.aborted) {
            resolve({ settled: false });
          } else {
            callController.signal.addEventListener(
              "abort",
              () => resolve({ settled: false }),
              { once: true },
            );
          }
        }),
      ]);
      if (!normRaced.settled || callController.signal.aborted) {
        // Detached normalizer: hold slots until it settles (no audit
        // write; the call already settled as timeout/cancel).
        void normalizerPromise.then(
          () => releaseSlots(),
          () => releaseSlots(),
        );
        cleanupTimer();
        if (wasTimeout(abortKind)) {
          return {
            kind: "failed",
            final: {
              actualOutcome: "timed_out",
              reportedOutcome: "succeeded",
              disposition: "discarded",
              errorCode: "execution_timeout",
              resultDigest: null,
              reusedFromCallId: null,
              normalized: null,
              modelFacing: null,
            },
          };
        }
        return {
          kind: "failed",
          final: {
            actualOutcome: "cancelled",
            reportedOutcome: "succeeded",
            disposition: "discarded",
            errorCode: "execution_cancelled",
            resultDigest: null,
            reusedFromCallId: null,
            normalized: null,
            modelFacing: null,
          },
        };
      }
      if (normRaced.value === undefined) {
        throw new Error("normalizer rejected");
      }
      normalizedOutput = normRaced.value;
    } catch {
      cleanupTimer();
      releaseSlots();
      return {
        kind: "failed",
        final: {
          actualOutcome: "failed",
          reportedOutcome: "succeeded",
          disposition: "none",
          errorCode: "output_invalid",
          resultDigest: null,
          reusedFromCallId: null,
          normalized: null,
          modelFacing: null,
        },
      };
    }
    // Abort that fired during normalization wins over a delivered value,
    // but the handler had succeeded: preserve reported `succeeded`.
    if (callController.signal.aborted) {
      cleanupTimer();
      releaseSlots();
      if (wasTimeout(abortKind)) {
        return {
          kind: "failed",
          final: {
            actualOutcome: "timed_out",
            reportedOutcome: "succeeded",
            disposition: "discarded",
            errorCode: "execution_timeout",
            resultDigest: null,
            reusedFromCallId: null,
            normalized: null,
            modelFacing: null,
          },
        };
      }
      return {
        kind: "failed",
        final: {
          actualOutcome: "cancelled",
          reportedOutcome: "succeeded",
          disposition: "discarded",
          errorCode: "execution_cancelled",
          resultDigest: null,
          reusedFromCallId: null,
          normalized: null,
          modelFacing: null,
        },
      };
    }
    cleanupTimer();
    if (
      !Number.isInteger(normalizedOutput.observations) ||
      (normalizedOutput.observations as number) < 0
    ) {
      releaseSlots();
      return { kind: "failed", final: outputInvalidOutcome("succeeded", null) };
    }
    let parsedNormalized: unknown;
    try {
      parsedNormalized = reg.outputSchema.parse(normalizedOutput.normalized);
    } catch {
      releaseSlots();
      return {
        kind: "failed",
        final: outputInvalidOutcome(
          "succeeded",
          digestOf(normalizedOutput.normalized),
        ),
      };
    }
    normalizedOutput = {
      normalized: parsedNormalized,
      observations: normalizedOutput.observations,
      modelFacing: normalizedOutput.modelFacing,
    };
    let canonicalNormalized: string;
    let canonicalModel: string;
    try {
      canonicalNormalized = canonicalJsonString(normalizedOutput.normalized);
      canonicalModel = canonicalJsonString(normalizedOutput.modelFacing);
    } catch {
      releaseSlots();
      return { kind: "failed", final: outputInvalidOutcome("succeeded", null) };
    }
    const normalizedBytes = byteLengthUtf8(canonicalNormalized);
    const modelBytes = byteLengthUtf8(canonicalModel);
    const digest = sha256Hex(canonicalNormalized);
    if (normalizedBytes > this.budgets.maxNormalizedOutputBytesPerCall) {
      releaseSlots();
      return {
        kind: "failed",
        final: outputTooLargeOutcome("succeeded", digest),
      };
    }
    if (modelBytes > this.budgets.maxModelFacingOutputBytesPerCall) {
      releaseSlots();
      return {
        kind: "failed",
        final: outputTooLargeOutcome("succeeded", digest),
      };
    }
    if (normalizedOutput.observations > this.budgets.maxObservationsPerCall) {
      releaseSlots();
      return {
        kind: "failed",
        final: outputInvalidOutcome("succeeded", digest),
      };
    }
    releaseSlots();
    return {
      kind: "pending",
      pending: {
        normalized: cloneValue(normalizedOutput.normalized),
        modelFacing: cloneValue(normalizedOutput.modelFacing),
        observations: normalizedOutput.observations,
        modelBytes,
        resultDigest: digest,
      },
    };
  }

  /** Single synchronous check-and-add for the per-run cumulative budgets. */
  private reserveCumulative(
    runId: string,
    modelBytes: number,
    observations: number,
  ): "ok" | "model" | "observations" {
    const current = this.cumulative.get(runId) ?? {
      modelBytes: 0,
      observations: 0,
    };
    if (
      current.modelBytes + modelBytes >
      this.budgets.maxModelFacingOutputBytesPerRun
    ) {
      return "model";
    }
    if (
      current.observations + observations >
      this.budgets.maxObservationsPerRun
    ) {
      return "observations";
    }
    this.cumulative.set(runId, {
      modelBytes: current.modelBytes + modelBytes,
      observations: current.observations + observations,
    });
    return "ok";
  }

  private lateReport(
    callId: string,
    reported: ReportedOutcome,
    discarded: boolean,
  ): void {
    try {
      const now = this.clock.now();
      if (discarded) {
        // Never overwrite a cooperative report: fill only unset rows.
        this.db
          .prepare(
            "UPDATE tool_calls SET reported_outcome = ?, reported_at = ?, result_disposition = 'discarded' WHERE id = ? AND reported_outcome IS NULL",
          )
          .run(reported, now, callId);
      } else {
        this.db
          .prepare(
            "UPDATE tool_calls SET reported_outcome = ?, reported_at = ? WHERE id = ? AND reported_outcome IS NULL",
          )
          .run(reported, now, callId);
      }
    } catch {
      // Audit-only best effort; never throws into handler continuations.
    }
  }

  /** Fast-path finalization (no physical work): audit row + event + result. */
  private finishFast(
    runId: string,
    tool: string,
    call: CallRef,
    final: FinalOutcome,
    trace: PipelineStep[],
  ): BrokerCallResult {
    trace.push("audit");
    this.onStep?.("audit", { runId, tool, callIndex: call.callIndex });
    this.commitFinished(runId, tool, call, final);
    return this.finalizeResult(tool, call, final, trace);
  }

  /**
   * Audit-only finalization for begun-non-running invocations
   * (queued / cancel_requested / terminal): reserves/audits with no
   * RunEvents. Used only for the initial running-eligibility gate;
   * terminal races inside commitFinished remain the only other
   * audit-only path.
   */
  private finishFastAuditOnly(
    runId: string,
    tool: string,
    call: CallRef,
    final: FinalOutcome,
    trace: PipelineStep[],
  ): BrokerCallResult {
    trace.push("audit");
    this.onStep?.("audit", { runId, tool, callIndex: call.callIndex });
    this.updateRowFinished(call.callId, final);
    return this.finalizeResult(tool, call, final, trace);
  }

  private finalizeResult(
    tool: string,
    call: CallRef,
    final: FinalOutcome,
    trace: PipelineStep[],
  ): BrokerCallResult {
    const result = ToolResultSchema.parse({
      tool,
      callIndex: call.callIndex,
      actualOutcome: final.actualOutcome,
      reportedOutcome: final.reportedOutcome,
      disposition: final.disposition,
      errorCode: final.errorCode,
      resultDigest: final.resultDigest,
      reusedFromCallId: final.reusedFromCallId,
      finishedAt: this.clock.now(),
    });
    return {
      result,
      normalized:
        final.normalized === null ? null : cloneValue(final.normalized),
      modelFacing:
        final.modelFacing === null ? null : cloneValue(final.modelFacing),
      pipeline: [...trace],
    };
  }
}

/**
 * Factory: build a ToolBroker with a static finalized registry.
 * No M1+ tools are registered here; callers supply M0 read tools only.
 */
export function createToolBroker(options: ToolBrokerOptions): ToolBroker {
  return new ToolBroker(options);
}
