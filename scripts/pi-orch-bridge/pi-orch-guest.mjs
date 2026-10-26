#!/usr/bin/env node
// Frozen pi-orch / OMP guest adapter for the sealed bridge.
//
// This file is the pinned executor that runs INSIDE the bwrap + systemd user
// scope built by containment.mjs. It never runs on the host and never imports
// host modules. It:
//   1. reads the frozen job file only (no command/model/path from the model),
//   2. starts an ephemeral loopback HTTP relay that forwards exactly
//      POST /v1/chat/completions and GET /v1/models to the single host UDS,
//   3. writes a guest-private models.yml pointing OMP at that loopback relay
//      with a dummy bearer key,
//   4. invokes the REAL installed OMP binary in headless JSON mode with a
//      fixed read-only or write tool profile, and
//   5. writes a bounded observation (tool names/args/result status only) for
//      the host bridge.
//
// No external model route, no credential, no host HOME, no host node_modules,
// and no model-selected command exist in this process.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const WORK_ROOT = "/work";
const MODEL_UDS = process.env.COMPANION_MODEL_UDS ?? "/run/model.sock";
const JOB_FILE = process.env.COMPANION_JOB_FILE ?? "/run/companion-job.json";
const OMP_BIN = process.env.COMPANION_OMP_BIN ?? "";
const NODE_BIN = process.env.COMPANION_NODE_BIN ?? process.execPath;
const EXECUTOR_KIND = process.env.COMPANION_EXECUTOR_KIND ?? "fixed";
const PI_ORCH_LAUNCHER = process.env.COMPANION_PI_ORCH_LAUNCHER ?? "";
const OBSERVATION_REL =
  process.env.COMPANION_OBSERVATION_REL ?? ".companion-observation/guest.json";
const MODEL_PROVIDER = "companion-local";
const MODEL_ID = "companion-current";
const MODEL_ALIAS = `${MODEL_PROVIDER}/${MODEL_ID}`;

const MAX_REQUEST_BYTES = Math.min(
  Number(process.env.COMPANION_MAX_REQUEST_BYTES ?? 8 * 1024 * 1024),
  16 * 1024 * 1024,
);
const MAX_RESPONSE_BYTES = Math.min(
  Number(process.env.COMPANION_MAX_RESPONSE_BYTES ?? 4 * 1024 * 1024),
  16 * 1024 * 1024,
);
const MAX_MODEL_CALLS = Math.max(
  1,
  Math.min(Number(process.env.COMPANION_MAX_MODEL_CALLS ?? 8), 24),
);
const MAX_OMP_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVATION_BYTES = 64 * 1024;
// Stop this far before the bridge's outer deadline so the guest can write
// its observation and exit instead of being killed at the boundary.
const GUEST_TIMEOUT_MARGIN_SECONDS = 2;
// Pinned to scripts/pi-orch-bridge/companion-protocol.mjs (the canonical wire
// contract): MAX_LIST_ITEMS=16, MAX_TEXT_SHORT=1024. The guest is a
// standalone copied artifact, so it cannot import the host protocol module.
const MAX_LIST_ITEMS = 16;
const MAX_TEXT_SHORT = 1024;

function fail(message) {
  process.stderr.write(`pi-orch guest: ${message}\n`);
  process.exit(2);
}

