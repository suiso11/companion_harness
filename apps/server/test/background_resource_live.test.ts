// Shared background admission LIVE proof: production `startServer` with the
// SAME configured ModelGateway production builds (no injected gateway) pointed
// at a SYNTHETIC loopback HTTP model server (real sockets, own private
// fixture, closed in-test — never a user PID or shared listener).
//
// What this proves over REAL network sockets (not mock-only):
// - Contention: a parked memory-extraction socket + shadow candidates
//   never overlap (observed max concurrent background calls = 1); a busy
//   shadow candidate defers BEFORE claim (stays `pending`, no loss, no
//   claim-then-starve); releasing the extraction lets the oldest shadow job
//   park alone, then complete after its own release.
// - Foreground: an ordinary chat starts WITHOUT waiting for the parked
//   background socket; the parked socket observes a REAL network abort and
//   THAT job holds `aborted_foreground` with no synthetic decision, while
//   the queued explicit job proceeds alone after the release (parks solo,
//   completes normally) and the held job is never auto-revived.
// - STOP (I03-09): pausing control keeps memory admission OPEN — a paused
//   turn still cultivates (across restart too) and explicit manage still
//   completes; a parked extraction aborts only on its own `timeoutMs` bound
//   (STOP never aborts memory work), landing NO late write for it.
// - Release never auto-revives a held job (it stays held to the end).
//
// The purpose POST auto-enqueues a `policy_change` deliberation job (older),
// so phase 2 deterministically aborts+holds THAT job while the explicit
// request (newer) proves ordered post-release progress; both ids are read
// back from the list endpoint rather than assumed.
//
// The synthetic server is a loopback stand-in for the model transport (the
// native protocols are real: `answer.submit`, extraction JSON,
// `autonomy_deliberation.submit`); it is NOT a real model and claims no
// GPU/hardware coverage. Memory uses the REAL remind CLI temp DB when the
// sibling CLI is available (same prerequisite pattern as
// `memory_live_http.test.ts`); the gateway contention proof does not depend
// on it.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";

const TEST_SCOPE = "personal/default";
const MODEL_NAME = "synthetic-live-resource-gateway";

type ParkKind = "extract" | "shadow" | "ordinary";

interface ParkedResponder {
  kind: ParkKind;
  respond: (payload?: unknown) => void;
  aborted: boolean;
}

function hereDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function siblingRemindPath(...parts: string[]): string {
  return resolve(hereDir(), "..", "..", "..", "..", "remind", ...parts);
}

function resolveCliPaths(): { entry: string; template: string } {
  const entry =
    process.env.COMPANION_MEMORY_TEST_ENTRY ??
    siblingRemindPath("dist", "src", "cli.js");
  const template =
    process.env.COMPANION_MEMORY_TEST_CONFIG_TEMPLATE ??
    siblingRemindPath("memory.config.example.json");
  const missing: string[] = [];
  if (!existsSync(entry)) {
    missing.push(`remind CLI entry missing: ${entry}`);
  }
  if (!existsSync(template)) {
    const fallback = siblingRemindPath("memory.config.json");
    if (existsSync(fallback)) {
      return { entry, template: fallback };
    }
    missing.push(`remind config template missing: ${template}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Live resource proof prerequisite missing (real remind CLI required, ` +
        `no fixture fallback): ${missing.join("; ")}. ` +
        `Provide COMPANION_MEMORY_TEST_ENTRY and ` +
        `COMPANION_MEMORY_TEST_CONFIG_TEMPLATE or check out the sibling ` +
        `remind repo with a built dist/src/cli.js.`,
    );
  }
  return { entry, template };
}

