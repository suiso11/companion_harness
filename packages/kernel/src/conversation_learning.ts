// Durable, per-session conversation reflections and human-approved lessons.
//
// Model output is never trusted automatically: a completed selected turn may
// produce candidate reflections, but a candidate only becomes usable context
// after an operator approves the EXACT content hash. Approvals and rejects
// are durable in a private SQLite store and survive restart. Retrieval is
// session-scoped; there is deliberately no cross-session promotion in this
// implementation.
//
// The model can never call approve/reject: there is no HTTP route and no
// tool registration in this module. The only approval surface is the
// operator CLI (apps/server/src/learning_cli.ts).

import type Database from "better-sqlite3";
import { canonicalJsonString, generateId, sha256Hex } from "./canonical.js";
import { RepositoryValidationError } from "./errors.js";
import {
  closePrivateSqlite,
  hardenPrivateSidecars,
  openPrivateSqlite,
} from "./private_sqlite.js";

export const LEARNING_KINDS = [
  "observation",
  "user_confirmed_feedback",
  "model_inference",
] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export const LEARNING_MAX_CANDIDATES_PER_TURN = 5;
export const LEARNING_LESSON_MAX_CP = 500;
export const LEARNING_EVIDENCE_MAX_CP = 500;
export const LEARNING_APPLICABILITY_MAX_CP = 300;
export const LEARNING_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type LearningProposalStatus = "pending" | "approved" | "rejected";

export interface LearningCandidate {
  readonly kind: LearningKind;
  readonly lesson: string;
  readonly evidence: string;
  readonly applicability: string;
}

export interface LearningProposalRow {
  readonly id: string;
  readonly reflectionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly kind: LearningKind;
  readonly lesson: string;
  readonly evidence: string;
  readonly applicability: string;
  readonly provenance: string;
  readonly contentHash: string;
  readonly status: LearningProposalStatus;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface LearningReflectionRow {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly candidateCount: number;
  readonly createdAt: number;
}

export interface LearningAppliedRow {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly proposalId: string;
  readonly createdAt: number;
}

export interface LearningStore {
  readonly path: string;
  captureReflection(input: {
    sessionId: string;
    runId: string;
    turnId: string;
    candidates: readonly LearningCandidate[];
    now?: number;
  }): {
    reflection: LearningReflectionRow;
    proposals: readonly LearningProposalRow[];
    deduplicated: boolean;
  };
  listReflections(): LearningReflectionRow[];
  /** Durable per-run lookup used to make reflection capture idempotent. */
  findReflectionByRun(runId: string): LearningReflectionRow | null;
  listProposals(status?: LearningProposalStatus): LearningProposalRow[];
  /** Newest-first bounded page for the read-only browser view. */
  listRecentProposals(
    status?: LearningProposalStatus,
    limit?: number,
  ): LearningProposalRow[];
  show(id: string): LearningProposalRow;
  approve(id: string, expectedHash: string, now?: number): LearningProposalRow;
  reject(id: string, now?: number): LearningProposalRow;
  listApprovedForSession(sessionId: string): LearningProposalRow[];
  recordApplication(input: {
    sessionId: string;
    runId: string;
    proposalId: string;
    now?: number;
  }): LearningAppliedRow;
  listApplications(sessionId?: string): LearningAppliedRow[];
  close(): void;
}

export interface LearningStoreOptions {
  readonly path: string;
  readonly clock?: { now(): number };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND_SET = new Set<string>(LEARNING_KINDS);
const STATUS_SET = new Set<string>(["pending", "approved", "rejected"]);

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RepositoryValidationError(`${what} is invalid`);
  }
  return value;
}

function requireSessionId(value: unknown): string {
  return requireId(value, "learning session");
}

function requireRunId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new RepositoryValidationError("learning run is invalid");
  }
  return value;
}

function requireTurnId(value: unknown): string {
  return requireRunId(value);
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function requireText(
  value: unknown,
  min: number,
  max: number,
  what: string,
): string {
  if (
    typeof value !== "string" ||
    countCodePoints(value) < min ||
    countCodePoints(value) > max ||
    value.includes("\0")
  ) {
    throw new RepositoryValidationError(`${what} is invalid`);
  }
  for (const unit of value) {
    const code = unit.codePointAt(0) ?? 0;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      throw new RepositoryValidationError(`${what} is invalid`);
    }
  }
  return value;
}

function requireKind(value: unknown): LearningKind {
  if (typeof value !== "string" || !KIND_SET.has(value)) {
    throw new RepositoryValidationError("learning kind is invalid");
  }
  return value as LearningKind;
}

