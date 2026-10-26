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
  formatAutonomyEnvLine,
  selectFrozenRootsToPrune,
  validateTrialOperatorInput,
} from "./trialOperator.mjs";

const fail = (message: string): never => {
  console.error("FAIL", message);
  process.exit(1);
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
  execFileSync("cp", ["-al", sourceNodeModules, DEP_SOURCE], {
    stdio: "inherit",
  });
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
  const DEP_NM = join(
    STATE,
    "jobs",
    "manual-freeze-v2",
    "dependency",
    "node_modules",
  );
  const checks = {
    typecheck: {
      executable: join(DEP_NM, "typescript", "bin", "tsc"),
      args: ["-p", "/work/apps/server/tsconfig.json", "--noEmit"],
    },
    lint: {
      executable: join(DEP_NM, "@biomejs", "biome", "bin", "biome"),
      args: ["check", "/work"],
    },
  };
  const selectedChecks = input.mandatoryChecks;
  if (
    selectedChecks.some((id) => checks[id as keyof typeof checks] === undefined)
  ) {
    fail(
      `unsupported mandatoryChecks entry (known: ${Object.keys(checks).join(", ")})`,
    );
  }

  const trialRaw = {
    available: true,
    enabled: true,
    mandatoryChecks: selectedChecks,
    configFingerprint: "0".repeat(64),
    sourceRevision: "0".repeat(40),
    currentModel: "local-chat",
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
    readScopes: ["apps", "packages", "scripts", "docs"],
    writeScopes: ["apps", "packages"],
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
      checks,
      executionBackend: "confined",
      runtime,
      dependencySourceNodeModules: DEP_SOURCE,
      allowedTopLevelFiles: [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "biome.json",
        ".gitignore",
        ".node-version",
        "README.md",
      ],
      maxDurationMs: limits.timeoutMs,
      modelRoute: "local",
    },
  };
  const ad =
    parseAutodispatchConfig(JSON.stringify(adRaw), trialPre) ??
    fail("autodispatch parse");
  const policy = {
    id: "manual-freeze",
    sessionId: "manual",
    parentPurposeId: "manual",
    workspaceAlias: input.workspaceAlias,
    version: 1,
    status: "active",
    operations: ["investigate", "implement"],
    readScopes: ["apps", "packages", "scripts", "docs"],
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
    currentModel: "local-chat",
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
  } catch (err) {
    if (previousOperator !== null) {
      atomicWrite(input.operatorFile, previousOperator);
    } else {
      rmSync(input.operatorFile, { force: true });
    }
    throw err;
  }

  // 6. Prune old frozen roots, keeping the newest two.
  const rootNames = readdirSync(input.stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("frozen-"));
  const prune = selectFrozenRootsToPrune(rootNames, basename(ROOT), 2);
  for (const name of prune) {
    const target = join(input.stateRoot, name);
    if (!target.startsWith(input.stateRoot + "/")) continue;
    execFileSync("chmod", ["-R", "u+rwX", target], { stdio: "ignore" });
    rmSync(target, { recursive: true, force: true });
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
  // Failed builds never publish; remove the half-built root so it is not
  // mistaken for a valid snapshot.
  rmSync(ROOT, { recursive: true, force: true });
  fail(err instanceof Error ? err.message : String(err));
}