function patchRemindConfig(templatePath: string, dir: string): string {
  const raw = readFileSync(templatePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const dbPath = join(dir, "remind-live.db");
  const vaultPath = join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  if (typeof parsed.dbPath === "string") {
    parsed.dbPath = dbPath;
  }
  if (typeof parsed.vaultPath === "string") {
    parsed.vaultPath = vaultPath;
  }
  if (Array.isArray(parsed.allowedScopes)) {
    const scopes = parsed.allowedScopes as unknown[];
    if (!scopes.includes(TEST_SCOPE)) {
      scopes.push(TEST_SCOPE);
    }
  }
  const vectors = parsed.vectors as Record<string, unknown> | undefined;
  if (
    vectors !== undefined &&
    typeof vectors === "object" &&
    vectors !== null
  ) {
    if ("enabled" in vectors) {
      vectors.enabled = false;
    }
  }
  const llm = parsed.llm as Record<string, unknown> | undefined;
  if (llm !== undefined && typeof llm === "object" && llm !== null) {
    if ("enabled" in llm) {
      llm.enabled = false;
    }
  }
  const outPath = join(dir, "remind-live.config.json");
  writeFileSync(outPath, JSON.stringify(parsed), "utf-8");
  return outPath;
}

function answerPayload(text: string): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: "answer-1",
              type: "function",
              function: {
                name: "answer.submit",
                arguments: JSON.stringify({
                  version: 1,
                  parts: [{ text, citations: [] }],
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function extractionPayload(): unknown {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            memories: [
              {
                body: "ユーザーは緑茶が好きだと伝え、アシスタントがそれを覚えた。",
                kind: "summary",
              },
              { body: "user likes green tea", kind: "user_fact" },
            ],
          }),
        },
        finish_reason: "stop",
      },
    ],
  };
}

function shadowPayload(label: string): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: "shadow-call-1",
              type: "function",
              function: {
                name: "autonomy_deliberation.submit",
                arguments: JSON.stringify({
                  decision: "do-nothing",
                  evidenceIds: [label],
                  reason: "nothing to do yet",
                  proposedAction: null,
                  completion: "none required",
                  stopConditions: ["any new constraint appears"],
                  uncertainty: "low",
                  counterargument: "waiting could miss a window",
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/**
 * Synthetic loopback model server over REAL HTTP sockets. Per-kind modes
 * (`park` holds the socket open; `immediate` answers) plus concurrency
 * accounting and real abort observation (request `close` before respond).
 */
async function startSyntheticModel(): Promise<{
  url: string;
  close: () => Promise<void>;
  state: {
    current: number;
    max: number;
    calls: number;
    shadowCalls: number;
    extractCalls: number;
    aborted: ParkKind[];
    parked: ParkedResponder[];
    parkExtract: boolean;
    parkShadow: boolean;
  };
}> {
  const state = {
    current: 0,
    max: 0,
    calls: 0,
    shadowCalls: 0,
    extractCalls: 0,
    aborted: [] as ParkKind[],
    parked: [] as ParkedResponder[],
    parkExtract: false,
    parkShadow: false,
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const names = tools
        .map((tool) => {
          if (typeof tool !== "object" || tool === null) {
            return null;
          }
          const record = tool as Record<string, unknown>;
          if (typeof record.name === "string") {
            return record.name;
          }
          const fn = record.function as Record<string, unknown> | undefined;
          return typeof fn?.name === "string" ? fn.name : null;
        })
        .filter((name): name is string => name !== null);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { role?: unknown }).role === "system",
      ) as { content?: unknown } | undefined;
      const systemText =
        typeof system?.content === "string" ? system.content : "";
      let kind: ParkKind = "ordinary";
      if (names.includes("autonomy_deliberation.submit")) {
        kind = "shadow";
      } else if (systemText.startsWith("Extract durable memories")) {
        kind = "extract";
      }
      state.calls += 1;
      if (kind === "shadow") {
        state.shadowCalls += 1;
      }
      if (kind === "extract") {
        state.extractCalls += 1;
      }
      state.current += 1;
      state.max = Math.max(state.max, state.current);
      let responded = false;
      const finish = (): void => {
        if (!responded) {
          responded = true;
          state.current -= 1;
        }
      };
      // Real socket-abort observation: `res` close while NO response was
      // sent yet means the client went away mid-park (an abort). `req`
      // close is NOT used: Node emits it when the request stream completes,
      // even with the socket healthy. After `respond()` the guard below is
      // inert (`responded` is already true; normal completion decrements).
      res.on("close", () => {
        if (!responded) {
          entry.aborted = true;
          state.aborted.push(kind);
          const index = state.parked.indexOf(entry);
          if (index >= 0) {
            state.parked.splice(index, 1);
          }
          finish();
        }
      });
      const userText =
        messages
          .filter(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { role?: unknown }).role === "user",
          )
          .map((message) => (message as { content?: unknown }).content ?? "")
          .join("\n") ?? "";
      const label = /sP\d+/.exec(String(userText))?.[0] ?? "sP1";
      const payload =
        kind === "shadow"
          ? shadowPayload(label)
          : kind === "extract"
            ? extractionPayload()
            : answerPayload("Noted green tea.");
      const entry: ParkedResponder = {
        kind,
        aborted: false,
        respond: (custom?: unknown) => {
          if (responded) {
            return;
          }
          responded = true;
          const index = state.parked.indexOf(entry);
          if (index >= 0) {
            state.parked.splice(index, 1);
          }
          try {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(custom ?? payload));
          } catch {
            // Best effort: the client may already be gone.
          }
          state.current -= 1;
        },
      };
      const shouldPark =
        (kind === "extract" && state.parkExtract) ||
        (kind === "shadow" && state.parkShadow);
      if (shouldPark) {
        state.parked.push(entry);
        return;
      }
      entry.respond();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("synthetic model server did not bind");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
    state,
  };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      origin: base,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(
  base: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    headers: { host: "127.0.0.1" },
  });
  return { status: response.status, body: await response.json() };
}

