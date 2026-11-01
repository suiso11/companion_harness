// POST /api/transcribe: one captured utterance in, one normalized transcript
// out.
//
// Real Hono app + real config parsing, with a loopback fake whisper.cpp
// server. Proves: config-gated 404, the strict base64/WAV envelope (an
// arbitrary blob never reaches the engine), the exact multipart call shape
// (language, json response, operator bias prompt, WAV file), transcript
// normalization of engine artifacts, and a fixed 502 for engine failures.

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
import { normalizeTranscript } from "../src/asr.js";
import { loadServerConfig, parseAsrConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

const T0 = 1_790_000_000_000;

const WAV_BYTES = (() => {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(40, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(4, 40);
  return buffer;
})();

type EngineMode = "ok" | "fail" | "not-json" | "no-text";

interface UpstreamHit {
  readonly path: string;
  readonly body: string;
}

interface Upstream {
  readonly server: Server;
  readonly baseUrl: string;
  readonly hits: UpstreamHit[];
  setMode(mode: EngineMode): void;
  setText(text: string): void;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startUpstream(): Promise<Upstream> {
  const hits: UpstreamHit[] = [];
  let mode: EngineMode = "ok";
  let text = "こんにちはどす。";
  const server = createServer((request, response) => {
    void (async () => {
      hits.push({ path: request.url ?? "/", body: await readBody(request) });
      if (mode === "fail") {
        response.statusCode = 500;
        response.end("engine down");
        return;
      }
      response.setHeader("content-type", "application/json");
      if (mode === "not-json") {
        response.end("null");
        return;
      }
      response.end(JSON.stringify(mode === "no-text" ? {} : { text }));
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
    setMode: (next: EngineMode) => {
      mode = next;
    },
    setText: (next: string) => {
      text = next;
    },
  };
}

interface Fixture {
  readonly app: CreatedServerApp["app"];
  readonly upstream: Upstream;
  close(): void;
}

async function makeFixture(options: { asr?: boolean } = {}): Promise<Fixture> {
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
    ...(options.asr === false
      ? {}
      : {
          COMPANION_ASR_JSON: JSON.stringify({
            url: upstream.baseUrl,
            prompt: "春琴抄、京ことば、引用",
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
    upstream,
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

async function postTranscribe(
  fixture: Fixture,
  body: unknown,
): Promise<Response> {
  return fixture.app.request("/api/transcribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/transcribe", () => {
  it("is a fixed 404 while the ASR config is unset", async () => {
    const fixture = await makeFixture({ asr: false });
    cleanups.push(() => fixture.close());
    const response = await postTranscribe(fixture, {
      audioBase64: WAV_BYTES.toString("base64"),
    });
    expect(response.status).toBe(404);
    expect(fixture.upstream.hits).toHaveLength(0);
  });

  it("forwards the utterance with the operator bias and returns the transcript", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const response = await postTranscribe(fixture, {
      audioBase64: WAV_BYTES.toString("base64"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "こんにちはどす" });
    const hit = fixture.upstream.hits[0];
    expect(hit?.path).toBe("/inference");
    const body = hit?.body ?? "";
    expect(body).toContain('name="language"');
    expect(body).toContain("ja");
    expect(body).toContain('name="response_format"');
    expect(body).toContain("json");
    expect(body).toContain('name="prompt"');
    expect(body).toContain("春琴抄、京ことば、引用");
    expect(body).toContain('name="file"; filename="utterance.wav"');
    expect(body).toContain("RIFF");
    expect(body).toContain("WAVE");
  });

  it("turns engine artifacts and silence into an empty transcript", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    fixture.upstream.setText("[BLANK_AUDIO] ご視聴ありがとうございました。");
    const response = await postTranscribe(fixture, {
      audioBase64: WAV_BYTES.toString("base64"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "" });
  });

  it("rejects non-canonical base64 and non-WAV bytes before calling the engine", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    for (const body of [
      {},
      { audioBase64: "not base64!" },
      { audioBase64: Buffer.from("hello world, not a wav").toString("base64") },
      { audioBase64: WAV_BYTES.toString("base64"), extra: true },
    ]) {
      const response = await postTranscribe(fixture, body);
      expect(response.status).toBe(400);
    }
    expect(fixture.upstream.hits).toHaveLength(0);
  });

  it("returns a fixed 502 for engine failures and unusable responses", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    for (const mode of ["fail", "not-json", "no-text"] as const) {
      fixture.upstream.setMode(mode);
      const response = await postTranscribe(fixture, {
        audioBase64: WAV_BYTES.toString("base64"),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "internal_error",
          message: "speech recognition failed",
        },
      });
    }
  });
});

describe("normalizeTranscript", () => {
  it("removes engine annotations, collapses whitespace, and applies NFKC", () => {
    expect(normalizeTranscript("  [音楽]  ｺﾝﾆﾁﾊ どす。\n")).toBe(
      "コンニチハ どす",
    );
    expect(normalizeTranscript("。。。")).toBe("");
    expect(normalizeTranscript("チャンネル登録お願いします")).toBe("");
  });

  it("keeps real speech, including parentheticals and numbers", () => {
    expect(normalizeTranscript("明日は10時に会いましょ（笑）")).toBe(
      "明日は10時に会いましょ(笑)",
    );
  });
});

describe("parseAsrConfig", () => {
  it("normalizes a loopback engine url and applies defaults", () => {
    expect(
      parseAsrConfig(JSON.stringify({ url: "http://localhost:8080/" })),
    ).toEqual({
      url: "http://127.0.0.1:8080",
      prompt: null,
      timeoutMs: 20_000,
    });
    expect(parseAsrConfig(undefined)).toBeNull();
  });

  it("fails closed on non-loopback urls, unknown keys, and bad prompts", () => {
    for (const raw of [
      JSON.stringify({ url: "http://example.com" }),
      JSON.stringify({ url: "http://127.0.0.1:8080", x: 1 }),
      JSON.stringify({ url: "http://127.0.0.1:8080", prompt: "" }),
      JSON.stringify({
        url: "http://127.0.0.1:8080",
        prompt: "あ".repeat(501),
      }),
      "{",
    ]) {
      expect(() => parseAsrConfig(raw)).toThrow();
    }
  });
});
