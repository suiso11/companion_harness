// Trusted sealed workspace for policy-authorized candidate implementation.
//
// This module is deliberately standalone (node builtins only, no database or
// scheduler dependency). It provides the boundary the existing TrialRunner /
// pi-orch bridge reuse before a worker is launched:
//
//   1. createSealedWorkspaceSnapshot: an explicit allowlist copy of approved
//      source roots. Denied directories are never traversed or read. The
//      snapshot is self-contained; the original source root is never handed to
//      a guest.
//   2. verifySealedWorkspaceSnapshot: recomputes the exact on-disk manifest
//      and per-file digests. Tampering (added/missing/changed/symlink/non
//      regular file, unsafe permissions) fails closed.
//   3. validateCandidateChanges: compares a candidate tree against the frozen
//      snapshot. Add/modify/delete outside the trusted edit scope, read-only
//      changes, forbidden paths, symlinks, case collisions, and oversized
//      deliverables are rejected. Declared scratch roots are non-deliverable.
//
// The returned artifact is metadata only (path/kind/size/mode/sha256). It never
// embeds candidate file bytes, so private/secret content cannot leak through
// the artifact frame. Base hashes are included for a later, separately
// reviewed host apply.
//
// Dependency/check confinement contract (intentionally NOT implemented here):
// the module never copies, mounts, or symlinks host node_modules into a guest.
// A later integration must accept a trusted-host-approved dependency depot
// (canonical absolute root + pinned content digest + explicit package closure)
// and bind it read-only to the check context; scratch outputs must be separate
// private declared roots. Network install and writable host node_modules are
// forbidden, and a missing offline closure is `blocked: dependencies` rather
// than a skipped/faked check. This slice exposes no API that could create a
// fake dependency closure.
//
// Numeric limits are trusted-host options with conservative defaults; a model
// cannot select unlimited values through this module.

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;
export const DEFAULT_MAX_FILES = 20_000;

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_WALK_DEPTH = 256;
const SAFE_FILE_MODE_MASK = 0o777;
const SPECIAL_MODE_BITS = 0o7000;
const SNAPSHOT_DIR_NAME = "snapshot";
const MANIFEST_FILE_NAME = "workspace-manifest.json";
const SCHEMA_VERSION = 1;

export interface WorkspaceManifestEntry {
  /** POSIX-relative path inside the snapshot. */
  readonly path: string;
  readonly size: number;
  /** Original source permission bits (low 12 bits) for a future apply. */
  readonly mode: number;
  readonly sha256: string;
}

export interface SealedSourceIdentity {
  readonly canonicalRoot: string;
  readonly manifestDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /**
   * The identity is content-addressed, so legitimate uncommitted source bytes
   * are included. It is never a HEAD-only claim.
   */
  readonly identityKind: "content-manifest";
  readonly includesUncommittedBytes: true;
}

export interface SealedWorkspaceSnapshot {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly canonicalRoot: string;
  readonly snapshotRoot: string;
  readonly manifestPath: string;
  readonly manifest: readonly WorkspaceManifestEntry[];
  readonly manifestDigest: string;
  readonly sourceIdentity: SealedSourceIdentity;
  readonly maxSourceBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxFiles: number;
}

export interface CreateSealedWorkspaceOptions {
  /** Trusted absolute source root. Symlink aliases are canonicalized once. */
  readonly sourceRoot: string;
  /** New empty output directory; the snapshot is created below it at 0700. */
  readonly outputDir: string;
  /** Explicit relative source roots (directories only). Overlaps are invalid. */
  readonly allowedRoots: readonly string[];
  /** Explicit relative top-level files (e.g. package.json, .gitignore). */
  readonly allowedTopLevelFiles: readonly string[];
  readonly maxBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxFiles?: number;
  readonly signal?: AbortSignal;
  /** Test seam; defaults to the real platform. Trusted host only. */
  readonly caseInsensitiveFs?: boolean;
  /**
   * Test seam; defaults to the real platform. Trusted host only. Creation is
   * only supported on POSIX hosts where mode/ownership/no-follow semantics are
   * enforceable; any other platform fails closed before touching the FS.
   */
  readonly platform?: NodeJS.Platform;
}

export type CandidateChangeKind = "add" | "modify" | "delete";

export interface CandidateChange {
  readonly path: string;
  readonly kind: CandidateChangeKind;
  readonly baseSha256: string | null;
  readonly baseMode: number | null;
  readonly candidateSha256: string | null;
  readonly candidateMode: number | null;
  readonly size: number;
}

export interface CandidateArtifact {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly baseManifestDigest: string;
  readonly baseFileCount: number;
  readonly changes: readonly CandidateChange[];
  readonly changeCount: number;
  readonly changedSourceBytes: number;
  readonly artifactDigest: string;
}

export interface ValidateCandidateOptions {
  readonly snapshot: SealedWorkspaceSnapshot;
  /**
   * Digest pinned by host policy/grant. Required; the snapshot object alone is
   * not a trust anchor after deserialization.
   */
  readonly expectedManifestDigest: string;
  readonly candidateRoot: string;
  readonly mode: "read_only" | "write";
  /** Candidate-relative file/subtree scopes allowed to change. */
  readonly allowedEditPaths: readonly string[];
  /** Candidate-relative build/output roots excluded from the deliverable. */
  readonly generatedScratchRoots?: readonly string[];
  readonly signal?: AbortSignal;
  /** Test seam; defaults to the real platform. Trusted host only. */
  readonly caseInsensitiveFs?: boolean;
  /** Test seam; defaults to the real platform. Trusted host only. */
  readonly platform?: NodeJS.Platform;
}

