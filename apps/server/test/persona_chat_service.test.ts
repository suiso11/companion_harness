// Persona chat send path over a real migrated kernel DB and a fake gateway.
import {
  closeKernelDatabase,
  createPersonaChatStore,
  migrateKernelDatabase,
  openKernelDatabase,
  type PersonaChatStore,
} from "@companion/kernel";
import type {
  RemoteChatMessage,
  RemoteChatRequest,
} from "@companion/model-remote";
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
  keys: {
    openai: string | null;
    deepseek: string | null;
    opencode: string | null;
  } = {
    openai: "sk-test",
    deepseek: null,
    opencode: null,
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
      ["opencode", false],
      ["local", false],
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
      opencode: null,
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
    expect(calls[0]).toMatchObject({ maxOutputTokens: 1024 });
    expect(calls[0]?.temperature).toBeUndefined();
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

  describe("local provider and autotalk", () => {
    const HOUR = 3_600_000;

    async function setupTalk(acquireLocal?: () => (() => void) | null) {
      const handle = openKernelDatabase(":memory:");
      await migrateKernelDatabase({ db: handle.raw });
      fixtures.push(() => closeKernelDatabase(handle));
      const store = createPersonaChatStore({ db: handle.raw });
      const ada = store.createPersona(
        {
          name: "Ada",
          avatar: "A",
          provider: "openai",
          model: "gpt-4.1-mini",
          systemPrompt: "You are Ada.",
        },
        T0,
      );
      const ben = store.createPersona(
        {
          name: "Ben",
          avatar: "B",
          provider: "local",
          model: "informational",
          systemPrompt: "You are Ben.",
        },
        T0,
      );
      const chat = store.createChat(ada.id, undefined, T0, {
        partnerId: ben.id,
        autotalk: true,
      });
      if (chat === null) throw new Error("chat setup failed");
      const remote = vi.fn(async (_request: RemoteChatRequest) => "from ada");
      const local = vi.fn(
        async (_messages: readonly RemoteChatMessage[], _max: number) =>
          "from ben",
      );
      let clock = T0 + 1000;
      const service = createPersonaChatService({
        store,
        keys: { openai: "sk-test", deepseek: null, opencode: null },
        now: () => (clock += 10),
        createGateway: () => ({
          chat: async (request: RemoteChatRequest) => ({
            text: await remote(request),
            usage: null,
          }),
        }),
        localChat: local,
        ...(acquireLocal === undefined ? {} : { acquireLocal }),
      });
      const texts = () =>
        store
          .listMessages(chat.id, { limit: 50 })
          .messages.map((m) => m.content);
      return { store, service, ada, ben, chat, remote, local, texts };
    }

    it("marks local available only with a local chat function", async () => {
      const { service } = await setupTalk();
      expect(service.providers().find((p) => p.id === "local")?.available).toBe(
        true,
      );
    });

    it("sends a local persona through the local chat function without a key", async () => {
      const { store, service, ben, remote, local } = await setupTalk();
      const chat = store.createChat(ben.id, undefined, T0);
      if (chat === null) throw new Error("chat setup failed");
      const out = await service.send({ chatId: chat.id, text: "hi" });
      expect(out.messages.assistant.content).toBe("from ben");
      expect(remote).not.toHaveBeenCalled();
      expect(local).toHaveBeenCalledWith(
        [
          { role: "system", content: "You are Ben." },
          { role: "user", content: "hi" },
        ],
        1024,
      );
    });

    it("alternates speakers starting with the primary and prompts in their perspective", async () => {
      const { service, ada, ben, chat, remote, local, store, texts } =
        await setupTalk();

      expect(await service.autotalk(T0 + HOUR)).toBe(1);
      expect(remote.mock.calls[0]?.[0].messages).toEqual([
        { role: "system", content: "You are Ada.\n会話の相手はBenです。" },
        { role: "user", content: "会話を始めてください。" },
      ]);

      expect(await service.autotalk(T0 + 2 * HOUR)).toBe(1);
      expect(local.mock.calls[0]?.[0]).toEqual([
        { role: "system", content: "You are Ben.\n会話の相手はAdaです。" },
        { role: "user", content: "from ada" },
        {
          role: "user",
          content:
            "直前の流れに続く短い一言だけを返してください。前置きや説明は不要です。",
        },
      ]);

      expect(await service.autotalk(T0 + 3 * HOUR)).toBe(1);
      expect(remote.mock.calls[1]?.[0].messages.slice(1, 3)).toEqual([
        { role: "assistant", content: "from ada" },
        { role: "user", content: "from ben" },
      ]);

      expect(texts()).toEqual(["from ada", "from ben", "from ada"]);
      expect(
        store
          .listMessages(chat.id, { limit: 10 })
          .messages.map((m) => m.personaId),
      ).toEqual([ada.id, ben.id, ada.id]);
    });

    it("only runs chats whose newest message is older than the interval", async () => {
      const { service, remote, store, chat } = await setupTalk();
      expect(await service.autotalk(T0 + HOUR)).toBe(1);
      expect(await service.autotalk(T0 + HOUR + 500)).toBe(0);
      expect(remote).toHaveBeenCalledTimes(1);
      expect(await service.autotalk(T0 + 2 * HOUR)).toBe(1);
      store.setAutotalk(chat.id, false, T0 + 2 * HOUR);
      expect(await service.autotalk(T0 + 9 * HOUR)).toBe(0);
    });

    it("skips a failing chat without appending or throwing", async () => {
      const { service, remote, texts } = await setupTalk();
      remote.mockRejectedValueOnce(new Error("upstream secret text"));
      expect(await service.autotalk(T0 + HOUR)).toBe(0);
      expect(texts()).toEqual([]);
      expect(await service.autotalk(T0 + HOUR)).toBe(1);
      expect(texts()).toEqual(["from ada"]);
    });

    it("skips a local autotalk turn while the background gate is held", async () => {
      const { service, local, texts } = await setupTalk(() => null);
      // First pass: primary (hosted) writes. Second pass is the local partner.
      expect(await service.autotalk(T0 + HOUR)).toBe(1);
      expect(await service.autotalk(T0 + 2 * HOUR)).toBe(0);
      expect(local).not.toHaveBeenCalled();
      expect(texts()).toEqual(["from ada"]);
    });

    it("holds and releases the gate around a local autotalk turn", async () => {
      const release = vi.fn();
      const acquire = vi.fn(() => release);
      const { service, local, texts } = await setupTalk(acquire);
      expect(await service.autotalk(T0 + HOUR)).toBe(1);
      expect(await service.autotalk(T0 + 2 * HOUR)).toBe(1);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(local).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(texts()).toEqual(["from ada", "from ben"]);
    });

    it("runs the same chat once for concurrent autotalk passes", async () => {
      const { service, remote, texts } = await setupTalk();
      let release: (value: string) => void = () => {};
      remote.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
      const first = service.autotalk(T0 + HOUR);
      const second = service.autotalk(T0 + HOUR);
      await Promise.resolve();
      release("once");
      const counts = await Promise.all([first, second]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      expect(remote).toHaveBeenCalledTimes(1);
      expect(texts()).toEqual(["once"]);
    });
  });

  describe("main-agent partner", () => {
    const HOUR = 3_600_000;

    async function setupMain(options: { withMain: boolean }) {
      const handle = openKernelDatabase(":memory:");
      await migrateKernelDatabase({ db: handle.raw });
      fixtures.push(() => closeKernelDatabase(handle));
      const store = createPersonaChatStore({ db: handle.raw });
      const ada = store.createPersona(
        {
          name: "Ada",
          avatar: "A",
          provider: "openai",
          model: "gpt-4.1-mini",
          systemPrompt: "You are Ada.",
        },
        T0,
      );
      const chat = store.createChat(ada.id, undefined, T0, {
        partnerMain: true,
        autotalk: true,
      });
      if (chat === null) throw new Error("chat setup failed");
      const remote = vi.fn(async (_request: RemoteChatRequest) => "from ada");
      const main = vi.fn(
        async (_input: {
          chatId: string;
          personaName: string;
          text: string;
          transcript: string;
        }) => "from main",
      );
      let clock = T0 + 1000;
      const service = createPersonaChatService({
        store,
        keys: { openai: "sk-test", deepseek: null, opencode: null },
        now: () => (clock += 10),
        createGateway: () => ({
          chat: async (request: RemoteChatRequest) => ({
            text: await remote(request),
            usage: null,
          }),
        }),
        ...(options.withMain ? { mainChat: main } : {}),
      });
      return { store, service, ada, chat, remote, main };
    }

    it("alternates persona then real main agent", async () => {
      const { store, service, ada, chat, remote, main } = await setupMain({
        withMain: true,
      });
      expect(service.mainAvailable()).toBe(true);

      expect(await service.autotalk(T0 + HOUR)).toBe(1);
      expect(main).not.toHaveBeenCalled();

      expect(await service.autotalk(T0 + 2 * HOUR)).toBe(1);
      expect(main).toHaveBeenCalledTimes(1);
      expect(main.mock.calls[0]?.[0]).toMatchObject({
        chatId: chat.id,
        personaName: "Ada",
        text: "from ada",
      });
      expect(main.mock.calls[0]?.[0].transcript).toContain("Ada: from ada");

      expect(await service.autotalk(T0 + 3 * HOUR)).toBe(1);
      expect(remote).toHaveBeenCalledTimes(2);
      expect(
        store
          .listMessages(chat.id, { limit: 10 })
          .messages.map((m) => [m.role, m.personaId, m.content]),
      ).toEqual([
        ["assistant", ada.id, "from ada"],
        ["assistant", null, "from main"],
        ["assistant", ada.id, "from ada"],
      ]);
    });

    it("skips when the main agent is unavailable", async () => {
      const { service, chat } = await setupMain({ withMain: false });
      expect(service.mainAvailable()).toBe(false);
      expect(await service.autotalk(T0 + HOUR)).toBe(1); // persona still speaks
      expect(await service.autotalk(T0 + 2 * HOUR)).toBe(0); // main turn skipped
      expect(
        service.providers().some((p) => p.id === "local" && !p.available),
      ).toBe(true);
      expect(chat.partnerMain).toBe(true);
    });
  });
});