function guestFailed(message) {
  process.stderr.write(`pi-orch guest: ${message}\n`);
  process.exit(10);
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseJob(path) {
  const text = readFileSync(path, "utf8");
  if (text.length > 64 * 1024) fail("frozen job is oversized");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("frozen job is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail("frozen job must be an object");
  const allowed = new Set([
    "version",
    "mode",
    "executionId",
    "taskHash",
    "profileFingerprint",
    "sealed",
    "purpose",
    "objective",
    "relevantPaths",
    "acceptance",
    "constraints",
    "requiredChecks",
    "externalModelConsent",
  ]);
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) fail("frozen job carries an unsupported key");
  if (raw.version !== 1) fail("frozen job version must be 1");
  if (raw.mode !== "read_only" && raw.mode !== "write")
    fail("frozen job mode is invalid");
  if (
    typeof raw.objective !== "string" ||
    raw.objective.length === 0 ||
    raw.objective.length > 4096
  ) {
    fail("frozen objective is invalid");
  }
  if (!Array.isArray(raw.relevantPaths) || raw.relevantPaths.length === 0)
    fail("frozen relevantPaths are empty");
  for (const entry of raw.relevantPaths) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512)
      fail("frozen relevantPath is invalid");
    if (entry.startsWith("/") || entry.includes("..") || entry.includes("\0"))
      fail("frozen relevantPath must be relative");
  }
  if (!raw.purpose || typeof raw.purpose !== "object")
    fail("frozen purpose is invalid");
  if (
    typeof raw.purpose.statement !== "string" ||
    raw.purpose.statement.length === 0
  )
    fail("frozen purpose statement is invalid");
  if (!Array.isArray(raw.constraints) || raw.constraints.length > 16)
    fail("frozen constraints are invalid");
  const constraints = [];
  for (const entry of raw.constraints) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_TEXT_SHORT ||
      entry.includes("\0")
    ) {
      fail("frozen constraint is invalid");
    }
    constraints.push(entry);
  }
  if (
    !Array.isArray(raw.acceptance) ||
    raw.acceptance.length < 1 ||
    raw.acceptance.length > MAX_LIST_ITEMS
  ) {
    fail("frozen acceptance is invalid");
  }
  const acceptance = [];
  for (const entry of raw.acceptance) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_TEXT_SHORT ||
      entry.includes("\0")
    ) {
      fail("frozen acceptance is invalid");
    }
    acceptance.push(entry);
  }
  return {
    mode: raw.mode,
    objective: raw.objective,
    statement: raw.purpose.statement,
    relevantPaths: raw.relevantPaths,
    acceptance,
    constraints,
  };
}

