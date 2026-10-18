// AV03 review regressions: quote uniqueness + keyset pagination.
//
// Proves through the REAL kernel repository + ToolBroker (in-memory DB):
// - A staged quote must identify EXACTLY ONE passage of the server-bound
//   CURRENT ordinary `user_text` body: repeated or overlapping occurrences
//   are ambiguous and stage NOTHING (no authority, no draft, no pending
//   insert). Matching is exact on the original text (no normalization).
// - Ordinary unique quotes stage + replay exactly as before.
// - History paging is a stable opaque keyset over (created_at, id): every
//   owned row — including an old pending draft buried under newer
//   decisions — is reachable exactly once, `hasMore`/`nextCursor` are
//   truthful, `pendingCount` covers ALL owned pending, and cursors never
//   oracle foreign ids.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_ORIGIN } from "../src/agent.js";
import { RepositoryValidationError } from "../src/errors.js";
import {
  closeKernelDatabase,
  createAutonomyReadRegistrations,
  createConversationProposalRegistrations,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_004_000_000;
const MODEL_CTX = { origin: AGENT_TOOL_ORIGIN, caller: "test-agent" };

async function setup() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations: [
      ...createAutonomyReadRegistrations({ repo }),
      ...createConversationProposalRegistrations({ repo }),
    ],
  });
  return {
    handle,
    repo,
    broker,
    sessionId: session.body.sessionId as string,
  };
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  now: number,
  priorRunId?: string,
): string {
  if (priorRunId !== undefined) {
    repo.failRun(priorRunId, "execution_failed", { now });
  }
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: now + 1 });
  return runId;
}

function proposalCount(handle: ReturnType<typeof openKernelDatabase>): number {
  return (
    handle.raw
      .prepare("SELECT COUNT(*) AS n FROM conversation_proposals")
      .get() as {
      n: number;
    }
  ).n;
}

