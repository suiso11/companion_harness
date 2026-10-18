// Review regression P2: one service wake converges a >1250-event backlog.
// REAL kernel repository + migrator + production notification service on
// real SQLite (:memory:). Backlog is built while the projector is stopped;
// a SINGLE start-wake must make every notice durable with no extra wake.

import { randomUUID } from "node:crypto";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { createNotificationService } from "../src/notification_service.js";

const T0 = 1_700_001_000_000;
const JOBS = 450;

function validOutput(
  evidenceIds: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    decision: "do-nothing",
    evidenceIds,
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
    ...extra,
  };
}

describe("review fix: single wake drains a >25-batch source backlog", () => {
  it("converges >1250 shadow source events to all notices on ONE wake", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const base = createKernelRepository(handle.raw, {
        actionProposals: { writeEnabled: true },
      });
      let nowValue = T0 + 10_000_000;
      const service = createNotificationService({
        db: handle.raw,
        repo: base,
        now: () => nowValue,
      });
      // Build the backlog while the projector is STOPPED: no wakes at all.
      const session = base.createSession({ key: randomUUID(), now: T0 });
      const sessionId = session.body.sessionId;
      base.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 10 },
      );
      let clock = T0 + 20;
      for (let i = 0; i < JOBS; i += 1) {
        const scope = `backlog${i}`;
        base.createAutonomyPurpose(
          sessionId,
          {
            scope,
            statement: `backlog goal ${i}`,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now: clock },
        );
        clock += 1;
        const requested = base.requestShadowDeliberation(
          sessionId,
          { scope },
          { key: randomUUID(), now: clock },
        );
        clock += 1;
        const claimed = base.claimShadowJob(
          sessionId,
          requested.body.id,
          { owner: "worker-1", expectedVersion: 1 },
          { now: clock },
        );
        clock += 1;
        const label = (claimed.context?.purposes ?? [])[0]?.label as string;
        base.completeShadowJob(
          sessionId,
          requested.body.id,
          validOutput([label], { decision: "ask", reason: `ask ${i}` }),
          { expectedVersion: 2, leaseOwner: "worker-1", now: clock },
        );
        clock += 1;
      }
      const totalEvents = (
        handle.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM shadow_job_events WHERE session_id = ?",
          )
          .get(sessionId) as { n: number }
      ).n;
      // Sanity: the backlog really exceeds 25 sweeps x 50 rows = 1250.
      expect(totalEvents).toBeGreaterThan(1250);
      // ONE wake (startup) must converge everything: no extra wake below.
      service.start();
      const start = Date.now();
      for (;;) {
        if (!service.busy) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!service.busy) break;
        }
        if (Date.now() - start > 30_000) {
          throw new Error("notification service did not settle");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      nowValue = clock + 1_000;
      let seen = 0;
      let after = 0;
      for (;;) {
        const page = base.listNotificationsForward(sessionId, {
          after,
          limit: 100,
        });
        seen += page.items.length;
        for (const item of page.items) {
          expect(item.kind).toBe("question");
        }
        if (!page.hasMore) break;
        after = page.nextAfter as number;
      }
      expect(seen).toBe(JOBS);
      const cursor = handle.raw
        .prepare(
          "SELECT last_source_rowid AS rowid FROM notification_cursors WHERE session_id = ? AND source = 'shadow_job_events'",
        )
        .get(sessionId) as { rowid: number };
      const maxRowid = (
        handle.raw
          .prepare(
            "SELECT MAX(rowid) AS max_rowid FROM shadow_job_events WHERE session_id = ?",
          )
          .get(sessionId) as { max_rowid: number }
      ).max_rowid;
      expect(cursor.rowid).toBe(maxRowid);
      expect(service.getDiagnostic()).toBeNull();
      await service.stop();
    } finally {
      closeKernelDatabase(handle);
    }
  }, 60_000);
});
