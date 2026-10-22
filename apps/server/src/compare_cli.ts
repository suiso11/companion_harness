// Fixed-task baseline/variant comparison CLI.
//
// This is an explicit experimental operator command, not a production
// feature. It executes the REAL RunEngine + AgentStrategy (the same
// prompt/classification/repair/citation path as the server) against ONE
// fixed prompt and a fixed set of local documents, using dedicated
// throw-away storage. It never registers production MCP/Calendar/Web tools
// and never writes anything except the experimental DB and the private
// execution records inside the selected storage directory.
//
// Baseline = the immutable AGENT_SYSTEM_PROMPT only.
// Variant  = the same immutable base prompt PLUS the operator's variant
//            guidance (composeAgentSystemPrompt appends; it never replaces
//            the base safety rules).
//
// Output contains the ACTUAL answers/citations/tool calls/token counts/
// durations from both runs. It does not compute a fake "score": the
// operator compares the evidence. The model address comes from
// COMPANION_MODEL_JSON (the same strict loopback-only parser as the
// server); credentials never enter the output.
//
// Usage:
//   COMPANION_MODEL_JSON='{"adapter":"ollama","baseUrl":"http://127.0.0.1:11434","model":"..."}' \
//     pnpm --filter @companion/server compare -- /absolute/input.json
//
// Input file (strict, version 1):
//   {
//     "version": 1,
//     "prompt": "fixed task text",
//     "docs": [{ "key": "doc-a", "path": "/abs/doc-a.md", "title": "A" }],
//     "storageDirectory": "/abs/experimental-dir",
//     "variant": { "label": "variant-a", "systemPrompt": "extra guidance" },
//     "timeoutMs": 120000,
//     "maxSteps": 6,
//     "voice": "shunkin"
//   }
//
// `voice` is optional: when present, the SAME bundled voice renderer is
// attached to both baseline and variant. Output keeps each case's canonical
// answer/text and adds the auxiliary voice status/reason/parts.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentVoiceLayer,
  BUNDLED_VOICE_PROFILE_IDS,
  closeKernelDatabase,
  createAgentStrategy,
  createExecutionRecordStore,
  createKernelRepository,
  createReferenceManager,
  createToolBroker,
  createVoiceRenderer,
  loadBundledVoiceProfile,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
  StrategyRegistry,
  sha256Hex,
  ToolError,
  voiceProfileFingerprint,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { z } from "zod";
import { createModelGateway } from "./bootstrap.js";
import { parseModelConfig } from "./config.js";

const MAX_DOCS = 6;
const MAX_DOC_BYTES = 32 * 1024;
const MAX_PROMPT_CHARS = 20_000;
const MAX_VARIANT_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 900_000;
// Strict broker ToolDescriptor names are `namespace.verb`, so the registered
// tool is `experiment.read`; the prompt and fixture use this exact name.
const DOC_TOOL = "experiment.read";
const DOC_CONNECTOR_DISPLAY_NAME = "comparison-docs";

export class CompareCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "CompareCliError";
    this.cliCode = cliCode;
  }
}

function compareError(cliCode: string, message: string): CompareCliError {
  return new CompareCliError(cliCode, message);
}

const USAGE =
  "Use: COMPANION_MODEL_JSON=<loopback model config> compare -- /absolute/input.json";

export function toSafeCompareCliMessage(error: unknown): string {
  if (error instanceof CompareCliError) {
    return error.message;
  }
  return "compare failed";
}

interface CompareDoc {
  readonly key: string;
  readonly path: string;
  readonly title: string;
  readonly text: string;
  readonly sourceRevision: string;
}

export interface CompareInput {
  readonly version: 1;
  readonly prompt: string;
  readonly docs: readonly CompareDoc[];
  readonly storageDirectory: string;
  readonly variant: { readonly label: string; readonly systemPrompt: string };
  readonly timeoutMs: number;
  readonly maxSteps: number | null;
  /** Opt-in bundled voice profile applied to BOTH cases; null = disabled. */
  readonly voice: "shunkin" | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, what: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw compareError("invalid_input", `compare failed: ${what} is invalid`);
  }
  return value;
}