export type CandidateValidationResult =
  | { readonly ok: true; readonly artifact: CandidateArtifact }
  | { readonly ok: false; readonly rejected: readonly string[] };

export type WorkspaceViolationCode =
  | "invalid_input"
  | "unsupported_platform"
  | "source_escape"
  | "symlink_rejected"
  | "nonregular_rejected"
  | "depth_exceeded"
  | "forbidden_path"
  | "output_overlap"
  | "byte_budget_exceeded"
  | "artifact_budget_exceeded"
  | "manifest_mismatch"
  | "snapshot_tampered"
  | "scope_violation"
  | "read_only_violation"
  | "case_ambiguous";

export class SealedWorkspaceError extends Error {
  readonly code: WorkspaceViolationCode;

  constructor(code: WorkspaceViolationCode, message: string) {
    super(message);
    this.name = "SealedWorkspaceError";
    this.code = code;
  }
}

interface CollectedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mode: number;
}

const DENIED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".ci",
  ".git",
  ".hg",
  ".idea",
  ".next",
  ".nuxt",
  ".nyc_output",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".svn",
  ".tmp",
  ".turbo",
  ".venv",
  ".vscode",
  ".yarn",
  "__pycache__",
  "backup",
  "backups",
  "build",
  "cache",
  "coverage",
  "data",
  "dist",
  "log",
  "logs",
  "node_modules",
  "out",
  "playwright-report",
  "private",
  "runtime",
  "secret",
  "secrets",
  "target",
  "temp",
  "test-results",
  "tmp",
  "venv",
]);

function isDeniedDirectoryName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DENIED_DIRECTORY_NAMES.has(lower) ||
    lower.startsWith(".c12") ||
    lower.startsWith(".wt-") ||
    lower.startsWith(".wt.")
  );
}

function isDeniedFileName(relativePath: string): boolean {
  const slash = relativePath.lastIndexOf("/");
  const base = (
    slash >= 0 ? relativePath.slice(slash + 1) : relativePath
  ).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (
    base === ".npmrc" ||
    base === ".netrc" ||
    base === ".git-credentials" ||
    base === ".pgpass" ||
    base === "id_dsa" ||
    base === "id_ecdsa" ||
    base === "id_ed25519" ||
    base === "id_rsa"
  ) {
    return true;
  }
  if (
    base.endsWith(".sqlite-wal") ||
    base.endsWith(".sqlite-shm") ||
    base.endsWith(".db-journal")
  ) {
    return true;
  }
  return /\.(pem|key|p12|pfx|kdbx|ovpn|sqlite|sqlite3|db|db3|log|tsbuildinfo|secret|secrets|credential|credentials|token|password)$/.test(
    base,
  );
}

function requireRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0")
  ) {
    throw new SealedWorkspaceError(
      "invalid_input",
      `${label} must be a non-empty relative path`,
    );
  }
  if (isAbsolute(value) || value.includes("\\")) {
    throw new SealedWorkspaceError(
      "invalid_input",
      `${label} must not be absolute or use backslashes`,
    );
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new SealedWorkspaceError(
      "invalid_input",
      `${label} must not be the root itself`,
    );
  }
  for (const segment of trimmed.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new SealedWorkspaceError(
        "invalid_input",
        `${label} must not contain empty, "." or ".." segments`,
      );
    }
  }
  return trimmed;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function isScopeMatch(scope: string, relativePath: string): boolean {
  return scope === relativePath || relativePath.startsWith(`${scope}/`);
}

function hasSpecialModeBits(mode: number): boolean {
  return (mode & SPECIAL_MODE_BITS) !== 0;
}

function rejectUnsafeMode(mode: number, label: string): void {
  if (hasSpecialModeBits(mode)) {
    throw new SealedWorkspaceError(
      "nonregular_rejected",
      `setuid/setgid/sticky permissions rejected: ${label}`,
    );
  }
}

function safeFileMode(mode: number): number {
  return mode & SAFE_FILE_MODE_MASK;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SealedWorkspaceError(
      "invalid_input",
      `${label} must be a 64-character lowercase hex digest`,
    );
  }
  return value;
}

function ensureDistinctCase(
  paths: readonly string[],
  label: string,
  caseInsensitiveFs: boolean,
): void {
  if (!caseInsensitiveFs) {
    return;
  }
  const seen = new Set<string>();
  for (const value of paths) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      throw new SealedWorkspaceError(
        "case_ambiguous",
        `${label} contains paths that collide case-insensitively: ${value}`,
      );
    }
    seen.add(key);
  }
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function manifestEntriesDigest(
  entries: readonly WorkspaceManifestEntry[],
): string {
  const lines = entries.map(
    (entry) =>
      `${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256}`,
  );
  return sha256Hex(lines.join("\n"));
}

function executableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function snapshotFileMode(mode: number): number {
  return executableMode(mode) ? 0o700 : 0o600;
}

function checkAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/**
 * The sealed workspace relies on POSIX mode bits, ownership and
 * O_NOFOLLOW/lstat semantics that plain Windows filesystem APIs do not
 * provide. Fail closed explicitly on unsupported hosts BEFORE any directory,
 * copy, or manifest is created instead of pretending an ACL is equivalent.
 * Darwin keeps working when its POSIX semantics are available; the actual
 * auto-dispatch runtime remains Linux-only.
 */
function requireSupportedSealedWorkspacePlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux" && platform !== "darwin") {
    throw new SealedWorkspaceError(
      "unsupported_platform",
      `sealed workspace requires POSIX mode/ownership/no-follow semantics; unsupported platform: ${platform}`,
    );
  }
}

