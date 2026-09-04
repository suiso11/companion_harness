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
  type ReportedOutcome,
  type ResultDisposition,
  TOOL_BUDGET_DEFAULTS,
  type ToolDescriptor,
  ToolDescriptorSchema,
  ToolErrorCodeSchema,
  type ToolResult,
  ToolResultSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { canonicalJsonString, generateId, sha256Hex } from "./canonical.js";
import {
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
    const code = ToolErrorCodeSchema.parse(errorCode);
    super(message ?? code);
    this.name = "ToolError";
    this.errorCode = code;
  }
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
      this.registry.set(descriptor.name, {
        descriptor,
        inputSchema: reg.inputSchema,
        outputSchema: reg.outputSchema,
        handler: reg.handler,
        ...(reg.normalize === undefined ? {} : { normalize: reg.normalize }),
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

    const trace: PipelineStep[] = [];
    const callIndexHolder: { callIndex: number } = { callIndex: 0 };
    const note = (step: PipelineStep): void => {
      trace.push(step);
      this.onStep?.(step, {
        runId,
        tool,
        callIndex: callIndexHolder.callIndex,
      });
    };

    // ---- Step 1: atomic budget reservation (first, always). ----
    note("budget_reserve");
    const arrivalHash = fingerprintRawArgs(tool, args);
    if (!this.reserveBudget(runId)) {
      const call = this.insertCallRow(runId, tool, arrivalHash);
      callIndexHolder.callIndex = call.callIndex;
      return this.finishFast(
        runId,
        tool,
        call,
        {
          actualOutcome: "failed",
          reportedOutcome: null,
          disposition: "none",
          errorCode: "budget_exceeded",
          resultDigest: null,
          reusedFromCallId: null,
          normalized: null,
          modelFacing: null,
        },
        trace,
      );
    }
    const call = this.insertCallRow(runId, tool, arrivalHash);
    callIndexHolder.callIndex = call.callIndex;
    this.appendRequested(runId, tool, call, arrivalHash);

    // ---- Step 2: classification (allowlist + read-only default-deny). ----
    note("classify");
    const reg = this.registry.get(tool);
    if (
      context.allowedTools !== undefined &&
      !context.allowedTools.includes(tool)
    ) {
      return this.finishFast(runId, tool, call, deniedOutcome(), trace);
    }
    if (reg !== undefined && reg.descriptor.category !== "read") {
      return this.finishFast(runId, tool, call, deniedOutcome(), trace);
    }

    // ---- Step 3: descriptor + input validation. ----
    note("validate");
    if (reg === undefined) {
      return this.finishFast(
        runId,
        tool,
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
      return this.finishFast(runId, tool, call, invalidOutcome(), trace);
    }
    let canonicalInput: string;
    try {
      canonicalInput = canonicalJsonString(input);
    } catch {
      return this.finishFast(runId, tool, call, invalidOutcome(), trace);
    }
    if (byteLengthUtf8(canonicalInput) > this.budgets.maxInputBytesPerCall) {
      return this.finishFast(runId, tool, call, invalidOutcome(), trace);
    }
    const argsHash = sha256Hex(canonicalInput);
    this.updateArgsHash(call.callId, argsHash);

    // ---- Step 4: dedup (same run, post-defaults fingerprint). ----
    note("dedup");
    const key = `${tool}:${argsHash}`;
    if (freshness !== "refresh") {
      const prior = this.dedup.get(runId)?.get(key);
      if (prior !== undefined && prior.status === "done") {
        return this.finishFast(
          runId,
          tool,
          call,
          {
            actualOutcome: "deduplicated",
            reportedOutcome: null,
            disposition: "none",
            errorCode: null,
            resultDigest: null,
            reusedFromCallId: prior.leaderCallId,
            normalized: prior.normalized,
            modelFacing: prior.modelFacing,
          },
          trace,
        );
      }
      if (prior !== undefined && prior.status === "inflight") {
        const leader = await this.awaitLeader(prior.promise, context.signal);
        if (leader === null) {
          return this.finishFast(runId, tool, call, cancelOutcome(null), trace);
        }
        if (leader.accepted) {
          return this.finishFast(
            runId,
            tool,
            call,
            {
              actualOutcome: "deduplicated",
              reportedOutcome: null,
              disposition: "none",
              errorCode: null,
              resultDigest: null,
              reusedFromCallId: prior.leaderCallId,
              normalized: leader.final.normalized,
              modelFacing: leader.final.modelFacing,
            },
            trace,
          );
        }
        // Leader failed/timed out/was cancelled: mirror the physical fate.
        return this.finishFast(
          runId,
          tool,
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
      tool,
      reg,
      input,
      call,
      origin,
      caller,
      freshness,
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
    return this.finalizeResult(tool, call, settlement.final, trace);
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
    if (this.isTerminal(runId)) {
      return;
    }
    try {
      this.repo.appendToolEvent(runId, "tool.requested", {
        callId: call.callId,
        callIndex: call.callIndex,
        tool,
        argsHash,
      });
    } catch {
      // A lost terminal race means audit-only from here on.
    }
  }

  private appendCompleted(
    runId: string,
    tool: string,
    call: CallRef,
    final: FinalOutcome,
  ): void {
    if (this.isTerminal(runId)) {
      return;
    }
    try {
      this.repo.appendToolEvent(runId, "tool.completed", {
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
    } catch {
      // A lost terminal race means audit-only from here on.
    }
  }

  private isTerminal(runId: string): boolean {
    try {
      return isTerminalStatus(this.repo.getRun(runId).status);
    } catch {
      return true;
    }
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
  ): Promise<LeaderSettlement | null> {
    if (signal === undefined) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    return new Promise<LeaderSettlement | null>((resolve) => {
      const onAbort = (): void => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(null);
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
      if (args.freshness === "refresh") {
        // A failed refresh must not poison the cache: drop our entry.
        const perRun = this.dedup.get(runId);
        const current = perRun?.get(dedupKey);
        if (
          current !== undefined &&
          current.status === "inflight" &&
          current.leaderCallId === call.callId
        ) {
          perRun?.delete(dedupKey);
        }
      }
      args.note("audit");
      this.updateRowFinished(call.callId, physical.final);
      this.appendCompleted(runId, tool, call, physical.final);
      return { accepted: false, final: physical.final };
    }

    const pending = physical.pending;
    // Terminal landing: the handler produced a value the run can no
    // longer use. Preserve the report, mark discarded, emit no event.
    if (this.isTerminal(runId)) {
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
      args.note("audit");
      this.updateRowFinished(call.callId, final);
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
      args.note("audit");
      this.updateRowFinished(call.callId, final);
      this.appendCompleted(runId, tool, call, final);
      if (args.freshness === "refresh") {
        const perRun = this.dedup.get(runId);
        const current = perRun?.get(dedupKey);
        if (
          current !== undefined &&
          current.status === "inflight" &&
          current.leaderCallId === call.callId
        ) {
          perRun?.delete(dedupKey);
        }
      }
      return { accepted: false, final };
    }

    const final: FinalOutcome = {
      actualOutcome: "succeeded",
      reportedOutcome: "succeeded",
      disposition: "accepted",
      errorCode: null,
      resultDigest: pending.resultDigest,
      reusedFromCallId: null,
      normalized: pending.normalized,
      modelFacing: pending.modelFacing,
    };
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
        normalized: pending.normalized,
        modelFacing: pending.modelFacing,
      });
    }
    args.note("audit");
    this.updateRowFinished(call.callId, final);
    this.appendCompleted(runId, tool, call, final);
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

    // Terminal check before any physical work: never execute for a
    // terminal run; the late-arrival contract applies instead.
    if (this.isTerminal(runId)) {
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
    // waiters abort on timeout/cancel instead of executing late.
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

    // Detachment: a late handler settlement after timeout/cancel only
    // updates the audit row (reported_outcome / discarded), never events.
    handlerPromise.then(
      () => {
        if (abortKind !== null) {
          this.lateReport(call.callId, "succeeded", true);
        }
      },
      (error: unknown) => {
        if (abortKind !== null) {
          const mapped = mapHandlerError(error);
          this.lateReport(
            call.callId,
            mapped.cancelLike ? "cancelled" : "failed",
            false,
          );
        }
      },
    );

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

    perRunSlot.release();
    this.processSlot.release();
    cleanupTimer();

    if (!raced.settled || callController.signal.aborted) {
      args.note("normalize");
      return {
        kind: "failed",
        final: wasTimeout(abortKind) ? timeoutOutcome() : cancelOutcome(null),
      };
    }

    if ("error" in raced) {
      const mapped = mapHandlerError(raced.error);
      args.note("normalize");
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

    // ---- Step 6: normalization + strict output validation. ----
    args.note("normalize");
    const raw = raced.value;
    let normalizedOutput: NormalizedToolOutput;
    try {
      const normalizer = reg.normalize ?? defaultNormalizer;
      normalizedOutput = await normalizer(raw, { input });
    } catch {
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
    if (
      !Number.isInteger(normalizedOutput.observations) ||
      (normalizedOutput.observations as number) < 0
    ) {
      return { kind: "failed", final: outputInvalidOutcome("succeeded", null) };
    }
    try {
      reg.outputSchema.parse(normalizedOutput.normalized);
    } catch {
      return {
        kind: "failed",
        final: outputInvalidOutcome(
          "succeeded",
          digestOf(normalizedOutput.normalized),
        ),
      };
    }
    let canonicalNormalized: string;
    let canonicalModel: string;
    try {
      canonicalNormalized = canonicalJsonString(normalizedOutput.normalized);
      canonicalModel = canonicalJsonString(normalizedOutput.modelFacing);
    } catch {
      return { kind: "failed", final: outputInvalidOutcome("succeeded", null) };
    }
    const normalizedBytes = byteLengthUtf8(canonicalNormalized);
    const modelBytes = byteLengthUtf8(canonicalModel);
    const digest = sha256Hex(canonicalNormalized);
    if (normalizedBytes > this.budgets.maxNormalizedOutputBytesPerCall) {
      return {
        kind: "failed",
        final: outputTooLargeOutcome("succeeded", digest),
      };
    }
    if (modelBytes > this.budgets.maxModelFacingOutputBytesPerCall) {
      return {
        kind: "failed",
        final: outputTooLargeOutcome("succeeded", digest),
      };
    }
    if (normalizedOutput.observations > this.budgets.maxObservationsPerCall) {
      return {
        kind: "failed",
        final: outputInvalidOutcome("succeeded", digest),
      };
    }
    return {
      kind: "pending",
      pending: {
        normalized: normalizedOutput.normalized,
        modelFacing: normalizedOutput.modelFacing,
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
        this.db
          .prepare(
            "UPDATE tool_calls SET reported_outcome = ?, reported_at = ?, result_disposition = 'discarded' WHERE id = ?",
          )
          .run(reported, now, callId);
      } else {
        this.db
          .prepare(
            "UPDATE tool_calls SET reported_outcome = ?, reported_at = ? WHERE id = ?",
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
    this.updateRowFinished(call.callId, final);
    this.appendCompleted(runId, tool, call, final);
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
      normalized: final.normalized,
      modelFacing: final.modelFacing,
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
