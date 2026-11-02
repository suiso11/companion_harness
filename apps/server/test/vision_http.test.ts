// POST /api/vision: one JPEG + question in, one description out.
//
// Real Hono app + real config parsing, with a loopback fake OpenAI-compatible
// upstream recording each request.

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig, parseVisionConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

const T0 = 1_790_000_000_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG_B64 = JPEG.toString("base64");

type Mode = "ok" | "fail" | "empty" | "hang" | "redirect";

interface Fixture {
  readonly app: CreatedServerApp["app"];
  readonly hits: string[];
  setMode(mode: Mode): void;
  setRedirect(url: string): void;
  close(): void;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function makeFixture(
  options: { vision?: boolean; prompt?: string } = {},
): Promise<Fixture> {
  const hits: string[] = [];
  let mode: Mode = "ok";
  let redirectTo = "http://127.0.0.1:1/";
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      hits.push(`${request.url}\n${body}`);
      if (mode === "hang") {
        return;
      }
      if (mode === "fail") {
        response.statusCode = 500;
        response.end("down");
        return;
      }
      if (mode === "redirect") {
        response.statusCode = 307;
        response.setHeader("location", redirectTo);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { content: mode === "empty" ? "  " : " 猫がいます。 " },
            },
          ],
        }),
      );
    });
  });
  server.on("connection", (socket) => sockets.add(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: ":memory:",
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
    ...(options.vision === false
      ? {}
      : {
          COMPANION_VISION_JSON: JSON.stringify({
            url: baseUrl,
            model: "vlm-test",
            timeoutMs: 1_000,
            ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
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
    hits,
    setMode: (next) => {
      mode = next;
    },
    setRedirect: (url) => {
      redirectTo = url;
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
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

async function postVision(
  fixture: Fixture,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fixture.app.request("/api/vision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/vision", () => {
  it("is a fixed 404 while the vision config is unset", async () => {
    const fixture = await makeFixture({ vision: false });
    cleanups.push(() => fixture.close());
    const response = await postVision(fixture, { imageBase64: JPEG_B64 });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      JSON.stringify({
        error: { code: "not_found", message: "resource not found" },
      }),
    );
  });

  it("forwards the data URL, model and question upstream", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const response = await postVision(fixture, {
      imageBase64: JPEG_B64,
      question: "何が写っている？",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, text: "猫がいます。" });
    expect(fixture.hits).toHaveLength(1);
    const [path, body] = (fixture.hits[0] as string).split("\n");
    expect(path).toBe("/v1/chat/completions");
    const sent = JSON.parse(body as string);
    expect(sent.model).toBe("vlm-test");
    expect(sent.max_tokens).toBeLessThanOrEqual(1024);
    expect(sent.messages[0].content).toEqual([
      { type: "text", text: "何が写っている？" },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
      },
    ]);
  });

  it("falls back to the configured prompt, then a Japanese default", async () => {
    for (const [prompt, expected] of [
      ["短く説明", "短く説明"],
      [
        undefined,
        "この画像に何が写っているかを、簡潔な日本語で説明してください。",
      ],
    ] as const) {
      const fixture = await makeFixture(prompt === undefined ? {} : { prompt });
      cleanups.push(() => fixture.close());
      await postVision(fixture, { imageBase64: JPEG_B64 });
      const sent = JSON.parse((fixture.hits[0] as string).split("\n")[1] ?? "");
      expect(sent.messages[0].content[0].text).toBe(expected);
    }
  });

  it("returns a fixed 502 for upstream 500, empty content and timeout", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    for (const mode of ["fail", "empty", "hang"] as const) {
      fixture.setMode(mode);
      const response = await postVision(fixture, { imageBase64: JPEG_B64 });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "internal_error",
          message: "vision recognition failed",
        },
      });
    }
  });

  it("does not follow a redirect with the image", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const leaked = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("leaked");
    });
    leaked.listen(0, "127.0.0.1");
    await once(leaked, "listening");
    cleanups.push(() => leaked.close());
    fixture.setRedirect(
      `http://127.0.0.1:${(leaked.address() as AddressInfo).port}/collect`,
    );
    fixture.setMode("redirect");
    let hits = 0;
    leaked.on("request", () => {
      hits += 1;
    });
    const response = await postVision(fixture, { imageBase64: JPEG_B64 });
    expect(response.status).toBe(502);
    expect(hits).toBe(0);
  });

  it("rejects bad bodies without calling upstream", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const notJpeg = Buffer.from("not a jpeg at all!!").toString("base64");
    for (const body of [
      {},
      { imageBase64: "!!!notbase64!!!" },
      { imageBase64: notJpeg },
      { imageBase64: JPEG_B64, question: "" },
      { imageBase64: JPEG_B64, extra: 1 },
      { imageBase64: "A".repeat(3_800_001) },
      { imageBase64: Buffer.alloc(2_800_100, 0xff).toString("base64") },
    ]) {
      const response = await postVision(fixture, body);
      expect(response.status).toBe(400);
    }
    expect(fixture.hits).toHaveLength(0);
  });

  it("rejects an unrelated host and non-JSON bodies", async () => {
    const fixture = await makeFixture();
    cleanups.push(() => fixture.close());
    const wrongHost = await postVision(
      fixture,
      { imageBase64: JPEG_B64 },
      { host: "evil.example" },
    );
    expect(wrongHost.status).toBeGreaterThanOrEqual(400);
    const wrongType = await fixture.app.request("/api/vision", {
      method: "POST",
      headers: { "content-type": "image/jpeg", host: "127.0.0.1" },
      body: "x",
    });
    expect(wrongType.status).toBe(400);
    expect(fixture.hits).toHaveLength(0);
  });
});

describe("parseVisionConfig", () => {
  it("normalizes a loopback url and applies defaults", () => {
    expect(
      parseVisionConfig(
        JSON.stringify({ url: "http://localhost:8081/", model: "m" }),
      ),
    ).toEqual({
      url: "http://127.0.0.1:8081",
      model: "m",
      prompt: null,
      timeoutMs: 60_000,
    });
    expect(parseVisionConfig(undefined)).toBeNull();
  });

  it("fails closed on bad urls, keys, and bounds", () => {
    const ok = { url: "http://127.0.0.1:8081", model: "m" };
    for (const raw of [
      JSON.stringify({ ...ok, url: "http://example.com" }),
      JSON.stringify({ ...ok, x: 1 }),
      JSON.stringify({ url: ok.url }),
      JSON.stringify({ ...ok, model: "" }),
      JSON.stringify({ ...ok, prompt: "" }),
      JSON.stringify({ ...ok, timeoutMs: 999 }),
      JSON.stringify({ ...ok, timeoutMs: 120_001 }),
      "{",
    ]) {
      expect(() => parseVisionConfig(raw)).toThrow();
    }
  });
});
