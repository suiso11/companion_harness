#!/usr/bin/env node
// CI-only sealed executor substitute.
//
// GitHub-hosted runners do not carry the operator-installed pi-orch/OMP
// closure. This script is copied into the fixture and executed INSIDE the
// SAME real systemd-user + bwrap scope as `pi-orch-guest.mjs`, but it never
// runs the installed launcher or OMP. It drives the REAL host TrialModelRelay
// over the sealed model UDS with the same plain guest tool names (`read` /
// `write`) and the same parent delegation shape (`opencode_task`), then
// writes the guest observation the bridge expects.
//
// Honesty boundary: the substitute is recorded as `executorKind:
// "ci-substitute"` and `ciSubstitute: true`. It exercises the real
// server/UI/planner/materializer/TrialRunner/sealed bridge/relay/containment
// and host checks, but it is NOT evidence that the installed pi-orch or OMP
// binary works. Local runs keep using the real installed closure.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, isAbsolute, join, relative } from "node:path";

const WORK_ROOT = "/work";
const MODEL_UDS = process.env.COMPANION_MODEL_UDS ?? "/run/model.sock";
const JOB_FILE = process.env.COMPANION_JOB_FILE ?? "/run/companion-job.json";
const OBSERVATION_REL =
  process.env.COMPANION_OBSERVATION_REL ?? ".companion-observation/guest.json";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_CALLS = Math.max(
  1,
  Math.min(Number(process.env.COMPANION_MAX_MODEL_CALLS ?? 8), 16),
);

function fail(message) {
  process.stderr.write(`ci-executor: ${message}\n`);
  process.exit(2);
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
  if (raw.version !== 1) fail("frozen job version must be 1");
  if (raw.mode !== "read_only" && raw.mode !== "write")
    fail("frozen job mode is invalid");
  if (typeof raw.objective !== "string" || raw.objective.length === 0)
    fail("frozen objective is invalid");
  return raw;
}

function relay(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_REQUEST_BYTES) fail("relay request is oversized");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: MODEL_UDS,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: "Bearer dummy-bearer-not-a-secret",
          "content-length": String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error("relay response is oversized"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          if ((res.statusCode ?? 0) !== 200) {
            reject(
              new Error(`relay rejected the call: HTTP ${res.statusCode ?? 0}`),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("relay returned invalid JSON"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function tool(name, description, parameters) {
  return {
    type: "function",
    function: { name, description, parameters },
  };
}

const OPENCODE_TASK = tool(
  "opencode_task",
  "Delegate one bounded task to a child worker.",
  {
    type: "object",
    properties: {
      name: { type: "string" },
      mode: { type: "string", enum: ["read_only", "write"] },
      objective: { type: "string" },
      relevant_paths: { type: "array", items: { type: "string" } },
      expected_output: { type: "string" },
    },
    required: ["name", "mode", "objective"],
  },
);
const READ_TOOL = tool("read", "Read one file from the sealed workspace.", {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
});
const WRITE_TOOL = tool(
  "write",
  "Create or replace one file in the sealed workspace.",
  {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
);

const used = { count: 0 };

async function callModel(label, messages, tools) {
  used.count += 1;
  if (used.count > MAX_MODEL_CALLS) fail("model call cap exceeded");
  const response = await relay({
    messages,
    tools,
    tool_choice: "auto",
    stream: false,
  });
  const choice = response?.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message !== "object")
    fail(`${label}: relay returned no assistant message`);
  return message;
}

function parseArguments(call) {
  const raw = call?.function?.arguments;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      fail("tool arguments are not valid JSON");
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  fail("tool arguments are missing");
}

function workspacePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/"))
    fail("tool path must be relative");
  const target = realpathSync(join(WORK_ROOT, path));
  if (!isInside(target, WORK_ROOT)) fail("tool path escapes the workspace");
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile())
    fail("tool path must be a regular non-symlink file");
  return target;
}

function executeChildCall(name, args) {
  if (name === "read") {
    const target = workspacePath(args.path);
    return {
      content: readFileSync(target, "utf8"),
      observed: { name: "read", args: { path: args.path }, result: "ok" },
    };
  }
  if (name === "write") {
    if (typeof args.content !== "string") fail("write content is missing");
    const target = workspacePath(args.path);
    writeFileSync(target, args.content, { mode: 0o600 });
    return {
      content: JSON.stringify({
        summary: "candidate written",
        files: [args.path],
      }),
      observed: { name: "write", args: { path: args.path }, result: "ok" },
    };
  }
  fail(`unexpected child tool: ${String(name)}`);
}

async function runChild(task) {
  const writeMode = task.mode === "write";
  const tools = writeMode ? [READ_TOOL, WRITE_TOOL] : [READ_TOOL];
  const messages = [
    {
      role: "system",
      content:
        "[CI substitute direct worker] Use only the provided sealed workspace tools. Never delegate.",
    },
    {
      role: "user",
      content: `Objective: ${String(task.objective ?? "")}\nRelevant paths: ${(
        task.relevant_paths ?? []
      ).join(", ")}`,
    },
  ];
  const first = await callModel("child", messages, tools);
  const call = first.tool_calls?.[0];
  if (!call || typeof call !== "object") fail("child returned no tool call");
  const name = call.function?.name;
  const args = parseArguments(call);
  const executed = executeChildCall(name, args);
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: call.id,
        type: "function",
        function: {
          name,
          arguments:
            typeof call.function.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(args),
        },
      },
    ],
  });
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: executed.content,
  });
  const final = await callModel("child-final", messages, tools);
  return {
    observed: executed.observed,
    report:
      typeof final.content === "string" && final.content.length > 0
        ? final.content
        : JSON.stringify({ summary: "child worker finished" }),
  };
}

