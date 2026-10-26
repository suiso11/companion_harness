// Build the frozen trial-operator snapshot from the DEPLOYED source revision.
//
// The source tree is exported with `git archive <deployed sha>` (never a dirty
// checkout), materialized through the real autodispatch materializer, verified
// with parseOperatorConfig/computeEffectiveProfile and the real
// parseTrialConfig, and only then published atomically:
//   - ~/.config/companion/autonomy.env (0600, COMPANION_AUTONOMY_JSON='...')
//   - <stateRoot>/operator.json
// Previous frozen roots stay in place until success; afterwards the newest two
// are kept.
//
// Host-specific constants live in ~/.config/companion/trial-operator.json
// (override with COMPANION_TRIAL_OPERATOR_INPUT). No secrets are read or
// written.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertHostAutodispatchChecks,
  formatAutonomyEnvLine,
  frozenRootReferencedByOperator,
  resolveCurrentModel,
  SEALED_SOURCE_ROOTS,
  SEALED_TOP_LEVEL_FILES,
  sealedLintArgs,
  selectCheckCommands,
  selectFrozenRootsToPrune,
  selectSealedChecks,
  validateTrialOperatorInput,
} from "./trialOperator.mjs";

// Throw instead of exiting so the catch below always runs and removes the
// half-built root. process.exit(1) would skip the cleanup.
const fail = (message: string): never => {
  throw new Error(message);
};

const INPUT_PATH =
  process.env.COMPANION_TRIAL_OPERATOR_INPUT ??
  join(homedir(), ".config", "companion", "trial-operator.json");
if (!existsSync(INPUT_PATH)) fail(`input file missing: ${INPUT_PATH}`);
let rawInput: unknown;
try {
  rawInput = JSON.parse(readFileSync(INPUT_PATH, "utf8"));
} catch (err) {
  fail(`input file is not valid JSON: ${String(err)}`);
}
const input = validateTrialOperatorInput(rawInput);

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", input.sourceRepo, ...args], {
    encoding: "utf8",
  }).trim();

const deployedSha = git("rev-parse", "HEAD");
if (!/^[0-9a-f]{40}$/.test(deployedSha))
  fail(`unexpected HEAD: ${deployedSha}`);
const sourceRefSha = git("rev-parse", "--verify", input.sourceRef);
if (sourceRefSha !== deployedSha) {
  fail(
    `${input.sourceRepo} HEAD ${deployedSha.slice(0, 12)} does not match ${input.sourceRef} ${sourceRefSha.slice(0, 12)}`,
  );
}

const short = deployedSha.slice(0, 7);
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const ROOT = join(input.stateRoot, `frozen-${short}-${stamp}`);
if (existsSync(ROOT)) fail(`target root already exists: ${ROOT}`);
const SRC = join(ROOT, "source");
const STATE = join(ROOT, "state");
const DEP_SOURCE = join(input.stateRoot, "dep-source-clean", "node_modules");

// The trial model must equal the model the restarted server will use or
// bootstrap.ts refuses to start ("trial currentModel must match model
// config"). Derive it exactly like run-google-readonly.sh from the deploy
// environment; the key value is never returned or logged.
const LITELLM_ENV_FILE = join(input.sourceRepo, ".env.litellm");
const currentModel = resolveCurrentModel(
  process.env,
  existsSync(LITELLM_ENV_FILE) ? readFileSync(LITELLM_ENV_FILE, "utf8") : null,
);

// Load the validators/materializer from the deployed checkout so the build
// uses exactly the deployed code. (The sealed content itself comes from the
// clean archive below.)
const cfg = await import(
  pathToFileURL(join(input.sourceRepo, "apps/server/src/config.ts")).href
);
const mat = await import(
  pathToFileURL(
    join(input.sourceRepo, "apps/server/src/autodispatch_materializer.ts"),
  ).href
);
const sealed = await import(
  pathToFileURL(
    join(input.sourceRepo, "scripts/pi-orch-bridge/sealed-profile.mjs"),
  ).href
);
const { parseTrialConfig, parseAutodispatchConfig } = cfg;
const { createAutodispatchMaterializer } = mat;
const {
  parseOperatorConfig,
  computeEffectiveProfile,
  PROFILE_MAX_MODEL_CALLS,
} = sealed;

