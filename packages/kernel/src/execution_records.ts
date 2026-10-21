// Opt-in private local execution records.
//
// This store is DELIBERATELY separate from the metadata-only public audit
// (run_events / model_calls / tool_calls), SSE/history, and conversation
// memory. When explicitly configured, it captures the actual model requests,
// tool inputs/outputs, raw provider response bodies (when the boundary can
// read them), timings, and outcomes needed to debug a local run.
//
// Security properties:
// - The root is an explicit absolute host path (never model-controlled).
// - EVERY ancestor from the filesystem root down to the target is checked
//   with lstat and symlinks/non-directories are refused — not only the
//   deepest existing component. Run ids are hashed before becoming a path
//   segment, so a hostile run id cannot escape.
// - Files are created with mode 0600 and directories 0700 (POSIX). Only
//   directories created by this store are chmod'ed; pre-existing ancestors
//   (which may be shared, e.g. /tmp) are never re-permissioned.
// - Credential-shaped object keys are removed before persistence. Raw JSON
//   response bodies and encoded JSON tool arguments are parsed and given the
//   same structural filtering (including JSON nested inside them). This is a
//   structural denylist, NOT a promise that arbitrary free text can never
//   contain a secret: credential leaks inside non-JSON strings (e.g. model
//   message content) are not detectable and are preserved verbatim so model
//   payloads are never altered.
// - Writes are atomic (tmp file -> fsync -> rename). A crash may leave a
//   `.tmp-*` file; `list()` reports such files as incomplete instead of
//   pretending the record was captured, and `exportRun()` refuses to return
//   a quietly incomplete run (it fails instead).

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { generateId, sha256Hex } from "./canonical.js";
import { RepositoryValidationError } from "./errors.js";

export const EXECUTION_RECORD_VERSION = 1 as const;
// Practical per-record ceiling. A legal upper-bound model request is
// 128 messages x 65536 characters (~8.4MB verbatim, up to ~48MB when every
// character needs a `\uXXXX` escape). 64MiB holds even that worst case so
// valid recording-mode requests are captured whole; bounding is still applied
// dynamically for anything pathological, and such cases surface as explicit
// `omitted` metadata rather than a failed recording.
export const EXECUTION_RECORD_MAX_BYTES = 64 * 1024 * 1024;
export const EXECUTION_RECORD_RETENTION_DEFAULT_DAYS = 30;

/** Fixed failure surfaced to callers; no path or raw payload escapes. */
export class ExecutionRecordError extends Error {
  readonly code:
    | "record_invalid"
    | "record_too_large"
    | "record_path_unsafe"
    | "record_write_failed"
    | "record_read_failed";

  constructor(code: ExecutionRecordError["code"], message?: string) {
    super(message ?? code);
    this.name = "ExecutionRecordError";
    this.code = code;
  }
}

export interface ExecutionRecordInput {
  readonly kind: string;
  readonly runId: string;
  readonly step?: number;
  readonly callId?: string;
  readonly data: unknown;
}

export interface ExecutionRecordOmission {
  readonly reason: "record_too_large";
  /** UTF-8 byte length of the sanitized data before bounding. */
  readonly originalBytes: number;
  /** Top-level field names removed to fit the record budget. */
  readonly fields: readonly string[];
}

export interface StoredExecutionRecord {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly kind: string;
  readonly runId: string;
  readonly step?: number;
  readonly callId?: string;
  readonly data: unknown;
  /** Present only when large fields were omitted from `data`. */
  readonly omitted?: ExecutionRecordOmission;
}

export interface ExecutionRecordSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly kind: string;
  readonly runId: string;
  readonly step?: number;
  readonly callId?: string;
  /** Present when large fields were omitted to fit the record budget. */
  readonly omitted?: ExecutionRecordOmission;
}

export interface ExecutionRecordListing {
  readonly records: readonly ExecutionRecordSummary[];
  /** Number of interrupted `.tmp-*` writes (never counted as records). */
  readonly incomplete: number;
}

/** Small structural recorder interface (no DB, no async, no raw logging). */
export interface ExecutionRecorder {
  record(input: ExecutionRecordInput): void;
}

