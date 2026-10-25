// Real installed pi-orch extension acceptance regression.
//
// This test is deliberately opt-in on the host shape it proves: it launches
// the ACTUAL installed pi-orch launcher inside the sealed bwrap + systemd
// user scope, and serves the parent OMP and the child Pi worker from one
// synthetic OpenAI UDS endpoint. Nothing in the extension, worker result, or
// worker id is mocked; the only synthetic part is the model.
//
// It requires:
//   - /home/molmot/pi-codex-opencode-orchestrator (the installed launcher)
//   - a reachable user systemd bus (XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS)
//   - /usr/bin/bwrap
//
// Set PI_ORCH_ACCEPTANCE=1 to run it. Without that gate it is skipped so an
// ordinary kernel test run on a machine without those host prerequisites does
// not pretend to prove containment.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionJournal } from "../../../scripts/pi-orch-bridge/companion-journal.mjs";
import {
  companionScopeUnit,
  computeTaskHash,
  type TrialWireRequest,
} from "../../../scripts/pi-orch-bridge/companion-protocol.mjs";
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
  verifySealedWorkspaceSnapshot,
} from "../src/autonomous_workspace.js";

const GUEST = fileURLToPath(
  new URL("../../../scripts/pi-orch-bridge/pi-orch-guest.mjs", import.meta.url),
);
const BRIDGE = fileURLToPath(
  new URL(
    "../../../scripts/pi-orch-bridge/companion-bridge.mjs",
    import.meta.url,
  ),
);
const INSTALLED_ROOT =
  process.env.PI_ORCH_INSTALLED_ROOT ??
  "/home/molmot/pi-codex-opencode-orchestrator";
const INSTALLED_BIN =
  process.env.PI_ORCH_INSTALLED_BIN ?? "/home/molmot/.local/bin";
const RUNTIME_DIR = process.env.PI_ORCH_RUNTIME_DIR ?? "/run/user/1000";
const SESSION_BUS =
  process.env.PI_ORCH_SESSION_BUS ?? `unix:path=${RUNTIME_DIR}/bus`;

const README_TEXT =
  "# Synthetic Acceptance\n\nThe child worker read this exact synthetic README.\n";
const WRITE_README_TEXT =
  "# Synthetic Acceptance\n\nWritten by the real child Pi write tool as a scoped candidate.\n";
const ACCEPTANCE = process.env.PI_ORCH_ACCEPTANCE === "1";

