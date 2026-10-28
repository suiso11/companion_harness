#!/usr/bin/env node
// Sealed pi-orch bridge (TrialRunner-compatible CLI).
//
// Contract:
//   node companion-bridge.mjs --describe
//   node companion-bridge.mjs --config <absolute operator config>
//
// --config reads exactly one JSONLF request from stdin, requires fd3 to be a
// FIFO/socket control pipe, reserves an idempotent journal row, and runs the
// frozen operator executor/checks against a private copy of a verified SEALED
// source snapshot. The original source root is never mounted, read, or bound.
// stdout carries exactly one result JSONLF after a reservation; diagnostics
// are redacted to fixed strings on stderr.
//
// Production execution uses systemd user scope + bwrap. If user systemd/bwrap
// is unavailable the bridge returns an explicit error (containment blocker);
// it never falls back to a host process. `offline-fixture` is an explicit
// non-containment regression backend for synthetic tests only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Socket as ControlSocket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateCandidateChanges,
  verifySealedWorkspaceSnapshot,
} from "../../packages/kernel/src/autonomous_workspace.ts";
import { CompanionJournal } from "./companion-journal.mjs";
import {
  parseRequestFrame,
  serializeResult,
  validateWireResult,
} from "./companion-protocol.mjs";
import {
  buildCheckCommand,
  buildWholejobCommand,
  createJobFile,
  materializeSealedWork,
  preflightContainment,
  spawnObserved,
  stopOwnedScope,
} from "./containment.mjs";
import {
  assertConsent,
  assertProfileMatches,
  assertRequestBudget,
  assertRequestScopes,
  computeEffectiveProfile,
  loadSealedSnapshot,
  parseOperatorConfig,
  verifyDependencyClosure,
} from "./sealed-profile.mjs";

export const BRIDGE_VERSION = 2;
export const BRIDGE_WIRE_VERSION = 1;
export const BRIDGE_MODES = ["read_only", "write"];

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID = 2;
const STDOUT_FD = 1;
const STDERR_FD = 2;

const MSG_INVALID_ARGS = "companion bridge: invalid arguments";
const MSG_INVALID_CONFIG = "companion bridge: invalid operator config";
const MSG_INVALID_PIPE = "companion bridge: invalid control pipe";
const MSG_INVALID_REQUEST = "companion bridge: invalid request";
const MSG_INFLIGHT = "companion bridge: inflight";
const MSG_INTERNAL = "companion bridge: internal error";

function checkControlPipe(fd = 3) {
  let st;
  try {
    st = fstatSync(fd);
  } catch {
    throw new Error("control pipe unavailable");
  }
  if (!st.isFIFO() && !st.isSocket())
    throw new Error("control pipe must be FIFO or socket");
}

function redactedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/home\/[^\s:]+/g, "<path>").slice(0, 500);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function emptyReport(summary) {
  return { summary, files: [], findings: [], unresolved: [] };
}

// Provenance stays explicit and separate: `evidence.checks`/`artifact` are
// host-executed/revalidated; `evidence.workerIds` (when present) come from the
// guest-writable report and are guest-reported/unattested, never proof.
function rawResult(request, status, verified, report, evidence = {}) {
  return {
    version: 1,
    executionId: request.executionId,
    taskHash: request.taskHash,
    status,
    verified,
    report,
    evidence: {
      workerIds: evidence.workerIds ?? [],
      workspaceTrial: true,
      productionApplied: false,
      checks: evidence.checks ?? [],
      ...(evidence.workflowId !== undefined
        ? { workflowId: evidence.workflowId }
        : {}),
      ...(evidence.artifact !== undefined
        ? { artifact: evidence.artifact }
        : {}),
    },
  };
}

function checkUnit(request, index) {
  const nonce = `check-${index}-${request.taskHash.slice(0, 48)}`;
  return `capsule-${request.executionId}-${nonce}.scope`;
}

// The guest owns /work and can write this file. It is an UNTRUSTED guest
// self-report, exactly like model prose: never host evidence, never a
// permission/adoption/resource/trust input. Host authority comes only from the
// fixed operator checks and the post-check candidate/artifact revalidation.
function readGuestObservation(workRoot) {
  const path = join(workRoot, ".companion-observation", "guest.json");
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024)
      return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tools))
      return null;
    if (
      parsed.engine !== "omp-headless-json" &&
      parsed.engine !== "pi-orch-omp-json"
    )
      return null;
    // The observation is guest-owned and untrusted: bound and redact the
    // optional assistant stream tail here, before any consumer sees it.
    if (typeof parsed.lastAssistantTail === "string") {
      parsed.lastAssistantTail = redactDiagnostic(
        parsed.lastAssistantTail,
      ).slice(-MAX_ASSISTANT_TAIL_CHARS);
    }
    return parsed;
  } catch {
    return null;
  }
}

// The journal protocol caps each report entry at 1024 characters (which is
// also <= 2048 bytes), so bounded heads must fit that tighter entry limit.
const DIAGNOSTIC_HEAD_BYTES = 1024;
const MAX_ASSISTANT_TAIL_CHARS = 512;
const DIAGNOSTIC_SECRET_PATTERN = /(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/g;

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(DIAGNOSTIC_SECRET_PATTERN, "[redacted]")
    .replaceAll("\u0000", "");
}

