// Trusted-host execution-profile and offline dependency materializer.
//
// Core callers use these exported functions to turn a reviewed policy plus a
// sealed snapshot into the exact operator config consumed by
// companion-bridge.mjs:
//
//   prepareDependencyClosure({ sourceNodeModules, destinationRoot, ... })
//   prepareExecutorProfile({ snapshotRoot, expectedManifestDigest, ... })
//   buildBridgeExecConfig({ snapshotRoot, expectedManifestDigest, policy, modelUDS })
//
// The builder recomputes the effective fingerprint from real file content and
// the sealed manifest, never from a worker-declared sourceRevision. The
// dependency materializer copies an approved pnpm node_modules closure into a
// new read-only depot, rejects escaping symlinks, hashes every file, pins the
// real Node ABI for declared native packages, and never installs or runs
// package scripts.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  computeDependencyClosureDigest,
  computeEffectiveProfile,
  hashFileSync,
  parseOperatorConfig,
  readNodeAbi,
} from "./sealed-profile.mjs";
import { verifySealedWorkspaceSnapshot } from "../../packages/kernel/src/autonomous_workspace.ts";

const MANIFEST_SUFFIX = ".closure-manifest.json";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 200_000;
const NATIVE_PACKAGES = ["better-sqlite3"];

function fail(message) {
  throw new Error(`execution-profile: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function needAbsolutePath(value, field) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    fail(`${field} must be an absolute path`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) fail(`${field} contains control characters`);
  return value;
}

function needDigest(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${field} must be 64 lower-hex chars`);
  return value;
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
    /\.(pem|key|p12|pfx|kdbx|ovpn|secret|secrets|credential|credentials|token|password)$/.test(base)
  );
}

function copyFileBounded(source, destination, budget) {
  const st = lstatSync(source);
  if (!st.isFile()) fail(`dependency entry is not a regular file: ${source}`);
  budget.total += st.size;
  if (budget.total > budget.maxBytes) fail("dependency closure exceeds the declared byte cap");
  const inFd = openSync(source, "r");
  const outFd = openSync(destination, "w", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(inFd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      writeSync(outFd, buffer.subarray(0, read));
    }
  } finally {
    closeSync(inFd);
    closeSync(outFd);
  }
  chmodSync(destination, (st.mode & 0o111) !== 0 ? 0o555 : 0o444);
}

function copyClosure(sourceRoot, destinationRoot, budget) {
  const entries = [];
  const walk = (sourceAbsolute, destinationAbsolute, rel) => {
    const st = lstatSync(sourceAbsolute);
    if (st.isSymbolicLink()) {
      const resolved = realpathSync(sourceAbsolute);
      if (!isInside(resolved, sourceRoot)) fail(`dependency symlink escapes the approved depot: ${rel}`);
      const targetRel = relative(sourceRoot, resolved);
      const linkTarget = relative(dirname(destinationAbsolute), join(destinationRoot, targetRel));
      symlinkSync(linkTarget, destinationAbsolute);
      entries.push({ path: rel, type: "symlink", target: targetRel });
      return;
    }
    if (st.isDirectory()) {
      mkdirSync(destinationAbsolute, { recursive: true, mode: 0o700 });
      entries.push({ path: rel, type: "directory" });
      const names = [...readdirSync(sourceAbsolute)].sort();
      for (const name of names) {
        if (rel === "" && name === ".git") fail("dependency closure must not contain .git");
        if (denyDependencyName(name)) fail(`dependency closure contains a forbidden entry: ${rel === "" ? name : `${rel}/${name}`}`);
        walk(join(sourceAbsolute, name), join(destinationAbsolute, name), rel === "" ? name : `${rel}/${name}`);
      }
      return;
    }
    if (!st.isFile()) fail(`dependency entry is not a regular file: ${rel}`);
    budget.entries += 1;
    if (budget.entries > budget.maxEntries) fail("dependency closure exceeds the entry cap");
    copyFileBounded(sourceAbsolute, destinationAbsolute, budget);
    entries.push({ path: rel, type: "file", mode: st.mode & 0o7777, size: st.size, sha256: hashFileSync(sourceAbsolute) });
  };
  walk(join(sourceRoot, "."), join(destinationRoot, "node_modules"), "node_modules");
  return entries;
}

