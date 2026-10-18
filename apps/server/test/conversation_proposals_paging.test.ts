// AV03 review regressions: proposal list keyset contract over real HTTP.
//
// Exercises the ACTUAL session conversation-proposal list route (real Hono
// + kernel DB): opaque cursor pages cover every owned row exactly once
// (including an old pending draft buried under newer decisions), the
// pending queue filter reaches it directly, `pendingCount` always covers
// ALL owned pending, and malformed cursors / statuses / query keys fail
// closed without leaking foreign rows.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelRepository } from "@companion/kernel";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

const T0 = 1_769_000_000_000;

async function makeApp(): Promise<
  CreatedServerApp & { close: () => void; repo: KernelRepository }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-conv-paging-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  return { ...created, close: () => closeKernelDatabase(handle), repo };
}

async function post(
  app: CreatedServerApp["app"],
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key !== undefined) headers["idempotency-key"] = key;
  const response = await app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(
  app: CreatedServerApp["app"],
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
  return { status: response.status, body: await response.json() };
}

function stageOne(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  quote: string,
  now: number,
  priorRunId?: string,
): { proposalId: string; runId: string } {
  if (priorRunId !== undefined) {
    repo.failRun(priorRunId, "execution_failed", { now });
  }
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  const body = posted.body as { run: { id: string } };
  repo.startRun(body.run.id, { now: now + 1 });
  const out = repo.stageConversationProposalFromModel(
    body.run.id,
    {
      target: "purpose",
      scope: "health",
      draftKind: "wish",
      purposeKind: "goal",
      sourceQuote: quote,
      interpretation: `burst reading ${quote}`,
    },
    { key: randomUUID() },
  );
  return { proposalId: (out.body as { id: string }).id, runId: body.run.id };
}

interface PageBody {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
  pendingCount: number;
}

describe("conversation proposal list paging", () => {
  it("pages the full history exactly once with a truthful pending count", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/conversation-proposals`;

      // One old pending draft, then 55 decided drafts (all sharing nearby
      // timestamps so the keyset tie-break does real work).
      const keeper = stageOne(
        repo,
        sessionId,
        "note keeper choice end",
        "keeper choice",
        T0,
      );
      let prior = keeper.runId;
      for (let i = 0; i < 55; i += 1) {
        const staged = stageOne(
          repo,
          sessionId,
          `burst filler ${i} marker`,
          `filler ${i} marker`,
          T0,
          prior,
        );
        prior = staged.runId;
        const decided = await post(
          app,
          `${base}/${staged.proposalId}/reject`,
          { expectedVersion: 1 },
          randomUUID(),
        );
        expect(decided.status).toBe(200);
      }

      // Walk every page: 56 distinct ids, pendingCount always complete.
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const path =
          cursor === null
            ? `${base}?limit=7`
            : `${base}?limit=7&cursor=${encodeURIComponent(cursor)}`;
        const res = await get(app, path);
        expect(res.status).toBe(200);
        const page = res.body as PageBody;
        expect(page.pendingCount).toBe(1);
        expect(page.items.length).toBeLessThanOrEqual(7);
        for (const item of page.items) {
          expect(seen.has(item.id as string)).toBe(false);
          seen.add(item.id as string);
          expect(item.sessionId).toBe(sessionId);
        }
        pages += 1;
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(typeof page.nextCursor).toBe("string");
        cursor = page.nextCursor;
        expect(pages).toBeLessThan(30);
      }
      expect(seen.size).toBe(56);
      expect(seen.has(keeper.proposalId)).toBe(true);

      // The pending queue reaches the buried draft without paging history.
      const queue = await get(app, `${base}?limit=50&status=pending`);
      expect(queue.status).toBe(200);
      const queueBody = queue.body as PageBody;
      expect(queueBody.pendingCount).toBe(1);
      expect(queueBody.hasMore).toBe(false);
      expect(queueBody.items.map((item) => item.id)).toEqual([
        keeper.proposalId,
      ]);

      // The decided filter never leaks the pending draft.
      const decided = await get(app, `${base}?limit=100&status=rejected`);
      expect(decided.status).toBe(200);
      const decidedBody = decided.body as PageBody;
      expect(decidedBody.items).toHaveLength(55);
      expect(decidedBody.pendingCount).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it("fails closed on bad cursors, statuses, and query keys", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/conversation-proposals`;
      stageOne(repo, sessionId, "note lone thought end", "lone thought", T0);

      expect((await get(app, `${base}?limit=50&cursor=!!!`)).status).toBe(400);
      expect(
        (
          await get(
            app,
            `${base}?limit=50&cursor=${encodeURIComponent("missing")}`,
          )
        ).status,
      ).toBe(400);
      expect((await get(app, `${base}?limit=50&status=archived`)).status).toBe(
        400,
      );
      expect((await get(app, `${base}?limit=50&offset=10`)).status).toBe(400);
      expect((await get(app, `${base}?limit=50&limit=10`)).status).toBe(400);

      // A cursor minted for another session is just an opaque bound: 200,
      // own rows only, never a foreign-row oracle.
      const other = await post(app, "/api/sessions", {}, randomUUID());
      const foreignId = (other.body as { sessionId: string }).sessionId;
      const foreignBase = `/api/sessions/${foreignId}/conversation-proposals`;
      const foreignFirst0 = stageOne(
        repo,
        foreignId,
        "foreign anchor text",
        "anchor text",
        T0,
      );
      const foreignOne = stageOne(
        repo,
        foreignId,
        "foreign second note",
        "second note",
        T0 + 1,
        foreignFirst0.runId,
      );
      void foreignOne;
      const foreignFirst = (await get(app, `${foreignBase}?limit=1`))
        .body as PageBody;
      expect(foreignFirst.hasMore).toBe(true);
      expect(typeof foreignFirst.nextCursor).toBe("string");
      const cross = await get(
        app,
        `${base}?limit=50&cursor=${encodeURIComponent(foreignFirst.nextCursor as string)}`,
      );
      expect(cross.status).toBe(200);
      const crossBody = cross.body as PageBody;
      expect(
        crossBody.items.every((item) => item.sessionId === sessionId),
      ).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
