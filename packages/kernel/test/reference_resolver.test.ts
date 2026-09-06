// M1 ReferenceResolver tests (§14.7 exact order, §14.10): rN -> frozen
// selected -> frozen ordinal -> canonical exact -> title exact (frozen first,
// unique only). Ambiguous inputs are never guessed; semantic pronouns never
// resolve.

import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  createReferenceResolver,
  generateId,
  migrateKernelDatabase,
  openKernelDatabase,
  type ResourceObservation,
} from "../src/index.js";

const T0 = 1790000000000;

async function openStack() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const manager = createReferenceManager(handle.raw);
  const resolver = createReferenceResolver(handle.raw);
  return { handle, repo, manager, resolver };
}

function key(): string {
  return generateId();
}

function runningFixture(
  repo: ReturnType<typeof createKernelRepository>,
  now = T0,
) {
  const sessionId = repo.createSession({ key: key(), now }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "q" },
    { key: key(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function obs(
  connectorInstanceId: string,
  canonicalKey: string,
  text: string,
  extra: Partial<ResourceObservation> = {},
): ResourceObservation {
  return {
    connectorInstanceId,
    canonicalKey,
    title: null,
    text,
    sourceRevision: "rev-1",
    observedAt: T0,
    ...extra,
  };
}

describe("resolver exact priority", () => {
  it("resolves explicit rN session-wide and reports unknown rN", async () => {
    const { handle, repo, manager, resolver } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "text a", { title: "Alpha" }),
          obs(connector.id, "notes/b.md", "text b", { title: "Beta" }),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const second = presented.references[1];
      if (second === undefined) {
        throw new Error("expected two references");
      }
      expect(resolver.resolveByString(sessionId, "r2")).toEqual({
        outcome: "resolved",
        referenceId: second.referenceId,
        ordinal: 2,
      });
      expect(resolver.resolveByString(sessionId, "r99")).toEqual({
        outcome: "not-found",
        reason: "rN-not-found",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("selects the first frozen-context item on empty query", async () => {
    const { handle, repo, manager, resolver } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "text a"),
          obs(connector.id, "notes/b.md", "text b"),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const ids = presented.references.map((r) => r.referenceId);
      const frozen = [ids[1] as string, ids[0] as string];
      expect(
        resolver.resolveByString(sessionId, "", { frozenItems: frozen }),
      ).toEqual({
        outcome: "resolved",
        referenceId: ids[1],
        ordinal: 2,
      });
      expect(resolver.resolveByString(sessionId, "")).toEqual({
        outcome: "not-found",
        reason: "frozen-selected-empty",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("addresses the Nth frozen entry with bare digits", async () => {
    const { handle, repo, manager, resolver } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "text a"),
          obs(connector.id, "notes/b.md", "text b"),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const ids = presented.references.map((r) => r.referenceId);
      const frozen = [ids[1] as string, ids[0] as string];
      // "1" is the first FROZEN entry (ordinal 2), not r1.
      expect(
        resolver.resolveByString(sessionId, "1", { frozenItems: frozen }),
      ).toEqual({ outcome: "resolved", referenceId: ids[1], ordinal: 2 });
      expect(
        resolver.resolveByString(sessionId, "7", { frozenItems: frozen }),
      ).toEqual({ outcome: "not-found", reason: "frozen-ordinal-not-found" });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("matches canonical keys exactly and flags cross-instance ambiguity", async () => {
    const { handle, repo, manager, resolver } = await openStack();
    try {
      const first = manager.ensureMarkdownConnectorInstance("vault-a", 1, {
        now: T0,
      });
      const second = manager.ensureMarkdownConnectorInstance("vault-b", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [obs(first.id, "notes/shared.md", "text a")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const only = presented.references[0];
      if (only === undefined) {
        throw new Error("expected one reference");
      }
      expect(resolver.resolveByString(sessionId, "notes/shared.md")).toEqual({
        outcome: "resolved",
        referenceId: only.referenceId,
        ordinal: only.ordinal,
      });
      // Same key string under a second connector instance is ambiguous.
      const more = manager.presentObservations(
        sessionId,
        runId,
        [obs(second.id, "notes/shared.md", "text b")],
        { freshness: "normal", now: T0 + 6 },
      );
      if (!more.applied) {
        throw new Error("expected second presentation to apply");
      }
      const outcome = resolver.resolveByString(sessionId, "notes/shared.md");
      expect(outcome.outcome).toBe("ambiguous");
      if (outcome.outcome === "ambiguous") {
        expect(outcome.reason).toBe("canonical-key-ambiguous");
        expect(outcome.candidates).toHaveLength(2);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("prefers frozen titles and never guesses ambiguous titles", async () => {
    const { handle, repo, manager, resolver } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "text a", { title: "Dup" }),
          obs(connector.id, "notes/b.md", "text b", { title: "Dup" }),
          obs(connector.id, "notes/c.md", "text c", { title: "Solo" }),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const [a, b, c] = presented.references;
      if (a === undefined || b === undefined || c === undefined) {
        throw new Error("expected three references");
      }
      // Session-wide duplicate with no frozen scope is ambiguous.
      const ambiguous = resolver.resolveByString(sessionId, "Dup");
      expect(ambiguous.outcome).toBe("ambiguous");
      // Frozen scope narrows to the single frozen duplicate.
      expect(
        resolver.resolveByString(sessionId, "Dup", {
          frozenItems: [b.referenceId],
        }),
      ).toEqual({
        outcome: "resolved",
        referenceId: b.referenceId,
        ordinal: b.ordinal,
      });
      // Two frozen duplicates stay ambiguous (never first-hit guess).
      const frozenAmbiguous = resolver.resolveByString(sessionId, "Dup", {
        frozenItems: [a.referenceId, b.referenceId],
      });
      expect(frozenAmbiguous.outcome).toBe("ambiguous");
      // Unique session title resolves.
      expect(resolver.resolveByString(sessionId, "Solo")).toEqual({
        outcome: "resolved",
        referenceId: c.referenceId,
        ordinal: c.ordinal,
      });
      expect(resolver.resolveByString(sessionId, "Missing")).toEqual({
        outcome: "not-found",
        reason: "no-match",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never resolves semantic pronouns", async () => {
    const { handle, repo, manager, resolver } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "text a", { title: "this" })],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      // Even an exact title equal to a pronoun is not resolved.
      for (const pronoun of ["this", "that", "it", "それ", "さっきのやつ"]) {
        expect(resolver.resolveByString(sessionId, pronoun)).toEqual({
          outcome: "not-found",
          reason: "semantic-pronoun-unsupported",
        });
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