async function waitForHistoryResult(
  base: string,
  sessionId: string,
  position: number,
  timeoutMs = 30_000,
): Promise<{ runId: string; text: string }> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(
      `${base}/api/sessions/${sessionId}/history?limit=50`,
      { headers: { host: "127.0.0.1" } },
    );
    if (res.status === 200) {
      const body = (await res.json()) as {
        items: Array<{
          seq: number;
          selectedRun: {
            runId: string;
            result: { text: string } | null;
          } | null;
        }>;
      };
      const item = body.items.find((entry) => entry.seq === position);
      const result = item?.selectedRun?.result ?? null;
      if (result !== null && typeof result.text === "string") {
        return {
          runId: item?.selectedRun?.runId as string,
          text: result.text,
        };
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for history position ${position}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 15_000,
  message = "waitFor timed out",
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function queryOutboxKinds(
  dbPath: string,
  runId: string,
): Array<{ kind: string; status: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT kind, status FROM memory_outbox WHERE run_id = ?")
      .all(runId) as Array<{ kind: string; status: string }>;
  } finally {
    db.close();
  }
}

describe("background resource live proof (production server + real sockets)", () => {
  it("restart keeps memory admission open while paused; explicit manage completes STOPped", async () => {
    const { entry, template } = resolveCliPaths();
    const root = mkdtempSync(join(tmpdir(), "companion-live-bg-restart-"));
    // The remind home is REUSED across the restart below: staged records
    // persist, so post-restart management acts on the same real data.
    const remindDir = mkdtempSync(join(tmpdir(), "remind-live-bg-restart-"));
    const model = await startSyntheticModel();
    let started: StartedServer | null = null;
    try {
      const remindConfig = patchRemindConfig(template, remindDir);
      const dbPath = join(root, "companion.sqlite");
      const buildEnv = (): NodeJS.ProcessEnv => ({
        COMPANION_DB_PATH: dbPath,
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "0",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "error",
        COMPANION_MODEL_JSON: JSON.stringify({
          adapter: "openai-compatible",
          baseUrl: model.url,
          model: MODEL_NAME,
        }),
        COMPANION_MEMORY_JSON: JSON.stringify({
          executable: process.execPath,
          entry,
          config: remindConfig,
          scope: TEST_SCOPE,
          timeoutMs: 15000,
          maxResponseBytes: 65536,
          recallLimit: 5,
          idleMs: 5000,
        }),
      });
      const countExtractCalls = (): number => model.state.extractCalls;

      started = await startServer({ env: buildEnv(), drainMs: 200 });
      let base = `http://127.0.0.1:${String(started.port)}`;
      const session = await postJson(base, "/api/sessions", {});
      expect(session.status).toBe(201);
      const sessionId = (session.body as { sessionId: string }).sessionId;
      const control = await getJson(base, "/api/autonomy/control");
      expect(control.status).toBe(200);
      const unpause = await postJson(base, "/api/autonomy/control", {
        paused: false,
        expectedVersion: (control.body as { version: number }).version,
      });
      expect(unpause.status).toBe(200);

      // Baseline: ordinary chat cultivates (extraction writes land).
      const extractBaseline = countExtractCalls();
      const first = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        {
          text: "I like green tea.",
        },
      );
      expect(first.status).toBe(202);
      const turn1 = await waitForHistoryResult(base, sessionId, 1);
      await waitFor(
        () =>
          queryOutboxKinds(dbPath, turn1.runId).some(
            (row) => row.kind === "event.append" && row.status === "acked",
          ),
        30_000,
        "extraction did not cultivate the first turn",
      );
      expect(countExtractCalls()).toBeGreaterThan(extractBaseline);

      // STOP with no chat in flight (I03-09): memory admission stays OPEN.
      // The idle tick (idleMs 5000) runs the due automatic distill while
      // paused — it may be observed pending before its own drain completes —
      // and explicit management below still drains without another chat
      // anywhere.
      const pausing = await getJson(base, "/api/autonomy/control");
      const stopped = await postJson(base, "/api/autonomy/control", {
        paused: true,
        expectedVersion: (pausing.body as { version: number }).version,
      });
      expect(stopped.status).toBe(200);
      await waitFor(
        () => {
          const db = new Database(dbPath, { readonly: true });
          try {
            // Observed pending BEFORE its own (open-gate) drain completes,
            // OR already acked by that drain (either proves the idle tick
            // enqueued the due distill while paused).
            const rows = db
              .prepare(
                "SELECT status FROM memory_outbox WHERE kind = 'maintain.distill'",
              )
              .all() as Array<{ status: string }>;
            return rows.some(
              (row) => row.status === "pending" || row.status === "acked",
            );
          } finally {
            db.close();
          }
        },
        30_000,
        "no due automatic distill enqueued while STOPped",
      );

      const searchOnce = async (): Promise<{
        searchId: string;
        handle: string;
      }> => {
        const res = await postJson(
          base,
          `/api/sessions/${sessionId}/memory/search`,
          { query: "green tea", runId: turn1.runId },
        );
        expect(res.status).toBe(200);
        const hits = (res.body as { hits: Array<{ handle: string }> }).hits;
        expect(hits.length).toBeGreaterThan(0);
        return {
          searchId: (res.body as { searchId: string }).searchId,
          handle: (hits[0] as { handle: string }).handle,
        };
      };
      const stageAndAwait = async (
        kind: "record.retire" | "record.reactivate" | "record.correct",
        extra?: Record<string, unknown>,
      ): Promise<void> => {
        const target = await searchOnce();
        const res = await postJson(
          base,
          `/api/sessions/${sessionId}/memory/mutations`,
          {
            kind,
            searchId: target.searchId,
            handle: target.handle,
            runId: turn1.runId,
            ...(extra ?? {}),
          },
        );
        expect(res.status).toBe(202);
        const operationId = (res.body as { operationId: string }).operationId;
        const deadline = Date.now() + 30_000;
        for (;;) {
          const polled = await getJson(
            base,
            `/api/sessions/${sessionId}/memory/operations/${operationId}`,
          );
          expect(polled.status).toBe(200);
          const opStatus = (polled.body as { status: string }).status;
          if (opStatus === "acked") {
            return;
          }
          expect(opStatus).toBe("pending");
          if (Date.now() > deadline) {
            throw new Error(
              `${kind} never reached terminal done while STOPped`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };

      // Each explicit management kind reaches terminal done while STOPped.
      await stageAndAwait("record.retire");
      await stageAndAwait("record.reactivate");
      await stageAndAwait("record.correct", {
        correctionBody: "The user prefers oolong tea in the evening.",
      });

      // Restart with the control STILL paused: the kernel fence keeps it
      // paused but memory admission stays OPEN across restart (I03-09,
      // bootstrap no longer initializes the gate from the persisted pause) —
      // the first ordinary chat on the fresh process still cultivates while
      // paused: extraction runs and the write chain (event.append acked,
      // then the remember fan-out) lands without any explicit resume.
      await started.shutdown("test-restart");
      started = null;
      const extractBeforeRestart = countExtractCalls();
      started = await startServer({ env: buildEnv(), drainMs: 200 });
      base = `http://127.0.0.1:${String(started.port)}`;
      const controlAfter = await getJson(base, "/api/autonomy/control");
      expect(controlAfter.status).toBe(200);
      expect((controlAfter.body as { paused: boolean }).paused).toBe(true);
      const second = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "Are you still there?" },
      );
      expect(second.status).toBe(202);
      const turn2 = await waitForHistoryResult(base, sessionId, 2, 30_000);
      expect(turn2.text.length).toBeGreaterThan(0);
      await waitFor(
        () =>
          queryOutboxKinds(dbPath, turn2.runId).some(
            (row) => row.kind === "event.append" && row.status === "acked",
          ),
        30_000,
        "paused turn did not cultivate across restart",
      );
      expect(countExtractCalls()).toBeGreaterThan(extractBeforeRestart);
      await waitFor(
        () =>
          queryOutboxKinds(dbPath, turn2.runId).some(
            (row) => row.kind === "record.remember",
          ),
        30_000,
        "remember fan-out missing for the paused restart turn",
      );

      // An explicit current-version resume unpauses the kernel fence (the
      // memory gate was already open): the next ordinary chat cultivates
      // as usual on the resumed control.
      const resuming = await getJson(base, "/api/autonomy/control");
      const resumed = await postJson(base, "/api/autonomy/control", {
        paused: false,
        expectedVersion: (resuming.body as { version: number }).version,
      });
      expect(resumed.status).toBe(200);
      const third = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "Remember oolong too." },
      );
      expect(third.status).toBe(202);
      const turn3 = await waitForHistoryResult(base, sessionId, 3, 30_000);
      await waitFor(
        () =>
          queryOutboxKinds(dbPath, turn3.runId).some(
            (row) => row.kind === "event.append" && row.status === "acked",
          ),
        30_000,
        "extraction did not resume after explicit resume",
      );
    } finally {
      if (started !== null) {
        await started.shutdown("test-teardown").catch(() => undefined);
      }
      await model.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      rmSync(remindDir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 180_000);
  it("contends at max 1, foreground preempts, STOP aborts with no late writes", async () => {
    const { entry, template } = resolveCliPaths();
    const root = mkdtempSync(join(tmpdir(), "companion-live-bg-"));
    const remindDir = mkdtempSync(join(tmpdir(), "remind-live-bg-"));
    const model = await startSyntheticModel();
    let started: StartedServer | null = null;
    try {
      const remindConfig = patchRemindConfig(template, remindDir);
      const dbPath = join(root, "companion.sqlite");
      const env: NodeJS.ProcessEnv = {
        COMPANION_DB_PATH: dbPath,
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "0",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "error",
        // The SAME configured gateway production builds (no injection):
        // the synthetic loopback HTTP server is the model transport.
        COMPANION_MODEL_JSON: JSON.stringify({
          adapter: "openai-compatible",
          baseUrl: model.url,
          model: MODEL_NAME,
        }),
        COMPANION_MEMORY_JSON: JSON.stringify({
          executable: process.execPath,
          entry,
          config: remindConfig,
          scope: TEST_SCOPE,
          timeoutMs: 5000,
          maxResponseBytes: 65536,
          recallLimit: 5,
          idleMs: 300000,
        }),
      };
      started = await startServer({ env, drainMs: 200 });
      const base = `http://127.0.0.1:${String(started.port)}`;
      expect(started.port).toBeGreaterThan(0);

      const session = await postJson(base, "/api/sessions", {});
      expect(session.status).toBe(201);
      const sessionId = (session.body as { sessionId: string }).sessionId;

      const control = await getJson(base, "/api/autonomy/control");
      expect(control.status).toBe(200);
      const unpause = await postJson(base, "/api/autonomy/control", {
        paused: false,
        expectedVersion: (control.body as { version: number }).version,
      });
      expect(unpause.status).toBe(200);

      // Phase 1: park BOTH background kinds; ordinary answers immediately.
      model.state.parkExtract = true;
      model.state.parkShadow = true;
      const first = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        {
          text: "I like green tea.",
        },
      );
      expect(first.status).toBe(202);
      const turn1 = await waitForHistoryResult(base, sessionId, 1);
      expect(turn1.text).toContain("green tea");
      // The completed run's extraction now parks on a REAL held socket.
      await waitFor(
        () => model.state.parked.some((entry) => entry.kind === "extract"),
        15_000,
        "extraction did not park",
      );

      // A shadow candidate now contends: it must defer BEFORE claim —
      // still exactly one concurrent background call, job stays pending.
      const purpose = await postJson(
        base,
        `/api/sessions/${sessionId}/purposes`,
        {
          scope: "health",
          statement: "walk daily",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
      );
      expect(purpose.status).toBe(201);
      const requested = await postJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs`,
        { scope: "health" },
      );
      expect(requested.status).toBe(201);
      const shadowJobId = (requested.body as { id: string }).id;
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(model.state.max).toBe(1);
      const deferred = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs/${shadowJobId}`,
      );
      expect((deferred.body as { status: string }).status).toBe("pending");
      // The purpose POST auto-enqueued an older `policy_change` job beside
      // the explicit request: read its id back (never assumed) — it is the
      // unit that will park first and later prove the abort+hold path.
      const listedPhase1 = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs`,
      );
      const phase1Items = (
        listedPhase1.body as {
          items: Array<{ id: string; status: string }>;
        }
      ).items;
      expect(phase1Items).toHaveLength(2);
      const autoJob = phase1Items.find((item) => item.id !== shadowJobId);
      expect(autoJob).toBeDefined();
      const autoJobId = (autoJob as { id: string }).id;
      expect(phase1Items.find((item) => item.id === autoJobId)?.status).toBe(
        "pending",
      );

      // Release the extraction: it completes, frees the gate, and the
      // single release-wake re-drives the shadow job, which parks alone.
      for (const entry of [...model.state.parked]) {
        if (entry.kind === "extract") {
          entry.respond();
        }
      }
      await waitFor(
        () => model.state.parked.some((entry) => entry.kind === "shadow"),
        15_000,
        "shadow did not proceed after release",
      );
      expect(model.state.max).toBe(1);

      // Phase 2: an ordinary chat starts WITHOUT waiting for the parked
      // background socket (the older auto job); the parked socket observes
      // a REAL network abort and THAT job holds (never a synthetic
      // decision), while the queued explicit job proceeds alone after the
      // release and the held job is never auto-revived.
      const second = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "Still there?" },
      );
      expect(second.status).toBe(202);
      const turn2 = await waitForHistoryResult(base, sessionId, 2);
      expect(turn2.text).toContain("green tea");
      await waitFor(
        () => model.state.aborted.includes("shadow"),
        15_000,
        "parked shadow socket saw no real abort",
      );
      // The aborted unit (auto job) lands terminally: poll until the hold
      // commits rather than asserting on the socket observation alone.
      const heldAt = Date.now();
      let heldPoll: { status: number; body: unknown } = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs/${autoJobId}`,
      );
      while (
        (heldPoll.body as { status: string }).status !== "held" &&
        Date.now() - heldAt < 15_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        heldPoll = await getJson(
          base,
          `/api/sessions/${sessionId}/shadow-jobs/${autoJobId}`,
        );
      }
      expect((heldPoll.body as { status: string }).status).toBe("held");
      expect((heldPoll.body as { holdReason: string }).holdReason).toBe(
        "aborted_foreground",
      );
      // The queued explicit job proceeds alone after the release: answer
      // every parked socket until it lands terminally (this also drains a
      // raced turn-2 extraction park, which stays serialized at max 1).
      const progressAt = Date.now();
      let progress: { status: number; body: unknown } = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs/${shadowJobId}`,
      );
      while (
        (progress.body as { status: string }).status !== "completed" &&
        Date.now() - progressAt < 30_000
      ) {
        for (const entry of [...model.state.parked]) {
          entry.respond();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        progress = await getJson(
          base,
          `/api/sessions/${sessionId}/shadow-jobs/${shadowJobId}`,
        );
      }
      expect((progress.body as { status: string }).status).toBe("completed");
      expect(model.state.max).toBe(1);
      // Release never auto-revived the held job: it stays held after the
      // queued unit completed behind it.
      const stillHeld = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs/${autoJobId}`,
      );
      expect((stillHeld.body as { status: string }).status).toBe("held");

      // Phase 3: with NO foreground chat anywhere, a parked extraction
      // socket aborts only on its OWN `timeoutMs` bound (I03-09: STOP never
      // aborts memory work) and lands no late memory write for that run.
      model.state.parkExtract = true;
      model.state.parkShadow = false;
      const third = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "Remember oolong too." },
      );
      expect(third.status).toBe(202);
      const turn3 = await waitForHistoryResult(base, sessionId, 3);
      await waitFor(
        () => model.state.parked.some((entry) => entry.kind === "extract"),
        15_000,
        "second extraction did not park",
      );
      const pausing = await getJson(base, "/api/autonomy/control");
      const stopped = await postJson(base, "/api/autonomy/control", {
        paused: true,
        expectedVersion: (pausing.body as { version: number }).version,
      });
      expect(stopped.status).toBe(200);
      await waitFor(
        () => model.state.aborted.includes("extract"),
        15_000,
        "parked extraction socket never reached its own timeoutMs bound",
      );
      for (const entry of [...model.state.parked]) {
        entry.respond();
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(queryOutboxKinds(dbPath, turn3.runId)).toHaveLength(0);

      // Foreground chat still works while STOPped.
      const fourth = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "Are you still answering?" },
      );
      expect(fourth.status).toBe(202);
      const turn4 = await waitForHistoryResult(base, sessionId, 4);
      expect(turn4.text).toContain("green tea");

      // Release never auto-revived the held job: the aborted auto job stays
      // held to the end (the explicit job completed normally in phase 2).
      const heldAgain = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs/${autoJobId}`,
      );
      expect((heldAgain.body as { status: string }).status).toBe("held");
      const explicitAgain = await getJson(
        base,
        `/api/sessions/${sessionId}/shadow-jobs/${shadowJobId}`,
      );
      expect((explicitAgain.body as { status: string }).status).toBe(
        "completed",
      );

      const resuming = await getJson(base, "/api/autonomy/control");
      const resumed = await postJson(base, "/api/autonomy/control", {
        paused: false,
        expectedVersion: (resuming.body as { version: number }).version,
      });
      expect(resumed.status).toBe(200);
    } finally {
      if (started !== null) {
        await started.shutdown("test-teardown").catch(() => undefined);
      }
      await model.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      rmSync(remindDir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 120_000);
});
