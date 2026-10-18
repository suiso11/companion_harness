// AV04 Codex #47 review regressions (kernel half).
//
// Proves through the REAL kernel repository + migrator (in-memory DB,
// zero mocks):
// - rejecting a staged model hypothesis clears a pending
//   `needs_reevaluation` notice (terminal retire + unactionable notice
//   would otherwise stick forever) and audits `reevaluation_cleared`;
// - purpose revocation flags in-scope `refuted` hypotheses too (the
//   declared reaffirm path for flagged refuted rows is otherwise
//   unreachable), and a human can reaffirm a flagged refuted row.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_019_000_000;

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId as string,
  };
}

function makePurpose(
  repo: KernelRepository,
  sessionId: string,
  now: number,
  scope = "health",
) {
  return repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: "walk daily",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now },
  );
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  now: number,
): string {
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: now + 1 });
  return runId;
}

describe("learning codex47 review regressions", () => {
  it("rejecting a flagged staged hypothesis retires it with the notice cleared", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 10);
      const runId = newRunningRun(
        repo,
        sessionId,
        "morning pages help",
        T0 + 20,
      );
      const staged = repo.proposeLearningHypothesisFromModel(
        runId,
        { scope: "health", kind: "method", statement: "staged method" },
        { key: randomUUID(), now: T0 + 21 },
      );
      expect(staged.status).toBe(201);
      expect(staged.body.staged).toBe(true);
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 22 },
      );
      const flagged = repo.getLearningHypothesis(sessionId, staged.body.id);
      expect(flagged.needsReevaluation).toBe(true);
      const rejected = repo.rejectLearningHypothesis(
        sessionId,
        staged.body.id,
        { expectedVersion: flagged.version },
        { key: randomUUID(), now: T0 + 23 },
      );
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe("retired");
      expect(rejected.body.needsReevaluation).toBe(false);
      const events = repo.listLearningHypothesisEvents(
        sessionId,
        staged.body.id,
      );
      expect(
        events.events.some((event) => event.event === "reevaluation_cleared"),
      ).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("revocation flags refuted hypotheses and reaffirm keeps refuted", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 10);
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "refuted method" },
        { key: randomUUID(), now: T0 + 11 },
      );
      const refuted = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 1, transition: "refute" },
        { key: randomUUID(), now: T0 + 12 },
      );
      expect(refuted.body.status).toBe("refuted");
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 13 },
      );
      const flagged = repo.getLearningHypothesis(sessionId, hyp.body.id);
      expect(flagged.needsReevaluation).toBe(true);
      const reaffirmed = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: flagged.version, transition: "reaffirm" },
        { key: randomUUID(), now: T0 + 14 },
      );
      expect(reaffirmed.body.status).toBe("refuted");
      expect(reaffirmed.body.needsReevaluation).toBe(false);
      const events = repo.listLearningHypothesisEvents(sessionId, hyp.body.id);
      expect(
        events.events.some((event) => event.event === "reevaluation_flagged"),
      ).toBe(true);
      expect(events.events.some((event) => event.event === "reaffirmed")).toBe(
        true,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
