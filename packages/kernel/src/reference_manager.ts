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
// - Normal selection compares ONLY this session's latest snapshot for the
//   resource (highest revision referenced by this session, independent of
//   the observed content). When that latest session snapshot exists and its
//   `source_revision` (NULL-safe exact) plus `content_hash` equal the
//   observation it is reused; when it exists but differs a fresh Snapshot
//   + new rN is created even if an older session/global snapshot matches.
//   Only sessions with no reference to the resource fall back to the
//   global-latest match/reuse. Explicit refresh always creates a new
//   Snapshot + new rN.
// - Snippets are deterministic 512-code-point prefixes of the normalized
//   text (empty text falls back to `title ?? canonicalKey`). The manager has
//   no search query, so query-relative excerpts stay a connector concern.
// - Zero-hit presentations (`[]` observations or `[]` stored ids) write
//   nothing: no ReferenceSet, no items, no events (`setId: null`).
// - Connector `config_json` is metadata-only `{ version: 1, rootCount }`
//   for legacy rows or `{ version: 1, rootCount, configFingerprint }` for
//   fingerprinted rows (opaque 64-hex SHA-256, never a path).
//   Absolute paths / separators are rejected at the boundary.
// - `reference.presented` payloads carry structural IDs/ordinals only.

import {
  CanonicalKeySchema,
  countCodePoints,
  createExpandedLinkGraphBudget,
  MAX_EXPANDED_LINK_GRAPH_BYTES,
  MAX_SNIPPET_CODE_POINTS,
  parseRunEventPayload,
  ReferencePresentedPayloadSchema,
  ReferenceTitleSchema,
  RUN_EVENT_SCHEMA_VERSION,
  SnapshotBodySchema,
  SourceRevisionSchema,
  serializeExpandedLinkGraphEntry,
  utf8ByteLength,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { generateId, isUuidV4, sha256Hex } from "./canonical.js";
import {
  InvalidReferenceError,
  KernelStorageError,
  LinkGraphTooLargeError,
  ReferenceNotFoundError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";

/* ------------------------------------------------------------------ */
/* Observation (ephemeral, never persisted as-is)                        */
/* ------------------------------------------------------------------ */

/** One already-read external fact. Ephemeral: not evidence until committed. */
export interface ObservationLink {
  kind: "standard" | "wiki";
  status: "resolved" | "ambiguous" | "unresolved";
  /** Ordered path-free CanonicalKeySchema values (same connector only). */
  candidates: readonly string[];
}

export interface ResourceObservation {
  connectorInstanceId: string;
  canonicalKey: string;
  title: string | null;
  /** Raw external text (any normalization); kernel NFC-normalizes. */
  text: string;
  /** Opaque upstream revision signal (content-derived for Markdown). */
  sourceRevision: string | null;
  observedAt: number;
  /**
   * Ordered normalized link metadata (source-document order, ordinal 1..N).
   * Persisted ONLY when a new snapshot is materialized: candidate resources
   * are ensured under the same connector (title NULL if unseen) and one
   * immutable `snapshot_links` row per link is inserted in the same
   * presentation transaction. A reused snapshot never rewrites its graph;
   * a refresh writes a wholly new graph for the new snapshot. No raw
   * URL / wiki target / alias / fragment is accepted or stored.
   */
  links?: readonly ObservationLink[];
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

/** Stored-only related view (no snippet/body; tool layer presents later). */
export interface RelatedStoredView {
  referenceId: string;
  ordinal: number;
  snapshotId: string;
  resourceId: string;
  canonicalKey: string;
  title: string | null;
}

export const RELATED_DEFAULT_LIMIT = 10 as const;
export const RELATED_MAX_LIMIT = 20 as const;

const CONNECTOR_CONFIG_VERSION = 1 as const;

const CONFIG_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export interface EnsureMarkdownConnectorOptions {
  readonly now?: number;
  /**
   * Opaque stable instance identity (64 lowercase hex). Optional for
   * backward compatibility; when supplied the stored row must carry the
   * identical fingerprint or the ensure fails closed. Never a path.
   */
  readonly configFingerprint?: string;
}

function requireConfigFingerprint(input: unknown): string {
  if (typeof input !== "string" || !CONFIG_FINGERPRINT_PATTERN.test(input)) {
    throw new RepositoryValidationError(
      "configFingerprint must be 64 lowercase hex",
    );
  }
  return input;
}

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
  links: NormalizedLink[];
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
  const links = normalizeObservationLinks(raw.links);
  return {
    connectorInstanceId,
    canonicalKey,
    title,
    text,
    sourceRevision,
    observedAt,
    links,
  };
}

type NormalizedLink = {
  kind: "standard" | "wiki";
  status: "resolved" | "ambiguous" | "unresolved";
  candidates: string[];
};

/**
 * Ordered normalized link metadata: kind/status enums plus path-free
 * CanonicalKeySchema candidates with the DB state CHECK mirrored here
 * (resolved exactly 1, ambiguous >1, unresolved 0). No raw link text.
 */
function normalizeObservationLinks(
  input: readonly ObservationLink[] | undefined,
): NormalizedLink[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new RepositoryValidationError("links must be an array");
  }
  // No link-count bound: any number of links fits while the aggregate
  // 256KiB graph budget (checked in presentObservations preflight) fits.
  return input.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new RepositoryValidationError(`link ${index} must be an object`);
    }
    const { kind, status, candidates } = entry as {
      kind?: unknown;
      status?: unknown;
      candidates?: unknown;
    };
    if (kind !== "standard" && kind !== "wiki") {
      throw new RepositoryValidationError(`link ${index} kind invalid`);
    }
    if (
      status !== "resolved" &&
      status !== "ambiguous" &&
      status !== "unresolved"
    ) {
      throw new RepositoryValidationError(`link ${index} status invalid`);
    }
    if (!Array.isArray(candidates)) {
      throw new RepositoryValidationError(
        `link ${index} candidates must be an array`,
      );
    }
    const parsed: string[] = candidates.map((candidate, j) => {
      try {
        return CanonicalKeySchema.parse(candidate);
      } catch (error) {
        throw new RepositoryValidationError(
          `link ${index} candidate ${j} invalid: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    });
    if (status === "resolved" && parsed.length !== 1) {
      throw new RepositoryValidationError(
        `link ${index} resolved requires exactly one candidate`,
      );
    }
    if (status === "ambiguous" && parsed.length <= 1) {
      throw new RepositoryValidationError(
        `link ${index} ambiguous requires more than one candidate`,
      );
    }
    if (status === "unresolved" && parsed.length !== 0) {
      throw new RepositoryValidationError(
        `link ${index} unresolved requires zero candidates`,
      );
    }
    return { kind, status, candidates: parsed };
  });
}

/**
 * Defensive aggregate 256KiB graph preflight (exact contracts framing).
 *
 * Runs on the RAW observations BEFORE any normalization copies and BEFORE
 * `withImmediate` (hence before any resource/title/allocator/graph/ref/
 * set/event persistence). The flattened batch graph covers ALL observations
 * in the call in presentation order (observation order, link order within
 * each observation); ordinal is index+1 within each observation; repeated
 * candidates are charged per occurrence; unresolved (zero-candidate) links
 * are charged for their framing; body/title/snippets are never charged.
 * Empty/undefined links are treated as empty; there is no link-count bound.
 *
 * Each candidate key is type/grammar validated (string + CanonicalKeySchema,
 * <=512) one at a time before the incremental cap check: the remaining
 * byte budget for the entry (exact empty-candidates overhead plus
 * `JSON.stringify` UTF-8 bytes per valid key, inter-candidate commas, and
 * the outer entry comma) is enforced per candidate before append, so a
 * huge candidate list exits early without pushing a full oversized parsed
 * list. The shared contracts `createExpandedLinkGraphBudget` then confirms
 * the same entry (same count, no double charging), and it also measures
 * one bounded key at a time with early exit, so no huge single
 * serialization is ever built.
 * Overflow throws `LinkGraphTooLargeError` (fixed code `output_too_large`).
 * Structural link errors throw `RepositoryValidationError` (unchanged).
 */
function assertLinkGraphBudget(
  observations: readonly ResourceObservation[],
): void {
  const budget = createExpandedLinkGraphBudget();
  for (const raw of observations) {
    const input: unknown =
      (raw as { links?: unknown }).links === undefined
        ? []
        : (raw as { links?: unknown }).links;
    if (input === undefined) {
      continue;
    }
    if (!Array.isArray(input)) {
      throw new RepositoryValidationError("links must be an array");
    }
    for (let index = 0; index < input.length; index += 1) {
      const entry = input[index] as {
        kind?: unknown;
        status?: unknown;
        candidates?: unknown;
      };
      if (typeof entry !== "object" || entry === null) {
        throw new RepositoryValidationError(`link ${index} must be an object`);
      }
      const { kind, status, candidates } = entry;
      if (kind !== "standard" && kind !== "wiki") {
        throw new RepositoryValidationError(`link ${index} kind invalid`);
      }
      if (
        status !== "resolved" &&
        status !== "ambiguous" &&
        status !== "unresolved"
      ) {
        throw new RepositoryValidationError(`link ${index} status invalid`);
      }
      if (!Array.isArray(candidates)) {
        throw new RepositoryValidationError(
          `link ${index} candidates must be an array`,
        );
      }
      const rawCandidates = candidates as unknown[];
      const ordinal = index + 1;
      // Exact remaining bytes for this entry (outer entry comma included).
      const remaining =
        MAX_EXPANDED_LINK_GRAPH_BYTES -
        budget.bytes -
        (budget.count > 0 ? 1 : 0);
      // Exact empty-candidates overhead for this kind/status/ordinal
      // (bounded: framing plus small enums/ordinal, safe to serialize).
      const emptyOverhead = utf8ByteLength(
        serializeExpandedLinkGraphEntry({
          kind,
          status,
          candidates: [],
          ordinal,
        }),
      );
      if (emptyOverhead > remaining) {
        throw new LinkGraphTooLargeError();
      }
      let projected = emptyOverhead;
      const parsed: string[] = [];
      for (let j = 0; j < rawCandidates.length; j += 1) {
        const candidate = rawCandidates[j];
        if (typeof candidate !== "string") {
          throw new RepositoryValidationError(
            `link ${index} candidate ${j} invalid: expected string`,
          );
        }
        let valid: string;
        try {
          valid = CanonicalKeySchema.parse(candidate);
        } catch (error) {
          throw new RepositoryValidationError(
            `link ${index} candidate ${j} invalid: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        // Bounded per-key serialization (valid keys are <=512 UTF-16
        // units, so escaping stays small); enforced before append.
        const jsonBytes = utf8ByteLength(JSON.stringify(valid) as string);
        const separator = parsed.length > 0 ? 1 : 0;
        if (projected + separator + jsonBytes > remaining) {
          throw new LinkGraphTooLargeError();
        }
        projected += separator + jsonBytes;
        parsed.push(valid);
      }
      if (status === "resolved" && parsed.length !== 1) {
        throw new RepositoryValidationError(
          `link ${index} resolved requires exactly one candidate`,
        );
      }
      if (status === "ambiguous" && parsed.length <= 1) {
        throw new RepositoryValidationError(
          `link ${index} ambiguous requires more than one candidate`,
        );
      }
      if (status === "unresolved" && parsed.length !== 0) {
        throw new RepositoryValidationError(
          `link ${index} unresolved requires zero candidates`,
        );
      }
      // Final shared-budget confirmation for the same entry (same count,
      // no double charging; framing never rewritten or approximated).
      const accepted = budget.tryAddEntry({
        kind,
        status,
        candidates: parsed,
        ordinal,
      });
      if (!accepted) {
        throw new LinkGraphTooLargeError();
      }
    }
  }
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
    options: EnsureMarkdownConnectorOptions = {},
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
    const requestedFingerprint =
      options.configFingerprint === undefined
        ? undefined
        : requireConfigFingerprint(options.configFingerprint);
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
          !Number.isInteger((parsed as { rootCount?: unknown }).rootCount)
        ) {
          throw new RepositoryValidationError(
            "stored connector config invalid",
          );
        }
        const storedRootCount = (parsed as { rootCount: number }).rootCount;
        // Changed root configuration must never silently reuse an instance:
        // the stored root count always has to equal the requested count.
        // Connector rows are never updated or rebound.
        if (storedRootCount !== rootCount) {
          throw new RepositoryValidationError("connector root count mismatch");
        }
        const storedFingerprint = (parsed as { configFingerprint?: unknown })
          .configFingerprint;
        if (storedFingerprint !== undefined) {
          if (
            typeof storedFingerprint !== "string" ||
            !CONFIG_FINGERPRINT_PATTERN.test(storedFingerprint)
          ) {
            throw new RepositoryValidationError(
              "stored connector config invalid",
            );
          }
        }
        if (requestedFingerprint !== undefined) {
          // Fail closed: a fingerprinted startup requires the stored row to
          // carry the identical fingerprint (legacy/mismatched rows reject).
          if (storedFingerprint !== requestedFingerprint) {
            throw new RepositoryValidationError(
              "connector config fingerprint mismatch",
            );
          }
        }
        return {
          id: existing.id,
          kind: existing.kind,
          displayName: existing.display_name,
          rootCount: storedRootCount,
          createdAt: existing.created_at,
        };
      }
      const id = generateId();
      const configJson =
        requestedFingerprint === undefined
          ? JSON.stringify({
              version: CONNECTOR_CONFIG_VERSION,
              rootCount,
            })
          : JSON.stringify({
              version: CONNECTOR_CONFIG_VERSION,
              rootCount,
              configFingerprint: requestedFingerprint,
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
    // Defensive aggregate graph preflight FIRST: exact 256KiB budget over
    // the flattened batch graph on RAW inputs, before any normalization
    // copies and before withImmediate (hence before any resource/title/
    // allocator/graph/ref/set/event persistence). Overflow throws
    // output_too_large with zero DB changes.
    assertLinkGraphBudget(observations);
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
        let snapshotIsNew = false;
        // Normal reuse compares ONLY this session's latest snapshot for the
        // resource (highest revision referenced by this session, independent
        // of the observed content). A match reuses it; a mismatch creates a
        // fresh Snapshot even when an older session/global snapshot matches,
        // so A->B->A yields a third snapshot. Sessions with no reference to
        // the resource keep the global-latest match/reuse fallback below.
        let latestSession:
          | {
              id: string;
              source_revision: string | null;
              content_hash: string;
            }
          | undefined;
        if (options.freshness === "normal") {
          latestSession = db
            .prepare(
              "SELECT s.id AS id, s.source_revision AS source_revision, s.content_hash AS content_hash FROM resource_snapshots s JOIN session_references sr ON sr.snapshot_id = s.id WHERE sr.session_id = ? AND s.resource_id = ? ORDER BY s.revision DESC LIMIT 1",
            )
            .get(session, resource.id) as
            | {
                id: string;
                source_revision: string | null;
                content_hash: string;
              }
            | undefined;
        }
        if (
          options.freshness === "normal" &&
          latestSession !== undefined &&
          (latestSession.source_revision ?? null) ===
            (obs.sourceRevision ?? null) &&
          latestSession.content_hash === contentHash
        ) {
          // Session reuse: this session's latest snapshot still matches, so
          // reuse it (no new row, graph untouched). The session_reference
          // lookup below then returns the existing rN.
          snapshotId = latestSession.id;
        } else if (
          options.freshness === "normal" &&
          latestSession === undefined &&
          latest !== undefined &&
          (latest.source_revision ?? null) === (obs.sourceRevision ?? null) &&
          latest.content_hash === contentHash
        ) {
          // No session reference to this resource: reuse the global-latest
          // matching Snapshot (no new row, graph untouched).
          snapshotId = latest.id;
        } else {
          // Latest session snapshot differs (or no reusable latest exists),
          // changed revision (even with identical content), or explicit
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
          snapshotIsNew = true;
        }

        // Link graph: written if and only if a new snapshot was just
        // materialized. Candidate resources are ensured under the SAME
        // connector instance (title NULL when unseen); a reused snapshot
        // never rewrites its graph even if this observation carries links.
        if (snapshotIsNew && obs.links.length > 0) {
          const candidateIds = new Map<string, string>();
          for (const link of obs.links) {
            for (const candidate of link.candidates) {
              if (candidateIds.has(candidate)) {
                continue;
              }
              const target = db
                .prepare(
                  "SELECT id FROM resources WHERE connector_instance_id = ? AND canonical_key = ?",
                )
                .get(obs.connectorInstanceId, candidate) as
                | { id: string }
                | undefined;
              if (target === undefined) {
                const targetId = generateId();
                db.prepare(
                  "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, NULL, 1, ?)",
                ).run(targetId, obs.connectorInstanceId, candidate, now);
                candidateIds.set(candidate, targetId);
              } else {
                candidateIds.set(candidate, target.id);
              }
            }
          }
          let linkOrdinal = 1;
          for (const link of obs.links) {
            const targetResourceId =
              link.status === "resolved"
                ? (candidateIds.get(link.candidates[0] as string) as string)
                : null;
            db.prepare(
              "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              snapshotId,
              linkOrdinal,
              link.kind,
              link.status,
              targetResourceId,
              JSON.stringify(link.candidates),
            );
            linkOrdinal += 1;
          }
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

  /**
   * Stored-only related resolution over the saved link graph (no external
   * reads, no ReferenceSet / RunEvent / EvidenceGrant / Snapshot / I/O).
   *
   * DETERMINISTIC SELECTION (documented, never guesses ambiguous targets):
   * 1. Outgoing: resolved links of the EXACT base snapshot in link-ordinal
   *    order, deduped by target resource. Ambiguous/unresolved links are
   *    ignored entirely.
   * 2. Incoming: for every other resource with at least one reference in
   *    this session, take its latest session-referenced snapshot (the
   *    snapshot of its greatest-ordinal reference); if that snapshot holds
   *    a resolved link targeting the base resource, the resource is an
   *    incoming candidate sorted by canonical key code-unit order.
   * 3. Each candidate resource maps to its latest session reference
   *    (greatest ordinal) in this session; resources with no session
   *    reference are skipped (stored-only: never invents rN). The base
   *    reference itself is excluded, references are unique, and output is
   *    outgoing-first then incoming, truncated to `limit`.
   */
  function getRelatedStored(
    sessionId: string,
    referenceId: string,
    limit: number = RELATED_DEFAULT_LIMIT,
  ): RelatedStoredView[] {
    const session = requireId(sessionId, "sessionId");
    const baseRef = requireId(referenceId, "referenceId");
    if (!Number.isInteger(limit) || limit < 1 || limit > RELATED_MAX_LIMIT) {
      throw new RepositoryValidationError(
        `limit must be an integer 1..${RELATED_MAX_LIMIT}`,
      );
    }
    const base = db
      .prepare(
        `SELECT sr.id AS id, sr.ordinal AS ordinal, sr.resource_id AS resource_id,
                sr.snapshot_id AS snapshot_id
           FROM session_references sr
          WHERE sr.session_id = ? AND sr.id = ?`,
      )
      .get(session, baseRef) as
      | {
          id: string;
          ordinal: number;
          resource_id: string;
          snapshot_id: string;
        }
      | undefined;
    if (base === undefined) {
      throw new ReferenceNotFoundError(
        `reference ${baseRef} not found in session ${session}`,
      );
    }
    const baseSnapshotId = base.snapshot_id;
    const baseResourceId = base.resource_id;

    // All session references (latest ordinal per resource wins the mapping).
    const rows = db
      .prepare(
        `SELECT sr.id AS id, sr.ordinal AS ordinal, sr.resource_id AS resource_id,
                sr.snapshot_id AS snapshot_id, r.canonical_key AS canonical_key, r.title AS title
           FROM session_references sr
           JOIN resources r ON r.id = sr.resource_id
          WHERE sr.session_id = ?
          ORDER BY sr.ordinal ASC`,
      )
      .all(session) as Array<{
      id: string;
      ordinal: number;
      resource_id: string;
      snapshot_id: string;
      canonical_key: string;
      title: string | null;
    }>;
    const latestByResource = new Map<
      string,
      {
        id: string;
        ordinal: number;
        snapshot_id: string;
        canonical_key: string;
        title: string | null;
      }
    >();
    for (const row of rows) {
      const prev = latestByResource.get(row.resource_id);
      if (prev === undefined || row.ordinal > prev.ordinal) {
        latestByResource.set(row.resource_id, {
          id: row.id,
          ordinal: row.ordinal,
          snapshot_id: row.snapshot_id,
          canonical_key: row.canonical_key,
          title: row.title,
        });
      }
    }

    const ordered: RelatedStoredView[] = [];
    const seenRefs = new Set<string>([baseRef]);
    const seenResources = new Set<string>();

    // 1. Outgoing from the exact base snapshot.
    const outgoing = db
      .prepare(
        `SELECT target_resource_id AS target_resource_id
           FROM snapshot_links
          WHERE source_snapshot_id = ? AND status = 'resolved'
          ORDER BY ordinal ASC`,
      )
      .all(baseSnapshotId) as Array<{ target_resource_id: string }>;
    for (const link of outgoing) {
      const target = link.target_resource_id;
      if (seenResources.has(target)) {
        continue;
      }
      seenResources.add(target);
      if (target === baseResourceId) {
        continue;
      }
      const mapped = latestByResource.get(target);
      if (mapped === undefined || seenRefs.has(mapped.id)) {
        continue;
      }
      seenRefs.add(mapped.id);
      ordered.push({
        referenceId: mapped.id,
        ordinal: mapped.ordinal,
        snapshotId: mapped.snapshot_id,
        resourceId: target,
        canonicalKey: mapped.canonical_key,
        title: mapped.title,
      });
      if (ordered.length >= limit) {
        return ordered;
      }
    }

    // 2. Incoming via each resource's latest session-referenced snapshot.
    const incomingCandidates: Array<{
      resourceId: string;
      canonicalKey: string;
    }> = [];
    for (const [resourceId, mapped] of latestByResource) {
      if (resourceId === baseResourceId || seenResources.has(resourceId)) {
        continue;
      }
      const hit = db
        .prepare(
          `SELECT 1 AS hit FROM snapshot_links
            WHERE source_snapshot_id = ? AND status = 'resolved' AND target_resource_id = ?
            LIMIT 1`,
        )
        .get(mapped.snapshot_id, baseResourceId) as { hit: number } | undefined;
      if (hit !== undefined) {
        incomingCandidates.push({
          resourceId,
          canonicalKey: mapped.canonical_key,
        });
      }
    }
    incomingCandidates.sort((a, b) => {
      if (a.canonicalKey < b.canonicalKey) return -1;
      if (a.canonicalKey > b.canonicalKey) return 1;
      return 0;
    });
    for (const candidate of incomingCandidates) {
      const mapped = latestByResource.get(candidate.resourceId) as {
        id: string;
        ordinal: number;
        snapshot_id: string;
        canonical_key: string;
        title: string | null;
      };
      if (seenRefs.has(mapped.id)) {
        continue;
      }
      seenRefs.add(mapped.id);
      ordered.push({
        referenceId: mapped.id,
        ordinal: mapped.ordinal,
        snapshotId: mapped.snapshot_id,
        resourceId: candidate.resourceId,
        canonicalKey: mapped.canonical_key,
        title: mapped.title,
      });
      if (ordered.length >= limit) {
        break;
      }
    }
    return ordered;
  }

  return {
    ensureMarkdownConnectorInstance,
    presentObservations,
    presentStored,
    getRelatedStored,
  };
}

export type ReferenceManager = ReturnType<typeof createReferenceManager>;
