// Companion-initiated chat messages: ONE `companion_text` Turn, no Run, no
// user_text semantics; history projection + bounded forward read (SSE source).

import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/index.js";

async function openRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo, db: handle.raw };
}

const T0 = 1_790_000_000_000;

function newSession(repo: KernelRepository, now = T0) {
  return repo.createSession({ key: generateId(), now }).body.sessionId;
}

describe("companion messages", () => {
  it("persists one companion_text history item and no Run", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      const session = newSession(repo);
      const message = repo.postCompanionMessage(session, "作業が終わったよ", {
        now: T0 + 10,
      });
      expect(message).toEqual({
        turnId: expect.any(String),
        seq: 1,
        text: "作業が終わったよ",
        createdAt: T0 + 10,
      });
      expect(repo.getHistory(session, { limit: 50 }).items).toEqual([
        {
          turnId: message.turnId,
          seq: 1,
          kind: "companion_text",
          text: "作業が終わったよ",
          createdAt: T0 + 10,
          selectedRun: null,
        },
      ]);
      expect(repo.getActiveRun(session)).toBeNull();
      const runs = db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = ?")
        .get(session) as { n: number };
      expect(runs.n).toBe(0);
      expect(repo.latestSessionId()).toBe(session);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("pages forward after a seq and reports hasMore truthfully", async () => {
    const { handle, repo } = await openRepo();
    try {
      const session = newSession(repo);
      const first = repo.postCompanionMessage(session, "one", { now: T0 + 1 });
      repo.postCompanionMessage(session, "two", { now: T0 + 2 });
      const third = repo.postCompanionMessage(session, "three", {
        now: T0 + 3,
      });
      expect(
        repo.listCompanionMessagesForward(session, {
          after: first.seq,
          limit: 10,
        }),
      ).toEqual({
        messages: [
          {
            turnId: expect.any(String),
            seq: 2,
            text: "two",
            createdAt: T0 + 2,
          },
          {
            turnId: third.turnId,
            seq: 3,
            text: "three",
            createdAt: T0 + 3,
          },
        ],
        hasMore: false,
      });
      const page = repo.listCompanionMessagesForward(session, {
        after: first.seq,
        limit: 1,
      });
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0]?.text).toBe("two");
      expect(page.hasMore).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps sessions isolated and picks the newest activity by default", async () => {
    const { handle, repo } = await openRepo();
    try {
      const older = newSession(repo, T0);
      const newer = newSession(repo, T0 + 1);
      repo.postCompanionMessage(older, "older", { now: T0 + 2 });
      repo.postCompanionMessage(newer, "newer", { now: T0 + 3 });
      expect(repo.getHistory(older, { limit: 50 }).items).toHaveLength(1);
      expect(repo.getHistory(newer, { limit: 50 }).items).toHaveLength(1);
      expect(repo.latestSessionId()).toBe(newer);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects unknown sessions and unusable text without persisting", async () => {
    const { handle, repo } = await openRepo();
    try {
      const session = newSession(repo);
      expect(() =>
        repo.postCompanionMessage(generateId(), "hello", { now: T0 + 1 }),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        repo.postCompanionMessage(session, "   ", { now: T0 + 1 }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.postCompanionMessage(session, "x".repeat(32_769), { now: T0 + 1 }),
      ).toThrow(RepositoryValidationError);
      expect(repo.getHistory(session, { limit: 50 }).items).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