function writeObservation(observation) {
  const target = join(WORK_ROOT, OBSERVATION_REL);
  if (!isInside(target, WORK_ROOT)) fail("observation path escapes workspace");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(observation)}\n`;
  if (Buffer.byteLength(text, "utf8") > 64 * 1024)
    fail("observation is oversized");
  writeFileSync(target, text, { mode: 0o600 });
}

async function main() {
  const job = parseJob(JOB_FILE);
  const workerId = `oc-${process.pid}`;
  const messages = [
    {
      role: "system",
      content:
        "[CI substitute pi-orch parent] Delegate the bounded work to exactly one child worker with opencode_task.",
    },
    { role: "user", content: job.objective },
  ];
  const first = await callModel("parent", messages, [OPENCODE_TASK]);
  const call = first.tool_calls?.[0];
  if (!call || typeof call !== "object") fail("parent returned no tool call");
  const name = call.function?.name;
  if (name !== "opencode_task") fail(`unexpected parent tool: ${String(name)}`);
  const task = parseArguments(call);
  const child = await runChild(task);
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: call.id,
        type: "function",
        function: {
          name,
          arguments:
            typeof call.function.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(task),
        },
      },
    ],
  });
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({
      id: workerId,
      status: "done",
      report: child.report,
    }),
  });
  const final = await callModel("parent-final", messages, [OPENCODE_TASK]);
  const finalText =
    typeof final.content === "string" ? final.content.slice(0, 4096) : "";
  writeObservation({
    schemaVersion: 1,
    engine: "omp-headless-json",
    executorKind: "ci-substitute",
    ciSubstitute: true,
    substitute: "scripts/pi-orch-bridge/ci-executor.mjs",
    modelAlias: "companion-current/companion-current",
    mode: job.mode,
    tools: [
      {
        name: "opencode_task",
        args: {},
        result: "ok",
      },
      child.observed,
    ],
    delegatedWorkers: [{ id: workerId, status: "done" }],
    ompExitCode: 0,
    timedOut: false,
    finalText,
  });
  process.stdout.write(
    `${JSON.stringify({
      companionCiExecutor: true,
      modelCalls: used.count,
      toolCount: 2,
      workerId,
    })}\n`,
  );
  process.exit(0);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