export interface ExecutionRecordStoreOptions {
  /** Absolute private directory. Created with 0700 when missing. */
  readonly directory: string;
  readonly clock?: { now(): number };
}

export interface ExecutionRecordStore extends ExecutionRecorder {
  readonly directory: string;
  record(input: ExecutionRecordInput): void;
  list(): ExecutionRecordListing;
  inspect(id: string): StoredExecutionRecord;
  exportRun(runId: string): StoredExecutionRecord[];
  deleteRecord(id: string): boolean;
  deleteRun(runId: string): number;
  prune(retentionDays: number, now?: number): number;
}

const KIND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Structural redaction. Keys are compared case-insensitively
 * after removing `_`/`-`; matching keys are replaced, never stored. This
 * targets object shapes emitted by HTTP/provider libraries; it does not
 * claim perfect free-text secrecy.
 */
const DENY_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "xsubscriptiontoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "sessioncookie",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function isDeniedKey(key: string): boolean {
  return DENY_KEYS.has(normalizedKey(key));
}

/**
 * Field names whose string values are conventionally JSON documents
 * (provider request/response bodies, encoded tool-call arguments). When such
 * a string parses as JSON and contains credential keys, it is re-serialized
 * with the same structural redaction — including JSON nested inside it.
 * These rewrites only affect the private record COPY; the original object the
 * caller passes in (and any model-visible payload derived from it) is never
 * mutated.
 */
const JSON_STRING_KEYS = new Set([
  "body",
  "requestbody",
  "responsebody",
  "rawbody",
  "jsonbody",
  "argumentsjson",
  "arguments",
  "toolarguments",
  "request",
  "response",
]);

function redactEncodedJsonString(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !containsDeniedKey(parsed)
    ) {
      // Not JSON, or no credential keys present: keep the payload verbatim
      // instead of re-serializing (which would reorder/prettify bytes).
      return text;
    }
    return JSON.stringify(sanitize(parsed, 1));
  } catch {
    return text;
  }
}

const MAX_SANITIZE_DEPTH = 24;

function sanitize(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth > MAX_SANITIZE_DEPTH) {
    return "[depth-limit]";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isDeniedKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    const child = sanitize(entry, depth + 1, seen);
    out[key] =
      typeof child === "string" && JSON_STRING_KEYS.has(normalizedKey(key))
        ? redactEncodedJsonString(child)
        : child;
  }
  return out;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Reserve room in the bound for the stored record envelope. */
const RECORD_ENVELOPE_RESERVE_BYTES = 1024;

/**
 * Bound one record's sanitized data to the per-record budget. A valid
 * ordinary request/response is NEVER rejected just because it is large;
 * instead the largest top-level fields are omitted and the omission is
 * explicit (`omitted.fields` plus their exact count/order). Small fields
 * (model, settings, fingerprint, ids, status) are kept whenever possible.
 */
function boundRecordData(data: unknown): {
  data: unknown;
  omitted?: ExecutionRecordOmission;
} {
  const serialized = JSON.stringify(data);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= EXECUTION_RECORD_MAX_BYTES) {
    return { data };
  }
  const marker = "[omitted: record_too_large]";
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    // Size each top-level entry once, then remove largest-first. Removal
    // candidacy is decided with a subtractive estimate (no full re-serialize
    // per candidate) and verified with a single serialization of the kept
    // object, whose values are reused by reference (no per-field copies).
    const entries = Object.entries(data as Record<string, unknown>)
      .map((entry) => ({
        key: entry[0],
        value: entry[1],
        size: jsonBytes(entry[1]),
      }))
      .sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
    const budget = EXECUTION_RECORD_MAX_BYTES - RECORD_ENVELOPE_RESERVE_BYTES;
    let estimated = originalBytes;
    const fields: string[] = [];
    let cursor = 0;
    while (cursor < entries.length && estimated > budget) {
      const entry = entries[cursor] as { key: string; size: number };
      cursor += 1;
      fields.push(entry.key);
      estimated -= entry.size;
    }
    const bounded: Record<string, unknown> = {};
    for (let kept = cursor; kept < entries.length; kept += 1) {
      const entry = entries[kept] as { key: string; value: unknown };
      bounded[entry.key] = entry.value;
    }
    let boundedBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    // The subtractive estimate ignores key/separator overlap; if the exact
    // verification still exceeds the budget, drop more (largest first).
    while (boundedBytes > budget && cursor < entries.length) {
      const entry = entries[cursor] as { key: string };
      cursor += 1;
      fields.push(entry.key);
      delete bounded[entry.key];
      boundedBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    }
    if (boundedBytes <= budget) {
      return {
        data: bounded,
        omitted: {
          reason: "record_too_large",
          originalBytes,
          fields: Object.freeze(fields),
        },
      };
    }
  }
  return {
    data: marker,
    omitted: {
      reason: "record_too_large",
      originalBytes,
      fields: Object.freeze([]),
    },
  };
}

