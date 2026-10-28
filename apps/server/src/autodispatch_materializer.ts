// Per-execution auto-dispatch materialization: sealed source snapshot +
// verified dependency depot + exact executor/check/runtime profile.
//
// This module is the bridge between a frozen auto-dispatch plan and the
// EXISTING TrialAuthority grant. It never authorizes, queues, or approves
// anything itself. It prepares an immutable reference BEFORE the exact grant,
// persists that reference on the existing autodispatch ledger row, and lets
// the existing TrialRunner consume the same bytes. No new queue, scheduler,
// engine, model call, or host apply exists here.
//
// Trust boundary:
// - every input comes from the trusted operator config, never from a plan,
//   model output, or HTTP body;
// - the original source root is read ONLY to create a filtered sealed
//   snapshot (denylist + allowedRoots/top files). The guest/runner never sees
//   the original root, .git, environment files, credentials, or depots;
// - missing/tampered depot, executor, check, runtime, or snapshot fails
//   closed with a fixed blocker. A directory merely existing is never
//   "ready".

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { TrialProfileSnapshot } from "@companion/contracts";
import type {
  DispatchPlanView,
  KernelRepository,
  StandingPolicyView,
} from "@companion/kernel";
import {
  createSealedWorkspaceSnapshot,
  type SealedWorkspaceSnapshot,
  verifySealedWorkspaceSnapshot,
} from "../../../packages/kernel/src/autonomous_workspace.js";
import { canonicalize } from "../../../scripts/pi-orch-bridge/companion-protocol.mjs";
import {
  type DependencyClosureResult,
  prepareDependencyClosure,
  prepareExecutorProfile,
} from "../../../scripts/pi-orch-bridge/execution-profile.mjs";
import {
  computeEffectiveProfile,
  loadSealedSnapshot,
  type OperatorConfig,
  parseOperatorConfig,
  readNodeAbi,
  verifyDependencyClosure,
} from "../../../scripts/pi-orch-bridge/sealed-profile.mjs";
import { verifyAutodispatchDependency } from "./autodispatch_dependencies.js";
import type { AutodispatchConfig } from "./config.js";
import {
  type TrialModelRelayCaps,
  validateTrialModelRelayCaps,
} from "./trial_model_relay.js";

const SCHEMA_VERSION = 1;
const MATERIALIZATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 20_000;
/** Guest observation file is generated scratch, never a source change. The
 * sealed bridge collects it from the work tree and must exclude it from the
 * candidate diff (same declaration the standalone real-pi fixture uses). */
const GUEST_OBSERVATION_SCRATCH_ROOT = ".companion-observation";
/** Keep small candidate/check evidence for human review for one week. */
export const AUTODISPATCH_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Small fixed retained-artifact count even inside the time window. */
export const AUTODISPATCH_MAX_RETAINED_JOBS = 20;
const RETENTION_FILE = "retention.json";
/** Linux sun_path bytes for a UDS pathname (including the trailing NUL). */
const MAX_UDS_PATH_BYTES = 107;
/** Short per-execution socket directory name under the trusted runtime dir. */
const SOCKET_DIR_PREFIX = "companion-ad-";
const SOCKET_FILE_NAME = "model.sock";

export type MaterializationBlockerCode =
  | "config_missing"
  | "unsupported_platform"
  | "state_invalid"
  | "snapshot_failed"
  | "dependency_unavailable"
  | "dependency_prepare_failed"
  | "executor_unavailable"
  | "profile_failed"
  | "plan_scope_violation"
  | "stopped";

export interface AutodispatchMaterialization {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly reference: {
    readonly planId: string;
    readonly planRevision: number;
    readonly planHash: string;
    readonly policyId: string;
    readonly policyVersion: number;
    readonly workspaceAlias: string;
    readonly executionId: string;
    readonly createdAt: number;
  };
  readonly profile: TrialProfileSnapshot;
  /**
   * Immutable per-execution model budget derived at prepare time from the
   * frozen policy intersect the operator (autodispatch) caps. Both the guest
   * profile limits and the HOST trial relay use exactly these values; the
   * digest below binds them so a post-grant policy/config read can never
   * widen (or silently replace) the granted budget.
   */
  readonly budget: TrialModelRelayCaps;
  /** Exact private bridge operator config. Never returned by host routes. */
  readonly config: OperatorConfig;
  readonly state: {
    readonly jobRoot: string;
    readonly runDir: string;
    /** Trusted host runtime dir; socketDir is a private direct child. */
    readonly runtimeDir: string;
    /** Short private per-execution socket directory outside the job root. */
    readonly socketDir: string;
    readonly socketHostPath: string;
    readonly sourceRootCanonical: string;
    readonly snapshotRoot: string;
    readonly manifestPath: string;
    readonly sourceManifestDigest: string;
    readonly dependencyRoot: string;
    readonly dependencyManifestPath: string;
    readonly dependencyDigest: string;
    readonly executorDigest: string;
    readonly checks: Readonly<Record<string, string>>;
    readonly runtime: Readonly<Record<string, string | null>>;
    readonly configDigest: string;
  };
  readonly digests: {
    readonly materialization: string;
  };
}

export type PrepareAutodispatchResult =
  | { readonly ok: true; readonly materialization: AutodispatchMaterialization }
  | {
      readonly ok: false;
      readonly code: MaterializationBlockerCode;
      readonly reason: string;
    };

export interface PrepareAutodispatchInput {
  readonly plan: DispatchPlanView;
  readonly policy: StandingPolicyView;
  readonly executionId: string;
  readonly signal?: AbortSignal;
  readonly now?: number;
}

export interface AutodispatchMaterializer {
  prepare(input: PrepareAutodispatchInput): Promise<PrepareAutodispatchResult>;
  /** Only valid before the reference was persisted with a grant. */
  discard(materialization: AutodispatchMaterialization): void;
}

