// Sealed operator profile for the pi-orch bridge.
//
// The profile is trusted-host configuration. It names a sealed snapshot
// (snapshotRoot + manifestPath + digest), a pinned executor/check/runtime
// closure, and a dependency closure. The bridge NEVER mounts or reads the
// original source root or its .git, and never accepts a command, model route,
// or path from the model/request.
//
// All numeric limits below are conservative test maxima, NOT activated
// production policy. The operator must set every value explicitly; the bridge
// only rejects values above these transport ceilings.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  readdirSync as nodeReaddirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { canonicalize } from "./companion-protocol.mjs";

export const PROFILE_SCHEMA_VERSION = 2;

// Test/transport maxima. Not adopted production values.
export const PROFILE_MAX_DURATION_MS = 900_000;
export const PROFILE_MAX_MODEL_CALLS = 64;
export const PROFILE_MAX_OUTPUT_TOKENS = 4_096;
export const PROFILE_MAX_MODEL_CALL_MS = 120_000;
export const PROFILE_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const PROFILE_MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024 * 1024;
export const PROFILE_MAX_MODEL_CONCURRENCY = 1;
export const PROFILE_MAX_PROCESSES = 256;
export const PROFILE_MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const PROFILE_MAX_CPU_PERCENT = 100;
export const PROFILE_MAX_ARTIFACT_BYTES = 256 * 1024;
export const PROFILE_MAX_WORKSPACE_BYTES = 1024 * 1024 * 1024;

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const ALIAS_RE = /^[a-z0-9_-]{1,64}$/;
const CHECK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOOP_EXECUTABLES = new Set(["true", "false", ":"]);

function fail(message) {
  throw new Error(`sealed-profile: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkNoUnknown(obj, allowed, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key))
      fail(`${what} carries an unsupported key: ${key}`);
  }
}

function need(obj, key, what) {
  if (!(key in obj)) fail(`${what} is missing field: ${key}`);
  return obj[key];
}

function needAbsolutePath(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail(`field ${field} must be a non-empty path`);
  }
  if (!isAbsolute(value)) fail(`field ${field} must be absolute`);
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    fail(`field ${field} must not contain control characters`);
  }
  return value;
}

function needInt(value, field, min, max) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`field ${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function needString(value, field, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`field ${field} must be a 1..${max} char string`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    fail(`field ${field} must not contain control characters`);
  }
  return value;
}

function needArgs(value, field, allowAbsoluteGuest = false) {
  if (!Array.isArray(value)) fail(`field ${field} must be an array`);
  if (value.length > 64) fail(`field ${field} must carry at most 64 entries`);
  const out = [];
  for (const arg of value) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > 4096) {
      fail(`field ${field} entries must be 1..4096 char strings`);
    }
    if (arg.includes("\0") || arg.includes("\n") || arg.includes("\r")) {
      fail(`field ${field} entries must not contain control characters`);
    }
    if (
      allowAbsoluteGuest &&
      arg.startsWith("/") &&
      arg !== "/work" &&
      !arg.startsWith("/work/") &&
      arg !== "/scratch" &&
      !arg.startsWith("/scratch/") &&
      arg !== "/deps" &&
      !arg.startsWith("/deps/")
    ) {
      fail(
        `field ${field} absolute entries must be /work, /scratch, or /deps guest paths`,
      );
    }
    out.push(arg);
  }
  return out;
}

function needDigest(value, field) {
  if (typeof value !== "string" || !HEX64_RE.test(value)) {
    fail(`field ${field} must be 64 lower-hex chars`);
  }
  return value;
}

function rejectNoopExecutable(path, field) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (NOOP_EXECUTABLES.has(base))
    fail(`field ${field} must not be a no-op executable`);
}

export function hashFileSync(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile())
    fail(`content path is not a regular file: ${path}`);
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function sourceRevisionForManifest(manifestDigest) {
  return createHash("sha256")
    .update(`companion-sealed-source-revision\0${manifestDigest}`)
    .digest("hex")
    .slice(0, 40);
}

/**
 * Read the Node ABI (process.versions.modules) from the PINNED node binary by
 * running it with a fixed argument. This is a trusted host probe, never a
 * model- or request-supplied command.
 */
