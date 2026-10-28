// Sealed pi-orch bridge regression: synthetic source only.
//
// These tests exercise the real CLI process boundary (stdin JSONLF, fd3
// cancel pipe, one stdout result line, SQLite journal) with an explicit
// offline-fixture execution backend. That backend is NOT containment and is
// never claimed as such; the confined path is separately tested to fail
// closed when user systemd is unavailable.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionJournal } from "../../../scripts/pi-orch-bridge/companion-journal.mjs";
import {
  companionScopeUnit,
  computeTaskHash,
  type TrialWireRequest,
  validateWireResult,
} from "../../../scripts/pi-orch-bridge/companion-protocol.mjs";
import {
  buildCheckCommand,
  buildWholejobCommand,
  guestPathEnvironment,
} from "../../../scripts/pi-orch-bridge/containment.mjs";
import {
  computeDependencyClosureDigest,
  computeEffectiveProfile,
  hashFileSync,
  type OperatorConfig,
  parseOperatorConfig,
} from "../../../scripts/pi-orch-bridge/sealed-profile.mjs";
import {
  createSealedWorkspaceSnapshot,
  type SealedWorkspaceSnapshot,
} from "../src/autonomous_workspace.js";

const posixDescribe = process.platform === "win32" ? describe.skip : describe;

const BRIDGE = fileURLToPath(
  new URL(
    "../../../scripts/pi-orch-bridge/companion-bridge.mjs",
    import.meta.url,
  ),
);
const GUEST = fileURLToPath(
  new URL("../../../scripts/pi-orch-bridge/pi-orch-guest.mjs", import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-bridge-${label}-`));
  roots.push(dir);
  return dir;
}

function write(path: string, content: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode });
}

interface Fixture {
  readonly dir: string;
  readonly configPath: string;
  readonly config: OperatorConfig;
  readonly snapshot: SealedWorkspaceSnapshot;
  readonly executorPath: string;
  readonly checkPath: string;
  readonly depsRoot: string;
}

async function makeFixture(options: {
  readonly executorBody: string;
  readonly checkBody?: string;
  readonly backend?: "confined" | "offline-fixture";
  readonly maxArtifactBytes?: number;
  readonly scratchPaths?: string[];
  /** Additional sealed source files, written before the snapshot is taken. */
  readonly extraSources?: Record<string, string>;
  /**
   * Portable contract tests only parse the config; they must also run on
   * platforms where sealed snapshot creation fails closed (win32).
   */
  readonly sealedSnapshot?: boolean;
}): Promise<Fixture> {
  const dir = tempRoot("fixture");
  const source = join(dir, "source");
  write(join(source, "src/app.ts"), "export const app = 'sealed';\n");
  write(join(source, "src/util.ts"), "export const util = 1;\n");
  write(join(source, "src/.env"), "TOP_SECRET=do-not-copy\n");
  write(
    join(source, "src/node_modules/dep/index.js"),
    "module.exports = 'host';\n",
  );
  write(join(source, "package.json"), '{"name":"synthetic"}\n');
  for (const [path, content] of Object.entries(options.extraSources ?? {})) {
    write(join(source, path), content);
  }

  const snapshot =
    options.sealedSnapshot === false
      ? null
      : await createSealedWorkspaceSnapshot({
          sourceRoot: source,
          outputDir: join(dir, "sealed", "workspace"),
          allowedRoots: ["src"],
          allowedTopLevelFiles: ["package.json"],
        });
  const pristine = join(dir, "pristine", "snapshot");
  mkdirSync(pristine, { recursive: true });
  write(join(pristine, "README.md"), "# pristine deployment base\n");

  const depsRoot = join(dir, "deps");
  write(
    join(depsRoot, "node_modules/dep/index.js"),
    "module.exports = 'pinned';\n",
  );

  const backend = options.backend ?? "offline-fixture";
  const executorPath = join(dir, "bin", "executor.mjs");
  write(executorPath, `#!${process.execPath}\n${options.executorBody}`, 0o700);
  const checkPath = join(dir, "bin", "check.mjs");
  write(
    checkPath,
    `#!${process.execPath}\n${
      options.checkBody ??
      [
        "import { readFileSync } from 'node:fs';",
        "const p = process.argv[2] ?? 'src/app.ts';",
        "process.stdout.write(readFileSync(p, 'utf8').includes('app') ? 'check-ok\\n' : 'missing\\n');",
        "",
      ].join("\n")
    }`,
    0o700,
  );

  const fakeNode = join(dir, "bin", "node");
  write(fakeNode, "#!/bin/sh\nexit 0\n", 0o700);
  const fakeBwrap = join(dir, "bin", "bwrap");
  write(fakeBwrap, "#!/bin/sh\nexit 0\n", 0o700);
  const fakeSystemd = join(dir, "bin", "systemd-run");
  write(fakeSystemd, "#!/bin/sh\nexit 7\n", 0o700);
  const fakeSystemctl = join(dir, "bin", "systemctl");
  write(fakeSystemctl, "#!/bin/sh\nexit 0\n", 0o700);

  const config: OperatorConfig = {
    version: 2,
    stateDir: join(dir, "state"),
    storage: {
      maxRequestBytes: 64 * 1024,
      maxArtifactBytes: 64 * 1024,
      maxResultBytes: 64 * 1024,
      maxDbBytes: 16 * 1024 * 1024,
    },
    active: {
      configFingerprint: "0".repeat(64),
      sourceRevision: "0".repeat(40),
      workspaceAlias: "synthetic",
    },
    sealed: {
      rootDir: dir,
      snapshotRoot: snapshot?.snapshotRoot ?? join(dir, "sealed", "workspace"),
      manifestPath:
        snapshot?.manifestPath ?? join(dir, "sealed", "manifest.json"),
      manifestDigest: snapshot?.manifestDigest ?? "0".repeat(64),
      pristineSnapshotRoot: pristine,
      sourceRootOriginal: source,
    },
    profile: {
      executionBackend: backend,
      executor: {
        executable: executorPath,
        args: [],
        contentDigest: hashFileSync(executorPath),
      },
      checks: {
        "synthetic-check": {
          executable: checkPath,
          args: ["src/app.ts"],
          contentDigest: hashFileSync(checkPath),
          expectExitCode: 0,
          expectStdoutIncludes: "check-ok",
        },
      },
      runtime:
        backend === "confined"
          ? {
              nodeRealpath: fakeNode,
              bwrapRealpath: fakeBwrap,
              systemdRunRealpath: fakeSystemd,
              systemctlRealpath: fakeSystemctl,
            }
          : { nodeRealpath: fakeNode },
      model: {
        route: "local",
        sockHostPath: join(dir, "model.sock"),
        externalConsent: false,
      },
      limits: {
        maxDurationMs: 30_000,
        maxModelCalls: 24,
        maxOutputTokens: 4096,
        maxModelCallMs: 120_000,
        maxSourceBytes: 256 * 1024 * 1024,
        maxDependencyBytes: 64 * 1024 * 1024,
        modelConcurrency: 1,
        maxProcesses: 64,
        memoryMaxBytes: 256 * 1024 * 1024,
        cpuQuotaPercent: 100,
        maxArtifactBytes: options.maxArtifactBytes ?? 64 * 1024,
        workspaceMaxBytes: 8 * 1024 * 1024,
      },
      allowedPaths: ["src", "package.json"],
      scratchPaths: options.scratchPaths ?? [],
      dependencies: {
        root: depsRoot,
        manifestPath: join(dir, "deps-manifest.json"),
        digest: computeDependencyClosureDigest(depsRoot, 64 * 1024 * 1024)
          .digest,
        mounts: [
          {
            source: join(depsRoot, "node_modules"),
            guestPath: "/deps/node_modules",
          },
        ],
      },
    },
  };
  const parsed = parseOperatorConfig(JSON.stringify(config));
  const effective = computeEffectiveProfile(parsed);
  config.active.configFingerprint = effective.fingerprint;
  config.active.sourceRevision = effective.sourceRevision;
  const configPath = join(dir, "operator.json");
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  return {
    dir,
    configPath,
    config,
    snapshot: snapshot as SealedWorkspaceSnapshot,
    executorPath,
    checkPath,
    depsRoot,
  };
}

function makeRequest(
  fixture: Fixture,
  overrides: Partial<TrialWireRequest> = {},
): TrialWireRequest {
  const unsigned = {
    version: 1 as const,
    executionId: randomUUID(),
    configFingerprint: fixture.config.active.configFingerprint,
    sourceRevision: fixture.config.active.sourceRevision,
    workspaceAlias: "synthetic",
    mode: "read_only" as const,
    purpose: { statement: "synthetic smoke", scope: "synthetic src only" },
    objective: "Exercise the sealed bridge boundary.",
    relevantPaths: ["src"],
    acceptance: ["the fixed check passes"],
    requiredChecks: ["synthetic-check"],
    constraints: [],
    budget: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
    externalModelConsent: false,
    ...overrides,
  };
  return {
    ...(unsigned as Omit<TrialWireRequest, "taskHash">),
    taskHash: computeTaskHash(unsigned as Omit<TrialWireRequest, "taskHash">),
  };
}

interface BridgeRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBridge(
  fixture: Fixture,
  request: TrialWireRequest,
  options: {
    cancelWhenMarker?: string;
    cancelAfterMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<BridgeRun> {
  const child = spawn(
    process.execPath,
    [BRIDGE, "--config", fixture.configPath],
    {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin?.write(`${JSON.stringify(request)}\n`);
  child.stdin?.end();
  const fd3 = child.stdio[3] as { end: () => void } | null;
  const markerTimer = options.cancelWhenMarker
    ? setInterval(() => {
        if (existsSync(options.cancelWhenMarker as string)) {
          clearInterval(markerTimer);
          fd3?.end();
        }
      }, 25)
    : undefined;
  const cancelTimer =
    options.cancelAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          fd3?.end();
        }, options.cancelAfterMs);
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, options.timeoutMs ?? 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("close", () => resolve());
      child.on("error", reject);
    });
  } finally {
    clearTimeout(timeout);
    if (markerTimer) clearInterval(markerTimer);
    if (cancelTimer) clearTimeout(cancelTimer);
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  return { status: child.exitCode, stdout, stderr };
}

function resultOf(run: BridgeRun): TrialWireResultShape {
  const lines = run.stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0] as string) as TrialWireResultShape;
}

