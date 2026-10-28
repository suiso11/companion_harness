// Read-only review of the candidate bytes a completed write trial retained.
//
// The bridge freezes <stateDir>/runs/<executionId>/artifact.json and
// candidate/<path> after every host check passed. This module re-verifies that
// retained tree against the host-checked report digest and the trial's frozen
// grant scopes, then renders a bounded unified diff. It never trusts the
// artifact or candidate tree by itself and never writes to them.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TrialConfig } from "./config.js";

export const TRIAL_DIFF_MAX_BYTES = 64 * 1024;
const ARTIFACT_MAX_BYTES = 1024 * 1024;
const CANDIDATE_FILE_MAX_BYTES = 16 * 1024 * 1024;
const CHANGES_MAX = 1000;
const GIT_TIMEOUT_MS = 5000;

export type TrialCandidateErrorCode =
  | "candidate_unavailable"
  | "candidate_digest_mismatch"
  | "base_mismatch";

export class TrialCandidateError extends Error {
  readonly code: TrialCandidateErrorCode;
  constructor(code: TrialCandidateErrorCode) {
    super(code);
    this.name = "TrialCandidateError";
    this.code = code;
  }
}

export interface TrialCandidateChangeView {
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
  readonly size: number;
  readonly modeChanged: boolean;
}

export interface TrialCandidateView {
  readonly changes: readonly TrialCandidateChangeView[];
  readonly diff: string;
  readonly truncated: boolean;
}

interface ArtifactChange {
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
  readonly baseSha256: string | null;
  readonly candidateSha256: string | null;
  readonly baseMode: number | null;
  readonly candidateMode: number | null;
  readonly size: number;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readNoFollowRegular(path: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new TrialCandidateError("candidate_unavailable");
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size < 0 || opened.size > maxBytes) {
      throw new TrialCandidateError("candidate_unavailable");
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read <= 0) throw new TrialCandidateError("candidate_unavailable");
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) {
      throw new TrialCandidateError("candidate_unavailable");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Read a path whose final component must be a regular non-symlink file and
 * whose ancestors below `root` must be real directories (no symlink swaps). */
function readBeneath(root: string, relPath: string, maxBytes: number): Buffer {
  const segments = relPath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] as string);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined)
      throw new TrialCandidateError("candidate_unavailable");
    if (stat.isSymbolicLink()) {
      throw new TrialCandidateError("candidate_unavailable");
    }
    const last = index === segments.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      throw new TrialCandidateError("candidate_unavailable");
    }
  }
  return readNoFollowRegular(current, maxBytes);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel !== "" &&
    !rel.startsWith(`..${sep}`) &&
    rel !== ".." &&
    !isAbsolute(rel)
  );
}

function realDirectory(path: string, code: TrialCandidateErrorCode): string {
  try {
    const real = realpathSync(path);
    if (!lstatSync(real).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new TrialCandidateError(code);
    }
    return real;
  } catch (error) {
    if (error instanceof TrialCandidateError) throw error;
    throw new TrialCandidateError(code);
  }
}

function normalizeRelativePath(path: unknown): string | null {
  if (typeof path !== "string" || path.length < 1 || path.length > 512)
    return null;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/"))
    return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..")
      return null;
  }
  return path;
}

function parseHex64(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

function parseMode(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0o7777
    ? value
    : null;
}

function parseArtifactChange(raw: unknown): ArtifactChange | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;
  const path = normalizeRelativePath(record.path);
  const kindRaw = record.kind;
  const kind =
    kindRaw === "add" || kindRaw === "create"
      ? "create"
      : kindRaw === "modify" || kindRaw === "delete"
        ? kindRaw
        : null;
  if (path === null || kind === null) return null;
  const baseSha256 = parseHex64(record.baseSha256);
  const candidateSha256 = parseHex64(record.candidateSha256);
  const baseMode = record.baseMode === null ? null : parseMode(record.baseMode);
  const candidateMode =
    record.candidateMode === null ? null : parseMode(record.candidateMode);
  const size = record.size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > CANDIDATE_FILE_MAX_BYTES
  ) {
    return null;
  }
  if (kind === "create") {
    if (baseSha256 !== null || baseMode !== null) return null;
    if (candidateSha256 === null) return null;
  } else if (kind === "modify") {
    if (baseSha256 === null || candidateSha256 === null) return null;
  } else {
    if (baseSha256 === null || candidateSha256 !== null) return null;
    if (size !== 0) return null;
  }
  return {
    path,
    kind,
    baseSha256,
    candidateSha256,
    baseMode,
    candidateMode,
    size,
  };
}