async function ensureEmptyOutputDirectory(outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const canonicalOutput = await realpath(outputDir);
  const entries = await readdir(canonicalOutput);
  if (entries.length > 0) {
    throw new SealedWorkspaceError("invalid_input", "outputDir must be empty");
  }
  return canonicalOutput;
}

async function collectSourceFiles(
  canonicalRoot: string,
  allowedRoots: readonly string[],
  allowedTopLevelFiles: readonly string[],
  maxFiles: number,
  caseInsensitiveFs: boolean,
  signal: AbortSignal | undefined,
): Promise<CollectedFile[]> {
  const files = new Map<string, CollectedFile>();

  const addFile = async (
    absolutePath: string,
    relativePath: string,
  ): Promise<void> => {
    checkAborted(signal);
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      throw new SealedWorkspaceError(
        "symlink_rejected",
        `source symlink rejected: ${relativePath}`,
      );
    }
    if (!entryStat.isFile()) {
      throw new SealedWorkspaceError(
        "nonregular_rejected",
        `source entry is not a regular file: ${relativePath}`,
      );
    }
    if (isDeniedFileName(relativePath)) {
      return;
    }
    rejectUnsafeMode(entryStat.mode, relativePath);
    if (files.size >= maxFiles) {
      throw new SealedWorkspaceError(
        "byte_budget_exceeded",
        `source file count exceeds ${maxFiles}`,
      );
    }
    files.set(relativePath, {
      absolutePath,
      relativePath,
      size: entryStat.size,
      mode: safeFileMode(entryStat.mode),
    });
  };

  const walk = async (
    absoluteDir: string,
    relativeDir: string,
    depth: number,
  ): Promise<void> => {
    checkAborted(signal);
    if (depth > MAX_WALK_DEPTH) {
      throw new SealedWorkspaceError(
        "depth_exceeded",
        `source tree exceeds ${MAX_WALK_DEPTH} directory levels: ${relativeDir}`,
      );
    }
    const names = await readdir(absoluteDir);
    names.sort();
    for (const name of names) {
      checkAborted(signal);
      const absolutePath = join(absoluteDir, name);
      const relativePath =
        relativeDir.length === 0 ? name : `${relativeDir}/${name}`;
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new SealedWorkspaceError(
          "symlink_rejected",
          `source symlink rejected: ${relativePath}`,
        );
      }
      if (entryStat.isDirectory()) {
        if (isDeniedDirectoryName(name)) {
          continue;
        }
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new SealedWorkspaceError(
          "nonregular_rejected",
          `source entry is not a regular file: ${relativePath}`,
        );
      }
      if (isDeniedFileName(relativePath)) {
        continue;
      }
      rejectUnsafeMode(entryStat.mode, relativePath);
      if (files.size >= maxFiles) {
        throw new SealedWorkspaceError(
          "byte_budget_exceeded",
          `source file count exceeds ${maxFiles}`,
        );
      }
      files.set(relativePath, {
        absolutePath,
        relativePath,
        size: entryStat.size,
        mode: safeFileMode(entryStat.mode),
      });
    }
  };

  const normalizedAllowedRoots: string[] = [];
  for (let index = 0; index < allowedRoots.length; index += 1) {
    normalizedAllowedRoots.push(
      requireRelativePath(allowedRoots[index], `allowedRoots[${index}]`),
    );
  }
  ensureDistinctCase(normalizedAllowedRoots, "allowedRoots", caseInsensitiveFs);

  for (let index = 0; index < allowedRoots.length; index += 1) {
    const root = requireRelativePath(
      allowedRoots[index],
      `allowedRoots[${index}]`,
    );
    for (let other = 0; other < index; other += 1) {
      const previous = requireRelativePath(
        allowedRoots[other],
        `allowedRoots[${other}]`,
      );
      if (isScopeMatch(previous, root) || isScopeMatch(root, previous)) {
        throw new SealedWorkspaceError(
          "invalid_input",
          `allowedRoots overlap: ${previous} and ${root}`,
        );
      }
    }
    if (isDeniedDirectoryName(root.split("/")[0] ?? root)) {
      throw new SealedWorkspaceError(
        "forbidden_path",
        `allowed root is a denied directory: ${root}`,
      );
    }
    const absoluteRoot = join(canonicalRoot, ...root.split("/"));
    const rootStat = await lstat(absoluteRoot).catch(() => null);
    if (rootStat === null) {
      throw new SealedWorkspaceError(
        "invalid_input",
        `allowed root does not exist: ${root}`,
      );
    }
    if (rootStat.isSymbolicLink()) {
      throw new SealedWorkspaceError(
        "symlink_rejected",
        `allowed root symlink rejected: ${root}`,
      );
    }
    if (rootStat.isFile()) {
      // A literal file scope (for example `src/app.ts`) is an explicit,
      // exact allowlist entry, not a directory walk. No path component may
      // be a symlink: realpath must resolve to the same canonical path built
      // from the canonical source root. Denied file names and a denied first
      // directory segment are rejected exactly like other roots.
      if (isDeniedFileName(root)) {
        throw new SealedWorkspaceError(
          "forbidden_path",
          `allowed root is a denied file: ${root}`,
        );
      }
      const expectedAbsolute = join(canonicalRoot, ...root.split("/"));
      const canonicalFile = await realpath(absoluteRoot).catch(() => null);
      if (canonicalFile === null || canonicalFile !== expectedAbsolute) {
        throw new SealedWorkspaceError(
          "symlink_rejected",
          `allowed root path contains a symlink: ${root}`,
        );
      }
      await addFile(canonicalFile, root);
      continue;
    }
    if (!rootStat.isDirectory()) {
      throw new SealedWorkspaceError(
        "invalid_input",
        `allowed root is not a directory: ${root}`,
      );
    }
    const canonicalAllowedRoot = await realpath(absoluteRoot);
    if (!isPathInside(canonicalAllowedRoot, canonicalRoot)) {
      throw new SealedWorkspaceError(
        "source_escape",
        `allowed root escapes canonical source: ${root}`,
      );
    }
    await walk(canonicalAllowedRoot, root, 0);
  }

  for (let index = 0; index < allowedTopLevelFiles.length; index += 1) {
    const file = requireRelativePath(
      allowedTopLevelFiles[index],
      `allowedTopLevelFiles[${index}]`,
    );
    if (file.includes("/")) {
      throw new SealedWorkspaceError(
        "invalid_input",
        `allowedTopLevelFiles entries must be top-level: ${file}`,
      );
    }
    if (isDeniedFileName(file)) {
      throw new SealedWorkspaceError(
        "forbidden_path",
        `allowedTopLevelFiles entry is denied: ${file}`,
      );
    }
    const absoluteFile = join(canonicalRoot, file);
    const fileStat = await lstat(absoluteFile).catch(() => null);
    if (fileStat === null) {
      continue;
    }
    await addFile(absoluteFile, file);
  }

  return [...files.values()].sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
}

