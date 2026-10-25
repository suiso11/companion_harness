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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSealedWorkspaceSnapshot,
  type SealedWorkspaceSnapshot,
} from "../src/autonomous_workspace.js";
import {
  companionScopeUnit,
  computeTaskHash,
  type TrialWireRequest,
} from "../../../scripts/pi-orch-bridge/companion-protocol.mjs";
import { CompanionJournal } from "../../../scripts/pi-orch-bridge/companion-journal.mjs";
import {
  buildCheckCommand,
  buildWholejobCommand,
  guestPathEnvironment,
} from "../../../scripts/pi-orch-bridge/containment.mjs";
import {
  computeDependencyClosureDigest,
  computeEffectiveProfile,
  hashFileSync,
  parseOperatorConfig,
  type OperatorConfig,
} from "../../../scripts/pi-orch-bridge/sealed-profile.mjs";

const BRIDGE = join(
  new URL("../../../scripts/pi-orch-bridge/companion-bridge.mjs", import.meta.url).pathname,
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
}): Promise<Fixture> {
  const dir = tempRoot("fixture");
  const source = join(dir, "source");
  write(join(source, "src/app.ts"), "export const app = 'sealed';\n");
  write(join(source, "src/util.ts"), "export const util = 1;\n");
  write(join(source, "src/.env"), "TOP_SECRET=do-not-copy\n");
  write(join(source, "src/node_modules/dep/index.js"), "module.exports = 'host';\n");
  write(join(source, "package.json"), '{"name":"synthetic"}\n');

  const snapshot = await createSealedWorkspaceSnapshot({
    sourceRoot: source,
    outputDir: join(dir, "sealed", "workspace"),
    allowedRoots: ["src"],
    allowedTopLevelFiles: ["package.json"],
  });
  const pristine = join(dir, "pristine", "snapshot");
  mkdirSync(pristine, { recursive: true });
  write(join(pristine, "README.md"), "# pristine deployment base\n");

  const depsRoot = join(dir, "deps");
  write(join(depsRoot, "node_modules/dep/index.js"), "module.exports = 'pinned';\n");

  const executorPath = join(dir, "bin", "executor.mjs");
  write(executorPath, `#!${process.execPath}\n${options.executorBody}`, 0o700);
  const checkPath = join(dir, "bin", "check.mjs");
  write(
    checkPath,
    `#!${process.execPath}\n${options.checkBody ??
      [
        "import { readFileSync } from 'node:fs';",
        "const p = process.argv[2] ?? 'src/app.ts';",
        "process.stdout.write(readFileSync(p, 'utf8').includes('app') ? 'check-ok\\n' : 'missing\\n');",
        "",
      ].join("\n")}`,
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

  const backend = options.backend ?? "offline-fixture";
  const config: OperatorConfig = {
    version: 2,
    stateDir: join(dir, "state"),
    storage: {
      maxRequestBytes: 64 * 1024,
      maxArtifactBytes: 64 * 1024,
      maxResultBytes: 64 * 1024,
      maxDbBytes: 16 * 1024 * 1024,
    },
    active: { configFingerprint: "0".repeat(64), sourceRevision: "0".repeat(40), workspaceAlias: "synthetic" },
    sealed: {
      rootDir: dir,
      snapshotRoot: snapshot.snapshotRoot,
      manifestPath: snapshot.manifestPath,
      manifestDigest: snapshot.manifestDigest,
      pristineSnapshotRoot: pristine,
      sourceRootOriginal: source,
    },
    profile: {
      executionBackend: backend,
      executor: { executable: executorPath, args: [], contentDigest: hashFileSync(executorPath) },
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
      model: { route: "local", sockHostPath: join(dir, "model.sock"), externalConsent: false },
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
        digest: computeDependencyClosureDigest(depsRoot, 64 * 1024 * 1024).digest,
        mounts: [{ source: join(depsRoot, "node_modules"), guestPath: "/deps/node_modules" }],
      },
    },
  };
  const parsed = parseOperatorConfig(JSON.stringify(config));
  const effective = computeEffectiveProfile(parsed);
  config.active.configFingerprint = effective.fingerprint;
  config.active.sourceRevision = effective.sourceRevision;
  const configPath = join(dir, "operator.json");
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  return { dir, configPath, config, snapshot, executorPath, checkPath, depsRoot };
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
  options: { cancelWhenMarker?: string; cancelAfterMs?: number; timeoutMs?: number } = {},
): Promise<BridgeRun> {
  const child = spawn(process.execPath, [BRIDGE, "--config", fixture.configPath], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
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
  status: "done" | "error" | "cancelled" | "unknown";
  verified: boolean;
  executionId: string;
  taskHash: string;
  report: { summary: string; unresolved: string[]; findings: string[] };
  evidence: {
    checks: { id: string; exitCode: number | null; timedOut: boolean; outputMatched: boolean }[];
    artifact?: { sha256: string; entryCount: number; bytes: number };
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The guest owns this file. Tests use it to model an UNTRUSTED guest report,
// not host evidence; the bridge must never treat a reported `done` as proof.
function guestReportBody(delegatedWorkers: unknown[], extraBody = ""): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('.companion-observation', { recursive: true });\nwriteFileSync('.companion-observation/guest.json', ${JSON.stringify(
    JSON.stringify({
      schemaVersion: 1,
      engine: "pi-orch-omp-json",
      executorKind: "real-pi",
      mode: "read_only",
      tools: [],
      delegatedWorkers,
      error: "",
    }),
  )});\n${extraBody}`;
}

describe("sealed pi-orch bridge", { timeout: 30_000 }, () => {
  it("--describe is side-effect free and marks sealed/test defaults", () => {
    const dir = tempRoot("describe");
    const out = spawnSync(process.execPath, [BRIDGE, "--describe"], { encoding: "utf8" });
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
      { id: "synthetic-check", exitCode: 0, timedOut: false, outputMatched: true },
    ]);
    expect(result.evidence.artifact).toBeDefined();

    const journal = new CompanionJournal(fixture.config.stateDir, fixture.config.storage);
    const view = journal.inspect(request.executionId);
    expect(view?.state).toBe("done");
    expect(view?.scopeUnit).toBe(companionScopeUnit(request));
    const artifact = journal.readArtifact(request.executionId);
    journal.close();
    expect(artifact?.sha256).toBe(result.evidence.artifact?.sha256);
    expect(artifact?.bytes.toString("utf8")).toContain(request.taskHash);
  });

  it("guest-reported worker status only downgrades: done is unattested, error blocks", async () => {
    const doneFixture = await makeFixture({
      executorBody: guestReportBody([{ id: "oc-1", status: "done" }]),
      scratchPaths: [".companion-observation"],
    });
    const doneRun = await runBridge(doneFixture, makeRequest(doneFixture));
    expect(doneRun.status).toBe(0);
    const doneResult = resultOf(doneRun);
    expect(doneResult.status).toBe("done");
    expect(doneResult.verified).toBe(true);
    // Verification here is fixed host checks + revalidated artifact only; the
    // worker line is explicitly labelled as an unattested guest report.
    expect(doneResult.report.findings.join("\n")).toContain(
      "guest-reported worker oc-1 done (unattested)",
    );
    expect(doneResult.report.summary).toContain(
      "worker status guest-reported/unattested",
    );

    const failedFixture = await makeFixture({
      executorBody: guestReportBody([{ id: "oc-1", status: "error", isError: true }]),
      scratchPaths: [".companion-observation"],
    });
    const failedRun = await runBridge(failedFixture, makeRequest(failedFixture));
    expect(failedRun.status).toBe(0);
    const failedResult = resultOf(failedRun);
    // The synthetic check passed, but a real worker failure must never be
    // promoted to verified done by the bridge.
    expect(failedResult.status).toBe("error");
    expect(failedResult.verified).toBe(false);
    expect(failedResult.evidence.artifact).toBeUndefined();
    expect(failedResult.evidence.checks).toEqual([
      { id: "synthetic-check", exitCode: 0, timedOut: false, outputMatched: true },
    ]);
    expect(failedResult.report.unresolved).toContain(
      "blocked: guest-reported worker did not complete (unattested)",
    );

    const missingFixture = await makeFixture({
      executorBody: guestReportBody([]),
      scratchPaths: [".companion-observation"],
    });
    const missingRun = await runBridge(missingFixture, makeRequest(missingFixture));
    expect(missingRun.status).toBe(0);
    const missingResult = resultOf(missingRun);
    expect(missingResult.status).toBe("unknown");
    expect(missingResult.verified).toBe(false);
    expect(missingResult.evidence.artifact).toBeUndefined();
    expect(missingResult.report.unresolved).toContain(
      "blocked: guest-reported worker evidence (unattested)",
    );
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
      executorBody: "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
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
    expect(result.report.summary).toContain("candidate changed during operator checks");
    expect(result.report.unresolved).toContain("blocked: candidate changed during checks");
    expect(result.evidence.checks).toEqual([
      { id: "synthetic-check", exitCode: 0, timedOut: false, outputMatched: true },
    ]);

    const journal = new CompanionJournal(fixture.config.stateDir, fixture.config.storage);
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
    const run = await runBridge(fixture, request, { cancelWhenMarker: marker, timeoutMs: 8000 });
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
    writeFileSync(join(fixture.snapshot.snapshotRoot, "src", "app.ts"), "tampered\n");
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
      executorBody: "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/new.ts', 'export const added = true;\\n');\n",
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

  it("launches a real bwrap guest/check with three-argument --setenv env groups", () => {
    const bwrap = "/usr/bin/bwrap";
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
      executor: { executable: process.execPath, args: ["-e", observation, originalSource] },
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
    expect(guest.status, guest.stderr).toBe(0);
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
        { executable: process.execPath, args: ["-e", observation, originalSource] },
      ),
    );
    expect(check.status, check.stderr).toBe(0);
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
  });

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
});