interface TrialWireResultShape {
  /** Optional v2 journal exit code; absent on legacy bridge lines. */
  exitCode?: number;
  status: "done" | "error" | "cancelled" | "unknown";
  verified: boolean;
  executionId: string;
  taskHash: string;
  report: { summary: string; unresolved: string[]; findings: string[] };
  evidence: {
    checks: {
      id: string;
      exitCode: number | null;
      timedOut: boolean;
      outputMatched: boolean;
    }[];
    artifact?: { sha256: string; entryCount: number; bytes: number };
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface GuestReportOverrides {
  readonly tools?: unknown[];
  readonly ompExitCode?: number;
  readonly timedOut?: boolean;
  readonly error?: string;
}

// The guest owns this file. Tests use it to model an UNTRUSTED guest report,
// not host evidence; the bridge must never treat a reported success as proof.
// The sealed real-pi guest is a direct worker, so by default the report has one
// observed successful tool call and no delegated workers.
function guestReportBody(
  delegatedWorkers: unknown[] | undefined,
  extraBody = "",
  finalText?: string,
  overrides: GuestReportOverrides = {},
): string {
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    engine: "pi-orch-omp-json",
    executorKind: "real-pi",
    mode: "read_only",
    tools: overrides.tools ?? [
      { name: "read", args: { path: "src/app.ts" }, result: "ok" },
    ],
    ompExitCode: overrides.ompExitCode ?? 0,
    timedOut: overrides.timedOut ?? false,
    error: overrides.error ?? "",
    ...(delegatedWorkers === undefined ? {} : { delegatedWorkers }),
    ...(finalText === undefined ? {} : { finalText }),
  };
  return `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('.companion-observation', { recursive: true });\nwriteFileSync('.companion-observation/guest.json', ${JSON.stringify(
    JSON.stringify(report),
  )});\n${extraBody}`;
}

const FHS_ROOTS = ["/usr", "/etc", "/home", "/lib", "/lib64", "/bin"];

// CI Node installs live outside the FHS roots above (for example
// /opt/hostedtoolcache/node/<version>/<arch>/bin/node). Bind the canonical
// Node install root at its own host path so the guest, and shebangs pinned to
// process.execPath, resolve inside the minimal namespace.
function minimalNamespaceBindings(): string[] {
  const args = FHS_ROOTS.filter((path) => existsSync(path)).flatMap((path) => [
    "--ro-bind",
    path,
    path,
  ]);
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const covered = FHS_ROOTS.some(
    (path) => nodeRoot === path || nodeRoot.startsWith(`${path}/`),
  );
  if (!covered && existsSync(nodeRoot)) {
    // Mirror pushRoBindWithParents: create missing parents before the bind.
    let current = "";
    for (const part of nodeRoot.split("/").filter(Boolean).slice(0, -1)) {
      current += `/${part}`;
      args.push("--dir", current);
    }
    args.push("--ro-bind", nodeRoot, nodeRoot);
  }
  return args;
}

// Runs the REAL guest script in a minimal bwrap namespace with a fake OMP that
// captures the rendered prompt. /work does not exist on the host, so the
// process-level guest parse path needs a private workspace bind.
function runGuestJob(objective: string): {
  readonly status: number | null;
  readonly stderr: string;
  readonly prompt: string;
} {
  const dir = tempRoot("guest-parse");
  const workRoot = join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const omp = join(bin, "omp");
  const guestPromptPath = "/work/captured-prompt.txt";
  const events = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "src/app.ts" },
          },
          { type: "text", text: "ok" },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "t1",
        isError: false,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  write(
    omp,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(guestPromptPath)}, process.argv.at(-1) ?? "");\nprocess.stdout.write(${JSON.stringify(`${events}\n`)});\n`,
    0o700,
  );
  const jobFile = join(dir, "job.json");
  write(
    jobFile,
    `${JSON.stringify({
      version: 1,
      mode: "read_only",
      executionId: randomUUID(),
      taskHash: "a".repeat(64),
      profileFingerprint: "b".repeat(64),
      sealed: {
        manifestDigest: "c".repeat(64),
        sourceRevision: "d".repeat(40),
        snapshotRoot: "/snapshot",
      },
      purpose: { statement: "synthetic objective bound", scope: "synthetic" },
      objective,
      relevantPaths: ["src"],
      acceptance: ["bounded"],
      constraints: [],
      requiredChecks: ["synthetic-check"],
      externalModelConsent: false,
    })}\n`,
    0o600,
  );
  const bound = minimalNamespaceBindings();
  const run = spawnSync(
    "/usr/bin/bwrap",
    [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--unshare-user",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/scratch",
      ...bound,
      "--bind",
      workRoot,
      "/work",
      "--ro-bind",
      jobFile,
      jobFile,
      "--ro-bind",
      omp,
      omp,
      "--chdir",
      "/work",
      "--",
      process.execPath,
      GUEST,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        HOME: "/scratch",
        TMPDIR: "/scratch",
        COMPANION_JOB_FILE: jobFile,
        COMPANION_MODEL_UDS: join(dir, "model.sock"),
        COMPANION_OMP_BIN: omp,
        COMPANION_NODE_BIN: process.execPath,
        COMPANION_EXECUTOR_KIND: "fixed",
      },
    },
  );
  let prompt = "";
  try {
    prompt = readFileSync(join(workRoot, "captured-prompt.txt"), "utf8");
  } catch {
    // Rejected jobs never invoke the fake OMP.
  }
  return { status: run.status, stderr: run.stderr ?? "", prompt };
}

// Runs the REAL guest in the real-pi branch with a fake pinned OMP binary that
// records the argv and rendered prompt the guest hands it. The guest must NOT
// execute the pinned launcher (which loads the coordinator extension), so the
// fake launcher is only present for the profile path check. This pins the
// sealed tool allowlist and the absence of coordinator context at the actual
// process boundary instead of asserting on source text.
function runRealPiGuestJob(mode: "read_only" | "write"): {
  readonly status: number | null;
  readonly stderr: string;
  readonly argv: string[];
  readonly prompt: string;
  readonly launcherExecuted: boolean;
  readonly config: string;
  readonly ompEnv: Record<string, string>;
} {
  const dir = tempRoot("guest-realpi");
  const workRoot = join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const fake = join(workRoot, "fake");
  const launcher = join(fake, "launcher.mjs");
  // Present only so the guest's frozen profile-path check passes; it must
  // never be executed, because the real launcher loads the coordinator
  // extension that appends "[Coordinator-only parent contract]". The direct
  // worker needs no child Pi CLI/shim from the launcher closure.
  write(
    launcher,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('/work/launcher-was-executed', 'yes');\n`,
    0o700,
  );
  const events = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "src/app.ts" },
          },
          { type: "text", text: "ok" },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "t1",
        isError: false,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  write(
    join(fake, "omp"),
    `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst argv = process.argv.slice(2);\nwriteFileSync('/work/captured-argv.json', JSON.stringify(argv));\nwriteFileSync('/work/captured-prompt.txt', argv.at(-1) ?? "");\ntry { writeFileSync('/work/captured-config.yml', readFileSync((process.env.HOME ?? '/scratch') + '/.omp/agent/config.yml')); } catch {}\nwriteFileSync('/work/captured-env.json', JSON.stringify(process.env));\nprocess.stdout.write(${JSON.stringify(`${events}\n`)});\n`,
    0o700,
  );
  const jobFile = join(dir, "job.json");
  write(
    jobFile,
    `${JSON.stringify({
      version: 1,
      mode,
      executionId: randomUUID(),
      taskHash: "a".repeat(64),
      profileFingerprint: "b".repeat(64),
      sealed: {
        manifestDigest: "c".repeat(64),
        sourceRevision: "d".repeat(40),
        snapshotRoot: "/snapshot",
      },
      purpose: { statement: "synthetic argv bound", scope: "synthetic" },
      objective: "inspect src/app.ts",
      relevantPaths: ["src"],
      acceptance: ["bounded"],
      constraints: [],
      requiredChecks: ["synthetic-check"],
      externalModelConsent: false,
    })}\n`,
    0o600,
  );
  const bound = minimalNamespaceBindings();
  const run = spawnSync(
    "/usr/bin/bwrap",
    [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--unshare-user",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/scratch",
      ...bound,
      "--bind",
      workRoot,
      "/work",
      "--ro-bind",
      jobFile,
      jobFile,
      "--chdir",
      "/work",
      "--",
      process.execPath,
      GUEST,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        HOME: "/scratch",
        TMPDIR: "/scratch",
        COMPANION_JOB_FILE: jobFile,
        COMPANION_MODEL_UDS: join(dir, "model.sock"),
        COMPANION_OMP_BIN: "/work/fake/omp",
        COMPANION_NODE_BIN: process.execPath,
        COMPANION_EXECUTOR_KIND: "real-pi",
        COMPANION_PI_ORCH_LAUNCHER: "/work/fake/launcher.mjs",
      },
    },
  );
  let argv: string[] = [];
  let prompt = "";
  let config = "";
  let ompEnv: Record<string, string> = {};
  try {
    argv = JSON.parse(
      readFileSync(join(workRoot, "captured-argv.json"), "utf8"),
    ) as string[];
    prompt = readFileSync(join(workRoot, "captured-prompt.txt"), "utf8");
  } catch {
    // Rejected jobs never invoke the fake OMP binary.
  }
  try {
    config = readFileSync(join(workRoot, "captured-config.yml"), "utf8");
  } catch {
    // The fake OMP may not have reached the config read.
  }
  try {
    ompEnv = JSON.parse(
      readFileSync(join(workRoot, "captured-env.json"), "utf8"),
    ) as Record<string, string>;
  } catch {
    // The fake OMP may not have been spawned.
  }
  return {
    status: run.status,
    stderr: run.stderr ?? "",
    argv,
    prompt,
    launcherExecuted: existsSync(join(workRoot, "launcher-was-executed")),
    config,
    ompEnv,
  };
}

