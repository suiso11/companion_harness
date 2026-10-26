// Auto-dispatch real-browser E2E harness: the server process.
//
// Boots ONE real production server through `startServer` with:
//   - the REAL agent strategy / RunEngine / Hono routes / UI,
//   - the REAL autodispatch planner intake (synthetic model only),
//   - the REAL standing-policy ledger + kernel TrialAuthority,
//   - the REAL sealed materializer (per-execution snapshot + dependency
//     depot + fixed executor/check profile),
//   - the REAL TrialRunner/TrialModelRelay, and
//   - the ACTUAL installed pi-orch launcher inside the sealed
//     systemd-user + bwrap scope, with a real child Pi worker.
//
// The only synthetic part is the model: one injected ModelGateway answers
// foreground chat (`answer.submit`), the planner JSON, and the parent/child
// trial calls. It speaks the relay's GATEWAY-side tool names
// (`capsule.opencode_task`, `capsule.read`), never raw guest names.
// The source fixture is a tiny synthetic README; no user code or credential
// is read. Temp dirs are removed on shutdown.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { prepareDependencyClosure } from "../../../../scripts/pi-orch-bridge/execution-profile.mjs";
import { type StartedServer, startServer } from "../../src/index.js";
import {
  AD_TEXT_XSS,
  AD_XSS_GOAL,
  AUTODISPATCH_APP_PORT,
  AUTODISPATCH_CONTROL_ORIGIN,
  AUTODISPATCH_CONTROL_PORT,
} from "./ports.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(join(HERE, "..", "..", "..", ".."));
const MODEL_NAME = "synthetic-autodispatch-gateway";
const MODEL_BASE = "http://127.0.0.1:9";
const WORKSPACE_ALIAS = "autodispatch-e2e";
const README_TEXT =
  "# Synthetic Acceptance\n\nThe child worker read this exact synthetic README.\n";
// Distinct from README_TEXT so the artifact proves the candidate bytes came
// from the real child write tool, not from the fixture's source constant.
const WRITE_CANDIDATE_TEXT =
  "# Synthetic Acceptance\n\nWritten by the real child worker as a scoped candidate.\n";

// Module-scope fixture locations set by makeFixture BEFORE the control server
// starts: GET /fixture reads the ACTUAL source file, and GET /artifact reads
// the ACTUAL bridge run directory. Neither ever returns a host path.
let sourceRoot = "";
let stateDir = "";

// Host locators for the ACTUAL installed pi-orch closure. These are pinned
// test inputs, not production config: no production env/source is touched.
const INSTALLED_ROOT =
  process.env.PI_ORCH_INSTALLED_ROOT ??
  "/home/molmot/pi-codex-opencode-orchestrator";
