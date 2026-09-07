// Server structured-result regression (PR #4 r3943445771): history and
// events HTTP payloads retain the durable V2 answer (exact citations)
// while the exact M0 envelope still rejects V2 rows.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunResultV2,
  EventsResponseSchema,
  M0EventsResponseSchema,
  M0RunEventSchema,
  M1EventsResponseSchema,
  parseM0RunEvent,
} from "@companion/contracts";
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

const T0 = 1790000000000;

async function makeApp(): Promise<
  CreatedServerApp & { repo: KernelRepository; close: () => void }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-structured-")),
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

describe("structured result over HTTP (V2 durable, M0 pinned)", () => {
  it("history and events retain V2 citations; exact M0 rejects V2", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "research this" },
        { key: randomUUID(), now: T0 + 1 },
      );
      const runId = posted.body.run.id;
      f.repo.startRun(runId, { now: T0 + 2 });
      const durable = buildRunResultV2({
        version: 1,
        parts: [
          { text: "first", citations: [] },
          { text: "second", citations: ["r1"] },
        ],
      });
      expect(f.repo.completeRun(runId, durable, { now: T0 + 3 }).applied).toBe(
        true,
      );

      const history = await f.app.request(
        `/api/sessions/${sessionId}/history`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(history.status).toBe(200);
      const historyBody = (await history.json()) as {
        items: Array<{
          selectedRun: { result: unknown } | null;
        }>;
      };
      expect(historyBody.items).toHaveLength(1);
      // Durable/API data retains the exact part-to-citations mapping.
      expect(historyBody.items[0]?.selectedRun?.result).toEqual(durable);

      const events = await f.app.request(
        `/api/sessions/${sessionId}/runs/${runId}/events`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(events.status).toBe(200);
      const eventsBody = (await events.json()) as {
        events: Array<{ type: string; payload: { result?: unknown } }>;
      };
      const done = eventsBody.events.find((e) => e.type === "run.completed");
      expect(done?.payload.result).toEqual(durable);

      // Generic/latest HTTP page aligns with repository output (V2 row).
      expect(() => EventsResponseSchema.parse(eventsBody)).not.toThrow();
      expect(
        EventsResponseSchema.parse(eventsBody).events.map((e) => e.type),
      ).toContain("run.completed");

      // Exact M0 envelope acceptance is unchanged: V2 rows are rejected.
      expect(() =>
        parseM0RunEvent({
          schemaVersion: 1,
          runId,
          seq: 1,
          createdAt: T0,
          type: "run.completed",
          payload: { result: durable },
        }),
      ).toThrow();
      expect(() =>
        M0RunEventSchema.parse({
          schemaVersion: 1,
          runId,
          seq: 1,
          createdAt: T0,
          type: "run.completed",
          payload: { result: { version: 1, text: "legacy" } },
        }),
      ).not.toThrow();
    } finally {
      f.close();
    }
  });

  it("serves model.step.* via the generic/latest page; exact M0/M1 pages reject them", async () => {
    const f = await makeApp();
    try {
      const sessionId = f.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "agent work" },
        { key: randomUUID(), now: T0 + 1 },
      );
      const runId = posted.body.run.id;
      f.repo.appendModelStepEvent(
        runId,
        "model.step.started",
        { step: 1 },
        { now: T0 + 2 },
      );

      const events = await f.app.request(
        `/api/sessions/${sessionId}/runs/${runId}/events`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(events.status).toBe(200);
      const eventsBody = (await events.json()) as unknown;
      // Generic/latest HTTP page validates the repository output.
      const page = EventsResponseSchema.parse(eventsBody);
      expect(page.events.map((e) => e.type)).toContain("model.step.started");
      // Structural metadata only: no prompt/content/raw output keys.
      const started = page.events.find(
        (e) => e.type === "model.step.started",
      ) as unknown as { payload: Record<string, unknown> };
      expect(started.payload).toEqual({ step: 1 });
      // Exact legacy pages stay closed: M0 and M1 both reject model.step.*.
      expect(() => M0EventsResponseSchema.parse(eventsBody)).toThrow();
      expect(() => M1EventsResponseSchema.parse(eventsBody)).toThrow();
      // Unknown future event names are still rejected by the latest page.
      expect(() =>
        EventsResponseSchema.parse({
          ...(page as Record<string, unknown>),
          events: [
            {
              schemaVersion: 1,
              runId,
              seq: 999,
              createdAt: T0,
              type: "model.step.delta",
              payload: {},
            },
          ],
        }),
      ).toThrow();
    } finally {
      f.close();
    }
  });
});