function makeTreeReadOnly(root) {
  const walk = (absolute) => {
    const st = lstatSync(absolute);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(absolute)) walk(join(absolute, name));
      chmodSync(absolute, 0o555);
      return;
    }
    chmodSync(absolute, (st.mode & 0o111) !== 0 ? 0o555 : 0o444);
  };
  for (const name of readdirSync(root)) walk(join(root, name));
}

function nativeModulesFor(entries, requiredPackages) {
  const found = [];
  for (const name of requiredPackages) {
    const prefix = `node_modules/${name}/`;
    const native = entries.filter(
      (entry) => entry.type === "file" && entry.path.startsWith(prefix) && entry.path.endsWith(".node"),
    );
    if (native.length === 0) fail(`required native package has no compiled .node file: ${name}`);
    for (const entry of native) found.push({ package: name, path: entry.path, size: entry.size, sha256: entry.sha256 });
  }
  return found;
}

/**
 * Materialize a pnpm node_modules closure into a NEW read-only depot.
 *
 * - sourceNodeModules may itself be a symlink, but every resolved entry must
 *   stay inside the approved source root.
 * - destinationRoot must be new/empty and outside the source tree.
 * - relative symlinks are recreated inside the destination; no host symlink
 *   is dereferenced into the guest.
 * - no network, no package install, no lifecycle script, no host check.
 */
export function prepareDependencyClosure(options) {
  if (!isRecord(options)) fail("prepareDependencyClosure requires an options object");
  const sourceInput = needAbsolutePath(options.sourceNodeModules, "sourceNodeModules");
  const destinationRoot = needAbsolutePath(options.destinationRoot, "destinationRoot");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("maxBytes must be a positive safe integer");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) fail("maxEntries must be a positive safe integer");

  const sourceRoot = realpathSync(sourceInput);
  const sourceStat = statSync(sourceRoot);
  if (!sourceStat.isDirectory()) fail("sourceNodeModules must resolve to a directory");
  if (!existsSync(destinationRoot)) {
    mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  }
  const destinationReal = realpathSync(destinationRoot);
  if (isInside(destinationReal, sourceRoot) || isInside(sourceRoot, destinationReal)) {
    fail("destinationRoot must be disjoint from sourceNodeModules");
  }
  const destinationStat = lstatSync(destinationReal);
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) fail("destinationRoot must be a real directory");
  if (readdirSync(destinationReal).length !== 0) fail("destinationRoot must be empty");

  const budget = { total: 0, entries: 0, maxBytes, maxEntries };
  const entries = copyClosure(sourceRoot, destinationReal, budget);
  makeTreeReadOnly(destinationReal);
  const closure = computeDependencyClosureDigest(destinationReal, maxBytes);

  const requiredPackages = ["better-sqlite3", ...(options.requiredPackages ?? [])].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  const nodeRealpath = options.nodeRealpath === undefined ? undefined : needAbsolutePath(options.nodeRealpath, "nodeRealpath");
  const nodeAbi = options.expectedNodeAbi ?? (nodeRealpath === undefined ? undefined : readNodeAbi(nodeRealpath));
  if (nodeAbi !== undefined && (!Number.isSafeInteger(nodeAbi) || nodeAbi <= 0 || nodeAbi > 1000)) {
    fail("expectedNodeAbi must be a valid Node ABI integer");
  }
  if (nodeAbi === undefined && requiredPackages.some((name) => NATIVE_PACKAGES.includes(name))) {
    fail("a declared native dependency requires nodeRealpath or expectedNodeAbi");
  }
  const nativeModules = nativeModulesFor(entries, requiredPackages).map((entry) => ({ ...entry, nodeAbi }));

  const manifestPath = `${destinationReal}${MANIFEST_SUFFIX}`;
  const manifest = {
    schemaVersion: 1,
    sourceRoot,
    root: destinationReal,
    digest: closure.digest,
    nodeAbi: nodeAbi ?? null,
    totalBytes: closure.totalBytes,
    entryCount: entries.length,
    nativeModules,
    entries,
  };
  const manifestText = `${JSON.stringify(manifest)}\n`;
  writeFileSync(manifestPath, manifestText, { mode: 0o444 });
  chmodSync(manifestPath, 0o444);
  return {
    root: destinationReal,
    manifestPath,
    digest: closure.digest,
    nodeAbi: nodeAbi ?? null,
    totalBytes: closure.totalBytes,
    entryCount: entries.length,
    nativeModules,
    mounts: [{ source: join(destinationReal, "node_modules"), guestPath: "/deps/node_modules" }],
  };
}

