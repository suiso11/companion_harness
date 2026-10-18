// AV04 learning HTTP behavioral test (real Hono app + real kernel DB).
//
// Exercises the ACTUAL learning routes end to end (no listener):
// hypothesis create/list(scope-filtered keyset pages)/open, evidence
// attach anchored to a REAL rejected conversation proposal + keyset
// evidence pages, support transitions, and the explicit human `reaffirm`
// (keeps status, clears the reevaluation notice, allowed only while the
// notice is set). Proves stale CAS 409s after a revocation flag,
// unknown-source 404s on evidence attach, and that routine learning
// writes never touch control/purposes.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

async function makeApp(): Promise<
  CreatedServerApp & { repo: KernelRepository; close: () => void }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-learning-")),
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
  return { ...created, repo, close: () => closeKernelDatabase(handle) };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", host: "127.0.0.1", ...extra };
}

async function post(
  app: CreatedServerApp["app"],
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "POST",
    headers: headers(key === undefined ? {} : { "idempotency-key": key }),
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

describe("learning HTTP", () => {
  it("creates, scope-filters, anchors evidence, and reaffirms after revocation", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/learning/hypotheses`;
      const controlBefore = repo.getAutonomyControlState();

      // Two hypotheses in health, one in work.
      const h1 = await post(
        app,
        base,
        { scope: "health", kind: "method", statement: "first method" },
        randomUUID(),
      );
      expect(h1.status).toBe(201);
      await post(
        app,
        base,
        { scope: "health", kind: "hypothesis", statement: "second guess" },
        randomUUID(),
      );
      await post(
        app,
        base,
        { scope: "work", kind: "method", statement: "work method" },
        randomUUID(),
      );
      const id1 = (h1.body as { id: string }).id;

      // Scope filter is honored server-side (not JS-filtered).
      const scoped = await get(app, `${base}?scope=health&limit=50`);
      expect(scoped.status).toBe(200);
      expect((scoped.body as { items: unknown[] }).items).toHaveLength(2);
      const unscoped = await get(app, `${base}?limit=50`);
      expect((unscoped.body as { items: unknown[] }).items).toHaveLength(3);
      expect((await get(app, `${base}/${id1}`)).status).toBe(200);

      // Support h1, then stage + reject a conversation proposal to anchor
      // real `refutes` evidence (rejected proposals anchor only refutes).
      const support = await post(
        app,
        `${base}/${id1}/transition`,
        { expectedVersion: 1, transition: "support" },
        randomUUID(),
      );
      expect(support.status).toBe(200);
      const posted = repo.postMessage(
        sessionId,
        { text: "morning runs feel great" },
        { key: randomUUID(), now: Date.now() },
      );
      const runId = (posted.body as { run: { id: string } }).run.id;
      repo.startRun(runId, { now: Date.now() + 1 });
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "wish",
          purposeKind: "goal",
          sourceQuote: "morning runs feel great",
          interpretation: "wants a running habit",
        },
        { key: randomUUID() },
      );
      const proposalId = staged.body.id;
      const rejected = repo.rejectConversationProposal(
        sessionId,
        proposalId,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      expect(rejected.body.status).toBe("rejected");

      // Unknown source anchors fail closed with 404 (hypothesis untouched).
      const badEvidence = await post(
        app,
        `${base}/${id1}/evidence`,
        {
          polarity: "neutral",
          sourceKind: "task_event",
          sourceId: randomUUID(),
        },
        randomUUID(),
      );
      expect(badEvidence.status).toBe(404);
      expect((await get(app, `${base}/${id1}`)).status).toBe(200);

      // Real anchored evidence attaches (status never promoted by it).
      const goodEvidence = await post(
        app,
        `${base}/${id1}/evidence`,
        {
          polarity: "refutes",
          sourceKind: "conversation_proposal",
          sourceId: proposalId,
        },
        randomUUID(),
      );
      expect(goodEvidence.status).toBe(201);
      const evidence = await get(app, `${base}/${id1}/evidence?limit=50`);
      expect(evidence.status).toBe(200);
      const evidenceBody = evidence.body as {
        items: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(evidenceBody.items).toHaveLength(1);
      expect(evidenceBody.hasMore).toBe(false);
      expect(evidenceBody.nextCursor).toBeNull();

      // Revoking the parent flags h1 (version bump); stale CAS 409s.
      const purpose = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "walk daily",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: Date.now() },
      );
      const revoke = await post(
        app,
        `/api/sessions/${sessionId}/purposes/${purpose.body.id}/revoke`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(revoke.status).toBe(200);
      const flagged = (await get(app, `${base}/${id1}`)).body as {
        needsReevaluation: boolean;
        version: number;
        status: string;
      };
      expect(flagged.needsReevaluation).toBe(true);
      expect(flagged.version).toBe(3);
      const stale = await post(
        app,
        `${base}/${id1}/transition`,
        { expectedVersion: 2, transition: "retire" },
        randomUUID(),
      );
      expect(stale.status).toBe(409);

      // Explicit human reaffirm keeps the supported status and clears the
      // notice (audited, control/purposes untouched).
      const reaffirm = await post(
        app,
        `${base}/${id1}/reaffirm`,
        { expectedVersion: 3 },
        randomUUID(),
      );
      expect(reaffirm.status).toBe(200);
      const reaffirmed = reaffirm.body as {
        status: string;
        needsReevaluation: boolean;
      };
      expect(reaffirmed.status).toBe("supported");
      expect(reaffirmed.needsReevaluation).toBe(false);
      // The notice is gone: a second reaffirm is rejected.
      const second = await post(
        app,
        `${base}/${id1}/reaffirm`,
        { expectedVersion: 4 },
        randomUUID(),
      );
      expect(second.status).toBe(409);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
    } finally {
      fixture.close();
    }
  });

  it("pages evidence through limit/cursor without truncation", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/learning/hypotheses`;
      const hyp = await post(
        app,
        base,
        { scope: "health", kind: "hypothesis", statement: "paged" },
        randomUUID(),
      );
      const hypId = (hyp.body as { id: string }).id;

      const empty = await get(app, `${base}/${hypId}/evidence?limit=1`);
      expect(empty.status).toBe(200);
      const emptyBody = empty.body as {
        items: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(emptyBody.items).toHaveLength(0);
      expect(emptyBody.hasMore).toBe(false);
      expect(emptyBody.nextCursor).toBeNull();

      // Two anchored rows through the real route, then keyset paging.
      const posted = repo.postMessage(
        sessionId,
        { text: "evening walks help too" },
        { key: randomUUID(), now: Date.now() },
      );
      const runId = (posted.body as { run: { id: string } }).run.id;
      repo.startRun(runId, { now: Date.now() + 1 });
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "wish",
          purposeKind: "goal",
          sourceQuote: "evening walks help too",
          interpretation: "wants an evening habit",
        },
        { key: randomUUID() },
      );
      repo.rejectConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      for (let n = 0; n < 2; n += 1) {
        const attached = await post(
          app,
          `${base}/${hypId}/evidence`,
          {
            polarity: "refutes",
            sourceKind: "conversation_proposal",
            sourceId: staged.body.id,
            note: `anchor ${n}`,
          },
          randomUUID(),
        );
        expect(attached.status).toBe(201);
      }
      const first = await get(app, `${base}/${hypId}/evidence?limit=1`);
      expect(first.status).toBe(200);
      const firstBody = first.body as {
        items: { note: string | null }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(firstBody.items).toHaveLength(1);
      expect(firstBody.items[0]?.note).toBe("anchor 0");
      expect(firstBody.hasMore).toBe(true);
      expect(typeof firstBody.nextCursor).toBe("string");
      const second = await get(
        app,
        `${base}/${hypId}/evidence?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      );
      expect(second.status).toBe(200);
      const secondBody = second.body as {
        items: { note: string | null }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(secondBody.items).toHaveLength(1);
      expect(secondBody.items[0]?.note).toBe("anchor 1");
      expect(secondBody.hasMore).toBe(false);
      expect(secondBody.nextCursor).toBeNull();
    } finally {
      fixture.close();
    }
  });
});