function decodeUtf8(buffer: Buffer, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw compareError("invalid_input", `compare failed: ${what} is not UTF-8`);
  }
}

/**
 * Parse + validate one comparison input file. Paths are absolute and each
 * document is a regular non-symlink file. Content is read once into memory
 * so tool calls never touch the filesystem again.
 */
export function parseCompareInput(text: string): CompareInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw compareError(
      "invalid_input",
      "compare failed: input must be a JSON object",
    );
  }
  if (!isPlainObject(raw)) {
    throw compareError(
      "invalid_input",
      "compare failed: input must be a JSON object",
    );
  }
  const allowed = new Set([
    "version",
    "prompt",
    "docs",
    "storageDirectory",
    "variant",
    "timeoutMs",
    "maxSteps",
    "voice",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw compareError(
        "invalid_input",
        "compare failed: input has an unknown key",
      );
    }
  }
  if (raw.version !== 1) {
    throw compareError(
      "invalid_input",
      "compare failed: input version must be 1",
    );
  }
  const prompt = boundedString(raw.prompt, "prompt", MAX_PROMPT_CHARS);
  const storageDirectory = boundedString(
    raw.storageDirectory,
    "storageDirectory",
    4096,
  );
  if (!isAbsolute(storageDirectory)) {
    throw compareError(
      "invalid_input",
      "compare failed: storageDirectory must be absolute",
    );
  }
  if (!isPlainObject(raw.variant)) {
    throw compareError("invalid_input", "compare failed: variant is invalid");
  }
  const variantAllowed = new Set(["label", "systemPrompt"]);
  for (const key of Object.keys(raw.variant)) {
    if (!variantAllowed.has(key)) {
      throw compareError(
        "invalid_input",
        "compare failed: variant has an unknown key",
      );
    }
  }
  const label = boundedString(raw.variant.label, "variant label", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(label)) {
    throw compareError(
      "invalid_input",
      "compare failed: variant label has an invalid shape",
    );
  }
  const systemPrompt = boundedString(
    raw.variant.systemPrompt,
    "variant systemPrompt",
    MAX_VARIANT_CHARS,
  );
  if (
    !Array.isArray(raw.docs) ||
    raw.docs.length < 1 ||
    raw.docs.length > MAX_DOCS
  ) {
    throw compareError(
      "invalid_input",
      `compare failed: docs must contain 1..${MAX_DOCS} entries`,
    );
  }
  const seenKeys = new Set<string>();
  const docs: CompareDoc[] = [];
  let totalBytes = 0;
  for (const entry of raw.docs) {
    if (!isPlainObject(entry)) {
      throw compareError("invalid_input", "compare failed: doc is invalid");
    }
    for (const key of Object.keys(entry)) {
      if (key !== "key" && key !== "path" && key !== "title") {
        throw compareError(
          "invalid_input",
          "compare failed: doc has an unknown key",
        );
      }
    }
    const key = boundedString(entry.key, "doc key", 64);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || seenKeys.has(key)) {
      throw compareError(
        "invalid_input",
        "compare failed: doc key is invalid or duplicated",
      );
    }
    seenKeys.add(key);
    const path = boundedString(entry.path, "doc path", 4096);
    if (!isAbsolute(path)) {
      throw compareError(
        "invalid_input",
        "compare failed: doc path must be absolute",
      );
    }
    const title =
      entry.title === undefined
        ? basename(path)
        : boundedString(entry.title, "doc title", 200);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      throw compareError(
        "invalid_input",
        `compare failed: cannot read doc ${key}`,
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw compareError(
        "invalid_input",
        `compare failed: doc ${key} must be a regular file (not a symlink)`,
      );
    }
    if (stat.size > MAX_DOC_BYTES) {
      throw compareError(
        "invalid_input",
        `compare failed: doc ${key} exceeds ${MAX_DOC_BYTES} bytes`,
      );
    }
    totalBytes += stat.size;
    const buffer = readFileSync(path);
    const docText = decodeUtf8(buffer, `doc ${key}`);
    if (docText.length === 0) {
      throw compareError(
        "invalid_input",
        `compare failed: doc ${key} is empty`,
      );
    }
    docs.push({
      key,
      path,
      title,
      text: docText,
      sourceRevision: sha256Hex(docText),
    });
  }
  if (totalBytes > MAX_DOCS * MAX_DOC_BYTES) {
    throw compareError("invalid_input", "compare failed: docs are too large");
  }
  const timeoutMs =
    raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : raw.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw compareError(
      "invalid_input",
      `compare failed: timeoutMs must be an integer 1..${MAX_TIMEOUT_MS}`,
    );
  }
  let maxSteps: number | null = null;
  if (raw.maxSteps !== undefined) {
    if (
      typeof raw.maxSteps !== "number" ||
      !Number.isInteger(raw.maxSteps) ||
      raw.maxSteps < 1 ||
      raw.maxSteps > 8
    ) {
      throw compareError(
        "invalid_input",
        "compare failed: maxSteps must be an integer 1..8",
      );
    }
    maxSteps = raw.maxSteps;
  }
  let voice: "shunkin" | null = null;
  if (raw.voice !== undefined) {
    if (
      typeof raw.voice !== "string" ||
      !(BUNDLED_VOICE_PROFILE_IDS as readonly string[]).includes(raw.voice)
    ) {
      throw compareError(
        "invalid_input",
        "compare failed: voice must be a bundled profile id",
      );
    }
    voice = raw.voice as "shunkin";
  }
  return {
    version: 1,
    prompt,
    docs,
    storageDirectory,
    variant: { label, systemPrompt },
    timeoutMs,
    maxSteps,
    voice,
  };
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("unsafe");
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw compareError(
        "storage_unavailable",
        "compare failed: experimental storage is unavailable",
      );
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw compareError(
        "storage_unavailable",
        "compare failed: experimental storage could not be created",
      );
    }
    const created = lstatSync(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw compareError(
        "storage_unavailable",
        "compare failed: experimental storage is unsafe",
      );
    }
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(directory, 0o700);
    } catch {
      throw compareError(
        "storage_unavailable",
        "compare failed: experimental storage permissions failed",
      );
    }
  }
}