const INSTALLED_BIN =
  process.env.PI_ORCH_INSTALLED_BIN ?? "/home/molmot/.local/bin";
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || "/run/user/1000";
const SESSION_BUS =
  process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${RUNTIME_DIR}/bus`;
// TrialRunner spawns the bridge with this process's environment.
process.env.XDG_RUNTIME_DIR = RUNTIME_DIR;
process.env.DBUS_SESSION_BUS_ADDRESS = SESSION_BUS;

type PlannerMode =
  | "execute"
  | "discuss"
  | "missing"
  | "hang"
  | "xss"
  | "implement-write";

interface Observation {
  plannerCalls: number;
  plannerModes: PlannerMode[];
  workerIds: string[];
  parentToolNames: string[];
  childToolNames: string[];
  relayCalls: number;
  /** A synthetic hanging planner is currently awaiting an explicit release. */
  hangingPlannerActive: boolean;
  /** The production intake aborted the hanging planner's signal. */
  hangingPlannerAborted: boolean;
  /** The late, otherwise-valid proposal was released after STOP. */
  hangingPlannerReleased: boolean;
  /** The hanging planner returned its late proposal to the intake. */
  hangingPlannerSettled: boolean;
}

const observation: Observation = {
  plannerCalls: 0,
  plannerModes: [],
  workerIds: [],
  parentToolNames: [],
  childToolNames: [],
  relayCalls: 0,
  hangingPlannerActive: false,
  hangingPlannerAborted: false,
  hangingPlannerReleased: false,
  hangingPlannerSettled: false,
};
let plannerMode: PlannerMode = "execute";
let releaseHangingPlanner: (() => void) | null = null;

const roots: string[] = [];
const servers: StartedServer[] = [];
const PID_FILE = join(
  tmpdir(),
  `companion-autodispatch-e2e-fixture-${process.getuid?.() ?? "user"}.pid`,
);

/** Deterministic fixture wait: no arbitrary sleeps in the spec itself. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/**
 * Fixture reset precondition: the caller has already paused the REAL
 * global control through the production API. Abort this fixture's OWN
 * in-flight planner intake (the same graceful hook used by panel STOP),
 * settle a deliberately hanging synthetic planner, and let any already
 * claimed real trial reach quiescence via the runner's graceful preempt.
 * No process is killed and no final ledger row is edited.
 */
async function quiesceForReset(): Promise<boolean> {
  server.autodispatch?.notifyForeground();
  if (observation.hangingPlannerActive) {
    // The abort listener is synchronous; release the intentionally
    // pending synthetic response so the trusted intake can settle/reject.
    releaseHangingPlanner?.();
    await waitFor(() => !observation.hangingPlannerActive, 15_000);
  }
  if (server.trialRunner?.busy === true) {
    server.trialRunner.revokeForForeground();
  }
  return waitFor(() => server.trialRunner?.busy !== true, 30_000);
}

writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o600 });

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function write(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function lastUserText(request: ChatRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function systemText(request: ChatRequest): string {
  const first = request.messages[0];
  return first?.role === "system" ? first.content : "";
}

function toolNames(request: ChatRequest): string[] {
  return (request.tools ?? []).map((tool) => tool.name);
}

function toolMessages(request: ChatRequest): Array<{
  toolName?: string;
  content: string;
}> {
  return request.messages.filter(
    (message): message is typeof message & { content: string } =>
      message.role === "tool",
  );
}

function answer(text: string): ChatResult {
  return {
    text: "",
    toolCalls: [
      {
        id: `answer-${randomUUID()}`,
        name: "answer.submit",
        arguments: { version: 1, parts: [{ text, citations: [] }] },
      },
    ],
    stopReason: "tool_calls",
  };
}

function toolCall(name: string, args: Record<string, unknown>): ChatResult {
  return {
    text: "",
    toolCalls: [
      {
        id: `call-${randomUUID()}`,
        name,
        arguments: args,
      },
    ],
    stopReason: "tool_calls",
  };
}

function plannerProposal(
  text: string,
  mode: PlannerMode,
): {
  operation: "investigate" | "implement";
  intent: {
    kind: "execute" | "discuss" | "unclear";
    quotes: Array<{ turnId: string; runId: string; text: string }>;
    latestUserTurnId: string;
    latestUserRunId: string;
  };
  content: {
    goal: string;
    decisions: string[];
    nongoals: string[];
    steps: string[];
    acceptance: string[];
    missing: string[];
    relevantPaths: string[];
  };
} {
  const payload = JSON.parse(text) as {
    latestUserTurnId?: unknown;
    latestUserRunId?: unknown;
    turns?: Array<{ turnId?: unknown; runId?: unknown; text?: unknown }>;
  };
  const latestTurnId = String(payload.latestUserTurnId ?? "");
  const latestRunId = String(payload.latestUserRunId ?? "");
  const turn =
    payload.turns?.find(
      (entry) => entry.turnId === latestTurnId || entry.runId === latestRunId,
    ) ?? payload.turns?.at(-1);
  const turnId = String(latestTurnId || turn?.turnId || "");
  const runId = String(latestRunId || turn?.runId || "");
  const quoteText = String(turn?.text ?? "");
  const kind =
    mode === "discuss" || mode === "xss"
      ? ("discuss" as const)
      : ("execute" as const);
  return {
    operation: mode === "implement-write" ? "implement" : "investigate",
    intent: {
      kind,
      quotes: [{ turnId, runId, text: quoteText }],
      latestUserTurnId: turnId,
      latestUserRunId: runId,
    },
    content: {
      goal:
        mode === "xss"
          ? AD_XSS_GOAL
          : "README.md の見出しを確認し、結果を報告する",
      decisions: [],
      nongoals: ["ソースへの適用や本番反映は行わない"],
      steps: ["候補ワークスペースで README.md を確認する"],
      acceptance: ["固定チェック readme-check が合格する"],
      missing: mode === "missing" ? ["報告する範囲（見出しのみか全文か）"] : [],
      relevantPaths: ["README.md"],
    },
  };
}

/**
 * Synthetic gateway that deliberately ignores the production abort signal:
 * it records the abort (so the test can prove STOP reached the in-flight
 * planner) but remains pending until POST /release-hanging-planner. Releasing
 * yields an otherwise-valid execute proposal AFTER STOP, which lets the test
 * prove the trusted intake/host boundary rejects the late result instead of
 * relying on an arbitrary sleep.
 */
function hangUntilReleased(signal?: AbortSignal): Promise<void> {
  observation.hangingPlannerActive = true;
  observation.hangingPlannerAborted = false;
  observation.hangingPlannerReleased = false;
  observation.hangingPlannerSettled = false;
  const markAborted = (): void => {
    observation.hangingPlannerAborted = true;
  };
  if (signal?.aborted === true) {
    markAborted();
  } else {
    signal?.addEventListener("abort", markAborted, { once: true });
  }
  return new Promise<void>((resolve) => {
    releaseHangingPlanner = () => {
      signal?.removeEventListener("abort", markAborted);
      releaseHangingPlanner = null;
      resolve();
    };
  });
}

const modelGateway: ModelGateway = {
  provider: "ollama",
  capabilities: { toolCalling: true },
  baseUrl: MODEL_BASE,
  chatUrl: `${MODEL_BASE}/api/chat`,
  async chat(
    request: ChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    if (process.env.E2E_MODEL_DEBUG_LOG !== undefined) {
      try {
        const { appendFileSync } = await import("node:fs");
        const calls = request.messages.flatMap((message) =>
          (message.toolCalls ?? []).map((call) => call.name),
        );
        appendFileSync(
          process.env.E2E_MODEL_DEBUG_LOG,
          `${JSON.stringify({ tools: toolNames(request), calls })}\n`,
        );
      } catch {
        // debug only
      }
    }
    const system = systemText(request);
    if (system.startsWith("You summarize a bounded")) {
      observation.plannerCalls += 1;
      observation.plannerModes.push(plannerMode);
      if (plannerMode === "hang") {
        await hangUntilReleased(options?.signal);
        observation.hangingPlannerReleased = true;
        const proposal = plannerProposal(lastUserText(request), "execute");
        observation.hangingPlannerSettled = true;
        observation.hangingPlannerActive = false;
        return {
          text: JSON.stringify(proposal),
          toolCalls: [],
          stopReason: "stop",
        };
      }
      const proposal = plannerProposal(lastUserText(request), plannerMode);
      return {
        text: JSON.stringify(proposal),
        toolCalls: [],
        stopReason: "stop",
      };
    }

    const names = toolNames(request);
    const results = toolMessages(request);
    observation.relayCalls += 1;
    if (names.includes("capsule.opencode_task")) {
      observation.parentToolNames = names;
      const writeTask = plannerMode === "implement-write";
      if (results.length === 0) {
        return toolCall(
          "capsule.opencode_task",
          writeTask
            ? {
                name: "readme-child-write",
                mode: "write",
                objective: "Replace README.md with the exact candidate text.",
                relevant_paths: ["README.md"],
                expected_output:
                  "A structured report; the exact README candidate bytes are retained.",
              }
            : {
                name: "readme-child-investigate",
                mode: "read_only",
                objective: "Inspect README.md and report its first heading.",
                relevant_paths: ["README.md"],
                expected_output:
                  "A structured report quoting the README heading.",
              },
        );
      }
      const match = JSON.stringify(results).match(/oc-\d+/);
      if (match !== null) observation.workerIds.push(match[0]);
      return {
        text: `Delegation complete; the real child worker ${
          match?.[0] ?? "unknown"
        } ${writeTask ? "wrote" : "read"} README.md and returned its report.`,
        toolCalls: [],
        stopReason: "stop",
      };
    }
    if (names.includes("capsule.write") && plannerMode === "implement-write") {
      observation.childToolNames = names;
      if (results.length === 0) {
        return toolCall("capsule.write", {
          path: "README.md",
          content: WRITE_CANDIDATE_TEXT,
        });
      }
      return {
        text: JSON.stringify({
          summary:
            "Child worker wrote the exact README candidate in the sealed workspace.",
          files: ["README.md"],
          findings: [
            "README candidate: # Synthetic Acceptance",
            "write tool executed",
          ],
          unresolved: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      };
    }
    if (names.includes("capsule.read")) {
      observation.childToolNames = names;
      if (results.length === 0) {
        return toolCall("capsule.read", { path: "README.md" });
      }
      return {
        text: JSON.stringify({
          summary: "Child worker read README.md in the sealed workspace.",
          files: ["README.md"],
          findings: ["README heading: # Synthetic Acceptance"],
          unresolved: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      };
    }
    if (
      names.length === 0 &&
      results.length === 0 &&
      lastUserText(request) === AD_TEXT_XSS
    ) {
      return { text: "synthetic title", toolCalls: [], stopReason: "stop" };
    }
    return answer(
      lastUserText(request).slice(0, 120) === ""
        ? "Foreground answer accepted."
        : "Foreground answer accepted.",
    );
  },
};

function dependencyDepot(root: string): string {
  const source = join(root, "dependency-source", "node_modules");
  write(
    join(source, "better-sqlite3", "package.json"),
    '{"name":"better-sqlite3","version":"0.0.0-synthetic"}\n',
  );
  write(
    join(source, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    "synthetic native placeholder bytes\n",
  );
  const nodeRealpath = realpathSync(process.execPath);
  const prepared = prepareDependencyClosure({
    sourceNodeModules: source,
    destinationRoot: join(root, "dependency-depot"),
    maxBytes: 16 * 1024 * 1024,
    nodeRealpath,
  });
  return prepared.root;
}

async function makeFixture(): Promise<NodeJS.ProcessEnv> {
  const root = makeRoot("companion-autodispatch-e2e-");
  sourceRoot = join(root, "source");
  write(join(sourceRoot, "README.md"), README_TEXT);
  write(join(sourceRoot, ".env"), "SHOULD_NOT_BE_READ=1\n");

  stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dependencyRoot = dependencyDepot(root);

  const check = join(root, "bin", "check.mjs");
  write(
    check,
    [
      `#!${realpathSync(process.execPath)}`,
      "import { readFileSync } from 'node:fs';",
      "const text = readFileSync(process.argv[2] ?? 'README.md', 'utf8');",
      "process.stdout.write(text.includes('# Synthetic Acceptance') ? 'check-ok\\n' : 'missing\\n');",
      "",
    ].join("\n"),
    0o700,
  );
  const bridgeDir = join(REPO, "scripts", "pi-orch-bridge");
  const guest = join(root, "bin", "pi-orch-guest.mjs");
  copyFileSync(join(bridgeDir, "pi-orch-guest.mjs"), guest);
  chmodSync(guest, 0o700);

  const launcher = realpathSync(join(INSTALLED_ROOT, "scripts", "pi-orch.mjs"));
  const launcherRoot = dirname(dirname(launcher));
  const realBridgeScriptPath = join(bridgeDir, "companion-bridge.mjs");
  const bridgeConfigTemplatePath = join(root, "bridge-template.json");
  // Fixture-only diagnostic: wrap the REAL bridge spawn so its redacted
  // stderr is captured for a failing launch. The wrapper still spawns the
  // real bridge process with the same fds; production code is untouched.
  let bridgeScriptPath = realBridgeScriptPath;
  if (process.env.E2E_BRIDGE_STDERR_PATH !== undefined) {
    bridgeScriptPath = join(root, "bin", "bridge-stderr-wrapper.mjs");
    write(
      bridgeScriptPath,
      [
        "import { spawn } from 'node:child_process';",
        "import { appendFileSync } from 'node:fs';",
        `const real = ${JSON.stringify(realBridgeScriptPath)};`,
        `const log = ${JSON.stringify(process.env.E2E_BRIDGE_STDERR_PATH)};`,
        "const child = spawn(process.execPath, [real, ...process.argv.slice(2)], {",
        "  stdio: ['inherit', 'inherit', 'pipe', 'inherit'],",
        "});",
        "child.stderr.on('data', (chunk) => {",
        "  try { appendFileSync(log, chunk); } catch {}",
        "  process.stderr.write(chunk);",
        "});",
        "child.on('exit', (code, signal) => {",
        "  if (signal) process.kill(process.pid, signal);",
        "  else process.exit(code ?? 1);",
        "});",
        "",
      ].join("\n"),
      0o700,
    );
  }
  write(bridgeConfigTemplatePath, "{}\n");
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
  const caps = {
    timeoutMs: 300_000,
    maxOutputBytes: 262_144,
    maxModelCalls: 16,
    maxOutputTokens: 4096,
    perCallTimeoutMs: 60_000,
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 1_048_576,
    maxConcurrent: 1,
    jobsPerDay: 3,
    concurrentExecutions: 1,
  };
  const trial = {
    available: true,
    enabled: true,
    mandatoryChecks: ["readme-check"],
    configFingerprint: "0".repeat(64),
    sourceRevision: "0".repeat(40),
    currentModel: MODEL_NAME,
    disclosedWholeRepoRead: true,
    timeoutMs: 300_000,
    maxOutputBytes: 262_144,
    workspaceAlias: WORKSPACE_ALIAS,
    runner: {
      nodeRealpath: runtime.nodeRealpath,
      bridgeScriptPath,
      bridgeConfigTemplatePath,
      systemctlRealpath: runtime.systemctlRealpath,
      xdgRuntimeDir: RUNTIME_DIR,
      relay: {
        maxRequestBytes: 1_048_576,
        maxModelCalls: 16,
        maxOutputTokens: 4096,
        maxResponseBytes: 1_048_576,
        perCallTimeoutMs: 60_000,
        maxConcurrent: 1,
      },
      observe: {
        activeTimeoutMs: 30_000,
        goneTimeoutMs: 30_000,
        pollIntervalMs: 100,
      },
      pollMs: 100,
    },
  };
  const autodispatch = {
    enabled: true,
    workspaceAlias: WORKSPACE_ALIAS,
    sourceRoot,
    operations: ["investigate", "implement"],
    readScopes: ["README.md"],
    writeScopes: ["README.md"],
    checks: ["readme-check"],
    caps,
    dependencyRoot,
    bridgeScriptPath,
    bridgeConfigTemplatePath,
    materialization: {
      stateDir,
      executor: { kind: "real-pi", executable: guest, args: [] },
      checks: { "readme-check": { executable: check, args: ["README.md"] } },
      executionBackend: "confined",
      runtime,
      dependencySourceNodeModules: null,
      allowedTopLevelFiles: ["README.md"],
      maxDurationMs: 300_000,
      modelRoute: "synthetic-local",
    },
  };
  return {
    COMPANION_DB_PATH: join(root, "companion.sqlite"),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: String(AUTODISPATCH_APP_PORT),
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: process.env.E2E_DEBUG_LOG === "1" ? "info" : "error",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "ollama",
      baseUrl: MODEL_BASE,
      model: MODEL_NAME,
    }),
    COMPANION_AUTONOMY_JSON: JSON.stringify(trial),
    COMPANION_AUTODISPATCH_JSON: JSON.stringify(autodispatch),
  };
}