function readSnapshotManifest(snapshotRootInput, manifestPathInput) {
  const snapshotRoot = realpathSync(needAbsolutePath(snapshotRootInput, "snapshotRoot"));
  const manifestPath = realpathSync(
    needAbsolutePath(manifestPathInput ?? join(dirname(snapshotRoot), "workspace-manifest.json"), "snapshotManifestPath"),
  );
  const stat = statSync(manifestPath);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail("sealed manifest is missing or oversized");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    fail("sealed manifest is malformed");
  }
  return {
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
}

function buildRawConfig(options) {
  if (!isRecord(options)) fail("buildBridgeExecConfig requires an options object");
  const policy = options.policy;
  if (!isRecord(policy)) fail("policy is required");
  const storage = options.storage ?? {
    maxRequestBytes: 256 * 1024,
    maxArtifactBytes: 256 * 1024,
    maxResultBytes: 256 * 1024,
    maxDbBytes: 64 * 1024 * 1024,
  };
  const stateDir = needAbsolutePath(options.stateDir, "stateDir");
  const modelUDS = needAbsolutePath(options.modelUDS, "modelUDS");
  const sealedRoot = needAbsolutePath(options.sealedRoot, "sealedRoot");
  const pristineSnapshotRoot = needAbsolutePath(options.pristineSnapshotRoot, "pristineSnapshotRoot");
  const sourceRootOriginal = needAbsolutePath(options.sourceRootOriginal, "sourceRootOriginal");
  const snapshotRoot = realpathSync(needAbsolutePath(options.snapshotRoot, "snapshotRoot"));
  const snapshotManifestPath = realpathSync(
    needAbsolutePath(options.snapshotManifestPath ?? join(dirname(snapshotRoot), "workspace-manifest.json"), "snapshotManifestPath"),
  );

  if (!isRecord(policy.executor)) fail("policy.executor is required");
  const executor = {
    kind: policy.executor.kind ?? "fixed",
    executable: needAbsolutePath(policy.executor.executable, "policy.executor.executable"),
    args: policy.executor.args ?? [],
    contentDigest: policy.executor.contentDigest ?? hashFileSync(policy.executor.executable),
  };
  if (!isRecord(policy.checks) || Object.keys(policy.checks).length === 0) fail("policy.checks is required");
  const checks = {};
  for (const [id, check] of Object.entries(policy.checks)) {
    checks[id] = {
      ...check,
      contentDigest: check.contentDigest ?? hashFileSync(check.executable),
    };
  }
  if (!isRecord(policy.runtime) || policy.runtime.nodeRealpath === undefined) fail("policy.runtime.nodeRealpath is required");
  if (executor.kind === "pi-orch-guest" && policy.runtime.ompRealpath === undefined) {
    fail("pi-orch-guest executor requires policy.runtime.ompRealpath");
  }
  if (!isRecord(policy.dependencies)) fail("policy.dependencies is required");
  const depsRoot = needAbsolutePath(policy.dependencies.root, "policy.dependencies.root");
  const depsManifest = needAbsolutePath(policy.dependencies.manifestPath, "policy.dependencies.manifestPath");
  if (!existsSync(depsManifest)) fail("policy.dependencies.manifestPath does not exist");
  if (isInside(depsRoot, snapshotRoot) || isInside(snapshotRoot, depsRoot)) {
    fail("dependency depot must be disjoint from the sealed source snapshot");
  }
  return {
    version: 2,
    stateDir,
    storage,
    active: {
      configFingerprint: "0".repeat(64),
      sourceRevision: "0".repeat(40),
      workspaceAlias: options.workspaceAlias ?? "synthetic",
    },
    sealed: {
      rootDir: sealedRoot,
      snapshotRoot,
      manifestPath: snapshotManifestPath,
      manifestDigest: needDigest(options.expectedManifestDigest, "expectedManifestDigest"),
      pristineSnapshotRoot,
      sourceRootOriginal,
    },
    profile: {
      executionBackend: policy.executionBackend ?? "confined",
      executor,
      checks,
      runtime: policy.runtime,
      model: {
        route: policy.modelRoute ?? "local",
        sockHostPath: modelUDS,
        externalConsent: policy.externalConsent ?? false,
      },
      limits: policy.limits,
      allowedPaths: policy.allowedPaths,
      scratchPaths: policy.scratchPaths ?? [],
      dependencies: {
        root: depsRoot,
        manifestPath: depsManifest,
        digest: needDigest(policy.dependencies.digest, "policy.dependencies.digest"),
        ...(policy.dependencies.nodeAbi !== undefined ? { nodeAbi: policy.dependencies.nodeAbi } : {}),
        mounts: policy.dependencies.mounts,
      },
    },
  };
}