describe("sealed pi-orch bridge portable protocol/command contract", () => {
  it("validates the optional wire exitCode and rejects out-of-range values", () => {
    const base = {
      version: 1,
      executionId: randomUUID(),
      taskHash: "a".repeat(64),
      status: "error",
      verified: false,
      report: { summary: "x", files: [], findings: [], unresolved: [] },
      evidence: {
        workerIds: [],
        workspaceTrial: true,
        productionApplied: false,
        checks: [],
      },
    };
    // A legacy line without exitCode still validates and stays exitCode-free.
    const legacy = validateWireResult(base, []) as unknown as Record<
      string,
      unknown
    >;
    expect("exitCode" in legacy).toBe(false);
    // Any integer 0..255 round-trips unchanged.
    for (const exitCode of [0, 1, 10, 137, 143, 255]) {
      const out = validateWireResult(
        { ...base, exitCode },
        [],
      ) as unknown as Record<string, unknown>;
      expect(out.exitCode).toBe(exitCode);
    }
    // Anything else is a parse error, not a silent synthesis.
    for (const exitCode of [-1, 256, 1.5, 0.1, "1", null, Number.NaN]) {
      expect(() => validateWireResult({ ...base, exitCode }, [])).toThrow(
        /exitCode must be an integer 0\.\.255/,
      );
    }
  });

  it("ships the frozen guest executor as an executable file", () => {
    // The confined bridge ro-binds this exact path into bwrap and execs it
    // directly. A non-executable checkout (for example mode 0644) makes every
    // trial fail before the guest starts; pin the exec bit in the tree.
    expect(() => accessSync(GUEST, constants.X_OK)).not.toThrow();
  });

  it("accepts dependency mount paths in sealed check args", async () => {
    const fixture = await makeFixture({
      executorBody: "",
      sealedSnapshot: false,
    });
    const config = structuredClone(fixture.config);
    const check = config.profile.checks["synthetic-check"];
    expect(check).toBeDefined();
    check!.args = [
      "/deps/node_modules/@biomejs/biome/bin/biome",
      "check",
      "/work",
    ];
    expect(() => parseOperatorConfig(JSON.stringify(config))).not.toThrow();

    check!.args = ["/etc/passwd"];
    expect(() => parseOperatorConfig(JSON.stringify(config))).toThrow(
      /absolute entries must be \/work, \/scratch, or \/deps/,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "passes an explicit coordinator-free sealed --tools allowlist in the real-pi branch",
    () => {
      const cases: ["read_only" | "write", string][] = [
        ["read_only", "read,grep,glob"],
        ["write", "read,grep,glob,edit,write"],
      ];
      for (const [mode, expected] of cases) {
        const run = runRealPiGuestJob(mode);
        expect(run.status, run.stderr).toBe(0);
        const index = run.argv.lastIndexOf("--tools");
        expect(index).toBeGreaterThanOrEqual(0);
        const toolsArg = run.argv[index + 1] as string;
        expect(toolsArg).toBe(expected);
        const exposed = toolsArg.split(",");
        expect(exposed).not.toContain("task");
        expect(exposed).not.toContain("wait");
        expect(exposed.some((name) => name.startsWith("opencode_"))).toBe(
          false,
        );
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "runs the sealed guest as a direct worker without the coordinator contract",
    () => {
      const run = runRealPiGuestJob("write");
      expect(run.status, run.stderr).toBe(0);

      // The coordinator extension is loaded by the pinned launcher via an
      // explicit --extension. The guest must bypass the launcher and disable
      // every extension/config discovery path instead.
      expect(run.argv).toContain("--no-extensions");
      expect(run.argv).not.toContain("--extension");
      expect(run.argv).not.toContain("-e");
      expect(run.argv).not.toContain("--config");
      expect(run.argv).not.toContain("--allow-home");

      // The guest must still pin the loopback synthetic model itself because
      // the launcher used to inject --model/--thinking.
      const modelIndex = run.argv.lastIndexOf("--model");
      expect(modelIndex).toBeGreaterThanOrEqual(0);
      expect(run.argv[modelIndex + 1]).toBe(
        "companion-local/companion-current",
      );
      const thinkingIndex = run.argv.lastIndexOf("--thinking");
      expect(thinkingIndex).toBeGreaterThanOrEqual(0);
      expect(run.argv[thinkingIndex + 1]).toBe("off");

      // No coordinator/delegation context reaches the model: neither in argv
      // (the appended system prompt) nor in the rendered user prompt.
      const argvText = run.argv.join("\n");
      for (const forbidden of [
        "Coordinator-only",
        "coordinator-only parent",
        "[Coordinator-only parent contract]",
      ]) {
        expect(argvText.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
      const appendIndex = run.argv.lastIndexOf("--append-system-prompt");
      expect(appendIndex).toBeGreaterThanOrEqual(0);
      const appended = run.argv[appendIndex + 1] as string;
      expect(appended).toContain("[Direct worker contract]");
      expect(appended).toContain("direct worker");
      expect(appended.toLowerCase()).toContain("no delegation tools");
      expect(run.prompt).toContain("direct worker");
      expect(run.prompt).not.toContain("Coordinator-only");

      // The pinned launcher itself must never execute: executing it would
      // load the coordinator extension and block the write tool.
      expect(run.launcherExecuted).toBe(false);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "disables the OMP loop guard in the sealed guest config",
    () => {
      // A finished guest on eb92119 restated its completion report (a
      // 416-char cycle x3) after making the exact requested edit. On 40bc410
      // trial 96f19690 repeated a ~600-char cycle after 14 model calls: the
      // guard still exited 1, so the bridge never reached host checks.
      // On 8495fed the config key above was present yet a write trial still
      // died with "Thinking loop detected ... 466-character cycle 3x" (exit
      // 1): OMP 18.12.1 ignores model.loopGuard.enabled in the headless
      // stream path, so the env switch is the authoritative one. Calls
      // (maxOutputTokens 1024) and the run (maxModelCalls 64 + timeoutMs)
      // are already capped, so the guard must be off entirely.
      const run = runRealPiGuestJob("write");
      expect(run.status, run.stderr).toBe(0);
      expect(run.ompEnv.PI_NO_THINKING_LOOP_GUARD).toBe("1");
      expect(run.config).toContain("model:");
      expect(run.config).toMatch(
        /model:\n {2}loopGuard:\n {4}enabled: false\n/,
      );
      expect(run.config).not.toContain("checkAssistantContent");
    },
  );

  it("--describe is side-effect free and marks sealed/test defaults", () => {
    const dir = tempRoot("describe");
    const out = spawnSync(process.execPath, [BRIDGE, "--describe"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      version: 2,
      wire: 1,
      modes: ["read_only", "write"],
      sealed: true,
      testDefaultLimits: "not-activated-policy",
    });
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "accepts maxModelCalls up to the 64-call ceiling and rejects 65",
    async () => {
      const fixture = await makeFixture({
        executorBody: "process.stdout.write('executor-ok\\n');\n",
      });
      const atCeiling = structuredClone(fixture.config);
      atCeiling.profile.limits.maxModelCalls = 64;
      expect(() =>
        parseOperatorConfig(JSON.stringify(atCeiling)),
      ).not.toThrow();

      const aboveCeiling = structuredClone(fixture.config);
      aboveCeiling.profile.limits.maxModelCalls = 65;
      expect(() => parseOperatorConfig(JSON.stringify(aboveCeiling))).toThrow(
        /profile\.limits\.maxModelCalls must be an integer in \[1, 64\]/,
      );
    },
  );

  it("pins the transient scope to the exact frozen millisecond runtime bound", () => {
    const built = buildWholejobCommand(
      {
        runtime: {
          bwrapRealpath: "/usr/bin/bwrap",
          systemdRunRealpath: "/usr/bin/systemd-run",
          nodeRealpath: process.execPath,
        },
        model: { sockHostPath: "/tmp/model.sock" },
        dependencies: { mounts: [] },
        executor: { executable: process.execPath, args: [] },
        limits: {
          memoryMaxBytes: 256 * 1024 * 1024,
          maxProcesses: 64,
          cpuQuotaPercent: 100,
          maxModelCalls: 1,
          maxOutputTokens: 1,
          maxModelCallMs: 1,
          modelConcurrency: 1,
          maxDurationMs: 12_345,
        },
      },
      {
        executorExecutable: process.execPath,
        workRoot: "/tmp/work",
        jobFile: "/tmp/companion-job.json",
      },
      "capsule-test.scope",
    );
    // Exact milliseconds: rounding up to 13s would widen the unit beyond the
    // frozen budget and make the kernel's observed/permit equality deny.
    expect(built.args).toContain("RuntimeMaxSec=12345ms");
    expect(built.args).not.toContain("RuntimeMaxSec=13");
  });

  it("passes the effective frozen timeout to the guest without widening it", () => {
    const built = buildWholejobCommand(
      {
        runtime: {
          bwrapRealpath: "/usr/bin/bwrap",
          systemdRunRealpath: "/usr/bin/systemd-run",
          nodeRealpath: process.execPath,
        },
        model: { sockHostPath: "/tmp/model.sock" },
        dependencies: { mounts: [] },
        executor: { executable: process.execPath, args: [] },
        limits: {
          memoryMaxBytes: 256 * 1024 * 1024,
          maxProcesses: 64,
          cpuQuotaPercent: 100,
          maxModelCalls: 1,
          maxOutputTokens: 1,
          maxModelCallMs: 1,
          modelConcurrency: 1,
          maxDurationMs: 30_000,
        },
      },
      {
        executorExecutable: process.execPath,
        workRoot: "/tmp/work",
        jobFile: "/tmp/companion-job.json",
      },
      "capsule-test.scope",
      { guestTimeoutMs: 12_345 },
    );
    const index = built.args.indexOf("COMPANION_GUEST_TIMEOUT_SECONDS");
    expect(index).toBeGreaterThan(0);
    // Floor, never round up: a wider guest window than the grant is a bug.
    expect(built.args[index + 1]).toBe("12");
  });
});

posixDescribe("sealed pi-orch bridge", { timeout: 30_000 }, () => {
  it("persists bounded, redacted failure diagnostics on executor nonzero", async () => {
    const observation = JSON.stringify({
      schemaVersion: 1,
      engine: "omp-headless-json",
      executorKind: "fixed",
      mode: "read_only",
      tools: [
        { name: "read", result: "error" },
        { name: "grep", result: "ok" },
      ],
      ompExitCode: 3,
      timedOut: false,
      error: "model failed \u0000sk-OBSECRET123",
      lastAssistantTail: `sk-TAILSECRET123 ${"z".repeat(900)} cycle abcdef TAILEND`,
    });
    const fixture = await makeFixture({
      executorBody: [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('.companion-observation', { recursive: true });",
        `writeFileSync('.companion-observation/guest.json', ${JSON.stringify(observation)});`,
        `process.stderr.write(${JSON.stringify(`fatal \u0000Bearer abc.def-123\n${"x".repeat(5000)}`)});`,
        `process.stdout.write(${JSON.stringify("out sk-STDOUTSECRET123\n")});`,
        "process.exit(3);",
      ].join("\n"),
    });
    const request = makeRequest(fixture);
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    // The wire result carries the journal's stored exit code instead of a
    // host-synthesized 1 for every error status.
    expect(result.exitCode).toBe(10);
    expect(result.report.summary).toBe("companion bridge: executor failed");
    const joined = result.report.unresolved.join("\n");
    expect(joined).toContain(
      "engine=omp-headless-json executorKind=fixed ompExitCode=3",
    );
    expect(joined).toContain("toolCount=2 toolErrors=1");
    expect(joined).toContain("guest assistant tail:");
    // Bounded to the LAST 512 chars: the prefix (and secret) is dropped.
    expect(joined).toContain("TAILEND");
    expect(joined).not.toContain("cycle abcdef TAILEND TAILEND");
    expect(joined).not.toContain("sk-TAILSECRET123");
    expect(joined).toContain("guest stderr:");
    expect(joined).toContain("guest stdout:");
    expect(joined).not.toContain("sk-OBSECRET123");
    expect(joined).not.toContain("sk-STDOUTSECRET123");
    expect(joined).not.toContain("Bearer abc.def-123");
    for (const entry of result.report.unresolved) {
      expect(new TextEncoder().encode(entry).length).toBeLessThanOrEqual(2048);
      expect(entry.length).toBeLessThanOrEqual(1024);
    }

    const journal = new CompanionJournal(
      fixture.config.stateDir,
      fixture.config.storage,
    );
    const view = journal.inspect(request.executionId);
    journal.close();
    expect(view?.state).toBe("error");
    expect(view?.exitCode).toBe(10);

    // The diagnostics must also fit the total result frame, not just each
    // entry, or a small output budget would replace exit 10 with an internal
    // error and discard the classification.
    const tightRequest = makeRequest(fixture, {
      budget: { timeoutMs: 10_000, maxOutputBytes: 1024 },
    });
    const tight = await runBridge(fixture, tightRequest);
    const tightResult = resultOf(tight);
    expect(tightResult.status).toBe("error");
    expect(tightResult.report.summary).toBe(
      "companion bridge: executor failed",
    );
    expect(new TextEncoder().encode(tight.stdout).length).toBeLessThanOrEqual(
      1024,
    );
    const tightJournal = new CompanionJournal(
      fixture.config.stateDir,
      fixture.config.storage,
    );
    const tightView = tightJournal.inspect(tightRequest.executionId);
    tightJournal.close();
    expect(tightView?.state).toBe("error");
    expect(tightView?.exitCode).toBe(10);
  });

  it("keeps executor failure diagnostics when the observation is missing", async () => {
    const fixture = await makeFixture({
      executorBody: [
        `process.stderr.write(${JSON.stringify("executor died before observation\n")});`,
        `process.stdout.write(${JSON.stringify("executor stdout\n")});`,
        "process.exit(4);",
      ].join("\n"),
    });
    const request = makeRequest(fixture);
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(10);
    expect(result.report.summary).toBe("companion bridge: executor failed");
    const joined = result.report.unresolved.join("\n");
    expect(joined).toContain("diagnostic: guest observation missing");
    expect(joined).toContain("guest stderr:");
    expect(joined).toContain("guest stdout:");
  });

  it("runs a real synthetic read-only trial and retains artifact metadata", async () => {
    const fixture = await makeFixture({
      executorBody: "process.stdout.write('executor-ok\\n');\n",
    });
    const request = makeRequest(fixture);
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result).toMatchObject({
      status: "done",
      verified: true,
      executionId: request.executionId,
      taskHash: request.taskHash,
    });
    expect(result.evidence.checks).toEqual([
      {
        id: "synthetic-check",
        exitCode: 0,
        timedOut: false,
        outputMatched: true,
      },
    ]);
    expect(result.evidence.artifact).toBeDefined();

    const journal = new CompanionJournal(
      fixture.config.stateDir,
      fixture.config.storage,
    );
    const view = journal.inspect(request.executionId);
    expect(view?.state).toBe("done");
    expect(view?.scopeUnit).toBe(companionScopeUnit(request));
    const artifact = journal.readArtifact(request.executionId);
    journal.close();
    expect(artifact?.sha256).toBe(result.evidence.artifact?.sha256);
    expect(artifact?.bytes.toString("utf8")).toContain(request.taskHash);
  });

  it("accepts direct sealed-guest execution evidence without delegated workers", async () => {
    const fixture = await makeFixture({
      executorBody: guestReportBody(undefined),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("done");
    expect(result.verified).toBe(true);
    // Verification here is fixed host checks + revalidated artifact only; the
    // execution line is explicitly labelled as an unattested guest report.
    expect(result.report.findings.join("\n")).toContain(
      "tool read src/app.ts (ok)",
    );
    expect(result.report.summary).toContain(
      "guest execution guest-reported/unattested",
    );
    expect(result.evidence.checks).toEqual([
      {
        id: "synthetic-check",
        exitCode: 0,
        timedOut: false,
        outputMatched: true,
      },
    ]);
    expect(result.evidence.artifact).toBeDefined();
  });

  it("accepts a guest that recovered from a failed tool call", async () => {
    const fixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, {
        tools: [
          { name: "grep", args: { path: "src" }, result: "ok" },
          { name: "edit", args: { path: "src/app.ts" }, result: "error" },
          { name: "edit", args: { path: "src/app.ts" }, result: "ok" },
        ],
      }),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    // A recovered failure is normal agent behavior and is not authority; the
    // host checks plus revalidated artifact still verify the run.
    expect(result.status).toBe("done");
    expect(result.verified).toBe(true);
    expect(result.evidence.artifact).toBeDefined();
    expect(result.report.findings.join("\n")).toContain(
      "guest recovered from 1 failed tool call(s) (unattested)",
    );
  });

  it("downgrades a guest whose last tool call failed after a recovery", async () => {
    const fixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, {
        tools: [
          { name: "read", args: { path: "src/app.ts" }, result: "ok" },
          { name: "edit", args: { path: "src/app.ts" }, result: "error" },
        ],
      }),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    // A trailing unrecovered failure is still a reliability downgrade.
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
    expect(result.report.unresolved).toContain(
      "blocked: guest execution did not complete reliably (guest-reported, unattested)",
    );
  });

  it("downgrades a guest with a pending tool call before a success", async () => {
    const fixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, {
        tools: [
          { name: "edit", args: { path: "src/app.ts" }, result: "pending" },
          { name: "read", args: { path: "src/app.ts" }, result: "ok" },
        ],
      }),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    // Pending means missing completion evidence, not a recovered failure.
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
  });

  it("requires at least one observed tool call for real-pi execution", async () => {
    const fixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, { tools: [] }),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("unknown");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
    expect(result.report.unresolved).toContain(
      "blocked: guest execution evidence (guest-reported, unattested)",
    );
  });

  it("downgrades real-pi execution whose observed tool failed", async () => {
    const fixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, {
        tools: [
          { name: "read", args: { path: "src/app.ts" }, result: "error" },
        ],
      }),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    // The synthetic check passed, but an observed tool failure must never be
    // promoted to verified done by the bridge.
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
    expect(result.report.unresolved).toContain(
      "blocked: guest execution did not complete reliably (guest-reported, unattested)",
    );
  });

  it("downgrades real-pi execution with a guest error or nonzero exit", async () => {
    const errorFixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, {
        error: "model or tool error",
      }),
      scratchPaths: [".companion-observation"],
    });
    const errorRun = await runBridge(errorFixture, makeRequest(errorFixture));
    expect(errorRun.status).toBe(0);
    const errorResult = resultOf(errorRun);
    expect(errorResult.status).toBe("error");
    expect(errorResult.verified).toBe(false);

    const exitFixture = await makeFixture({
      executorBody: guestReportBody(undefined, "", undefined, {
        ompExitCode: 1,
      }),
      scratchPaths: [".companion-observation"],
    });
    const exitRun = await runBridge(exitFixture, makeRequest(exitFixture));
    expect(exitRun.status).toBe(0);
    const exitResult = resultOf(exitRun);
    expect(exitResult.status).toBe("error");
    expect(exitResult.verified).toBe(false);
  });

  it("keeps the legacy delegated-worker downgrade when a report is present", async () => {
    const doneFixture = await makeFixture({
      executorBody: guestReportBody([{ id: "oc-1", status: "done" }]),
      scratchPaths: [".companion-observation"],
    });
    const doneRun = await runBridge(doneFixture, makeRequest(doneFixture));
    expect(doneRun.status).toBe(0);
    const doneResult = resultOf(doneRun);
    expect(doneResult.status).toBe("done");
    expect(doneResult.verified).toBe(true);
    expect(doneResult.report.findings.join("\n")).toContain(
      "guest-reported worker oc-1 done (unattested)",
    );
    expect(doneResult.report.summary).toContain(
      "guest execution guest-reported/unattested",
    );

    const failedFixture = await makeFixture({
      executorBody: guestReportBody([
        { id: "oc-1", status: "error", isError: true },
      ]),
      scratchPaths: [".companion-observation"],
    });
    const failedRun = await runBridge(
      failedFixture,
      makeRequest(failedFixture),
    );
    expect(failedRun.status).toBe(0);
    const failedResult = resultOf(failedRun);
    expect(failedResult.status).toBe("error");
    expect(failedResult.verified).toBe(false);
    expect(failedResult.evidence.artifact).toBeUndefined();
    expect(failedResult.report.unresolved).toContain(
      "blocked: guest execution did not complete reliably (guest-reported, unattested)",
    );
  });

  it("forwards a bounded, explicitly unattested guest answer into a read-only report", async () => {
    const answer = `synthetic answer: src/app.ts exports app\u0000\u0007 ${"detail ".repeat(900)}`;
    const fixture = await makeFixture({
      executorBody: guestReportBody(
        [{ id: "oc-answer", status: "done" }],
        "",
        answer,
      ),
      scratchPaths: [".companion-observation"],
    });
    const run = await runBridge(fixture, makeRequest(fixture));
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("done");
    const answerEntries = result.report.findings.filter((entry) =>
      entry.startsWith("guest answer (unattested)"),
    );
    expect(answerEntries.length).toBeGreaterThan(0);
    const joined = answerEntries.join(" ");
    expect(joined).toContain("synthetic answer: src/app.ts exports app");
    expect(joined).toContain("detail");
    // Control characters are stripped and the forwarded answer stays within
    // the 4 KiB bound even when the guest wrote much more.
    expect(joined).not.toContain("\u0000");
    expect(joined).not.toContain("\u0007");
    expect(joined.length).toBeLessThanOrEqual(4096 + 6 * 40);
    expect(answerEntries.every((entry) => entry.length <= 1024)).toBe(true);
    // The answer is prose only: host checks remain the sole verified evidence.
    expect(result.evidence.checks).toEqual([
      {
        id: "synthetic-check",
        exitCode: 0,
        timedOut: false,
        outputMatched: true,
      },
    ]);
  });

  it("truncates an unattested multibyte answer to keep the result line within maxOutputBytes", async () => {
    const answer = `日本語の回答: ${"詳細な説明です。".repeat(500)}`;
    const fixture = await makeFixture({
      executorBody: guestReportBody(
        [{ id: "oc-answer", status: "done" }],
        "",
        answer,
      ),
      scratchPaths: [".companion-observation"],
    });
    const request = makeRequest(fixture, {
      budget: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    // The complete serialized line (JSON + LF, UTF-8 bytes) is capped.
    expect(Buffer.byteLength(run.stdout, "utf8")).toBeLessThanOrEqual(4096);
    const result = JSON.parse(lines[0] as string) as TrialWireResultShape;
    expect(result.status).toBe("done");
    expect(result.verified).toBe(true);
    const answers = result.report.findings.filter((entry) =>
      entry.startsWith("guest answer (unattested)"),
    );
    expect(answers.length).toBeGreaterThan(0);
    const joined = answers.join(" ");
    expect(joined).toContain("日本語");
    expect(joined).toContain("[truncated]");
    // Host evidence is untouched by answer fitting.
    expect(result.evidence.artifact).toBeDefined();
    expect(result.evidence.checks).toEqual([
      {
        id: "synthetic-check",
        exitCode: 0,
        timedOut: false,
        outputMatched: true,
      },
    ]);
  });

  it("a forged guest done report cannot bypass host checks or candidate scope", async () => {
    const forged = [{ id: "forged-worker", status: "done" }];
    const failedCheck = await makeFixture({
      executorBody: guestReportBody(forged),
      checkBody: "process.stdout.write('check-failed\\n');\nprocess.exit(1);\n",
      scratchPaths: [".companion-observation"],
    });
    const failedRun = await runBridge(failedCheck, makeRequest(failedCheck));
    expect(failedRun.status).toBe(0);
    const failedResult = resultOf(failedRun);
    expect(failedResult.status).toBe("error");
    expect(failedResult.verified).toBe(false);
    expect(failedResult.evidence.artifact).toBeUndefined();
    expect(failedResult.report.summary).toContain("check failed");

    const outOfScope = await makeFixture({
      executorBody: guestReportBody(
        forged,
        "import { mkdirSync as mkdirOut, writeFileSync as writeOut } from 'node:fs';\nmkdirOut('docs', { recursive: true });\nwriteOut('docs/evil.ts', 'export const evil = 1;\\n');\n",
      ),
      scratchPaths: [".companion-observation"],
    });
    const outOfScopeRun = await runBridge(
      outOfScope,
      makeRequest(outOfScope, { mode: "write" }),
    );
    expect(outOfScopeRun.status).toBe(0);
    const outOfScopeResult = resultOf(outOfScopeRun);
    expect(outOfScopeResult.status).toBe("error");
    expect(outOfScopeResult.verified).toBe(false);
    expect(outOfScopeResult.evidence.artifact).toBeUndefined();
    expect(outOfScopeResult.report.summary).toContain(
      "candidate scope violation",
    );
  });

  it("write mode publishes only in-scope changes and rejects out-of-scope ones", async () => {
    const fixture = await makeFixture({
      executorBody:
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
    });
    const request = makeRequest(fixture, { mode: "write" });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("done");
    expect(result.evidence.artifact?.entryCount).toBe(1);
    expect(result.report.findings).toContain("add src/new.ts");

    const outside = await makeFixture({
      executorBody:
        "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('docs', { recursive: true });\nwriteFileSync('docs/evil.ts', 'export const evil = 1;\\n');\n",
    });
    const outsideRequest = makeRequest(outside, { mode: "write" });
    const outsideRun = await runBridge(outside, outsideRequest);
    expect(outsideRun.status).toBe(0);
    const outsideResult = resultOf(outsideRun);
    expect(outsideResult.status).toBe("error");
    expect(outsideResult.verified).toBe(false);
    expect(outsideResult.evidence.artifact).toBeUndefined();
    expect(outsideResult.report.summary).toContain("candidate scope violation");
  });

  it("retains base bytes for a large deleted file beyond the artifact budget", async () => {
    // 300 KiB: larger than the 64 KiB artifact cap, so base retention must use
    // the source budget rather than the (much smaller) artifact budget.
    const big = `// ${"x".repeat(300 * 1024)}\n`;
    const fixture = await makeFixture({
      extraSources: { "src/big.ts": big },
      executorBody:
        "import { unlinkSync } from 'node:fs';\nunlinkSync('src/big.ts');\n",
    });
    const request = makeRequest(fixture, { mode: "write" });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("done");
    expect(result.report.findings).toContain("delete src/big.ts");
    expect(result.evidence.artifact?.entryCount).toBe(1);

    const retained = join(
      fixture.config.stateDir,
      "runs",
      request.executionId,
      "base",
      "src",
      "big.ts",
    );
    expect(existsSync(retained)).toBe(true);
    expect(readFileSync(retained, "utf8")).toBe(big);
  });

  it("rejects a check that mutates the candidate inside an allowed path after validation", async () => {
    const fixture = await makeFixture({
      executorBody:
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
      checkBody: [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('src/new.ts', 'export const added = false;\\n');",
        "process.stdout.write('check-ok\\n');",
        "",
      ].join("\n"),
    });
    const request = makeRequest(fixture, { mode: "write" });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
    expect(result.report.summary).toContain(
      "candidate changed during operator checks",
    );
    expect(result.report.unresolved).toContain(
      "blocked: candidate changed during checks",
    );
    expect(result.evidence.checks).toEqual([
      {
        id: "synthetic-check",
        exitCode: 0,
        timedOut: false,
        outputMatched: true,
      },
    ]);

    const journal = new CompanionJournal(
      fixture.config.stateDir,
      fixture.config.storage,
    );
    const view = journal.inspect(request.executionId);
    const artifact = journal.readArtifact(request.executionId);
    journal.close();
    expect(view?.state).toBe("error");
    expect(artifact).toBeUndefined();
  });

  it("rejects a check that writes an out-of-scope path after validation", async () => {
    const fixture = await makeFixture({
      executorBody:
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
      checkBody: [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('docs', { recursive: true });",
        "writeFileSync('docs/evil.ts', 'export const evil = 1;\\n');",
        "process.stdout.write('check-ok\\n');",
        "",
      ].join("\n"),
    });
    const request = makeRequest(fixture, { mode: "write" });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
    expect(result.report.summary).toContain("candidate scope violation");
    expect(result.report.unresolved.join("\n")).toContain(
      "scope_violation: change outside allowed edit paths: docs/evil.ts",
    );
  });

  it("rejects a check that swaps a validated candidate for a symlink", async () => {
    const fixture = await makeFixture({
      executorBody:
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
      checkBody: [
        "import { symlinkSync, unlinkSync } from 'node:fs';",
        "unlinkSync('src/new.ts');",
        "symlinkSync('app.ts', 'src/new.ts');",
        "process.stdout.write('check-ok\\n');",
        "",
      ].join("\n"),
    });
    const request = makeRequest(fixture, { mode: "write" });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.evidence.artifact).toBeUndefined();
    expect(result.report.unresolved.join("\n")).toContain("symlink_rejected");
  });

  it("rejects an escaping candidate symlink instead of publishing it", async () => {
    const fixture = await makeFixture({
      executorBody:
        "import { symlinkSync } from 'node:fs';\nsymlinkSync('/etc/passwd', 'src/link.ts');\n",
    });
    const request = makeRequest(fixture, { mode: "write" });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.report.unresolved.join(" ")).toContain("symlink");
    expect(result.evidence.artifact).toBeUndefined();
  });

  it("replays duplicate finals verbatim and refuses an inflight duplicate without resend", async () => {
    const fixture = await makeFixture({
      executorBody: "process.stdout.write('executor-ok\\n');\n",
    });
    const request = makeRequest(fixture);
    const first = await runBridge(fixture, request);
    const second = await runBridge(fixture, request);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    const marker = join(fixture.dir, "started.marker");
    const slow = await makeFixture({
      executorBody: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'started');\nsetTimeout(() => {}, 60000);\n`,
    });
    const slowRequest = makeRequest(slow);
    const running = runBridge(slow, slowRequest, { cancelAfterMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const duplicate = await runBridge(slow, slowRequest);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain("inflight");
    const cancelled = await running;
    expect(cancelled.status).toBe(0);
    expect(resultOf(cancelled).status).toBe("cancelled");
  });

  it("cancels the owned process promptly through fd3 and never reports done", async () => {
    const dir = tempRoot("cancel");
    const marker = join(dir, "started.marker");
    const fixture = await makeFixture({
      executorBody: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'started');\nsetTimeout(() => {}, 60000);\n`,
    });
    const request = makeRequest(fixture);
    const started = Date.now();
    const run = await runBridge(fixture, request, {
      cancelWhenMarker: marker,
      timeoutMs: 8000,
    });
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("cancelled");
    expect(result.verified).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("fails closed on snapshot/profile tamper before reading the request", async () => {
    const fixture = await makeFixture({
      executorBody: "process.stdout.write('executor-ok\\n');\n",
    });
    const request = makeRequest(fixture);
    const configText = readFileSync(fixture.configPath, "utf8");
    const tampered = JSON.parse(configText) as OperatorConfig;
    tampered.active.configFingerprint = "f".repeat(64);
    writeFileSync(fixture.configPath, `${JSON.stringify(tampered)}\n`);
    const profileRun = await runBridge(fixture, request);
    expect(profileRun.status).toBe(2);
    expect(profileRun.stdout).toBe("");
    expect(profileRun.stderr).toContain("invalid operator config");

    writeFileSync(fixture.configPath, configText);
    writeFileSync(
      join(fixture.snapshot.snapshotRoot, "src", "app.ts"),
      "tampered\n",
    );
    const snapshotRun = await runBridge(fixture, request);
    expect(snapshotRun.status).toBe(2);
    expect(snapshotRun.stdout).toBe("");
    expect(snapshotRun.stderr).toContain("invalid operator config");
  });

  it("rejects a request that asks for external model consent outside the frozen route", async () => {
    const fixture = await makeFixture({
      executorBody: "process.stdout.write('executor-ok\\n');\n",
    });
    const request = makeRequest(fixture, { externalModelConsent: true });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("invalid request");
  });

  it("reports a containment blocker instead of falling back to a host process", async () => {
    const fixture = await makeFixture({
      backend: "confined",
      executorBody: "process.stdout.write('executor-ok\\n');\n",
    });
    const request = makeRequest(fixture);
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.report.summary).toContain("containment unavailable");
    expect(result.report.unresolved).toContain("blocked: containment");
  });

  it("emits unknown when the artifact cannot be published within the declared cap", async () => {
    const fixture = await makeFixture({
      maxArtifactBytes: 256,
      executorBody:
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
    });
    const request = makeRequest(fixture, {
      mode: "write",
      budget: { timeoutMs: 10_000, maxOutputBytes: 1024 },
    });
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("unknown");
    expect(result.verified).toBe(false);
  });

  it("never copies raw executor/check output or credentials into stdout/stderr", async () => {
    const fixture = await makeFixture({
      executorBody:
        "process.stdout.write('RAW_EXECUTOR_SECRET\\n');\nprocess.stderr.write('RAW_EXECUTOR_STDERR\\n');\n",
    });
    const request = makeRequest(fixture);
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("RAW_EXECUTOR_SECRET");
    expect(run.stderr).not.toContain("RAW_EXECUTOR_STDERR");
    expect(run.stdout).not.toContain("dummy-bearer");
    expect(JSON.parse(run.stdout.trim())).toMatchObject({ status: "done" });
    expect(sha256(run.stdout.trim())).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(process.platform !== "linux")(
    "launches a real bwrap guest/check with three-argument --setenv env groups",
    () => {
      const bwrap = "/usr/bin/bwrap";
      const probe = spawnSync(bwrap, ["--version"], { encoding: "utf8" });
      expect(
        probe.status,
        `bwrap probe failed for ${bwrap}: ${probe.error?.message ?? ""} ${probe.stderr ?? ""}`,
      ).toBe(0);
      expect(probe.stdout).toContain("bubblewrap");
      const dir = tempRoot("bwrap-env");
      const workRoot = join(dir, "work");
      mkdirSync(workRoot, { recursive: true });
      write(join(workRoot, "work-secret.txt"), "confined-copy\n");
      const originalSource = join(dir, "original-source", "secret.txt");
      write(originalSource, "HOST_ORIGINAL_SECRET\n");
      const jobFile = join(dir, "job.json");
      write(jobFile, "{}\n");
      const modelSock = join(dir, "model.sock");
      write(modelSock, "");
      const scratchRoot = join(dir, "scratch");
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });

      const observation = [
        "const fs = require('node:fs');",
        "let readable = false; let errorCode = null;",
        "try { fs.readFileSync(process.argv[1], 'utf8'); readable = true; }",
        "catch (error) { errorCode = error.code; }",
        // Emulate the guest's OMP model config/cache write. It must land under
        // the private scratch HOME, never in the /work source copy.
        "let cacheWrite = false;",
        "try {",
        "  fs.mkdirSync(process.env.HOME + '/.omp/agent', { recursive: true, mode: 0o700 });",
        "  fs.writeFileSync(process.env.HOME + '/.omp/agent/models.yml', 'probe', { mode: 0o600 });",
        "  cacheWrite = true;",
        "} catch {}",
        "process.stdout.write(JSON.stringify({",
        "home: process.env.HOME,",
        "tmpdir: process.env.TMPDIR,",
        "path: process.env.PATH,",
        "token: process.env.COMPANION_MODEL_TOKEN,",
        "omp: process.env.COMPANION_OMP_BIN,",
        "job: process.env.COMPANION_JOB_FILE,",
        "calls: process.env.COMPANION_MAX_MODEL_CALLS,",
        "hostOnly: process.env.HOST_ONLY_SECRET ?? null,",
        "cwd: process.cwd(),",
        "readable,",
        "errorCode,",
        "cacheWrite,",
        "workOmp: fs.existsSync('/work/.omp'),",
        "workSecret: fs.readFileSync('/work/work-secret.txt', 'utf8'),",
        "}));",
      ].join("\n");
      // A value with both spaces and '=' proves bwrap receives it as one argument.
      const ompBin = "/nonexistent omp dir/omp=bin/omp candidate";
      const profile = {
        runtime: {
          bwrapRealpath: bwrap,
          systemdRunRealpath: "/usr/bin/systemd-run",
          nodeRealpath: process.execPath,
          ompRealpath: ompBin,
        },
        model: { sockHostPath: modelSock },
        dependencies: { mounts: [] },
        executor: {
          executable: process.execPath,
          args: ["-e", observation, originalSource],
        },
        limits: {
          memoryMaxBytes: 256 * 1024 * 1024,
          maxProcesses: 64,
          cpuQuotaPercent: 100,
          maxModelCalls: 24,
          maxOutputTokens: 4096,
          maxModelCallMs: 120_000,
          modelConcurrency: 1,
        },
      };
      const diagnostics = (result: ReturnType<typeof spawnSync>) => ({
        status: result.status,
        signal: result.signal,
        error: result.error
          ? {
              code: (result.error as NodeJS.ErrnoException).code,
              message: result.error.message,
            }
          : null,
        stderr: result.stderr?.toString() ?? "",
      });
      const launch = (built: { args: string[] }) => {
        const bwrapIndex = built.args.indexOf(bwrap);
        expect(bwrapIndex).toBeGreaterThan(0);
        return spawnSync(bwrap, built.args.slice(bwrapIndex + 1), {
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, HOST_ONLY_SECRET: "host-only-leak" },
        });
      };

      const guest = launch(
        buildWholejobCommand(
          profile,
          { executorExecutable: process.execPath, workRoot, jobFile },
          "capsule-test.scope",
        ),
      );
      expect(guest.status, JSON.stringify(diagnostics(guest))).toBe(0);
      const guestEnv = JSON.parse(guest.stdout) as Record<string, unknown>;
      expect(guestEnv).toMatchObject({
        home: "/scratch",
        tmpdir: "/scratch",
        path: guestPathEnvironment(profile),
        token: "dummy-bearer-not-a-secret",
        omp: ompBin,
        job: "/run/companion-job.json",
        calls: "24",
        hostOnly: null,
        cwd: "/work",
        readable: false,
        errorCode: "ENOENT",
        cacheWrite: true,
        workOmp: false,
        workSecret: "confined-copy\n",
      });

      const check = launch(
        buildCheckCommand(
          profile,
          { workRoot, scratchRoot },
          "capsule-test.scope",
          {
            executable: process.execPath,
            args: ["-e", observation, originalSource],
          },
        ),
      );
      expect(check.status, JSON.stringify(diagnostics(check))).toBe(0);
      const checkEnv = JSON.parse(check.stdout) as Record<string, unknown>;
      expect(checkEnv).toMatchObject({
        home: "/scratch",
        tmpdir: "/scratch",
        path: guestPathEnvironment(profile),
        hostOnly: null,
        cwd: "/work",
        readable: false,
        errorCode: "ENOENT",
        cacheWrite: true,
        workOmp: false,
        workSecret: "confined-copy\n",
      });
    },
  );

  it("detects a dependency closure mismatch as blocked dependencies", async () => {
    const fixture = await makeFixture({
      executorBody: "process.stdout.write('executor-ok\\n');\n",
    });
    const depsFile = join(fixture.depsRoot, "node_modules", "dep", "index.js");
    writeFileSync(depsFile, "module.exports = 'tampered';\n");
    const request = makeRequest(fixture);
    const run = await runBridge(fixture, request);
    expect(run.status).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("error");
    expect(result.report.unresolved).toContain("blocked: dependencies");
  });

  it.skipIf(process.platform !== "linux")(
    "accepts canonical 8192-char objectives through the real guest parse path and rejects 8193",
    () => {
      const bwrap = "/usr/bin/bwrap";
      const probe = spawnSync(bwrap, ["--version"], { encoding: "utf8" });
      expect(
        probe.status,
        `bwrap probe failed: ${probe.error?.message ?? ""} ${probe.stderr ?? ""}`,
      ).toBe(0);
      for (const length of [4097, 8192]) {
        const objective = "o".repeat(length);
        const run = runGuestJob(objective);
        expect(run.status, run.stderr).toBe(0);
        // The parsed objective reaches the rendered prompt unchanged.
        expect(run.prompt).toContain(`Objective: ${objective}`);
      }
      const tooLong = runGuestJob("o".repeat(8193));
      expect(tooLong.status).toBe(2);
      expect(tooLong.stderr).toContain("frozen objective is invalid");
      expect(tooLong.prompt).toBe("");
    },
    30_000,
  );

  it.skipIf(process.platform !== "linux")(
    "the real guest terminates on the frozen timeout before the bridge deadline",
    async () => {
      const bwrap = "/usr/bin/bwrap";
      const probe = spawnSync(bwrap, ["--version"], { encoding: "utf8" });
      expect(
        probe.status,
        `bwrap probe failed: ${probe.error?.message ?? ""} ${probe.stderr ?? ""}`,
      ).toBe(0);
      const dir = tempRoot("guest-timeout");
      const workRoot = join(dir, "work");
      mkdirSync(workRoot, { recursive: true });
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const omp = join(bin, "omp");
      // Basename must be omp; exec keeps SIGTERM on this PID (a shell that
      // left `sleep` holding the stdio pipe would delay `close` past the cap).
      // It deliberately outlives the guest cap.
      write(omp, "#!/bin/sh\nexec sleep 30\n", 0o700);
      const jobFile = join(dir, "job.json");
      write(
        jobFile,
        `${JSON.stringify({
          version: 1,
          mode: "read_only",
          executionId: randomUUID(),
          taskHash: "a".repeat(64),
          profileFingerprint: "b".repeat(64),
          sealed: {
            manifestDigest: "c".repeat(64),
            sourceRevision: "d".repeat(40),
            snapshotRoot: "/snapshot",
          },
          purpose: { statement: "synthetic timeout", scope: "synthetic" },
          objective: "Prove the frozen guest timeout is honored.",
          relevantPaths: ["src"],
          acceptance: ["bounded"],
          constraints: ["Decision: stay within the frozen budget"],
          requiredChecks: ["synthetic-check"],
          externalModelConsent: false,
        })}\n`,
        0o600,
      );
      const started = Date.now();
      // A minimal, writable-root namespace (not `--dev-bind / /`, whose host
      // root is not writable and cannot create the `/work` mountpoint).
      const bound = minimalNamespaceBindings();
      const run = spawnSync(
        bwrap,
        [
          "--die-with-parent",
          "--new-session",
          "--unshare-all",
          "--unshare-user",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/scratch",
          ...bound,
          "--bind",
          workRoot,
          "/work",
          "--ro-bind",
          jobFile,
          jobFile,
          "--ro-bind",
          omp,
          omp,
          "--chdir",
          "/work",
          "--",
          process.execPath,
          GUEST,
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            HOME: "/scratch",
            TMPDIR: "/scratch",
            COMPANION_JOB_FILE: jobFile,
            COMPANION_MODEL_UDS: join(dir, "model.sock"),
            COMPANION_OMP_BIN: omp,
            COMPANION_NODE_BIN: process.execPath,
            COMPANION_EXECUTOR_KIND: "fixed",
            // 4 - 2 margin => the guest must stop after ~2s, well before 4s.
            COMPANION_GUEST_TIMEOUT_SECONDS: "4",
          },
        },
      );
      const elapsed = Date.now() - started;
      expect(run.status, run.stderr).toBe(10);
      expect(run.stderr).toContain("exceeded the frozen guest timeout");
      expect(elapsed).toBeLessThan(10_000);
      const observation = JSON.parse(
        readFileSync(
          join(workRoot, ".companion-observation", "guest.json"),
          "utf8",
        ),
      ) as { timedOut: boolean; mode: string };
      expect(observation).toMatchObject({ mode: "read_only", timedOut: true });
    },
  );
});
