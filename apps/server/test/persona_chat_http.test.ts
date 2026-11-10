// Persona chat HTTP routes: real Hono app, real migrated kernel DB, real
// persona chat store + service, fake provider gateway (the createGateway seam).

import { randomUUID } from "node:crypto";
import { createPersonaChatStore } from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createCollectingLogger } from "../src/logger.js";
import { createPersonaChatService } from "../src/persona_chat_service.js";
import { createServerFixtureContext } from "./server_fixture.js";

const T0 = 1_790_000_000_000;

const PERSONA = {
  name: "Haruko",
  avatar: "🌸",
  provider: "openai",
  model: "gpt-4.1-mini",
  systemPrompt: "You are Haruko.",
} as const;

interface Fixture {
  request(path: string, method?: string, body?: unknown): Promise<Response>;
  readonly gatewayCalls: number[];
  setGatewayFails(fails: boolean): void;
}

async function makeFixture(
  options: {
    personaChat?: boolean;
    keys?: {
      openai: string | null;
      deepseek: string | null;
      opencode: string | null;
    };
  } = {},
): Promise<Fixture> {
  const { handle, repo, config, engine } =
    await createServerFixtureContext(cleanups);
  let clock = T0;
  const now = () => ++clock;
  const store = createPersonaChatStore({ db: handle.raw });
  const gatewayCalls: number[] = [];
  let fails = false;
  const service = createPersonaChatService({
    store,
    keys: options.keys ?? { openai: "sk-test", deepseek: null, opencode: null },
    now,
    createGateway: () => ({
      chat: async () => {
        gatewayCalls.push(1);
        if (fails) throw new Error("boom");
        return { text: `reply ${gatewayCalls.length}`, usage: null };
      },
    }),
  });
  const { app } = createApp({
    config,
    repo,
    engine,
    logger: createCollectingLogger("debug").logger,
    now,
    ...(options.personaChat === false
      ? {}
      : { personaChat: { store, service } }),
  });
  return {
    gatewayCalls,
    setGatewayFails: (next) => {
      fails = next;
    },
    request: async (path, method = "GET", body) =>
      app.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
});

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

async function createPersona(f: Fixture, over: object = {}): Promise<Json> {
  const res = await f.request("/api/personas", "POST", { ...PERSONA, ...over });
  expect(res.status).toBe(201);
  return res.json();
}

async function createChat(f: Fixture, personaId: string): Promise<Json> {
  const res = await f.request("/api/chats", "POST", { personaId });
  expect(res.status).toBe(201);
  return res.json();
}