export function readNodeAbi(nodeRealpath) {
  const result = spawnSync(nodeRealpath, ["-p", "process.versions.modules"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });
  if (result.status !== 0) fail("pinned node binary did not report a Node ABI");
  const abi = Number(result.stdout.trim());
  if (!Number.isSafeInteger(abi) || abi <= 0 || abi > 1000)
    fail("pinned node binary reported an invalid Node ABI");
  return abi;
}

function scopesOverlap(left, right) {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

/** Scratch roots are non-deliverable and must never hide or alias a source scope. */
export function assertScratchDisjoint(allowedPaths, scratchPaths) {
  for (const scratch of scratchPaths) {
    if (scratch === ".")
      fail("profile.scratchPaths must not grant the whole workspace");
    for (const allowed of allowedPaths) {
      if (scopesOverlap(scratch, allowed)) {
        fail(
          `profile.scratchPaths entry overlaps an allowed path: ${scratch} vs ${allowed}`,
        );
      }
    }
  }
}

function isPathInside(child, parent) {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

const GUEST_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function parseGuestEnv(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 64) {
    fail("profile.executor.guestEnv must be an array of names (max 64)");
  }
  const seen = new Set();
  const names = [];
  for (const name of raw) {
    if (
      typeof name !== "string" ||
      !GUEST_ENV_NAME_RE.test(name) ||
      name === "HOME" ||
      name === "TMPDIR" ||
      name.startsWith("COMPANION_") ||
      seen.has(name)
    ) {
      fail("profile.executor.guestEnv contains an invalid name");
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function parseExecutor(raw) {
  if (!isRecord(raw)) fail("field profile.executor must be an object");
  checkNoUnknown(
    raw,
    ["kind", "executable", "args", "contentDigest", "guestEnv"],
    "profile.executor",
  );
  const kind = raw.kind === undefined ? "fixed" : raw.kind;
  if (kind !== "fixed" && kind !== "pi-orch-guest" && kind !== "real-pi") {
    fail(
      'profile.executor.kind must be "fixed", "pi-orch-guest", or "real-pi"',
    );
  }
  const executable = needAbsolutePath(
    need(raw, "executable", "profile.executor"),
    "profile.executor.executable",
  );
  rejectNoopExecutable(executable, "profile.executor.executable");
  const args = needArgs(
    need(raw, "args", "profile.executor"),
    "profile.executor.args",
  );
  if ((kind === "pi-orch-guest" || kind === "real-pi") && args.length > 0) {
    fail(
      "profile.executor.args must be empty for the frozen pi-orch guest adapter",
    );
  }
  return {
    kind,
    executable,
    args,
    contentDigest: needDigest(
      need(raw, "contentDigest", "profile.executor"),
      "profile.executor.contentDigest",
    ),
    guestEnv: parseGuestEnv(raw.guestEnv),
  };
}

function parseChecks(raw) {
  if (!isRecord(raw)) fail("field profile.checks must be an object");
  const entries = Object.entries(raw);
  if (entries.length === 0)
    fail("field profile.checks must carry at least one check");
  const checks = {};
  for (const [id, entry] of entries) {
    if (!CHECK_ID_RE.test(id))
      fail(`profile.checks key must match [A-Za-z0-9_-]{1,64}: ${id}`);
    if (!isRecord(entry)) fail(`field profile.checks[${id}] must be an object`);
    checkNoUnknown(
      entry,
      [
        "executable",
        "args",
        "contentDigest",
        "expectExitCode",
        "expectStdoutIncludes",
      ],
      `profile.checks[${id}]`,
    );
    const executable = needAbsolutePath(
      need(entry, "executable", `profile.checks[${id}]`),
      `profile.checks[${id}].executable`,
    );
    rejectNoopExecutable(executable, `profile.checks[${id}].executable`);
    const expectExitCode =
      entry.expectExitCode === undefined
        ? 0
        : needInt(
            entry.expectExitCode,
            `profile.checks[${id}].expectExitCode`,
            0,
            255,
          );
    let expectStdoutIncludes;
    if (entry.expectStdoutIncludes !== undefined) {
      expectStdoutIncludes = needString(
        entry.expectStdoutIncludes,
        `profile.checks[${id}].expectStdoutIncludes`,
        1024,
      );
    }
    checks[id] = {
      executable,
      args: needArgs(
        need(entry, "args", `profile.checks[${id}]`),
        `profile.checks[${id}].args`,
        true,
      ),
      contentDigest: needDigest(
        need(entry, "contentDigest", `profile.checks[${id}]`),
        `profile.checks[${id}].contentDigest`,
      ),
      expectExitCode,
      ...(expectStdoutIncludes !== undefined ? { expectStdoutIncludes } : {}),
    };
  }
  return checks;
}

function parseRuntime(raw) {
  if (!isRecord(raw)) fail("field profile.runtime must be an object");
  const keys = [
    "nodeRealpath",
    "ompRealpath",
    "bwrapRealpath",
    "systemdRunRealpath",
    "systemctlRealpath",
    "piOrchLauncherRealpath",
    "piOrchShellRealpath",
    "piOrchConfigRealpath",
    "piOrchExtensionRealpath",
    "piOrchLockRealpath",
  ];
  checkNoUnknown(raw, keys, "profile.runtime");
  const runtime = {};
  for (const key of keys) {
    if (raw[key] === undefined) continue;
    runtime[key] = needAbsolutePath(raw[key], `profile.runtime.${key}`);
  }
  return runtime;
}

// The installed pi-orch launcher is the trust anchor for its own small closure.
// Every other pinned path must be derived from that launcher root, so a caller
// cannot pair an approved launcher with an unrelated shell/extension/deps tree.
function assertRealPiRuntime(executor, runtime) {
  if (executor.kind !== "real-pi") return;
  for (const key of [
    "ompRealpath",
    "piOrchLauncherRealpath",
    "piOrchShellRealpath",
    "piOrchConfigRealpath",
    "piOrchExtensionRealpath",
    "piOrchLockRealpath",
  ]) {
    if (runtime[key] === undefined)
      fail(`real-pi executor requires profile.runtime.${key}`);
  }
  const root = dirname(dirname(runtime.piOrchLauncherRealpath));
  const expected = {
    piOrchShellRealpath: join(root, "scripts", "pi_codex_orchestrator.sh"),
    piOrchConfigRealpath: join(root, "scripts", "omp-orchestrator.yml"),
    piOrchExtensionRealpath: join(
      root,
      ".pi",
      "extensions",
      "opencode-orchestrator",
      "omp.ts",
    ),
    piOrchLockRealpath: join(root, "package-lock.json"),
  };
  for (const [key, path] of Object.entries(expected)) {
    if (runtime[key] !== path) {
      fail(
        `profile.runtime.${key} must be derived from the pi-orch launcher root: ${path}`,
      );
    }
  }
}

function parseLimits(raw) {
  if (!isRecord(raw)) fail("field profile.limits must be an object");
  const keys = [
    "maxDurationMs",
    "maxModelCalls",
    "maxOutputTokens",
    "maxModelCallMs",
    "maxSourceBytes",
    "maxDependencyBytes",
    "modelConcurrency",
    "maxProcesses",
    "memoryMaxBytes",
    "cpuQuotaPercent",
    "maxArtifactBytes",
    "workspaceMaxBytes",
  ];
  checkNoUnknown(raw, keys, "profile.limits");
  for (const key of keys) need(raw, key, "profile.limits");
  return {
    maxDurationMs: needInt(
      raw.maxDurationMs,
      "profile.limits.maxDurationMs",
      1_000,
      PROFILE_MAX_DURATION_MS,
    ),
    maxModelCalls: needInt(
      raw.maxModelCalls,
      "profile.limits.maxModelCalls",
      1,
      PROFILE_MAX_MODEL_CALLS,
    ),
    maxOutputTokens: needInt(
      raw.maxOutputTokens,
      "profile.limits.maxOutputTokens",
      1,
      PROFILE_MAX_OUTPUT_TOKENS,
    ),
    maxModelCallMs: needInt(
      raw.maxModelCallMs,
      "profile.limits.maxModelCallMs",
      // A policy may legitimately narrow the per-call timeout to 100ms (the
      // relay/policy parsers already accept >=100). Never clamp up to 1s.
      100,
      PROFILE_MAX_MODEL_CALL_MS,
    ),
    maxSourceBytes: needInt(
      raw.maxSourceBytes,
      "profile.limits.maxSourceBytes",
      1,
      PROFILE_MAX_SOURCE_BYTES,
    ),
    maxDependencyBytes: needInt(
      raw.maxDependencyBytes,
      "profile.limits.maxDependencyBytes",
      1,
      PROFILE_MAX_DEPENDENCY_BYTES,
    ),
    modelConcurrency: needInt(
      raw.modelConcurrency,
      "profile.limits.modelConcurrency",
      1,
      PROFILE_MAX_MODEL_CONCURRENCY,
    ),
    maxProcesses: needInt(
      raw.maxProcesses,
      "profile.limits.maxProcesses",
      1,
      PROFILE_MAX_PROCESSES,
    ),
    memoryMaxBytes: needInt(
      raw.memoryMaxBytes,
      "profile.limits.memoryMaxBytes",
      16 * 1024 * 1024,
      PROFILE_MAX_MEMORY_BYTES,
    ),
    cpuQuotaPercent: needInt(
      raw.cpuQuotaPercent,
      "profile.limits.cpuQuotaPercent",
      1,
      PROFILE_MAX_CPU_PERCENT,
    ),
    maxArtifactBytes: needInt(
      raw.maxArtifactBytes,
      "profile.limits.maxArtifactBytes",
      1,
      PROFILE_MAX_ARTIFACT_BYTES,
    ),
    workspaceMaxBytes: needInt(
      raw.workspaceMaxBytes,
      "profile.limits.workspaceMaxBytes",
      1,
      PROFILE_MAX_WORKSPACE_BYTES,
    ),
  };
}

function parseModel(raw) {
  if (!isRecord(raw)) fail("field profile.model must be an object");
  checkNoUnknown(
    raw,
    ["route", "sockHostPath", "externalConsent"],
    "profile.model",
  );
  const route = need(raw, "route", "profile.model");
  if (
    route !== "local" &&
    route !== "synthetic-local" &&
    route !== "external"
  ) {
    fail(
      'field profile.model.route must be "local", "synthetic-local", or "external"',
    );
  }
  const externalConsent = need(raw, "externalConsent", "profile.model");
  if (typeof externalConsent !== "boolean")
    fail("field profile.model.externalConsent must be a boolean");
  if (route === "external" && !externalConsent)
    fail("external route requires frozen externalConsent true");
  if (route !== "external" && externalConsent)
    fail("local/synthetic route must not claim externalConsent");
  const sockHostPath = needAbsolutePath(
    need(raw, "sockHostPath", "profile.model"),
    "profile.model.sockHostPath",
  );
  return { route, sockHostPath, externalConsent };
}

function parseDependencies(raw) {
  if (!isRecord(raw)) fail("field profile.dependencies must be an object");
  checkNoUnknown(
    raw,
    ["root", "manifestPath", "digest", "nodeAbi", "mounts"],
    "profile.dependencies",
  );
  const root = needAbsolutePath(
    need(raw, "root", "profile.dependencies"),
    "profile.dependencies.root",
  );
  const manifestPath = needAbsolutePath(
    need(raw, "manifestPath", "profile.dependencies"),
    "profile.dependencies.manifestPath",
  );
  const digest = needDigest(
    need(raw, "digest", "profile.dependencies"),
    "profile.dependencies.digest",
  );
  const mountsRaw = need(raw, "mounts", "profile.dependencies");
  if (
    !Array.isArray(mountsRaw) ||
    mountsRaw.length === 0 ||
    mountsRaw.length > 16
  ) {
    fail("profile.dependencies.mounts must carry 1..16 entries");
  }
  const mounts = [];
  for (const mount of mountsRaw) {
    if (!isRecord(mount))
      fail("profile.dependencies.mounts entries must be objects");
    checkNoUnknown(
      mount,
      ["source", "guestPath"],
      "profile.dependencies.mounts entry",
    );
    const source = needAbsolutePath(
      need(mount, "source", "profile.dependencies.mounts entry"),
      "profile.dependencies.mounts.source",
    );
    const guestPath = needString(
      need(mount, "guestPath", "profile.dependencies.mounts entry"),
      "profile.dependencies.mounts.guestPath",
      512,
    );
    if (
      !guestPath.startsWith("/") ||
      guestPath.includes("..") ||
      guestPath === "/"
    ) {
      fail(
        "profile.dependencies.mounts.guestPath must be an absolute guest path",
      );
    }
    if (!isPathInside(realpathSync(source), realpathSync(root))) {
      fail(
        "dependency mount source must be inside the dependency closure root",
      );
    }
    mounts.push({ source, guestPath });
  }
  const nodeAbi =
    raw.nodeAbi === undefined
      ? undefined
      : needInt(raw.nodeAbi, "profile.dependencies.nodeAbi", 1, 1000);
  return {
    root,
    manifestPath,
    digest,
    ...(nodeAbi !== undefined ? { nodeAbi } : {}),
    mounts,
  };
}

export function parseOperatorConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("operator config must be valid JSON");
  }
  if (!isRecord(raw)) fail("operator config must decode to an object");
  checkNoUnknown(
    raw,
    ["version", "stateDir", "storage", "active", "sealed", "profile"],
    "operator config",
  );
  for (const key of [
    "version",
    "stateDir",
    "storage",
    "active",
    "sealed",
    "profile",
  ]) {
    need(raw, key, "operator config");
  }
  if (raw.version !== PROFILE_SCHEMA_VERSION)
    fail(`field version must be ${PROFILE_SCHEMA_VERSION}`);
  const stateDir = needAbsolutePath(raw.stateDir, "stateDir");

  if (!isRecord(raw.storage)) fail("field storage must be an object");
  checkNoUnknown(
    raw.storage,
    ["maxRequestBytes", "maxArtifactBytes", "maxResultBytes", "maxDbBytes"],
    "field storage",
  );
  const storage = {};
  for (const key of [
    "maxRequestBytes",
    "maxArtifactBytes",
    "maxResultBytes",
    "maxDbBytes",
  ]) {
    storage[key] = needInt(
      need(raw.storage, key, "field storage"),
      `storage.${key}`,
      1,
      16 * 1024 * 1024 * 1024,
    );
  }

  if (!isRecord(raw.active)) fail("field active must be an object");
  checkNoUnknown(
    raw.active,
    ["configFingerprint", "sourceRevision", "workspaceAlias"],
    "field active",
  );
  const active = {
    configFingerprint: needDigest(
      need(raw.active, "configFingerprint", "field active"),
      "active.configFingerprint",
    ),
    sourceRevision: (() => {
      const value = need(raw.active, "sourceRevision", "field active");
      if (typeof value !== "string" || !HEX40_RE.test(value))
        fail("field active.sourceRevision must be 40 lower-hex chars");
      return value;
    })(),
    workspaceAlias: (() => {
      const value = need(raw.active, "workspaceAlias", "field active");
      if (typeof value !== "string" || !ALIAS_RE.test(value))
        fail("field active.workspaceAlias must match [a-z0-9_-]{1,64}");
      return value;
    })(),
  };

  if (!isRecord(raw.sealed)) fail("field sealed must be an object");
  checkNoUnknown(
    raw.sealed,
    [
      "rootDir",
      "snapshotRoot",
      "manifestPath",
      "manifestDigest",
      "pristineSnapshotRoot",
      "sourceRootOriginal",
    ],
    "field sealed",
  );
  const sealed = {
    rootDir: needAbsolutePath(
      need(raw.sealed, "rootDir", "field sealed"),
      "sealed.rootDir",
    ),
    snapshotRoot: needAbsolutePath(
      need(raw.sealed, "snapshotRoot", "field sealed"),
      "sealed.snapshotRoot",
    ),
    manifestPath: needAbsolutePath(
      need(raw.sealed, "manifestPath", "field sealed"),
      "sealed.manifestPath",
    ),
    manifestDigest: needDigest(
      need(raw.sealed, "manifestDigest", "field sealed"),
      "sealed.manifestDigest",
    ),
    pristineSnapshotRoot: needAbsolutePath(
      need(raw.sealed, "pristineSnapshotRoot", "field sealed"),
      "sealed.pristineSnapshotRoot",
    ),
    sourceRootOriginal: needAbsolutePath(
      need(raw.sealed, "sourceRootOriginal", "field sealed"),
      "sealed.sourceRootOriginal",
    ),
  };

  if (!isRecord(raw.profile)) fail("field profile must be an object");
  checkNoUnknown(
    raw.profile,
    [
      "executionBackend",
      "executor",
      "checks",
      "runtime",
      "model",
      "limits",
      "allowedPaths",
      "scratchPaths",
      "dependencies",
    ],
    "field profile",
  );
  const executionBackend = need(
    raw.profile,
    "executionBackend",
    "field profile",
  );
  if (
    executionBackend !== "confined" &&
    executionBackend !== "offline-fixture"
  ) {
    fail(
      'field profile.executionBackend must be "confined" or "offline-fixture"',
    );
  }
  const allowedPaths = need(raw.profile, "allowedPaths", "field profile");
  const scratchPaths = need(raw.profile, "scratchPaths", "field profile");
  const parseScopes = (value, field, minItems = 1) => {
    if (!Array.isArray(value) || value.length < minItems || value.length > 32) {
      fail(`field ${field} must carry ${minItems}..32 entries`);
    }
    return value.map((entry, index) => {
      if (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 512
      ) {
        fail(`field ${field}[${index}] must be a relative path`);
      }
      if (
        entry.startsWith("/") ||
        entry.includes("\\") ||
        entry.includes("\0")
      ) {
        fail(`field ${field}[${index}] must be a relative POSIX path`);
      }
      for (const segment of entry.split("/")) {
        if (segment === "" || segment === "." || segment === "..") {
          fail(`field ${field}[${index}] contains an invalid segment`);
        }
      }
      return entry;
    });
  };
  const profile = {
    executionBackend,
    executor: parseExecutor(need(raw.profile, "executor", "field profile")),
    checks: parseChecks(need(raw.profile, "checks", "field profile")),
    runtime: parseRuntime(need(raw.profile, "runtime", "field profile")),
    model: parseModel(need(raw.profile, "model", "field profile")),
    limits: parseLimits(need(raw.profile, "limits", "field profile")),
    allowedPaths: parseScopes(allowedPaths, "profile.allowedPaths"),
    scratchPaths: parseScopes(scratchPaths, "profile.scratchPaths", 0),
    dependencies: parseDependencies(
      need(raw.profile, "dependencies", "field profile"),
    ),
  };
  assertScratchDisjoint(profile.allowedPaths, profile.scratchPaths);
  if (
    profile.executor.kind === "pi-orch-guest" &&
    profile.runtime.ompRealpath === undefined
  ) {
    fail(
      "profile.executor.kind pi-orch-guest requires profile.runtime.ompRealpath",
    );
  }
  assertRealPiRuntime(profile.executor, profile.runtime);
  return {
    version: PROFILE_SCHEMA_VERSION,
    stateDir,
    storage,
    active,
    sealed,
    profile,
  };
}

function hashIfPresent(path) {
  if (!existsSync(path)) return null;
  return hashFileSync(path);
}

/**
 * Compute the effective profile fingerprint from ACTUAL file content. The
 * operator-declared active.configFingerprint/sourceRevision are compared to
 * this result before any request is reserved.
 */
export function computeEffectiveProfile(config) {
  const snapshotDigest = config.sealed.manifestDigest;
  const sourceRevision = sourceRevisionForManifest(snapshotDigest);
  const executorDigest = hashFileSync(config.profile.executor.executable);
  if (executorDigest !== config.profile.executor.contentDigest) {
    fail("executor content digest does not match the pinned profile");
  }
  const checks = {};
  for (const [id, check] of Object.entries(config.profile.checks)) {
    const actual = hashFileSync(check.executable);
    if (actual !== check.contentDigest)
      fail(`check ${id} content digest does not match the pinned profile`);
    checks[id] = { ...check, contentDigest: actual };
  }
  const runtime = {};
  for (const [key, path] of Object.entries(config.profile.runtime)) {
    const actual = hashIfPresent(path);
    if (actual === null) {
      if (config.profile.executionBackend === "confined")
        fail(`runtime binary is missing: ${key}`);
      runtime[key] = { path, contentDigest: null };
      continue;
    }
    runtime[key] = { path, contentDigest: actual };
  }
  const effective = {
    version: PROFILE_SCHEMA_VERSION,
    workspaceAlias: config.active.workspaceAlias,
    sourceRevision,
    sourceManifestDigest: snapshotDigest,
    sealed: {
      rootDir: config.sealed.rootDir,
      snapshotRoot: config.sealed.snapshotRoot,
      manifestPath: config.sealed.manifestPath,
      pristineSnapshotRoot: config.sealed.pristineSnapshotRoot,
    },
    executor: {
      kind: config.profile.executor.kind ?? "fixed",
      executable: config.profile.executor.executable,
      args: config.profile.executor.args,
      contentDigest: executorDigest,
      // Omit the empty list so existing frozen profiles keep their exact
      // fingerprint; enabling the allowlist is a real profile change.
      ...((config.profile.executor.guestEnv ?? []).length > 0
        ? { guestEnv: config.profile.executor.guestEnv }
        : {}),
    },
    checks,
    runtime,
    model: config.profile.model,
    limits: config.profile.limits,
    scopes: {
      allowedPaths: config.profile.allowedPaths,
      scratchPaths: config.profile.scratchPaths,
    },
    executionBackend: config.profile.executionBackend,
    dependencies: {
      root: config.profile.dependencies.root,
      manifestPath: config.profile.dependencies.manifestPath,
      digest: config.profile.dependencies.digest,
      manifestContentDigest: hashIfPresent(
        config.profile.dependencies.manifestPath,
      ),
      ...(config.profile.dependencies.nodeAbi !== undefined
        ? { nodeAbi: config.profile.dependencies.nodeAbi }
        : {}),
      mounts: config.profile.dependencies.mounts,
    },
    storage: config.storage,
  };
  if (config.profile.dependencies.nodeAbi !== undefined) {
    if (config.profile.runtime.nodeRealpath === undefined) {
      fail(
        "profile.dependencies.nodeAbi requires profile.runtime.nodeRealpath",
      );
    }
    const actualAbi = readNodeAbi(config.profile.runtime.nodeRealpath);
    if (actualAbi !== config.profile.dependencies.nodeAbi) {
      fail(
        "dependency closure Node ABI does not match the pinned runtime node",
      );
    }
  }
  const fingerprint = createHash("sha256")
    .update(canonicalize(effective))
    .digest("hex");
  return {
    fingerprint,
    effective,
    sourceRevision,
    executorDigest,
    checks,
    runtime,
    dependenciesManifestDigest: effective.dependencies.manifestContentDigest,
  };
}

export function assertProfileMatches(config, effective) {
  if (config.active.configFingerprint !== effective.fingerprint) {
    fail(
      "active.configFingerprint does not match the actual effective profile content",
    );
  }
  if (config.active.sourceRevision !== effective.sourceRevision) {
    fail("active.sourceRevision is not the computed sealed snapshot revision");
  }
}

/** Load and validate the sealed snapshot manifest without touching the source. */
export function loadSealedSnapshot(config, options = {}) {
  const rootDir = realpathSync(config.sealed.rootDir);
  const snapshotRoot = realpathSync(config.sealed.snapshotRoot);
  const manifestPath = realpathSync(config.sealed.manifestPath);
  const pristine = realpathSync(config.sealed.pristineSnapshotRoot);
  const original = realpathSync(config.sealed.sourceRootOriginal);
  for (const [label, path] of [
    ["snapshotRoot", snapshotRoot],
    ["manifestPath", manifestPath],
    ["pristineSnapshotRoot", pristine],
  ]) {
    if (!isPathInside(path, rootDir))
      fail(`sealed.${label} must be inside sealed.rootDir`);
  }
  if (
    snapshotRoot === original ||
    isPathInside(snapshotRoot, original) ||
    isPathInside(original, snapshotRoot)
  ) {
    fail("snapshotRoot must not alias or contain the original source root");
  }
  if (snapshotRoot === pristine)
    fail("snapshotRoot must be separate from the pristine snapshot");
  if (existsSync(join(snapshotRoot, ".git")))
    fail("sealed snapshot must not contain .git");
  if (
    existsSync(join(snapshotRoot, "node_modules")) &&
    lstatSync(join(snapshotRoot, "node_modules")).isSymbolicLink()
  ) {
    fail("sealed snapshot must not expose a host node_modules symlink");
  }
  const manifestStat = statSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 8 * 1024 * 1024) {
    fail("sealed manifest is missing or oversized");
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    fail("sealed manifest is malformed");
  }
  if (
    options.expectedManifestDigest !== undefined &&
    options.expectedManifestDigest !== config.sealed.manifestDigest
  ) {
    fail(
      "sealed.manifestDigest does not match the host-pinned expected digest",
    );
  }
  if (parsed.manifestDigest !== config.sealed.manifestDigest) {
    fail("sealed.manifestDigest does not match the manifest file");
  }
  if (
    parsed.manifestDigest !== options.expectedManifestDigest &&
    options.expectedManifestDigest !== undefined
  ) {
    fail("manifest file digest does not match the host-pinned expected digest");
  }
  if (parsed.snapshotRoot !== snapshotRoot) {
    fail("manifest snapshotRoot does not match sealed.snapshotRoot");
  }
  const snapshot = {
    schemaVersion: 1,
    canonicalRoot: parsed.canonicalRoot,
    snapshotRoot,
    manifestPath,
    manifest: parsed.entries,
    manifestDigest: parsed.manifestDigest,
    sourceIdentity: parsed.sourceIdentity,
    maxSourceBytes: parsed.maxSourceBytes,
    maxArtifactBytes: parsed.maxArtifactBytes,
    maxFiles: parsed.maxFiles,
  };
  return snapshot;
}

function denyDependencyName(name) {
  const base = name.toLowerCase();
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".npmrc" ||
    base === ".netrc" ||
    base === ".git-credentials" ||
    base === ".pgpass" ||
    /\.(pem|key|p12|pfx|kdbx|ovpn|sqlite|sqlite3|db|db3|secret|secrets|credential|credentials|token|password)$/.test(
      base,
    )
  );
}