function buildTaskText(input: CompareInput): string {
  const keys = input.docs.map((doc) => doc.key).join(", ");
  return (
    `${input.prompt}\n\n` +
    `Fixed local documents are available with the ${DOC_TOOL} tool. ` +
    `Available keys: ${keys}. Read every document needed for the task, ` +
    "then answer using only that evidence and cite documents by their rN id."
  );
}

function createDocRegistration(args: {
  readonly docs: readonly CompareDoc[];
  readonly connectorInstanceId: string;
  readonly manager: ReturnType<typeof createReferenceManager>;
  readonly repo: ReturnType<typeof createKernelRepository>;
}): Parameters<typeof createToolBroker>[0]["registrations"][number] {
  const byKey = new Map(args.docs.map((doc) => [doc.key, doc]));
  return {
    descriptor: {
      name: DOC_TOOL,
      version: 1,
      title: "Read a fixed experimental document",
      description:
        "Read one fixed local document by key. Read-only experimental evidence; returns the document body with its citation id.",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: false,
    },
    inputSchema: z.strictObject({ key: z.string() }),
    outputSchema: z.strictObject({
      referenceId: z.string(),
      ordinal: z.number().int(),
      title: z.string(),
      body: z.strictObject({ version: z.literal(1), text: z.string() }),
    }),
    async handler(input: { key: string }, ctx: { runId: string }) {
      const doc = byKey.get(input.key);
      if (doc === undefined) {
        throw new ToolError("execution_failed");
      }
      const run = args.repo.getRun(ctx.runId);
      if (run.status !== "running") {
        throw new ToolError("execution_failed");
      }
      const presented = args.manager.presentObservations(
        run.sessionId,
        run.id,
        [
          {
            connectorInstanceId: args.connectorInstanceId,
            canonicalKey: `experiment/${doc.key}.md`,
            title: doc.title,
            text: doc.text,
            sourceRevision: doc.sourceRevision,
            observedAt: Date.now(),
          },
        ],
        { freshness: "normal", now: Date.now() },
      );
      const reference = presented.references[0];
      if (!presented.applied || reference === undefined) {
        throw new ToolError("execution_failed");
      }
      return {
        referenceId: reference.referenceId,
        ordinal: reference.ordinal,
        title: reference.title ?? doc.title,
        body: { version: 1, text: doc.text },
      };
    },
  };
}