async function copyAndHashFile(
  source: CollectedFile,
  destinationPath: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  checkAborted(signal);
  const handle = await open(
    source.absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== source.size) {
      throw new SealedWorkspaceError(
        "manifest_mismatch",
        `source changed before read: ${source.relativePath}`,
      );
    }
    await mkdir(dirname(destinationPath), {
      recursive: true,
      mode: 0o700,
    });
    const destination = await open(
      destinationPath,
      "wx",
      snapshotFileMode(source.mode),
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let readBytes = 0;
    try {
      for (;;) {
        checkAborted(signal);
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (result.bytesRead === 0) {
          break;
        }
        readBytes += result.bytesRead;
        if (readBytes > source.size) {
          throw new SealedWorkspaceError(
            "manifest_mismatch",
            `source grew while reading: ${source.relativePath}`,
          );
        }
        hash.update(buffer.subarray(0, result.bytesRead));
        let written = 0;
        while (written < result.bytesRead) {
          const writeResult = await destination.write(
            buffer,
            written,
            result.bytesRead - written,
            null,
          );
          written += writeResult.bytesWritten;
        }
      }
      if (readBytes !== source.size) {
        throw new SealedWorkspaceError(
          "manifest_mismatch",
          `source size changed while reading: ${source.relativePath}`,
        );
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new SealedWorkspaceError(
          "manifest_mismatch",
          `source mutated while reading: ${source.relativePath}`,
        );
      }
      return hash.digest("hex");
    } finally {
      await destination.close();
    }
  } finally {
    await handle.close();
  }
}