/**
 * Verify the offline dependency closure. Missing/tampered deps are a
 * dependency blocker (not a skipped check). Symlinks are allowed only when
 * their resolved target stays inside the closure root; escaping links fail.
 */
export function computeDependencyClosureDigest(rootInput, maxBytes) {
  const root = realpathSync(rootInput);
  if (root !== rootInput) fail("dependency root must be a canonical real path");
  const hashes = [];
  let total = 0;
  const walk = (absolute, rel) => {
    const st = lstatSync(absolute);
    if (st.isSymbolicLink()) {
      const target = realpathSync(absolute);
      if (!isPathInside(target, root))
        fail(`dependency symlink escapes the closure: ${rel}`);
      hashes.push(`${rel}\0L\0${relative(root, target)}`);
      return;
    }
    if (st.isDirectory()) {
      const names = [...nodeReaddirSync(absolute)];
      names.sort();
      for (const name of names) {
        if (rel === "" && name === ".git")
          fail("dependency closure must not contain .git");
        walk(join(absolute, name), rel === "" ? name : `${rel}/${name}`);
      }
      return;
    }
    if (!st.isFile()) fail(`dependency entry is not a regular file: ${rel}`);
    if (denyDependencyName(rel))
      fail(`dependency closure contains a forbidden file: ${rel}`);
    total += st.size;
    if (total > maxBytes)
      fail("dependency closure exceeds the declared byte cap");
    hashes.push(
      `${rel}\0F\0${st.mode & 0o7777}\0${st.size}\0${hashFileSync(absolute)}`,
    );
  };
  walk(root, "");
  const digest = createHash("sha256").update(hashes.join("\n")).digest("hex");
  return { digest, totalBytes: total, entryCount: hashes.length };
}

