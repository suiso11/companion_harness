// Pinned companion wire v1 (TrialRunner-compatible) for the sealed pi-orch
// bridge. Independent of the mutable .c12 candidate tree; the wire shape and
// canonical task hash are intentionally identical to the reviewed candidate
// protocol so an existing TrialRunner can keep sending the same request.
//
// Pure module: no I/O and no spawning.

import { createHash } from "node:crypto";

export const COMPANION_WIRE_VERSION = 1;
export const MAX_RELEVANT_PATHS = 16;
export const MAX_PATH_CHARS = 512;
export const MAX_TEXT_SHORT = 1024;
export const MAX_STATEMENT_CHARS = 4096;
export const MAX_OBJECTIVE_CHARS = 8192;
export const MAX_LIST_ITEMS = 16;
export const MAX_WORKER_IDS = 16;
export const MAX_CHECKS = 16;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MIN_OUTPUT_BYTES = 1_024;
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 65_536;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const ALIAS_RE = /^[a-z0-9_-]{1,64}$/;
const CHECK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LITERAL_PATH_RE = /^[^*?[\]{}]*$/;
const SCOPE_NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

function fail(message) {
  throw new Error(`companion-wire: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needBoundedText(value, field, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(`field ${field} must be a string of ${min}..${max} chars`);
  }
  if (value.includes("\0")) fail(`field ${field} must not contain NUL`);
  return value;
}

function needStringArray(value, field, minItems, maxItems, maxChars) {
  if (!Array.isArray(value)) fail(`field ${field} must be an array`);
  if (value.length < minItems || value.length > maxItems) {
    fail(`field ${field} must carry ${minItems}..${maxItems} entries`);
  }
  const out = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > maxChars
    ) {
      fail(`field ${field} entries must be 1..${maxChars} char strings`);
    }
    if (entry.includes("\0"))
      fail(`field ${field} entries must not contain NUL`);
    out.push(entry);
  }
  return out;
}

function needRelevantPaths(value) {
  if (!Array.isArray(value)) fail("field relevantPaths must be an array");
  if (value.length < 1 || value.length > MAX_RELEVANT_PATHS) {
    fail(`field relevantPaths must carry 1..${MAX_RELEVANT_PATHS} entries`);
  }
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_PATH_CHARS
    ) {
      fail("field relevantPaths entries must be 1..512 char strings");
    }
    if (entry.includes("\0") || entry.includes("\n") || entry.includes("\r")) {
      fail("field relevantPaths entries must not contain control characters");
    }
    if (entry === ".") {
      if (seen.has(".")) fail("field relevantPaths carries duplicate entries");
      seen.add(".");
      out.push(entry);
      continue;
    }
    if (entry.startsWith("/"))
      fail("field relevantPaths entries must be repository-relative literals");
    if (!LITERAL_PATH_RE.test(entry))
      fail(
        `field relevantPaths must be concrete literals, not globs: ${entry}`,
      );
    if (entry.includes("\\"))
      fail(`field relevantPaths must not contain backslashes: ${entry}`);
    for (const segment of entry.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        fail(`field relevantPaths entries must be concrete literals: ${entry}`);
      }
    }
    if (seen.has(entry)) fail("field relevantPaths carries duplicate entries");
    seen.add(entry);
    out.push(entry);
  }
  for (let i = 0; i < out.length; i += 1) {
    for (let j = 0; j < out.length; j += 1) {
      if (i === j) continue;
      const a = out[i];
      const b = out[j];
      if (a === "." || b === ".") continue;
      if (b === a || b.startsWith(`${a}/`)) {
        fail(`field relevantPaths carries overlapping scopes: ${a} vs ${b}`);
      }
    }
  }
  return out;
}

function needCheckIds(value) {
  const ids = needStringArray(value, "requiredChecks", 1, MAX_CHECKS, 64);
  const seen = new Set();
  for (const id of ids) {
    if (!CHECK_ID_RE.test(id))
      fail(
        `field requiredChecks entries must match [A-Za-z0-9_-]{1,64}: ${id}`,
      );
    if (seen.has(id)) fail("field requiredChecks carries duplicate entries");
    seen.add(id);
  }
  return ids;
}

function needBudget(value) {
  if (!isRecord(value)) fail("field budget must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "timeoutMs" && key !== "maxOutputBytes") {
      fail(`field budget carries an unsupported key: ${key}`);
    }
  }
  const timeoutMs = value.timeoutMs;
  const maxOutputBytes = value.maxOutputBytes;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    fail(
      `field budget.timeoutMs must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`,
    );
  }
  if (
    typeof maxOutputBytes !== "number" ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < MIN_OUTPUT_BYTES ||
    maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    fail(
      `field budget.maxOutputBytes must be an integer in [${MIN_OUTPUT_BYTES}, ${MAX_OUTPUT_BYTES}]`,
    );
  }
  return { timeoutMs, maxOutputBytes };
}

const REQUEST_KEYS = [
  "version",
  "executionId",
  "taskHash",
  "configFingerprint",
  "sourceRevision",
  "workspaceAlias",
  "mode",
  "purpose",
  "objective",
  "relevantPaths",
  "acceptance",
  "requiredChecks",
  "constraints",
  "budget",
  "externalModelConsent",
];

export function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value))
        fail("canonical value carries non-finite number");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      fail("canonical value carries undefined");
      break;
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  fail("canonical value carries an unsupported type");
}

export function computeTaskHash(request) {
  const rest = { ...request };
  delete rest.taskHash;
  return createHash("sha256").update(canonicalize(rest)).digest("hex");
}

export function validateWireRequest(raw) {
  if (!isRecord(raw)) fail("request must decode to an object");
  for (const key of Object.keys(raw)) {
    if (!REQUEST_KEYS.includes(key))
      fail(`request carries an unsupported key: ${key}`);
  }
  for (const key of REQUEST_KEYS) {
    if (!(key in raw)) fail(`request is missing field: ${key}`);
  }
  if (raw.version !== 1) fail("field version must be 1");
  if (typeof raw.executionId !== "string" || !UUID_RE.test(raw.executionId)) {
    fail("field executionId must be a UUID");
  }
  if (typeof raw.taskHash !== "string" || !HEX64_RE.test(raw.taskHash)) {
    fail("field taskHash must be 64 lower-hex chars");
  }
  if (
    typeof raw.configFingerprint !== "string" ||
    !HEX64_RE.test(raw.configFingerprint)
  ) {
    fail("field configFingerprint must be 64 lower-hex chars");
  }
  if (
    typeof raw.sourceRevision !== "string" ||
    !HEX40_RE.test(raw.sourceRevision)
  ) {
    fail("field sourceRevision must be 40 lower-hex chars");
  }
  if (
    typeof raw.workspaceAlias !== "string" ||
    !ALIAS_RE.test(raw.workspaceAlias)
  ) {
    fail("field workspaceAlias must match [a-z0-9_-]{1,64}");
  }
  if (raw.mode !== "read_only" && raw.mode !== "write") {
    fail('field mode must be "read_only" or "write"');
  }
  if (!isRecord(raw.purpose)) fail("field purpose must be an object");
  for (const key of Object.keys(raw.purpose)) {
    if (key !== "statement" && key !== "scope")
      fail(`field purpose carries an unsupported key: ${key}`);
  }
  const purpose = {
    statement: needBoundedText(
      raw.purpose.statement,
      "purpose.statement",
      1,
      MAX_STATEMENT_CHARS,
    ),
    scope: needBoundedText(
      raw.purpose.scope,
      "purpose.scope",
      1,
      MAX_STATEMENT_CHARS,
    ),
  };
  const objective = needBoundedText(
    raw.objective,
    "objective",
    1,
    MAX_OBJECTIVE_CHARS,
  );
  const relevantPaths = needRelevantPaths(raw.relevantPaths);
  const acceptance = needStringArray(
    raw.acceptance,
    "acceptance",
    1,
    MAX_LIST_ITEMS,
    MAX_TEXT_SHORT,
  );
  const requiredChecks = needCheckIds(raw.requiredChecks);
  const constraints = needStringArray(
    raw.constraints,
    "constraints",
    0,
    MAX_LIST_ITEMS,
    MAX_TEXT_SHORT,
  );
  const budget = needBudget(raw.budget);
  if (typeof raw.externalModelConsent !== "boolean") {
    fail("field externalModelConsent must be a boolean");
  }
  const request = {
    version: 1,
    executionId: raw.executionId,
    taskHash: raw.taskHash,
    configFingerprint: raw.configFingerprint,
    sourceRevision: raw.sourceRevision,
    workspaceAlias: raw.workspaceAlias,
    mode: raw.mode,
    purpose,
    objective,
    relevantPaths,
    acceptance,
    requiredChecks,
    constraints,
    budget,
    externalModelConsent: raw.externalModelConsent,
  };
  if (computeTaskHash(request) !== raw.taskHash) {
    fail("field taskHash does not match the canonical request hash");
  }
  return request;
}

export function parseRequestFrame(frame, maxBytes) {
  if (!(frame instanceof Uint8Array)) fail("frame must be bytes");
  if (frame.length === 0) fail("frame is empty");
  if (frame.length > maxBytes) fail(`frame exceeds ${maxBytes} bytes`);
  if (frame.includes(0)) fail("frame carries NUL");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    fail("frame is not valid UTF-8");
  }
  if (!text.endsWith("\n")) fail("frame must end with a single LF");
  const body = text.slice(0, -1);
  if (body.includes("\n") || body.includes("\r"))
    fail("frame must carry exactly one JSONLF line");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail("frame must decode as JSON");
  }
  return validateWireRequest(parsed);
}

function needReportArrays(report) {
  const summary = needBoundedText(report.summary, "report.summary", 0, 1024);
  const needList = (value, field, maxChars, maxItems) => {
    if (!Array.isArray(value)) fail(`field ${field} must be an array`);
    if (value.length > maxItems)
      fail(`field ${field} carries too many entries`);
    const out = [];
    const seen = new Set();
    for (const entry of value) {
      if (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > maxChars
      ) {
        fail(`field ${field} entries must be 1..${maxChars} char strings`);
      }
      if (entry.includes("\0"))
        fail(`field ${field} entries must not contain NUL`);
      if (seen.has(entry)) fail(`field ${field} carries duplicate entries`);
      seen.add(entry);
      out.push(entry);
    }
    return out;
  };
  return {
    summary,
    files: needList(report.files, "report.files", 512, MAX_RELEVANT_PATHS),
    findings: needList(
      report.findings,
      "report.findings",
      MAX_TEXT_SHORT,
      MAX_RELEVANT_PATHS,
    ),
    unresolved: needList(
      report.unresolved,
      "report.unresolved",
      MAX_TEXT_SHORT,
      MAX_RELEVANT_PATHS,
    ),
  };
}

function needChecks(value) {
  if (!Array.isArray(value)) fail("field evidence.checks must be an array");
  if (value.length > MAX_CHECKS)
    fail("field evidence.checks carries too many entries");
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!isRecord(item)) fail("field evidence.checks entries must be objects");
    for (const key of Object.keys(item)) {
      if (
        key !== "id" &&
        key !== "exitCode" &&
        key !== "timedOut" &&
        key !== "outputMatched"
      ) {
        fail(`field evidence.checks entry carries an unsupported key: ${key}`);
      }
    }
    if (typeof item.id !== "string" || !CHECK_ID_RE.test(item.id)) {
      fail("field evidence.checks entries need id [A-Za-z0-9_-]{1,64}");
    }
    if (seen.has(item.id)) fail("field evidence.checks carries duplicate ids");
    seen.add(item.id);
    if (
      item.exitCode !== null &&
      (typeof item.exitCode !== "number" ||
        !Number.isSafeInteger(item.exitCode))
    ) {
      fail("field evidence.checks exitCode must be an integer or null");
    }
    if (
      typeof item.timedOut !== "boolean" ||
      typeof item.outputMatched !== "boolean"
    ) {
      fail("field evidence.checks timedOut/outputMatched must be booleans");
    }
    out.push({
      id: item.id,
      exitCode: item.exitCode,
      timedOut: item.timedOut,
      outputMatched: item.outputMatched,
    });
  }
  return out;
}

export function validateWireResult(raw, requiredChecks) {
  if (!isRecord(raw)) fail("result must decode to an object");
  for (const key of Object.keys(raw)) {
    if (
      key !== "version" &&
      key !== "executionId" &&
      key !== "taskHash" &&
      key !== "status" &&
      key !== "verified" &&
      key !== "report" &&
      key !== "evidence"
    ) {
      fail(`result carries an unsupported key: ${key}`);
    }
  }
  if (raw.version !== 1) fail("field version must be 1");
  if (typeof raw.executionId !== "string" || !UUID_RE.test(raw.executionId))
    fail("field executionId must be a UUID");
  if (typeof raw.taskHash !== "string" || !HEX64_RE.test(raw.taskHash))
    fail("field taskHash must be 64 lower-hex chars");
  if (!["done", "error", "cancelled", "unknown"].includes(raw.status)) {
    fail('field status must be "done", "error", "cancelled", or "unknown"');
  }
  if (typeof raw.verified !== "boolean")
    fail("field verified must be a boolean");
  if (!isRecord(raw.report)) fail("field report must be an object");
  for (const key of Object.keys(raw.report)) {
    if (
      key !== "summary" &&
      key !== "files" &&
      key !== "findings" &&
      key !== "unresolved"
    ) {
      fail(`field report carries an unsupported key: ${key}`);
    }
  }
  const report = needReportArrays(raw.report);
  if (!isRecord(raw.evidence)) fail("field evidence must be an object");
  const evidence = raw.evidence;
  for (const key of Object.keys(evidence)) {
    if (
      key !== "workflowId" &&
      key !== "workerIds" &&
      key !== "workspaceTrial" &&
      key !== "productionApplied" &&
      key !== "checks" &&
      key !== "artifact"
    ) {
      fail(`field evidence carries an unsupported key: ${key}`);
    }
  }
  let workflowId;
  if (evidence.workflowId !== undefined) {
    if (
      typeof evidence.workflowId !== "string" ||
      evidence.workflowId.length === 0 ||
      evidence.workflowId.length > 128
    ) {
      fail("field evidence.workflowId must be a 1..128 char string");
    }
    if (evidence.workflowId.includes("\0"))
      fail("field evidence.workflowId must not contain NUL");
    workflowId = evidence.workflowId;
  }
  if (!Array.isArray(evidence.workerIds))
    fail("field evidence.workerIds must be an array");
  if (evidence.workerIds.length > MAX_WORKER_IDS)
    fail("field evidence.workerIds carries too many entries");
  const workerIds = [];
  for (const entry of evidence.workerIds) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 128 ||
      entry.includes("\0")
    ) {
      fail("field evidence.workerIds entries must be 1..128 char strings");
    }
    workerIds.push(entry);
  }
  if (evidence.workspaceTrial !== true)
    fail("field evidence.workspaceTrial must be true");
  if (evidence.productionApplied !== false)
    fail("field evidence.productionApplied must be false");
  const checks = needChecks(evidence.checks);
  let artifact;
  if (evidence.artifact !== undefined) {
    if (!isRecord(evidence.artifact))
      fail("field evidence.artifact must be an object");
    for (const key of Object.keys(evidence.artifact)) {
      if (key !== "sha256" && key !== "entryCount" && key !== "bytes") {
        fail(`field evidence.artifact carries an unsupported key: ${key}`);
      }
    }
    if (
      typeof evidence.artifact.sha256 !== "string" ||
      !HEX64_RE.test(evidence.artifact.sha256)
    ) {
      fail("field evidence.artifact.sha256 must be 64 lower-hex chars");
    }
    const entryCount = evidence.artifact.entryCount;
    const bytes = evidence.artifact.bytes;
    if (
      typeof entryCount !== "number" ||
      !Number.isSafeInteger(entryCount) ||
      entryCount < 0 ||
      entryCount > MAX_MANIFEST_FILES
    ) {
      fail("field evidence.artifact.entryCount is out of range");
    }
    if (
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_OUTPUT_BYTES
    ) {
      fail("field evidence.artifact.bytes is out of range");
    }
    artifact = { sha256: evidence.artifact.sha256, entryCount, bytes };
  }
  if (raw.status === "done") {
    if (raw.verified !== true) fail("done results require verified true");
    if (requiredChecks.length === 0)
      fail("done results require a nonempty required check set");
    if (checks.length !== requiredChecks.length)
      fail("done results require exactly the required check IDs");
    const seen = new Set(checks.map((check) => check.id));
    for (const id of requiredChecks) {
      if (!seen.has(id)) fail(`done result is missing required check: ${id}`);
    }
    for (const check of checks) {
      if (check.exitCode !== 0 || check.timedOut || !check.outputMatched) {
        fail(`done result check is not clean: ${check.id}`);
      }
    }
  } else if (raw.verified !== false) {
    fail("non-done results require verified false");
  }
  return {
    version: 1,
    executionId: raw.executionId,
    taskHash: raw.taskHash,
    status: raw.status,
    verified: raw.verified,
    report,
    evidence: {
      workerIds,
      workspaceTrial: true,
      productionApplied: false,
      checks,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(artifact !== undefined ? { artifact } : {}),
    },
  };
}

export function serializeResult(result) {
  return `${canonicalize(result)}\n`;
}

export function companionScopeIdentity(request) {
  return { scopeUuid: request.executionId, scopeNonce: request.taskHash };
}

export function expectedScopeUnit(identity) {
  return `capsule-${identity.scopeUuid}-${identity.scopeNonce}.scope`;
}

export function companionScopeUnit(request) {
  return expectedScopeUnit(companionScopeIdentity(request));
}

export function isCompanionScopeUnit(parsedUnit, request) {
  if (typeof parsedUnit !== "string" || !SCOPE_NONCE_RE.test(request.taskHash))
    return false;
  return parsedUnit === companionScopeUnit(request);
}

export function isPathInScopes(rel, scopes) {
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.length === 0) continue;
    if (scope === ".") return true;
    const norm = scope.replace(/\/+$/, "");
    if (norm === "" || norm === ".") return true;
    if (rel === norm || rel.startsWith(`${norm}/`)) return true;
  }
  return false;
}