interface CaseEvidence {
  readonly label: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly text: string | null;
  readonly answer: {
    readonly parts: readonly {
      readonly text: string;
      readonly citations: readonly string[];
    }[];
  } | null;
  readonly citations: readonly string[];
  readonly durationMs: number;
  readonly modelCalls: readonly {
    readonly step: number;
    readonly outcome: string;
    readonly errorCode: string | null;
    readonly durationMs: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  }[];
  readonly tokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  } | null;
  readonly toolCalls: readonly {
    readonly tool: string;
    readonly outcome: string | null;
    readonly errorCode: string | null;
    readonly durationMs: number | null;
  }[];
  readonly privateRecords: {
    readonly count: number;
    readonly kinds: readonly string[];
  } | null;
  readonly voice: {
    readonly status: string;
    readonly reason: string | null;
    readonly parts: readonly string[];
  } | null;
  readonly timedOut: boolean;
}

function extractAnswer(result: unknown): CaseEvidence["answer"] {
  if (!isPlainObject(result)) {
    return null;
  }
  const answer = result.answer;
  if (!isPlainObject(answer) || !Array.isArray(answer.parts)) {
    return null;
  }
  const parts: Array<{ text: string; citations: string[] }> = [];
  for (const part of answer.parts) {
    if (!isPlainObject(part) || typeof part.text !== "string") {
      return null;
    }
    const citations = Array.isArray(part.citations)
      ? part.citations.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    parts.push({ text: part.text, citations });
  }
  return { parts };
}

