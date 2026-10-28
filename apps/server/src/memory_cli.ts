// Conversation-memory remind CLI client (I02 async local adapter).
//
// Ownership: this module is the SOLE boundary that spawns the remind CLI.
// The CLI is always spawned with `shell: false` and exactly
// `[entry, --config, config]` plus one LF-framed JSON line on stdin. No
// shell, no argument interpolation, no lookup: `executable`, `entry`, and
// `config` are absolute paths from the frozen trusted startup config only.
//
// Protocol (matches remind M1 CLI):
// - stdin: exactly one JSON line (`JSON.stringify(request) + "\n"`),
//   pre-capped at RAW_MAX_BYTES (32768) before spawn.
// - stdout: exactly one LF-terminated JSON envelope
//   `{ v: 1, ok, code, message, data, deduplicated }`. The client validates
//   exact JSON/LF bytes: UTF-8 fatal decode, a single trailing LF, no
//   embedded LF, byte cap `maxResponseBytes`, strict envelope shape, closed
//   code set. stderr is captured (bounded) but never parsed as protocol.
// - Every call is bounded by `timeoutMs` with a hard SIGKILL afterwards and
//   an awaited termination wait: no orphaned child survives a call.
// - Crash/unknown-outcome replay reuses the caller's stable idempotency key;
//   this client never mints keys and never retries (retry is the durable
//   outbox owner's decision).
//
// Failures throw `MemoryCliError` with a fixed `cliCode` only
// (`cli_unavailable`, `cli_timeout`, `cli_malformed`, `cli_limit`,
// `cli_version_mismatch`, `cli_bad_request`). No paths, no scopes, no
// request/response bodies, and
// no raw error text ever escape in the error or in logs (this module logs
// nothing at all; the service logs fixed codes plus numeric sizes only).
// Companion never opens the remind DB directly: this client is the only
// interface.

import { spawn } from "node:child_process";

/**
 * Companion-side memory protocol version (F-I01-01). Sent with every
 * request and required on every response envelope. Additive evolution
 * keeps this version; a mismatch means breaking (major) changes, which
 * the recall path treats like memory being disabled (F-I01-07).
 */
export const MEMORY_PROTOCOL_VERSION = 1;
/** Fixed remind BAD_REQUEST text for an unsupported numeric version. */
const UNSUPPORTED_PROTOCOL_VERSION_MESSAGE = "unsupported protocol version";

/** Max raw stdin request size in UTF-8 bytes (remind protocol fixed cap). */
export const MEMORY_CLI_RAW_MAX_BYTES = 32768;
/** Cap for captured stderr bytes (diagnostic only, never protocol). */
export const MEMORY_CLI_STDERR_MAX_BYTES = 65536;

/** Closed remind CLI envelope codes (protocol MESSAGES + OK). */
const CLI_ENVELOPE_CODES: ReadonlySet<string> = new Set([
  "OK",
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN_SCOPE",
  "STORE_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "TIMEOUT",
]);

/** Ops this client will send (no perception/export/deletion surface). */
const ALLOWED_OPS: ReadonlySet<string> = new Set([
  "event.append",
  "record.remember",
  "record.recall",
  "record.feedback",
  "maintain.distill",
  // Derived association + topic maintenance (additive remind ops).
  "maintain.associate",
  // Derived consolidation + preview-only activation (remind >=795c476).
  "maintain.consolidate",
  "maintain.activation",
  "topic.set",
  "topic.pending",
  "record.search",
  "record.get",
  // Read-only bounded listing for the memory content stats panel.
  "record.list",
  "record.correct",
  "record.retire",
  "record.reactivate",
  // Read-only graph ops (session-scoped, never write, never heat).
  "graph.local",
  "graph.page",
  "graph.version",
]);

/** Write ops require a caller-supplied stable idempotency key. */
const WRITE_OPS: ReadonlySet<string> = new Set([
  "event.append",
  "record.remember",
  "record.feedback",
  "maintain.distill",
  "maintain.associate",
  // Derived consolidation + preview-only activation (remind >=795c476).
  "maintain.consolidate",
  "maintain.activation",
  "topic.set",
  "record.correct",
  "record.retire",
  "record.reactivate",
]);

/** Fixed client-side failure codes (never carry values). */
export type MemoryCliFailureCode =
  | "cli_unavailable"
  | "cli_timeout"
  | "cli_malformed"
  | "cli_version_mismatch"
  | "cli_limit"
  | "cli_bad_request";

export class MemoryCliError extends Error {
  readonly cliCode: MemoryCliFailureCode;

  constructor(cliCode: MemoryCliFailureCode) {
    super(cliCode);
    this.name = "MemoryCliError";
    this.cliCode = cliCode;
  }
}

