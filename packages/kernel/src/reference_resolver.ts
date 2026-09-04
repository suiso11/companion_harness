// M1 ReferenceResolver (§14.7): deterministic fixed-priority resolution.
//
// Exact priority (never reordered, never guessed):
//   1. explicit rN within the session (e.g. `r3`)
//   2. frozen selected reference (first ordered context item; empty query)
//   3. explicit ordinal within the frozen active set (digits `N` = Nth
//      frozen-context entry, 1-based position)
//   4. canonical key exact match
//   5. title exact match (frozen active first, then session; unique only)
//
// Unresolvable inputs yield explicit `ambiguous` / `not-found` outcomes.
// M1 never resolves semantic pronouns ("that thing", Japanese demonstratives,
// etc.); those inputs short-circuit to `not-found` with a dedicated reason.
//
// AMBIGUITY CHOICES (implementation-level, documented here):
// - Step 2 fires only on the empty query `""`. There is no keyword alias.
// - Step 3 interprets bare digits as the 1-based POSITION inside the frozen
//   ordered context (not the rN ordinal value). `rN` keeps the `r` prefix.
// - Step 4 compares canonical keys with exact (`===`) equality: no case
//   folding, no NFC. Keys are already normalized at write time.
// - Step 5 compares titles with exact (`===`) equality. Frozen-active matches
//   win over session-wide matches; any multiplicity within the searched scope
//   is `ambiguous`, never a first-hit guess.
// - The pronoun blocklist below is exact-lowercased matching; anything else
//   falls through the normal priority chain.

import type Database from "better-sqlite3";
import { isUuidV4 } from "./canonical.js";
import { RepositoryValidationError } from "./errors.js";

export interface ResolverReferenceView {
  id: string;
  ordinal: number;
  resourceId: string;
  snapshotId: string;
  canonicalKey: string;
  title: string | null;
}

export type ResolverOutcome =
  | { outcome: "resolved"; referenceId: string; ordinal: number }
  | {
      outcome: "ambiguous";
      reason: string;
      candidates: Array<{ referenceId: string; ordinal: number }>;
    }
  | { outcome: "not-found"; reason: string };

export interface ResolveStringOptions {
  /** Ordered frozen context items (SessionReference ids) for this Run. */
  frozenItems?: readonly string[];
}

/** Inputs that are never resolved semantically (M1 non-goal, §14.7). */
const SEMANTIC_PRONOUNS = new Set(
  [
    "it",
    "this",
    "that",
    "these",
    "those",
    "they",
    "them",
    "previous",
    "above",
    "earlier",
    "それ",
    "これ",
    "あれ",
    "どれ",
    "この",
    "その",
    "あの",
    "どの",
    "さっきのやつ",
    "さっきの",
    "まえの",
    "前の",
  ].map((entry) => entry.toLowerCase()),
);

function requireSession(sessionId: string): string {
  if (!isUuidV4(sessionId)) {
    throw new RepositoryValidationError("sessionId must be a UUID v4");
  }
  return sessionId;
}

function listSessionRefs(
  db: Database.Database,
  sessionId: string,
): ResolverReferenceView[] {
  const rows = db
    .prepare(
      `SELECT sr.id AS id, sr.ordinal AS ordinal, sr.resource_id AS resource_id,
              sr.snapshot_id AS snapshot_id, r.canonical_key AS canonical_key, r.title AS title
         FROM session_references sr
         JOIN resources r ON r.id = sr.resource_id
        WHERE sr.session_id = ?
        ORDER BY sr.ordinal ASC`,
    )
    .all(sessionId) as Array<{
    id: string;
    ordinal: number;
    resource_id: string;
    snapshot_id: string;
    canonical_key: string;
    title: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    resourceId: row.resource_id,
    snapshotId: row.snapshot_id,
    canonicalKey: row.canonical_key,
    title: row.title,
  }));
}