describe("persona chat routes", () => {
  it("404s every route when personaChat is absent", async () => {
    const f = await makeFixture({ personaChat: false });
    expect((await f.request("/api/personas")).status).toBe(404);
    expect((await f.request("/api/chats")).status).toBe(404);
  });

  it("persona CRUD", async () => {
    const f = await makeFixture();
    const created = await createPersona(f);
    expect(created).toMatchObject(PERSONA);
    expect(created.createdAt).toBe(created.updatedAt);

    const list = (await (await f.request("/api/personas")).json()) as Json;
    expect(list.personas).toEqual([created]);
    const avail = Object.fromEntries(
      list.providers.map((p: Json) => [p.id, p.available]),
    );
    expect(avail).toEqual({
      openai: true,
      deepseek: false,
      opencode: false,
      local: false,
    });

    const patched = await f.request(`/api/personas/${created.id}`, "PATCH", {
      ...PERSONA,
      name: "Renamed",
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Json).name).toBe("Renamed");
    expect(
      (await f.request(`/api/personas/${randomUUID()}`, "PATCH", PERSONA))
        .status,
    ).toBe(404);

    expect(
      (await f.request(`/api/personas/${created.id}`, "DELETE")).status,
    ).toBe(200);
    const after = (await (await f.request("/api/personas")).json()) as Json;
    expect(after.personas).toEqual([]);
    expect(
      (await f.request(`/api/personas/${created.id}`, "DELETE")).status,
    ).toBe(404);
  });

  it("creates a persona with the opencode provider", async () => {
    // Regression: the DB provider CHECK must accept every id in the
    // contracts enum; 0045 only knew openai/deepseek/local.
    const f = await makeFixture();
    const res = await f.request("/api/personas", "POST", {
      ...PERSONA,
      provider: "opencode",
      model: "deepseek-v4.1-flash",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Json).provider).toBe("opencode");
  });

  it("rejects bad persona bodies with 400", async () => {
    const f = await makeFixture();
    const extra = await f.request("/api/personas", "POST", {
      ...PERSONA,
      bogus: 1,
    });
    expect(extra.status).toBe(400);
    expect(((await extra.json()) as Json).error.code).toBe("validation_error");
    const blank = await f.request("/api/personas", "POST", {
      ...PERSONA,
      name: "   ",
    });
    expect(blank.status).toBe(400);
  });

  it("chat CRUD", async () => {
    const f = await makeFixture();
    const persona = await createPersona(f);
    const first = await createChat(f, persona.id);
    expect(first).toMatchObject({
      personaId: persona.id,
      personaName: "Haruko",
      avatar: "🌸",
      title: "Harukoとの会話",
      messageCount: 0,
    });
    expect(
      (await f.request("/api/chats", "POST", { personaId: randomUUID() }))
        .status,
    ).toBe(404);

    const second = await createChat(f, persona.id);
    const list = (await (await f.request("/api/chats")).json()) as Json;
    expect(list.chats.map((c: Json) => c.id)).toEqual([second.id, first.id]);

    const renamed = await f.request(`/api/chats/${first.id}`, "PATCH", {
      title: "New title",
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as Json).title).toBe("New title");

    expect((await f.request(`/api/chats/${first.id}`, "DELETE")).status).toBe(
      200,
    );
    const after = (await (await f.request("/api/chats")).json()) as Json;
    expect(after.chats.map((c: Json) => c.id)).toEqual([second.id]);

    const missing = randomUUID();
    expect(
      (await f.request(`/api/chats/${missing}`, "PATCH", { title: "x" }))
        .status,
    ).toBe(404);
    expect((await f.request(`/api/chats/${missing}`, "DELETE")).status).toBe(
      404,
    );
  });

  it("creates and toggles two-persona autotalk chats", async () => {
    const f = await makeFixture();
    const primary = await createPersona(f);
    const partner = await createPersona(f, { name: "Natsuki" });
    const res = await f.request("/api/chats", "POST", {
      personaId: primary.id,
      partnerId: partner.id,
      autotalk: true,
    });
    expect(res.status).toBe(201);
    const chat = (await res.json()) as Json;
    expect(chat).toMatchObject({
      personaId: primary.id,
      partnerId: partner.id,
      partnerName: "Natsuki",
      autotalk: true,
    });

    const plain = await createChat(f, primary.id);
    expect(plain).toMatchObject({ partnerId: null, autotalk: false });

    for (const body of [
      { personaId: primary.id, partnerId: primary.id },
      { personaId: primary.id, partnerId: randomUUID() },
    ]) {
      expect((await f.request("/api/chats", "POST", body)).status).toBe(400);
    }

    const path = `/api/chats/${chat.id}`;
    const off = await f.request(path, "PATCH", { autotalk: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as Json).autotalk).toBe(false);
    const on = await f.request(path, "PATCH", { autotalk: true });
    expect(((await on.json()) as Json).autotalk).toBe(true);
    const empty = await f.request(path, "PATCH", {});
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as Json).title).toBe(chat.title);
    expect(
      (await f.request(`/api/chats/${randomUUID()}`, "PATCH", {})).status,
    ).toBe(404);
  });

  it("exposes personaId on messages", async () => {
    const f = await makeFixture();
    const persona = await createPersona(f);
    const chat = await createChat(f, persona.id);
    const sent = (await (
      await f.request(`/api/chats/${chat.id}/messages`, "POST", { text: "hi" })
    ).json()) as Json;
    expect(sent.messages.user.personaId).toBeNull();
    expect(sent.messages.assistant.personaId).toBe(persona.id);
    const history = (await (
      await f.request(`/api/chats/${chat.id}/messages`)
    ).json()) as Json;
    expect(history.messages.map((m: Json) => m.personaId)).toEqual([
      null,
      persona.id,
    ]);
  });

  it("sends, replays by clientKey, and pages history", async () => {
    const f = await makeFixture();
    const chat = await createChat(f, (await createPersona(f)).id);
    const path = `/api/chats/${chat.id}/messages`;

    const sent = await f.request(path, "POST", {
      text: "hello",
      clientKey: "key-12345678",
    });
    expect(sent.status).toBe(200);
    const body = (await sent.json()) as Json;
    expect(body.messages.user).toMatchObject({
      role: "user",
      content: "hello",
    });
    expect(body.messages.assistant).toMatchObject({
      role: "assistant",
      content: "reply 1",
    });
    expect(body.chat.messageCount).toBe(2);

    const replay = (await (
      await f.request(path, "POST", {
        text: "hello",
        clientKey: "key-12345678",
      })
    ).json()) as Json;
    expect(replay.messages.user.id).toBe(body.messages.user.id);
    expect(replay.messages.assistant.id).toBe(body.messages.assistant.id);
    expect(f.gatewayCalls).toHaveLength(1);

    const page = (await (await f.request(`${path}?limit=1`)).json()) as Json;
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m: Json) => m.id)).toEqual([
      body.messages.assistant.id,
    ]);
  });

  it("maps provider and lookup failures", async () => {
    const noKey = await makeFixture({
      keys: { openai: null, deepseek: null, opencode: null },
    });
    const chat1 = await createChat(noKey, (await createPersona(noKey)).id);
    const unavailable = await noKey.request(
      `/api/chats/${chat1.id}/messages`,
      "POST",
      { text: "hi" },
    );
    expect(unavailable.status).toBe(409);
    expect(((await unavailable.json()) as Json).error.code).toBe(
      "provider_unavailable",
    );

    const f = await makeFixture();
    const chat = await createChat(f, (await createPersona(f)).id);
    f.setGatewayFails(true);
    const failed = await f.request(`/api/chats/${chat.id}/messages`, "POST", {
      text: "hi",
    });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as Json).error.code).toBe("provider_failed");
    const history = (await (
      await f.request(`/api/chats/${chat.id}/messages`)
    ).json()) as Json;
    expect(history.messages).toEqual([]);

    expect(
      (
        await f.request(`/api/chats/${randomUUID()}/messages`, "POST", {
          text: "hi",
        })
      ).status,
    ).toBe(404);
  });

  it("validates message bodies and paging bounds", async () => {
    const f = await makeFixture();
    const chat = await createChat(f, (await createPersona(f)).id);
    const path = `/api/chats/${chat.id}/messages`;
    for (const body of [
      {},
      { text: "  " },
      { text: "hi", clientKey: "short" },
    ]) {
      expect((await f.request(path, "POST", body)).status).toBe(400);
    }
    expect((await f.request(`${path}?limit=0`)).status).toBe(400);
    expect((await f.request(`${path}?limit=101`)).status).toBe(400);
    expect((await f.request(`${path}?limit=100`)).status).toBe(200);
  });
});