/** Frozen per-call CLI addressing (subset of the trusted MemoryConfig). */
export interface MemoryCliAddress {
  readonly executable: string;
  readonly entry: string;
  readonly config: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface MemoryCliCallOptions {
  /** Per-call deadline override (distill uses the long budget). */
  readonly timeoutMs?: number;
  /** Cooperative abort (foreground preemption / shutdown). */
  readonly signal?: AbortSignal;
}

/** Validated remind response envelope (data stays opaque to the client). */
export interface MemoryCliEnvelope {
  readonly ok: boolean;
  readonly code: string;
  readonly data: Record<string, unknown> | null;
  readonly deduplicated: boolean;
}

function fail(code: MemoryCliFailureCode): MemoryCliError {
  return new MemoryCliError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one CLI call's addressing + op/params shape before spawn.
 * Rejects unknown ops, missing write-op keys, and non-object params with
 * fixed codes (no values escape).
 */
function validateCall(
  address: MemoryCliAddress,
  op: string,
  params: unknown,
  idempotencyKey: string | undefined,
): void {
  if (
    typeof address.executable !== "string" ||
    typeof address.entry !== "string" ||
    typeof address.config !== "string" ||
    address.executable.length === 0 ||
    address.entry.length === 0 ||
    address.config.length === 0
  ) {
    throw fail("cli_unavailable");
  }
  if (!ALLOWED_OPS.has(op)) {
    throw fail("cli_bad_request");
  }
  if (!isPlainObject(params)) {
    throw fail("cli_bad_request");
  }
  if (WRITE_OPS.has(op)) {
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)
    ) {
      throw fail("cli_bad_request");
    }
  } else if (idempotencyKey !== undefined) {
    throw fail("cli_bad_request");
  }
  if (
    !Number.isInteger(address.timeoutMs) ||
    !Number.isInteger(address.maxResponseBytes)
  ) {
    throw fail("cli_unavailable");
  }
}

/**
 * Strict stdout validation: fatal UTF-8 decode, exactly one LF-terminated
 * line within `maxBytes`, no embedded LF, strict envelope shape, closed
 * code set. Anything else is `cli_malformed` (fixed code, no echo).
 */
