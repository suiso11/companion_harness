// M1 ReferenceManager (§4, §14.2-§14.4): kernel-owned identity for
// CanonicalResource / ResourceSnapshot / SessionReference (rN).
//
// External I/O is NEVER performed here: callers (Markdown connector reads,
// ToolBroker handlers) read first, then hand already-read ephemeral
// `ResourceObservation` facts to the transaction methods below, which run a
// single short `BEGIN IMMEDIATE` transaction that rechecks Run ownership +
// `running` status before committing resources / snapshots / references /
// reference set + items / `reference.presented` events atomically. Any
// cancelled/terminal Run rolls everything back (including resource/title
// updates): post-cancel observations persist nothing.
//
// AMBIGUITY CHOICES (implementation-level, documented here):
// - `contentHash` = SHA-256 hex of the NFC-normalized full text (UTF-8).
//   `sizeBytes` = UTF-8 byte length of that same normalized text.
//   Connector-supplied hashes/sizes are never accepted.
// - `bodyJson` = `{ version: 1, text: <NFC text> }` (contracts
//   `SnapshotBodySchema`, 1MiB enforced, no silent truncation).
// - `sourceRevision` is an opaque upstream signal compared with `===`
//   against the latest snapshot (`NULL` equals only `NULL`). A changed
//   revision always materializes a new Snapshot even when the content hash
//   is identical.
// - Snippets are deterministic 512-code-point prefixes of the normalized
//   text (empty text falls back to `title ?? canonicalKey`). The manager has
//   no search query, so query-relative excerpts stay a connector concern.
// - Zero-hit presentations (`[]` observations or `[]` stored ids) write
//   nothing: no ReferenceSet, no items, no events (`setId: null`).
// - Connector `config_json` is metadata-only `{ version: 1, rootCount }`.
//   Absolute paths / separators are rejected at the boundary.
// - `reference.presented` payloads carry structural IDs/ordinals only.

import {
  CanonicalKeySchema,
  countCodePoints,
  MAX_SNIPPET_CODE_POINTS,
  parseRunEventPayload,
  ReferencePresentedPayloadSchema,
  ReferenceTitleSchema,
  RUN_EVENT_SCHEMA_VERSION,
  SnapshotBodySchema,
  SourceRevisionSchema,
  utf8ByteLength,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { generateId, isUuidV4, sha256Hex } from "./canonical.js";
import {
  InvalidReferenceError,
  KernelStorageError,
  ReferenceNotFoundError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";

/* ------------------------------------------------------------------ */
/* Observation (ephemeral, never persisted as-is)                        */
/* ------------------------------------------------------------------ */

/** One already-read external fact. Ephemeral: not evidence until committed. */
export interface ResourceObservation {
  connectorInstanceId: string;
  canonicalKey: string;
  title: string | null;
  /** Raw external text (any normalization); kernel NFC-normalizes. */
  text: string;
  /** Opaque upstream revision signal (content-derived for Markdown). */
  sourceRevision: string | null;
  observedAt: number;
}

export type FreshnessKind = "normal" | "refresh";

export interface PresentedReferenceView {
  referenceId: string;
  ordinal: number;
  snapshotId: string;
  resourceId: string;
  canonicalKey: string;
  title: string | null;
  snippet: string;
}

export type PresentObservationsResult =
  | {
      applied: true;
      setId: string | null;
      references: PresentedReferenceView[];
    }
  | { applied: false; status: string; setId: null; references: [] };

export type PresentStoredResult =
  | {
      applied: true;
      setId: string | null;
      references: PresentedReferenceView[];
    }
  | { applied: false; status: string; setId: null; references: [] };

export interface MarkdownConnectorView {
  id: string;
  kind: string;
  displayName: string;
  rootCount: number;
  createdAt: number;
}

const CONNECTOR_CONFIG_VERSION = 1 as const;

function nowMs(input?: number): number {
  const now = input ?? Date.now();
  if (!Number.isInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw new RepositoryValidationError(
      "now must be an integer Unix-ms timestamp",
    );
  }
  return now;
}

function requireId(id: unknown, what: string): string {
  if (!isUuidV4(id)) {
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  }
  return id;
}

function withImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Best effort: the original error carries the failure.
    }
    throw error;
  }
}

