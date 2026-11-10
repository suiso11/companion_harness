// Provider key settings routes: real Hono app, real migrated kernel DB, real
// persona chat service, key store backed by a temp file.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonaChatStore } from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createCollectingLogger } from "../src/logger.js";
import { createPersonaChatService } from "../src/persona_chat_service.js";
import { createProviderKeyStore } from "../src/provider_keys.js";
import { createServerFixtureContext } from "./server_fixture.js";

const KEY = "sk-secret-test-key-123";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
});

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

interface Fixture {
  readonly file: string;
  request(
    path: string,
    method?: string,
    body?: unknown,
    origin?: string,
  ): Promise<Response>;
}

async function makeFixture(
  options: { providerKeys?: boolean } = {},
): Promise<Fixture> {
  const { handle, repo, config, engine } =
    await createServerFixtureContext(cleanups);
  const dir = mkdtempSync(join(tmpdir(), "provider-keys-http-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "provider-keys.json");
  const providerKeys = createProviderKeyStore({
    filePath: file,
    env: { openai: null, deepseek: null, opencode: null },
  });
  const store = createPersonaChatStore({ db: handle.raw });
  const service = createPersonaChatService({
    store,
    keys: providerKeys.keys,
    now: Date.now,
    createGateway: () => ({
      chat: async () => ({ text: "x", usage: null }),
    }),
  });
  const { app } = createApp({
    config,
    repo,
    engine,
    logger: createCollectingLogger("debug").logger,
    now: Date.now,
    personaChat: { store, service },
    ...(options.providerKeys === false ? {} : { providerKeys }),
  });
  return {
    file,
    request: async (
      path,
      method = "GET",
      body,
      origin = "http://127.0.0.1:3000",
    ) =>
      app.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

const availability = async (f: Fixture, id: string): Promise<boolean> => {
  const list = (await (await f.request("/api/providers")).json()) as Json;
  return list.providers.find((p: Json) => p.id === id).available;
};

describe("provider key routes", () => {
  it("lists opencode as unavailable initially", async () => {
    const f = await makeFixture();
    const res = await f.request("/api/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.providers.map((p: Json) => p.id)).toContain("opencode");
    expect(await availability(f, "opencode")).toBe(false);
  });

  it("saves a key without echoing it, then clears it", async () => {
    const f = await makeFixture();
    const saved = await f.request("/api/providers/opencode/key", "POST", {
      apiKey: KEY,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, available: true });
    expect(await availability(f, "opencode")).toBe(true);
    expect(await (await f.request("/api/providers")).text()).not.toContain(KEY);
    if (process.platform !== "win32") {
      expect(statSync(f.file).mode & 0o777).toBe(0o600);
    }

    const cleared = await f.request("/api/providers/opencode/key", "POST", {
      apiKey: "",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, available: false });
    expect(await availability(f, "opencode")).toBe(false);
  });

  it("rejects an invalid key and an unknown provider", async () => {
    const f = await makeFixture();
    const bad = await f.request("/api/providers/openai/key", "POST", {
      apiKey: "bad key",
    });
    expect(bad.status).toBe(400);
    const unknown = await f.request("/api/providers/nope/key", "POST", {
      apiKey: KEY,
    });
    expect(unknown.status).toBe(400);
    const local = await f.request("/api/providers/local/key", "POST", {
      apiKey: KEY,
    });
    expect(local.status).toBe(400);
  });

  it("rejects a cross-origin POST and does not store the key", async () => {
    const f = await makeFixture();
    const res = await f.request(
      "/api/providers/openai/key",
      "POST",
      { apiKey: KEY },
      "http://evil.test",
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await availability(f, "openai")).toBe(false);
  });

  it("404s when providerKeys is absent", async () => {
    const f = await makeFixture({ providerKeys: false });
    expect((await f.request("/api/providers")).status).toBe(404);
    expect(
      (await f.request("/api/providers/openai/key", "POST", { apiKey: KEY }))
        .status,
    ).toBe(404);
  });
});