function containsDeniedKey(value: unknown, depth = 0): boolean {
  if (
    depth > MAX_SANITIZE_DEPTH ||
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsDeniedKey(entry, depth + 1));
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isDeniedKey(key)) {
      return true;
    }
    // Credential keys can also hide inside an encoded JSON string (provider
    // request/response bodies, tool-call arguments), including JSON nested
    // further inside it. Mirror `sanitize`'s JSON_STRING_KEYS handling so
    // detection and redaction agree on which strings are inspected.
    if (typeof entry === "string" && JSON_STRING_KEYS.has(normalizedKey(key))) {
      try {
        const nested = JSON.parse(entry) as unknown;
        if (containsDeniedKey(nested, depth + 1)) {
          return true;
        }
      } catch {
        // Not JSON: nothing structurally detectable here.
      }
    }
    if (containsDeniedKey(entry, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Redact credential-shaped keys inside a provider response body when the
 * body is valid JSON (including JSON nested inside it, e.g. encoded analysis
 * payloads or tool arguments). Invalid (malformed) or credential-free bodies
 * are preserved verbatim so the operator can debug the exact bytes the model
 * returned. This only changes the private record, never model-visible
 * content.
 */
export function redactRawResponseBody(body: string): string {
  if (typeof body !== "string" || body.length === 0) {
    return "";
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!containsDeniedKey(parsed)) {
      return body;
    }
    return JSON.stringify(sanitize(parsed));
  } catch {
    return body;
  }
}

function assertPrivateDirectory(directory: string): void {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > 4096 ||
    !isAbsolute(directory)
  ) {
    throw new ExecutionRecordError("record_path_unsafe");
  }
  // Build the full ancestor chain root->leaf with pure string ops, so the
  // check covers every ancestor through the filesystem root, not just the
  // existing leaf. An existing leaf whose parent is a symlink must be
  // refused exactly like a symlinked leaf.
  const chain: string[] = [directory];
  let tip = directory;
  for (;;) {
    const parent = dirname(tip);
    if (parent === tip) {
      break;
    }
    chain.push(parent);
    tip = parent;
  }
  chain.reverse();
  for (let index = 0; index < chain.length; index += 1) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(chain[index] as string);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        (error as { code?: unknown }).code !== "ENOENT"
      ) {
        throw new ExecutionRecordError("record_path_unsafe");
      }
      // Missing from here down to the leaf: create in root->leaf order.
      // Only directories created here are chmod'ed to 0700; pre-existing
      // (possibly shared, e.g. /tmp) ancestors are left untouched.
      for (let create = index; create < chain.length; create += 1) {
        const target = chain[create] as string;
        try {
          const existing = lstatSync(target);
          if (existing.isSymbolicLink() || !existing.isDirectory()) {
            throw new ExecutionRecordError("record_path_unsafe");
          }
          // Raced into existence by another process: keep as-is.
          continue;
        } catch (check) {
          if (check instanceof ExecutionRecordError) {
            throw check;
          }
          if (
            typeof check !== "object" ||
            check === null ||
            (check as { code?: unknown }).code !== "ENOENT"
          ) {
            throw new ExecutionRecordError("record_path_unsafe");
          }
        }
        try {
          mkdirSync(target, { mode: 0o700 });
          if (process.platform !== "win32") {
            chmodSync(target, 0o700);
          }
        } catch {
          // Creation failure is an explicit storage write failure, never a
          // silent degradation or a raw filesystem error.
          throw new ExecutionRecordError("record_write_failed");
        }
      }
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ExecutionRecordError("record_path_unsafe");
    }
  }
}