// A failure diagnostic must stay small enough for the bounded journal report
// and must never retain credential-shaped material from untrusted output.
function boundedDiagnostic(value, limit = DIAGNOSTIC_HEAD_BYTES) {
  const text = redactDiagnostic(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const marker = "\n[truncated]";
  const room = Math.max(0, limit - Buffer.byteLength(marker, "utf8"));
  return `${bytes
    .subarray(0, room)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "")}${marker}`;
}

// The guest observation and the executor heads are the only failure evidence
// the bridge currently has; persist them (bounded/redacted) with exit 10 so a
// future nonzero can be diagnosed instead of collapsing to a generic message.
function executorFailureDiagnostics(workRoot, run) {
  const diagnostics = [];
  const observation = readGuestObservation(workRoot);
  if (observation === null) {
    diagnostics.push("diagnostic: guest observation missing");
  } else {
    const observedTools = Array.isArray(observation.tools)
      ? observation.tools
      : [];
    const toolErrors = observedTools.filter(
      (tool) => tool && tool.result === "error",
    ).length;
    const errorKind =
      typeof observation.error === "string" && observation.error.length > 0
        ? observation.error
        : "none";
    diagnostics.push(
      boundedDiagnostic(
        `diagnostic: guest observation engine=${observation.engine} executorKind=${observation.executorKind} ompExitCode=${observation.ompExitCode ?? "unknown"} timedOut=${observation.timedOut === true} signal=${typeof observation.signal === "string" ? observation.signal : "none"} toolCount=${observedTools.length} toolErrors=${toolErrors} error=${errorKind}`,
      ),
    );
  }
  if (
    observation !== null &&
    typeof observation.lastAssistantTail === "string" &&
    observation.lastAssistantTail.length > 0
  ) {
    diagnostics.push(
      boundedDiagnostic(
        `diagnostic: guest assistant tail: ${observation.lastAssistantTail}`,
      ),
    );
  }
  if (typeof run.stderr === "string" && run.stderr.length > 0) {
    diagnostics.push(
      boundedDiagnostic(`diagnostic: guest stderr: ${run.stderr}`),
    );
  }
  if (typeof run.stdout === "string" && run.stdout.length > 0) {
    diagnostics.push(
      boundedDiagnostic(`diagnostic: guest stdout: ${run.stdout}`),
    );
  }
  return diagnostics;
}

function observationFindings(observation) {
  if (observation === null) return [];
  const findings = [];
  for (const tool of observation.tools.slice(0, 8)) {
    if (!tool || typeof tool.name !== "string") continue;
    const path =
      tool.args && typeof tool.args.path === "string"
        ? ` ${tool.args.path.slice(0, 256)}`
        : "";
    const result =
      tool.result === "ok"
        ? "ok"
        : tool.result === "error"
          ? "denied"
          : "pending";
    findings.push(`tool ${tool.name.slice(0, 64)}${path} (${result})`);
  }
  for (const worker of (Array.isArray(observation.delegatedWorkers)
    ? observation.delegatedWorkers
    : []
  ).slice(0, 8)) {
    if (
      !worker ||
      typeof worker.id !== "string" ||
      typeof worker.status !== "string"
    )
      continue;
    findings.push(
      `guest-reported worker ${worker.id.slice(0, 32)} ${worker.status.slice(0, 32)} (unattested)`,
    );
  }
  return findings;
}

const MAX_GUEST_ANSWER_CHARS = 4096;
const MAX_GUEST_ANSWER_CHUNK = 900;
const MAX_REPORT_FINDINGS = 16;
const GUEST_ANSWER_LABEL = "guest answer (unattested)";
const GUEST_ANSWER_SINGLE_PREFIX = `${GUEST_ANSWER_LABEL}: `;
const GUEST_ANSWER_CHUNK_PREFIX = `${GUEST_ANSWER_LABEL} `;
const TRUNCATION_MARKER = " [truncated]";

function boundedGuestAnswer(observation) {
  if (
    observation === null ||
    typeof observation.finalText !== "string" ||
    observation.finalText.length === 0
  )
    return "";
  return observation.finalText
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_GUEST_ANSWER_CHARS);
}

function buildGuestAnswerFindings(answer, truncated = false) {
  if (answer.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < answer.length; i += MAX_GUEST_ANSWER_CHUNK)
    chunks.push(answer.slice(i, i + MAX_GUEST_ANSWER_CHUNK));
  return chunks.map((chunk, index) => {
    const label =
      chunks.length === 1
        ? GUEST_ANSWER_SINGLE_PREFIX
        : `${GUEST_ANSWER_CHUNK_PREFIX}${index + 1}/${chunks.length}: `;
    const suffix =
      truncated && index === chunks.length - 1 ? TRUNCATION_MARKER : "";
    return `${label}${chunk}${suffix}`;
  });
}

function guestAnswerChunkText(entry) {
  if (entry.startsWith(GUEST_ANSWER_SINGLE_PREFIX))
    return entry.slice(GUEST_ANSWER_SINGLE_PREFIX.length);
  if (!entry.startsWith(GUEST_ANSWER_CHUNK_PREFIX)) return null;
  const rest = entry.slice(GUEST_ANSWER_CHUNK_PREFIX.length);
  const match = /^\d+\/\d+: /.exec(rest);
  return match === null ? null : rest.slice(match[0].length);
}

function isGuestAnswerFinding(entry) {
  return guestAnswerChunkText(entry) !== null;
}

// The guest's final prose is UNATTESTED, exactly like its tool/worker lines.
// It is forwarded only as clearly labelled report findings (never checks,
// authorization, artifact, or completion evidence) after stripping control
// characters and bounding the total forwarded size.
function guestAnswerFindings(observation) {
  return buildGuestAnswerFindings(boundedGuestAnswer(observation));
}