export function parseMemoryCliStdout(
  stdout: Buffer,
  maxBytes: number,
): MemoryCliEnvelope {
  if (stdout.length === 0 || stdout.length > maxBytes) {
    throw fail(stdout.length === 0 ? "cli_malformed" : "cli_limit");
  }
  if (stdout[stdout.length - 1] !== 0x0a) {
    throw fail("cli_malformed");
  }
  const body = stdout.subarray(0, stdout.length - 1);
  if (body.includes(0x0a)) {
    throw fail("cli_malformed");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw fail("cli_malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("cli_malformed");
  }
  if (!isPlainObject(parsed)) {
    throw fail("cli_malformed");
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (
      key !== "v" &&
      key !== "ok" &&
      key !== "code" &&
      key !== "message" &&
      key !== "data" &&
      key !== "deduplicated"
    ) {
      throw fail("cli_malformed");
    }
  }
  // Protocol-version mismatch is a distinct failure (F-I01-01 additive
  // compatibility: breaking changes bump the version). A numeric response
  // version other than the one this client speaks is a mismatch, never
  // generic malformed shape; a non-numeric/missing v stays cli_malformed.
  if (typeof parsed.v === "number" && parsed.v !== MEMORY_PROTOCOL_VERSION) {
    throw fail("cli_version_mismatch");
  }
  // A well-formed rejection naming the fixed unsupported-version message is
  // the version-mismatch answer (fixed string only; the value never
  // escapes this module).
  if (
    parsed.ok === false &&
    parsed.code === "BAD_REQUEST" &&
    parsed.message === UNSUPPORTED_PROTOCOL_VERSION_MESSAGE
  ) {
    throw fail("cli_version_mismatch");
  }
  if (
    parsed.v !== MEMORY_PROTOCOL_VERSION ||
    typeof parsed.ok !== "boolean" ||
    typeof parsed.code !== "string" ||
    !CLI_ENVELOPE_CODES.has(parsed.code) ||
    typeof parsed.message !== "string" ||
    typeof parsed.deduplicated !== "boolean"
  ) {
    throw fail("cli_malformed");
  }
  const data = parsed.data;
  if (data !== null && !isPlainObject(data)) {
    throw fail("cli_malformed");
  }
  return {
    ok: parsed.ok,
    code: parsed.code,
    data,
    deduplicated: parsed.deduplicated,
  };
}

/**
 * One bounded remind CLI call. Async spawn only (never blocks the server
 * event loop beyond the awaited child). Resolves with the validated
 * envelope for every well-formed CLI answer (including `ok: false` domain
 * codes: NOT_FOUND/CONFLICT/FORBIDDEN_SCOPE/etc. are caller decisions, not
 * transport failures). Throws `MemoryCliError` on transport failures only:
 * spawn failure, non-zero exit without stdout, timeout kill, over-cap or
 * malformed stdout.
 */
export async function callMemoryCli(
  address: MemoryCliAddress,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  options: MemoryCliCallOptions = {},
): Promise<MemoryCliEnvelope> {
  validateCall(address, op, params, idempotencyKey);
  const timeoutMs = options.timeoutMs ?? address.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw fail("cli_unavailable");
  }
  const request: Record<string, unknown> = {
    v: MEMORY_PROTOCOL_VERSION,
    op,
    params,
  };
  if (idempotencyKey !== undefined) {
    request.idempotencyKey = idempotencyKey;
  }
  const line = `${JSON.stringify(request)}\n`;
  const requestBytes = Buffer.byteLength(line, "utf8");
  if (requestBytes > MEMORY_CLI_RAW_MAX_BYTES) {
    throw fail("cli_limit");
  }
  const maxBytes = address.maxResponseBytes;

  return new Promise<MemoryCliEnvelope>((resolve, reject) => {
    let settled = false;
    const settleOk = (envelope: MemoryCliEnvelope): void => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(envelope);
      }
    };
    const settleFail = (code: MemoryCliFailureCode): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(fail(code));
      }
    };
    let child: ReturnType<typeof spawn>;
    let timedOut = false;
    let abortFired = false;
    /** Recorded stdin failure (EPIPE/write): kill requested, settle on close. */
    let stdinFailure: MemoryCliFailureCode | null = null;
    try {
      // No shell, no lookup, exact argv: [entry, --config, config].
      child = spawn(
        address.executable,
        [address.entry, "--config", address.config],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      settleFail("cli_unavailable");
      return;
    }
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutOver = false;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        timer = undefined;
        // Hard kill on deadline; settle only on close/exit so the reap is
        // awaited and the next drain cannot overlap a killed-but-running child.
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort: exit/close handlers still settle the call.
        }
      },
      Math.max(timeoutMs, 1),
    );
    if (
      timer !== undefined &&
      typeof (timer as unknown as { unref?: unknown }).unref === "function"
    ) {
      (timer as unknown as { unref(): void }).unref();
    }
    const onAbort = (): void => {
      // Abort (preemption/shutdown) kills and settles on close: the child
      // exit is awaited, so a preempted drain cannot overlap the next tick.
      abortFired = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort.
      }
    };
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        abortFired = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
        // Fall through: close/exit settles as cli_timeout after the reap.
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    let spawnFailed = false;
    child.on("error", () => {
      // A deadline/abort kill races spawn errors: the reap settles timeout.
      if (timedOut || abortFired) {
        return;
      }
      // Record only: settlement waits for the `close` reap below, so the
      // caller never finishes (and never overlaps a retry) while the child
      // lifetime is unresolved. The armed timeout below stays the backstop.
      spawnFailed = true;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxBytes) {
        stdoutOver = true;
      }
      if (stdoutChunks.length < 256) {
        stdoutChunks.push(bytes);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded discard: stderr is never protocol data.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > MEMORY_CLI_STDERR_MAX_BYTES) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
      }
    });
    child.on("close", (code) => {
      // Deadline/abort always settle as timeout AFTER the reap, so the next
      // drain cannot overlap a killed-but-running previous child.
      if (timedOut || abortFired || signal?.aborted === true) {
        settleFail("cli_timeout");
        return;
      }
      if (spawnFailed) {
        // The process never existed (or died before stdio): no stdout can
        // be trusted, and the close reap above proves no child survives.
        settleFail("cli_unavailable");
        return;
      }
      if (stdinFailure !== null) {
        // The request never reached the child (EPIPE/write failure): the
        // kill was requested at record time and this close reap proves the
        // child lifetime ended before settling (no orphan overlaps retry).
        settleFail(stdinFailure);
        return;
      }
      if (stdoutOver) {
        settleFail("cli_limit");
        return;
      }
      const stdout = Buffer.concat(stdoutChunks);
      if (stdout.length === 0) {
        // Non-zero exit / no stdout JSON: unavailable, never parsed.
        settleFail(code === 0 ? "cli_malformed" : "cli_unavailable");
        return;
      }
      try {
        settleOk(parseMemoryCliStdout(stdout, maxBytes));
      } catch (error) {
        settleFail(
          error instanceof MemoryCliError ? error.cliCode : "cli_malformed",
        );
      }
    });
    // Async stdin failures (EPIPE when the child exits early) never throw
    // synchronously: observe them explicitly instead of only try/catch.
    // Record the failure and request termination; settlement waits for the
    // `close` reap (like the timeout/abort paths), while the still-armed
    // timeout above stays the backstop if the reap never arrives.
    child.stdin?.on("error", () => {
      if (timedOut || abortFired || stdinFailure !== null) {
        return;
      }
      stdinFailure = "cli_unavailable";
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort: close still settles.
      }
    });
    try {
      child.stdin?.write(line, "utf8");
      child.stdin?.end();
    } catch {
      if (!timedOut && !abortFired && stdinFailure === null) {
        stdinFailure = "cli_unavailable";
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort: close still settles.
        }
      }
    }
  });
}