const atomicWrite = (path: string, data: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
};
const hashFile = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const listFiles = (root: string, rel = ""): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const r = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, r));
    else if (entry.isFile()) out.push(r);
  }
  return out.sort();
};

const runtime: Record<string, string> = {};
for (const [key, path] of Object.entries(input.runtime)) {
  if (!existsSync(path)) fail(`runtime ${key} is missing: ${path}`);
  runtime[key] = realpathSync(path);
}
const NODE = runtime.nodeRealpath;
if (!NODE) fail("runtime.nodeRealpath is required");

// Set once operator.json + autonomy.env are published. A failure afterwards
// must not delete the published root, because both files would then point at
// a missing snapshot/executor.
let published = false;
try {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  mkdirSync(SRC, { recursive: true, mode: 0o700 });

  // 1. Clean source export from the deployed commit.
  const archive = execFileSync(
    "git",
    ["-C", input.sourceRepo, "archive", "--format=tar", deployedSha],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  const untar = spawnSync("tar", ["-x", "-C", SRC], {
    input: archive,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (untar.status !== 0)
    fail(`git archive extraction failed: ${untar.status}`);
  if (existsSync(join(SRC, ".git"))) fail("clean source export contains .git");
  if (listFiles(SRC).length === 0) fail("clean source export is empty");

  // 2. Refresh the clean dependency source from the deployed node_modules.
  const depRoot = join(input.stateRoot, "dep-source-clean");
  rmSync(depRoot, { recursive: true, force: true });
  mkdirSync(depRoot, { recursive: true, mode: 0o700 });
  const sourceNodeModules = join(input.sourceRepo, "node_modules");
  if (!existsSync(sourceNodeModules)) {
    fail(
      `deployed node_modules missing (run pnpm install): ${sourceNodeModules}`,
    );
  }
  try {
    execFileSync("cp", ["-al", sourceNodeModules, DEP_SOURCE], {
      stdio: "inherit",
    });
  } catch {
    // Hard links cannot cross filesystems (stateRoot and the checkout are
    // independently configurable). Fall back to a real copy, removing any
    // partial staging tree first.
    rmSync(DEP_SOURCE, { recursive: true, force: true });
    execFileSync("cp", ["-a", sourceNodeModules, DEP_SOURCE], {
      stdio: "inherit",
    });
  }
  const workspaceLinks = join(
    DEP_SOURCE,
    ".pnpm",
    "node_modules",
    "@companion",
  );
  if (existsSync(workspaceLinks)) {
    rmSync(workspaceLinks, { recursive: true, force: true });
  }
  const betterSqlite = join(DEP_SOURCE, "better-sqlite3");
  if (!existsSync(betterSqlite)) {
    execFileSync(
      "ln",
      [
        "-s",
        ".pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3",
        betterSqlite,
      ],
      { stdio: "inherit" },
    );
  }

  // 3. Assemble the materializer config from validated host inputs.
  const limits = input.limits;
  const caps = {
    timeoutMs: limits.timeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
    maxModelCalls: Math.min(PROFILE_MAX_MODEL_CALLS, limits.maxModelCalls),
    maxOutputTokens: limits.maxOutputTokens,
    perCallTimeoutMs: limits.maxModelCallMs,
    maxRequestBytes: input.runner.relay.maxRequestBytes,
    maxResponseBytes: input.runner.relay.maxResponseBytes,
    maxConcurrent: limits.maxConcurrent,
    jobsPerDay: limits.jobsPerDay,
    concurrentExecutions: 1,
  };
  // Check executables must be the pinned node runtime: the guest binds only
  // the executable at its own path, so a bare launcher would lose its sibling
  // tree. The dependency closure is mounted read-only at /deps/node_modules.
  // `node` itself is always bound at its host path.
  //
  // Only `lint` is a valid sealed-workspace check. The dependency closure is
  // mounted at /deps/node_modules, which TypeScript does NOT consult when it
  // resolves imports from project files under /work (and pnpm workspace
  // package links do not exist inside the sealed snapshot), so a `typecheck`
  // gate would reject every candidate. Biome needs no project dependencies.
  // Requested-but-unsupported checks are dropped loudly, never silently.
  //
  // Target source paths explicitly: the guest writes generated scratch
  // (.companion-observation/guest.json) into /work before checks run, and
  // checking the whole tree would fail formatting on that untrusted file.
  const checks = {
    lint: {
      executable: NODE,
      args: sealedLintArgs("/deps/node_modules/@biomejs/biome/bin/biome"),
    },
  };
  const selectedChecks = selectSealedChecks(
    input.mandatoryChecks,
    Object.keys(checks),
  );
  const droppedChecks = input.mandatoryChecks.filter(
    (id: string) => !selectedChecks.includes(id),
  );
  if (droppedChecks.length > 0) {
    console.error(
      `WARNING unsupported checks are not sealed-workspace runnable and were dropped: ${droppedChecks.join(",")}`,
    );
  }
  const selectedCheckCommands = selectCheckCommands(checks, selectedChecks);

  const trialRaw = {
    available: true,
    enabled: true,
    mandatoryChecks: selectedChecks,
    configFingerprint: "0".repeat(64),
    sourceRevision: "0".repeat(40),
    currentModel,
    disclosedWholeRepoRead: true,
    timeoutMs: limits.timeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
    workspaceAlias: input.workspaceAlias,
    runner: {
      nodeRealpath: NODE,
      bridgeScriptPath: join(
        input.sourceRepo,
        "scripts/pi-orch-bridge/companion-bridge.mjs",
      ),
      bridgeConfigTemplatePath: input.operatorFile,
      systemctlRealpath: runtime.systemctlRealpath,
      xdgRuntimeDir: `/run/user/${process.getuid?.() ?? 1000}`,
      relay: { ...input.runner.relay },
      observe: { ...input.runner.observe },
      pollMs: input.runner.pollMs,
    },
  };
  const trialPre =
    parseTrialConfig(JSON.stringify(trialRaw)) ?? fail("trial parse");
  const adRaw = {
    enabled: true,
    workspaceAlias: input.workspaceAlias,
    sourceRoot: SRC,
    operations: ["investigate", "implement"],
    readScopes: [...SEALED_SOURCE_ROOTS],
    writeScopes: ["apps", "packages"],
    // Top-level checks are the selected NAMES (array); materialization below
    // carries the filtered command map, exactly as parseAutodispatchConfig
    // expects.
    checks: selectedChecks,
    caps,
    dependencyRoot: null,
    bridgeScriptPath: trialRaw.runner.bridgeScriptPath,
    bridgeConfigTemplatePath: input.operatorFile,
    materialization: {
      stateDir: STATE,
      executor: {
        kind: "real-pi",
        executable: realpathSync(
          join(SRC, "scripts/pi-orch-bridge/pi-orch-guest.mjs"),
        ),
        args: [],
      },
      checks: selectedCheckCommands,
      executionBackend: "confined",
      runtime,
      dependencySourceNodeModules: DEP_SOURCE,
      allowedTopLevelFiles: [...SEALED_TOP_LEVEL_FILES],
      maxDurationMs: limits.timeoutMs,
      modelRoute: "local",
    },
  };
  const ad =
    parseAutodispatchConfig(JSON.stringify(adRaw), trialPre) ??
    fail("autodispatch parse");
  // The restarted server loads COMPANION_AUTODISPATCH_JSON from companion/env,
  // not this synthetic config. Reject a check-set mismatch before publishing:
  // otherwise the build succeeds and the server fails its startup gate.
  const hostAutodispatch = process.env.COMPANION_AUTODISPATCH_JSON;
  assertHostAutodispatchChecks(hostAutodispatch, selectedChecks);
  if (hostAutodispatch !== undefined) {
    const hostAd = parseAutodispatchConfig(hostAutodispatch, trialPre);
    if (hostAd === null) fail("host autodispatch parse returned null");
  }
  const policy = {
    id: "manual-freeze",
    sessionId: "manual",
    parentPurposeId: "manual",
    workspaceAlias: input.workspaceAlias,
    version: 1,
    status: "active",
    operations: ["investigate", "implement"],
    readScopes: [...SEALED_SOURCE_ROOTS],
    writeScopes: ["apps", "packages"],
    checks: selectedChecks,
    caps: { ...caps },
    expiresAt: null,
    revokedAt: null,
    createdAt: Date.now(),
  };
  const plan = {
    id: "manual-freeze-v2",
    sessionId: "manual",
    policyId: policy.id,
    policyVersion: 1,
    revision: 1,
    planHash: "1".repeat(64),
    status: "approved",
    goal: "freeze",
    decisions: [],
    nongoals: [],
    steps: [],
    acceptance: [],
    missing: [],
    relevantPaths: ["apps", "packages"],
    operation: "implement",
    workspaceAlias: input.workspaceAlias,
    intent: {
      kind: "implement",
      quotes: [],
      latestUserTurnId: "t",
      latestUserRunId: "r",
      provenance: "user-conversation",
    },
    sourceTurnId: "t",
    sourceRunId: "r",
    createdAt: Date.now(),
  };
  const materializer = createAutodispatchMaterializer({
    config: ad,
    runtimeDir: `/run/user/${process.getuid?.() ?? 1000}`,
    currentModel,
    available: true,
    enabled: true,
    disclosedWholeRepoRead: true,
  });
  const res = await materializer.prepare({
    plan,
    policy,
    executionId: "manual-freeze-v2",
  });
  if (!res.ok) fail(`${res.code}: ${res.reason}`);
  const config = res.materialization.config;

  // 4. Verify the fresh snapshot against the clean export BEFORE publishing.
  const snapshotRoot = res.materialization.state.snapshotRoot;
  const manifestPath = res.materialization.state.manifestPath;
  if (!existsSync(snapshotRoot) || !existsSync(manifestPath)) {
    fail("fresh snapshot missing");
  }
  if (existsSync(join(snapshotRoot, ".git"))) fail("snapshot contains .git");
  const snapshotFiles = listFiles(snapshotRoot);
  if (snapshotFiles.length === 0) fail("fresh snapshot is empty");
  const differing: string[] = [];
  const notInSource: string[] = [];
  for (const rel of snapshotFiles) {
    const sourcePath = join(SRC, rel);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      notInSource.push(rel);
      continue;
    }
    if (hashFile(join(snapshotRoot, rel)) !== hashFile(sourcePath)) {
      differing.push(rel);
    }
  }
  if (differing.length > 0 || notInSource.length > 0) {
    fail(
      `snapshot/source mismatch differing=${differing.length} notInSource=${notInSource.length}`,
    );
  }

  // 5. Publish: operator.json first, then autonomy.env, restoring the old
  // operator if the env write/parse fails.
  const previousOperator = existsSync(input.operatorFile)
    ? readFileSync(input.operatorFile, "utf8")
    : null;
  atomicWrite(input.operatorFile, JSON.stringify(config, null, 2) + "\n");
  const parsed = parseOperatorConfig(readFileSync(input.operatorFile, "utf8"));
  const eff = computeEffectiveProfile(parsed);
  const fp = eff.fingerprint;
  const rev = eff.sourceRevision;
  if (fp !== res.materialization.profile.configFingerprint) {
    fail("fingerprint mismatch");
  }
  if (rev !== res.materialization.profile.sourceRevision) {
    fail("sourceRevision mismatch");
  }
  if (parsed.active.configFingerprint !== fp) {
    fail("active configFingerprint mismatch");
  }
  const autonomy = {
    ...trialRaw,
    configFingerprint: fp,
    sourceRevision: rev,
    mandatoryChecks: Object.keys(eff.checks as object).sort(),
    timeoutMs: Math.min(
      limits.timeoutMs,
      res.materialization.profile.timeoutMs,
    ),
    maxOutputBytes: Math.min(
      limits.maxOutputBytes,
      res.materialization.profile.maxOutputBytes,
    ),
  };
  const autonomyJson = JSON.stringify(autonomy);
  parseTrialConfig(autonomyJson) ?? fail("final trial parse");
  try {
    atomicWrite(input.environmentFile, formatAutonomyEnvLine(autonomyJson));
    published = true;
  } catch (err) {
    if (previousOperator !== null) {
      atomicWrite(input.operatorFile, previousOperator);
    } else {
      rmSync(input.operatorFile, { force: true });
    }
    throw err;
  }

  // 6. Prune old frozen roots BY REFERENCE: the published operator.json, the
  // pre-deploy operator (restored by a rollback), and the deploy's rollback
  // backup must never be pruned even if an older timestamp sorts them out.
  // Only the newest two unreferenced roots are kept. Pruning is best-effort
  // AFTER publication: a prune failure (old root unremovable, malformed
  // previous operator, ...) must not delete the root both files now reference.
  let prune: string[] = [];
  try {
    const rootNames = readdirSync(input.stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("frozen-"));
    const rollbackOperatorFile =
      process.env.COMPANION_TRIAL_ROLLBACK_OPERATOR_FILE ?? "";
    const rollbackOperatorText =
      rollbackOperatorFile.length > 0 && existsSync(rollbackOperatorFile)
        ? readFileSync(rollbackOperatorFile, "utf8")
        : null;
    const protectedRoots = [
      frozenRootReferencedByOperator(
        readFileSync(input.operatorFile, "utf8"),
        input.stateRoot,
      ),
      previousOperator === null
        ? null
        : frozenRootReferencedByOperator(previousOperator, input.stateRoot),
      rollbackOperatorText === null
        ? null
        : frozenRootReferencedByOperator(rollbackOperatorText, input.stateRoot),
    ].filter((name): name is string => name !== null);
    prune = selectFrozenRootsToPrune(
      rootNames,
      basename(ROOT),
      2,
      protectedRoots,
    );
    for (const name of prune) {
      const target = join(input.stateRoot, name);
      if (!target.startsWith(input.stateRoot + "/")) continue;
      execFileSync("chmod", ["-R", "u+rwX", target], { stdio: "ignore" });
      rmSync(target, { recursive: true, force: true });
    }
  } catch (pruneErr) {
    console.error(
      "WARNING pruning skipped; published root preserved:",
      pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        root: ROOT,
        sourceRoot: SRC,
        sourceSha: deployedSha,
        operator: input.operatorFile,
        autonomyEnv: input.environmentFile,
        fingerprint: fp,
        revision: rev,
        checks: Object.keys(eff.checks as object).sort(),
        snapshotFiles: snapshotFiles.length,
        pruned: prune,
      },
      null,
      2,
    ),
  );
} catch (err) {
  // Only remove the half-built root while it is unpublished. After
  // publication the operator.json/autonomy.env pair points here, so deleting
  // it would leave trials broken. The dependency materializer seals copied
  // directories read-only, so restore owner write permissions first: a plain
  // rm would fail on mode 0555 entries and mask the original build error.
  if (!published) {
    try {
      execFileSync("chmod", ["-R", "u+rwX", ROOT], { stdio: "ignore" });
    } catch {
      // Best effort; rmSync below still gets its chance.
    }
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(
        "WARNING could not remove failed root:",
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      );
    }
  }
  console.error("FAIL", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
