// AV03 conversation-proposal HTTP consumer vertical (real Hono + kernel DB).
//
// Exercises the ACTUAL session conversation-proposal routes end to end (no
// listener): list/get ownership (foreign ids are 404), accept-201 atomic
// adoption (ONE purpose/task with SELF provenance, explicit human dates
// only, target link + decision history), lost-response frozen retry (same
// key + same body replays ONE target), reused-key body drift (409),
// correct reject (200, creates nothing, terminal), stale/revoked parent
// (honest 409 with NOTHING created, fresh proposal required), and strict
// date rejection (model dates never exist; human dates must be strict
// RFC3339 with an explicit offset). Source HTML renders inert (verbatim
// JSON, textContent-only client).

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
      mkdtempSync(join(tmpdir(), "companion-conv-proposals-")),
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

/** Stage via the REAL kernel model-only path (server-derived OWN source). */
function stagePurpose(
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
      interpretation: "wants a daily walk habit",
    },
    { key: randomUUID() },
  );
  return { proposalId: (out.body as { id: string }).id, runId: body.run.id };
}

function stageTask(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  quote: string,
  parentId: string,
  parentVersion: number,
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
      target: "task",
      scope: "health",
      draftKind: "task",
      taskKind: "task",
      sourceQuote: quote,
      interpretation: "buy milk after work",
      parentPurposeId: parentId,
      expectedParentVersion: parentVersion,
    },
    { key: randomUUID() },
  );
  return { proposalId: (out.body as { id: string }).id, runId: body.run.id };
}

function makeParent(repo: KernelRepository, sessionId: string, now: number) {
  return repo.createAutonomyPurpose(
    sessionId,
    {
      scope: "health",
      statement: "stay healthy",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now },
  );
}

