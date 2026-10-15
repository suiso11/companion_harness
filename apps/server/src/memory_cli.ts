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
// `cli_bad_request`). No paths, no scopes, no request/response bodies, and
// no raw error text ever escape in the error or in logs (this module logs
// nothing at all; the service logs fixed codes plus numeric sizes only).
// Companion never opens the remind DB directly: this client is the only
// interface.

import { spawn } from "node:child_process";

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
  "record.search",
  "record.get",
  "record.correct",
  "record.retire",
  "record.reactivate",
]);

/** Write ops require a caller-supplied stable idempotency key. */
const WRITE_OPS: ReadonlySet<string> = new Set([
  "event.append",
  "record.remember",
  "record.feedback",
  "maintain.distill",
  "record.correct",
  "record.retire",
  "record.reactivate",
]);

/** Fixed client-side failure codes (never carry values). */
export type MemoryCliFailureCode =
  | "cli_unavailable"
  | "cli_timeout"
  | "cli_malformed"
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
  if (
    parsed.v !== 1 ||
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
  const request: Record<string, unknown> = { v: 1, op, params };
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
      spawnFailed = true;
      settleFail("cli_unavailable");
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
      if (spawnFailed) {
        return;
      }
      // Deadline/abort always settle as timeout AFTER the reap, so the next
      // drain cannot overlap a killed-but-running previous child.
      if (timedOut || abortFired || signal?.aborted === true) {
        settleFail("cli_timeout");
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
    child.stdin?.on("error", () => {
      if (timedOut || abortFired) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort: close still settles.
      }
      settleFail("cli_unavailable");
    });
    try {
      child.stdin?.write(line, "utf8");
      child.stdin?.end();
    } catch {
      if (!timedOut && !abortFired) {
        settleFail("cli_unavailable");
      }
    }
  });
}