interface ParsedArtifact {
  readonly sourceRevision: string;
  readonly changes: readonly ArtifactChange[];
}

function parseArtifact(bytes: Buffer, executionId: string): ParsedArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TrialCandidateError("candidate_unavailable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 2 || record.executionId !== executionId) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  if (
    typeof record.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.sourceRevision)
  ) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  if (!Array.isArray(record.changes) || record.changes.length > CHANGES_MAX) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  if (record.changeCount !== record.changes.length) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const changes: ArtifactChange[] = [];
  const seen = new Set<string>();
  for (const raw of record.changes) {
    const change = parseArtifactChange(raw);
    if (change === null || seen.has(change.path)) {
      throw new TrialCandidateError("candidate_unavailable");
    }
    seen.add(change.path);
    changes.push(change);
  }
  return { sourceRevision: record.sourceRevision, changes };
}

function scopeMatches(scope: string, path: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

function inScopes(scopes: readonly string[], path: string): boolean {
  return scopes.some((scope) => scopeMatches(scope, path));
}

function readOperatorStateDir(templatePath: string): string {
  const bytes = readNoFollowRegular(templatePath, 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TrialCandidateError("candidate_unavailable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const stateDir = (parsed as Record<string, unknown>).stateDir;
  if (
    typeof stateDir !== "string" ||
    stateDir.length < 1 ||
    stateDir.length > 4096 ||
    stateDir.includes("\0") ||
    !isAbsolute(stateDir)
  ) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  return stateDir;
}

/** Base bytes come from the frozen source snapshot the trial started from.
 * `sourceRevision` is a synthetic sealed-manifest revision (not a git object),
 * so `git show` can never resolve it. The snapshot is verified byte-for-byte
 * against the clean export when the frozen root is built, and the workspace is
 * materialized from the same tree. */
function baseBytes(snapshotRoot: string, path: string): Buffer | null {
  try {
    return readBeneath(snapshotRoot, path, CANDIDATE_FILE_MAX_BYTES);
  } catch {
    return null;
  }
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.includes(0);
}

function unifiedDiff(
  path: string,
  kind: "create" | "modify" | "delete",
  base: Buffer,
  candidate: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (looksBinary(base) || looksBinary(candidate)) {
    return {
      text: `Binary files a/${path} and b/${path} differ\n`,
      truncated: false,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "companion-candidate-diff-"));
  try {
    const aPath = join(dir, "a");
    const bPath = join(dir, "b");
    writeFileSync(aPath, kind === "create" ? Buffer.alloc(0) : base, {
      mode: 0o600,
    });
    writeFileSync(bPath, kind === "delete" ? Buffer.alloc(0) : candidate, {
      mode: 0o600,
    });
    const result = spawnSync(
      "git",
      [
        "-c",
        "diff.external=",
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--unified=3",
        aPath,
        bPath,
      ],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        // Worst case (every line changed in a max-size file): base + candidate
        // bytes plus one prefix byte per line on each side. Keep this above
        // that bound so an oversized diff is truncated by the 64 KiB limit
        // below instead of failing as `candidate_unavailable`.
        maxBuffer: CANDIDATE_FILE_MAX_BYTES * 3 + 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: tmpdir(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    // `git diff --no-index` exits 1 when the files differ. Anything else means
    // no trustworthy rendering was produced; fail closed instead of returning
    // an empty diff.
    if (
      result.error !== undefined ||
      (result.status !== 0 && result.status !== 1) ||
      typeof result.stdout !== "string"
    ) {
      throw new TrialCandidateError("candidate_unavailable");
    }
    let text = result.stdout;
    text = text.replaceAll(aPath, `/${path}`).replaceAll(bPath, `/${path}`);
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
      let end = buf.length;
      while (end > 0 && ((buf[end - 1] ?? 0) & 0xc0) === 0x80) end -= 1;
      text = buf.subarray(0, end).toString("utf8");
      return { text, truncated: true };
    }
    return { text, truncated: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface LoadTrialCandidateInput {
  readonly executionId: string;
  readonly trial: TrialConfig;
  readonly expectedArtifactSha256: string;
  readonly literalPatchPaths: readonly string[];
}

/** Verify + render the retained candidate for a completed trial. */
export function loadTrialCandidate(
  input: LoadTrialCandidateInput,
): TrialCandidateView {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.executionId,
    )
  ) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedArtifactSha256)) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const stateDir = readOperatorStateDir(
    input.trial.runner.bridgeConfigTemplatePath,
  );
  const realState = realDirectory(stateDir, "candidate_unavailable");
  const runsDir = realDirectory(
    join(realState, "runs"),
    "candidate_unavailable",
  );
  if (!isInside(realState, runsDir)) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const runDir = realDirectory(
    join(runsDir, input.executionId),
    "candidate_unavailable",
  );
  if (!isInside(runsDir, runDir)) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const artifactBytes = readNoFollowRegular(
    join(runDir, "artifact.json"),
    ARTIFACT_MAX_BYTES,
  );
  if (sha256(artifactBytes) !== input.expectedArtifactSha256) {
    throw new TrialCandidateError("candidate_digest_mismatch");
  }
  const artifact = parseArtifact(artifactBytes, input.executionId);
  if (artifact.sourceRevision !== input.trial.sourceRevision) {
    throw new TrialCandidateError("candidate_unavailable");
  }
  const snapshotRoot = realDirectory(
    resolve(input.trial.sourceRepoPath),
    "base_mismatch",
  );
  // Deletion-only artifacts retain no candidate tree; the bridge never creates
  // `candidate` when every entry is a deletion.
  const candidateRoot = artifact.changes.some(
    (change) => change.kind !== "delete",
  )
    ? realDirectory(join(runDir, "candidate"), "candidate_unavailable")
    : null;

  const changes: TrialCandidateChangeView[] = [];
  const parts: string[] = [];
  let truncated = false;
  let remaining = TRIAL_DIFF_MAX_BYTES;
  for (const change of artifact.changes) {
    if (
      !inScopes(input.trial.allowedPaths, change.path) ||
      !inScopes(input.literalPatchPaths, change.path)
    ) {
      throw new TrialCandidateError("candidate_unavailable");
    }
    let base: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    if (change.kind !== "create") {
      const bytes = baseBytes(snapshotRoot, change.path);
      if (bytes === null) throw new TrialCandidateError("base_mismatch");
      if (sha256(bytes) !== change.baseSha256) {
        throw new TrialCandidateError("base_mismatch");
      }
      base = bytes;
    }
    let candidate: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    if (change.kind !== "delete") {
      if (candidateRoot === null) {
        throw new TrialCandidateError("candidate_unavailable");
      }
      const bytes = readBeneath(
        candidateRoot,
        change.path,
        CANDIDATE_FILE_MAX_BYTES,
      );
      if (
        bytes.length !== change.size ||
        sha256(bytes) !== change.candidateSha256
      ) {
        throw new TrialCandidateError("candidate_digest_mismatch");
      }
      candidate = bytes;
    }
    changes.push({
      path: change.path,
      kind: change.kind,
      size: change.size,
      // Compare executable status, not the confinement-normalized private
      // copy mode (0644 -> 0600), which is not a deliverable mode change.
      modeChanged:
        change.baseMode !== null &&
        change.candidateMode !== null &&
        (change.baseMode & 0o111) !== (change.candidateMode & 0o111),
    });
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const rendered = unifiedDiff(
      change.path,
      change.kind,
      base,
      candidate,
      remaining,
    );
    if (rendered.text.length > 0) {
      parts.push(rendered.text);
      remaining = Math.max(
        0,
        remaining - Buffer.byteLength(rendered.text, "utf8"),
      );
    }
    if (rendered.truncated) truncated = true;
  }
  return { changes, diff: parts.join(""), truncated };
}