function assertSealedLayout(raw) {
  const root = realpathSync(raw.sealed.rootDir);
  for (const key of ["snapshotRoot", "manifestPath", "pristineSnapshotRoot"]) {
    const path = realpathSync(raw.sealed[key]);
    if (!isInside(path, root)) fail(`sealed.${key} must be inside sealedRoot`);
  }
}

/**
 * Validate a frozen policy against a real sealed snapshot and return the
 * parsed/effective config. The expected digest is the host trust anchor and
 * is verified against the manifest file plus every snapshot byte.
 */
export async function prepareExecutorProfile(options) {
  const raw = buildRawConfig(options);
  const config = parseOperatorConfig(JSON.stringify(raw));
  assertSealedLayout(config);
  const snapshot = readSnapshotManifest(options.snapshotRoot, options.snapshotManifestPath);
  if (snapshot.manifestDigest !== options.expectedManifestDigest) {
    fail("manifest file does not carry the host-pinned expectedManifestDigest");
  }
  const verification = await verifySealedWorkspaceSnapshot(snapshot, {
    expectedManifestDigest: options.expectedManifestDigest,
  });
  if (!verification.ok) fail(`sealed snapshot verification failed: ${verification.reason}`);
  const effective = computeEffectiveProfile(config);
  return { config, effective, snapshot };
}

/**
 * Build (and optionally write) the exact operator config for a core grant.
 * active.configFingerprint/sourceRevision are always recomputed from actual
 * content, never accepted from the caller.
 */
export async function buildBridgeExecConfig(options) {
  const prepared = await prepareExecutorProfile(options);
  const config = prepared.config;
  config.active.configFingerprint = prepared.effective.fingerprint;
  config.active.sourceRevision = prepared.effective.sourceRevision;
  const parsed = parseOperatorConfig(JSON.stringify(config));
  const effective = computeEffectiveProfile(parsed);
  if (effective.fingerprint !== prepared.effective.fingerprint) fail("effective profile changed while finalizing the bridge config");
  const configPath = options.configPath ?? join(parsed.stateDir, "operator.json");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { config: parsed, configPath, effective, snapshot: prepared.snapshot };
}

export { MANIFEST_SUFFIX };
