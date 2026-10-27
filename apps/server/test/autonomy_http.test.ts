// AV autonomy HTTP behavioral test (real Hono app + real kernel DB).
//
// Exercises the ACTUAL routes end to end (no listener): purpose
// list/get/create/correct/revoke/achieve + explicit conflict record, task
// list/get/create/start/hold/resume/complete/cancel, and the global
// GET/POST autonomy control. Proves same-kind goals never auto-conflict,
// explicit pair record + cross-session 404, session-ownership 404s,
// replay-once idempotency, reused-key 409s, stale-CAS 409s,
// revoke-holds-dependent + no-blind-resume, null deadlines/windows, and that
// normal chat still admits while paused.

// UNION of HEAD (closed scope + idempotency lookup) + origin/master (correction omission + history pagination): all 5 its kept.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function makeApp(): Promise<CreatedServerApp & { close: () => void }> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-autonomy-")),
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
  return { ...created, close: () => closeKernelDatabase(handle) };
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

describe("autonomy HTTP", () => {
  it("runs the full purpose/task/control lifecycle with strict semantics", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      // Session bootstrap through the real route.
      const created = await post(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const other = await post(app, "/api/sessions", {}, randomUUID());
      const otherId = (other.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}`;

      // Control defaults to paused; conversation is never gated by it.
      const control = await get(app, "/api/autonomy/control");
      expect(control.status).toBe(200);
      expect((control.body as { paused: boolean }).paused).toBe(true);
      const chat = await post(
        app,
        `${base}/messages`,
        { text: "hello while paused" },
        randomUUID(),
      );
      expect(chat.status).toBe(202);

      // Purpose create + replay-once + key-reuse conflict.
      const key = randomUUID();
      const purposeBody = {
        scope: "health",
        statement: "walk daily",
        kind: "goal",
        explicit: true,
        sourceKind: "user",
      };
      const made = await post(app, `${base}/purposes`, purposeBody, key);
      expect(made.status).toBe(201);
      const purposeId = (made.body as { id: string }).id;
      const replay = await post(app, `${base}/purposes`, purposeBody, key);
      expect(replay.status).toBe(201);
      expect((replay.body as { id: string }).id).toBe(purposeId);
      const clash = await post(
        app,
        `${base}/purposes`,
        { ...purposeBody, statement: "different" },
        key,
      );
      expect(clash.status).toBe(409);
      expect((clash.body as { error: { code: string } }).error.code).toBe(
        "idempotency_key_reused",
      );

      // Ownership: foreign session reads are 404.
      const foreign = await get(
        app,
        `/api/sessions/${otherId}/purposes/${purposeId}`,
      );
      expect(foreign.status).toBe(404);
      // Unknown query keys are 400.
      const badQuery = await get(app, `${base}/purposes?unknown=1`);
      expect(badQuery.status).toBe(400);

      // Two independent same-kind goals never auto-conflict.
      const secondMade = await post(
        app,
        `${base}/purposes`,
        { ...purposeBody, statement: "run daily" },
        randomUUID(),
      );
      expect(secondMade.status).toBe(201);
      const secondId = (secondMade.body as { id: string }).id;
      const emptyConflicts = await get(app, `${base}/purpose-conflicts`);
      expect(emptyConflicts.status).toBe(200);
      expect(
        (emptyConflicts.body as { conflicts: unknown[] }).conflicts,
      ).toHaveLength(0);
      // Explicit owner-recorded pair only; cross-session pair is 404.
      const recorded = await post(
        app,
        `${base}/purpose-conflicts`,
        { purposeAId: purposeId, purposeBId: secondId },
        randomUUID(),
      );
      expect(recorded.status).toBe(201);
      const conflicts = await get(app, `${base}/purpose-conflicts`);
      expect(conflicts.status).toBe(200);
      expect(
        (conflicts.body as { conflicts: unknown[] }).conflicts,
      ).toHaveLength(1);
      const crossSession = await post(
        app,
        `/api/sessions/${otherId}/purpose-conflicts`,
        { purposeAId: purposeId, purposeBId: secondId },
        randomUUID(),
      );
      expect(crossSession.status).toBe(404);

      // Correct appends; stale CAS revoke is 409 with a fixed code.
      const corrected = await post(
        app,
        `${base}/purposes/${purposeId}/correct`,
        {
          expectedVersion: 1,
          scope: "health",
          statement: "walk twice daily",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        randomUUID(),
      );
      expect(corrected.status).toBe(201);
      expect(
        (corrected.body as { old: { statement: string } }).old.statement,
      ).toBe("walk daily");
      const stale = await post(
        app,
        `${base}/purposes/${purposeId}/revoke`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(stale.status).toBe(409);
      expect((stale.body as { error: { code: string } }).error.code).toBe(
        "autonomy_version_conflict",
      );

      // Task under the corrected (active) purpose; revoke holds it.
      const currentId = (
        corrected.body as { current: { id: string; version: number } }
      ).current.id;
      const tasked = await post(
        app,
        `${base}/tasks`,
        {
          scope: "health",
          title: "morning run",
          kind: "task",
          speaker: "user",
          parentPurposeId: currentId,
        },
        randomUUID(),
      );
      expect(tasked.status).toBe(201);
      const taskId = (tasked.body as { id: string }).id;
      const revoked = await post(
        app,
        `${base}/purposes/${currentId}/revoke`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(revoked.status).toBe(200);
      const held = await get(app, `${base}/tasks/${taskId}`);
      expect((held.body as { status: string }).status).toBe("held");
      // Blind resume (no new parent) is a state conflict.
      const blind = await post(
        app,
        `${base}/tasks/${taskId}/resume`,
        {
          expectedVersion: (held.body as { version: number }).version,
          evidenceKind: "user_confirmed",
          evidence: "just resume",
        },
        randomUUID(),
      );
      expect(blind.status).toBe(409);
      expect((blind.body as { error: { code: string } }).error.code).toBe(
        "autonomy_state_conflict",
      );

      // Achieve path + terminal task rule.
      const goal = await post(
        app,
        `${base}/purposes`,
        purposeBody,
        randomUUID(),
      );
      const goalId = (goal.body as { id: string }).id;
      const achieved = await post(
        app,
        `${base}/purposes/${goalId}/achieve`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(achieved.status).toBe(200);
      const solo = await post(
        app,
        `${base}/tasks`,
        { scope: "health", title: "solo", kind: "task", speaker: "user" },
        randomUUID(),
      );
      const soloId = (solo.body as { id: string }).id;
      const soloVersion = (solo.body as { version: number }).version;
      expect(
        await post(
          app,
          `${base}/tasks/${soloId}/start`,
          { expectedVersion: soloVersion },
          randomUUID(),
        ),
      ).toMatchObject({ status: 200 });
      const progressed = await get(app, `${base}/tasks/${soloId}`);
      const inProgress = (progressed.body as { version: number }).version;
      expect(
        await post(
          app,
          `${base}/tasks/${soloId}/hold`,
          {
            expectedVersion: inProgress,
            reason: "waiting",
            reconsiderTrigger: "signal",
          },
          randomUUID(),
        ),
      ).toMatchObject({ status: 200 });
      const heldAgain = await get(app, `${base}/tasks/${soloId}`);
      const heldVersion = (heldAgain.body as { version: number }).version;
      expect(
        await post(
          app,
          `${base}/tasks/${soloId}/resume`,
          {
            expectedVersion: heldVersion,
            evidenceKind: "user_confirmed",
            evidence: "signal arrived",
          },
          randomUUID(),
        ),
      ).toMatchObject({ status: 200 });
      const resumed = await get(app, `${base}/tasks/${soloId}`);
      const resumedVersion = (resumed.body as { version: number }).version;
      expect(
        await post(
          app,
          `${base}/tasks/${soloId}/complete`,
          { expectedVersion: resumedVersion },
          randomUUID(),
        ),
      ).toMatchObject({ status: 200 });
      // Completed tasks never revive.
      const revive = await post(
        app,
        `${base}/tasks/${soloId}/cancel`,
        { expectedVersion: resumedVersion + 1 },
        randomUUID(),
      );
      expect(revive.status).toBe(409);

      // Global control flips with CAS and stays queryable.
      const resumed2 = await post(
        app,
        "/api/autonomy/control",
        { paused: false, expectedVersion: 1 },
        randomUUID(),
      );
      expect(resumed2.status).toBe(200);
      expect((resumed2.body as { paused: boolean }).paused).toBe(false);
      const activity = await get(app, "/api/autonomy/activity?limit=50");
      expect(activity.status).toBe(200);
      const kinds = (activity.body as { items: { kind: string }[] }).items.map(
        (item) => item.kind,
      );
      expect(kinds).toContain("user_message");
    } finally {
      fixture.close();
    }
  });

  it("enforces the task scope wire contract (missing scope defaults)", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}`;
      const parent = await post(
        app,
        `${base}/purposes`,
        {
          scope: "health",
          statement: "scoped parent",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        randomUUID(),
      );
      const parentId = (parent.body as { id: string }).id;
      // Scope round-trips on create + read + list.
      const tasked = await post(
        app,
        `${base}/tasks`,
        {
          scope: "health",
          title: "scoped work",
          kind: "task",
          speaker: "user",
          parentPurposeId: parentId,
        },
        randomUUID(),
      );
      expect(tasked.status).toBe(201);
      expect((tasked.body as { scope: string }).scope).toBe("health");
      const read = await get(
        app,
        `${base}/tasks/${(tasked.body as { id: string }).id}`,
      );
      expect((read.body as { scope: string }).scope).toBe("health");
      // Cross-scope parent and unknown fields are refused by the strict wire
      // schema (both 400); missing scope falls back to the contract default
      // "default" (MERGE: master's defaulted-scope contract wins over HEAD's
      // closed-reject variant).
      expect(
        (
          await post(
            app,
            `${base}/tasks`,
            {
              scope: "work",
              title: "cross",
              kind: "task",
              speaker: "user",
              parentPurposeId: parentId,
            },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
      const scopedDefault = await post(
        app,
        `${base}/tasks`,
        { title: "no scope", kind: "task", speaker: "user" },
        randomUUID(),
      );
      expect(scopedDefault.status).toBe(201);
      expect((scopedDefault.body as { scope: string }).scope).toBe("default");
      expect(
        (
          await post(
            app,
            `${base}/tasks`,
            {
              scope: "health",
              title: "extra",
              kind: "task",
              speaker: "user",
              bogus: true,
            },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
    } finally {
      fixture.close();
    }
  });

  it("serves owned session idempotency lookups and 404s foreign/global scopes", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const first = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (first.body as { sessionId: string }).sessionId;
      const second = await post(app, "/api/sessions", {}, randomUUID());
      const otherId = (second.body as { sessionId: string }).sessionId;
      const key = randomUUID();
      const created = await post(
        app,
        `/api/sessions/${sessionId}/purposes`,
        {
          scope: "health",
          statement: "lookup probe",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        key,
      );
      expect(created.status).toBe(201);
      const scope = `session:${sessionId}:purpose`;
      const owned = await get(
        app,
        `/api/sessions/${sessionId}/idempotency/${key}?scope=${encodeURIComponent(scope)}`,
      );
      expect(owned.status).toBe(200);
      expect((owned.body as { found: boolean }).found).toBe(true);
      // Same scope+key through a foreign session: 404, never leaked.
      const foreign = await get(
        app,
        `/api/sessions/${otherId}/idempotency/${key}?scope=${encodeURIComponent(scope)}`,
      );
      expect(foreign.status).toBe(404);
      // Global control state is never exposed via a session lookup.
      const global = await get(
        app,
        `/api/sessions/${sessionId}/idempotency/${randomUUID()}?scope=autonomy%3Acontrol`,
      );
      expect(global.status).toBe(404);
    } finally {
      fixture.close();
    }
  });

  it("distinguishes correction omission from explicit null and replays terminal corrections verbatim", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}`;
      const windowed = {
        scope: "health",
        statement: "windowed goal",
        kind: "goal",
        explicit: true,
        sourceKind: "user",
        validFrom: "2026-11-01T00:00:00+09:00",
        validUntil: "2026-11-30T00:00:00+09:00",
      };
      const made = await post(app, `${base}/purposes`, windowed, randomUUID());
      expect(made.status).toBe(201);
      const purposeId = (made.body as { id: string }).id;
      const key = randomUUID();
      const preservedBody = {
        expectedVersion: 1,
        scope: "health",
        statement: "kept window",
        kind: "goal",
        explicit: true,
        sourceKind: "user",
      };
      const kept = await post(
        app,
        `${base}/purposes/${purposeId}/correct`,
        preservedBody,
        key,
      );
      expect(kept.status).toBe(201);
      expect(
        (kept.body as { current: { validFrom: string } }).current.validFrom,
      ).toBe(windowed.validFrom);
      // Same key with explicit null instead of omission is a key-reuse
      // conflict (never a silent merge of preserve vs clear).
      const clash = await post(
        app,
        `${base}/purposes/${purposeId}/correct`,
        { ...preservedBody, validFrom: null },
        key,
      );
      expect(clash.status).toBe(409);
      expect((clash.body as { error: { code: string } }).error.code).toBe(
        "idempotency_key_reused",
      );
      // A later state change (revoke the new record) does not alter the
      // stored correction: exact replay stays verbatim.
      const currentId = (kept.body as { current: { id: string } }).current.id;
      const revoked = await post(
        app,
        `${base}/purposes/${currentId}/revoke`,
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(revoked.status).toBe(200);
      const replay = await post(
        app,
        `${base}/purposes/${purposeId}/correct`,
        preservedBody,
        key,
      );
      expect(replay.status).toBe(201);
      expect((replay.body as { current: { id: string } }).current.id).toBe(
        currentId,
      );
      expect(
        (replay.body as { old: { statement: string } }).old.statement,
      ).toBe("windowed goal");
    } finally {
      fixture.close();
    }
  });

  it("paginates task history losslessly past 200 events and rejects invalid history queries", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const other = await post(app, "/api/sessions", {}, randomUUID());
      const otherId = (other.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}`;
      const tasked = await post(
        app,
        `${base}/tasks`,
        { scope: "health", title: "cycled", kind: "task", speaker: "user" },
        randomUUID(),
      );
      expect(tasked.status).toBe(201);
      const taskId = (tasked.body as { id: string }).id;
      let version = (tasked.body as { version: number }).version;
      // 100 hold/resume cycles => 201 valid events.
      for (let cycle = 0; cycle < 100; cycle += 1) {
        const held = await post(
          app,
          `${base}/tasks/${taskId}/hold`,
          {
            expectedVersion: version,
            reason: `waiting ${cycle}`,
            reconsiderTrigger: `signal ${cycle}`,
          },
          randomUUID(),
        );
        expect(held.status).toBe(200);
        version = (held.body as { version: number }).version;
        const resumed = await post(
          app,
          `${base}/tasks/${taskId}/resume`,
          {
            expectedVersion: version,
            evidenceKind: "user_confirmed",
            evidence: `signal arrived ${cycle}`,
          },
          randomUUID(),
        );
        expect(resumed.status).toBe(200);
        version = (resumed.body as { version: number }).version;
      }
      // The default page is bounded; consecutive pages yield exactly all
      // ordered distinct events (lossless, never rewritten).
      const first = await get(app, `${base}/tasks/${taskId}/history`);
      expect(first.status).toBe(200);
      const firstBody = first.body as {
        events: { seq: number }[];
        nextAfterSeq: number | null;
      };
      expect(firstBody.events.length).toBeLessThanOrEqual(200);
      expect(firstBody.nextAfterSeq).not.toBeNull();
      const seqs: number[] = [];
      let after = 0;
      for (;;) {
        const page = await get(
          app,
          `${base}/tasks/${taskId}/history?afterSeq=${after}&limit=50`,
        );
        expect(page.status).toBe(200);
        const pageBody = page.body as {
          events: { seq: number }[];
          nextAfterSeq: number | null;
        };
        expect(pageBody.events.length).toBeLessThanOrEqual(50);
        for (const event of pageBody.events) {
          seqs.push(event.seq);
        }
        if (pageBody.nextAfterSeq === null) {
          break;
        }
        after = pageBody.nextAfterSeq;
      }
      expect(seqs).toHaveLength(201);
      expect(seqs).toEqual(
        Array.from({ length: 201 }, (_, index) => index + 1),
      );
      // Purpose history carries the same cursor contract on small trails.
      const made = await post(
        app,
        `${base}/purposes`,
        {
          scope: "health",
          statement: "paged purpose",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        randomUUID(),
      );
      const purposeId = (made.body as { id: string }).id;
      const purposeHistory = await get(
        app,
        `${base}/purposes/${purposeId}/history`,
      );
      expect(purposeHistory.status).toBe(200);
      expect(
        (purposeHistory.body as { nextAfterSeq: unknown }).nextAfterSeq,
      ).toBeNull();
      // Ownership runs before history: foreign sessions are 404.
      const foreignTask = await get(
        app,
        `/api/sessions/${otherId}/tasks/${taskId}/history`,
      );
      expect(foreignTask.status).toBe(404);
      const foreignPurpose = await get(
        app,
        `/api/sessions/${otherId}/purposes/${purposeId}/history`,
      );
      expect(foreignPurpose.status).toBe(404);
      // Invalid history queries are rejected (never clamped or ignored).
      for (const bad of [
        `${base}/tasks/${taskId}/history?afterSeq=-1`,
        `${base}/tasks/${taskId}/history?limit=0`,
        `${base}/tasks/${taskId}/history?limit=201`,
        `${base}/tasks/${taskId}/history?unknown=1`,
        `${base}/purposes/${purposeId}/history?afterSeq=oops`,
        `${base}/purposes/${purposeId}/history?limit=201`,
      ]) {
        expect(await get(app, bad)).toMatchObject({ status: 400 });
      }
    } finally {
      fixture.close();
    }
  });
  it("notifies memory control on a committed control change without any shadow worker (memory-only wiring)", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    const config = loadServerConfig({
      COMPANION_DB_PATH: join(
        mkdtempSync(join(tmpdir(), "companion-autonomy-memonly-")),
        "db.sqlite",
      ),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "debug",
    });
    const { logger } = createCollectingLogger("debug");
    const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
    // Memory-only bootstrap shape: no shadowWake, but the control hook
    // (the worker notifyControl) IS provided so a committed control
    // change always reaches whatever worker is wired (the memory service
    // is deliberately independent of the pause per I03-09).
    let notified = 0;
    const created = createApp({
      config,
      repo,
      engine,
      logger,
      shadowControlChanged: () => {
        notified += 1;
      },
    });
    try {
      const control = await post(
        created.app,
        "/api/autonomy/control",
        { paused: false, expectedVersion: 1 },
        randomUUID(),
      );
      expect(control.status).toBe(200);
      expect(notified).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("confirms a chat-adopted goal only through the human route", async () => {
    const fixture = await makeApp();
    try {
      const { app } = fixture;
      const created = await post(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}`;
      // Adopted shape: non-explicit, self-sourced.
      const made = await post(
        app,
        `${base}/purposes`,
        {
          scope: "health",
          statement: "walk daily",
          kind: "goal",
          explicit: false,
          sourceKind: "self",
        },
        randomUUID(),
      );
      expect(made.status).toBe(201);
      const goalId = (made.body as { id: string }).id;
      const version = (made.body as { version: number }).version;

      // No Idempotency-Key is rejected before any write.
      const unkeyed = await post(app, `${base}/goals/${goalId}/confirm`, {
        expectedVersion: version,
      });
      expect(unkeyed.status).toBe(400);

      // Stale CAS is a 409 and does not promote.
      const stale = await post(
        app,
        `${base}/goals/${goalId}/confirm`,
        { expectedVersion: version + 7 },
        randomUUID(),
      );
      expect(stale.status).toBe(409);
      const before = await get(app, `${base}/purposes/${goalId}`);
      expect((before.body as { explicit: boolean }).explicit).toBe(false);

      const key = randomUUID();
      const ok = await post(
        app,
        `${base}/goals/${goalId}/confirm`,
        { expectedVersion: version },
        key,
      );
      expect(ok.status).toBe(200);
      expect((ok.body as { explicit: boolean }).explicit).toBe(true);
      expect((ok.body as { sourceKind: string }).sourceKind).toBe("user");
      // Same key replays byte-identically (still 200).
      const replay = await post(
        app,
        `${base}/goals/${goalId}/confirm`,
        { expectedVersion: version },
        key,
      );
      expect(replay.status).toBe(200);
      expect((replay.body as { version: number }).version).toBe(
        (ok.body as { version: number }).version,
      );
      // Already explicit under a NEW key: idempotent 200, no version bump.
      const again = await post(
        app,
        `${base}/goals/${goalId}/confirm`,
        { expectedVersion: (ok.body as { version: number }).version },
        randomUUID(),
      );
      expect(again.status).toBe(200);
      expect((again.body as { version: number }).version).toBe(
        (ok.body as { version: number }).version,
      );

      // Retired goals are 409.
      await post(
        app,
        `${base}/purposes/${goalId}/revoke`,
        { expectedVersion: (ok.body as { version: number }).version },
        randomUUID(),
      );
      const retired = await post(
        app,
        `${base}/goals/${goalId}/confirm`,
        { expectedVersion: (again.body as { version: number }).version + 1 },
        randomUUID(),
      );
      expect(retired.status).toBe(409);
    } finally {
      fixture.close();
    }
  });
});