function requireStatus(value: unknown): LearningProposalStatus {
  if (typeof value !== "string" || !STATUS_SET.has(value)) {
    throw new RepositoryValidationError("learning status is invalid");
  }
  return value as LearningProposalStatus;
}

function requireNow(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RepositoryValidationError("learning clock is invalid");
  }
  return value;
}

function requireCandidate(value: unknown): LearningCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RepositoryValidationError("learning candidate is invalid");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key !== "kind" &&
      key !== "lesson" &&
      key !== "evidence" &&
      key !== "applicability"
    ) {
      throw new RepositoryValidationError("learning candidate is invalid");
    }
  }
  return Object.freeze({
    kind: requireKind(record.kind),
    lesson: requireText(
      record.lesson,
      1,
      LEARNING_LESSON_MAX_CP,
      "learning lesson",
    ),
    evidence: requireText(
      record.evidence,
      1,
      LEARNING_EVIDENCE_MAX_CP,
      "learning evidence",
    ),
    applicability: requireText(
      record.applicability,
      1,
      LEARNING_APPLICABILITY_MAX_CP,
      "learning applicability",
    ),
  });
}

/** Exact-content hash binding used by show/approve. */
export function learningContentHash(candidate: LearningCandidate): string {
  const checked = requireCandidate(candidate);
  return sha256Hex(
    canonicalJsonString({
      version: 1,
      kind: checked.kind,
      lesson: checked.lesson,
      evidence: checked.evidence,
      applicability: checked.applicability,
    }),
  );
}

interface RawProposal {
  id: string;
  reflection_id: string;
  session_id: string;
  run_id: string;
  turn_id: string;
  kind: string;
  lesson: string;
  evidence: string;
  applicability: string;
  provenance: string;
  content_hash: string;
  status: string;
  created_at: number;
  decided_at: number | null;
}

function toProposal(raw: RawProposal): LearningProposalRow {
  return Object.freeze({
    id: raw.id,
    reflectionId: raw.reflection_id,
    sessionId: raw.session_id,
    runId: raw.run_id,
    turnId: raw.turn_id,
    kind: requireKind(raw.kind),
    lesson: raw.lesson,
    evidence: raw.evidence,
    applicability: raw.applicability,
    provenance: raw.provenance,
    contentHash: raw.content_hash,
    status: requireStatus(raw.status),
    createdAt: raw.created_at,
    decidedAt: raw.decided_at,
  });
}

interface RawReflection {
  id: string;
  session_id: string;
  run_id: string;
  turn_id: string;
  candidate_count: number;
  created_at: number;
}

function toReflection(raw: RawReflection): LearningReflectionRow {
  return Object.freeze({
    id: raw.id,
    sessionId: raw.session_id,
    runId: raw.run_id,
    turnId: raw.turn_id,
    candidateCount: raw.candidate_count,
    createdAt: raw.created_at,
  });
}

interface RawApplication {
  id: string;
  session_id: string;
  run_id: string;
  proposal_id: string;
  created_at: number;
}

function toApplication(raw: RawApplication): LearningAppliedRow {
  return Object.freeze({
    id: raw.id,
    sessionId: raw.session_id,
    runId: raw.run_id,
    proposalId: raw.proposal_id,
    createdAt: raw.created_at,
  });
}

