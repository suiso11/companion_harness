import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createPersonaChatStore,
  migrateKernelDatabase,
  openKernelDatabase,
  PersonaChatStoreError,
} from "../src/index.js";

const input = {
  name: "Ada",
  avatar: "A",
  provider: "openai",
  model: "gpt-4.1",
  systemPrompt: "Be brief.",
} as const;

async function setup() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return { handle, store: createPersonaChatStore({ db: handle.raw }) };
}

describe("persona chat store", () => {
  it("round-trips personas and chats, rename bumps updated_at", async () => {
    const { handle, store } = await setup();
    const p = store.createPersona(input, 100);
    expect(store.updatePersona(p.id, { ...input, name: "Bo" }, 150)?.name).toBe(
      "Bo",
    );
    const chat = store.createChat(p.id, undefined, 200);
    expect(chat?.personaName).toBe("Bo");
    expect(chat?.preview).toBe("");
    const renamed = store.renameChat(chat?.id as string, "New", 300);
    expect(renamed).toMatchObject({ title: "New", updatedAt: 300 });
    expect(store.listChats()).toHaveLength(1);
    closeKernelDatabase(handle);
  });

  it("pages messages and replays by client key", async () => {
    const { handle, store } = await setup();
    const p = store.createPersona(input, 1);
    const chat = store.createChat(p.id, "T", 2);
    const id = chat?.id as string;
    const ex = [1, 2, 3].map((i) =>
      store.appendExchange(
        id,
        { text: `q${i}`, reply: `a${i}`, clientKey: `key-000${i}` },
        i * 10,
      ),
    );
    expect(store.findMessageByClientKey(id, "key-0002")?.id).toBe(
      ex[1]?.user.id,
    );
    expect(store.getChat(id)).toMatchObject({ messageCount: 6, preview: "a3" });
    expect(store.findExchangeByClientKey(id, "key-0001")).toEqual(ex[0]);
    expect(store.findExchangeByClientKey(id, "key-0002")).toEqual(ex[1]);
    expect(store.findExchangeByClientKey(id, "nope-0000")).toBeNull();
    const page = store.listMessages(id, { limit: 4 });
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.content)).toEqual([
      "q2",
      "a2",
      "q3",
      "a3",
    ]);
    const beforeId = page.messages[0]?.id;
    const older =
      beforeId === undefined
        ? { messages: [], hasMore: false }
        : store.listMessages(id, { limit: 4, beforeId });
    expect(older).toMatchObject({ hasMore: false });
    expect(older.messages.map((m) => m.content)).toEqual(["q1", "a1"]);
    expect(() => store.listMessages(id, { limit: 1, beforeId: "x" })).toThrow(
      PersonaChatStoreError,
    );
    closeKernelDatabase(handle);
  });

  it("cascades persona delete and treats unknown ids as not found", async () => {
    const { handle, store } = await setup();
    const p = store.createPersona(input, 1);
    const chat = store.createChat(p.id, "T", 2);
    store.appendExchange(chat?.id as string, { text: "q", reply: "a" }, 3);
    expect(store.deletePersona(p.id)).toBe(true);
    expect(store.getChat(chat?.id as string)).toBeNull();
    expect(
      handle.raw
        .prepare("SELECT count(*) AS n FROM persona_chat_messages")
        .get(),
    ).toEqual({ n: 0 });
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(store.getPersona(ghost)).toBeNull();
    expect(store.updatePersona(ghost, input, 5)).toBeNull();
    expect(store.createChat(ghost, undefined, 5)).toBeNull();
    expect(store.renameChat(ghost, "x", 5)).toBeNull();
    expect(store.deleteChat(ghost)).toBe(false);
    expect(store.deletePersona(ghost)).toBe(false);
    closeKernelDatabase(handle);
  });

  it("rejects out-of-range titles in store and DB", async () => {
    const { handle, store } = await setup();
    const p = store.createPersona(input, 1);
    expect(() => store.createChat(p.id, "x".repeat(121), 2)).toThrow(
      PersonaChatStoreError,
    );
    expect(() =>
      handle.raw
        .prepare(
          "INSERT INTO persona_chats (id, persona_id, title, created_at, updated_at) VALUES ('c', ?, '', 1, 1)",
        )
        .run(p.id),
    ).toThrow(/CHECK/);
    closeKernelDatabase(handle);
  });
});
