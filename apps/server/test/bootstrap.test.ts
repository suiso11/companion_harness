// Bootstrap tests: exact startup order + graceful shutdown over a real
// (loopback, ephemeral-port) listener with a temp file DB. Resources are
// always closed; no test leaves a listener or DB handle open.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_SCHEMA_VERSION, RunEngine } from "@companion/kernel";
import type {
  ChatRequest,
  FetchImpl,
  ModelGateway,
} from "@companion/model-local";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_STRATEGY_NAME,
  createModelGateway,
  type StartedServer,
  sanitizeStartupErrorStatus,
  startServer,
} from "../src/bootstrap.js";
import { createCollectingLogger } from "../src/logger.js";
import { STORE_SIZE_WARN_BYTES } from "../src/maintenance.js";

const servers: StartedServer[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.shutdown("test-teardown");
    }
  }
  for (const dir of tempDirs) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "companion-bootstrap-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "companion.sqlite");
  return {
    env: {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    },
    dir,
    dbPath,
  };
}

describe("bootstrap startup + graceful shutdown", () => {
  it("starts in order, serves exact health, and shuts down gracefully", async () => {
    const { env, dbPath } = tempEnv();
    const started = await startServer({ env, drainMs: 200 });
    servers.push(started);
    try {
      expect(started.config.host).toBe("127.0.0.1");
      expect(started.port).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${started.port}`;
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
        status: "live",
      });
      expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({
        status: "ready",
      });

      // Startup order left a versioned, migrated file DB behind.
      const probe = new Database(dbPath, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(
          BUNDLED_SCHEMA_VERSION,
        );
        const sessions = probe
          .prepare("SELECT COUNT(*) AS n FROM sessions")
          .get() as {
          n: number;
        };
        expect(sessions.n).toBe(0);
      } finally {
        probe.close();
      }

      // End-to-end mutation over HTTP with exact same-origin Origin
      // (undici emits Sec-Fetch metadata, so missing Origin is rejected).
      const created = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: base,
        },
        body: "{}",
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };

      // Draining: live stays 200, ready flips to exact 503, intake is refused.
      started.controls.markDraining();
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
        status: "live",
      });
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "not_ready",
        code: "server_shutting_down",
      });
      const late = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: base,
        },
        body: JSON.stringify({ text: "late" }),
      });
      expect(late.status).toBe(503);
      expect(late.headers.get("retry-after")).toBe("5");

      await started.shutdown("test");
      servers.pop();
      await expect(fetch(`${base}/health/live`)).rejects.toThrow();
      // Idempotent shutdown resolves again.
      await started.shutdown("test-again");
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("fails closed on a newer database version", async () => {
    const { env, dbPath } = tempEnv();
    const setup = new Database(dbPath);
    try {
      setup.exec("CREATE TABLE t (a TEXT) STRICT");
      setup.pragma("user_version = 99");
    } finally {
      setup.close();
    }
    await expect(startServer({ env, drainMs: 50 })).rejects.toThrow();
  });

  it("fails drain closed without closing DB/listener and permits retry", async () => {
    const { env } = tempEnv();
    const started = await startServer({ env, drainMs: 50 });
    servers.push(started);
    const base = `http://127.0.0.1:${started.port}`;
    const originalShutdown = started.engine.shutdown.bind(started.engine);
    let failOnce = true;
    started.engine.shutdown = async (options?: { drainMs?: number }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("drain boom");
      }
      return originalShutdown(options);
    };
    await expect(started.shutdown("test-drain-fail")).rejects.toThrow(
      "drain failed",
    );
    // Fail-closed: listener and DB still serve; ready stays not_ready.
    expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
      status: "live",
    });
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    // Retry succeeds and stops the server.
    await started.shutdown("test-drain-retry");
    servers.pop();
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });

  it("does not leak named signal handlers across start/shutdown", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const first = tempEnv();
    const a = await startServer({ env: first.env, drainMs: 50 });
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    await a.shutdown("test");
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    const second = tempEnv();
    const b = await startServer({ env: second.env, drainMs: 50 });
    servers.push(b);
    try {
      expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
      await b.shutdown("test");
      servers.pop();
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    } finally {
      const index = servers.indexOf(b);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("warns (only) above 1 GiB DB+WAL without logging the DB path", async () => {
    const { env, dbPath } = tempEnv();
    const over = createCollectingLogger("debug");
    const started = await startServer({
      env,
      drainMs: 50,
      logger: over.logger,
      stat: (path) =>
        path === dbPath ? { size: STORE_SIZE_WARN_BYTES } : { size: 1 },
    });
    servers.push(started);
    try {
      const warnings = over.records.filter(
        (record) => record.code === "server.store_size_warning",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.bytes).toBe(STORE_SIZE_WARN_BYTES + 1);
      expect(JSON.stringify(warnings[0])).not.toContain(dbPath);
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("stays silent at exactly 1 GiB and sanitizes shutdown/status logs", async () => {
    const { env } = tempEnv();
    const exact = createCollectingLogger("debug");
    const started = await startServer({
      env,
      drainMs: 50,
      logger: exact.logger,
      stat: () => ({ size: 512 * 1024 * 1024 }),
    });
    servers.push(started);
    try {
      // 512 MiB DB + 512 MiB WAL = exactly 1 GiB: no warning.
      expect(
        exact.records.filter(
          (record) => record.code === "server.store_size_warning",
        ),
      ).toHaveLength(0);
      await started.shutdown("evil reason; /etc/passwd");
      servers.pop();
      const stopped = exact.records.filter(
        (record) => record.code === "server.stopped",
      );
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.status).toBe("unknown");
      expect(JSON.stringify(stopped[0])).not.toContain("evil");
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("fails closed when the POSIX app-dir chmod fails (fixed safe error)", async () => {
    const { env, dbPath } = tempEnv();
    const failing = createCollectingLogger("debug");
    const failure = await startServer({
      env,
      drainMs: 50,
      logger: failing.logger,
      platform: "linux",
      chmod: () => {
        throw new Error("EACCES: permission denied");
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "database directory permissions failed",
    );
    expect((failure as Error).message).not.toContain(dbPath);
    const failed = failing.records.filter(
      (record) => record.code === "server.start_failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("server_config_invalid");
  });

  it("returns a null toolBroker when no markdown roots are configured", async () => {
    const { env } = tempEnv();
    const started = await startServer({ env, drainMs: 50 });
    servers.push(started);
    try {
      expect(started.toolBroker).toBeNull();
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("wires one M1 broker with four tools and a hashed connector row", async () => {
    const { env, dbPath } = tempEnv();
    const vault = mkdtempSync(join(tmpdir(), "companion-vault-"));
    tempDirs.push(vault);
    writeFileSync(join(vault, "note.md"), "# Note\n\nHello vault.\n");
    const configured = await startServer({
      env: {
        ...env,
        COMPANION_MARKDOWN_ROOTS_JSON: JSON.stringify([{ path: vault }]),
      },
      drainMs: 50,
    });
    servers.push(configured);
    try {
      expect(configured.toolBroker).not.toBeNull();
      expect([...(configured.toolBroker?.toolNames() ?? [])].sort()).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
      ]);
      const probe = new Database(dbPath, { readonly: true });
      try {
        const rows = probe
          .prepare(
            "SELECT id, kind, display_name, config_json FROM connector_instances",
          )
          .all() as {
          id: string;
          kind: string;
          display_name: string;
          config_json: string;
        }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe("markdown");
        const parsed = JSON.parse(rows[0]?.config_json ?? "{}") as {
          rootCount?: unknown;
          configFingerprint?: unknown;
        };
        expect(parsed.rootCount).toBe(1);
        expect(typeof parsed.configFingerprint).toBe("string");
        expect(parsed.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0]?.config_json).not.toContain("note.md");
      } finally {
        probe.close();
      }
      await configured.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(configured);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("fails before listen and closes safely on a bad or missing vault", async () => {
    const { env, dbPath } = tempEnv();
    const missing = join(
      mkdtempSync(join(tmpdir(), "companion-missing-")),
      "absent-vault",
    );
    const failing = createCollectingLogger("debug");
    const before = process.listenerCount("SIGINT");
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_MARKDOWN_ROOTS_JSON: JSON.stringify([{ path: missing }]),
        },
        drainMs: 50,
        logger: failing.logger,
      }),
    ).rejects.toThrow();
    expect(process.listenerCount("SIGINT")).toBe(before);
    const failed = failing.records.filter(
      (record) => record.code === "server.start_failed",
    );
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).not.toContain("absent-vault");
    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare("SELECT COUNT(*) AS n FROM connector_instances")
        .get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      probe.close();
    }
    mkdirSync(missing, { recursive: true });
    const retryLogger = createCollectingLogger("debug");
    const retryMissing = join(missing, "no-such-file.md");
    void retryMissing;
    const badEnv = {
      ...env,
      COMPANION_MARKDOWN_ROOTS_JSON: "not-json",
    };
    await expect(
      startServer({ env: badEnv, drainMs: 50, logger: retryLogger.logger }),
    ).rejects.toThrow();
    const invalidJsonFailed = retryLogger.records.filter(
      (record) => record.code === "server.start_failed",
    );
    // Invalid JSON config logs exactly once with the fixed sanitized
    // status and no paths/raw values.
    expect(invalidJsonFailed).toHaveLength(1);
    expect(invalidJsonFailed[0]?.status).toBe("server_config_invalid");
    expect(JSON.stringify(invalidJsonFailed[0])).not.toContain("not-json");
    expect(JSON.stringify(invalidJsonFailed[0])).not.toContain(dbPath);
    expect(JSON.stringify(retryLogger.records)).not.toContain("not-json");
  });

  it("rejects removal of bound Markdown roots with DB unchanged and restore succeeding", async () => {
    const { env, dbPath } = tempEnv();
    const vault = mkdtempSync(join(tmpdir(), "companion-bound-"));
    tempDirs.push(vault);
    writeFileSync(join(vault, "note.md"), "# Note\nbound body\n");
    const rootsJson = JSON.stringify([{ path: vault }]);
    const first = await startServer({
      env: { ...env, COMPANION_MARKDOWN_ROOTS_JSON: rootsJson },
      drainMs: 50,
    });
    servers.push(first);
    expect(first.toolBroker).not.toBeNull();
    await first.shutdown("test");
    servers.pop();
    // Empty roots after migration with a bound markdown instance fails
    // before engine/listen with a fixed path-free ServerConfigError.
    const failing = createCollectingLogger("debug");
    const before = process.listenerCount("SIGINT");
    const failure = await startServer({
      env,
      drainMs: 50,
      logger: failing.logger,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ServerConfigError");
    expect((failure as Error).message).toBe(
      "markdown roots must not be removed while bound",
    );
    expect((failure as Error).message).not.toContain(vault);
    expect((failure as Error).message).not.toContain(dbPath);
    expect(process.listenerCount("SIGINT")).toBe(before);
    const failed = failing.records.filter(
      (record) => record.code === "server.start_failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("server_config_invalid");
    expect(JSON.stringify(failed[0])).not.toContain(vault);
    expect(JSON.stringify(failed[0])).not.toContain(dbPath);
    // DB unchanged: the single bound markdown row survives the rejection.
    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare("SELECT kind FROM connector_instances WHERE kind = 'markdown'")
        .all() as { kind: string }[];
      expect(rows).toHaveLength(1);
    } finally {
      probe.close();
    }
    // Exact roots restore succeeds on the same DB.
    const restored = await startServer({
      env: { ...env, COMPANION_MARKDOWN_ROOTS_JSON: rootsJson },
      drainMs: 50,
    });
    servers.push(restored);
    try {
      expect(restored.toolBroker).not.toBeNull();
      await restored.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(restored);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("logs early config failure once via the safe default logger", async () => {
    const { env } = tempEnv();
    // No injected logger: the safe default (process stderr) still emits
    // exactly the sanitized failure without throwing a second error.
    await expect(
      startServer({
        env: { ...env, COMPANION_MARKDOWN_ROOTS_JSON: "not-json" },
        drainMs: 50,
      }),
    ).rejects.toThrow();
  });

  it("logs each startup failure exactly once with fixed safe fields", async () => {
    const countStderrStartFailed = (lines: string[]): number =>
      lines.filter((line) => line.includes("server.start_failed")).length;
    const originalWrite = process.stderr.write.bind(process.stderr);

    // Early failure: invalid config with an injected logger stays in the
    // logger (exactly once) and never duplicates on stderr.
    {
      const { env } = tempEnv();
      const collecting = createCollectingLogger("debug");
      const lines: string[] = [];
      (
        process.stderr as unknown as { write: (...args: never[]) => boolean }
      ).write = ((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as (...args: never[]) => boolean;
      try {
        await expect(
          startServer({
            env: { ...env, COMPANION_MARKDOWN_ROOTS_JSON: "not-json" },
            drainMs: 50,
            logger: collecting.logger,
          }),
        ).rejects.toThrow();
      } finally {
        process.stderr.write = originalWrite as typeof process.stderr.write;
      }
      const failed = collecting.records.filter(
        (record) => record.code === "server.start_failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("server_config_invalid");
      expect(countStderrStartFailed(lines)).toBe(0);
      expect(JSON.stringify(failed[0])).not.toContain("not-json");
      expect(JSON.stringify(collecting.records)).not.toContain("not-json");
    }

    // Late failure: post-config chmod failure with an injected logger also
    // logs exactly once with fixed safe fields and no stderr duplicate.
    {
      const { env, dbPath } = tempEnv();
      const collecting = createCollectingLogger("debug");
      const lines: string[] = [];
      (
        process.stderr as unknown as { write: (...args: never[]) => boolean }
      ).write = ((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as (...args: never[]) => boolean;
      try {
        await expect(
          startServer({
            env,
            drainMs: 50,
            logger: collecting.logger,
            platform: "linux",
            chmod: () => {
              throw new Error("EACCES: permission denied");
            },
          }),
        ).rejects.toThrow("database directory permissions failed");
      } finally {
        process.stderr.write = originalWrite as typeof process.stderr.write;
      }
      const failed = collecting.records.filter(
        (record) => record.code === "server.start_failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("server_config_invalid");
      expect(countStderrStartFailed(lines)).toBe(0);
      expect(JSON.stringify(failed[0])).not.toContain(dbPath);
    }
  });

  it("maps unknown startup codes to unknown (closed vocabulary)", async () => {
    expect(
      sanitizeStartupErrorStatus(
        Object.assign(new Error("boom"), { code: "injected_code" }),
      ),
    ).toBe("unknown");
    expect(
      sanitizeStartupErrorStatus(
        Object.assign(new Error("boom"), { code: "EVIL-CODE!" }),
      ),
    ).toBe("unknown");
    expect(
      sanitizeStartupErrorStatus(
        Object.assign(new Error("bad config"), {
          code: "server_config_invalid",
        }),
      ),
    ).toBe("server_config_invalid");
    expect(sanitizeStartupErrorStatus(new Error("plain boom"))).toBe("unknown");
  });
});

describe("bootstrap M2 model wiring", () => {
  const MODEL_NAME = "test-model";
  const MODEL_BASE = "http://127.0.0.1:11434";

  function modelEnv(
    env: NodeJS.ProcessEnv,
    adapter = "ollama",
  ): NodeJS.ProcessEnv {
    return {
      ...env,
      COMPANION_MODEL_JSON: JSON.stringify({
        adapter,
        baseUrl: MODEL_BASE,
        model: MODEL_NAME,
      }),
    };
  }

  function mockModelGateway(): ModelGateway {
    return {
      provider: "ollama",
      capabilities: { toolCalling: true },
      baseUrl: MODEL_BASE,
      chatUrl: `${MODEL_BASE}/api/chat`,
      chat: async () => ({ text: "mock", toolCalls: [], stopReason: "stop" }),
    };
  }

  function strategiesOf(server: StartedServer): RunEngine["strategies"] {
    return (server.engine as unknown as RunEngine).strategies;
  }

  it("registers no strategy without model config (fail-closed)", async () => {
    const { env } = tempEnv();
    const started = await startServer({ env, drainMs: 50 });
    servers.push(started);
    try {
      expect(started.toolBroker).toBeNull();
      expect(strategiesOf(started).has(AGENT_STRATEGY_NAME)).toBe(false);
      expect(strategiesOf(started).names()).toEqual([]);
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("constructs both adapters without network (mock fetch)", async () => {
    const request: ChatRequest = {
      model: MODEL_NAME,
      messages: [{ role: "user", content: "hi" }],
    };
    const ollamaFetch: FetchImpl = async () =>
      new Response(
        JSON.stringify({
          message: { content: "hello" },
          done_reason: "stop",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    const ollama = createModelGateway(
      { adapter: "ollama", baseUrl: MODEL_BASE, model: MODEL_NAME },
      ollamaFetch,
    );
    expect(ollama.provider).toBe("ollama");
    expect(ollama.baseUrl).toBe(MODEL_BASE);
    expect(ollama.chatUrl).toBe(`${MODEL_BASE}/api/chat`);
    expect((await ollama.chat(request)).text).toBe("hello");

    const openaiFetch: FetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    const openai = createModelGateway(
      {
        adapter: "openai-compatible",
        baseUrl: MODEL_BASE,
        model: MODEL_NAME,
      },
      openaiFetch,
    );
    expect(openai.provider).toBe("openai-compatible");
    expect(openai.chatUrl).toBe(`${MODEL_BASE}/v1/chat/completions`);
    expect((await openai.chat(request)).text).toBe("hello");
  });

  it("registers the agent with a mocked gateway and null toolBroker when no roots", async () => {
    const { env } = tempEnv();
    const started = await startServer({
      env: modelEnv(env),
      drainMs: 50,
      modelGateway: mockModelGateway(),
    });
    servers.push(started);
    try {
      expect(started.toolBroker).toBeNull();
      expect(strategiesOf(started).has(AGENT_STRATEGY_NAME)).toBe(true);
      // The listener still serves health: registration preceded listen.
      const base = `http://127.0.0.1:${started.port}`;
      expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({
        status: "ready",
      });
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("builds the production gateway from config when only fetch is injected", async () => {
    const { env } = tempEnv();
    const fetchImpl: FetchImpl = async () =>
      new Response(
        JSON.stringify({
          message: { content: "hi" },
          done_reason: "stop",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    const started = await startServer({
      env: modelEnv(env),
      drainMs: 50,
      modelFetch: fetchImpl,
    });
    servers.push(started);
    try {
      expect(started.toolBroker).toBeNull();
      expect(strategiesOf(started).has(AGENT_STRATEGY_NAME)).toBe(true);
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("reuses the M1 broker when roots are configured", async () => {
    const { env } = tempEnv();
    const vault = mkdtempSync(join(tmpdir(), "companion-m2-vault-"));
    tempDirs.push(vault);
    writeFileSync(join(vault, "note.md"), "# Note\n\nHello vault.\n");
    const started = await startServer({
      env: {
        ...modelEnv(env, "openai-compatible"),
        COMPANION_MARKDOWN_ROOTS_JSON: JSON.stringify([{ path: vault }]),
      },
      drainMs: 50,
      modelGateway: mockModelGateway(),
    });
    servers.push(started);
    try {
      expect(started.toolBroker).not.toBeNull();
      expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
      ]);
      expect(strategiesOf(started).has(AGENT_STRATEGY_NAME)).toBe(true);
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("registers the agent before engine.start and listen (startup ordering)", async () => {
    const { env } = tempEnv();
    const seen: boolean[] = [];
    const originalStart = RunEngine.prototype.start;
    RunEngine.prototype.start = function (this: RunEngine) {
      seen.push(this.strategies.has(AGENT_STRATEGY_NAME));
      return originalStart.call(this);
    };
    try {
      const started = await startServer({
        env: modelEnv(env),
        drainMs: 50,
        modelGateway: mockModelGateway(),
      });
      servers.push(started);
      try {
        // Registration preceded engine.start (recovery) and the listener
        // below only resolves after registration + start completed.
        expect(seen).toEqual([true]);
        const base = `http://127.0.0.1:${started.port}`;
        expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
          status: "live",
        });
        await started.shutdown("test");
        servers.pop();
      } finally {
        const index = servers.indexOf(started);
        if (index >= 0) {
          servers.splice(index, 1);
        }
      }
    } finally {
      RunEngine.prototype.start = originalStart;
    }
  });

  it("never logs model config or secrets", async () => {
    const { env } = tempEnv();
    const secret = "sk-m2-test-secret-xyz";
    const collecting = createCollectingLogger("debug");
    const started = await startServer({
      env: {
        ...env,
        COMPANION_MODEL_JSON: JSON.stringify({
          adapter: "ollama",
          baseUrl: "http://127.0.0.1:11439",
          model: "super-secret-model-name",
          apiKey: secret,
        }),
      },
      drainMs: 50,
      logger: collecting.logger,
      modelGateway: mockModelGateway(),
    });
    servers.push(started);
    try {
      const dumped = JSON.stringify(collecting.records);
      expect(dumped).not.toContain(secret);
      expect(dumped).not.toContain("super-secret-model-name");
      expect(dumped).not.toContain("11439");
      expect(
        collecting.records.filter(
          (record) => record.code === "server.model_ready",
        ),
      ).toHaveLength(1);
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });
});
