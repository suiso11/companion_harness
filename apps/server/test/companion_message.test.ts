// Companion-initiated chat message: bounded CLI argv, real kernel write, and
// the durable SSE feed step the open chat consumes.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompanionMessageCliError,
  MESSAGE_USAGE,
  parseSendMessageArgv,
  runSendMessageCli,
} from "../src/companion_message_cli.js";
import { pollCompanionMessageStep } from "../src/sse.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-message-"));
  tempRoots.push(dir);
  return dir;
}

async function makeSeededDb(dir: string): Promise<{
  dbPath: string;
  older: string;
  newer: string;
}> {
  const dbPath = join(dir, "companion.sqlite");
  const handle = openKernelDatabase(dbPath);
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const older = repo.createSession({
    key: randomUUID(),
    now: 1_700_001_000_000,
  }).body.sessionId;
  const newer = repo.createSession({
    key: randomUUID(),
    now: 1_700_001_000_001,
  }).body.sessionId;
  closeKernelDatabase(handle);
  return { dbPath, older, newer };
}

function envFor(dbPath: string): NodeJS.ProcessEnv {
  return {
    COMPANION_DB_PATH: dbPath,
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "0",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "error",
  };
}

describe("send argv parsing", () => {
  it("accepts text and an optional session only", () => {
    expect(parseSendMessageArgv(["--text", "done"])).toEqual({ text: "done" });
    expect(
      parseSendMessageArgv(["--text", "done", "--session", randomUUID()]),
    ).toEqual({ text: "done", sessionId: expect.any(String) });
  });

  it("rejects unknown flags, dangling values, and unusable text", () => {
    expect(() => parseSendMessageArgv(["--text"])).toThrow(MESSAGE_USAGE);
    expect(() =>
      parseSendMessageArgv(["--text", "x", "--secret", "y"]),
    ).toThrow(CompanionMessageCliError);
    expect(() => parseSendMessageArgv(["--text", "   "])).toThrow(
      MESSAGE_USAGE,
    );
    expect(() => parseSendMessageArgv(["--text", "x".repeat(32_769)])).toThrow(
      MESSAGE_USAGE,
    );
  });
});

describe("send CLI against the kernel store", () => {
  it("writes to the newest session by default with fixed safe output", async () => {
    const dir = tempDir();
    const { dbPath, newer } = await makeSeededDb(dir);
    const out = runSendMessageCli(["--text", "終わったよ"], envFor(dbPath));
    expect(out).toMatch(
      new RegExp(
        `^companion message sent: session=${newer} turn=[0-9a-f-]+ seq=1$`,
      ),
    );
    expect(out).not.toContain(dbPath);
    const handle = openKernelDatabase(dbPath);
    try {
      const repo = createKernelRepository(handle.raw);
      expect(repo.getHistory(newer, { limit: 50 }).items).toEqual([
        {
          turnId: expect.any(String),
          seq: 1,
          kind: "companion_text",
          text: "終わったよ",
          createdAt: expect.any(Number),
          selectedRun: null,
        },
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("addresses an explicit session", async () => {
    const dir = tempDir();
    const { dbPath, older, newer } = await makeSeededDb(dir);
    runSendMessageCli(
      ["--text", "older only", "--session", older],
      envFor(dbPath),
    );
    const handle = openKernelDatabase(dbPath);
    try {
      const repo = createKernelRepository(handle.raw);
      expect(repo.getHistory(older, { limit: 50 }).items).toHaveLength(1);
      expect(repo.getHistory(newer, { limit: 50 }).items).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("companion message SSE step", () => {
  it("formats a durable envelope and advances the cursor by turn seq", () => {
    const step = pollCompanionMessageStep(
      {
        listCompanionMessagesForward: () => ({
          messages: [
            {
              turnId: "11111111-1111-4111-8111-111111111111",
              seq: 2,
              text: "hello",
              createdAt: 42,
            },
          ],
          hasMore: false,
        }),
      },
      "session",
      1,
    );
    expect(step.cursor).toBe(2);
    expect(step.chunks).toEqual([
      'id: 2\nevent: companion-message\ndata: {"turnId":"11111111-1111-4111-8111-111111111111","seq":2,"text":"hello","createdAt":42}\n\n',
    ]);
    const idle = pollCompanionMessageStep(
      {
        listCompanionMessagesForward: () => ({
          messages: [],
          hasMore: false,
        }),
      },
      "session",
      7,
    );
    expect(idle).toEqual({ chunks: [], cursor: 7, done: false });
  });
});