function formatAcceptance(criteria) {
  return [
    "Acceptance criteria (all must hold, in order):",
    ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join("\n");
}

function formatConstraints(constraints) {
  return [
    "Frozen decisions/non-goals/steps (all must hold):",
    ...constraints.map((constraint) => `- ${constraint}`),
  ].join("\n");
}

function buildPrompt(job) {
  const paths = job.relevantPaths.join(", ");
  if (job.mode === "read_only") {
    return [
      "You are inspecting a sealed read-only workspace at /work.",
      "Use only the read tool. Do not write, edit, or run commands.",
      `Relevant paths: ${paths}.`,
      `Purpose: ${job.statement}`,
      `Objective: ${job.objective}`,
      ...(job.constraints.length > 0
        ? [formatConstraints(job.constraints)]
        : []),
      formatAcceptance(job.acceptance),
      "Read the relevant files and then answer with a short factual report.",
    ].join("\n");
  }
  return [
    "You are making one minimal candidate change in a sealed workspace at /work.",
    "Use the read and write tools. Do not run commands and do not touch other paths.",
    `Relevant paths: ${paths}.`,
    `Purpose: ${job.statement}`,
    `Objective: ${job.objective}`,
    ...(job.constraints.length > 0
      ? [formatConstraints(job.constraints)]
      : []),
    formatAcceptance(job.acceptance),
    "Write the smallest correct candidate file, then stop.",
  ].join("\n");
}

// The child Pi backend has its OWN agent directory and model registry
// (~/.pi/agent/models.json). Registering the synthetic relay only in the OMP
// registry leaves the child unable to resolve `companion-local/companion-current`.
// The child inherits guest HOME (Pi's default agent dir), so this registration
// stays inside the guest and never touches the host's ~/.pi or credentials.
function writePiAgentConfig(home, port) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700);
  const models = {
    providers: {
      [MODEL_PROVIDER]: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "dummy-bearer-not-a-secret",
        models: [
          {
            id: MODEL_ID,
            name: "Companion synthetic local",
            contextWindow: 65536,
            maxTokens: 2048,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models)}\n`, {
    mode: 0o600,
  });
}

function writeAgentConfig(agentDir, port) {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700);
  const models = [
    "providers:",
    `  ${MODEL_PROVIDER}:`,
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "    api: openai-completions",
    "    apiKey: dummy-bearer-not-a-secret",
    "    models:",
    `      - id: ${MODEL_ID}`,
    "        name: Companion synthetic local",
    "        contextWindow: 65536",
    "        maxTokens: 2048",
    "        reasoning: false",
    "        input: [text]",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    "",
  ].join("\n");
  writeFileSync(join(agentDir, "models.yml"), models, { mode: 0o600 });
  writeFileSync(
    join(agentDir, "config.yml"),
    [
      "enabledProviders:",
      `  - ${MODEL_PROVIDER}`,
      "disabledProviders: []",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function startModelRelay() {
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: MODEL_ID,
              object: "model",
              created: 0,
              owned_by: "companion-local",
            },
          ],
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "route not allowed" } }));
      return;
    }
    calls += 1;
    if (calls > MAX_MODEL_CALLS) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "model call cap exceeded" } }),
      );
      return;
    }
    const bounded = [];
    let requestBytes = 0;
    req.on("data", (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes > MAX_REQUEST_BYTES) {
        req.destroy();
        return;
      }
      bounded.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(bounded);
      const upstream = httpRequest(
        {
          socketPath: MODEL_UDS,
          path: req.url,
          method: "POST",
          headers: {
            "content-type": req.headers["content-type"] ?? "application/json",
            accept: req.headers.accept ?? "text/event-stream",
            authorization: "Bearer dummy-bearer-not-a-secret",
            "content-length": String(body.length),
          },
        },
        (upstreamRes) => {
          const headers = { ...upstreamRes.headers };
          delete headers["transfer-encoding"];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          let responseBytes = 0;
          upstreamRes.on("data", (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              upstreamRes.destroy();
              res.destroy();
              return;
            }
            res.write(chunk);
          });
          upstreamRes.on("end", () => res.end());
          upstreamRes.on("error", () => res.destroy());
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent)
          res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "trusted model relay unavailable" },
          }),
        );
      });
      upstream.end(body);
    });
    req.on("error", () => {
      try {
        res.destroy();
      } catch {
        // Already closed.
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      if (!Number.isSafeInteger(port) || port <= 0)
        reject(new Error("relay bind failed"));
      else resolve({ server, port });
    });
  });
}

const TASK_STATUSES = new Set(["running", "done", "error", "cancelled"]);

function boundedStatus(value) {
  return typeof value === "string" && TASK_STATUSES.has(value) ? value : null;
}

function addDelegatedStatus(workers, id, status, isError) {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return;
  const bounded = boundedStatus(status);
  if (bounded === null) return;
  // Later manager events for the same worker supersede earlier ones
  // (spawn:running -> wait:done/error). The final observed status is the
  // reliable terminal state; the model's prose is never consulted.
  workers.set(id, {
    id,
    status: bounded,
    ...(isError === true ? { isError: true } : {}),
  });
}

function captureDelegatedStatus(workers, name, details, isError) {
  if (
    !name.startsWith("opencode_") ||
    !details ||
    typeof details !== "object" ||
    Array.isArray(details)
  )
    return;
  if (Array.isArray(details.results)) {
    for (const result of details.results) {
      if (!result || typeof result !== "object" || Array.isArray(result))
        continue;
      addDelegatedStatus(
        workers,
        result.id,
        result.status,
        isError === true || result.isError === true,
      );
    }
  }
  if (Array.isArray(details.tasks)) {
    for (const task of details.tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      addDelegatedStatus(
        workers,
        task.id,
        task.status,
        isError === true || task.isError === true,
      );
    }
  }
  addDelegatedStatus(
    workers,
    details.id,
    details.status,
    isError === true || details.isError === true,
  );
}

function summarizeEvents(text, stderrText) {
  const tools = [];
  const byId = new Map();
  const delegated = new Map();
  let finalText = "";
  let modelCalls = 0;
  let sawError = "";
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.length > 2 * 1024 * 1024) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (
      event.type === "message_end" &&
      event.message &&
      typeof event.message === "object"
    ) {
      const message = event.message;
      if (message.role === "assistant") {
        modelCalls += 1;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "toolCall") {
              const key = `${block.id ?? ""}:${block.name ?? ""}`;
              if (!seen.has(key)) {
                seen.add(key);
                const entry = {
                  name: String(block.name ?? "unknown").slice(0, 64),
                  args: sanitizeArgs(block.arguments),
                  result: "pending",
                };
                tools.push(entry);
                if (
                  typeof block.id === "string" &&
                  block.id.length > 0 &&
                  block.id.length <= 128
                )
                  byId.set(block.id, entry);
              }
            } else if (
              block.type === "text" &&
              typeof block.text === "string"
            ) {
              finalText = block.text.slice(0, 4096);
            }
          }
        }
        if (message.stopReason === "error")
          sawError = String(message.errorMessage ?? "model error").slice(
            0,
            512,
          );
      } else if (message.role === "toolResult") {
        const name = String(message.toolName ?? "unknown").slice(0, 64);
        const callId =
          typeof message.toolCallId === "string"
            ? message.toolCallId.slice(0, 128)
            : "";
        const entry =
          (callId ? byId.get(callId) : undefined) ??
          tools.find((tool) => tool.name === name && tool.result === "pending");
        if (entry) entry.result = message.isError ? "error" : "ok";
        captureDelegatedStatus(
          delegated,
          name,
          message.details,
          message.isError,
        );
      }
    }
  }
  const delegatedWorkers = [...delegated.values()].slice(0, 32);
  if (
    delegatedWorkers.some(
      (worker) => worker.status !== "done" || worker.isError === true,
    )
  ) {
    sawError ||= "delegated worker did not complete";
  }
  if (stderrText.length > 0) sawError ||= stderrText.slice(0, 512);
  return { tools, finalText, modelCalls, delegatedWorkers, error: sawError };
}

function sanitizeArgs(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const key of ["path", "file_path", "filename"]) {
    if (typeof value[key] === "string") out.path = value[key].slice(0, 512);
  }
  return out;
}

function writeObservation(root, observation) {
  const target = join(root, OBSERVATION_REL);
  if (!isInside(target, root)) fail("observation path escapes the workspace");
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const text = `${JSON.stringify(observation)}\n`;
  if (Buffer.byteLength(text) > MAX_OBSERVATION_BYTES)
    fail("observation is oversized");
  const fd = openSync(target, "w", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const realPi = EXECUTOR_KIND === "real-pi";
  if (realPi) {
    if (
      !PI_ORCH_LAUNCHER ||
      !isAbsolute(PI_ORCH_LAUNCHER) ||
      !existsSync(PI_ORCH_LAUNCHER)
    ) {
      fail("pinned pi-orch launcher path is missing");
    }
    if (!OMP_BIN || !isAbsolute(OMP_BIN) || !existsSync(OMP_BIN))
      fail("pinned underlying OMP binary path is missing");
    if (basename(OMP_BIN) !== "omp")
      fail(
        "underlying OMP binary must be invoked as 'omp' by the pinned launcher",
      );
  } else if (!OMP_BIN || !isAbsolute(OMP_BIN)) {
    fail("pinned OMP binary path is missing");
  }
  const job = parseJob(JOB_FILE);
  const { server, port } = await startModelRelay();
  const scratch = process.env.TMPDIR ?? "/scratch";
  const home = process.env.HOME ?? "/scratch/home";
  const agentDir = join(home, ".omp", "agent");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  writeAgentConfig(agentDir, port);
  // Real child Pi workers use Pi's own registry; only the OMP registry exists
  // for the fixed executor. Register the same loopback synthetic model there.
  if (realPi) writePiAgentConfig(home, port);

  // The installed extension resolves its Pi worker binary from its own
  // module graph and falls back to a bare "pi" when that resolution is not
  // available in the OMP extension loader. Provide that exact installed Pi
  // CLI inside the guest scratch tmpfs; this is a shim to the pinned
  // /piorch node_modules closure, not a different executor.
  let workerPathPrefix = "";
  if (realPi) {
    const launcherRoot = dirname(dirname(PI_ORCH_LAUNCHER));
    const piCli = join(
      launcherRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    if (!existsSync(piCli))
      fail("pinned Pi worker CLI is missing from the launcher closure");
    const realPiBin = join(scratch, "bin");
    mkdirSync(realPiBin, { recursive: true, mode: 0o700 });
    const wrapper = join(realPiBin, "pi");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${JSON.stringify(NODE_BIN)} ${JSON.stringify(piCli)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(wrapper, 0o700);
    workerPathPrefix = `${realPiBin}:`;
  }

  const tools = realPi
    ? "read,grep,glob,write,task,wait,opencode_task,opencode_spawn,opencode_wait,opencode_tools"
    : job.mode === "read_only"
      ? "read"
      : "read,write";
  const requestedTimeout = process.env.COMPANION_GUEST_TIMEOUT_SECONDS;
  let maxTimeSeconds = 300;
  if (requestedTimeout !== undefined) {
    const seconds = Number(requestedTimeout);
    if (!Number.isFinite(seconds) || seconds <= 0)
      fail("COMPANION_GUEST_TIMEOUT_SECONDS must be a positive number");
    maxTimeSeconds = Math.max(
      1,
      Math.min(900, Math.floor(seconds) - GUEST_TIMEOUT_MARGIN_SECONDS),
    );
  }
  const args = realPi
    ? [
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--approval-mode",
        "yolo",
        "--auto-approve",
        "--max-time",
        String(maxTimeSeconds),
        buildPrompt(job),
      ]
    : [
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--model",
        MODEL_ALIAS,
        "--thinking",
        "off",
        "--approval-mode",
        "yolo",
        "--auto-approve",
        "--tools",
        tools,
        "--max-time",
        String(maxTimeSeconds),
        buildPrompt(job),
      ];
  const env = {
    PATH: `${workerPathPrefix}${dirname(NODE_BIN)}:${dirname(OMP_BIN)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: scratch,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    OMP_LOG_LEVEL: "error",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "127.0.0.1,localhost",
    ...(realPi
      ? {
          PI_ORCH_RUNTIME: "omp",
          PI_CODEX_MODEL: MODEL_ALIAS,
          // The installed extension's opencode_task resolves its worker
          // backend from this env value. pi:: keeps the child a real OMP/Pi
          // process inside the same guest instead of reaching OpenCode's
          // provider registry (which has no synthetic endpoint).
          PI_OPENCODE_MODEL: `pi::${MODEL_ALIAS}`,
          PI_CODEX_THINKING: "off",
          PI_OPENCODE_TIMEOUT_MS: String(maxTimeSeconds * 1000),
        }
      : {}),
  };
  const command = realPi ? NODE_BIN : OMP_BIN;
  const commandArgs = realPi ? [PI_ORCH_LAUNCHER, ...args] : args;
  const engine = realPi ? "pi-orch-omp-json" : "omp-headless-json";
  const child = spawn(command, commandArgs, {
    cwd: WORK_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.on("data", (chunk) => {
    if (stdout.length < MAX_OMP_STDOUT_BYTES)
      stdout += chunk
        .toString("utf8")
        .slice(0, MAX_OMP_STDOUT_BYTES - stdout.length);
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 4096)
      stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }, maxTimeSeconds * 1000);
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (exitCode, signal) =>
      resolve(exitCode ?? (signal ? 143 : 1)),
    );
  });
  clearTimeout(timer);
  try {
    server.close();
  } catch {
    // Best effort.
  }
  const summary = summarizeEvents(stdout, stderr);
  writeObservation(WORK_ROOT, {
    schemaVersion: 1,
    engine,
    executorKind: EXECUTOR_KIND,
    ...(realPi ? { launcher: PI_ORCH_LAUNCHER } : {}),
    modelAlias: MODEL_ALIAS,
    mode: job.mode,
    tools,
    ompExitCode: code,
    timedOut,
    ...summary,
  });
  const digest = createHash("sha256").update(stdout).digest("hex");
  process.stdout.write(
    `${JSON.stringify({
      companionGuest: true,
      engine,
      ompExitCode: code,
      timedOut,
      toolCount: summary.tools.length,
      modelCalls: summary.modelCalls,
      stdoutSha256: digest,
    })}\n`,
  );
  if (timedOut) guestFailed("OMP exceeded the frozen guest timeout");
  if (code !== 0) guestFailed("OMP exited nonzero");
  if (summary.error) guestFailed("OMP reported a model or tool error");
  if (summary.tools.length === 0)
    guestFailed("OMP produced no observed tool action");
  process.exit(0);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