function normalizeObservation(raw: ResourceObservation): {
  connectorInstanceId: string;
  canonicalKey: string;
  title: string | null;
  text: string;
  sourceRevision: string | null;
  observedAt: number;
} {
  const connectorInstanceId = requireId(
    raw.connectorInstanceId,
    "connectorInstanceId",
  );
  let canonicalKey: string;
  try {
    canonicalKey = CanonicalKeySchema.parse(raw.canonicalKey);
  } catch (error) {
    throw new RepositoryValidationError(
      `canonicalKey invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let title: string | null = null;
  if (raw.title !== null && raw.title !== undefined) {
    if (typeof raw.title !== "string") {
      throw new RepositoryValidationError("title must be a string");
    }
    // NFC normalization only: no case folding or locale-dependent transform.
    const normalizedTitle = raw.title.normalize("NFC");
    try {
      title = ReferenceTitleSchema.parse(normalizedTitle);
    } catch (error) {
      throw new RepositoryValidationError(
        `title invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  if (typeof raw.text !== "string") {
    throw new RepositoryValidationError("observation text must be a string");
  }
  const text = raw.text.normalize("NFC");
  try {
    SnapshotBodySchema.parse({ version: 1, text });
  } catch (error) {
    throw new RepositoryValidationError(
      `snapshot body invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let sourceRevision: string | null = null;
  if (raw.sourceRevision !== null && raw.sourceRevision !== undefined) {
    try {
      sourceRevision = SourceRevisionSchema.parse(raw.sourceRevision);
    } catch (error) {
      throw new RepositoryValidationError(
        `sourceRevision invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const observedAt = nowMs(raw.observedAt);
  return {
    connectorInstanceId,
    canonicalKey,
    title,
    text,
    sourceRevision,
    observedAt,
  };
}

/** Deterministic prefix excerpt (manager has no search query). */
export function deriveSnippet(
  normalizedText: string,
  title: string | null,
  canonicalKey: string,
): string {
  const source =
    normalizedText.length > 0 ? normalizedText : (title ?? canonicalKey);
  const points = Array.from(source).slice(0, MAX_SNIPPET_CODE_POINTS);
  const snippet = points.join("");
  if (countCodePoints(snippet) < 1) {
    return canonicalKey;
  }
  return snippet;
}

interface RawRun {
  id: string;
  session_id: string;
  status: string;
  event_seq: number;
}

function appendPresentedInTx(
  db: Database.Database,
  runId: string,
  prevSeq: number,
  payload: {
    setId: string;
    referenceId: string;
    ordinal: number;
    snapshotId: string;
    resourceId: string;
  },
  now: number,
): number {
  const valid = ReferencePresentedPayloadSchema.parse(payload);
  // Reuse the guarded allocator: bump event_seq only from the expected
  // predecessor so concurrent appends roll back instead of forking seqs.
  const next = prevSeq + 1;
  const moved = db
    .prepare("UPDATE runs SET event_seq = ? WHERE id = ? AND event_seq = ?")
    .run(next, runId, prevSeq);
  if (moved.changes !== 1) {
    throw new KernelStorageError(
      "kernel_concurrent_conflict",
      "concurrent event append conflict; retry the transition",
    );
  }
  const checked = parseRunEventPayload("reference.presented", valid);
  db.prepare(
    "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    runId,
    next,
    RUN_EVENT_SCHEMA_VERSION,
    "reference.presented",
    JSON.stringify(checked),
    now,
  );
  return next;
}

export function createReferenceManager(db: Database.Database) {
  function ensureMarkdownConnectorInstance(
    displayName: string,
    rootCount: number,
    options: { now?: number } = {},
  ): MarkdownConnectorView {
    if (
      typeof displayName !== "string" ||
      displayName.length < 1 ||
      displayName.length > 128
    ) {
      throw new RepositoryValidationError("displayName must be 1..128 chars");
    }
    if (!Number.isInteger(rootCount) || rootCount < 1 || rootCount > 1024) {
      throw new RepositoryValidationError(
        "rootCount must be an integer 1..1024",
      );
    }
    // No paths ever reach storage: reject separators / drive prefixes here.
    if (
      displayName.includes("/") ||
      displayName.includes("\\") ||
      displayName.includes("\0") ||
      /^[A-Za-z]:/.test(displayName)
    ) {
      throw new RepositoryValidationError(
        "displayName must not contain paths or separators",
      );
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const existing = db
        .prepare(
          "SELECT id, kind, display_name, config_json, created_at FROM connector_instances WHERE kind = 'markdown' AND display_name = ?",
        )
        .get(displayName) as
        | {
            id: string;
            kind: string;
            display_name: string;
            config_json: string;
            created_at: number;
          }
        | undefined;
      if (existing !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing.config_json);
        } catch {
          throw new RepositoryValidationError(
            "stored connector config invalid",
          );
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          (parsed as { version?: unknown }).version !==
            CONNECTOR_CONFIG_VERSION ||
          typeof (parsed as { rootCount?: unknown }).rootCount !== "number"
        ) {
          throw new RepositoryValidationError(
            "stored connector config invalid",
          );
        }
        return {
          id: existing.id,
          kind: existing.kind,
          displayName: existing.display_name,
          rootCount: (parsed as { rootCount: number }).rootCount,
          createdAt: existing.created_at,
        };
      }
      const id = generateId();
      const configJson = JSON.stringify({
        version: CONNECTOR_CONFIG_VERSION,
        rootCount,
      });
      db.prepare(
        "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', ?, ?, ?)",
      ).run(id, displayName, configJson, now);
      return { id, kind: "markdown", displayName, rootCount, createdAt: now };
    });
  }

  function presentObservations(
    sessionId: string,
    runId: string,
    observations: readonly ResourceObservation[],
    options: { freshness: FreshnessKind; now?: number },
  ): PresentObservationsResult {
    const session = requireId(sessionId, "sessionId");
    const run = requireId(runId, "runId");
    if (options.freshness !== "normal" && options.freshness !== "refresh") {
      throw new RepositoryValidationError("freshness must be normal|refresh");
    }
    const now = nowMs(options.now);
    // Validate + normalize OUTSIDE the transaction is fine, but hashing and
    // persistence stay inside so a cancelled Run discards even validation
    // side effects: nothing is written before the running recheck.
    const normalized = observations.map(normalizeObservation);
    return withImmediate(db, () => {
      const row = db
        .prepare(
          "SELECT id, session_id, status, event_seq FROM runs WHERE id = ?",
        )
        .get(run) as RawRun | undefined;
      if (row === undefined || row.session_id !== session) {
        throw new RepositoryNotFoundError(
          `run ${run} not found in session ${session}`,
        );
      }
      if (row.status !== "running") {
        // Cancel-first / terminal: persist nothing (no resource, snapshot,
        // reference, set, items, title updates, or events).
        return {
          applied: false as const,
          status: row.status,
          setId: null,
          references: [],
        };
      }
      // Running no-op CAS recheck: lose the race instead of writing stale.
      const guarded = db
        .prepare(
          "UPDATE runs SET status = 'running' WHERE id = ? AND status = 'running'",
        )
        .run(run);
      if (guarded.changes !== 1) {
        const current = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(run) as { status: string } | undefined;
        return {
          applied: false as const,
          status: current?.status ?? "unknown",
          setId: null,
          references: [],
        };
      }
      if (normalized.length === 0) {
        // Zero-hit: no empty set/event.
        return { applied: true as const, setId: null, references: [] };
      }
      let eventSeq = row.event_seq;
      const ordered: PresentedReferenceView[] = [];
      const seenReferenceIds = new Set<string>();

      for (const obs of normalized) {
        const connector = db
          .prepare("SELECT id FROM connector_instances WHERE id = ?")
          .get(obs.connectorInstanceId) as { id: string } | undefined;
        if (connector === undefined) {
          throw new ReferenceNotFoundError(
            `connector instance ${obs.connectorInstanceId} not found`,
          );
        }
        const contentHash = sha256Hex(obs.text);
        const sizeBytes = utf8ByteLength(obs.text);
        const bodyJson = JSON.stringify({ version: 1, text: obs.text });

        // Find or create the canonical resource (CAS allocator, no MAX).
        let resource = db
          .prepare(
            "SELECT id, title, next_revision FROM resources WHERE connector_instance_id = ? AND canonical_key = ?",
          )
          .get(obs.connectorInstanceId, obs.canonicalKey) as
          | { id: string; title: string | null; next_revision: number }
          | undefined;
        if (resource === undefined) {
          const resourceId = generateId();
          db.prepare(
            "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 1, ?)",
          ).run(
            resourceId,
            obs.connectorInstanceId,
            obs.canonicalKey,
            obs.title,
            now,
          );
          resource = { id: resourceId, title: obs.title, next_revision: 1 };
        } else if (obs.title !== null && obs.title !== resource.title) {
          // Title is display-only (never identity); update inside the same
          // transaction so post-cancel rollback discards it.
          db.prepare("UPDATE resources SET title = ? WHERE id = ?").run(
            obs.title,
            resource.id,
          );
          resource = { ...resource, title: obs.title };
        }

        const latest = db
          .prepare(
            "SELECT id, revision, source_revision, content_hash FROM resource_snapshots WHERE resource_id = ? ORDER BY revision DESC LIMIT 1",
          )
          .get(resource.id) as
          | {
              id: string;
              revision: number;
              source_revision: string | null;
              content_hash: string;
            }
          | undefined;

        let snapshotId: string;
        if (
          options.freshness === "normal" &&
          latest !== undefined &&
          (latest.source_revision ?? null) === (obs.sourceRevision ?? null) &&
          latest.content_hash === contentHash
        ) {
          // Normal reuse: identical revision signal + identical normalized
          // content reuses the latest Snapshot (no new row).
          snapshotId = latest.id;
        } else {
          // Changed revision (even with identical content) or explicit
          // refresh: always a new Snapshot + new rN. No
          // UNIQUE(resource_id, content_hash) exists, so duplicates persist.
          const revision = resource.next_revision;
          snapshotId = generateId();
          db.prepare(
            "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            snapshotId,
            resource.id,
            revision,
            obs.sourceRevision,
            contentHash,
            bodyJson,
            sizeBytes,
            obs.observedAt,
            now,
          );
          const bumped = db
            .prepare(
              "UPDATE resources SET next_revision = ? WHERE id = ? AND next_revision = ?",
            )
            .run(revision + 1, resource.id, revision);
          if (bumped.changes !== 1) {
            throw new KernelStorageError(
              "kernel_concurrent_conflict",
              "concurrent revision allocation conflict",
            );
          }
          resource = { ...resource, next_revision: revision + 1 };
        }

        // Same-session + same-snapshot reuses the same rN (DB UNIQUE backs
        // this; check first to keep the ordered output stable).
        let reference = db
          .prepare(
            "SELECT id, ordinal FROM session_references WHERE session_id = ? AND snapshot_id = ?",
          )
          .get(session, snapshotId) as
          | { id: string; ordinal: number }
          | undefined;
        if (reference === undefined) {
          const sessionRow = db
            .prepare("SELECT next_reference_ordinal FROM sessions WHERE id = ?")
            .get(session) as { next_reference_ordinal: number } | undefined;
          if (sessionRow === undefined) {
            throw new RepositoryNotFoundError(`session ${session} not found`);
          }
          const ordinal = sessionRow.next_reference_ordinal;
          const referenceId = generateId();
          try {
            db.prepare(
              "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(referenceId, session, ordinal, resource.id, snapshotId, now);
          } catch (error) {
            // A concurrent same-snapshot insert wins the UNIQUE: reuse it.
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error
            ) {
              const code = (error as { code?: unknown }).code;
              if (
                code === "SQLITE_CONSTRAINT_UNIQUE" ||
                code === "SQLITE_CONSTRAINT"
              ) {
                const winner = db
                  .prepare(
                    "SELECT id, ordinal FROM session_references WHERE session_id = ? AND snapshot_id = ?",
                  )
                  .get(session, snapshotId) as
                  | { id: string; ordinal: number }
                  | undefined;
                if (winner !== undefined) {
                  reference = winner;
                } else {
                  throw error;
                }
              } else {
                throw error;
              }
            } else {
              throw error;
            }
          }
          if (reference === undefined) {
            const moved = db
              .prepare(
                "UPDATE sessions SET next_reference_ordinal = ? WHERE id = ? AND next_reference_ordinal = ?",
              )
              .run(ordinal + 1, session, ordinal);
            if (moved.changes !== 1) {
              throw new KernelStorageError(
                "kernel_concurrent_conflict",
                "concurrent rN allocation conflict",
              );
            }
            reference = { id: referenceId, ordinal };
          }
        }

        if (!seenReferenceIds.has(reference.id)) {
          seenReferenceIds.add(reference.id);
          ordered.push({
            referenceId: reference.id,
            ordinal: reference.ordinal,
            snapshotId,
            resourceId: resource.id,
            canonicalKey: obs.canonicalKey,
            title: resource.title,
            snippet: deriveSnippet(obs.text, resource.title, obs.canonicalKey),
          });
        }
      }

      // Ordered ReferenceSet for this presentation.
      const setId = generateId();
      db.prepare(
        "INSERT INTO reference_sets (id, session_id, created_at) VALUES (?, ?, ?)",
      ).run(setId, session, now);
      let position = 1;
      for (const entry of ordered) {
        db.prepare(
          "INSERT INTO reference_set_items (session_id, set_id, ordinal, reference_id) VALUES (?, ?, ?, ?)",
        ).run(session, setId, position, entry.referenceId);
        position += 1;
      }
      // One structural reference.presented event per presented reference.
      for (const entry of ordered) {
        eventSeq = appendPresentedInTx(
          db,
          run,
          eventSeq,
          {
            setId,
            referenceId: entry.referenceId,
            ordinal: entry.ordinal,
            snapshotId: entry.snapshotId,
            resourceId: entry.resourceId,
          },
          now,
        );
      }
      return { applied: true as const, setId, references: ordered };
    });
  }

  function presentStored(
    sessionId: string,
    runId: string,
    referenceIds: readonly string[],
    options: { now?: number } = {},
  ): PresentStoredResult {
    const session = requireId(sessionId, "sessionId");
    const run = requireId(runId, "runId");
    const now = nowMs(options.now);
    const ids = [...referenceIds];
    for (const id of ids) {
      requireId(id, "referenceId");
    }
    return withImmediate(db, () => {
      const row = db
        .prepare(
          "SELECT id, session_id, status, event_seq FROM runs WHERE id = ?",
        )
        .get(run) as RawRun | undefined;
      if (row === undefined || row.session_id !== session) {
        throw new RepositoryNotFoundError(
          `run ${run} not found in session ${session}`,
        );
      }
      if (row.status !== "running") {
        return {
          applied: false as const,
          status: row.status,
          setId: null,
          references: [],
        };
      }
      const guarded = db
        .prepare(
          "UPDATE runs SET status = 'running' WHERE id = ? AND status = 'running'",
        )
        .run(run);
      if (guarded.changes !== 1) {
        const current = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(run) as { status: string } | undefined;
        return {
          applied: false as const,
          status: current?.status ?? "unknown",
          setId: null,
          references: [],
        };
      }
      if (ids.length === 0) {
        // Zero-hit: no empty set/event.
        return { applied: true as const, setId: null, references: [] };
      }
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          throw new InvalidReferenceError(
            "duplicate reference id in presentation",
          );
        }
        seen.add(id);
      }
      // Stored-only: validate membership, never reread external sources.
      const ordered: PresentedReferenceView[] = [];
      for (const id of ids) {
        const found = db
          .prepare(
            `SELECT sr.id AS id, sr.ordinal AS ordinal, sr.resource_id AS resource_id,
                    sr.snapshot_id AS snapshot_id, r.canonical_key AS canonical_key, r.title AS title,
                    s.body_json AS body_json
               FROM session_references sr
               JOIN resources r ON r.id = sr.resource_id
               JOIN resource_snapshots s ON s.id = sr.snapshot_id
              WHERE sr.session_id = ? AND sr.id = ?`,
          )
          .get(session, id) as
          | {
              id: string;
              ordinal: number;
              resource_id: string;
              snapshot_id: string;
              canonical_key: string;
              title: string | null;
              body_json: string;
            }
          | undefined;
        if (found === undefined) {
          throw new ReferenceNotFoundError(
            `reference ${id} not found in session ${session}`,
          );
        }
        let text = "";
        try {
          const body = JSON.parse(found.body_json) as { text?: unknown };
          if (typeof body.text === "string") {
            text = body.text;
          }
        } catch {
          throw new RepositoryValidationError("stored snapshot body invalid");
        }
        ordered.push({
          referenceId: found.id,
          ordinal: found.ordinal,
          snapshotId: found.snapshot_id,
          resourceId: found.resource_id,
          canonicalKey: found.canonical_key,
          title: found.title,
          snippet: deriveSnippet(text, found.title, found.canonical_key),
        });
      }
      const setId = generateId();
      db.prepare(
        "INSERT INTO reference_sets (id, session_id, created_at) VALUES (?, ?, ?)",
      ).run(setId, session, now);
      let position = 1;
      for (const entry of ordered) {
        db.prepare(
          "INSERT INTO reference_set_items (session_id, set_id, ordinal, reference_id) VALUES (?, ?, ?, ?)",
        ).run(session, setId, position, entry.referenceId);
        position += 1;
      }
      let eventSeq = row.event_seq;
      for (const entry of ordered) {
        eventSeq = appendPresentedInTx(
          db,
          run,
          eventSeq,
          {
            setId,
            referenceId: entry.referenceId,
            ordinal: entry.ordinal,
            snapshotId: entry.snapshotId,
            resourceId: entry.resourceId,
          },
          now,
        );
      }
      return { applied: true as const, setId, references: ordered };
    });
  }

  return {
    ensureMarkdownConnectorInstance,
    presentObservations,
    presentStored,
  };
}

export type ReferenceManager = ReturnType<typeof createReferenceManager>;