function assertSafeFile(file: string): void {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ExecutionRecordError("record_path_unsafe");
    }
  } catch (error) {
    if (error instanceof ExecutionRecordError) {
      throw error;
    }
    if (
      typeof error !== "object" ||
      error === null ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw new ExecutionRecordError("record_path_unsafe");
    }
  }
}

function runDirectory(root: string, runId: string): string {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 256) {
    throw new ExecutionRecordError("record_invalid");
  }
  return join(root, "runs", sha256Hex(`run:${runId}`));
}

function requireRecordId(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new ExecutionRecordError("record_invalid");
  }
  return id;
}

function safeParseRecord(text: string): StoredExecutionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Partial<StoredExecutionRecord>;
  if (
    record.version !== EXECUTION_RECORD_VERSION ||
    typeof record.id !== "string" ||
    !ID_PATTERN.test(record.id) ||
    typeof record.createdAt !== "number" ||
    typeof record.kind !== "string" ||
    typeof record.runId !== "string" ||
    !("data" in record)
  ) {
    return null;
  }
  if (record.omitted !== undefined) {
    const omitted = record.omitted as Partial<ExecutionRecordOmission>;
    if (
      omitted.reason !== "record_too_large" ||
      typeof omitted.originalBytes !== "number" ||
      !Number.isSafeInteger(omitted.originalBytes) ||
      omitted.originalBytes < 0 ||
      !Array.isArray(omitted.fields) ||
      !omitted.fields.every((field) => typeof field === "string")
    ) {
      return null;
    }
  }
  return record as StoredExecutionRecord;
}

/**
 * Create the private record store. Construction validates/creates the root
 * fail-closed; it never silently degrades to a no-op store.
 */