export interface AutodispatchMaterializerDeps {
  readonly config: AutodispatchConfig;
  /** Trusted host runner runtime dir (e.g. /run/user/<uid>). Never model input. */
  readonly runtimeDir?: string;
  readonly currentModel: string;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly disclosedWholeRepoRead: boolean;
  readonly now?: () => number;
  /** Injectable platform override (tests). Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
}

type ArtifactRetentionStatus = "prepared" | "cleaned" | "artifact-expired";

interface RetentionRecord {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly status: ArtifactRetentionStatus;
  readonly cleanedAt?: number;
  readonly expiredAt?: number;
}

export interface AutodispatchRetentionSummary {
  readonly cleaned: number;
  readonly expired: number;
  readonly retained: number;
  readonly prepared: number;
}

function retentionPath(jobRoot: string): string {
  return join(jobRoot, RETENTION_FILE);
}

function readRetention(jobRoot: string): RetentionRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(retentionPath(jobRoot), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== 1) return null;
  if (
    typeof rec.executionId !== "string" ||
    rec.executionId.length < 1 ||
    rec.executionId.length > 128 ||
    typeof rec.sessionId !== "string" ||
    rec.sessionId.length < 1 ||
    rec.sessionId.length > 128 ||
    typeof rec.createdAt !== "number" ||
    !Number.isSafeInteger(rec.createdAt) ||
    (rec.status !== "prepared" &&
      rec.status !== "cleaned" &&
      rec.status !== "artifact-expired")
  ) {
    return null;
  }
  return rec as unknown as RetentionRecord;
}

function writeRetention(jobRoot: string, record: RetentionRecord): void {
  writeFileSync(retentionPath(jobRoot), JSON.stringify(record), {
    mode: 0o600,
  });
  chmodSync(retentionPath(jobRoot), 0o600);
}

/** Read-only retention status for review surfaces; null when unknown. */
export function readAutodispatchRetentionStatus(
  jobRoot: string,
): { status: ArtifactRetentionStatus; createdAt: number } | null {
  const rec = readRetention(jobRoot);
  return rec === null ? null : { status: rec.status, createdAt: rec.createdAt };
}

/** Make a private owned tree deletable without following symlinks. */
function makeOwnedTreeWritable(path: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      makeOwnedTreeWritable(join(path, entry.name));
    }
    try {
      chmodSync(path, 0o700);
    } catch {
      // Best effort: deletion below still reports its own failure.
    }
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

/**
 * Remove ONE exact prepared-copy root under the job directory. Never follows
 * a symlink and never touches a shared depot/operator source path.
 */
function removeOwnedCopyRoot(jobRoot: string, target: string): boolean {
  try {
    if (!isInside(target, jobRoot) || target === jobRoot) return false;
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      rmSync(target, { force: true });
      return true;
    }
    if (!st.isDirectory()) return false;
    const jobRootReal = realpathSync(jobRoot);
    if (!isInside(realpathSync(target), jobRootReal)) return false;
    makeOwnedTreeWritable(target);
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanupHeavyRoots(
  jobRoot: string,
  materialization?: AutodispatchMaterialization,
): boolean {
  const snapshotRoot =
    materialization?.state.snapshotRoot ?? join(jobRoot, "sealed-workspace");
  const dependencyRoot =
    materialization?.state.dependencyRoot ?? join(jobRoot, "dependency");
  const expectedDependencyRoot = join(jobRoot, "dependency");
  let removed = false;
  if (removeOwnedCopyRoot(jobRoot, snapshotRoot)) removed = true;
  // Only a per-execution prepared copy is removable; an external shared
  // trusted depot (different path) is never touched.
  if (
    dependencyRoot === expectedDependencyRoot &&
    removeOwnedCopyRoot(jobRoot, dependencyRoot)
  ) {
    removed = true;
  }
  // The short socket dir lives outside the job root. Remove it ONLY because
  // this caller has already proven known quiescence (or is discarding a
  // pre-grant materialization); never guess/scan sibling runtime dirs.
  if (
    materialization !== undefined &&
    removePrivateSocketDir(materialization)
  ) {
    removed = true;
  }
  return removed;
}

/**
 * Terminal cleanup after ACTUAL quiescence: remove only the sealed source
 * snapshot and prepared dependency depot (the heavy per-execution copies)
 * while keeping the run dir with candidate/artifact/check evidence and the
 * retention metadata. Idempotent; never throws into the runner.
 */
export function cleanupTerminalAutodispatchMaterialization(
  materialization: AutodispatchMaterialization,
  now?: number,
): void {
  try {
    if (process.env.DEBUG_CLEANUP === "1")
      console.error("cleanup-start", materialization.state.jobRoot);
    const jobRoot = materialization.state.jobRoot;
    const st = lstatSync(jobRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    cleanupHeavyRoots(jobRoot, materialization);
    const rec = readRetention(jobRoot);
    if (
      rec !== null &&
      rec.executionId === materialization.reference.executionId &&
      rec.status === "prepared"
    ) {
      writeRetention(jobRoot, {
        ...rec,
        status: "cleaned",
        cleanedAt: now ?? Date.now(),
      });
    }
  } catch (error) {
    if (process.env.DEBUG_CLEANUP === "1") console.error("cleanup-fail", error);
    // Best effort: cleanup never changes the trial outcome.
  }
}

/**
 * Read the exact host-pinned materialization for a retention row. Identity
 * and the canonical JSON digest must still match; the current executor/check/
 * runtime binary fingerprints are intentionally NOT re-read here so operator
 * drift after a revoke cannot pin cleanup forever.
 */
function exactStoredMaterialization(
  repo: KernelRepository,
  sessionId: string,
  executionId: string,
  jobRoot: string,
): AutodispatchMaterialization | undefined {
  try {
    const stored = repo.readAutodispatchMaterialization(sessionId, executionId);
    if (typeof stored?.materializationJson !== "string") return undefined;
    const parsed = parseMaterialization(stored.materializationJson);
    if (
      parsed === null ||
      parsed.reference.executionId !== executionId ||
      parsed.state.jobRoot !== jobRoot ||
      !hasExactMaterializationDigest(parsed)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Startup/pre-prepare sweep. It only removes previously MATERIALIZED copies
 * whose existing grant/worker outcome proves terminal known-quiescence.
 * Active/unknown/unreadable rows and jobs without our exact retention record
 * are retained (never PID guessed). Cleaned small artifacts expire after the
 * fixed retention window/count with an explicit artifact-expired status.
 */
export function pruneAutodispatchMaterializations(
  repo: KernelRepository,
  config: AutodispatchConfig,
  now: number = Date.now(),
): AutodispatchRetentionSummary {
  const empty: AutodispatchRetentionSummary = {
    cleaned: 0,
    expired: 0,
    retained: 0,
    prepared: 0,
  };
  const material = config.materialization;
  if (material === null) return empty;
  const jobsRoot = join(material.stateDir, "jobs");
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(jobsRoot, { withFileTypes: true });
  } catch {
    return empty;
  }
  let cleaned = 0;
  let expired = 0;
  let retained = 0;
  let prepared = 0;
  const cleanedRecords: Array<{ jobRoot: string; record: RetentionRecord }> =
    [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobRoot = join(jobsRoot, entry.name);
    const record = readRetention(jobRoot);
    if (record === null || record.executionId !== entry.name) continue;
    if (record.status === "cleaned") {
      cleanedRecords.push({ jobRoot, record });
      continue;
    }
    if (record.status === "artifact-expired") {
      // Audit tombstone only: the run artifacts were already removed by the
      // one-time cleaned -> artifact-expired transition. It must not count
      // toward the retained-artifact admission budget, and repeat prunes must
      // not "expire" it again (capacity stays freed). Keep retention.json.
      continue;
    }
    // A durable grant revoked before ever being claimed/launched has no
    // worker that can still use its bytes. The exact ledger materialization
    // must still bind the job root + private socket digest; if that proof is
    // missing/tampered/foreign we HOLD rather than guess.
    let revokedNeverLaunched = false;
    try {
      revokedNeverLaunched = repo.isNeverLaunchedRevokedTrialGrant(
        record.sessionId,
        record.executionId,
      );
    } catch {
      revokedNeverLaunched = false;
    }
    if (revokedNeverLaunched) {
      const materialization = exactStoredMaterialization(
        repo,
        record.sessionId,
        record.executionId,
        jobRoot,
      );
      if (materialization === undefined) {
        prepared += 1;
        retained += 1;
        continue;
      }
      cleanupHeavyRoots(jobRoot, materialization);
      // No worker ever launched, so the retained evidence is already expired;
      // free admission immediately instead of waiting for the 7-day/count
      // retained window.
      removeOwnedCopyRoot(jobRoot, join(jobRoot, "run"));
      removeOwnedCopyRoot(jobRoot, join(jobRoot, "bridge-state"));
      writeRetention(jobRoot, {
        ...record,
        status: "artifact-expired",
        expiredAt: now,
      });
      expired += 1;
      continue;
    }
    // status prepared: only a terminal row with ACTUAL durable quiescence
    // evidence may release the heavy copies. Merely having a status/summary
    // (including a late/observed placeholder) is not enough.
    let terminal = false;
    try {
      const outcome = repo.readTrialWorkerOutcome(
        record.sessionId,
        record.executionId,
      );
      terminal =
        outcome !== null &&
        outcome.recorded === true &&
        ((outcome.status === "consumed" &&
          outcome.succeeded &&
          outcome.authorized) ||
          (outcome.status === "interrupted" &&
            (outcome.quiescent || outcome.succeeded)));
    } catch {
      terminal = false;
    }
    if (!terminal) {
      prepared += 1;
      retained += 1;
      continue;
    }
    const quiescentMaterialization = exactStoredMaterialization(
      repo,
      record.sessionId,
      record.executionId,
      jobRoot,
    );
    if (quiescentMaterialization === undefined) {
      prepared += 1;
      retained += 1;
      continue;
    }
    cleanupHeavyRoots(jobRoot, quiescentMaterialization);
    writeRetention(jobRoot, {
      ...record,
      status: "cleaned",
      cleanedAt: now,
    });
    cleaned += 1;
    cleanedRecords.push({ jobRoot, record: { ...record, status: "cleaned" } });
  }
  cleanedRecords.sort((a, b) => a.record.createdAt - b.record.createdAt);
  // Keep at most the fixed count; also expire anything older than one week.
  const keep = new Map<string, true>();
  const survivors = cleanedRecords.slice(-AUTODISPATCH_MAX_RETAINED_JOBS);
  for (const survivor of survivors) keep.set(survivor.jobRoot, true);
  for (const item of cleanedRecords) {
    const tooOld =
      now - item.record.createdAt > AUTODISPATCH_ARTIFACT_RETENTION_MS;
    if (!tooOld && keep.has(item.jobRoot)) {
      retained += 1;
      continue;
    }
    removeOwnedCopyRoot(item.jobRoot, join(item.jobRoot, "run"));
    removeOwnedCopyRoot(item.jobRoot, join(item.jobRoot, "bridge-state"));
    writeRetention(item.jobRoot, {
      ...item.record,
      status: "artifact-expired",
      expiredAt: now,
    });
    expired += 1;
  }
  return { cleaned, expired, retained, prepared };
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function canonicalAbsolute(value: string, what: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${what} must be an absolute path`);
  }
  return realpathSync(value);
}

/** True only for a canonical, non-symlink directory owned by this user and
 * inaccessible to group/other. Used for the trusted runtime dir and the
 * private per-execution socket dir. */
function isOwnedPrivateDir(path: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return false;
  if ((Number(st.mode) & 0o077) !== 0) return false;
  try {
    return realpathSync(path) === path;
  } catch {
    return false;
  }
}

/** Validate and canonicalize the trusted host runtime dir. Missing,
 * symlinked, non-private, or foreign-owned dirs fail before any grant. */
function trustedRuntimeDir(value: string | undefined): string | null {
  if (value === undefined) return null;
  let dir: string;
  try {
    dir = canonicalAbsolute(value, "runtimeDir");
  } catch {
    return null;
  }
  if (!isOwnedPrivateDir(dir)) return null;
  return dir;
}

function socketPathByteLength(socketPath: string): number {
  return Buffer.byteLength(socketPath, "utf8");
}

/** Remove ONE exact per-execution socket dir. The caller must already know
 * the materialization is quiescent or never granted. */
function removePrivateSocketDir(
  materialization: AutodispatchMaterialization,
): boolean {
  const socketDir = materialization.state.socketDir;
  const runtimeDir = materialization.state.runtimeDir;
  if (typeof socketDir !== "string" || typeof runtimeDir !== "string") {
    return false;
  }
  // Only a direct, prefixed child of the recorded trusted runtime dir. Never
  // touch an unrelated runtime dir or a path that escaped canonicalization.
  if (dirname(socketDir) !== runtimeDir) return false;
  if (!basename(socketDir).startsWith(SOCKET_DIR_PREFIX)) return false;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(socketDir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return false;
  try {
    if (realpathSync(socketDir) !== socketDir) return false;
  } catch {
    return false;
  }
  try {
    rmSync(socketDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Revalidate the exact persisted socket bind before the existing runner
 * launches it. Bad owner/mode/symlink/containment/byte length denies. */
function validateMaterializedSocketPaths(
  materialization: AutodispatchMaterialization,
  expectedRuntimeDir: string | undefined,
): string | null {
  const socketHostPath = materialization.state.socketHostPath;
  const socketDir = materialization.state.socketDir;
  const runtimeDir = materialization.state.runtimeDir;
  if (
    typeof socketHostPath !== "string" ||
    typeof socketDir !== "string" ||
    typeof runtimeDir !== "string"
  ) {
    return "materialized socket directory invalid";
  }
  if (
    socketPathByteLength(socketHostPath) > MAX_UDS_PATH_BYTES ||
    dirname(socketHostPath) !== socketDir ||
    basename(socketHostPath) !== SOCKET_FILE_NAME ||
    dirname(socketDir) !== runtimeDir ||
    !basename(socketDir).startsWith(SOCKET_DIR_PREFIX)
  ) {
    return "materialized socket directory invalid";
  }
  const trusted = trustedRuntimeDir(expectedRuntimeDir ?? runtimeDir);
  if (trusted === null || trusted !== runtimeDir) {
    return "materialized socket directory untrusted";
  }
  if (!isOwnedPrivateDir(socketDir)) {
    return "materialized socket directory invalid";
  }
  return null;
}

function blocked(
  code: MaterializationBlockerCode,
  reason: string,
): PrepareAutodispatchResult {
  return { ok: false, code, reason };
}

/**
 * Collapse snapshot-copy roots that are already covered by an approved
 * ancestor (for example read `src` + write `src/feature` -> copy `src` once).
 * This ONLY feeds createSealedWorkspaceSnapshot; the separate policy
 * read/write scopes, plan relevantPaths, and check authority stay intact.
 * A literal `.` is never introduced here and `src` never collapses `src2`.
 */
function collapseSnapshotRoots(roots: readonly string[]): string[] {
  const unique = [...new Set(roots)];
  return unique
    .filter(
      (candidate) =>
        !unique.some(
          (other) =>
            other !== candidate &&
            (other === "." || candidate.startsWith(`${other}/`)),
        ),
    )
    .sort();
}

/**
 * Frozen-policy ∩ current-config scopes. The policy is the approval the human
 * made; a later config edit may only narrow it. For every pair, contribute the
 * narrower path when one contains the other (equal -> itself, policy under
 * config -> policy, config under policy -> config, disjoint -> nothing).
 * Adding config scopes that the policy never approved would widen the
 * materialized profile, so they are never included.
 */
function intersectScopes(
  policyScopes: readonly string[],
  configScopes: readonly string[],
): string[] {
  const scopes = new Set<string>();
  for (const approved of policyScopes) {
    for (const current of configScopes) {
      if (approved === current || withinScope(approved, [current])) {
        scopes.add(approved);
      } else if (withinScope(current, [approved])) {
        scopes.add(current);
      }
    }
  }
  return [...scopes];
}

/** Frozen-policy ∩ current-config write scopes. An implement plan's
 * relevantPaths are edit paths, so they must be inside the write authority
 * only (never widened by read scopes). */
function policyWriteScopes(
  config: AutodispatchConfig,
  policy: StandingPolicyView,
): string[] {
  return intersectScopes(policy.writeScopes, config.writeScopes);
}

function policyScopes(
  config: AutodispatchConfig,
  policy: StandingPolicyView,
  plan: DispatchPlanView,
): string[] {
  const scopes = new Set<string>(
    intersectScopes(policy.readScopes, config.readScopes),
  );
  if (plan.operation === "implement") {
    for (const scope of policyWriteScopes(config, policy)) {
      scopes.add(scope);
    }
  }
  // The policy has no separate allowedTopLevelFiles notion; keep the existing
  // operator-approved top-level file behavior (it is still snapshot-filtered
  // and never becomes an arbitrary path).
  for (const top of config.materialization?.allowedTopLevelFiles ?? []) {
    scopes.add(top);
  }
  return [...scopes];
}

function withinScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      path === scope || (scope !== "." && path.startsWith(`${scope}/`)),
  );
}

function assertPlanScope(
  config: AutodispatchConfig,
  policy: StandingPolicyView,
  plan: DispatchPlanView,
): boolean {
  // Implement edits are constrained to the frozen write scopes only.
  // Investigate has no writes, so the snapshot read/write union is the
  // correct (still intersected) scope check.
  const scopes =
    plan.operation === "implement"
      ? policyWriteScopes(config, policy)
      : policyScopes(config, policy, plan);
  for (const relevant of plan.relevantPaths) {
    if (relevant === ".") return false;
    if (!withinScope(relevant, scopes)) return false;
  }
  return true;
}

/**
 * Frozen per-execution model budget: policy caps intersect the operator
 * (autodispatch) caps field by field. Never widens either side; both the
 * guest profile limits and the host relay receive this same representation.
 */
function deriveEffectiveRelayCaps(
  policyCaps: {
    readonly maxModelCalls: number;
    readonly maxOutputTokens: number;
    readonly perCallTimeoutMs: number;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxConcurrent: number;
  },
  operatorCaps: {
    readonly maxModelCalls: number;
    readonly maxOutputTokens: number;
    readonly perCallTimeoutMs: number;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxConcurrent: number;
  },
): TrialModelRelayCaps {
  const caps: TrialModelRelayCaps = Object.freeze({
    maxModelCalls: Math.min(
      policyCaps.maxModelCalls,
      operatorCaps.maxModelCalls,
    ),
    maxOutputTokens: Math.min(
      policyCaps.maxOutputTokens,
      operatorCaps.maxOutputTokens,
    ),
    perCallTimeoutMs: Math.min(
      policyCaps.perCallTimeoutMs,
      operatorCaps.perCallTimeoutMs,
    ),
    maxRequestBytes: Math.min(
      policyCaps.maxRequestBytes,
      operatorCaps.maxRequestBytes,
    ),
    maxResponseBytes: Math.min(
      policyCaps.maxResponseBytes,
      operatorCaps.maxResponseBytes,
    ),
    maxConcurrent: Math.min(
      policyCaps.maxConcurrent,
      operatorCaps.maxConcurrent,
    ),
  });
  validateTrialModelRelayCaps(caps);
  return caps;
}

function isTrialModelRelayCaps(value: unknown): value is TrialModelRelayCaps {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    validateTrialModelRelayCaps(value as TrialModelRelayCaps);
    return true;
  } catch {
    return false;
  }
}

function parseMaterialization(raw: string): AutodispatchMaterialization | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof rec.reference !== "object" || rec.reference === null) return null;
  if (typeof rec.profile !== "object" || rec.profile === null) return null;
  if (!isTrialModelRelayCaps(rec.budget)) return null;
  if (typeof rec.config !== "object" || rec.config === null) return null;
  if (typeof rec.state !== "object" || rec.state === null) return null;
  if (typeof rec.digests !== "object" || rec.digests === null) return null;
  const digests = rec.digests as Record<string, unknown>;
  if (
    typeof digests.materialization !== "string" ||
    !MATERIALIZATION_DIGEST_PATTERN.test(digests.materialization)
  ) {
    return null;
  }
  return value as AutodispatchMaterialization;
}

function recomputeMaterializationDigest(
  materialization: Omit<AutodispatchMaterialization, "digests">,
): string {
  return sha256Canonical(materialization);
}

function hasExactMaterializationDigest(
  materialization: AutodispatchMaterialization,
): boolean {
  const { digests, ...base } = materialization;
  return (
    typeof digests?.materialization === "string" &&
    MATERIALIZATION_DIGEST_PATTERN.test(digests.materialization) &&
    recomputeMaterializationDigest(base) === digests.materialization
  );
}

/** Verify all actual bytes referenced by a persisted materialization. The
 * expected digest is host-pinned in the log row; any drift fails closed. */
export async function verifyAutodispatchMaterialization(
  materialization: AutodispatchMaterialization,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (
    sha256Canonical({
      schemaVersion: materialization.schemaVersion,
      reference: materialization.reference,
      profile: materialization.profile,
      budget: materialization.budget,
      config: materialization.config,
      state: materialization.state,
    }) !== materialization.digests.materialization
  ) {
    return { ok: false, reason: "materialization digest mismatch" };
  }
  const socketProblem = validateMaterializedSocketPaths(
    materialization,
    undefined,
  );
  if (socketProblem !== null) {
    return { ok: false, reason: socketProblem };
  }
  let config: OperatorConfig;
  try {
    config = parseOperatorConfig(JSON.stringify(materialization.config));
  } catch {
    return { ok: false, reason: "materialized config unreadable" };
  }
  // The guest profile limits and the host relay budget are ONE frozen
  // representation: their four shared fields must match exactly.
  const guestLimits = config.profile.limits;
  if (
    guestLimits.maxModelCalls !== materialization.budget.maxModelCalls ||
    guestLimits.maxOutputTokens !== materialization.budget.maxOutputTokens ||
    guestLimits.maxModelCallMs !== materialization.budget.perCallTimeoutMs ||
    guestLimits.modelConcurrency !== materialization.budget.maxConcurrent
  ) {
    return { ok: false, reason: "materialized model budget drift" };
  }
  let effective: ReturnType<typeof computeEffectiveProfile>;
  try {
    effective = computeEffectiveProfile(config);
  } catch {
    return { ok: false, reason: "materialized executor/check/runtime drift" };
  }
  if (effective.fingerprint !== materialization.profile.configFingerprint) {
    return { ok: false, reason: "materialized config fingerprint drift" };
  }
  if (effective.sourceRevision !== materialization.profile.sourceRevision) {
    return { ok: false, reason: "materialized source revision drift" };
  }
  if (
    Object.keys(effective.checks as Record<string, unknown>)
      .sort()
      .join("\n") !==
    [...materialization.profile.mandatoryChecks].sort().join("\n")
  ) {
    return { ok: false, reason: "materialized check set drift" };
  }
  if (materialization.state.configDigest !== sha256Canonical(config)) {
    return { ok: false, reason: "materialized config content drift" };
  }
  let snapshot: SealedWorkspaceSnapshot;
  try {
    snapshot = loadSealedSnapshot(config, {
      expectedManifestDigest: config.sealed.manifestDigest,
    }) as SealedWorkspaceSnapshot;
  } catch {
    return { ok: false, reason: "materialized sealed snapshot unavailable" };
  }
  const verified = await verifySealedWorkspaceSnapshot(snapshot, {
    expectedManifestDigest: config.sealed.manifestDigest,
  });
  if (!verified.ok) {
    return {
      ok: false,
      reason: `materialized sealed snapshot: ${verified.reason}`,
    };
  }
  if (verified.manifestDigest !== materialization.state.sourceManifestDigest) {
    return { ok: false, reason: "materialized source manifest drift" };
  }
  try {
    const closure = verifyDependencyClosure(
      {
        root: config.profile.dependencies.root,
        digest: config.profile.dependencies.digest,
      },
      config.profile.limits.maxDependencyBytes ?? MAX_DEPENDENCY_BYTES,
    );
    if (closure.digest !== materialization.state.dependencyDigest) {
      return { ok: false, reason: "materialized dependency digest drift" };
    }
  } catch {
    return { ok: false, reason: "materialized dependency closure drift" };
  }
  return { ok: true };
}

export interface TrialMaterializationResolutionTrust {
  readonly workspaceAlias: string;
  readonly sourceRoot: string;
  readonly dependencyRoot: string | null;
  readonly checks: readonly string[];
  /** Trusted host runner runtime dir; the persisted socket dir must match. */
  readonly runtimeDir?: string;
}

export type TrialMaterializationResolution =
  | { readonly kind: "manual" }
  | {
      readonly kind: "policy";
      readonly profile: TrialProfileSnapshot;
      /** The exact immutable policy∩operator relay budget from the digest. */
      readonly caps: TrialModelRelayCaps;
      readonly config: OperatorConfig;
      readonly runDir: string;
      readonly socketHostPath: string;
      readonly materialization: AutodispatchMaterialization;
    }
  | { readonly kind: "blocked"; readonly reason: string };

/** Trusted resolver used by the existing TrialRunner BEFORE claim. Manual
 * human grants (no ledger materialization row) stay on the unchanged path. */
export async function resolveAutodispatchMaterialization(
  repo: KernelRepository,
  trust: TrialMaterializationResolutionTrust,
  input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly proposalId: string;
  },
): Promise<TrialMaterializationResolution> {
  let raw: ReturnType<KernelRepository["readAutodispatchMaterialization"]>;
  try {
    raw = repo.readAutodispatchMaterialization(
      input.sessionId,
      input.executionId,
    );
  } catch {
    return { kind: "blocked", reason: "materialization ledger unreadable" };
  }
  if (raw === null) return { kind: "manual" };
  // A policy-ledger row without a materialization reference is NOT a manual
  // human grant: it must never fall back to the static profile.
  if (raw.materializationJson === null) {
    return {
      kind: "blocked",
      reason: "policy execution has no materialization",
    };
  }
  if (raw.status !== "authorized") {
    return { kind: "blocked", reason: "materialization not authorized" };
  }
  const materialization = parseMaterialization(raw.materializationJson);
  if (materialization === null) {
    return { kind: "blocked", reason: "materialization unreadable" };
  }
  if (
    materialization.reference.executionId !== input.executionId ||
    materialization.reference.workspaceAlias !== trust.workspaceAlias
  ) {
    return { kind: "blocked", reason: "materialization identity drift" };
  }
  try {
    if (
      materialization.state.sourceRootCanonical !==
      realpathSync(trust.sourceRoot)
    ) {
      return { kind: "blocked", reason: "materialization source root drift" };
    }
  } catch {
    return { kind: "blocked", reason: "materialization source root invalid" };
  }
  try {
    const plan = repo.readAutodispatchPlan(
      input.sessionId,
      materialization.reference.planId,
    );
    if (
      plan.status !== "dispatched" ||
      plan.id !== materialization.reference.planId ||
      plan.revision !== materialization.reference.planRevision
    ) {
      return { kind: "blocked", reason: "plan drifted before launch" };
    }
    const policy = repo.readAutodispatchPolicy(
      input.sessionId,
      materialization.reference.policyId,
    );
    if (
      policy.status !== "active" ||
      policy.version !== materialization.reference.policyVersion ||
      policy.workspaceAlias !== trust.workspaceAlias
    ) {
      return { kind: "blocked", reason: "policy drifted before launch" };
    }
    if (repo.getAutonomyControlState().paused) {
      return { kind: "blocked", reason: "control paused before launch" };
    }
  } catch {
    return { kind: "blocked", reason: "authority unreadable before launch" };
  }
  const verified = await verifyAutodispatchMaterialization(materialization);
  if (!verified.ok) return { kind: "blocked", reason: verified.reason };
  if (!isInside(materialization.state.runDir, materialization.state.jobRoot)) {
    return { kind: "blocked", reason: "materialized run directory invalid" };
  }
  const socketProblem = validateMaterializedSocketPaths(
    materialization,
    trust.runtimeDir,
  );
  if (socketProblem !== null) {
    return { kind: "blocked", reason: socketProblem };
  }
  return {
    kind: "policy",
    profile: Object.freeze({ ...materialization.profile }),
    caps: Object.freeze({ ...materialization.budget }),
    config: materialization.config,
    runDir: materialization.state.runDir,
    socketHostPath: materialization.state.socketHostPath,
    materialization,
  };
}

export function createAutodispatchMaterializer(
  deps: AutodispatchMaterializerDeps,
): AutodispatchMaterializer {
  const now = deps.now ?? Date.now;

  async function prepare(
    input: PrepareAutodispatchInput,
  ): Promise<PrepareAutodispatchResult> {
    // The sealed snapshot, POSIX modes, bwrap confinement and the relay UDS are
    // a Linux runtime contract. Fail closed before creating a job root or
    // touching the source/grant path; Windows ACLs are not an equivalent seal.
    const platform = deps.platform ?? process.platform;
    if (platform !== "linux") {
      return blocked(
        "unsupported_platform",
        `sealed auto-dispatch requires a Linux POSIX runtime; unsupported platform: ${platform}`,
      );
    }
    const material = deps.config.materialization;
    if (material === null)
      return blocked("config_missing", "materialization not configured");
    if (!deps.available || !deps.enabled || !deps.disclosedWholeRepoRead) {
      return blocked("config_missing", "operator profile not available");
    }
    if (
      deps.config.dependencyRoot === null &&
      material.dependencySourceNodeModules === null
    ) {
      return blocked("dependency_unavailable", "no trusted dependency closure");
    }
    if (input.signal?.aborted === true)
      return blocked("stopped", "intake stopped");
    if (!assertPlanScope(deps.config, input.policy, input.plan)) {
      return blocked("plan_scope_violation", "plan path outside policy scopes");
    }
    let sourceRoot: string;
    let stateRoot: string;
    try {
      sourceRoot = canonicalAbsolute(deps.config.sourceRoot, "sourceRoot");
      if (!statSync(sourceRoot).isDirectory()) {
        return blocked("state_invalid", "source root is not a directory");
      }
      stateRoot = canonicalAbsolute(material.stateDir, "stateDir");
      if (isInside(stateRoot, sourceRoot)) {
        return blocked("state_invalid", "state dir is inside the source root");
      }
      if (!statSync(stateRoot).isDirectory()) {
        return blocked("state_invalid", "state dir is not a directory");
      }
    } catch {
      return blocked("state_invalid", "trusted source/state path invalid");
    }
    // The relay socket must live in a SHORT trusted runtime path, never under
    // the (potentially very long) job state dir: Linux sun_path is 107 bytes.
    let runtimeDir: string;
    try {
      const resolvedRuntimeDir = trustedRuntimeDir(deps.runtimeDir);
      if (resolvedRuntimeDir === null) {
        return blocked(
          "state_invalid",
          "trusted runtime directory unavailable",
        );
      }
      runtimeDir = resolvedRuntimeDir;
      // Length check BEFORE creating anything; mkdtemp replaces six X bytes
      // with six random bytes, so this estimate is exact.
      const estimatedSocketPath = join(
        join(runtimeDir, `${SOCKET_DIR_PREFIX}XXXXXX`),
        SOCKET_FILE_NAME,
      );
      if (socketPathByteLength(estimatedSocketPath) > MAX_UDS_PATH_BYTES) {
        return blocked("state_invalid", "trusted runtime directory too long");
      }
    } catch {
      return blocked("state_invalid", "trusted runtime directory unavailable");
    }
    const jobsRoot = join(stateRoot, "jobs");
    try {
      mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    } catch {
      return blocked("state_invalid", "materialization jobs directory invalid");
    }
    const jobRoot = join(jobsRoot, input.executionId);
    let created = false;
    try {
      mkdirSync(jobRoot, { recursive: false, mode: 0o700 });
      chmodSync(jobRoot, 0o700);
      created = true;
    } catch {
      return blocked(
        "state_invalid",
        "materialization directory already exists",
      );
    }
    let success = false;
    let socketDir: string | null = null;
    try {
      const sealedRoot = jobRoot;
      const snapshot = await createSealedWorkspaceSnapshot({
        sourceRoot,
        outputDir: join(jobRoot, "sealed-workspace"),
        allowedRoots: collapseSnapshotRoots(
          policyScopes(deps.config, input.policy, input.plan).filter(
            (scope) => !material.allowedTopLevelFiles.includes(scope),
          ),
        ),
        allowedTopLevelFiles: material.allowedTopLevelFiles,
        maxBytes: MAX_SOURCE_BYTES,
        maxFiles: MAX_FILES,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const pristineRoot = join(jobRoot, "pristine");
      mkdirSync(pristineRoot, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(pristineRoot, "README.md"),
        "# pristine deployment base\n",
        { mode: 0o600 },
      );

      let dependency: {
        root: string;
        manifestPath: string;
        digest: string;
        nodeAbi: number | null;
        mounts: DependencyClosureResult["mounts"];
      };
      if (material.dependencySourceNodeModules !== null) {
        try {
          const prepared = prepareDependencyClosure({
            sourceNodeModules: material.dependencySourceNodeModules,
            destinationRoot: join(jobRoot, "dependency"),
            maxBytes: MAX_DEPENDENCY_BYTES,
            nodeRealpath: material.runtime.nodeRealpath,
          });
          dependency = {
            root: prepared.root,
            manifestPath: prepared.manifestPath,
            digest: prepared.digest,
            nodeAbi: prepared.nodeAbi,
            mounts: prepared.mounts,
          };
        } catch {
          return blocked(
            "dependency_prepare_failed",
            "trusted dependency closure could not be prepared",
          );
        }
      } else if (deps.config.dependencyRoot !== null) {
        const verified = verifyAutodispatchDependency(
          deps.config.dependencyRoot,
        );
        if (!verified.ok) {
          return blocked("dependency_unavailable", verified.reason);
        }
        dependency = {
          root: verified.depot.root,
          manifestPath: verified.depot.manifestPath,
          digest: verified.depot.digest,
          nodeAbi: verified.depot.nodeAbi,
          mounts: [
            {
              source: join(verified.depot.root, "node_modules"),
              guestPath: "/deps/node_modules",
            },
          ],
        };
      } else {
        return blocked(
          "dependency_unavailable",
          "no trusted dependency closure",
        );
      }

      // The dependency closure's native modules were built for one Node ABI.
      // Bind it to the pinned runtime BEFORE any guest starts; a mismatch is a
      // dependency availability failure, not a later profile surprise.
      let runtimeNodeAbi: number;
      try {
        runtimeNodeAbi = readNodeAbi(
          canonicalAbsolute(material.runtime.nodeRealpath, "node"),
        );
      } catch {
        return blocked(
          "dependency_unavailable",
          "pinned runtime node ABI unavailable",
        );
      }
      if (
        typeof dependency.nodeAbi !== "number" ||
        runtimeNodeAbi !== dependency.nodeAbi
      ) {
        return blocked(
          "dependency_unavailable",
          "dependency closure Node ABI does not match the pinned runtime node",
        );
      }

      const runDir = join(jobRoot, "run");
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      // Private, owner-only, SHORT per-execution socket dir under the trusted
      // runtime dir. It is not inside the job root, so no state-path depth can
      // overflow the Linux UDS pathname bound.
      socketDir = mkdtempSync(join(runtimeDir, SOCKET_DIR_PREFIX));
      chmodSync(socketDir, 0o700);
      if (
        !isOwnedPrivateDir(socketDir) ||
        dirname(realpathSync(socketDir)) !== runtimeDir
      ) {
        return blocked("state_invalid", "private socket directory invalid");
      }
      const socketHostPath = join(socketDir, SOCKET_FILE_NAME);
      if (socketPathByteLength(socketHostPath) > MAX_UDS_PATH_BYTES) {
        return blocked("state_invalid", "private socket path too long");
      }
      const stateDir = join(jobRoot, "bridge-state");
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      // Policy/operator caps are UPPER BOUNDS. Build the ACTUAL runtime limit
      // from the frozen policy caps intersect the operator caps FIRST, then
      // use that SAME value for the profile, the grant/request budget, and the
      // observed unit bound (the kernel compares them for exact equality).
      const appliedTimeoutMs = Math.min(
        input.policy.caps.timeoutMs,
        material.maxDurationMs,
        deps.config.caps.timeoutMs,
        900_000,
      );
      const appliedMaxOutputBytes = Math.min(
        input.policy.caps.maxOutputBytes,
        deps.config.caps.maxOutputBytes,
        MAX_ARTIFACT_BYTES * 4,
      );
      // The SAME frozen policy∩operator budget feeds the guest profile, the
      // host relay, and the digest. No later mutable policy/config read is
      // consulted after the grant.
      const budget = deriveEffectiveRelayCaps(
        input.policy.caps,
        deps.config.caps,
      );
      // Implement plans expose only the intersected write scopes as edit
      // paths; the snapshot still copies the read∪write union above.
      const scopes = (
        input.plan.operation === "implement"
          ? policyWriteScopes(deps.config, input.policy)
          : policyScopes(deps.config, input.policy, input.plan)
      ).filter((scope) => scope !== ".");
      const checkCommands: Record<
        string,
        {
          executable: string;
          args: string[];
          expectExitCode: number;
        }
      > = {};
      for (const checkId of input.policy.checks) {
        const command = material.checks[checkId];
        if (command === undefined) {
          return blocked(
            "executor_unavailable",
            "check executable not configured",
          );
        }
        checkCommands[checkId] = {
          executable: canonicalAbsolute(command.executable, "check executable"),
          args: [...command.args],
          expectExitCode: 0,
        };
      }
      const policy = {
        executionBackend: material.executionBackend,
        executor: {
          kind: material.executor.kind ?? "fixed",
          executable: canonicalAbsolute(
            material.executor.executable,
            "executor",
          ),
          args: [...material.executor.args],
        },
        checks: checkCommands,
        runtime: {
          nodeRealpath: canonicalAbsolute(
            material.runtime.nodeRealpath,
            "node",
          ),
          ...(material.runtime.ompRealpath !== undefined
            ? {
                ompRealpath: canonicalAbsolute(
                  material.runtime.ompRealpath,
                  "omp",
                ),
              }
            : {}),
          ...(material.runtime.bwrapRealpath !== undefined
            ? {
                bwrapRealpath: canonicalAbsolute(
                  material.runtime.bwrapRealpath,
                  "bwrap",
                ),
              }
            : {}),
          ...(material.runtime.systemdRunRealpath !== undefined
            ? {
                systemdRunRealpath: canonicalAbsolute(
                  material.runtime.systemdRunRealpath,
                  "systemd-run",
                ),
              }
            : {}),
          ...(material.runtime.systemctlRealpath !== undefined
            ? {
                systemctlRealpath: canonicalAbsolute(
                  material.runtime.systemctlRealpath,
                  "systemctl",
                ),
              }
            : {}),
          ...(material.runtime.piOrchLauncherRealpath !== undefined
            ? {
                piOrchLauncherRealpath: canonicalAbsolute(
                  material.runtime.piOrchLauncherRealpath,
                  "pi-orch launcher",
                ),
              }
            : {}),
          ...(material.runtime.piOrchShellRealpath !== undefined
            ? {
                piOrchShellRealpath: canonicalAbsolute(
                  material.runtime.piOrchShellRealpath,
                  "pi-orch shell",
                ),
              }
            : {}),
          ...(material.runtime.piOrchConfigRealpath !== undefined
            ? {
                piOrchConfigRealpath: canonicalAbsolute(
                  material.runtime.piOrchConfigRealpath,
                  "pi-orch config",
                ),
              }
            : {}),
          ...(material.runtime.piOrchExtensionRealpath !== undefined
            ? {
                piOrchExtensionRealpath: canonicalAbsolute(
                  material.runtime.piOrchExtensionRealpath,
                  "pi-orch extension",
                ),
              }
            : {}),
          ...(material.runtime.piOrchLockRealpath !== undefined
            ? {
                piOrchLockRealpath: canonicalAbsolute(
                  material.runtime.piOrchLockRealpath,
                  "pi-orch lock",
                ),
              }
            : {}),
        },
        modelRoute: material.modelRoute,
        limits: {
          maxDurationMs: appliedTimeoutMs,
          maxModelCalls: budget.maxModelCalls,
          maxOutputTokens: budget.maxOutputTokens,
          maxModelCallMs: budget.perCallTimeoutMs,
          maxSourceBytes: MAX_SOURCE_BYTES,
          maxDependencyBytes: MAX_DEPENDENCY_BYTES,
          modelConcurrency: budget.maxConcurrent,
          maxProcesses: 256,
          memoryMaxBytes: 2 * 1024 * 1024 * 1024,
          cpuQuotaPercent: 100,
          maxArtifactBytes: MAX_ARTIFACT_BYTES,
          workspaceMaxBytes: 1024 * 1024 * 1024,
        },
        allowedPaths: scopes,
        scratchPaths: [GUEST_OBSERVATION_SCRATCH_ROOT],
        dependencies: {
          root: dependency.root,
          manifestPath: dependency.manifestPath,
          digest: dependency.digest,
          nodeAbi: runtimeNodeAbi,
          mounts: dependency.mounts,
        },
      };
      const preparedProfile = await prepareExecutorProfile({
        snapshotRoot: snapshot.snapshotRoot,
        snapshotManifestPath: snapshot.manifestPath,
        expectedManifestDigest: snapshot.manifestDigest,
        sealedRoot: sealedRoot,
        pristineSnapshotRoot: pristineRoot,
        sourceRootOriginal: sourceRoot,
        stateDir,
        modelUDS: socketHostPath,
        workspaceAlias: deps.config.workspaceAlias,
        policy,
      });
      const config = preparedProfile.config;
      config.active.configFingerprint = preparedProfile.effective.fingerprint;
      config.active.sourceRevision = preparedProfile.effective.sourceRevision;
      const reparsed = parseOperatorConfig(JSON.stringify(config));
      const effective = computeEffectiveProfile(reparsed);
      if (
        effective.fingerprint !== preparedProfile.effective.fingerprint ||
        effective.sourceRevision !== preparedProfile.effective.sourceRevision
      ) {
        return blocked(
          "profile_failed",
          "materialized profile changed while finalizing",
        );
      }
      const checks: Record<string, string> = {};
      for (const id of Object.keys(
        effective.checks as Record<string, unknown>,
      ).sort()) {
        const entry = (
          effective.checks as Record<string, { contentDigest?: unknown }>
        )[id];
        if (typeof entry?.contentDigest !== "string") {
          return blocked("profile_failed", "materialized check digest missing");
        }
        checks[id] = entry.contentDigest;
      }
      const runtime: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(
        effective.runtime as Record<string, { contentDigest?: string | null }>,
      )) {
        runtime[key] = value.contentDigest ?? null;
      }
      const profile: TrialProfileSnapshot = Object.freeze({
        available: true,
        enabled: true,
        mandatoryChecks: [...input.policy.checks],
        configFingerprint: effective.fingerprint,
        sourceRevision: effective.sourceRevision,
        currentModel: deps.currentModel,
        disclosedWholeRepoRead: true,
        timeoutMs: appliedTimeoutMs,
        maxOutputBytes: appliedMaxOutputBytes,
        allowedPaths: [...scopes],
        modelRoute: material.modelRoute,
      });
      const base = {
        schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
        reference: {
          planId: input.plan.id,
          planRevision: input.plan.revision,
          planHash: input.plan.planHash,
          policyId: input.policy.id,
          policyVersion: input.policy.version,
          workspaceAlias: deps.config.workspaceAlias,
          executionId: input.executionId,
          createdAt: input.now ?? now(),
        },
        profile,
        budget,
        config: reparsed,
        state: {
          jobRoot,
          runDir,
          runtimeDir,
          socketDir,
          socketHostPath,
          sourceRootCanonical: sourceRoot,
          snapshotRoot: snapshot.snapshotRoot,
          manifestPath: snapshot.manifestPath,
          sourceManifestDigest: snapshot.manifestDigest,
          dependencyRoot: dependency.root,
          dependencyManifestPath: dependency.manifestPath,
          dependencyDigest: dependency.digest,
          executorDigest: effective.executorDigest,
          checks,
          runtime,
          configDigest: sha256Canonical(reparsed),
        },
      };
      const materialization: AutodispatchMaterialization = Object.freeze({
        ...base,
        digests: Object.freeze({
          materialization: recomputeMaterializationDigest(base),
        }),
      });
      writeRetention(jobRoot, {
        schemaVersion: 1,
        executionId: input.executionId,
        sessionId: input.plan.sessionId,
        createdAt: input.now ?? now(),
        status: "prepared",
      });
      success = true;
      return { ok: true, materialization };
    } catch {
      return blocked("snapshot_failed", "materialization failed closed");
    } finally {
      if (!success && created) {
        try {
          rmSync(jobRoot, { recursive: true, force: true });
        } catch {
          // Best effort: the failure is already a safe block.
        }
      }
      // A failed pre-grant prepare never leaves an active socket behind.
      if (!success && socketDir !== null) {
        try {
          if (dirname(socketDir) === runtimeDir) {
            rmSync(socketDir, { recursive: true, force: true });
          }
        } catch {
          // Best effort: no grant was persisted.
        }
      }
    }
  }

  function discard(materialization: AutodispatchMaterialization): void {
    try {
      rmSync(materialization.state.jobRoot, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only when no grant was persisted.
    }
    // Discard is only valid BEFORE a grant was persisted: no worker can be
    // using the socket, so remove this exact private dir (never siblings).
    removePrivateSocketDir(materialization);
  }

  return { prepare, discard };
}
