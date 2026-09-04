// Bounded redacted server logging (plan §9 blocker 7.9, §12.4, §19.5).
//
// Single layer that strips content: records carry a fixed code plus scalar
// ids/sizes/durations only. Message text, response content, file paths,
// tool/model I/O, secrets, and raw errors are never representable: unknown
// fields are dropped, strings are length-capped, and errors map to codes.

import type { ServerLogLevel } from "./config.js";

const LEVEL_ORDER: Record<ServerLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CODE_PATTERN = /^[a-z0-9_.]{1,128}$/;

/** Whitelisted scalar fields. Nothing else is ever emitted. */
export interface ServerLogFields {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly scope?: string;
  readonly status?: number | string;
  readonly bytes?: number;
  readonly durationMs?: number;
  readonly attempt?: number;
  readonly port?: number;
}

export interface ServerLogRecord extends ServerLogFields {
  readonly ts: number;
  readonly level: ServerLogLevel;
  readonly code: string;
}

export interface ServerLogger {
  readonly level: ServerLogLevel;
  log(level: ServerLogLevel, code: string, fields?: ServerLogFields): void;
  debug(code: string, fields?: ServerLogFields): void;
  info(code: string, fields?: ServerLogFields): void;
  warn(code: string, fields?: ServerLogFields): void;
  error(code: string, fields?: ServerLogFields): void;
}

const MAX_STRING_LENGTH = 128;

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_STRING_LENGTH);
}

function sanitizeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function sanitizeFields(fields: ServerLogFields | undefined): ServerLogFields {
  if (fields === undefined) {
    return {};
  }
  const out: Record<string, string | number> = {};
  const sessionId = sanitizeString(fields.sessionId);
  if (sessionId !== undefined) {
    out.sessionId = sessionId;
  }
  const turnId = sanitizeString(fields.turnId);
  if (turnId !== undefined) {
    out.turnId = turnId;
  }
  const runId = sanitizeString(fields.runId);
  if (runId !== undefined) {
    out.runId = runId;
  }
  const scope = sanitizeString(fields.scope);
  if (scope !== undefined) {
    out.scope = scope;
  }
  if (typeof fields.status === "string") {
    const status = sanitizeString(fields.status);
    if (status !== undefined) {
      out.status = status;
    }
  } else {
    const status = sanitizeNumber(fields.status);
    if (status !== undefined) {
      out.status = status;
    }
  }
  const bytes = sanitizeNumber(fields.bytes);
  if (bytes !== undefined) {
    out.bytes = bytes;
  }
  const durationMs = sanitizeNumber(fields.durationMs);
  if (durationMs !== undefined) {
    out.durationMs = durationMs;
  }
  const attempt = sanitizeNumber(fields.attempt);
  if (attempt !== undefined) {
    out.attempt = attempt;
  }
  const port = sanitizeNumber(fields.port);
  if (port !== undefined) {
    out.port = port;
  }
  return out;
}

export interface LogSink {
  writeStdout(line: string): void;
  writeStderr(line: string): void;
}

export function createServerLogger(
  level: ServerLogLevel,
  sink: LogSink,
  now: () => number = Date.now,
): ServerLogger {
  const emit = (
    logLevel: ServerLogLevel,
    code: string,
    fields?: ServerLogFields,
  ): void => {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) {
      return;
    }
    const safeCode = CODE_PATTERN.test(code) ? code : "log_code_invalid";
    const record: ServerLogRecord = {
      ts: now(),
      level: logLevel,
      code: safeCode,
      ...sanitizeFields(fields),
    };
    const line = `${JSON.stringify(record)}\n`;
    if (logLevel === "warn" || logLevel === "error") {
      sink.writeStderr(line);
    } else {
      sink.writeStdout(line);
    }
  };
  return {
    level,
    log: emit,
    debug: (code, fields) => emit("debug", code, fields),
    info: (code, fields) => emit("info", code, fields),
    warn: (code, fields) => emit("warn", code, fields),
    error: (code, fields) => emit("error", code, fields),
  };
}

export function createStdServerLogger(level: ServerLogLevel): ServerLogger {
  return createServerLogger(level, {
    writeStdout: (line) => process.stdout.write(line),
    writeStderr: (line) => process.stderr.write(line),
  });
}

/** In-memory logger for tests. */
export function createCollectingLogger(level: ServerLogLevel = "debug"): {
  logger: ServerLogger;
  records: ServerLogRecord[];
} {
  const records: ServerLogRecord[] = [];
  const logger = createServerLogger(
    level,
    {
      writeStdout: (line) => {
        records.push(JSON.parse(line) as ServerLogRecord);
      },
      writeStderr: (line) => {
        records.push(JSON.parse(line) as ServerLogRecord);
      },
    },
    () => 1790000000000,
  );
  return { logger, records };
}