export function verifyDependencyClosure(deps, maxBytes) {
  const result = computeDependencyClosureDigest(deps.root, maxBytes);
  if (result.digest !== deps.digest)
    fail("dependency closure digest does not match the pinned profile");
  return result;
}

export function assertConsent(profile, request) {
  if (profile.model.route === "external") {
    if (request.externalModelConsent !== true)
      fail(
        "request did not grant externalModelConsent for the frozen external route",
      );
    return;
  }
  if (request.externalModelConsent) {
    fail(
      "request asks for external model use outside the frozen local profile",
    );
  }
}

export function assertRequestScopes(profile, request) {
  for (const path of request.relevantPaths) {
    if (!isPathInScopesLocal(path, profile.allowedPaths)) {
      fail(
        `request relevantPath is outside the frozen operator scope: ${path}`,
      );
    }
  }
  for (const id of request.requiredChecks) {
    if (!Object.hasOwn(profile.checks, id)) {
      fail(`unknown required check: ${id}`);
    }
  }
}

function isPathInScopesLocal(rel, scopes) {
  for (const scope of scopes) {
    if (scope === ".") return true;
    if (rel === scope || rel.startsWith(`${scope}/`)) return true;
  }
  return false;
}

export function assertRequestBudget(profile, request) {
  if (request.budget.timeoutMs > profile.limits.maxDurationMs) {
    fail("request budget exceeds the frozen maxDurationMs");
  }
  if (request.budget.maxOutputBytes > profile.limits.maxArtifactBytes * 4) {
    fail("request output budget exceeds the frozen output cap");
  }
}