const env = await makeFixture();
const server = await startServer({
  env,
  drainMs: 50,
  modelGateway,
});
servers.push(server);

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const control = createServer(async (req, res) => {
  res.on("error", () => {});
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = await readBody(req);
  if (req.method === "GET" && url.pathname === "/health") {
    json(200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    json(200, { ...observation, mode: plannerMode });
    return;
  }
  if (req.method === "GET" && url.pathname === "/fixture") {
    try {
      json(200, {
        readme: readFileSync(join(sourceRoot, "README.md"), "utf8"),
      });
    } catch {
      json(500, { error: "source_read_failed" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/artifact/")) {
    const executionId = url.pathname.slice("/artifact/".length);
    if (!UUID_PATTERN.test(executionId)) {
      json(400, { error: "invalid_execution_id" });
      return;
    }
    // The bridge pins stateDir=jobRoot/bridge-state and
    // runDir=join(stateDir, "runs", executionId). Read ONLY that execution's
    // retained candidate/artifact; no host path is ever returned.
    const runDir = join(
      stateDir,
      "jobs",
      executionId,
      "bridge-state",
      "runs",
      executionId,
    );
    let candidateBytes: Buffer;
    let artifactBytes: Buffer;
    try {
      candidateBytes = readFileSync(join(runDir, "candidate", "README.md"));
      artifactBytes = readFileSync(join(runDir, "artifact.json"));
    } catch {
      json(404, { error: "artifact_not_found" });
      return;
    }
    let parsedArtifact: { changes?: unknown };
    try {
      parsedArtifact = JSON.parse(artifactBytes.toString("utf8")) as {
        changes?: unknown;
      };
    } catch {
      json(500, { error: "artifact_invalid" });
      return;
    }
    json(200, {
      candidate: candidateBytes.toString("utf8"),
      candidateSha256: sha256Hex(candidateBytes),
      artifactSha256: sha256Hex(artifactBytes),
      changes: Array.isArray(parsedArtifact.changes)
        ? parsedArtifact.changes
        : [],
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/arm") {
    const parsed = JSON.parse(body || "{}") as { mode?: unknown };
    if (
      parsed.mode === "execute" ||
      parsed.mode === "discuss" ||
      parsed.mode === "missing" ||
      parsed.mode === "hang" ||
      parsed.mode === "xss" ||
      parsed.mode === "implement-write"
    ) {
      plannerMode = parsed.mode;
      json(200, { mode: plannerMode });
      return;
    }
    json(400, { error: "invalid mode" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/release-hanging-planner") {
    if (releaseHangingPlanner === null) {
      json(409, { error: "no_hanging_planner" });
      return;
    }
    releaseHangingPlanner();
    json(200, { released: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    if (!(await quiesceForReset())) {
      json(503, { error: "reset_not_quiescent" });
      return;
    }
    plannerMode = "execute";
    observation.plannerCalls = 0;
    observation.plannerModes.length = 0;
    observation.workerIds.length = 0;
    observation.parentToolNames.length = 0;
    observation.childToolNames.length = 0;
    observation.relayCalls = 0;
    observation.hangingPlannerActive = false;
    observation.hangingPlannerAborted = false;
    observation.hangingPlannerReleased = false;
    observation.hangingPlannerSettled = false;
    json(200, { reset: true });
    return;
  }
  json(404, { error: "not_found" });
});

await new Promise<void>((resolve) => {
  (control as HttpServer).listen(
    AUTODISPATCH_CONTROL_PORT,
    "127.0.0.1",
    resolve,
  );
});

// Fixture-only hygiene: remove every synthetic temp root (source, SQLite,
// sealed deployment copies) when Playwright stops the web server. No repo
// cache/artifact is touched.
let tearingDown = false;
async function teardown(): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  try {
    await server.shutdown("e2e-teardown");
  } catch {
    // Best effort: the process is exiting anyway.
  }
  try {
    (control as HttpServer).close();
  } catch {
    // Best effort: closing the process exits the loopback control server.
  }
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: never mask the exit path.
    }
  }
  try {
    if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    // Removed by preflight/another teardown already.
  }
}
// Synchronous last-resort cleanup for an abrupt exit path; the normal
// SIGTERM/SIGINT path above awaits server.shutdown first.
process.once("exit", () => {
  try {
    if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore.
  }
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore.
    }
  }
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void teardown().finally(() => process.exit(0));
  });
}

// eslint-disable-next-line no-console
console.log(`autodispatch-e2e-control-ready ${AUTODISPATCH_CONTROL_ORIGIN}`);
// eslint-disable-next-line no-console
console.log(
  `autodispatch-e2e-ready http://127.0.0.1:${server.port} pid=${process.pid}`,
);