async function runCase(args: {
  readonly label: string;
  readonly systemPrompt?: string;
  readonly input: CompareInput;
  readonly model: { readonly adapter: string; readonly model: string };
  readonly gateway: ModelGateway;
  readonly handle: ReturnType<typeof openKernelDatabase>;
  readonly repo: ReturnType<typeof createKernelRepository>;
  readonly manager: ReturnType<typeof createReferenceManager>;
  readonly connectorInstanceId: string;
  readonly recorder: ReturnType<typeof createExecutionRecordStore>;
  readonly voice: AgentVoiceLayer | undefined;
}): Promise<CaseEvidence> {
  const { input, repo, handle, gateway, recorder } = args;
  const registrations = [
    createDocRegistration({
      docs: input.docs,
      connectorInstanceId: args.connectorInstanceId,
      manager: args.manager,
      repo,
    }),
  ];
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations,
    executionRecorder: recorder,
  });
  const registry = new StrategyRegistry();
  registry.register(
    "m0-default",
    createAgentStrategy({
      db: handle.raw,
      repo,
      broker,
      gateway,
      model: args.model.model,
      ...(args.systemPrompt === undefined
        ? {}
        : {
            systemPrompt: args.systemPrompt,
            promptVariantName: args.label,
          }),
      executionRecorder: recorder,
      ...(args.voice === undefined ? {} : { voice: args.voice }),
      ...(input.maxSteps === null ? {} : { maxSteps: input.maxSteps }),
    }),
  );
  const engine = new RunEngine({
    db: handle.raw,
    repo,
    registry,
    pollIntervalMs: 5,
  });
  engine.start();
  const sessionId = repo.createSession({
    key: randomUUID(),
    now: Date.now(),
  }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: buildTaskText(input) },
    {
      key: randomUUID(),
      now: Date.now(),
      strategy: "m0-default",
      selectOnSuccess: true,
    },
  );
  const runId = posted.body.run.id;
  const deadline = Date.now() + input.timeoutMs;
  let timedOut = false;
  try {
    for (;;) {
      engine.pump();
      const run = repo.getRun(runId);
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "abandoned"
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        try {
          repo.cancelRun(sessionId, runId, { now: Date.now() });
        } catch {
          // Shutdown below abandons a still-running run.
        }
        const cancelDeadline = Date.now() + 5_000;
        while (Date.now() < cancelDeadline) {
          engine.pump();
          const current = repo.getRun(runId);
          if (
            current.status === "completed" ||
            current.status === "failed" ||
            current.status === "cancelled" ||
            current.status === "abandoned"
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    try {
      await engine.shutdown({ drainMs: 1_000 });
    } catch {
      // Best effort: evidence below uses the durable row.
    }
  }
  const run = repo.getRun(runId);
  const modelCalls = repo.listModelCalls(runId);
  const usageCalls = modelCalls.filter((call) => call.usage !== null);
  const tokens =
    usageCalls.length === 0
      ? null
      : {
          inputTokens: usageCalls.reduce(
            (sum, call) => sum + (call.usage?.inputTokens ?? 0),
            0,
          ),
          outputTokens: usageCalls.reduce(
            (sum, call) => sum + (call.usage?.outputTokens ?? 0),
            0,
          ),
        };
  const toolRows = handle.raw
    .prepare(
      "SELECT tool, actual_outcome, error_code, started_at, actual_finished_at, requested_at FROM tool_calls WHERE run_id = ? ORDER BY call_index ASC",
    )
    .all(runId) as Array<{
    tool: string;
    actual_outcome: string | null;
    error_code: string | null;
    started_at: number | null;
    actual_finished_at: number | null;
    requested_at: number;
  }>;
  const toolCalls = toolRows.map((row) => {
    const start = row.started_at ?? row.requested_at;
    return {
      tool: row.tool,
      outcome: row.actual_outcome,
      errorCode: row.error_code,
      durationMs:
        row.actual_finished_at === null
          ? null
          : Math.max(row.actual_finished_at - start, 0),
    };
  });
  const answer = extractAnswer(run.result);
  const citations =
    answer === null
      ? []
      : [...new Set(answer.parts.flatMap((part) => part.citations))];
  let privateRecords: CaseEvidence["privateRecords"] = null;
  try {
    const records = recorder.exportRun(runId);
    privateRecords = {
      count: records.length,
      kinds: [...new Set(records.map((record) => record.kind))],
    };
  } catch {
    privateRecords = null;
  }
  // Voice is an optional V2 projection. Canonical `text` above always stays
  // authoritative; this output only surfaces the auxiliary status/parts.
  const voiceRender =
    run.result !== null && run.result.version === 2
      ? run.result.voice
      : undefined;
  const voice =
    voiceRender === undefined
      ? null
      : {
          status: voiceRender.status,
          reason: voiceRender.reason ?? null,
          parts: voiceRender.parts?.map((part) => part.text) ?? [],
        };
  return {
    label: args.label,
    runId,
    sessionId,
    status: run.status,
    errorCode: run.errorCode,
    text:
      run.result !== null && typeof run.result.text === "string"
        ? run.result.text
        : null,
    answer,
    citations,
    durationMs:
      (run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt),
    modelCalls: modelCalls.map((call) => ({
      step: call.step,
      outcome: call.outcome,
      errorCode: call.errorCode,
      durationMs: call.durationMs,
      inputTokens: call.usage?.inputTokens ?? null,
      outputTokens: call.usage?.outputTokens ?? null,
    })),
    tokens,
    toolCalls,
    privateRecords,
    voice,
    timedOut,
  };
}

export async function runCompareCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const args = [...argv];
  if (args[0] === "--") {
    args.shift();
  }
  if (args.length !== 1 || args[0] === undefined) {
    throw compareError("usage", `compare failed: ${USAGE}`);
  }
  let inputText: string;
  try {
    inputText = readFileSync(args[0], "utf8");
  } catch {
    throw compareError(
      "invalid_input",
      "compare failed: input file could not be read",
    );
  }
  const input = parseCompareInput(inputText);
  let modelConfig: ReturnType<typeof parseModelConfig>;
  try {
    modelConfig = parseModelConfig(env.COMPANION_MODEL_JSON);
  } catch {
    throw compareError(
      "invalid_model",
      "compare failed: COMPANION_MODEL_JSON is invalid",
    );
  }
  if (modelConfig === null) {
    throw compareError(
      "missing_model",
      "compare failed: set COMPANION_MODEL_JSON (adapter/baseUrl/model)",
    );
  }
  const gateway = createModelGateway(modelConfig);
  ensurePrivateDirectory(input.storageDirectory);
  const experimentDirectory = mkdtempSync(
    join(input.storageDirectory, "comparison-"),
  );
  if (process.platform !== "win32") {
    chmodSync(experimentDirectory, 0o700);
  }
  const dbPath = join(experimentDirectory, "comparison.sqlite");
  const recorder = createExecutionRecordStore({
    directory: join(experimentDirectory, "records"),
  });
  let voiceLayer: AgentVoiceLayer | undefined;
  if (input.voice !== null) {
    const profile = loadBundledVoiceProfile(input.voice);
    voiceLayer = {
      render: createVoiceRenderer({
        gateway,
        model: modelConfig.model,
        profile,
        recorder,
      }),
      profileId: profile.id,
      profileVersion: voiceProfileFingerprint(profile),
      profile: {
        displayName: profile.displayName,
        description: profile.description,
      },
    };
  }
  const handle = openKernelDatabase(dbPath);
  try {
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    const manager = createReferenceManager(handle.raw);
    const connector = manager.ensureMarkdownConnectorInstance(
      DOC_CONNECTOR_DISPLAY_NAME,
      input.docs.length,
      { now: Date.now() },
    );
    const baseline = await runCase({
      label: "baseline",
      input,
      model: { adapter: modelConfig.adapter, model: modelConfig.model },
      gateway,
      handle,
      repo,
      manager,
      connectorInstanceId: connector.id,
      recorder,
      voice: voiceLayer,
    });
    const variant = await runCase({
      label: input.variant.label,
      systemPrompt: input.variant.systemPrompt,
      input,
      model: { adapter: modelConfig.adapter, model: modelConfig.model },
      gateway,
      handle,
      repo,
      manager,
      connectorInstanceId: connector.id,
      recorder,
      voice: voiceLayer,
    });
    const output = {
      version: 1,
      taskHash: sha256Hex(input.prompt),
      model: {
        adapter: modelConfig.adapter,
        model: modelConfig.model,
      },
      documents: input.docs.map((doc) => ({
        key: doc.key,
        title: doc.title,
        bytes: Buffer.byteLength(doc.text, "utf8"),
        sha256: doc.sourceRevision,
      })),
      baseline,
      variant,
      experimentalStorage: experimentDirectory,
    };
    return `${JSON.stringify(output, null, 2)}\n`;
  } finally {
    closeKernelDatabase(handle);
  }
}

function isMainModule(): boolean {
  // Filename-suffix matching silently skipped the CLI for renamed/compiled
  // entrypoints; use the runtime's entry-module flag with a path fallback.
  const main = (import.meta as ImportMeta & { main?: boolean }).main;
  if (main === true) {
    return true;
  }
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return (
      realpathSync(resolve(invoked)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCompareCli()
    .then((output) => {
      process.stdout.write(output);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${toSafeCompareCliMessage(error)}\n`);
      process.exitCode = 1;
    });
}