describe("conversation proposal quote uniqueness", () => {
  it("stages a unique quote and replays it without duplicating", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "I want to walk daily at sunrise",
        T0,
      );
      const draft = {
        scope: "health",
        draftKind: "wish",
        purposeKind: "goal",
        sourceQuote: "walk daily",
        interpretation: "a morning walk habit",
      };
      const first = await broker.invoke(
        runId,
        "purpose.propose",
        draft,
        MODEL_CTX,
      );
      expect(first.result.actualOutcome).toBe("succeeded");
      const replayed = repo.stageConversationProposalFromModel(
        runId,
        { target: "purpose", ...draft },
        { key: randomUUID() },
      );
      expect(replayed.replayed).toBe(true);
      expect(proposalCount(handle)).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects a repeated quote with nothing staged", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "walk daily, then walk daily again tomorrow",
        T0,
      );
      expect(() =>
        repo.stageConversationProposalFromModel(
          runId,
          {
            target: "purpose",
            scope: "health",
            draftKind: "wish",
            purposeKind: "goal",
            sourceQuote: "walk daily",
            interpretation: "ambiguous repeated passage",
          },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      expect(proposalCount(handle)).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects an overlapping quote with nothing staged", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, "aaa", T0);
      expect(() =>
        repo.stageConversationProposalFromModel(
          runId,
          {
            target: "purpose",
            scope: "health",
            draftKind: "wish",
            purposeKind: "goal",
            sourceQuote: "aa",
            interpretation: "overlapping ambiguous passage",
          },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      expect(proposalCount(handle)).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("matches the original text exactly without normalization", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      // Body carries NFC é; the NFD form must NOT match (no normalization).
      const nfc = "caf\u00e9 break";
      const nfd = "cafe\u0301 break";
      expect(nfc.includes(nfd)).toBe(false);
      const runId = newRunningRun(repo, sessionId, nfc, T0);
      expect(() =>
        repo.stageConversationProposalFromModel(
          runId,
          {
            target: "purpose",
            scope: "health",
            draftKind: "wish",
            purposeKind: "goal",
            sourceQuote: nfd,
            interpretation: "normalized lookalike",
          },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      // The byte-identical original still stages exactly once.
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "wish",
          purposeKind: "goal",
          sourceQuote: "caf\u00e9",
          interpretation: "verbatim original",
        },
        { key: randomUUID() },
      );
      expect(staged.status).toBe(201);
      expect(proposalCount(handle)).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects a same-tool repeated staging attempt as ambiguous too", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "nap daily after lunch, nap daily again at dusk",
        T0,
      );
      const out = await broker.invoke(
        runId,
        "purpose.propose",
        {
          scope: "health",
          draftKind: "wish",
          purposeKind: "goal",
          sourceQuote: "nap daily",
          interpretation: "ambiguous via the model tool path",
        },
        MODEL_CTX,
      );
      expect(out.result.actualOutcome).toBe("failed");
      expect(proposalCount(handle)).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("conversation proposal keyset pagination", () => {
  it("reaches every row exactly once with truthful hasMore and pendingCount", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      let prior: string | undefined;
      // One old pending draft first, then 60 decided drafts (mixed accept /
      // reject) sharing identical timestamps to pin the (created_at, id)
      // tie-break.
      const keeperRun = newRunningRun(
        repo,
        sessionId,
        "note keeper choice end",
        T0,
        prior,
      );
      prior = keeperRun;
      const keeper = repo.stageConversationProposalFromModel(
        keeperRun,
        {
          target: "purpose",
          scope: "health",
          draftKind: "wish",
          purposeKind: "goal",
          sourceQuote: "keeper choice",
          interpretation: "the old pending draft",
        },
        { key: randomUUID() },
      );
      const keeperId = keeper.body.id;
      for (let i = 0; i < 60; i += 1) {
        const runId = newRunningRun(
          repo,
          sessionId,
          `burst filler ${i} marker`,
          T0,
          prior,
        );
        prior = runId;
        const staged = repo.stageConversationProposalFromModel(
          runId,
          {
            target: "purpose",
            scope: "health",
            draftKind: "wish",
            purposeKind: "goal",
            sourceQuote: `filler ${i} marker`,
            interpretation: `burst draft ${i}`,
          },
          { key: randomUUID() },
        );
        if (i % 2 === 0) {
          repo.rejectConversationProposal(
            sessionId,
            staged.body.id,
            { expectedVersion: 1 },
            { key: randomUUID(), now: T0 },
          );
        } else {
          repo.acceptConversationProposal(
            sessionId,
            staged.body.id,
            { expectedVersion: 1 },
            { key: randomUUID(), now: T0 },
          );
        }
      }
      expect(proposalCount(handle)).toBe(61);

      // Walk the whole history through the opaque keyset: every id
      // exactly once, 61 rows over small pages.
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      let firstPendingCount = -1;
      for (;;) {
        const page = repo.listConversationProposals(sessionId, {
          limit: 7,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (firstPendingCount === -1) {
          firstPendingCount = page.pendingCount;
        }
        expect(page.pendingCount).toBe(1);
        for (const item of page.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        pages += 1;
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(typeof page.nextCursor).toBe("string");
        cursor = page.nextCursor as string;
        expect(pages).toBeLessThan(30);
      }
      expect(seen.size).toBe(61);
      expect(seen.has(keeperId)).toBe(true);
      expect(firstPendingCount).toBe(1);

      // The pending queue reaches the buried draft directly.
      const queue = repo.listConversationProposals(sessionId, {
        limit: 50,
        status: "pending",
      });
      expect(queue.pendingCount).toBe(1);
      expect(queue.hasMore).toBe(false);
      expect(queue.items.map((item) => item.id)).toEqual([keeperId]);

      // Bad cursors fail closed; unknown cursor ids are just bounds.
      expect(() =>
        repo.listConversationProposals(sessionId, {
          limit: 10,
          cursor: "not-a-cursor!!",
        }),
      ).toThrow(RepositoryValidationError);
      const foreign = repo.listConversationProposals(sessionId, {
        limit: 100,
        cursor: await setupCursorFromOtherSession(repo),
      });
      expect(foreign.items.every((item) => item.sessionId === sessionId)).toBe(
        true,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

async function setupCursorFromOtherSession(
  repo: KernelRepository,
): Promise<string> {
  const other = repo.createSession({ key: randomUUID(), now: T0 });
  const otherId = other.body.sessionId as string;
  const posted = repo.postMessage(
    otherId,
    { text: "other session anchor text" },
    { key: randomUUID(), now: T0 },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: T0 + 1 });
  const staged = repo.stageConversationProposalFromModel(
    runId,
    {
      target: "purpose",
      scope: "health",
      draftKind: "wish",
      purposeKind: "goal",
      sourceQuote: "anchor text",
      interpretation: "foreign draft",
    },
    { key: randomUUID() },
  );
  void staged;
  repo.failRun(runId, "execution_failed", { now: T0 + 2 });
  const posted2 = repo.postMessage(
    otherId,
    { text: "other session second note" },
    { key: randomUUID(), now: T0 + 3 },
  );
  const runId2 = (posted2.body as { run: { id: string } }).run.id;
  repo.startRun(runId2, { now: T0 + 4 });
  const staged2 = repo.stageConversationProposalFromModel(
    runId2,
    {
      target: "purpose",
      scope: "health",
      draftKind: "wish",
      purposeKind: "goal",
      sourceQuote: "second note",
      interpretation: "foreign draft two",
    },
    { key: randomUUID() },
  );
  void staged2;
  // A REAL cursor minted for ANOTHER session: usable as an opaque bound
  // here without leaking whether its rows exist (no oracle).
  const page = repo.listConversationProposals(otherId, { limit: 1 });
  expect(page.hasMore).toBe(true);
  const cursor = page.nextCursor;
  expect(typeof cursor).toBe("string");
  return cursor as string;
}