type ModelScenario = "read" | "write";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) {
    try {
      servers.pop()?.close();
    } catch {
      // Best effort.
    }
  }
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-real-${label}-`));
  roots.push(dir);
  return dir;
}

function write(path: string, content: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canRun(): boolean {
  if (!ACCEPTANCE) return false;
  for (const path of [
    join(INSTALLED_ROOT, "scripts", "pi-orch.mjs"),
    join(INSTALLED_ROOT, "scripts", "pi_codex_orchestrator.sh"),
    join(
      INSTALLED_ROOT,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
    join(INSTALLED_BIN, "node"),
    join(INSTALLED_BIN, "omp"),
    "/usr/bin/bwrap",
    "/usr/bin/systemd-run",
    "/usr/bin/systemctl",
    join(RUNTIME_DIR, "bus"),
    GUEST,
    BRIDGE,
  ]) {
    if (!existsSync(path)) return false;
  }
  return true;
}

interface CapturedRequest {
  readonly parent: boolean;
  readonly toolNames: string[];
  readonly body: Record<string, unknown>;
  readonly toolMessages: Record<string, unknown>[];
  workerId?: string;
}

interface SyntheticModel {
  readonly socketPath: string;
  readonly requests: CapturedRequest[];
  readonly server: Server;
}

function toolNamesOf(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = (tool as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const messages = body.messages;
  return Array.isArray(messages)
    ? messages.filter(
        (m): m is Record<string, unknown> =>
          Boolean(m) && typeof m === "object",
      )
    : [];
}

function sendChunk(
  response: import("node:http").ServerResponse,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-synthetic",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

function sendToolCall(
  response: import("node:http").ServerResponse,
  model: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  sendChunk(
    response,
    model,
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    null,
  );
  sendChunk(response, model, {}, "tool_calls");
}

function sendText(
  response: import("node:http").ServerResponse,
  model: string,
  text: string,
): void {
  sendChunk(response, model, { role: "assistant", content: text }, null);
  sendChunk(response, model, {}, "stop");
}

async function startSyntheticModel(
  socketPath: string,
  scenario: ModelScenario,
): Promise<SyntheticModel> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "companion-current",
              object: "model",
              created: 0,
              owned_by: "companion-local",
            },
          ],
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "synthetic route not allowed" } }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    const toolNames = toolNamesOf(body);
    const messages = messagesOf(body);
    const toolMessages = messages.filter((message) => message.role === "tool");
    const parent = toolNames.includes("opencode_task");
    const model =
      typeof body.model === "string" ? body.model : "companion-current";
    const captured: CapturedRequest = { parent, toolNames, body, toolMessages };
    if (parent && toolMessages.length > 0) {
      const match = JSON.stringify(toolMessages).match(/oc-\d+/);
      if (match) captured.workerId = match[0];
    }
    requests.push(captured);

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (parent) {
      if (toolMessages.length === 0) {
        // Parent OMP advertises opencode_task -> make the real extension
        // execute a real delegated read or write task.
        sendToolCall(response, model, "call-parent-task", "opencode_task", {
          name:
            scenario === "write" ? "readme-child-write" : "readme-child-smoke",
          mode: scenario === "write" ? "write" : "read_only",
          objective:
            scenario === "write"
              ? "Replace README.md with the exact candidate text."
              : "Inspect README.md and report its first heading.",
          relevant_paths: ["README.md"],
          expected_output:
            scenario === "write"
              ? "A structured report; the exact README candidate bytes are retained."
              : "A structured report quoting the README heading.",
        });
      } else {
        const workerId = captured.workerId ?? "missing";
        sendText(
          response,
          model,
          `Delegation complete; worker ${workerId} ${
            scenario === "write" ? "wrote" : "read"
          } README.md and its report was returned to the parent.`,
        );
      }
    } else if (toolMessages.length === 0) {
      if (scenario === "write") {
        // Child Pi worker advertises write -> execute the real write tool with
        // the exact tiny synthetic README candidate.
        sendToolCall(response, model, "call-child-write", "write", {
          path: "README.md",
          content: WRITE_README_TEXT,
        });
      } else {
        // Child Pi worker advertises only read -> execute the real read tool.
        sendToolCall(response, model, "call-child-read", "read", {
          path: "README.md",
        });
      }
    } else {
      sendText(
        response,
        model,
        JSON.stringify({
          summary:
            scenario === "write"
              ? "Child worker wrote the exact README candidate in the sealed workspace."
              : "Child worker read README.md in the sealed workspace.",
          files: ["README.md"],
          findings:
            scenario === "write"
              ? [
                  "README candidate: # Synthetic Acceptance",
                  "write tool executed",
                ]
              : ["README heading: # Synthetic Acceptance"],
          unresolved: [],
        }),
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return { socketPath, requests, server };
}

interface Fixture {
  readonly dir: string;
  readonly configPath: string;
  readonly config: OperatorConfig;
  readonly snapshot: SealedWorkspaceSnapshot;
  readonly sourceReadme: string;
  readonly sourceRoot: string;
}

async function makeFixture(modelSocket: string): Promise<Fixture> {
  const dir = tempRoot("fixture");
  const sourceRoot = join(dir, "source");
  write(join(sourceRoot, "README.md"), README_TEXT);
  write(join(sourceRoot, "ignored.env"), "SYNTHETIC_NOT_COPIED=1\n");

  const snapshot = await createSealedWorkspaceSnapshot({
    sourceRoot,
    outputDir: join(dir, "sealed", "workspace"),
    allowedRoots: [],
    allowedTopLevelFiles: ["README.md"],
  });
  const pristine = join(dir, "pristine", "snapshot");
  mkdirSync(pristine, { recursive: true });
  write(join(pristine, "README.md"), "# pristine deployment base\n");

  const depsRoot = join(dir, "deps");
  write(
    join(depsRoot, "node_modules", "dep", "index.js"),
    "module.exports = 'synthetic-dep';\n",
  );
  const depsManifest = join(dir, "deps-manifest.json");
  write(depsManifest, `${JSON.stringify({ schemaVersion: 1, entries: [] })}\n`);

  const guest = join(dir, "bin", "pi-orch-guest.mjs");
  mkdirSync(dirname(guest), { recursive: true });
  copyFileSync(GUEST, guest);
  chmodSync(guest, 0o700);
  const check = join(dir, "bin", "check.mjs");
  write(
    check,
    [
      `#!${process.execPath}`,
      "import { readFileSync } from 'node:fs';",
      "const text = readFileSync(process.argv[2] ?? 'README.md', 'utf8');",
      "process.stdout.write(text.includes('# Synthetic Acceptance') ? 'check-ok\\n' : 'missing\\n');",
      "",
    ].join("\n"),
    0o700,
  );

  const launcher = realpathSync(join(INSTALLED_ROOT, "scripts", "pi-orch.mjs"));
  const launcherRoot = dirname(dirname(launcher));
  const runtime = {
    nodeRealpath: realpathSync(join(INSTALLED_BIN, "node")),
    ompRealpath: realpathSync(join(INSTALLED_BIN, "omp")),
    bwrapRealpath: realpathSync("/usr/bin/bwrap"),
    systemdRunRealpath: realpathSync("/usr/bin/systemd-run"),
    systemctlRealpath: realpathSync("/usr/bin/systemctl"),
    piOrchLauncherRealpath: launcher,
    piOrchShellRealpath: join(
      launcherRoot,
      "scripts",
      "pi_codex_orchestrator.sh",
    ),
    piOrchConfigRealpath: join(launcherRoot, "scripts", "omp-orchestrator.yml"),
    piOrchExtensionRealpath: join(
      launcherRoot,
      ".pi",
      "extensions",
      "opencode-orchestrator",
      "omp.ts",
    ),
    piOrchLockRealpath: join(launcherRoot, "package-lock.json"),
  };

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
      workspaceAlias: "synthetic-real-pi",
    },
    sealed: {
      rootDir: dir,
      snapshotRoot: snapshot.snapshotRoot,
      manifestPath: snapshot.manifestPath,
      manifestDigest: snapshot.manifestDigest,
      pristineSnapshotRoot: pristine,
      sourceRootOriginal: sourceRoot,
    },
    profile: {
      executionBackend: "confined",
      executor: {
        kind: "real-pi",
        executable: guest,
        args: [],
        contentDigest: hashFileSync(guest),
      },
      checks: {
        "readme-check": {
          executable: check,
          args: ["README.md"],
          contentDigest: hashFileSync(check),
          expectExitCode: 0,
          expectStdoutIncludes: "check-ok",
        },
      },
      runtime,
      model: {
        route: "synthetic-local",
        sockHostPath: modelSocket,
        externalConsent: false,
      },
      limits: {
        maxDurationMs: 120_000,
        maxModelCalls: 8,
        maxOutputTokens: 4096,
        maxModelCallMs: 120_000,
        maxSourceBytes: 8 * 1024 * 1024,
        maxDependencyBytes: 64 * 1024 * 1024,
        modelConcurrency: 1,
        maxProcesses: 128,
        memoryMaxBytes: 2 * 1024 * 1024 * 1024,
        cpuQuotaPercent: 100,
        maxArtifactBytes: 64 * 1024,
        workspaceMaxBytes: 8 * 1024 * 1024,
      },
      allowedPaths: ["README.md"],
      // Guest observation is generated scratch; it must never be treated as a
      // source change in read_only mode.
      scratchPaths: [".companion-observation"],
      dependencies: {
        root: depsRoot,
        manifestPath: depsManifest,
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
  write(configPath, `${JSON.stringify(config)}\n`);

  return {
    dir,
    configPath,
    config,
    snapshot,
    sourceReadme: README_TEXT,
    sourceRoot,
  };
}

function makeRequest(
  fixture: Fixture,
  mode: "read_only" | "write" = "read_only",
): TrialWireRequest {
  const unsigned = {
    version: 1 as const,
    executionId: randomUUID(),
    configFingerprint: fixture.config.active.configFingerprint,
    sourceRevision: fixture.config.active.sourceRevision,
    workspaceAlias: "synthetic-real-pi",
    mode,
    purpose: {
      statement: "real pi-orch acceptance smoke",
      scope: "synthetic README only",
    },
    objective:
      mode === "write"
        ? "Delegate one scoped README write through the installed pi-orch extension."
        : "Delegate one README read through the installed pi-orch extension.",
    relevantPaths: ["README.md"],
    acceptance: [
      mode === "write"
        ? "the delegated child writes the exact README candidate and the fixed check passes"
        : "the delegated child reads README.md and the fixed check passes",
    ],
    requiredChecks: ["readme-check"],
    constraints: [],
    budget: { timeoutMs: 100_000, maxOutputBytes: 256 * 1024 },
    externalModelConsent: false,
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
): Promise<BridgeRun> {
  const child = spawn(
    process.execPath,
    [BRIDGE, "--config", fixture.configPath],
    {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: SESSION_BUS,
        ...(process.env.PI_ORCH_DEBUG_LOG
          ? { PI_ORCH_DEBUG_LOG: process.env.PI_ORCH_DEBUG_LOG }
          : {}),
      },
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
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, 150_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("close", () => resolve());
      child.on("error", reject);
    });
  } finally {
    clearTimeout(timeout);
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  return { status: child.exitCode, stdout, stderr };
}

interface TrialWireResultShape {
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

describe("real installed pi-orch acceptance", { timeout: 200_000 }, () => {
  it.skipIf(!canRun())(
    "delegates through the actual launcher to a real child Pi worker on a synthetic model",
    async () => {
      const dir = tempRoot("model");
      const socketPath = join(dir, "model.sock");
      const model = await startSyntheticModel(socketPath, "read");
      const fixture = await makeFixture(socketPath);
      const request = makeRequest(fixture, "read_only");

      let descriptor = false;
      try {
        descriptor = lstatSync(socketPath).isSocket();
      } catch {
        descriptor = false;
      }
      expect(descriptor).toBe(true);

      const run = await runBridge(fixture, request);
      expect(run.status, `stderr: ${run.stderr}`).toBe(0);
      const lines = run.stdout.split("\n").filter((line) => line.length > 0);
      expect(lines.length).toBe(1);
      const result = JSON.parse(lines[0] as string) as TrialWireResultShape;

      expect(result, `${JSON.stringify(result)}\n${run.stderr}`).toMatchObject({
        status: "done",
        verified: true,
        executionId: request.executionId,
        taskHash: request.taskHash,
      });
      expect(result.evidence.checks).toEqual([
        {
          id: "readme-check",
          exitCode: 0,
          timedOut: false,
          outputMatched: true,
        },
      ]);
      expect(result.evidence.artifact).toBeDefined();
      expect(result.report.findings.join("\n")).toContain("opencode_task");

      // The synthetic model saw an actual parent OMP request that advertised
      // opencode_task, and an actual child Pi request that advertised read.
      const parentRequests = model.requests.filter((entry) => entry.parent);
      const childRequests = model.requests.filter((entry) => !entry.parent);
      expect(parentRequests.length).toBe(2);
      expect(
        childRequests.length,
        JSON.stringify(parentRequests[1]?.toolMessages),
      ).toBe(2);
      expect(parentRequests[0]?.toolNames).toContain("opencode_task");
      expect(childRequests[0]?.toolNames).toContain("read");
      expect(childRequests[0]?.toolNames).not.toContain("opencode_task");

      const parentToolCall = JSON.stringify(
        parentRequests[0]?.body.messages ?? [],
      );
      expect(parentToolCall).toContain("opencode_task");
      expect(parentToolCall).toContain("README.md");
      const parentFinal = parentRequests[1];
      expect(parentFinal?.workerId).toMatch(/^oc-\d+$/);
      expect(JSON.stringify(parentFinal?.toolMessages ?? [])).toContain(
        parentFinal?.workerId as string,
      );

      // The child read result is the actual README bytes, not a fabricated
      // observation. This is the decisive child tool-execution evidence.
      const childToolResult = JSON.stringify(
        childRequests[1]?.toolMessages ?? [],
      );
      expect(childToolResult).toContain("# Synthetic Acceptance");
      expect(childToolResult).toContain("read");

      // The original synthetic source and the sealed snapshot are unchanged.
      expect(readFileSync(join(fixture.sourceRoot, "README.md"), "utf8")).toBe(
        fixture.sourceReadme,
      );
      const after = await verifySealedWorkspaceSnapshot(fixture.snapshot, {
        expectedManifestDigest: fixture.snapshot.manifestDigest,
      });
      expect(after.ok).toBe(true);

      // Journal reflects the exact request identity and a verified done state.
      const journal = new CompanionJournal(
        fixture.config.stateDir,
        fixture.config.storage,
      );
      const view = journal.inspect(request.executionId);
      const artifact = journal.readArtifact(request.executionId);
      journal.close();
      expect(view?.state).toBe("done");
      expect(view?.scopeUnit).toBe(companionScopeUnit(request));
      expect(artifact?.sha256).toBe(result.evidence.artifact?.sha256);
      expect(sha256(artifact?.bytes.toString("utf8") ?? "")).toBe(
        result.evidence.artifact?.sha256,
      );
    },
  );

  it.skipIf(!canRun())(
    "writes one scoped candidate through the actual launcher and real child Pi write tool",
    async () => {
      const dir = tempRoot("model-write");
      const socketPath = join(dir, "model.sock");
      const model = await startSyntheticModel(socketPath, "write");
      const fixture = await makeFixture(socketPath);
      const request = makeRequest(fixture, "write");

      let descriptor = false;
      try {
        descriptor = lstatSync(socketPath).isSocket();
      } catch {
        descriptor = false;
      }
      expect(descriptor).toBe(true);

      const run = await runBridge(fixture, request);
      expect(run.status, `stderr: ${run.stderr}`).toBe(0);
      const lines = run.stdout.split("\n").filter((line) => line.length > 0);
      expect(lines.length).toBe(1);
      const result = JSON.parse(lines[0] as string) as TrialWireResultShape;

      expect(result, `${JSON.stringify(result)}\n${run.stderr}`).toMatchObject({
        status: "done",
        verified: true,
        executionId: request.executionId,
        taskHash: request.taskHash,
      });
      expect(result.evidence.checks).toEqual([
        {
          id: "readme-check",
          exitCode: 0,
          timedOut: false,
          outputMatched: true,
        },
      ]);
      expect(result.evidence.artifact).toMatchObject({ entryCount: 1 });
      expect(result.report.findings).toContain("modify README.md");

      const parentRequests = model.requests.filter((entry) => entry.parent);
      const childRequests = model.requests.filter((entry) => !entry.parent);
      expect(parentRequests.length).toBe(2);
      expect(
        childRequests.length,
        JSON.stringify(parentRequests[1]?.toolMessages),
      ).toBe(2);
      expect(parentRequests[0]?.toolNames).toContain("opencode_task");
      expect(childRequests[0]?.toolNames).toContain("write");
      expect(childRequests[0]?.toolNames).not.toContain("opencode_task");
      expect(JSON.stringify(childRequests[0]?.body.messages ?? [])).toContain(
        "Mode: write",
      );
      const parentFinal = parentRequests[1];
      expect(parentFinal?.workerId).toMatch(/^oc-\d+$/);
      expect(JSON.stringify(parentFinal?.toolMessages ?? [])).toContain(
        parentFinal?.workerId as string,
      );
      expect(JSON.stringify(childRequests[1]?.toolMessages ?? [])).toContain(
        "README.md",
      );

      // The original synthetic source and the sealed snapshot are unchanged.
      expect(readFileSync(join(fixture.sourceRoot, "README.md"), "utf8")).toBe(
        fixture.sourceReadme,
      );
      const after = await verifySealedWorkspaceSnapshot(fixture.snapshot, {
        expectedManifestDigest: fixture.snapshot.manifestDigest,
      });
      expect(after.ok).toBe(true);

      // The journal artifact records the exact candidate/base hashes and the
      // retained candidate bytes are those exact validated bytes.
      const journal = new CompanionJournal(
        fixture.config.stateDir,
        fixture.config.storage,
      );
      const view = journal.inspect(request.executionId);
      const artifact = journal.readArtifact(request.executionId);
      journal.close();
      expect(view?.state).toBe("done");
      expect(view?.scopeUnit).toBe(companionScopeUnit(request));
      expect(artifact?.sha256).toBe(result.evidence.artifact?.sha256);
      expect(sha256(artifact?.bytes.toString("utf8") ?? "")).toBe(
        result.evidence.artifact?.sha256,
      );

      const artifactDoc = JSON.parse(
        artifact?.bytes.toString("utf8") ?? "{}",
      ) as {
        changes: {
          path: string;
          kind: string;
          baseSha256: string | null;
          candidateSha256: string | null;
          size: number;
        }[];
      };
      expect(artifactDoc.changes).toHaveLength(1);
      const [change] = artifactDoc.changes;
      if (change === undefined)
        throw new Error("candidate change missing from artifact");
      expect(change).toMatchObject({
        path: "README.md",
        kind: "modify",
        baseSha256: sha256(README_TEXT),
        candidateSha256: sha256(WRITE_README_TEXT),
        size: Buffer.byteLength(WRITE_README_TEXT),
      });
      const candidatePath = join(
        fixture.config.stateDir,
        "runs",
        request.executionId,
        "candidate",
        "README.md",
      );
      const candidateBytes = readFileSync(candidatePath);
      expect(candidateBytes.toString("utf8")).toBe(WRITE_README_TEXT);
      expect(sha256(candidateBytes.toString("utf8"))).toBe(
        change.candidateSha256,
      );
    },
  );
});
