// Session list projection: human title/preview and last-turn kind, bounded.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_790_000_000_000;

async function open() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo };
}

describe("listSessions", () => {
  it("derives title, preview, last kind and last user time", async () => {
    const { handle, repo } = await open();
    try {
      const first = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const posted = repo.postMessage(
        first,
        { text: "  最初の質問です  " },
        { key: randomUUID(), now: T0 + 1 },
      );
      repo.cancelRun(first, posted.body.run.id, { now: T0 + 2 });
      repo.postCompanionMessage(first, "自発メッセージ", { now: T0 + 3 });

      const second = repo.createSession({ key: randomUUID(), now: T0 + 10 })
        .body.sessionId;
      repo.postMessage(
        second,
        { text: "二番目のセッション" },
        { key: randomUUID(), now: T0 + 11 },
      );

      const all = repo.listSessions({ limit: 10 });
      expect(all.sessions[0]?.id).toBe(second);
      const summary = all.sessions.find((item) => item.id === first);
      expect(summary).toMatchObject({
        title: "最初の質問です",
        lastTurnKind: "companion_text",
        preview: "自発メッセージ",
        lastUserAt: T0 + 1,
      });
      expect(all.sessions).toHaveLength(2);

      const one = repo.listSessions({ limit: 1 });
      expect(one.sessions).toHaveLength(1);
      expect(one.sessions[0]?.id).toBe(second);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("bounds a long title and defaults an empty session", async () => {
    const { handle, repo } = await open();
    try {
      const empty = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const long = repo.createSession({ key: randomUUID(), now: T0 + 1 }).body
        .sessionId;
      repo.postMessage(
        long,
        { text: "あ".repeat(80) },
        { key: randomUUID(), now: T0 + 2 },
      );
      const all = repo.listSessions({ limit: 10 });
      expect(all.sessions.find((item) => item.id === empty)?.title).toBe(
        "新しい会話",
      );
      const title = all.sessions.find((item) => item.id === long)?.title ?? "";
      expect(Array.from(title)).toHaveLength(40);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