function reportFindings(observation, extra = []) {
  const out = [];
  const seen = new Set();
  const candidates = [
    ...guestAnswerFindings(observation),
    ...extra,
    ...observationFindings(observation),
  ];
  for (const entry of candidates) {
    if (out.length >= MAX_REPORT_FINDINGS) break;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function resultLineCap(request, config) {
  // TrialRunner accepts budget.maxOutputBytes + a framing allowance, but the
  // conservative bound for the complete JSON+LF line is the request budget.
  return Math.min(request.budget.maxOutputBytes, config.storage.maxResultBytes);
}

function serializedResultBytes(raw) {
  return Buffer.byteLength(serializeResult(raw), "utf8");
}

// Cut on a UTF-8 code-point boundary so a multibyte character is never split
// into a replacement sequence.
function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function extractGuestAnswer(findings) {
  const chunks = [];
  for (const entry of findings) {
    const text = guestAnswerChunkText(entry);
    if (text !== null) chunks.push(text);
  }
  return chunks.join(" ");
}

function withoutGuestAnswer(raw) {
  return {
    ...raw,
    report: {
      ...raw.report,
      findings: raw.report.findings.filter(
        (entry) => !isGuestAnswerFinding(entry),
      ),
    },
  };
}

function withGuestAnswer(raw, answer, truncated) {
  return {
    ...raw,
    report: {
      ...raw.report,
      findings: [
        ...buildGuestAnswerFindings(answer, truncated),
        ...raw.report.findings.filter((entry) => !isGuestAnswerFinding(entry)),
      ],
    },
  };
}

// Keep the COMPLETE serialized result line within the request output
// allowance. The unattested guest answer is shrunk first (UTF-8-safe, marked
// truncated), then optional findings are dropped from the end. Checks, the
// artifact, and authorization/identity fields are never trimmed.
function fitResultLineBudget(raw, request, config) {
  const cap = resultLineCap(request, config);
  if (serializedResultBytes(raw) <= cap) return raw;
  if (!Array.isArray(raw.report?.findings)) return raw;
  let fitted = raw;
  const answer = extractGuestAnswer(raw.report.findings);
  if (answer.length > 0) {
    const reduced = withoutGuestAnswer(raw);
    if (serializedResultBytes(reduced) > cap) {
      // Not even the remaining fields fit: drop the answer, then let the
      // optional-finding loop below make room.
      fitted = reduced;
    } else {
      const fullBytes = Buffer.byteLength(answer, "utf8");
      let low = 1;
      let high = fullBytes;
      let best = null;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const truncated = mid < fullBytes;
        const candidate = withGuestAnswer(
          reduced,
          truncateUtf8(answer, mid),
          truncated,
        );
        if (serializedResultBytes(candidate) <= cap) {
          best = candidate;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      fitted = best ?? reduced;
    }
  }
  while (
    serializedResultBytes(fitted) > cap &&
    fitted.report.findings.length > 0
  ) {
    fitted = {
      ...fitted,
      report: {
        ...fitted.report,
        findings: fitted.report.findings.slice(0, -1),
      },
    };
  }
  return fitted;
}

// Conservative RELIABILITY downgrade over an UNTRUSTED guest report. The
// reported execution status is guest-reported/unattested (the guest can
// rewrite guest.json); it is never host evidence and never authorizes
// permission, adoption, resources, or trust. A reported success proves nothing
// and cannot make a host check pass or widen candidate scope. Missing/failed
// reports may only downgrade the result to unknown/error. Host authority is
// exclusively: every fixed operator check passed + candidate scope revalidated
// + retained artifact hashes matched. That still does not attest execution,
// delegation, completion, or semantic correctness.
//
// The sealed real-pi guest is a DIRECT worker (read/grep/glob[,write]); it does
// not have to delegate through task/opencode, so a report without delegated
// workers is the expected shape. The gate is instead the guest's own observed
// execution: the observation must report ompExitCode 0, no error, at least one
// observed tool call, and every observed tool result "ok". A delegated-worker
// report is optional; when present the legacy per-worker checks still apply.
const DELEGATED_WORKER_STATUSES = new Set([
  "running",
  "done",
  "error",
  "cancelled",
]);

function evaluateGuestExecution(observation, realPiRequired) {
  if (observation === null || observation.executorKind !== "real-pi") {
    return realPiRequired
      ? { ok: false, missing: true }
      : { ok: true, missing: false };
  }
  if (!Array.isArray(observation.tools)) {
    return { ok: false, missing: true };
  }
  if (observation.tools.length === 0) return { ok: false, missing: true };
  const reportedWorkers = observation.delegatedWorkers;
  if (reportedWorkers !== undefined && reportedWorkers !== null) {
    if (!Array.isArray(reportedWorkers)) return { ok: false, missing: true };
    for (const worker of reportedWorkers.slice(0, 32)) {
      if (
        !worker ||
        typeof worker !== "object" ||
        typeof worker.id !== "string" ||
        worker.id.length === 0 ||
        typeof worker.status !== "string" ||
        !DELEGATED_WORKER_STATUSES.has(worker.status)
      ) {
        return { ok: false, missing: true };
      }
      if (worker.status !== "done" || worker.isError === true) {
        return { ok: false, missing: false };
      }
    }
  }
  if (!Number.isSafeInteger(observation.ompExitCode)) {
    return { ok: false, missing: true };
  }
  if (observation.ompExitCode !== 0 || observation.timedOut === true) {
    return { ok: false, missing: false };
  }
  if (
    observation.error !== undefined &&
    observation.error !== null &&
    observation.error !== ""
  ) {
    return { ok: false, missing: false };
  }
  for (const tool of observation.tools) {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
      return { ok: false, missing: true };
    }
    if (tool.result !== "ok") return { ok: false, missing: false };
  }
  return { ok: true, missing: false };
}

// Retain the exact candidate bytes that the final validation hashed. The file
// is opened with O_NOFOLLOW, the opened descriptor is bounded to the recorded
// size, and the bytes are hashed again before they are written to the
// retention directory. A path swap (including a symlink swap) or a byte change
// after validation therefore fails closed instead of retaining stale or
// mismatched content.
function readVerifiedCandidateBytes(workRoot, change, maxBytes) {
  if (change.candidateSha256 === null || change.kind === "delete") return null;
  if (
    !Number.isSafeInteger(change.size) ||
    change.size < 0 ||
    change.size > maxBytes
  ) {
    throw new Error("candidate retention exceeds the artifact cap");
  }
  const source = join(workRoot, ...change.path.split("/"));
  const fd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== change.size) {
      throw new Error("candidate changed while retaining");
    }
    const bytes = Buffer.allocUnsafe(change.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read <= 0) throw new Error("candidate changed while retaining");
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, null) !== 0)
      throw new Error("candidate changed while retaining");
    const digest = sha256(bytes);
    if (digest !== change.candidateSha256) {
      throw new Error("candidate bytes do not match the validated digest");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

// Retain the verified base bytes for changes whose diff needs them. Completed
// policy trials delete the heavy sealed snapshot at quiescence, so the review
// surface must have a retained copy to verify baseSha256 after that cleanup.
// Best effort: a base copy never fails an otherwise successful trial.
function retainBaseChanges(snapshotRoot, changes, destination, maxBytes) {
  let total = 0;
  for (const change of changes) {
    if (change.kind === "create" || change.baseSha256 === null) continue;
    let bytes;
    try {
      const source = join(snapshotRoot, ...change.path.split("/"));
      const fd = openSync(
        source,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > maxBytes) continue;
        bytes = Buffer.allocUnsafe(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, null);
          if (read <= 0) throw new Error("base changed while retaining");
          offset += read;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (sha256(bytes) !== change.baseSha256) continue;
    if (total + bytes.length > maxBytes) continue;
    try {
      const target = join(destination, ...change.path.split("/"));
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      const targetFd = openSync(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(targetFd, bytes, 0, bytes.length, 0);
      } finally {
        closeSync(targetFd);
      }
      chmodSync(target, 0o600);
      total += bytes.length;
    } catch {
      // A failed base retention only degrades review, never the trial result.
    }
  }
}

function retainCandidateChanges(
  workRoot,
  changes,
  destination,
  artifactBytes,
  maxBytes,
) {
  if (
    !Number.isSafeInteger(artifactBytes) ||
    artifactBytes < 0 ||
    artifactBytes > maxBytes
  ) {
    throw new Error("candidate retention exceeds the artifact cap");
  }
  let total = artifactBytes;
  const retained = [];
  for (const change of changes) {
    const bytes = readVerifiedCandidateBytes(
      workRoot,
      change,
      maxBytes - artifactBytes,
    );
    if (bytes === null) continue;
    total += bytes.length;
    if (total > maxBytes)
      throw new Error("candidate retention exceeds the artifact cap");
    const target = join(destination, ...change.path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    const targetFd = openSync(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(targetFd, bytes, 0, bytes.length, 0);
    } finally {
      closeSync(targetFd);
    }
    chmodSync(target, 0o600);
    retained.push({
      path: change.path,
      sha256: change.candidateSha256,
      size: bytes.length,
    });
  }
  return retained;
}

// The installed extension's direct-write guard requires a Git worktree with a
// capturable baseline. Create that baseline only inside the private /work copy
// of the verified sealed snapshot; the original source and its .git are never
// mounted or read. .git is operator-owned scratch metadata and is excluded
// from candidate source validation (and from relevantPaths).
function ensureWriteBaseline(workRoot, runDir) {
  const home = join(runDir, "git-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: workRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("git baseline setup failed");
  };
  git(["-c", "init.defaultBranch=main", "init", "-q"]);
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=Companion Bridge",
    "-c",
    "user.email=bridge@localhost",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "sealed baseline",
  ]);
}

async function main() {
  let controlStream = null;
  let currentChild = null;
  let currentUnit = null;
  let runtime = null;
  let controlCancelled = false;
  let deadlineFired = false;

  const exitWith = (fd, text, code) => {
    try {
      writeSync(fd, text);
    } catch {
      // Best effort.
    }
    try {
      if (controlStream !== null) controlStream.destroy();
    } catch {
      // Best effort.
    }
    process.exit(code);
  };

  const requestCancel = () => {
    if (controlCancelled) return;
    controlCancelled = true;
    if (currentChild !== null) {
      try {
        currentChild.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
    if (currentUnit !== null && runtime !== null) {
      stopOwnedScope(runtime, currentUnit, "SIGTERM");
    }
    const force = setTimeout(() => {
      if (currentChild !== null) {
        try {
          currentChild.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }
      if (currentUnit !== null && runtime !== null)
        stopOwnedScope(runtime, currentUnit, "SIGKILL");
    }, 15_000);
    if (force.unref) force.unref();
  };

  const argv = process.argv.slice(2);
  if (argv.includes("--describe")) {
    exitWith(
      STDOUT_FD,
      `${JSON.stringify({
        version: BRIDGE_VERSION,
        wire: BRIDGE_WIRE_VERSION,
        modes: BRIDGE_MODES,
        sealed: true,
        backends: ["confined", "offline-fixture"],
        testDefaultLimits: "not-activated-policy",
      })}\n`,
      EXIT_OK,
    );
  }

  let configPath;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config") {
      if (configPath !== undefined || i + 1 >= argv.length) {
        exitWith(STDERR_FD, `${MSG_INVALID_ARGS}\n`, EXIT_INVALID);
      }
      configPath = argv[i + 1];
      i += 1;
    } else {
      exitWith(STDERR_FD, `${MSG_INVALID_ARGS}\n`, EXIT_INVALID);
    }
  }
  if (configPath === undefined || !configPath.startsWith("/")) {
    exitWith(STDERR_FD, `${MSG_INVALID_ARGS}\n`, EXIT_INVALID);
  }

  // Strict operator config and REAL effective-profile computation first.
  let config;
  let effective;
  let snapshot;
  try {
    config = parseOperatorConfig(readFileSync(configPath, "utf8"));
    runtime = config.profile.runtime;
    effective = computeEffectiveProfile(config);
    assertProfileMatches(config, effective);
    snapshot = loadSealedSnapshot(config, {
      expectedManifestDigest: config.sealed.manifestDigest,
    });
    const verified = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: config.sealed.manifestDigest,
    });
    if (!verified.ok)
      throw new Error(
        `sealed snapshot verification failed: ${verified.reason}`,
      );
    if (verified.manifestDigest !== config.sealed.manifestDigest) {
      throw new Error("sealed snapshot digest changed during verification");
    }
    let sourceBytes = 0;
    for (const entry of snapshot.manifest) sourceBytes += entry.size;
    if (snapshot.manifest.length > 20_000)
      throw new Error("sealed snapshot exceeds 20000 files");
    if (sourceBytes > config.profile.limits.maxSourceBytes)
      throw new Error("sealed snapshot exceeds maxSourceBytes");
  } catch (error) {
    process.stderr.write(`${MSG_INVALID_CONFIG}: ${redactedError(error)}\n`);
    process.exit(EXIT_INVALID);
  }

  try {
    checkControlPipe(3);
  } catch {
    exitWith(STDERR_FD, `${MSG_INVALID_PIPE}\n`, EXIT_INVALID);
  }

  try {
    controlStream = new ControlSocket({
      fd: 3,
      readable: true,
      writable: false,
    });
    controlStream.on("data", () => {});
    controlStream.on("end", requestCancel);
    controlStream.on("error", requestCancel);
    controlStream.resume();
  } catch {
    requestCancel();
  }
  process.on("SIGINT", requestCancel);
  process.on("SIGTERM", requestCancel);

  let frame;
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > config.storage.maxRequestBytes)
        throw new Error("request too large");
      chunks.push(chunk);
    }
    frame = Buffer.concat(chunks);
  } catch {
    exitWith(STDERR_FD, `${MSG_INVALID_REQUEST}\n`, EXIT_INVALID);
  }

  let request;
  try {
    request = parseRequestFrame(frame, config.storage.maxRequestBytes);
    if (request.configFingerprint !== effective.fingerprint)
      throw new Error("config fingerprint mismatch");
    if (request.sourceRevision !== effective.sourceRevision)
      throw new Error("source revision mismatch");
    if (request.workspaceAlias !== config.active.workspaceAlias)
      throw new Error("workspace alias mismatch");
    assertConsent(config.profile, request);
    assertRequestScopes(config.profile, request);
    assertRequestBudget(config.profile, request);
  } catch {
    exitWith(STDERR_FD, `${MSG_INVALID_REQUEST}\n`, EXIT_INVALID);
  }

  let journal;
  try {
    journal = new CompanionJournal(config.stateDir, config.storage);
  } catch (error) {
    exitWith(
      STDERR_FD,
      `${MSG_INTERNAL}: ${redactedError(error)}\n`,
      EXIT_INTERNAL,
    );
  }

  let reserve;
  try {
    reserve = journal.reserve(request, config.active, {
      artifactCapBytes: config.storage.maxArtifactBytes,
      resultCapBytes: config.storage.maxResultBytes,
    });
  } catch {
    journal.close();
    exitWith(STDERR_FD, `${MSG_INVALID_REQUEST}\n`, EXIT_INVALID);
  }
  if (reserve.kind === "duplicate-final") {
    journal.close();
    exitWith(STDOUT_FD, reserve.resultJsonLf, EXIT_OK);
  }
  if (reserve.kind === "duplicate-inflight") {
    journal.close();
    exitWith(STDERR_FD, `${MSG_INFLIGHT}\n`, EXIT_INVALID);
  }

  const runDir = join(config.stateDir, "runs", request.executionId);
  const ownerToken = reserve.ownerToken;
  let outcome;

  const finalize = (raw, storedExit, artifactBytes) => {
    // Carry the journal's stored exit code on the wire. Without it the host
    // had to synthesize 1 for every error status and lost the faithful
    // classification (e.g. executor failure 10 vs internal 1).
    const fitted = fitResultLineBudget(
      { ...raw, exitCode: storedExit },
      request,
      config,
    );
    const validated = validateWireResult(fitted, request.requiredChecks);
    const line = serializeResult(validated);
    if (Buffer.byteLength(line, "utf8") > resultLineCap(request, config))
      throw new Error("final result exceeds the output allowance");
    journal.finalize(request, {
      resultJsonLf: line,
      exitCode: storedExit,
      ownerToken,
      ...(artifactBytes !== undefined ? { artifactBytes } : {}),
    });
    writeSync(STDOUT_FD, line);
  };

  const errorOutcome = (summary, checks, storedExit, unresolved = []) => ({
    raw: rawResult(
      request,
      "error",
      false,
      { summary, files: [], findings: [], unresolved },
      { checks },
    ),
    storedExit,
  });

  try {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    const runStat = lstatSync(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory())
      throw new Error("run dir is not private");

    const effectiveDurationMs = Math.min(
      request.budget.timeoutMs,
      config.profile.limits.maxDurationMs,
    );
    const deadlineAt = Date.now() + effectiveDurationMs;
    const remainingMs = () => deadlineAt - Date.now();
    const deadlineTimer = setTimeout(
      () => {
        deadlineFired = true;
        requestCancel();
      },
      Math.max(0, remainingMs()),
    );
    if (deadlineTimer.unref) deadlineTimer.unref();

    const observe = async (command, args, options) => {
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          requestCancel();
        },
        Math.max(0, options.timeoutMs),
      );
      if (timer.unref) timer.unref();
      try {
        const result = await spawnObserved(command, args, {
          ...options,
          onChild: (child) => {
            currentChild = child;
            options.onChild?.(child);
          },
        });
        return { ...result, timedOut };
      } finally {
        clearTimeout(timer);
        currentChild = null;
        currentUnit = null;
      }
    };

    const deps = (() => {
      try {
        return {
          ok: true,
          value: verifyDependencyClosure(
            config.profile.dependencies,
            config.profile.limits.maxDependencyBytes,
          ),
        };
      } catch (error) {
        return { ok: false, reason: redactedError(error) };
      }
    })();

    const before = await verifySealedWorkspaceSnapshot(snapshot, {
      expectedManifestDigest: config.sealed.manifestDigest,
    });
    if (!before.ok) {
      outcome = errorOutcome(
        "companion bridge: sealed snapshot failed before launch",
        [],
        12,
        ["blocked: snapshot content"],
      );
    } else if (!deps.ok) {
      outcome = errorOutcome("companion bridge: blocked dependencies", [], 12, [
        "blocked: dependencies",
      ]);
    } else if (config.profile.executionBackend === "confined") {
      const preflight = preflightContainment(config.profile.runtime);
      if (!preflight.ok) {
        outcome = errorOutcome(
          "companion bridge: containment unavailable",
          [],
          12,
          ["blocked: containment", preflight.reason],
        );
      } else {
        let relayOk = false;
        try {
          relayOk = lstatSync(config.profile.model.sockHostPath).isSocket();
        } catch {
          relayOk = false;
        }
        if (!relayOk) {
          outcome = errorOutcome(
            "companion bridge: containment unavailable",
            [],
            12,
            [
              "blocked: containment",
              "trusted model relay UDS is missing or not a socket",
            ],
          );
        }
      }
    }

    if (outcome === undefined && controlCancelled) {
      outcome = {
        raw: rawResult(
          request,
          "cancelled",
          false,
          emptyReport("companion bridge: cancelled"),
        ),
        storedExit: 143,
      };
    }

    if (outcome === undefined) {
      const workRoot = join(runDir, "work");
      materializeSealedWork(snapshot.snapshotRoot, workRoot);
      if (request.mode === "write") ensureWriteBaseline(workRoot, runDir);
      const executorFile = config.profile.executor.executable;
      if (lstatSync(executorFile).isSymbolicLink())
        throw new Error("executor must not be a symlink");
      const jobFile = createJobFile(join(runDir, "job.json"), {
        version: 1,
        mode: request.mode,
        executionId: request.executionId,
        taskHash: request.taskHash,
        profileFingerprint: effective.fingerprint,
        sealed: {
          manifestDigest: config.sealed.manifestDigest,
          sourceRevision: effective.sourceRevision,
          snapshotRoot: snapshot.snapshotRoot,
        },
        purpose: request.purpose,
        objective: request.objective,
        relevantPaths: request.relevantPaths,
        acceptance: request.acceptance,
        constraints: request.constraints,
        requiredChecks: request.requiredChecks,
        externalModelConsent: request.externalModelConsent,
      });
      const unit = reserve.scopeUnit;
      let run;
      if (config.profile.executionBackend === "confined") {
        const built = buildWholejobCommand(
          config.profile,
          { executorExecutable: executorFile, workRoot, jobFile },
          unit,
          { guestTimeoutMs: effectiveDurationMs },
        );
        if (process.env.PI_ORCH_DEBUG_LOG) {
          try {
            writeFileSync(
              `${process.env.PI_ORCH_DEBUG_LOG}.cmd`,
              JSON.stringify(built),
            );
          } catch {
            /* debug only */
          }
        }
        currentUnit = unit;
        run = await observe(built.command, built.args, {
          timeoutMs: remainingMs(),
          outputCap: Math.min(request.budget.maxOutputBytes, 1024 * 1024),
        });
      } else {
        // Explicit synthetic regression backend. NOT containment.
        run = await observe(executorFile, config.profile.executor.args, {
          cwd: workRoot,
          timeoutMs: remainingMs(),
          outputCap: Math.min(request.budget.maxOutputBytes, 1024 * 1024),
          env: {
            PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
            HOME: workRoot,
            TMPDIR: workRoot,
            COMPANION_JOB_FILE: jobFile,
            COMPANION_MODEL_TOKEN: "dummy-bearer-not-a-secret",
          },
        });
      }

      if (controlCancelled && !deadlineFired) {
        outcome = {
          raw: rawResult(
            request,
            "cancelled",
            false,
            emptyReport("companion bridge: cancelled"),
          ),
          storedExit: 143,
        };
      } else if (deadlineFired || run.timedOut) {
        outcome = errorOutcome("companion bridge: timed out", [], 4);
      } else if (run.code !== 0) {
        if (process.env.PI_ORCH_DEBUG_LOG) {
          try {
            writeFileSync(process.env.PI_ORCH_DEBUG_LOG, JSON.stringify(run));
          } catch {
            /* debug only */
          }
        }
        outcome = errorOutcome(
          "companion bridge: executor failed",
          [],
          10,
          executorFailureDiagnostics(workRoot, run),
        );
        // The report frame has a total byte allowance, not just per-entry
        // limits. Drop diagnostics (lowest value last) until the failure
        // result fits so low-output-budget jobs keep exit 10 and status
        // "error" instead of falling back to an internal error.
        const diagnosticCap = resultLineCap(request, config) - 64;
        while (
          outcome.raw.report.unresolved.length > 0 &&
          Buffer.byteLength(`${JSON.stringify(outcome.raw)}\n`, "utf8") >
            diagnosticCap
        ) {
          outcome.raw.report.unresolved.pop();
        }
      } else {
        const validation = await validateCandidateChanges({
          snapshot,
          expectedManifestDigest: config.sealed.manifestDigest,
          candidateRoot: workRoot,
          mode: request.mode,
          allowedEditPaths: request.relevantPaths,
          generatedScratchRoots: config.profile.scratchPaths,
        });
        if (!validation.ok) {
          outcome = errorOutcome(
            "companion bridge: candidate scope violation",
            [],
            10,
            validation.rejected,
          );
        } else {
          const validatedArtifactDigest = validation.artifact.artifactDigest;
          const artifactDoc = {
            schemaVersion: 2,
            executionId: request.executionId,
            taskHash: request.taskHash,
            baseManifestDigest: validation.artifact.baseManifestDigest,
            profileFingerprint: effective.fingerprint,
            sourceRevision: effective.sourceRevision,
            changeCount: validation.artifact.changeCount,
            changes: validation.artifact.changes,
          };
          const artifactBytes = Buffer.from(`${JSON.stringify(artifactDoc)}\n`);
          if (
            artifactBytes.length > config.profile.limits.maxArtifactBytes ||
            artifactBytes.length > config.storage.maxArtifactBytes
          ) {
            outcome = {
              raw: rawResult(
                request,
                "unknown",
                false,
                emptyReport("companion bridge: artifact publication invalid"),
              ),
              storedExit: 1,
            };
          } else {
            writeFileSync(join(runDir, "artifact.json"), artifactBytes, {
              mode: 0o600,
            });
            const checks = [];
            let stoppedEarly = false;
            for (
              let index = 0;
              index < request.requiredChecks.length;
              index += 1
            ) {
              const id = request.requiredChecks[index];
              if (controlCancelled && !deadlineFired) break;
              if (deadlineFired || remainingMs() < 1000) {
                stoppedEarly = true;
                break;
              }
              const check = config.profile.checks[id];
              const checkRuntime = Math.min(
                remainingMs(),
                config.profile.limits.maxDurationMs,
              );
              let checkRun;
              if (config.profile.executionBackend === "confined") {
                const scratchRoot = join(runDir, `check-${index}`);
                mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
                chmodSync(scratchRoot, 0o700);
                const built = buildCheckCommand(
                  config.profile,
                  { workRoot, scratchRoot },
                  checkUnit(request, index),
                  check,
                );
                currentUnit = checkUnit(request, index);
                checkRun = await observe(built.command, built.args, {
                  timeoutMs: checkRuntime,
                  outputCap: Math.min(
                    request.budget.maxOutputBytes,
                    1024 * 1024,
                  ),
                });
              } else {
                checkRun = await observe(check.executable, check.args, {
                  cwd: workRoot,
                  timeoutMs: checkRuntime,
                  outputCap: Math.min(
                    request.budget.maxOutputBytes,
                    1024 * 1024,
                  ),
                  env: {
                    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
                    HOME: workRoot,
                    TMPDIR: workRoot,
                  },
                });
              }
              if (controlCancelled && !deadlineFired) break;
              const outputMatched =
                checkRun.code === check.expectExitCode &&
                (check.expectStdoutIncludes === undefined ||
                  checkRun.stdout.includes(check.expectStdoutIncludes));
              checks.push({
                id,
                exitCode: checkRun.timedOut ? 4 : checkRun.code,
                timedOut: checkRun.timedOut,
                outputMatched,
              });
              if (checkRun.timedOut || !outputMatched) {
                stoppedEarly = true;
                break;
              }
            }

            if (controlCancelled && !deadlineFired) {
              outcome = {
                raw: rawResult(
                  request,
                  "cancelled",
                  false,
                  emptyReport("companion bridge: cancelled"),
                  { checks },
                ),
                storedExit: 143,
              };
            } else if (stoppedEarly || deadlineFired) {
              outcome = errorOutcome(
                deadlineFired
                  ? "companion bridge: timed out"
                  : "companion bridge: check failed",
                checks,
                deadlineFired ? 4 : 10,
              );
            } else {
              const after = await verifySealedWorkspaceSnapshot(snapshot, {
                expectedManifestDigest: config.sealed.manifestDigest,
              });
              if (!after.ok) {
                outcome = errorOutcome(
                  "companion bridge: sealed snapshot changed after checks",
                  checks,
                  12,
                  ["blocked: snapshot content"],
                );
              } else {
                // Operator checks run with /work bound writable. Re-validate the
                // candidate AFTER every check, before any bytes are retained:
                // a check must not be able to change or mask the deliverable
                // between validation and retention.
                const finalValidation = await validateCandidateChanges({
                  snapshot,
                  expectedManifestDigest: config.sealed.manifestDigest,
                  candidateRoot: workRoot,
                  mode: request.mode,
                  allowedEditPaths: request.relevantPaths,
                  generatedScratchRoots: config.profile.scratchPaths,
                });
                if (!finalValidation.ok) {
                  outcome = errorOutcome(
                    "companion bridge: candidate scope violation",
                    checks,
                    10,
                    finalValidation.rejected,
                  );
                } else if (
                  finalValidation.artifact.artifactDigest !==
                  validatedArtifactDigest
                ) {
                  outcome = errorOutcome(
                    "companion bridge: candidate changed during operator checks",
                    checks,
                    10,
                    ["blocked: candidate changed during checks"],
                  );
                } else {
                  const changes = finalValidation.artifact.changes;
                  const observation = readGuestObservation(workRoot);
                  const guestExecutionEvidence = evaluateGuestExecution(
                    observation,
                    config.profile.executor.kind === "real-pi",
                  );
                  if (!guestExecutionEvidence.ok) {
                    // The guest report is not authority. A failed or missing
                    // report may conservatively downgrade a run for reliability;
                    // it is never promoted into host attestation.
                    outcome = guestExecutionEvidence.missing
                      ? {
                          raw: rawResult(
                            request,
                            "unknown",
                            false,
                            {
                              summary:
                                "companion bridge: guest execution evidence missing",
                              files: [],
                              findings: reportFindings(observation),
                              unresolved: [
                                "blocked: guest execution evidence (guest-reported, unattested)",
                              ],
                            },
                            { checks },
                          ),
                          storedExit: 1,
                        }
                      : errorOutcome(
                          "companion bridge: guest execution did not complete reliably",
                          checks,
                          10,
                          [
                            "blocked: guest execution did not complete reliably (guest-reported, unattested)",
                          ],
                        );
                    if (outcome.raw.report.findings.length === 0) {
                      outcome.raw.report.findings = reportFindings(observation);
                    }
                  } else {
                    const findings = reportFindings(
                      observation,
                      changes
                        .slice(0, 8)
                        .map((change) => `${change.kind} ${change.path}`),
                    );
                    try {
                      retainCandidateChanges(
                        workRoot,
                        changes,
                        join(runDir, "candidate"),
                        artifactBytes.length,
                        Math.min(
                          config.profile.limits.maxArtifactBytes,
                          config.storage.maxArtifactBytes,
                        ),
                      );
                      // Base evidence is source-sized, not artifact-sized: a
                      // valid deletion can reference a file far larger than
                      // the 256 KiB artifact cap. The sealed snapshot already
                      // fits maxSourceBytes. retainBaseChanges caps each
                      // retained base file at maxSourceBytes and the aggregate
                      // retained bytes at that same maxSourceBytes budget.
                      retainBaseChanges(
                        snapshot.snapshotRoot,
                        changes,
                        join(runDir, "base"),
                        config.profile.limits.maxSourceBytes,
                      );
                    } catch {
                      throw new Error("candidate retention invalid");
                    }
                    // `verified` here is ONLY the fixed host-check/scope/artifact
                    // result; the guest worker report stays unattested.
                    const summary =
                      request.mode === "write"
                        ? `sealed trial completed: ${changes.length} host-checked change(s); guest execution guest-reported/unattested`
                        : "sealed read-only trial completed; guest execution guest-reported/unattested";
                    const artifact = {
                      sha256: sha256(artifactBytes),
                      entryCount: changes.length,
                      bytes: artifactBytes.length,
                    };
                    const raw = rawResult(
                      request,
                      "done",
                      true,
                      { summary, files: [], findings, unresolved: [] },
                      { checks, artifact },
                    );
                    try {
                      validateWireResult(raw, request.requiredChecks);
                      outcome = { raw, storedExit: 0, artifactBytes };
                    } catch {
                      outcome = errorOutcome(
                        "companion bridge: result validation failed",
                        checks,
                        10,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    clearTimeout(deadlineTimer);
  } catch (error) {
    outcome = {
      raw: rawResult(
        request,
        "unknown",
        false,
        emptyReport("companion bridge: internal error"),
      ),
      storedExit: 1,
    };
    void error;
  }

  try {
    finalize(outcome.raw, outcome.storedExit, outcome.artifactBytes);
  } catch {
    try {
      finalize(
        rawResult(
          request,
          "unknown",
          false,
          emptyReport("companion bridge: internal error"),
        ),
        1,
      );
    } catch {
      exitWith(STDERR_FD, `${MSG_INTERNAL}\n`, EXIT_INTERNAL);
    }
  }
  try {
    if (controlStream !== null) controlStream.destroy();
    journal.close();
  } catch {
    // Diagnostics only after a finalized line.
  }
  process.exit(EXIT_OK);
}

const invokedAsCli = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  main().catch(() => {
    try {
      writeSync(2, `${MSG_INTERNAL}\n`);
    } catch {
      // Best effort.
    }
    process.exit(EXIT_INTERNAL);
  });
}