describe("conversation proposal HTTP", () => {
  it("lists/gets with ownership-first 404s and strict queries", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const a = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (a.body as { sessionId: string }).sessionId;
      const b = await post(app, "/api/sessions", {}, randomUUID());
      const foreignId = (b.body as { sessionId: string }).sessionId;

      const staged = stagePurpose(
        repo,
        sessionId,
        "i want to walk daily at 8am",
        "walk daily",
        T0,
      );
      const base = `/api/sessions/${sessionId}/conversation-proposals`;

      const listed = await get(app, `${base}?limit=50`);
      expect(listed.status).toBe(200);
      const items = (listed.body as { items: unknown[] }).items;
      expect(items).toHaveLength(1);
      const view = items[0] as Record<string, unknown>;
      expect(view.id).toBe(staged.proposalId);
      expect(view.status).toBe("pending");
      expect(view.sourceKind).toBe("model");
      expect(view.sourceQuote).toBe("walk daily");

      const one = await get(app, `${base}/${staged.proposalId}`);
      expect(one.status).toBe(200);

      // Foreign session reads are 404 (never 403), never leaked.
      const cross = await get(
        app,
        `/api/sessions/${foreignId}/conversation-proposals/${staged.proposalId}`,
      );
      expect(cross.status).toBe(404);
      const crossList = await get(
        app,
        `/api/sessions/${foreignId}/conversation-proposals?limit=50`,
      );
      expect((crossList.body as { items: unknown[] }).items).toHaveLength(0);

      // Strict gates: unknown query keys and bad limits are 400.
      expect((await get(app, `${base}?cursor=abc`)).status).toBe(400);
      expect((await get(app, `${base}?limit=500`)).status).toBe(400);
      expect((await get(app, `${base}/not-a-uuid`)).status).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("accepts a purpose draft atomically with frozen lost-response replay", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const a = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (a.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/conversation-proposals`;
      const staged = stagePurpose(
        repo,
        sessionId,
        "i want to walk daily at 8am",
        "walk daily",
        T0,
      );

      const key = randomUUID();
      const accepted = await post(
        app,
        `${base}/${staged.proposalId}/accept`,
        { expectedVersion: 1 },
        key,
      );
      expect(accepted.status).toBe(201);
      const out = accepted.body as {
        proposal: Record<string, unknown>;
        purpose: Record<string, unknown> | null;
        task: unknown;
      };
      expect(out.proposal.status).toBe("accepted");
      expect(out.task).toBeNull();
      // ONE purpose: quote kept verbatim, interpretation separate, inferred
      // SELF provenance, no human window (NULL stays NULL).
      expect(out.purpose?.statement).toBe("walk daily");
      expect(out.purpose?.interpretation).toBe("wants a daily walk habit");
      expect(out.purpose?.explicit).toBe(false);
      expect(out.purpose?.sourceKind).toBe("self");
      expect(out.purpose?.validFrom).toBeNull();
      expect(out.purpose?.validUntil).toBeNull();
      expect(out.proposal.acceptedTargetId).toBe(out.purpose?.id);

      // Lost-response frozen retry: same key + same body replays ONE target.
      const replay = await post(
        app,
        `${base}/${staged.proposalId}/accept`,
        { expectedVersion: 1 },
        key,
      );
      expect(replay.status).toBe(201);
      expect((replay.body as typeof out).proposal.acceptedTargetId).toBe(
        out.proposal.acceptedTargetId,
      );
      const purposes = await get(
        app,
        `/api/sessions/${sessionId}/purposes?limit=50`,
      );
      expect((purposes.body as { items: unknown[] }).items).toHaveLength(1);

      // Reused key with drifted body is an honest 409 (no false replay).
      const drift = await post(
        app,
        `${base}/${staged.proposalId}/accept`,
        { expectedVersion: 1, validFrom: "2026-10-20T09:00:00+09:00" },
        key,
      );
      expect(drift.status).toBe(409);

      // Fresh key on a decided proposal is a state conflict (never revived).
      const again = await post(
        app,
        `${base}/${staged.proposalId}/accept`,
        { expectedVersion: 2 },
        randomUUID(),
      );
      expect(again.status).toBe(409);
    } finally {
      fixture.close();
    }
  });

  it("rejects correctly: terminal 200, creates nothing, keyed replay", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const a = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (a.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/conversation-proposals`;
      const staged = stagePurpose(
        repo,
        sessionId,
        "i want to walk daily at 8am",
        "walk daily",
        T0,
      );

      const key = randomUUID();
      const rejected = await post(
        app,
        `${base}/${staged.proposalId}/reject`,
        { expectedVersion: 1 },
        key,
      );
      expect(rejected.status).toBe(200);
      expect((rejected.body as Record<string, unknown>).status).toBe(
        "rejected",
      );

      // Same-key replay is stable; nothing was created anywhere.
      const replay = await post(
        app,
        `${base}/${staged.proposalId}/reject`,
        { expectedVersion: 1 },
        key,
      );
      expect(replay.status).toBe(200);
      const purposes = await get(
        app,
        `/api/sessions/${sessionId}/purposes?limit=50`,
      );
      expect((purposes.body as { items: unknown[] }).items).toHaveLength(0);

      // Fresh key on a decided proposal is a state conflict.
      const again = await post(
        app,
        `${base}/${staged.proposalId}/reject`,
        { expectedVersion: 2 },
        randomUUID(),
      );
      expect(again.status).toBe(409);

      // Missing key and stale versions fail closed without mutations.
      const noKey = await post(app, `${base}/${staged.proposalId}/reject`, {
        expectedVersion: 2,
      });
      expect(noKey.status).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("refuses stale/revoked parents with nothing created", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const a = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (a.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/conversation-proposals`;
      const parent = makeParent(repo, sessionId, T0);
      const parentId = (parent.body as { id: string }).id;

      const staged = stageTask(
        repo,
        sessionId,
        "buy milk after work please",
        "buy milk",
        parentId,
        1,
        T0 + 10,
      );

      // Parent revoked after the draft: honest 409, fresh proposal required.
      const revoked = repo.revokeAutonomyPurpose(
        sessionId,
        parentId,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 20 },
      );
      expect(revoked.status).toBe(200);
      const denied = await post(
        app,
        `${base}/${staged.proposalId}/accept`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(denied.status).toBe(409);
      const tasks = await get(app, `/api/sessions/${sessionId}/tasks?limit=50`);
      expect((tasks.body as { items: unknown[] }).items).toHaveLength(0);
      // The draft stays pending (a fresh proposal is required, no autorename).
      const still = await get(app, `${base}/${staged.proposalId}`);
      expect((still.body as Record<string, unknown>).status).toBe("pending");
    } finally {
      fixture.close();
    }
  });

  it("accepts human-only strict dates and rejects everything else", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const a = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (a.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/conversation-proposals`;
      const parent = makeParent(repo, sessionId, T0);
      const parentId = (parent.body as { id: string }).id;

      // Task draft with an explicit human deadline adopts it exactly.
      const taskDraft = stageTask(
        repo,
        sessionId,
        "buy milk after work please",
        "buy milk",
        parentId,
        1,
        T0 + 10,
      );
      const withDeadline = await post(
        app,
        `${base}/${taskDraft.proposalId}/accept`,
        { expectedVersion: 1, deadline: "2026-10-20T09:00:00+09:00" },
        randomUUID(),
      );
      expect(withDeadline.status).toBe(201);
      const taskOut = withDeadline.body as {
        task: Record<string, unknown>;
        purpose: unknown;
      };
      expect(taskOut.task.deadline).toBe("2026-10-20T09:00:00+09:00");
      expect(taskOut.task.speaker).toBe("self");
      expect(taskOut.task.title).toBe("buy milk");
      expect(taskOut.purpose).toBeNull();

      // Purpose draft with an explicit human window adopts it exactly.
      const purposeDraft = stagePurpose(
        repo,
        sessionId,
        "i want to walk daily at 8am",
        "walk daily",
        T0 + 20,
        taskDraft.runId,
      );
      const withWindow = await post(
        app,
        `${base}/${purposeDraft.proposalId}/accept`,
        {
          expectedVersion: 1,
          validFrom: "2026-10-20T09:00:00+09:00",
          validUntil: "2026-10-27T09:00:00+09:00",
        },
        randomUUID(),
      );
      expect(withWindow.status).toBe(201);
      const purposeOut = withWindow.body as {
        purpose: Record<string, unknown>;
      };
      expect(purposeOut.purpose.validFrom).toBe("2026-10-20T09:00:00+09:00");
      expect(purposeOut.purpose.validUntil).toBe("2026-10-27T09:00:00+09:00");

      // Cross-target dates and loose dates are rejected (400), no writes.
      const badTarget = stageTask(
        repo,
        sessionId,
        "buy bread after work please",
        "buy bread",
        parentId,
        1,
        T0 + 30,
        purposeDraft.runId,
      );
      expect(
        (
          await post(
            app,
            `${base}/${badTarget.proposalId}/accept`,
            { expectedVersion: 1, validFrom: "2026-10-20T09:00:00+09:00" },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            app,
            `${base}/${badTarget.proposalId}/accept`,
            { expectedVersion: 1, deadline: "2026-10-20" },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
      const badPurpose = stagePurpose(
        repo,
        sessionId,
        "i want to nap daily at noon",
        "nap daily",
        T0 + 40,
        badTarget.runId,
      );
      expect(
        (
          await post(
            app,
            `${base}/${badPurpose.proposalId}/accept`,
            { expectedVersion: 1, deadline: "2026-10-20T09:00:00+09:00" },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("keeps source HTML inert and verbatim", async () => {
    const fixture = await makeApp();
    try {
      const { app, repo } = fixture;
      const a = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (a.body as { sessionId: string }).sessionId;
      const quote = "<img src=x onerror=alert(1)> walk";
      const staged = stagePurpose(
        repo,
        sessionId,
        `note: ${quote} daily`,
        quote,
        T0,
      );
      const listed = await get(
        app,
        `/api/sessions/${sessionId}/conversation-proposals?limit=50`,
      );
      const items = (listed.body as { items: Record<string, unknown>[] }).items;
      expect(items[0]?.sourceQuote).toBe(quote);
      expect(JSON.stringify(items[0])).toContain(quote);
      void staged;
    } finally {
      fixture.close();
    }
  });
});
