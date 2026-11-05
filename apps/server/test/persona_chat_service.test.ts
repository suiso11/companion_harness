// Persona chat send path over a real migrated kernel DB and a fake gateway.
import {
  closeKernelDatabase,
  createPersonaChatStore,
  migrateKernelDatabase,
  openKernelDatabase,
  type PersonaChatStore,
} from "@companion/kernel";
import type { RemoteChatRequest } from "@companion/model-remote";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersonaChatService,
  PersonaChatServiceError,
} from "../src/persona_chat_service.js";

const T0 = 1790000000000;
const fixtures: Array<() => void> = [];

afterEach(() => {
  for (const close of fixtures) close();
  fixtures.length = 0;
});

async function setup(
  keys: { openai: string | null; deepseek: string | null } = {
    openai: "sk-test",
    deepseek: null,
  },
  reply: () => Promise<string> = async () => "hello back",
) {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  fixtures.push(() => closeKernelDatabase(handle));
  const store: PersonaChatStore = createPersonaChatStore({ db: handle.raw });
  const persona = store.createPersona(
    {
      name: "Ada",
      avatar: "A",
      provider: "openai",
      model: "gpt-4.1-mini",
      systemPrompt: "You are Ada.",
    },
    T0,
  );
  const chat = store.createChat(persona.id, undefined, T0);
  if (chat === null) throw new Error("chat setup failed");
  const calls: RemoteChatRequest[] = [];
  const createGateway = vi.fn(() => ({
    chat: async (request: RemoteChatRequest) => {
      calls.push(request);
      return { text: await reply(), usage: null };
    },
  }));
  let clock = T0 + 1000;
  const service = createPersonaChatService({
    store,
    keys,
    now: () => (clock += 10),
    createGateway,
  });
  return { store, service, chat, calls, createGateway };
}

describe("persona chat service", () => {
  it("lists providers with availability from the key map", async () => {
    const { service } = await setup();
    expect(service.providers().map((p) => [p.id, p.available])).toEqual([
      ["openai", true],
      ["deepseek", false],
    ]);
  });

  it("stores both messages and bumps the chat", async () => {
    const { store, service, chat } = await setup();
    const out = await service.send({ chatId: chat.id, text: "hi" });
    expect(out.messages.user.content).toBe("hi");
    expect(out.messages.assistant.content).toBe("hello back");
    expect(out.chat.messageCount).toBe(2);
    expect(out.chat.updatedAt).toBeGreaterThan(chat.updatedAt);
    expect(
      store.listMessages(chat.id, { limit: 10 }).messages.map((m) => m.role),
    ).toEqual(["user", "assistant"]);
  });

  it("replays a clientKey without a second model call", async () => {
    const { service, chat, calls } = await setup();
    const first = await service.send({
      chatId: chat.id,
      text: "hi",
      clientKey: "key-12345678",
    });
    const again = await service.send({
      chatId: chat.id,
      text: "hi",
      clientKey: "key-12345678",
    });
    expect(again.messages).toEqual(first.messages);
    expect(calls).toHaveLength(1);
  });

  it("shares one model call across concurrent sends with the same clientKey", async () => {
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { service, chat, calls } = await setup(undefined, () => gate);
    const first = service.send({
      chatId: chat.id,
      text: "hi",
      clientKey: "key-12345678",
    });
    const second = service.send({
      chatId: chat.id,
      text: "hi",
      clientKey: "key-12345678",
    });
    await Promise.resolve();
    release("once");
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a.messages).toEqual(b.messages);
    expect(a.messages.assistant.content).toBe("once");
  });

  it("is provider_unavailable when the provider key is null", async () => {
    const { store, service, chat, calls } = await setup({
      openai: null,
      deepseek: null,
    });
    await expect(
      service.send({ chatId: chat.id, text: "hi" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(calls).toHaveLength(0);
    expect(store.listMessages(chat.id, { limit: 10 }).messages).toEqual([]);
  });

  it("wraps provider errors and persists nothing", async () => {
    const { store, service, chat } = await setup(undefined, async () => {
      throw new Error("upstream secret text");
    });
    const error = await service
      .send({ chatId: chat.id, text: "hi", clientKey: "key-12345678" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PersonaChatServiceError);
    expect((error as PersonaChatServiceError).code).toBe("provider_failed");
    expect((error as Error).message).not.toContain("secret");
    expect(store.listMessages(chat.id, { limit: 10 }).messages).toEqual([]);
  });

  it("prompts with system + newest 20 messages + the new text", async () => {
    const { store, service, chat, calls } = await setup();
    for (let i = 0; i < 13; i += 1) {
      store.appendExchange(
        chat.id,
        { text: `u${i}`, reply: `a${i}` },
        T0 + 100 + i * 10,
      );
    }
    await service.send({ chatId: chat.id, text: "now" });
    const expected: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are Ada." },
    ];
    // 26 stored messages; the newest 20 are u3..a12.
    for (let i = 3; i < 13; i += 1) {
      expected.push({ role: "user", content: `u${i}` });
      expected.push({ role: "assistant", content: `a${i}` });
    }
    expected.push({ role: "user", content: "now" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual(expected);
    expect(calls[0]).toMatchObject({ maxOutputTokens: 1024, temperature: 0.8 });
  });

  it("rejects an unknown chat", async () => {
    const { service, createGateway } = await setup();
    await expect(
      service.send({
        chatId: "00000000-0000-4000-8000-000000000000",
        text: "hi",
      }),
    ).rejects.toMatchObject({ code: "chat_not_found" });
    expect(createGateway).not.toHaveBeenCalled();
  });
});