export function createReferenceResolver(db: Database.Database) {
  function resolveByString(
    sessionId: string,
    query: string,
    options: ResolveStringOptions = {},
  ): ResolverOutcome {
    const session = requireSession(sessionId);
    if (typeof query !== "string") {
      throw new RepositoryValidationError("query must be a string");
    }
    const frozenItems = [...(options.frozenItems ?? [])];
    for (const item of frozenItems) {
      if (!isUuidV4(item)) {
        throw new RepositoryValidationError(
          "frozenItems must contain UUID v4 reference ids",
        );
      }
    }

    // Semantic pronouns are never resolved (M1 non-goal). Short-circuit
    // before any priority step so they cannot accidentally match a title.
    if (SEMANTIC_PRONOUNS.has(query.toLowerCase())) {
      return { outcome: "not-found", reason: "semantic-pronoun-unsupported" };
    }

    const views = listSessionRefs(db, session);
    const byOrdinal = new Map(views.map((view) => [view.ordinal, view]));
    const byRefId = new Map(views.map((view) => [view.id, view]));

    // 1. Explicit rN (e.g. `r3`): session-wide ordinal lookup.
    const rMatch = /^r(\d+)$/.exec(query);
    if (rMatch?.[1] !== undefined) {
      const ordinal = Number.parseInt(rMatch[1] as string, 10);
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        return { outcome: "not-found", reason: "rN-out-of-range" };
      }
      const found = byOrdinal.get(ordinal);
      if (found === undefined) {
        return { outcome: "not-found", reason: "rN-not-found" };
      }
      return {
        outcome: "resolved",
        referenceId: found.id,
        ordinal: found.ordinal,
      };
    }

    // 2. Frozen selected reference: empty query selects the first ordered
    // frozen-context item that still exists in this session.
    if (query === "") {
      const first = frozenItems[0];
      if (first === undefined) {
        return { outcome: "not-found", reason: "frozen-selected-empty" };
      }
      const found = byRefId.get(first);
      if (found === undefined) {
        return { outcome: "not-found", reason: "frozen-selected-not-found" };
      }
      return {
        outcome: "resolved",
        referenceId: found.id,
        ordinal: found.ordinal,
      };
    }

    // 3. Explicit ordinal within the frozen active set: bare digits address
    // the 1-based POSITION inside the frozen ordered context.
    if (/^\d+$/.test(query)) {
      const position = Number.parseInt(query, 10);
      if (!Number.isSafeInteger(position) || position < 1) {
        return { outcome: "not-found", reason: "frozen-ordinal-out-of-range" };
      }
      const targetId = frozenItems[position - 1];
      if (targetId === undefined) {
        return { outcome: "not-found", reason: "frozen-ordinal-not-found" };
      }
      const found = byRefId.get(targetId);
      if (found === undefined) {
        return { outcome: "not-found", reason: "frozen-ordinal-not-found" };
      }
      return {
        outcome: "resolved",
        referenceId: found.id,
        ordinal: found.ordinal,
      };
    }

    // 4. Canonical key exact match (case-sensitive, no folding).
    const keyHits = views.filter((view) => view.canonicalKey === query);
    if (keyHits.length === 1) {
      const hit = keyHits[0] as ResolverReferenceView;
      return {
        outcome: "resolved",
        referenceId: hit.id,
        ordinal: hit.ordinal,
      };
    }
    if (keyHits.length > 1) {
      return {
        outcome: "ambiguous",
        reason: "canonical-key-ambiguous",
        candidates: keyHits.map((hit) => ({
          referenceId: hit.id,
          ordinal: hit.ordinal,
        })),
      };
    }

    // 5. Title exact match: frozen active first, then session; unique only.
    const frozenSet = new Set(frozenItems);
    const frozenViews = views.filter((view) => frozenSet.has(view.id));
    const frozenHits = frozenViews.filter((view) => view.title === query);
    if (frozenHits.length === 1) {
      const hit = frozenHits[0] as ResolverReferenceView;
      return {
        outcome: "resolved",
        referenceId: hit.id,
        ordinal: hit.ordinal,
      };
    }
    if (frozenHits.length > 1) {
      return {
        outcome: "ambiguous",
        reason: "title-ambiguous-frozen",
        candidates: frozenHits.map((hit) => ({
          referenceId: hit.id,
          ordinal: hit.ordinal,
        })),
      };
    }
    const sessionHits = views.filter((view) => view.title === query);
    if (sessionHits.length === 1) {
      const hit = sessionHits[0] as ResolverReferenceView;
      return {
        outcome: "resolved",
        referenceId: hit.id,
        ordinal: hit.ordinal,
      };
    }
    if (sessionHits.length > 1) {
      return {
        outcome: "ambiguous",
        reason: "title-ambiguous-session",
        candidates: sessionHits.map((hit) => ({
          referenceId: hit.id,
          ordinal: hit.ordinal,
        })),
      };
    }
    return { outcome: "not-found", reason: "no-match" };
  }

  function listForSession(sessionId: string): ResolverReferenceView[] {
    return listSessionRefs(db, requireSession(sessionId));
  }

  return { resolveByString, listForSession };
}

export type ReferenceResolver = ReturnType<typeof createReferenceResolver>;

/** Test-only helper: expose the pronoun blocklist for assertions. */
export const __testing = { SEMANTIC_PRONOUNS };