async function writeAtomicFile(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const temporary = join(
    dirname(filePath),
    `.${MANIFEST_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Create an immutable, filtered copy of the selected source roots.
 * Denied directories are never traversed; denied files are never read.
 */
export async function createSealedWorkspaceSnapshot(
  options: CreateSealedWorkspaceOptions,
): Promise<SealedWorkspaceSnapshot> {
  requireSupportedSealedWorkspacePlatform(options.platform);
  const maxSourceBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxArtifactBytes =
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (
    !Number.isSafeInteger(maxSourceBytes) ||
    maxSourceBytes <= 0 ||
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes <= 0 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles <= 0
  ) {
    throw new SealedWorkspaceError(
      "invalid_input",
      "limits must be positive safe integers",
    );
  }
  const canonicalRoot = await realpath(options.sourceRoot).catch(() => {
    throw new SealedWorkspaceError(
      "invalid_input",
      "sourceRoot does not exist",
    );
  });
  const rootStat = await stat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new SealedWorkspaceError(
      "invalid_input",
      "sourceRoot is not a directory",
    );
  }

  const outputDir = await ensureEmptyOutputDirectory(options.outputDir);
  // Reject an output directory nested anywhere inside the source root, not
  // only inside a selected subtree. The check runs after canonicalization so a
  // symlinked output alias cannot smuggle the snapshot back into the source
  // walk or a later candidate validation.
  if (isPathInside(outputDir, canonicalRoot)) {
    throw new SealedWorkspaceError(
      "output_overlap",
      "outputDir must not be inside the source root",
    );
  }
  const caseInsensitiveFs =
    options.caseInsensitiveFs ?? caseInsensitivePlatform();
  const files = await collectSourceFiles(
    canonicalRoot,
    options.allowedRoots,
    options.allowedTopLevelFiles,
    maxFiles,
    caseInsensitiveFs,
    options.signal,
  );

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (totalBytes > maxSourceBytes) {
      throw new SealedWorkspaceError(
        "byte_budget_exceeded",
        `source exceeds ${maxSourceBytes} bytes`,
      );
    }
  }

  const temporaryRoot = join(
    outputDir,
    `.snapshot.${process.pid}.${randomUUID()}.tmp`,
  );
  const snapshotRoot = join(outputDir, SNAPSHOT_DIR_NAME);
  await mkdir(temporaryRoot, { mode: 0o700 });
  let renamed = false;
  try {
    const manifest: WorkspaceManifestEntry[] = [];
    for (const file of files) {
      checkAborted(options.signal);
      const sha256 = await copyAndHashFile(
        file,
        join(temporaryRoot, ...file.relativePath.split("/")),
        options.signal,
      );
      manifest.push({
        path: file.relativePath,
        size: file.size,
        mode: file.mode,
        sha256,
      });
    }
    manifest.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const manifestDigest = manifestEntriesDigest(manifest);
    await rename(temporaryRoot, snapshotRoot);
    renamed = true;
    const sourceIdentity: SealedSourceIdentity = {
      canonicalRoot,
      manifestDigest,
      fileCount: manifest.length,
      totalBytes,
      identityKind: "content-manifest",
      includesUncommittedBytes: true,
    };
    const manifestPath = join(outputDir, MANIFEST_FILE_NAME);
    const manifestFile = {
      schemaVersion: SCHEMA_VERSION,
      canonicalRoot,
      snapshotRoot,
      manifestDigest,
      sourceIdentity,
      maxSourceBytes,
      maxArtifactBytes,
      maxFiles,
      entries: manifest,
    };
    await writeAtomicFile(
      manifestPath,
      `${JSON.stringify(manifestFile)}\n`,
      0o600,
    );
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      canonicalRoot,
      snapshotRoot,
      manifestPath,
      manifest: Object.freeze(manifest),
      manifestDigest,
      sourceIdentity: Object.freeze(sourceIdentity),
      maxSourceBytes,
      maxArtifactBytes,
      maxFiles,
    });
  } catch (error) {
    if (renamed) {
      await rm(snapshotRoot, { recursive: true, force: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function hashRegularFile(
  absolutePath: string,
  expectedSize: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<string> {
  checkAborted(signal);
  const handle = await open(
    absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new SealedWorkspaceError(
        "nonregular_rejected",
        `not a regular file: ${label}`,
      );
    }
    if (fileStat.size !== expectedSize) {
      throw new SealedWorkspaceError(
        "manifest_mismatch",
        `size mismatch: ${label}`,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let readBytes = 0;
    for (;;) {
      checkAborted(signal);
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) {
        break;
      }
      readBytes += result.bytesRead;
      if (readBytes > expectedSize) {
        throw new SealedWorkspaceError(
          "manifest_mismatch",
          `file grew while reading: ${label}`,
        );
      }
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    if (readBytes !== expectedSize) {
      throw new SealedWorkspaceError(
        "manifest_mismatch",
        `file changed while reading: ${label}`,
      );
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function walkSnapshot(
  snapshotRoot: string,
  expectedCount: number,
  signal: AbortSignal | undefined,
): Promise<Map<string, { size: number; mode: number }>> {
  const files = new Map<string, { size: number; mode: number }>();
  const walk = async (
    absoluteDir: string,
    relativeDir: string,
    depth: number,
  ): Promise<void> => {
    checkAborted(signal);
    if (depth > MAX_WALK_DEPTH) {
      throw new SealedWorkspaceError(
        "depth_exceeded",
        `snapshot tree exceeds ${MAX_WALK_DEPTH} directory levels: ${relativeDir}`,
      );
    }
    const names = await readdir(absoluteDir);
    names.sort();
    for (const name of names) {
      checkAborted(signal);
      const absolutePath = join(absoluteDir, name);
      const relativePath =
        relativeDir.length === 0 ? name : `${relativeDir}/${name}`;
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new SealedWorkspaceError(
          "symlink_rejected",
          `snapshot symlink: ${relativePath}`,
        );
      }
      if (entryStat.isDirectory()) {
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new SealedWorkspaceError(
          "nonregular_rejected",
          `snapshot non-regular file: ${relativePath}`,
        );
      }
      rejectUnsafeMode(entryStat.mode, relativePath);
      if (files.size >= expectedCount) {
        throw new SealedWorkspaceError(
          "manifest_mismatch",
          `unexpected snapshot entry: ${relativePath}`,
        );
      }
      files.set(relativePath, {
        size: entryStat.size,
        mode: safeFileMode(entryStat.mode),
      });
    }
  };
  await walk(snapshotRoot, "", 0);
  return files;
}

function isManifestEntry(value: unknown): value is WorkspaceManifestEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    typeof record.size === "number" &&
    Number.isSafeInteger(record.size) &&
    record.size >= 0 &&
    typeof record.mode === "number" &&
    Number.isSafeInteger(record.mode) &&
    record.mode >= 0 &&
    record.mode <= SAFE_FILE_MODE_MASK &&
    typeof record.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(record.sha256)
  );
}

function manifestEntriesEqual(
  left: readonly WorkspaceManifestEntry[],
  right: readonly WorkspaceManifestEntry[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined ||
      b === undefined ||
      a.path !== b.path ||
      a.size !== b.size ||
      a.mode !== b.mode ||
      a.sha256 !== b.sha256
    ) {
      return false;
    }
  }
  return true;
}

async function readManifestBounded(manifestPath: string): Promise<string> {
  const handle = await open(
    manifestPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_MANIFEST_BYTES) {
      throw new SealedWorkspaceError(
        "manifest_mismatch",
        "manifest file is missing or oversized",
      );
    }
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let readBytes = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) {
        break;
      }
      readBytes += result.bytesRead;
      if (readBytes > MAX_MANIFEST_BYTES) {
        throw new SealedWorkspaceError(
          "manifest_mismatch",
          "manifest file grew while reading",
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    if (readBytes !== fileStat.size) {
      throw new SealedWorkspaceError(
        "manifest_mismatch",
        "manifest file size changed while reading",
      );
    }
    return Buffer.concat(chunks, readBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface VerifySealedWorkspaceOptions {
  /**
   * Digest pinned by host policy/grant (not merely copied from the in-memory
   * snapshot object). Required so a consistent caller-supplied snapshot alone
   * can never establish trust after deserialization.
   */
  readonly expectedManifestDigest: string;
  readonly signal?: AbortSignal;
  /** Test seam; defaults to the real platform. Trusted host only. */
  readonly platform?: NodeJS.Platform;
}

export type VerifySealedWorkspaceResult =
  | { readonly ok: true; readonly manifestDigest: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Recompute the exact snapshot manifest. Any mismatch, extra entry, symlink,
 * non-regular file, or group/world-readable artifact fails closed.
 */
export async function verifySealedWorkspaceSnapshot(
  snapshot: SealedWorkspaceSnapshot,
  options: VerifySealedWorkspaceOptions,
): Promise<VerifySealedWorkspaceResult> {
  try {
    requireSupportedSealedWorkspacePlatform(options.platform);
    checkAborted(options.signal);
    const expectedManifestDigest = requireDigest(
      options.expectedManifestDigest,
      "expectedManifestDigest",
    );
    if (snapshot.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, reason: "unsupported snapshot schemaVersion" };
    }
    if (snapshot.manifestDigest !== expectedManifestDigest) {
      return {
        ok: false,
        reason: "snapshot manifest digest does not match host-pinned digest",
      };
    }
    const identity = snapshot.sourceIdentity;
    const totalBytes = snapshot.manifest.reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    if (
      identity.canonicalRoot !== snapshot.canonicalRoot ||
      identity.manifestDigest !== snapshot.manifestDigest ||
      identity.identityKind !== "content-manifest" ||
      identity.includesUncommittedBytes !== true ||
      identity.fileCount !== snapshot.manifest.length ||
      identity.totalBytes !== totalBytes
    ) {
      return { ok: false, reason: "snapshot source identity is inconsistent" };
    }
    const canonicalSnapshotRoot = await realpath(snapshot.snapshotRoot);
    if (canonicalSnapshotRoot !== snapshot.snapshotRoot) {
      return {
        ok: false,
        reason: "snapshotRoot was replaced by a symlink or alias",
      };
    }
    const manifestText = await readManifestBounded(snapshot.manifestPath);
    const parsed: unknown = JSON.parse(manifestText);
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "manifest is not an object" };
    }
    const record = parsed as Record<string, unknown>;
    const recordIdentity = record.sourceIdentity;
    if (
      record.schemaVersion !== SCHEMA_VERSION ||
      record.canonicalRoot !== snapshot.canonicalRoot ||
      record.snapshotRoot !== snapshot.snapshotRoot ||
      typeof recordIdentity !== "object" ||
      recordIdentity === null ||
      (recordIdentity as Record<string, unknown>).manifestDigest !==
        expectedManifestDigest
    ) {
      return { ok: false, reason: "manifest identity does not match snapshot" };
    }
    if (!Array.isArray(record.entries)) {
      return { ok: false, reason: "manifest entries are missing" };
    }
    const entries: WorkspaceManifestEntry[] = [];
    for (const entry of record.entries) {
      if (!isManifestEntry(entry)) {
        return { ok: false, reason: "manifest entry is malformed" };
      }
      entries.push(entry);
    }
    entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    if (
      record.manifestDigest !== snapshot.manifestDigest ||
      !manifestEntriesEqual(entries, snapshot.manifest)
    ) {
      return { ok: false, reason: "manifest does not match snapshot object" };
    }
    const recomputedDigest = manifestEntriesDigest(entries);
    if (recomputedDigest !== snapshot.manifestDigest) {
      return { ok: false, reason: "manifest digest mismatch" };
    }
    const actual = await walkSnapshot(
      snapshot.snapshotRoot,
      entries.length,
      options.signal,
    );
    for (const entry of entries) {
      checkAborted(options.signal);
      const actualEntry = actual.get(entry.path);
      if (actualEntry === undefined) {
        return {
          ok: false,
          reason: `snapshot file missing: ${entry.path}`,
        };
      }
      if ((actualEntry.mode & 0o077) !== 0) {
        return {
          ok: false,
          reason: `snapshot file permissions too broad: ${entry.path}`,
        };
      }
      const actualSha256 = await hashRegularFile(
        join(snapshot.snapshotRoot, ...entry.path.split("/")),
        entry.size,
        options.signal,
        entry.path,
      );
      if (actualSha256 !== entry.sha256) {
        return {
          ok: false,
          reason: `snapshot digest mismatch: ${entry.path}`,
        };
      }
      actual.delete(entry.path);
    }
    if (actual.size > 0) {
      return {
        ok: false,
        reason: `snapshot has unexpected entries: ${[...actual.keys()].join(", ")}`,
      };
    }
    return { ok: true, manifestDigest: recomputedDigest };
  } catch (error) {
    if (error instanceof SealedWorkspaceError) {
      return { ok: false, reason: `${error.code}: ${error.message}` };
    }
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `verification failed: ${error.message}`
          : "verification failed",
    };
  }
}

function caseInsensitivePlatform(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

interface CandidateScanResult {
  readonly files: Map<string, CollectedFile>;
  readonly totalBytes: number;
}

async function collectCandidateFiles(
  candidateRoot: string,
  scratchRoots: readonly string[],
  maxBytes: number,
  maxFiles: number,
  caseInsensitiveFs: boolean,
  signal: AbortSignal | undefined,
): Promise<CandidateScanResult> {
  const files = new Map<string, CollectedFile>();
  const lowerPaths = new Set<string>();
  let totalBytes = 0;

  const inScratch = (relativePath: string): boolean =>
    scratchRoots.some((scratch) => isScopeMatch(scratch, relativePath));

  const record = (
    absolutePath: string,
    relativePath: string,
    entryStat: Stats,
  ): void => {
    if (entryStat.isSymbolicLink()) {
      throw new SealedWorkspaceError(
        "symlink_rejected",
        `candidate symlink rejected: ${relativePath}`,
      );
    }
    if (!entryStat.isFile()) {
      throw new SealedWorkspaceError(
        "nonregular_rejected",
        `candidate entry is not a regular file: ${relativePath}`,
      );
    }
    if (isDeniedFileName(relativePath)) {
      throw new SealedWorkspaceError(
        "forbidden_path",
        `candidate contains forbidden path: ${relativePath}`,
      );
    }
    rejectUnsafeMode(entryStat.mode, relativePath);
    if (files.size >= maxFiles) {
      throw new SealedWorkspaceError(
        "byte_budget_exceeded",
        `candidate file count exceeds ${maxFiles}`,
      );
    }
    if (caseInsensitiveFs) {
      const lower = relativePath.toLowerCase();
      if (lowerPaths.has(lower)) {
        throw new SealedWorkspaceError(
          "case_ambiguous",
          `candidate paths differ only by case: ${relativePath}`,
        );
      }
      lowerPaths.add(lower);
    }
    totalBytes += entryStat.size;
    if (totalBytes > maxBytes) {
      throw new SealedWorkspaceError(
        "byte_budget_exceeded",
        `candidate source exceeds ${maxBytes} bytes`,
      );
    }
    files.set(relativePath, {
      absolutePath,
      relativePath,
      size: entryStat.size,
      mode: safeFileMode(entryStat.mode),
    });
  };

  const checkCaseCollision = (relativePath: string): void => {
    if (!caseInsensitiveFs) {
      return;
    }
    const lower = relativePath.toLowerCase();
    if (lowerPaths.has(lower)) {
      throw new SealedWorkspaceError(
        "case_ambiguous",
        `candidate paths differ only by case: ${relativePath}`,
      );
    }
    lowerPaths.add(lower);
  };

  const walk = async (
    absoluteDir: string,
    relativeDir: string,
    depth: number,
  ): Promise<void> => {
    checkAborted(signal);
    if (depth > MAX_WALK_DEPTH) {
      throw new SealedWorkspaceError(
        "depth_exceeded",
        `candidate tree exceeds ${MAX_WALK_DEPTH} directory levels: ${relativeDir}`,
      );
    }
    const names = await readdir(absoluteDir);
    names.sort();
    for (const name of names) {
      checkAborted(signal);
      const absolutePath = join(absoluteDir, name);
      const relativePath =
        relativeDir.length === 0 ? name : `${relativeDir}/${name}`;
      if (inScratch(relativePath)) {
        continue;
      }
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new SealedWorkspaceError(
          "symlink_rejected",
          `candidate symlink rejected: ${relativePath}`,
        );
      }
      if (entryStat.isDirectory()) {
        if (isDeniedDirectoryName(name)) {
          continue;
        }
        checkCaseCollision(relativePath);
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      record(absolutePath, relativePath, entryStat);
    }
  };

  await walk(candidateRoot, "", 0);
  return { files, totalBytes };
}

function artifactDigest(
  artifact: Omit<CandidateArtifact, "artifactDigest">,
): string {
  const parts = [
    `${artifact.schemaVersion}\0${artifact.baseManifestDigest}\0${artifact.baseFileCount}`,
  ];
  for (const change of artifact.changes) {
    parts.push(
      [
        change.path,
        change.kind,
        change.baseSha256 ?? "-",
        change.baseMode?.toString(8) ?? "-",
        change.candidateSha256 ?? "-",
        change.candidateMode?.toString(8) ?? "-",
        String(change.size),
      ].join("\0"),
    );
  }
  return sha256Hex(parts.join("\n"));
}

/**
 * Compare a candidate tree against a verified sealed snapshot.
 *
 * The candidate never needs the original source root. Source contents are not
 * embedded in the artifact; only verified metadata and base hashes are
 * returned. Build/output roots must be declared explicitly and are excluded
 * from the deliverable instead of relying on `.gitignore`.
 */
export async function validateCandidateChanges(
  options: ValidateCandidateOptions,
): Promise<CandidateValidationResult> {
  requireSupportedSealedWorkspacePlatform(options.platform);
  const verification = await verifySealedWorkspaceSnapshot(options.snapshot, {
    expectedManifestDigest: options.expectedManifestDigest,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!verification.ok) {
    throw new SealedWorkspaceError("snapshot_tampered", verification.reason);
  }
  checkAborted(options.signal);
  const candidateRoot = await realpath(options.candidateRoot).catch(() => {
    throw new SealedWorkspaceError(
      "invalid_input",
      "candidateRoot does not exist",
    );
  });
  const candidateStat = await stat(candidateRoot);
  if (!candidateStat.isDirectory()) {
    throw new SealedWorkspaceError(
      "invalid_input",
      "candidateRoot is not a directory",
    );
  }
  if (
    isPathInside(candidateRoot, options.snapshot.snapshotRoot) ||
    isPathInside(options.snapshot.snapshotRoot, candidateRoot) ||
    isPathInside(candidateRoot, options.snapshot.canonicalRoot)
  ) {
    throw new SealedWorkspaceError(
      "invalid_input",
      "candidateRoot overlaps the sealed snapshot or original source",
    );
  }

  const caseInsensitiveFs =
    options.caseInsensitiveFs ?? caseInsensitivePlatform();
  const allowedScopes = options.allowedEditPaths.map((entry) =>
    requireRelativePath(entry, "allowedEditPaths"),
  );
  const scratchRoots = (options.generatedScratchRoots ?? []).map((entry) =>
    requireRelativePath(entry, "generatedScratchRoots"),
  );
  ensureDistinctCase(allowedScopes, "allowedEditPaths", caseInsensitiveFs);
  ensureDistinctCase(scratchRoots, "generatedScratchRoots", caseInsensitiveFs);
  for (const scratch of scratchRoots) {
    for (const scope of allowedScopes) {
      if (isScopeMatch(scratch, scope) || isScopeMatch(scope, scratch)) {
        throw new SealedWorkspaceError(
          "invalid_input",
          `generated scratch root collides with an allowed edit path: ${scratch}`,
        );
      }
    }
    for (const entry of options.snapshot.manifest) {
      if (
        isScopeMatch(scratch, entry.path) ||
        isScopeMatch(entry.path, scratch)
      ) {
        throw new SealedWorkspaceError(
          "invalid_input",
          `generated scratch root would hide sealed source: ${scratch} (${entry.path})`,
        );
      }
    }
  }
  let scan: CandidateScanResult;
  try {
    scan = await collectCandidateFiles(
      candidateRoot,
      scratchRoots,
      options.snapshot.maxSourceBytes,
      options.snapshot.maxFiles,
      caseInsensitiveFs,
      options.signal,
    );
  } catch (error) {
    if (error instanceof SealedWorkspaceError) {
      return {
        ok: false,
        rejected: [`${error.code}: ${error.message}`],
      };
    }
    throw error;
  }

  const snapshotByPath = new Map(
    options.snapshot.manifest.map((entry) => [entry.path, entry]),
  );
  const changes: CandidateChange[] = [];
  let changedSourceBytes = 0;
  try {
    for (const [path, candidate] of scan.files) {
      checkAborted(options.signal);
      const base = snapshotByPath.get(path);
      if (base === undefined) {
        changes.push({
          path,
          kind: "add",
          baseSha256: null,
          baseMode: null,
          candidateSha256: await hashRegularFile(
            candidate.absolutePath,
            candidate.size,
            options.signal,
            path,
          ),
          candidateMode: candidate.mode,
          size: candidate.size,
        });
        changedSourceBytes += candidate.size;
        continue;
      }
      const baseExecutable = executableMode(base.mode);
      const candidateExecutable = executableMode(candidate.mode);
      if (
        base.size === candidate.size &&
        baseExecutable === candidateExecutable
      ) {
        const candidateSha256 = await hashRegularFile(
          candidate.absolutePath,
          candidate.size,
          options.signal,
          path,
        );
        if (candidateSha256 === base.sha256) {
          continue;
        }
        changes.push({
          path,
          kind: "modify",
          baseSha256: base.sha256,
          baseMode: base.mode,
          candidateSha256,
          candidateMode: candidate.mode,
          size: candidate.size,
        });
        changedSourceBytes += candidate.size;
        continue;
      }
      changes.push({
        path,
        kind: "modify",
        baseSha256: base.sha256,
        baseMode: base.mode,
        candidateSha256: await hashRegularFile(
          candidate.absolutePath,
          candidate.size,
          options.signal,
          path,
        ),
        candidateMode: candidate.mode,
        size: candidate.size,
      });
      changedSourceBytes += candidate.size;
    }
    for (const base of options.snapshot.manifest) {
      if (!scan.files.has(base.path)) {
        changes.push({
          path: base.path,
          kind: "delete",
          baseSha256: base.sha256,
          baseMode: base.mode,
          candidateSha256: null,
          candidateMode: null,
          size: 0,
        });
      }
    }
  } catch (error) {
    if (error instanceof SealedWorkspaceError) {
      return {
        ok: false,
        rejected: [`${error.code}: ${error.message}`],
      };
    }
    throw error;
  }

  changes.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const rejected: string[] = [];
  for (const change of changes) {
    if (!allowedScopes.some((scope) => isScopeMatch(scope, change.path))) {
      rejected.push(
        `scope_violation: change outside allowed edit paths: ${change.path}`,
      );
    }
  }
  if (options.mode === "read_only" && changes.length > 0) {
    rejected.push(
      `read_only_violation: read-only candidate delivered ${changes.length} change(s)`,
    );
  }
  if (rejected.length > 0) {
    return { ok: false, rejected };
  }
  const baseArtifact: Omit<CandidateArtifact, "artifactDigest"> = {
    schemaVersion: SCHEMA_VERSION,
    baseManifestDigest: options.snapshot.manifestDigest,
    baseFileCount: options.snapshot.manifest.length,
    changes,
    changeCount: changes.length,
    changedSourceBytes,
  };
  const artifact: CandidateArtifact = {
    ...baseArtifact,
    artifactDigest: artifactDigest(baseArtifact),
  };
  const artifactBytes = Buffer.byteLength(
    `${JSON.stringify(artifact)}\n`,
    "utf8",
  );
  if (artifactBytes > options.snapshot.maxArtifactBytes) {
    return {
      ok: false,
      rejected: [
        `artifact_budget_exceeded: artifact is ${artifactBytes} bytes, limit ${options.snapshot.maxArtifactBytes}`,
      ],
    };
  }
  return { ok: true, artifact };
}
