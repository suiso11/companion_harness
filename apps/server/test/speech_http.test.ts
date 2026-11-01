// POST /api/speech: one finished answer in, one WAV out.
//
// Real Hono app + real config parsing, with a loopback fake VOICEVOX engine
// (audio_query → synthesis). Proves: config-gated 404, the existing JSON-only
// mutation gate, strict body validation and the total text bound, the exact
// upstream call shape (joined parts, speaker id, query passthrough), and that
// every engine failure becomes a fixed 502 instead of touching the answer.

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig, parseTtsConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

const T0 = 1_790_000_000_000;

interface UpstreamHit {
  readonly path: string;
  readonly search: string;
  readonly body: string;
}

type UpstreamMode = "ok" | "fail" | "garbage";

interface Fixture {
  readonly app: CreatedServerApp["app"];
  readonly hits: UpstreamHit[];
  readonly baseUrl: string;
  setMode(mode: UpstreamMode): void;
  close(): void;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startUpstream(): Promise<{
  server: Server;
  baseUrl: string;
  hits: UpstreamHit[];
  setMode: (mode: UpstreamMode) => void;
}> {
  const hits: UpstreamHit[] = [];
  let mode: UpstreamMode = "ok";
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.push({ path: url.pathname, search: url.search, body });
      if (mode === "fail") {
        response.statusCode = 500;
        response.end("engine down");
        return;
      }
      if (mode === "garbage") {
        response.setHeader("content-type", "application/json");
        response.end("null");
        return;
      }
      if (url.pathname === "/audio_query") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ kana: url.searchParams.get("text") ?? "" }),
        );
        return;
      }
      if (url.pathname === "/synthesis") {
        response.setHeader("content-type", "audio/wav");
        response.end(Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]));
        return;
      }
      response.statusCode = 404;
      response.end();
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    setMode: (next: UpstreamMode) => {
      mode = next;
    },
  };
}

async function makeFixture(options: { tts?: boolean } = {}): Promise<Fixture> {
  const upstream = await startUpstream();
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: ":memory:",
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
    ...(options.tts === false
      ? {}
      : {
          COMPANION_TTS_JSON: JSON.stringify({
            url: upstream.baseUrl,
            speaker: 8,
            timeoutMs: 1_000,
          }),
        }),
  });
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const { app } = createApp({
    config,
    repo,
    engine,
    logger: createCollectingLogger("debug").logger,
    now: () => T0,
  });
  return {
    app,
    hits: upstream.hits,
    baseUrl: upstream.baseUrl,
    setMode: upstream.setMode,
    close() {
      upstream.server.close();
      closeKernelDatabase(handle);
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    (cleanups.pop() as () => void)();
  }
});

async function postSpeech(
  fixture: Fixture,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fixture.app.request("/api/speech", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/speech", () => {
  it("is a fixed 404 while the TTS config is unset", async () => {
    const fixture = await makeFixture({ tts: false });
    cleanups.push(() => fixture.close());
    const response = await postSpeech(fixture, {
      parts: [{ text: "こんにちは" }],
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      JSON.stringify({
        error: { code: "not_found", message: "resource not found" },
      }),
    );
  });

  it("synthesizes the joined parts in one engine round-trip", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const response = await postSpeech(fixture, {
      parts: [{ text: "こんにちはどす。" }, { text: "今日は晴れどす。" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer,
    );
    expect(fixture.hits.map((hit) => hit.path)).toEqual([
      "/audio_query",
      "/synthesis",
    ]);
    const query = new URLSearchParams(fixture.hits[0]?.search ?? "");
    expect(query.get("speaker")).toBe("8");
    expect(query.get("text")).toBe("こんにちはどす。\n今日は晴れどす。");
    expect(JSON.parse(fixture.hits[1]?.body ?? "")).toEqual({
      kana: "こんにちはどす。\n今日は晴れどす。",
    });
  });

  it("rejects blank, oversized, and malformed bodies without calling the engine", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    for (const body of [
      {},
      { parts: [] },
      { parts: [{ text: "" }] },
      { parts: [{ text: "x".repeat(2_001) }] },
      { parts: [{ text: "こんにちは" }], extra: true },
    ]) {
      const response = await postSpeech(fixture, body);
      expect(response.status).toBe(400);
    }
    expect(fixture.hits).toHaveLength(0);
  });

  it("stays JSON-only through the shared mutation gate", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const response = await fixture.app.request("/api/speech", {
      method: "POST",
      headers: { "content-type": "audio/wav", host: "127.0.0.1" },
      body: "x",
    });
    expect(response.status).toBe(400);
    expect(fixture.hits).toHaveLength(0);
  });

  it("returns a fixed 502 for engine failures and garbage queries", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    for (const mode of ["fail", "garbage"] as const) {
      fixture.setMode(mode);
      const response = await postSpeech(fixture, {
        parts: [{ text: "こんにちはどす。" }],
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "internal_error",
          message: "speech synthesis failed",
        },
      });
    }
  });
});

describe("parseTtsConfig", () => {
  it("normalizes a loopback engine url and applies defaults", () => {
    expect(
      parseTtsConfig(
        JSON.stringify({ url: "http://localhost:50021/", speaker: 0 }),
      ),
    ).toEqual({
      // model-local canonicalizes localhost to the loopback literal.
      url: "http://127.0.0.1:50021",
      speaker: 0,
      timeoutMs: 20_000,
    });
    expect(parseTtsConfig(undefined)).toBeNull();
  });

  it("fails closed on non-loopback urls, unknown keys, and bad bounds", () => {
    for (const raw of [
      JSON.stringify({ url: "http://example.com", speaker: 0 }),
      JSON.stringify({ url: "http://127.0.0.1:50021", speaker: 0, x: 1 }),
      JSON.stringify({ url: "http://127.0.0.1:50021", speaker: -1 }),
      JSON.stringify({
        url: "http://127.0.0.1:50021",
        speaker: 0,
        timeoutMs: 999,
      }),
      "{",
    ]) {
      expect(() => parseTtsConfig(raw)).toThrow();
    }
  });
});