export function createLearningStore(
  options: LearningStoreOptions,
): LearningStore {
  if (typeof options !== "object" || options === null) {
    throw new RepositoryValidationError("learning options are required");
  }
  const path = options.path;
  const db: Database.Database = openPrivateSqlite(path);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_reflections (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        run_id          TEXT NOT NULL UNIQUE,
        turn_id         TEXT NOT NULL,
        candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
        created_at      INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS learning_proposals (
        id             TEXT PRIMARY KEY,
        reflection_id  TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        run_id         TEXT NOT NULL,
        turn_id        TEXT NOT NULL,
        kind           TEXT NOT NULL
                       CHECK (kind IN ('observation','user_confirmed_feedback','model_inference')),
        lesson         TEXT NOT NULL,
        evidence       TEXT NOT NULL,
        applicability  TEXT NOT NULL,
        provenance     TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        status         TEXT NOT NULL
                       CHECK (status IN ('pending','approved','rejected')),
        created_at     INTEGER NOT NULL,
        decided_at     INTEGER,
        UNIQUE(session_id, run_id, content_hash),
        CHECK ((status = 'pending' AND decided_at IS NULL) OR
               (status IN ('approved','rejected') AND decided_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS learning_proposals_approved_idx
        ON learning_proposals(session_id, status, created_at);
      CREATE TABLE IF NOT EXISTS learning_applications (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE(run_id, proposal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS learning_applications_session_idx
        ON learning_applications(session_id, created_at);
    `);
    hardenPrivateSidecars(path);
  } catch (error) {
    closePrivateSqlite(db, path);
    if (error instanceof RepositoryValidationError) throw error;
    throw new RepositoryValidationError("learning store is unavailable");
  }
  const clock = options.clock ?? { now: () => Date.now() };

  function readProposal(id: string): LearningProposalRow | null {
    const raw = db
      .prepare("SELECT * FROM learning_proposals WHERE id = ?")
      .get(id) as RawProposal | undefined;
    return raw === undefined ? null : toProposal(raw);
  }

  function readReflectionByRun(runId: string): LearningReflectionRow | null {
    const raw = db
      .prepare("SELECT * FROM learning_reflections WHERE run_id = ?")
      .get(runId) as RawReflection | undefined;
    return raw === undefined ? null : toReflection(raw);
  }

  function proposalsForReflection(reflectionId: string): LearningProposalRow[] {
    const rows = db
      .prepare(
        "SELECT * FROM learning_proposals WHERE reflection_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(reflectionId) as RawProposal[];
    return rows.map(toProposal);
  }

  const captureTx = db.transaction(
    (input: {
      sessionId: string;
      runId: string;
      turnId: string;
      candidates: readonly LearningCandidate[];
      now: number;
    }) => {
      const existing = readReflectionByRun(input.runId);
      if (existing !== null) {
        return {
          reflection: existing,
          proposals: proposalsForReflection(existing.id),
          deduplicated: true,
        };
      }
      const reflectionId = generateId();
      db.prepare(
        "INSERT INTO learning_reflections (id, session_id, run_id, turn_id, candidate_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        reflectionId,
        input.sessionId,
        input.runId,
        input.turnId,
        input.candidates.length,
        input.now,
      );
      const proposals: LearningProposalRow[] = [];
      for (const candidate of input.candidates) {
        const hash = learningContentHash(candidate);
        const id = generateId();
        try {
          db.prepare(
            "INSERT INTO learning_proposals (id, reflection_id, session_id, run_id, turn_id, kind, lesson, evidence, applicability, provenance, content_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          ).run(
            id,
            reflectionId,
            input.sessionId,
            input.runId,
            input.turnId,
            candidate.kind,
            candidate.lesson,
            candidate.evidence,
            candidate.applicability,
            "accepted_completed_turn",
            hash,
            input.now,
          );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            String((error as { code?: unknown }).code) ===
              "SQLITE_CONSTRAINT_UNIQUE"
          ) {
            continue;
          }
          throw error;
        }
        const row = readProposal(id);
        if (row !== null) proposals.push(row);
      }
      const reflection = readReflectionByRun(input.runId);
      if (reflection === null) {
        throw new RepositoryValidationError(
          "learning reflection insert failed",
        );
      }
      return { reflection, proposals, deduplicated: false };
    },
  );

  return {
    path,
    captureReflection(input) {
      const sessionId = requireSessionId(input.sessionId);
      const runId = requireRunId(input.runId);
      const turnId = requireTurnId(input.turnId);
      const now = requireNow(input.now ?? clock.now());
      if (
        !Array.isArray(input.candidates) ||
        input.candidates.length > LEARNING_MAX_CANDIDATES_PER_TURN
      ) {
        throw new RepositoryValidationError(
          "learning candidates are out of bounds",
        );
      }
      const candidates = input.candidates.map(requireCandidate);
      return captureTx({ sessionId, runId, turnId, candidates, now });
    },
    listReflections() {
      const rows = db
        .prepare(
          "SELECT * FROM learning_reflections ORDER BY created_at DESC, rowid DESC",
        )
        .all() as RawReflection[];
      return rows.map(toReflection);
    },
    findReflectionByRun(runId) {
      return readReflectionByRun(requireRunId(runId));
    },
    listProposals(statusFilter) {
      const rows =
        statusFilter === undefined
          ? (db
              .prepare(
                "SELECT * FROM learning_proposals ORDER BY created_at DESC, rowid DESC",
              )
              .all() as RawProposal[])
          : (db
              .prepare(
                "SELECT * FROM learning_proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC",
              )
              .all(requireStatus(statusFilter)) as RawProposal[]);
      return rows.map(toProposal);
    },
    listRecentProposals(statusFilter, limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RepositoryValidationError("limit must be 1..100");
      }
      const rows =
        statusFilter === undefined
          ? (db
              .prepare(
                "SELECT * FROM learning_proposals ORDER BY created_at DESC, rowid DESC LIMIT ?",
              )
              .all(limit) as RawProposal[])
          : (db
              .prepare(
                "SELECT * FROM learning_proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
              )
              .all(requireStatus(statusFilter), limit) as RawProposal[]);
      return rows.map(toProposal);
    },
    show(id) {
      const wanted = requireId(id, "learning proposal");
      const row = readProposal(wanted);
      if (row === null) {
        throw new RepositoryValidationError("learning proposal not found");
      }
      return row;
    },
    approve(id, expectedHash, now = clock.now()) {
      const wanted = requireId(id, "learning proposal");
      const at = requireNow(now);
      if (
        typeof expectedHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(expectedHash)
      ) {
        throw new RepositoryValidationError("learning content hash is invalid");
      }
      const current = readProposal(wanted);
      if (current === null) {
        throw new RepositoryValidationError("learning proposal not found");
      }
      if (current.contentHash !== expectedHash) {
        throw new RepositoryValidationError(
          "learning content hash does not match; nothing approved",
        );
      }
      if (current.status === "approved") return current;
      if (current.status !== "pending") {
        throw new RepositoryValidationError("learning proposal is not pending");
      }
      const moved = db
        .prepare(
          "UPDATE learning_proposals SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending' AND content_hash = ?",
        )
        .run(at, wanted, expectedHash);
      if (moved.changes !== 1) {
        throw new RepositoryValidationError(
          "learning proposal changed concurrently",
        );
      }
      const row = readProposal(wanted);
      if (row === null) {
        throw new RepositoryValidationError("learning proposal not found");
      }
      return row;
    },
    reject(id, now = clock.now()) {
      const wanted = requireId(id, "learning proposal");
      const at = requireNow(now);
      const current = readProposal(wanted);
      if (current === null) {
        throw new RepositoryValidationError("learning proposal not found");
      }
      if (current.status === "rejected") return current;
      if (current.status !== "pending") {
        throw new RepositoryValidationError("learning proposal is not pending");
      }
      const moved = db
        .prepare(
          "UPDATE learning_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(at, wanted);
      if (moved.changes !== 1) {
        throw new RepositoryValidationError(
          "learning proposal changed concurrently",
        );
      }
      const row = readProposal(wanted);
      if (row === null) {
        throw new RepositoryValidationError("learning proposal not found");
      }
      return row;
    },
    listApprovedForSession(sessionId) {
      const wanted = requireSessionId(sessionId);
      const rows = db
        .prepare(
          "SELECT * FROM learning_proposals WHERE session_id = ? AND status = 'approved' ORDER BY created_at ASC, rowid ASC",
        )
        .all(wanted) as RawProposal[];
      return rows.map(toProposal);
    },
    recordApplication(input) {
      const sessionId = requireSessionId(input.sessionId);
      const runId = requireRunId(input.runId);
      const proposalId = requireId(input.proposalId, "learning proposal");
      const now = requireNow(input.now ?? clock.now());
      const proposal = readProposal(proposalId);
      if (
        proposal === null ||
        proposal.sessionId !== sessionId ||
        proposal.status !== "approved"
      ) {
        throw new RepositoryValidationError(
          "learning application is not bound to an approved session lesson",
        );
      }
      db.prepare(
        "INSERT OR IGNORE INTO learning_applications (id, session_id, run_id, proposal_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(generateId(), sessionId, runId, proposalId, now);
      const raw = db
        .prepare(
          "SELECT * FROM learning_applications WHERE run_id = ? AND proposal_id = ?",
        )
        .get(runId, proposalId) as RawApplication | undefined;
      if (raw === undefined) {
        throw new RepositoryValidationError("learning application failed");
      }
      return toApplication(raw);
    },
    listApplications(sessionId) {
      const rows =
        sessionId === undefined
          ? (db
              .prepare(
                "SELECT * FROM learning_applications ORDER BY created_at DESC, rowid DESC",
              )
              .all() as RawApplication[])
          : (db
              .prepare(
                "SELECT * FROM learning_applications WHERE session_id = ? ORDER BY created_at DESC, rowid DESC",
              )
              .all(requireSessionId(sessionId)) as RawApplication[]);
      return rows.map(toApplication);
    },
    close() {
      closePrivateSqlite(db, path);
    },
  };
}