export function createExecutionRecordStore(
  options: ExecutionRecordStoreOptions,
): ExecutionRecordStore {
  if (typeof options !== "object" || options === null) {
    throw new ExecutionRecordError("record_invalid");
  }
  const directory = options.directory;
  assertPrivateDirectory(directory);
  const clock = options.clock ?? { now: () => Date.now() };

  function record(input: ExecutionRecordInput): void {
    if (typeof input !== "object" || input === null) {
      throw new ExecutionRecordError("record_invalid");
    }
    if (typeof input.kind !== "string" || !KIND_PATTERN.test(input.kind)) {
      throw new ExecutionRecordError("record_invalid");
    }
    if (
      input.step !== undefined &&
      (!Number.isInteger(input.step) || input.step < 1)
    ) {
      throw new ExecutionRecordError("record_invalid");
    }
    if (
      input.callId !== undefined &&
      (typeof input.callId !== "string" ||
        input.callId.length === 0 ||
        input.callId.length > 256)
    ) {
      throw new ExecutionRecordError("record_invalid");
    }
    const sanitized = sanitize(input.data);
    const bounded = boundRecordData(sanitized);
    const runDir = runDirectory(directory, input.runId);
    assertPrivateDirectory(runDir);
    const recordId = generateId();
    const stored: StoredExecutionRecord = {
      version: EXECUTION_RECORD_VERSION,
      id: recordId,
      createdAt: clock.now(),
      kind: input.kind,
      runId: input.runId,
      ...(input.step === undefined ? {} : { step: input.step }),
      ...(input.callId === undefined ? {} : { callId: input.callId }),
      data: bounded.data,
      ...(bounded.omitted === undefined ? {} : { omitted: bounded.omitted }),
    };
    let text: string;
    try {
      text = JSON.stringify(stored);
    } catch {
      throw new ExecutionRecordError("record_invalid");
    }
    if (Buffer.byteLength(text, "utf8") > EXECUTION_RECORD_MAX_BYTES) {
      // The fallback marker still did not fit: this is a store/invariant
      // failure, not a valid request being rejected.
      throw new ExecutionRecordError("record_write_failed");
    }
    const finalPath = join(runDir, `${recordId}.json`);
    const tempPath = join(runDir, `.tmp-${recordId}`);
    assertSafeFile(finalPath);
    assertSafeFile(tempPath);
    try {
      const fd = openSync(tempPath, "wx", 0o600);
      try {
        if (process.platform !== "win32") {
          chmodSync(tempPath, 0o600);
        }
        writeSync(fd, text, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, finalPath);
      if (process.platform !== "win32") {
        chmodSync(finalPath, 0o600);
      }
    } catch (error) {
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // Best effort cleanup only; the write failure is explicit.
      }
      if (error instanceof ExecutionRecordError) {
        throw error;
      }
      throw new ExecutionRecordError("record_write_failed");
    }
  }

  function scan(): {
    records: ExecutionRecordSummary[];
    incomplete: number;
    files: Array<{ id: string; path: string; runDir: string }>;
    /** Present-but-unparseable .json files, reported as incomplete. */
    corrupt: Array<{ id: string; path: string }>;
  } {
    const runsRoot = join(directory, "runs");
    if (!existsSync(runsRoot)) {
      return { records: [], incomplete: 0, files: [], corrupt: [] };
    }
    const stat = lstatSync(runsRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ExecutionRecordError("record_path_unsafe");
    }
    const summaries: ExecutionRecordSummary[] = [];
    const files: Array<{ id: string; path: string; runDir: string }> = [];
    const corrupt: Array<{ id: string; path: string }> = [];
    let incomplete = 0;
    for (const runDirName of readdirSync(runsRoot)) {
      const runDir = join(runsRoot, runDirName);
      const dirStat = lstatSync(runDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new ExecutionRecordError("record_path_unsafe");
      }
      for (const name of readdirSync(runDir)) {
        if (name.startsWith(".tmp-")) {
          incomplete += 1;
          continue;
        }
        if (!name.endsWith(".json")) {
          continue;
        }
        const id = name.slice(0, -5);
        if (!ID_PATTERN.test(id)) {
          continue;
        }
        const path = join(runDir, name);
        const fileStat = lstatSync(path);
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          throw new ExecutionRecordError("record_path_unsafe");
        }
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          throw new ExecutionRecordError("record_read_failed");
        }
        const record = safeParseRecord(text);
        if (record === null) {
          // A present but unparseable record is incomplete, never absent.
          incomplete += 1;
          corrupt.push({ id, path });
          continue;
        }
        summaries.push({
          id: record.id,
          createdAt: record.createdAt,
          kind: record.kind,
          runId: record.runId,
          ...(record.step === undefined ? {} : { step: record.step }),
          ...(record.callId === undefined ? {} : { callId: record.callId }),
          ...(record.omitted === undefined ? {} : { omitted: record.omitted }),
        });
        files.push({ id: record.id, path, runDir });
      }
    }
    summaries.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
    return { records: summaries, incomplete, files, corrupt };
  }

  function list(): ExecutionRecordListing {
    const scanned = scan();
    return { records: scanned.records, incomplete: scanned.incomplete };
  }

  function inspect(id: string): StoredExecutionRecord {
    const wanted = requireRecordId(id);
    const scanned = scan();
    const found = scanned.files.find((file) => file.id === wanted);
    if (found === undefined) {
      // A listed-but-unparseable record is a read failure, not "invalid":
      // the evidence exists but cannot be shown as absent.
      if (scanned.corrupt.some((entry) => entry.id === wanted)) {
        throw new ExecutionRecordError("record_read_failed");
      }
      throw new ExecutionRecordError("record_invalid");
    }
    try {
      const record = safeParseRecord(readFileSync(found.path, "utf8"));
      if (record === null) {
        throw new ExecutionRecordError("record_read_failed");
      }
      return record;
    } catch (error) {
      if (error instanceof ExecutionRecordError) {
        throw error;
      }
      throw new ExecutionRecordError("record_read_failed");
    }
  }

  function recordsForRun(runId: string): StoredExecutionRecord[] {
    const runDir = runDirectory(directory, runId);
    if (!existsSync(runDir)) {
      return [];
    }
    // The hashed run path and every ancestor (including runs/) are checked
    // structurally; a symlink there is an unsafe path, never followed.
    assertPrivateDirectory(runDir);
    const records: StoredExecutionRecord[] = [];
    for (const name of readdirSync(runDir)) {
      if (name.startsWith(".tmp-")) {
        // Interrupted write inside this run. A run export that silently
        // omitted it would present itself as complete; fail instead.
        throw new ExecutionRecordError(
          "record_read_failed",
          "run export is incomplete: interrupted .tmp write present",
        );
      }
      if (!name.endsWith(".json")) {
        continue;
      }
      const id = name.slice(0, -5);
      if (!ID_PATTERN.test(id)) {
        continue;
      }
      const path = join(runDir, name);
      // Only regular non-symlink files may be read as run evidence.
      const fileStat = lstatSync(path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new ExecutionRecordError("record_path_unsafe");
      }
      let record: StoredExecutionRecord | null;
      try {
        record = safeParseRecord(readFileSync(path, "utf8"));
      } catch {
        throw new ExecutionRecordError("record_read_failed");
      }
      if (record === null) {
        // Corrupt JSON would otherwise vanish from the export while it still
        // shows up as `incomplete` in list(): fail the export explicitly.
        throw new ExecutionRecordError(
          "record_read_failed",
          "run export is incomplete: corrupt record present",
        );
      }
      records.push(record);
    }
    records.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
    return records;
  }

  function exportRun(runId: string): StoredExecutionRecord[] {
    return recordsForRun(runId);
  }

  function deleteRecord(id: string): boolean {
    const wanted = requireRecordId(id);
    const scanned = scan();
    const found = scanned.files.find((file) => file.id === wanted);
    const path =
      found?.path ?? scanned.corrupt.find((file) => file.id === wanted)?.path;
    if (path === undefined) {
      return false;
    }
    try {
      unlinkSync(path);
      return true;
    } catch {
      throw new ExecutionRecordError("record_write_failed");
    }
  }

  function deleteRun(runId: string): number {
    const runDir = runDirectory(directory, runId);
    if (!existsSync(runDir)) {
      return 0;
    }
    const stat = lstatSync(runDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ExecutionRecordError("record_path_unsafe");
    }
    let removed = 0;
    for (const name of readdirSync(runDir)) {
      // Deletion above a symlinked entry would silently drop unknown
      // evidence; refuse instead of rm'ing blindly over it.
      const entryStat = lstatSync(join(runDir, name));
      if (entryStat.isSymbolicLink()) {
        throw new ExecutionRecordError("record_path_unsafe");
      }
      if (name.endsWith(".json") && !name.startsWith(".tmp-")) {
        removed += 1;
      }
    }
    try {
      rmSync(runDir, { recursive: true, force: true });
      return removed;
    } catch {
      throw new ExecutionRecordError("record_write_failed");
    }
  }

  function prune(retentionDays: number, now = clock.now()): number {
    if (
      !Number.isFinite(retentionDays) ||
      retentionDays < 0 ||
      retentionDays > 3650
    ) {
      throw new ExecutionRecordError("record_invalid");
    }
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    // One scan only: deletion targets the exact file paths scan already
    // validated, instead of re-scanning per id via deleteRecord().
    const scanned = scan();
    const createdAtById = new Map(
      scanned.records.map((record) => [record.id, record.createdAt]),
    );
    let removed = 0;
    for (const file of scanned.files) {
      const createdAt = createdAtById.get(file.id);
      if (createdAt === undefined || createdAt >= cutoff) {
        continue;
      }
      try {
        unlinkSync(file.path);
        removed += 1;
      } catch {
        throw new ExecutionRecordError("record_write_failed");
      }
    }
    return removed;
  }

  return {
    directory,
    record,
    list,
    inspect,
    exportRun,
    deleteRecord,
    deleteRun,
    prune,
  };
}

/** Recorder that discards nothing: it throws on every attempted write. */
export function createUnavailableExecutionRecorder(
  reason: string,
): ExecutionRecorder {
  return {
    record(): void {
      throw new ExecutionRecordError("record_write_failed", reason);
    },
  };
}

/** Validation helper shared by config/CLI boundaries. */
export function assertExecutionRecordDirectory(directory: string): string {
  assertPrivateDirectory(directory);
  return directory;
}

/** Remove a leftover private directory (test/CLI cleanup helper). */
export function removeExecutionRecordDirectory(directory: string): void {
  if (!isAbsolute(directory)) {
    throw new RepositoryValidationError("record directory must be absolute");
  }
  rmSync(directory, { recursive: true, force: true });
}
