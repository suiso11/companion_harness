// Durable per-session learning store behavior: exact-content approval,
// rejection, persistence across restart, dedup by accepted run, and strict
// session binding for approved-lesson retrieval/applications.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLearningStore,
  formatLessonPromptBlock,
  type LearningCandidate,
  learningContentHash,
  RepositoryValidationError,
} from "../src/index.js";

const T0 = 1790000000000;
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const RUN = "run-learning-1";
const TURN = "turn-learning-1";

const candidate: LearningCandidate = {
  kind: "user_confirmed_feedback",
  lesson: "Use ISO dates when changing calendar events",
  evidence: "use ISO dates",
  applicability: "calendar date changes",
};

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

function storeAt(path: string) {
  return createLearningStore({ path, clock: { now: () => T0 } });
}

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "learning-"));
  cleanups.push(dir);
  return join(dir, "state", "learning.sqlite");
}

describe("learning store", () => {
  it("keeps candidates pending until the exact content hash is approved", () => {
    const store = storeAt(tempPath());
    try {
      const captured = store.captureReflection({
        sessionId: SESSION,
        runId: RUN,
        turnId: TURN,
        candidates: [candidate],
      });
      expect(captured.proposals).toHaveLength(1);
      const proposal = captured.proposals[0];
      expect(proposal?.status).toBe("pending");
      expect(proposal?.contentHash).toBe(learningContentHash(candidate));
      expect(store.listApprovedForSession(SESSION)).toHaveLength(0);

      // A different hash (any content change) can never approve this row.
      expect(() =>
        store.approve(proposal?.id as string, "0".repeat(64)),
      ).toThrow(RepositoryValidationError);
      expect(store.show(proposal?.id as string).status).toBe("pending");

      const approved = store.approve(
        proposal?.id as string,
        proposal?.contentHash as string,
      );
      expect(approved.status).toBe("approved");
      expect(store.listApprovedForSession(SESSION)).toHaveLength(1);
      expect(store.listApprovedForSession(OTHER_SESSION)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("persists approval across restart and never reopens a rejection", () => {
    const path = tempPath();
    const first = storeAt(path);
    let approvedId = "";
    let rejectedId = "";
    try {
      const captured = first.captureReflection({
        sessionId: SESSION,
        runId: RUN,
        turnId: TURN,
        candidates: [
          candidate,
          {
            ...candidate,
            lesson: "Ask before destructive edits",
            evidence: "use ISO dates",
          },
        ],
      });
      approvedId = captured.proposals[0]?.id as string;
      rejectedId = captured.proposals[1]?.id as string;
      first.approve(approvedId, captured.proposals[0]?.contentHash as string);
      first.reject(rejectedId);
    } finally {
      first.close();
    }

    const second = storeAt(path);
    try {
      expect(second.show(approvedId).status).toBe("approved");
      expect(second.show(rejectedId).status).toBe("rejected");
      expect(
        second.listApprovedForSession(SESSION).map((row) => row.id),
      ).toEqual([approvedId]);
      expect(() =>
        second.approve(rejectedId, second.show(rejectedId).contentHash),
      ).toThrow(RepositoryValidationError);
    } finally {
      second.close();
    }
  });

  it("dedups one accepted run and binds applications to the same session", () => {
    const store = storeAt(tempPath());
    try {
      const first = store.captureReflection({
        sessionId: SESSION,
        runId: RUN,
        turnId: TURN,
        candidates: [candidate],
      });
      const replay = store.captureReflection({
        sessionId: SESSION,
        runId: RUN,
        turnId: TURN,
        candidates: [candidate],
      });
      expect(replay.deduplicated).toBe(true);
      expect(store.listProposals()).toHaveLength(1);
      expect(store.findReflectionByRun(RUN)?.id).toBe(first.reflection.id);
      expect(store.findReflectionByRun("run-missing")).toBeNull();

      const proposal = first.proposals[0];
      store.approve(proposal?.id as string, proposal?.contentHash as string);
      const applied = store.recordApplication({
        sessionId: SESSION,
        runId: "run-next",
        proposalId: proposal?.id as string,
      });
      expect(applied.proposalId).toBe(proposal?.id);
      expect(store.listApplications(SESSION)).toHaveLength(1);
      expect(store.listApplications(OTHER_SESSION)).toHaveLength(0);
      expect(() =>
        store.recordApplication({
          sessionId: OTHER_SESSION,
          runId: "run-cross",
          proposalId: proposal?.id as string,
        }),
      ).toThrow(RepositoryValidationError);
    } finally {
      store.close();
    }
  });

  it("rejects unknown extra content and invalid kinds at the boundary", () => {
    const store = storeAt(tempPath());
    try {
      expect(() =>
        store.captureReflection({
          sessionId: SESSION,
          runId: RUN,
          turnId: TURN,
          candidates: [
            {
              ...candidate,
              kind: "instruction" as unknown as LearningCandidate["kind"],
            },
          ],
        }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        store.captureReflection({
          sessionId: SESSION,
          runId: RUN,
          turnId: TURN,
          candidates: [
            { ...candidate, extra: "trust me" } as LearningCandidate,
          ],
        }),
      ).toThrow(RepositoryValidationError);
    } finally {
      store.close();
    }
  });
});

describe("approved lesson projection", () => {
  it("labels every kind and only attributes user-confirmed lessons to the user", () => {
    const snippet = (id: string, kind: string) => ({
      id,
      kind,
      lesson: `${kind} lesson`,
      evidence: `evidence for ${kind}`,
      applicability: "when relevant",
      provenance: `run=${id}`,
    });
    const block = formatLessonPromptBlock([
      snippet("l1", "user_confirmed_feedback"),
      snippet("l2", "observation"),
      snippet("l3", "model_inference"),
    ]);
    // Each lesson keeps its kind label.
    expect(block).toContain("[user_confirmed_feedback]");
    expect(block).toContain("[observation]");
    expect(block).toContain("[model_inference]");
    // The header is explicit that only user-confirmed lessons are attributed
    // to the user; all other kinds are unverified model observations.
    expect(block).toContain(
      "Only lessons labelled [user_confirmed_feedback] reflect what the user actually said",
    );
    expect(block).toContain("unverified model observation");
  });
});
