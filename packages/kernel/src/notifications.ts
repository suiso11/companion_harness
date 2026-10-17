// AV05 notifications durable-projection core (kernel only, no service/HTTP/UI).
//
// Ownership: this module is the ONLY writer of the notification tables
// (`notification_cursors`, `notifications`, `notification_acks`,
// `notification_deadline_schedule`). It uses the caller-provided single
// better-sqlite3 connection, joins the CALLER's `BEGIN IMMEDIATE`
// transaction model via own `withImmediate` writes (never opening a nested
// TX inside them), per-session monotonic `seq`, canonical semantic-state
// dedup fingerprints, and Zod validation on every JSON boundary — the same
// conventions as the M0 repository and `shadow.ts` / `autonomy.ts`.
//
// Import direction (cycle firewall): this module MAY read the existing
// strict deadline grammar from `autonomy.ts` (`isStrictAutonomyDeadline`)
// and NOTHING else from it. `autonomy.ts` and `shadow.ts` MUST NEVER
// runtime-import this module: the M5 receipt writer (`action_executions.ts`)
// in particular stays untouched, so old M6-historical / v9-fixture paths
// that run modern M5 helpers before upgrade-14 never need the new tables
// and never hit a silent no-such-table fallback on the write path.
//
// Hard boundaries enforced here (no exceptions):
// - BORING durable PROJECTION from EXISTING append-only sources only:
//   `shadow_job_events` (COMPLETED -> validated immutable job modelOutput +
//   CODE policy), `action_receipts` (actual `unknown` /
//   `succeeded_unverified` -> URGENT commitment-verification notice with
//   fixed safe content), `autonomy_task_events` (-> derived deadline
//   projection). The sources are already durable; the store advances the
//   cursor and inserts notification / projection rows in the SAME TX.
//   Catchup consumes only durable UNSEEN changes and never re-executes
//   work. No model invoke, no ToolBroker, no worker, no calendar write.
// - Source cursors are owned by migration 0014 + the kernel: migration 14
//   INSERTs one cursor row per (pre-existing session, source) at that
//   session's current MAX(source rowid) with a NULL key anchor, and an
//   AFTER-INSERT-ON-sessions trigger starts every NEW session at rowid 0 /
//   NULL anchor — so a new session's FIRST source event is always
//   consumed and historical rows are never mass-notified. The kernel
//   NEVER lazily baselines at MAX on first ingest: a missing cursor after
//   migration/trigger is an honest `notification_projection_reset_required`
//   (a projection reset), never a silent skip of the first event.
//   Every advance stores the source KEY at the frontier rowid in the SAME
//   TX (`shadow_job_events.id`, `action_receipts.execution_id`,
//   `autonomy_task_events.id`); before advancing the kernel verifies the
//   rowid at the stored cursor still carries the anchored key for the OWN
//   session, so a rowid reuse / reorder / rebuild with the same or higher
//   MAX surfaces an honest reset with ZERO partial progress instead of
//   silently skipping durable history.
// - A notification is an immutable original record: UUID id + per-session
//   monotonic seq, scope when the source knows it, kind
//   (progress / proposal / question / deadline / commitment), priority
//   (routine / urgent, CODE-computed — URGENT only for uncertain
//   commitment receipts — never model urgency), fixed safe system
//   provenance brief text (embedded model phrasing is UNTRUSTED), source
//   kind + id + version / epoch, optional EXPLICIT cited deadline(s).
//   Source-model labels are not claims or citations; raw resource URLs /
//   UUIDs never become user-visible (ids travel only as hidden links).
// - Dedup fingerprints cover the ACTUAL semantic state
//   (session / scope / scope-epoch / kind / subject) and EXCLUDE paraphrased
//   reason / model text / source job id for the SAME state, so repeated
//   explicit re-evaluation does not spam. A do-nothing completion inserts
//   ZERO rows; hold / failure paths notify only on meaningful NEW affected
//   state (never self-usefulness pings, never unchanged
//   `model_unavailable` spam, never a just-to-assert-working ping).
//   Questions carrying a cited EXPLICIT task deadline stay separate from
//   the general question group (no purpose window-as-deadline, ever).
//   Source-expired / superseded questions are retained HISTORY; the
//   derived actionable state may mark them outdated without assuming an
//   answer or ack, and old questions are never re-nudged after a purpose
//   change.
// - Acks are separate explicit immutable receipts (id + stable key) owned
//   by the session: same key + same notification replays, drift is 409,
//   foreign ids are 404. Idempotency lookup of an accepted scope MUST have
//   actually dispatched the owned notice. List / get / history / feed-
//   cursor are pure READS (no auto-ack, no delivered mutation) returning
//   truthful pagination, latestSeq, and unread counts — no hardcoded data.
//   Every notification stays auditably immutable; an ack changes NO
//   purpose / task / control / Calendar grant / proposal / hypothesis.
// - Deadline projection is REAL and strict: source is user-EXPLICIT
//   kind=`task` + speaker=`user` + non-terminal + deadline present under
//   the EXISTING strict RFC3339-with-explicit-offset grammar (validated via
//   the borrowed autonomy grammar + `Date.parse` on the validated string —
//   never a new timezone parser). No model dates, no goal
//   validFrom / validUntil windows as deadlines. The table is a DERIVED
//   schedule (taskId / session / dueAt / observedTaskVersion /
//   sourceUpdatedAt): startup rebuild ITERATES the whole task source in
//   bounded pages (never a 100-record silent truncation); original task
//   rows are NEVER changed or deleted here — only derived schedule rows
//   may be upserted / removed (completed / cancelled drops the row).
// - Future-deadline reads query the earliest indexed numeric dueAt; due
//   recording runs in a bounded transaction against the CURRENT control
//   version + paused fence. NO offline-time catchup: after an explicit
//   resume, `control.updatedAt` is the cutoff — OLD past deadlines are
//   skipped unless the task was meaningfully updated / created AFTER the
//   resume. Existing future deadlines stay eligible; a newly created
//   explicit PAST deadline is NEW state and may log once. STOP disables
//   autonomous deadline callback; an already human-approved Calendar
//   uncertain receipt still records its URGENT notice while autonomy is
//   paused (those actions are never aborted here). A deadline alert NEVER
//   marks a task held / completed / resumed and NEVER creates calendar
//   state. Dedup is (taskId, EXACT deadline) through hold / resume status
//   changes; terminal status removes only the derived schedule. The API
//   reports `control_paused` / `stale_epoch` honestly with ZERO actual
//   recordings — never a fake alert. No physical devices, no desktop-OS
//   push, no unknown urgency semantics.
// - Narrow ports only: no duplicated autonomy DTO mappers / grammar /
//   cycles. No unbounded arrays, no log polling, no new numeric model
//   bounds. New errors are fixed safe codes. Old shadow-42 / core policy +
//   GLOBAL claim leases are preserved; no job is enqueued from
//   notification events / ack / reads.

import {
  type NotificationKind,
  type NotificationView,
  NotificationViewSchema,
  ShadowJobContextSchema,
  type ShadowModelOutput,
  ShadowModelOutputSchema,
  type ShadowPolicyCode,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import { isStrictAutonomyDeadline } from "./autonomy.js";
import { generateId, isUuidV4 } from "./canonical.js";
import {
  KernelStorageError,
  NotificationKeyConflictError,
  NotificationProjectionResetError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";

/* ------------------------------------------------------------------ */
/* Local strict helpers (same conventions as the M0 repository).        */
/* ------------------------------------------------------------------ */

function nowMs(input?: number): number {
  const now = input ?? Date.now();
  if (!Number.isInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw new RepositoryValidationError(
      "now must be an integer Unix-ms timestamp",
    );
  }
  return now;
}

function parseOrValidation<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KernelStorageError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new RepositoryValidationError(`${what}: ${message}`, {
      cause: error,
    });
  }
}

function requireKey(key: unknown): string {
  if (!isUuidV4(key)) {
    throw new RepositoryValidationError("Idempotency-Key must be a UUID v4");
  }
  return (key as string).toLowerCase();
}

function requireId(id: unknown, what: string): string {
  if (!isUuidV4(id)) {
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  }
  return id as string;
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

function requireSession(db: Database.Database, sessionId: string): void {
  const id = requireId(sessionId, "sessionId");
  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new RepositoryNotFoundError(`session ${id} not found`);
  }
}

function truncateCp(text: string, maxCp: number): string {
  const cps = Array.from(text);
  return cps.length <= maxCp ? text : cps.slice(0, maxCp).join("");
}

/* ------------------------------------------------------------------ */
/* Cursors                                                              */
/* ------------------------------------------------------------------ */

const CURSOR_SOURCES = [
  "shadow_job_events",
  "action_receipts",
  "autonomy_task_events",
] as const;

export type NotificationCursorSource = (typeof CURSOR_SOURCES)[number];

/** Bounded per-source catchup batch (borrowed list-cap family, no spin). */
const SHADOW_EVENT_BATCH = 50;
const RECEIPT_BATCH = 50;
const TASK_EVENT_BATCH = 100;
const DUE_SCAN_BATCH = 100;
const SCHEDULE_PAGE = 200;

function sessionMaxRowid(
  db: Database.Database,
  table: NotificationCursorSource,
  sessionId: string,
): number | null {
  const row = db
    .prepare(
      `SELECT MAX(rowid) AS max_rowid FROM ${table} WHERE session_id = ?`,
    )
    .get(sessionId) as { max_rowid: number | null } | undefined;
  return row?.max_rowid ?? null;
}

function readCursor(
  db: Database.Database,
  sessionId: string,
  source: NotificationCursorSource,
): { rowid: number; key: string | null } | null {
  const row = db
    .prepare(
      "SELECT last_source_rowid, last_source_key FROM notification_cursors WHERE session_id = ? AND source = ?",
    )
    .get(sessionId, source) as
    | { last_source_rowid: number; last_source_key: string | null }
    | undefined;
  return row === undefined
    ? null
    : { rowid: row.last_source_rowid, key: row.last_source_key };
}

/** Immutable source key column anchoring each cursor's frontier rowid. */
const CURSOR_KEY_COLUMNS: Record<NotificationCursorSource, string> = {
  shadow_job_events: "id",
  action_receipts: "execution_id",
  autonomy_task_events: "id",
};

/**
 * Resolve the stored cursor or fail honest. There is NO lazy MAX(rowid)
 * baseline here: migration 14 owns the backfill for pre-existing sessions
 * and the sessions trigger owns fresh-session init, so a new session's
 * FIRST source event is always consumed. A missing cursor, a
 * renumber/rebuild (MAX(rowid) below the cursor), or a key-anchor mismatch
 * (the rowid at the cursor no longer carries the anchored source key for
 * the OWN session — rowid reuse / reorder / rebuild at the same or higher
 * MAX) is an honest `notification_projection_reset_required` with ZERO
 * partial progress, never a silent skip. MUST run inside the caller's
 * transaction.
 */
function resolveCursorInTx(
  db: Database.Database,
  sessionId: string,
  source: NotificationCursorSource,
): { cursor: number } {
  const stored = readCursor(db, sessionId, source);
  if (stored === null) {
    throw new NotificationProjectionResetError(
      `source ${source} has no cursor for session ${sessionId}; projection reset required`,
    );
  }
  const currentMax = sessionMaxRowid(db, source, sessionId);
  // Renumber / rebuild detection: the append-only source must never sit
  // below the stored cursor — whether rows shifted down (MAX below cursor)
  // or vanished entirely (no rows left past a nonzero cursor). Either way
  // advancing would silently skip durable history, so the projection
  // honestly refuses instead.
  if (currentMax === null ? stored.rowid > 0 : currentMax < stored.rowid) {
    throw new NotificationProjectionResetError(
      `source ${source} renumbered (max ${currentMax ?? "empty"} below cursor ${stored.rowid}); projection reset required`,
    );
  }
  // Key-anchor verification: NULL anchors are grandfathered (migration-14
  // baselines and fresh-session inits carry no key yet) and cursor 0 sits
  // before any source row; anything else must still own its anchored key.
  if (stored.key !== null && stored.rowid > 0) {
    const keyColumn = CURSOR_KEY_COLUMNS[source];
    const at = db
      .prepare(
        `SELECT ${keyColumn} AS anchor_key FROM ${source} WHERE rowid = ? AND session_id = ?`,
      )
      .get(stored.rowid, sessionId) as { anchor_key: string } | undefined;
    if (at === undefined || at.anchor_key !== stored.key) {
      throw new NotificationProjectionResetError(
        `source ${source} cursor row ${stored.rowid} no longer carries the anchored key; projection reset required`,
      );
    }
  }
  return { cursor: stored.rowid };
}

function advanceCursorInTx(
  db: Database.Database,
  sessionId: string,
  source: NotificationCursorSource,
  rowid: number,
  key: string | null,
  now: number,
): void {
  db.prepare(
    "INSERT INTO notification_cursors (session_id, source, last_source_rowid, last_source_key, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, source) DO UPDATE SET last_source_rowid = excluded.last_source_rowid, last_source_key = excluded.last_source_key, updated_at = excluded.updated_at",
  ).run(sessionId, source, rowid, key, now);
}

/* ------------------------------------------------------------------ */
/* Notification insert (semantic-state dedup)                           */
/* ------------------------------------------------------------------ */

interface NotificationDraft {
  scope: string;
  kind: NotificationKind;
  /** CODE-computed: urgent ONLY for uncertain commitment receipts. */
  priority: "routine" | "urgent";
  briefText: string;
  sourceKind: "shadow_job" | "action_receipt" | "task_deadline";
  sourceId: string;
  sourceVersion: number | null;
  sourceEpoch: number | null;
  citedDeadlines: string[];
  /** Semantic state WITHOUT paraphrase / model text / job id. */
  fingerprint: string;
  /**
   * DERIVED question-context expiry (Unix-ms) or null. Computed ONCE at
   * notice creation as the min FUTURE applicability boundary; reads map
   * `outdated` from it without ever mutating the stored original.
   */
  contextExpiryAt: number | null;
}

/**
 * Insert one immutable notification or dedup-ignore it on the SAME semantic
 * state (UNIQUE(session_id, fingerprint)). Returns true when actually
 * dispatched, false on no-change dedup. MUST run inside the caller's TX.
 */
function insertNotificationInTx(
  db: Database.Database,
  sessionId: string,
  seqState: { next: number },
  draft: NotificationDraft,
  now: number,
): boolean {
  if (draft.fingerprint.length === 0 || draft.fingerprint.length > 500) {
    throw new RepositoryValidationError("fingerprint must be 1..500 chars");
  }
  if (draft.scope.length === 0 || draft.scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  const brief = truncateCp(draft.briefText, 500);
  if (brief.length === 0) {
    throw new RepositoryValidationError("briefText must be 1..500 chars");
  }
  if (draft.citedDeadlines.length > 8) {
    throw new RepositoryValidationError("citedDeadlines max 8");
  }
  if (
    draft.contextExpiryAt !== null &&
    (!Number.isInteger(draft.contextExpiryAt) || draft.contextExpiryAt < 0)
  ) {
    throw new RepositoryValidationError(
      "contextExpiryAt must be Unix-ms or null",
    );
  }
  const seq = seqState.next;
  const moved = db
    .prepare(
      "INSERT INTO notifications (id, session_id, seq, scope, kind, priority, brief_text, source_kind, source_id, source_version, source_epoch, cited_deadlines, fingerprint, outdated, context_expiry_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(session_id, fingerprint) DO NOTHING",
    )
    .run(
      generateId(),
      sessionId,
      seq,
      draft.scope,
      draft.kind,
      draft.priority,
      brief,
      draft.sourceKind,
      draft.sourceId,
      draft.sourceVersion,
      draft.sourceEpoch,
      JSON.stringify(draft.citedDeadlines),
      draft.fingerprint,
      draft.contextExpiryAt,
      now,
    );
  if (moved.changes === 1) {
    seqState.next += 1;
    return true;
  }
  return false;
}

function readNextSeq(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM notifications WHERE session_id = ?",
    )
    .get(sessionId) as { max_seq: number };
  return row.max_seq + 1;
}

interface StoredNotificationRow {
  id: string;
  session_id: string;
  seq: number;
  scope: string;
  kind: string;
  priority: string;
  brief_text: string;
  source_kind: string;
  source_id: string;
  source_version: number | null;
  source_epoch: number | null;
  cited_deadlines: string;
  outdated: number;
  context_expiry_at: number | null;
  created_at: number;
}

function toNotificationView(
  row: StoredNotificationRow,
  now: number,
): NotificationView {
  return parseOrValidation(
    () =>
      NotificationViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        seq: row.seq,
        scope: row.scope,
        kind: row.kind,
        priority: row.priority,
        briefText: row.brief_text,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        sourceVersion: row.source_version,
        sourceEpoch: row.source_epoch,
        citedDeadlines: JSON.parse(row.cited_deadlines),
        // DERIVED relevance: the stored flag OR the technical expiry
        // reached at read time — computed here, never mutated on GET.
        outdated:
          row.outdated === 1 ||
          (row.context_expiry_at !== null && row.context_expiry_at <= now),
        contextExpiryAt: row.context_expiry_at,
        createdAt: row.created_at,
      }),
    "stored notification",
  );
}

function assertOwnedNotification(
  db: Database.Database,
  sessionId: string,
  notificationId: string,
): StoredNotificationRow {
  const session = requireId(sessionId, "sessionId");
  const id = requireId(notificationId, "notificationId");
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
    | StoredNotificationRow
    | undefined;
  if (row === undefined || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `notification ${id} not found in session ${session}`,
    );
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* Shadow-job source (COMPLETED only)                                   */
/* ------------------------------------------------------------------ */

interface RawShadowJob {
  id: string;
  session_id: string;
  scope: string;
  status: string;
  version: number;
  scope_epoch: number;
  claim_scope_epoch: number | null;
  claim_control_version: number | null;
  context_json: string | null;
  model_decision_json: string | null;
  policy_code: string | null;
}

/**
 * DERIVED question-context expiry: the min time-applicability boundary
 * frozen at notice creation, using the EXISTING strict
 * RFC3339-with-explicit-offset grammar + `Date.parse` (no new timezone
 * parser, no model dates). Candidates are (a) the `validUntil` END of
 * frozen purposes that were APPLICABLE at claim
 * (`applicableAtClaim === true`) — persisted STALE even when the
 * projection lands after the window already closed, so a question
 * completed while the window was valid still expires instead of staying
 * actionable forever; already-inapplicable history — including
 * already-expired windows — MUST NOT blanket-outdate a valid question —
 * (b) the `validFrom` START of a frozen ACTIVE purpose whose window opens
 * in the future (inapplicable at claim only because it has not started
 * yet; the context changes at `validFrom`, mirroring the shadow fence
 * applicability predicate of active status + window), and (c) the draft's
 * cited EXPLICIT task deadlines in the future. A purpose window is NEVER
 * a task deadline and is never stored as one. Cited deadlines keep the
 * future-only policy relative to notice creation, so a past deadline
 * cited in a NEW post-deadline question never instantly expires that
 * meaningful question. Returns null when nothing relevant is pending.
 */
function questionContextExpiryAt(
  contextJson: string | null,
  citedDeadlines: string[],
  now: number,
): number | null {
  let expiry: number | null = null;
  const considerFuture = (ms: number): void => {
    if (Number.isInteger(ms) && ms > now && (expiry === null || ms < expiry)) {
      expiry = ms;
    }
  };
  // Frozen purpose END boundary: takes the min over ALL applicable-at-claim
  // ends, past or future, so delayed ingestion still expires the question.
  const considerPurposeEnd = (ms: number): void => {
    if (Number.isInteger(ms) && ms >= 0 && (expiry === null || ms < expiry)) {
      expiry = ms;
    }
  };
  if (contextJson !== null) {
    try {
      const frozen = ShadowJobContextSchema.parse(JSON.parse(contextJson));
      for (const purpose of frozen.purposes) {
        if (purpose.applicableAtClaim) {
          if (
            purpose.validUntil !== null &&
            isStrictAutonomyDeadline(purpose.validUntil)
          ) {
            considerPurposeEnd(Date.parse(purpose.validUntil));
          }
          continue;
        }
        // Future START transition only: ACTIVE status + a strict future
        // validFrom whose window is not already closed. Anything else that
        // was inapplicable at claim (inactive status, past start, closed
        // window) is history, never a future transition.
        if (
          purpose.status === "active" &&
          purpose.validFrom !== null &&
          isStrictAutonomyDeadline(purpose.validFrom) &&
          (purpose.validUntil === null ||
            (isStrictAutonomyDeadline(purpose.validUntil) &&
              Date.parse(purpose.validUntil) > now))
        ) {
          considerFuture(Date.parse(purpose.validFrom));
        }
      }
    } catch {
      // Unparsable frozen context yields no derived expiry (never fake one).
    }
  }
  for (const cited of citedDeadlines) {
    if (isStrictAutonomyDeadline(cited)) {
      considerFuture(Date.parse(cited));
    }
  }
  return expiry;
}

/**
 * Derive ZERO-or-one notification drafts from a COMPLETED shadow job.
 * do-nothing inserts ZERO rows (genuinely representable silence, never a
 * fake failure fallback). Hold / failure-flavoured outcomes notify only on
 * meaningful NEW affected state — completed `hold`-decision work maps to a
 * routine progress note tied to its frozen evidence, never to
 * self-usefulness pings or unchanged-model spam.
 */
function draftFromCompletedShadowJob(
  job: RawShadowJob,
  decision: ShadowModelOutput,
  policy: ShadowPolicyCode,
  now: number,
): NotificationDraft | null {
  if (decision.decision === "do-nothing") {
    return null;
  }
  const kind: NotificationKind =
    decision.decision === "execute"
      ? "proposal"
      : decision.decision === "ask"
        ? "question"
        : "progress";
  const cited: string[] = [];
  const draftDeadline = decision.proposedAction?.taskDraft?.deadline;
  if (draftDeadline !== undefined && isStrictAutonomyDeadline(draftDeadline)) {
    cited.push(draftDeadline);
  }
  const evidence = [...decision.evidenceIds].sort().join(",");
  // Fingerprint = semantic state ONLY: scope + kind + decision + CODE
  // policy + frozen scope epoch + frozen evidence labels. The paraphrased
  // reason, the full model text, and the source job id are EXCLUDED, so a
  // repeated explicit re-evaluation of the SAME state dedups instead of
  // spamming. Cited explicit task deadlines stay in their own group.
  const fingerprint = truncateCp(
    `v1|shadow|${job.scope}|${kind}|${decision.decision}|${policy}|${job.claim_scope_epoch ?? job.scope_epoch}|${evidence}|${cited.join("+")}`,
    500,
  );
  const head = `shadow ${decision.decision} (${policy}) in scope ${job.scope}`;
  const reason = truncateCp(decision.reason, 300);
  return {
    scope: job.scope,
    kind,
    priority: "routine",
    briefText: `${head} — untrusted model note: ${reason}`,
    sourceKind: "shadow_job",
    sourceId: job.id,
    sourceVersion: job.version,
    sourceEpoch: job.claim_scope_epoch ?? job.scope_epoch,
    citedDeadlines: cited,
    fingerprint,
    // Only questions carry a derived context expiry (future applicability
    // boundaries frozen at creation); every other kind stays NULL.
    contextExpiryAt:
      kind === "question"
        ? questionContextExpiryAt(job.context_json, cited, now)
        : null,
  };
}

function ingestShadowEventsInTx(
  db: Database.Database,
  sessionId: string,
  seqState: { next: number },
  now: number,
): { ingested: number; skipped: number } {
  const { cursor } = resolveCursorInTx(db, sessionId, "shadow_job_events");
  const rows = db
    .prepare(
      "SELECT rowid AS rowid, id, job_id, to_status FROM shadow_job_events WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    )
    .all(sessionId, cursor, SHADOW_EVENT_BATCH) as {
    rowid: number;
    id: string;
    job_id: string;
    to_status: string;
  }[];
  let ingested = 0;
  let skipped = 0;
  let frontier = cursor;
  let frontierKey: string | null = null;
  for (const event of rows) {
    frontier = Math.max(frontier, event.rowid);
    frontierKey = event.id;
    if (event.to_status !== "completed") {
      skipped += 1;
      continue;
    }
    const job = db
      .prepare("SELECT * FROM shadow_jobs WHERE id = ?")
      .get(event.job_id) as RawShadowJob | undefined;
    if (
      job === undefined ||
      job.session_id !== sessionId ||
      job.status !== "completed" ||
      job.model_decision_json === null ||
      job.policy_code === null
    ) {
      skipped += 1;
      continue;
    }
    let decision: ShadowModelOutput;
    try {
      decision = parseOrValidation(
        () =>
          ShadowModelOutputSchema.parse(
            JSON.parse(job.model_decision_json as string),
          ),
        "stored shadow decision",
      );
    } catch {
      skipped += 1;
      continue;
    }
    const draft = draftFromCompletedShadowJob(
      job,
      decision,
      job.policy_code as ShadowPolicyCode,
      now,
    );
    if (draft === null) {
      skipped += 1;
      continue;
    }
    if (insertNotificationInTx(db, sessionId, seqState, draft, now)) {
      ingested += 1;
    } else {
      skipped += 1;
    }
  }
  if (frontier > cursor) {
    advanceCursorInTx(
      db,
      sessionId,
      "shadow_job_events",
      frontier,
      frontierKey,
      now,
    );
  }
  return { ingested, skipped };
}

/* ------------------------------------------------------------------ */
/* Action-receipt source (uncertain human-approved Calendar outcomes)    */
/* ------------------------------------------------------------------ */

function ingestReceiptsInTx(
  db: Database.Database,
  sessionId: string,
  seqState: { next: number },
  now: number,
): { ingested: number; skipped: number } {
  const { cursor } = resolveCursorInTx(db, sessionId, "action_receipts");
  const rows = db
    .prepare(
      "SELECT rowid AS rowid, execution_id, proposal_id, outcome FROM action_receipts WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    )
    .all(sessionId, cursor, RECEIPT_BATCH) as {
    rowid: number;
    execution_id: string;
    proposal_id: string;
    outcome: string;
  }[];
  let ingested = 0;
  let skipped = 0;
  let frontier = cursor;
  let frontierKey: string | null = null;
  for (const receipt of rows) {
    frontier = Math.max(frontier, receipt.rowid);
    frontierKey = receipt.execution_id;
    // ONLY actual uncertain outcomes notify: `unknown` /
    // `succeeded_unverified`. Verified / failed / blocked outcomes are
    // already terminally recorded elsewhere and stay silent here. The
    // notice fires while autonomy is paused too: already human-approved
    // Calendar work is never gated by the autonomous stop control.
    if (
      receipt.outcome !== "unknown" &&
      receipt.outcome !== "succeeded_unverified"
    ) {
      skipped += 1;
      continue;
    }
    const draft: NotificationDraft = {
      // Scope falls back to the session when the receipt carries none:
      // receipts are execution-scoped, not policy-scoped.
      scope: "session",
      kind: "commitment",
      // CODE-computed URGENT: an uncertain human-approved Calendar receipt
      // needs verification before anyone relies on it. Never model-chosen.
      priority: "urgent",
      briefText:
        `commitment verification needed: a human-approved calendar action recorded an uncertain receipt (${receipt.outcome}); verify the calendar state before relying on it` +
        ` — fixed system notice, no model content`,
      sourceKind: "action_receipt",
      sourceId: receipt.execution_id,
      sourceVersion: null,
      sourceEpoch: null,
      citedDeadlines: [],
      contextExpiryAt: null,
      fingerprint: truncateCp(
        `v1|receipt|${receipt.proposal_id}|${receipt.outcome}`,
        500,
      ),
    };
    if (insertNotificationInTx(db, sessionId, seqState, draft, now)) {
      ingested += 1;
    } else {
      skipped += 1;
    }
  }
  if (frontier > cursor) {
    advanceCursorInTx(
      db,
      sessionId,
      "action_receipts",
      frontier,
      frontierKey,
      now,
    );
  }
  return { ingested, skipped };
}

/* ------------------------------------------------------------------ */
/* Deadline projection (derived schedule from task events + rebuild)    */
/* ------------------------------------------------------------------ */

interface RawTaskRow {
  id: string;
  session_id: string;
  scope: string;
  title: string;
  kind: string;
  speaker: string;
  deadline: string | null;
  status: string;
  version: number;
  updated_at: number;
  created_at: number;
}

function readTaskRow(db: Database.Database, taskId: string): RawTaskRow | null {
  return (
    (db.prepare("SELECT * FROM autonomy_tasks WHERE id = ?").get(taskId) as
      | RawTaskRow
      | undefined) ?? null
  );
}

/**
 * Strict deadline eligibility: user-EXPLICIT kind=`task` + speaker=`user` +
 * non-terminal + deadline present under the EXISTING strict
 * RFC3339-with-explicit-offset grammar. No model dates, no goal
 * validFrom / validUntil windows as deadlines. Numeric dueAt comes from
 * `Date.parse` applied to the ALREADY-VALIDATED string (never a new
 * timezone parser).
 */
function eligibleDueAt(task: RawTaskRow): number | null {
  if (task.kind !== "task" || task.speaker !== "user") {
    return null;
  }
  if (task.status === "completed" || task.status === "cancelled") {
    return null;
  }
  if (task.deadline === null || !isStrictAutonomyDeadline(task.deadline)) {
    return null;
  }
  const dueAt = Date.parse(task.deadline);
  if (!Number.isInteger(dueAt) || dueAt < 0) {
    return null;
  }
  return dueAt;
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

/**
 * Upsert-or-remove ONE derived schedule row for the CURRENT task state.
 * Original task rows are NEVER changed or deleted here. MUST run inside
 * the caller's TX. Returns "upserted" | "removed" | "unchanged".
 */
function projectTaskDeadlineInTx(
  db: Database.Database,
  task: RawTaskRow,
  now: number,
): "upserted" | "removed" | "unchanged" {
  const dueAt = eligibleDueAt(task);
  const existing = db
    .prepare("SELECT * FROM notification_deadline_schedule WHERE task_id = ?")
    .get(task.id) as
    | {
        task_id: string;
        due_at: number;
        observed_task_version: number;
        source_updated_at: number;
      }
    | undefined;
  if (dueAt === null) {
    if (existing === undefined) {
      return "unchanged";
    }
    db.prepare(
      "DELETE FROM notification_deadline_schedule WHERE task_id = ?",
    ).run(task.id);
    if (isTerminalTaskStatus(task.status)) {
      // Terminal removes ONLY the derived schedule row; the notification
      // HISTORY stays, marked outdated so nobody re-nudges it.
      db.prepare(
        "UPDATE notifications SET outdated = 1 WHERE session_id = ? AND kind = 'deadline' AND source_id = ? AND outdated = 0",
      ).run(task.session_id, task.id);
    }
    return "removed";
  }
  if (
    existing !== undefined &&
    existing.due_at === dueAt &&
    existing.observed_task_version === task.version &&
    existing.source_updated_at === task.updated_at
  ) {
    return "unchanged";
  }
  db.prepare(
    "INSERT INTO notification_deadline_schedule (task_id, session_id, scope, due_at, observed_task_version, source_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET due_at = excluded.due_at, observed_task_version = excluded.observed_task_version, source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at",
  ).run(
    task.id,
    task.session_id,
    task.scope,
    dueAt,
    task.version,
    task.updated_at,
    now,
    now,
  );
  return "upserted";
}

function ingestTaskEventsInTx(
  db: Database.Database,
  sessionId: string,
  now: number,
): { projected: number; removed: number; skipped: number } {
  const { cursor } = resolveCursorInTx(db, sessionId, "autonomy_task_events");
  const rows = db
    .prepare(
      "SELECT rowid AS rowid, id, task_id FROM autonomy_task_events WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    )
    .all(sessionId, cursor, TASK_EVENT_BATCH) as {
    rowid: number;
    id: string;
    task_id: string;
  }[];
  let projected = 0;
  let removed = 0;
  let skipped = 0;
  let frontier = cursor;
  let frontierKey: string | null = null;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const event of rows) {
    frontier = Math.max(frontier, event.rowid);
    frontierKey = event.id;
    if (!seen.has(event.task_id)) {
      seen.add(event.task_id);
      ordered.push(event.task_id);
    }
  }
  for (const taskId of ordered) {
    const task = readTaskRow(db, taskId);
    if (task === null || task.session_id !== sessionId) {
      skipped += 1;
      continue;
    }
    const outcome = projectTaskDeadlineInTx(db, task, now);
    if (outcome === "upserted") projected += 1;
    else if (outcome === "removed") removed += 1;
    else skipped += 1;
  }
  if (rows.length === 0) {
    skipped += 0;
  } else if (ordered.length === 0) {
    skipped += rows.length;
  }
  if (frontier > cursor) {
    advanceCursorInTx(
      db,
      sessionId,
      "autonomy_task_events",
      frontier,
      frontierKey,
      now,
    );
  }
  return { projected, removed, skipped };
}

/* ------------------------------------------------------------------ */
/* Owned repo API (concrete sync surface for the NEXT service worker)    */
/* ------------------------------------------------------------------ */

export interface IngestNotificationsOptions {
  now?: number;
}

/**
 * Bounded durable catchup for ONE session: shadow completions, uncertain
 * receipts, and task-event deadline projection advance their key-anchored
 * cursors and insert notification / projection rows in ONE transaction
 * (atomic rollback on ANY failure — partial cursor advance is impossible).
 * Cursors are owned by migration 14 (pre-existing sessions) + the
 * sessions trigger (new sessions at rowid 0), so a new session's FIRST
 * source event is always consumed; afterwards only durable unseen changes
 * are consumed, and work is never re-executed. Never enqueues shadow
 * jobs, never touches receipts, never writes calendars.
 */
export function ingestNotifications(
  db: Database.Database,
  sessionId: string,
  options: IngestNotificationsOptions = {},
): { ingested: number; skipped: number; latestSeq: number } {
  const session = requireId(sessionId, "sessionId");
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    requireSession(db, session);
    const seqState = { next: readNextSeq(db, session) };
    const shadow = ingestShadowEventsInTx(db, session, seqState, now);
    const receipts = ingestReceiptsInTx(db, session, seqState, now);
    const tasks = ingestTaskEventsInTx(db, session, now);
    const latestRow = db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM notifications WHERE session_id = ?",
      )
      .get(session) as { max_seq: number };
    return {
      ingested: shadow.ingested + receipts.ingested,
      skipped: shadow.skipped + receipts.skipped + tasks.skipped,
      latestSeq: latestRow.max_seq,
    };
  });
}

export interface ListNotificationsOptions {
  limit?: number;
  /** Newest page strictly below this seq (history paging). */
  beforeSeq?: number;
  /** Read clock for derived `outdated` (expiry <= readNow). */
  now?: number;
}

export interface ListNotificationsForwardOptions {
  /** Forward-read cursor: notifications strictly after this seq. */
  after?: number;
  limit?: number;
  /** Read clock for derived `outdated` (expiry <= readNow). */
  now?: number;
}

function parseListLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RepositoryValidationError("limit must be an integer 1..100");
  }
  return value;
}

function readLatestSeq(db: Database.Database, session: string): number {
  const latest = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM notifications WHERE session_id = ?",
    )
    .get(session) as { max_seq: number };
  return latest.max_seq;
}

/**
 * Truthful unread count: unacked AND actionable (stored-outdated and
 * derived-expired rows are HISTORY and never count as unread). Pure read.
 */
function readUnreadCount(
  db: Database.Database,
  session: string,
  now: number,
): number {
  const unread = db
    .prepare(
      "SELECT COUNT(*) AS count FROM notifications n LEFT JOIN notification_acks a ON a.notification_id = n.id WHERE n.session_id = ? AND a.notification_id IS NULL AND n.outdated = 0 AND (n.context_expiry_at IS NULL OR n.context_expiry_at > ?)",
    )
    .get(session, now) as { count: number };
  return unread.count;
}

/**
 * Pure-read bounded newest page (newest first, strict 1..100 cap, optional
 * `beforeSeq` history cursor). Real SQL paging with a LIMIT+1 probe, so
 * `hasMore` / `nextBefore` are truthful and feeds never silently truncate.
 * Never auto-acks, never ingests, never baselines a cursor, never mutates
 * delivered state. Returns truthful latestSeq + unread counts.
 */
export function listNotifications(
  db: Database.Database,
  sessionId: string,
  options: ListNotificationsOptions = {},
): {
  items: NotificationView[];
  latestSeq: number;
  unreadCount: number;
  hasMore: boolean;
  nextBefore: number | null;
} {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = parseListLimit(options.limit);
  let beforeSeq: number | null = null;
  if (options.beforeSeq !== undefined) {
    if (!Number.isInteger(options.beforeSeq) || options.beforeSeq < 1) {
      throw new RepositoryValidationError("beforeSeq must be an integer >= 1");
    }
    beforeSeq = options.beforeSeq;
  }
  const now = nowMs(options.now);
  const rows = (
    beforeSeq === null
      ? db
          .prepare(
            "SELECT * FROM notifications WHERE session_id = ? ORDER BY seq DESC, id ASC LIMIT ?",
          )
          .all(session, capped + 1)
      : db
          .prepare(
            "SELECT * FROM notifications WHERE session_id = ? AND seq < ? ORDER BY seq DESC, id ASC LIMIT ?",
          )
          .all(session, beforeSeq, capped + 1)
  ) as StoredNotificationRow[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;
  return {
    items: page.map((row) => toNotificationView(row, now)),
    latestSeq: readLatestSeq(db, session),
    unreadCount: readUnreadCount(db, session, now),
    hasMore,
    nextBefore: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
  };
}

/**
 * Pure-read bounded forward page (`seq > after`, oldest first, strict
 * 1..100 cap). Real read-after SQL with a LIMIT+1 probe, so a future SSE
 * feed filtering AFTER a limited latest window never loses the first of
 * >100 new notices: every seq is delivered exactly once, even with equal
 * `createdAt` (ordering is by seq, never by timestamp). Never auto-acks,
 * never ingests, never baselines a cursor, never mutates anything.
 */
export function listNotificationsForward(
  db: Database.Database,
  sessionId: string,
  options: ListNotificationsForwardOptions = {},
): {
  items: NotificationView[];
  latestSeq: number;
  unreadCount: number;
  hasMore: boolean;
  nextAfter: number | null;
} {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const after = options.after ?? 0;
  if (!Number.isInteger(after) || after < 0) {
    throw new RepositoryValidationError("after must be an integer >= 0");
  }
  const capped = parseListLimit(options.limit);
  const now = nowMs(options.now);
  const rows = db
    .prepare(
      "SELECT * FROM notifications WHERE session_id = ? AND seq > ? ORDER BY seq ASC, id ASC LIMIT ?",
    )
    .all(session, after, capped + 1) as StoredNotificationRow[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;
  return {
    items: page.map((row) => toNotificationView(row, now)),
    latestSeq: readLatestSeq(db, session),
    unreadCount: readUnreadCount(db, session, now),
    hasMore,
    nextAfter: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
  };
}

export interface ReadNotificationOptions {
  /** Read clock for derived `outdated` (expiry <= readNow). */
  now?: number;
}

/** Pure-read single notification (foreign ids 404, never 403). */
export function getNotification(
  db: Database.Database,
  sessionId: string,
  notificationId: string,
  options: ReadNotificationOptions = {},
): NotificationView {
  return toNotificationView(
    assertOwnedNotification(db, sessionId, notificationId),
    nowMs(options.now),
  );
}

/**
 * Pure-read notification history: the immutable record plus its explicit
 * ack receipt (null when unacked). Never mutates anything.
 */
export function getNotificationHistory(
  db: Database.Database,
  sessionId: string,
  notificationId: string,
  options: ReadNotificationOptions = {},
): {
  notification: NotificationView;
  ack: {
    notificationId: string;
    sessionId: string;
    key: string;
    status: "acknowledged";
    createdAt: number;
  } | null;
} {
  const owned = assertOwnedNotification(db, sessionId, notificationId);
  const ack = db
    .prepare("SELECT * FROM notification_acks WHERE notification_id = ?")
    .get(owned.id) as
    | { session_id: string; ack_key: string; created_at: number }
    | undefined;
  return {
    notification: toNotificationView(owned, nowMs(options.now)),
    ack:
      ack === undefined
        ? null
        : {
            notificationId: owned.id,
            sessionId: ack.session_id,
            key: ack.ack_key,
            status: "acknowledged" as const,
            createdAt: ack.created_at,
          },
  };
}

/**
 * Pure-read feed cursor: per-source cursors + latest notification seq.
 * Strictly a SELECT: never acks, never ingests, never baselines or
 * advances a cursor.
 */
export function getLatestNotificationCursor(
  db: Database.Database,
  sessionId: string,
): {
  cursors: {
    source: NotificationCursorSource;
    lastSourceRowid: number;
    updatedAt: number;
  }[];
  latestSeq: number;
} {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const rows = db
    .prepare(
      "SELECT source, last_source_rowid, updated_at FROM notification_cursors WHERE session_id = ? ORDER BY source ASC",
    )
    .all(session) as {
    source: NotificationCursorSource;
    last_source_rowid: number;
    updated_at: number;
  }[];
  const latest = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM notifications WHERE session_id = ?",
    )
    .get(session) as { max_seq: number };
  return {
    cursors: rows.map((row) => ({
      source: row.source,
      lastSourceRowid: row.last_source_rowid,
      updatedAt: row.updated_at,
    })),
    latestSeq: latest.max_seq,
  };
}

export interface AckNotificationOptions {
  key: string;
  now?: number;
}

/**
 * Explicit ack receipt: separate immutable row owned by the session. The
 * same key + same notification replays the stored receipt; key drift (same
 * key on another notification, or a second key on an acked notification)
 * is 409; foreign ids are 404. An ack changes NO purpose / task / control /
 * Calendar grant / proposal / hypothesis — it only records the receipt.
 */
export function ackNotification(
  db: Database.Database,
  sessionId: string,
  notificationId: string,
  options: AckNotificationOptions,
): {
  status: number;
  body: {
    notificationId: string;
    sessionId: string;
    key: string;
    status: "acknowledged";
    createdAt: number;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    const owned = assertOwnedNotification(db, session, notificationId);
    const existing = db
      .prepare("SELECT * FROM notification_acks WHERE notification_id = ?")
      .get(owned.id) as
      | {
          session_id: string;
          ack_key: string;
          ack_body: string;
          created_at: number;
        }
      | undefined;
    if (existing !== undefined) {
      if (existing.ack_key !== key) {
        throw new NotificationKeyConflictError(
          `notification ${owned.id} already acked under a different key`,
        );
      }
      return {
        status: 200,
        body: {
          notificationId: owned.id,
          sessionId: existing.session_id,
          key: existing.ack_key,
          status: "acknowledged" as const,
          createdAt: existing.created_at,
        },
        replayed: true,
      };
    }
    const keyOwner = db
      .prepare(
        "SELECT notification_id FROM notification_acks WHERE session_id = ? AND ack_key = ?",
      )
      .get(session, key) as { notification_id: string } | undefined;
    if (keyOwner !== undefined) {
      throw new NotificationKeyConflictError(
        "ack key already used for another notification",
      );
    }
    const body = {
      notificationId: owned.id,
      sessionId: session,
      key,
      status: "acknowledged" as const,
      createdAt: now,
    };
    db.prepare(
      "INSERT INTO notification_acks (notification_id, session_id, ack_key, ack_body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(owned.id, session, key, JSON.stringify(body), now);
    return { status: 201, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Deadline schedule: build / read / record                           */
/* ------------------------------------------------------------------ */

export interface BuildDeadlineScheduleOptions {
  now?: number;
}

/**
 * (Re)build the derived deadline schedule for ONE session by ITERATING the
 * whole task source in bounded pages (never a 100-record silent
 * truncation). This is the startup rebuild; ongoing projection consumes
 * the durable `autonomy_task_events` cursor inside `ingestNotifications`.
 * Original task rows are NEVER changed or deleted — only derived schedule
 * rows are upserted / removed (completed / cancelled drops the row and
 * marks its alert history outdated). No queue, no notifications emitted
 * here (alerts come from `recordDueDeadlines`).
 */
export function buildDeadlineSchedule(
  db: Database.Database,
  sessionId: string,
  options: BuildDeadlineScheduleOptions = {},
): { upserted: number; removed: number; observed: number } {
  const session = requireId(sessionId, "sessionId");
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    requireSession(db, session);
    let upserted = 0;
    let removed = 0;
    let observed = 0;
    let offset = 0;
    for (;;) {
      const page = db
        .prepare(
          "SELECT * FROM autonomy_tasks WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
        )
        .all(session, SCHEDULE_PAGE, offset) as RawTaskRow[];
      if (page.length === 0) {
        break;
      }
      observed += page.length;
      for (const task of page) {
        const outcome = projectTaskDeadlineInTx(db, task, now);
        if (outcome === "upserted") upserted += 1;
        else if (outcome === "removed") removed += 1;
      }
      if (page.length < SCHEDULE_PAGE) {
        break;
      }
      offset += page.length;
    }
    // Drop schedule rows whose task vanished from the source scope view
    // (defensive: tasks are append-only, so this is normally empty). The
    // HISTORY stays; only the derived row goes.
    const orphaned = db
      .prepare(
        "SELECT s.task_id AS task_id FROM notification_deadline_schedule s LEFT JOIN autonomy_tasks t ON t.session_id = s.session_id AND t.id = s.task_id WHERE s.session_id = ? AND t.id IS NULL",
      )
      .all(session) as { task_id: string }[];
    for (const orphan of orphaned) {
      db.prepare(
        "DELETE FROM notification_deadline_schedule WHERE task_id = ?",
      ).run(orphan.task_id);
      removed += 1;
    }
    return { upserted, removed, observed };
  });
}

export interface NextDeadlineOptions {
  now?: number;
}

interface DeadlineScheduleRow {
  task_id: string;
  session_id: string;
  scope: string;
  due_at: number;
  observed_task_version: number;
  source_updated_at: number;
}

/**
 * Exact (taskId, EXACT deadline) alert fingerprint — the same string the
 * due recorder stores, so reads can tell genuinely-pending schedule rows
 * from already-alerted ones without touching history.
 */
function deadlineFingerprint(taskId: string, dueAt: number): string {
  return truncateCp(`v1|deadline|${taskId}|${dueAt}`, 500);
}

/** True when this EXACT deadline already produced its one alert. */
function isDeadlineAlerted(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  dueAt: number,
): boolean {
  const hit = db
    .prepare(
      "SELECT 1 AS hit FROM notifications WHERE session_id = ? AND fingerprint = ? LIMIT 1",
    )
    .get(sessionId, deadlineFingerprint(taskId, dueAt)) as
    | { hit: number }
    | undefined;
  return hit !== undefined;
}

/**
 * Pure-read pending probe for ONE schedule row: the CURRENT task still
 * carries this EXACT eligible deadline, the resume cutoff does not skip
 * it, and this EXACT deadline never alerted yet. Stale / terminal /
 * skipped / already-alerted rows are NOT pending — they must never arm
 * the single timer nor head-of-line-block rows behind them. Never mutates
 * anything (stale-row refresh belongs to the recorder).
 */
function isPendingDeadlineRow(
  db: Database.Database,
  sessionId: string,
  row: DeadlineScheduleRow,
  resumeCutoff: number,
): boolean {
  const task = readTaskRow(db, row.task_id);
  if (task === null || task.session_id !== sessionId) {
    return false;
  }
  if (isTerminalTaskStatus(task.status)) {
    return false;
  }
  const currentDue = eligibleDueAt(task);
  if (currentDue === null || currentDue !== row.due_at) {
    return false;
  }
  if (row.due_at < resumeCutoff && task.updated_at <= resumeCutoff) {
    return false;
  }
  if (isDeadlineAlerted(db, sessionId, row.task_id, row.due_at)) {
    return false;
  }
  return true;
}

/**
 * Pure-read future-deadline query: the earliest GENUINELY PENDING eligible
 * explicit deadline for the session (keyset-scanned past stale /
 * skipped / already-alerted head rows, never a 100-row silent
 * truncation), with the CURRENT control version + paused fence reported
 * honestly (paused still returns the pending row — it never fakes one;
 * the service simply arms no timer while paused). Null when nothing is
 * pending, so the service never re-polls an already-notified due.
 */
export function getNextDeadline(
  db: Database.Database,
  sessionId: string,
  options: NextDeadlineOptions = {},
): {
  status: "ready" | "control_paused";
  paused: boolean;
  controlVersion: number;
  deadline: {
    taskId: string;
    sessionId: string;
    scope: string;
    dueAt: number;
    observedTaskVersion: number;
    sourceUpdatedAt: number;
  } | null;
} {
  const session = requireId(sessionId, "sessionId");
  void nowMs(options.now);
  requireSession(db, session);
  const control = db
    .prepare(
      "SELECT paused, version, updated_at FROM autonomy_control WHERE id = 'global'",
    )
    .get() as
    | { paused: number; version: number; updated_at: number }
    | undefined;
  const paused = control?.paused === 1;
  const version = control?.version ?? 1;
  const resumeCutoff = control?.updated_at ?? 0;
  const status = paused ? "control_paused" : "ready";
  let lastDue: number | null = null;
  let lastTask: string | null = null;
  for (;;) {
    const page: DeadlineScheduleRow[] =
      lastDue === null
        ? (db
            .prepare(
              "SELECT task_id, session_id, scope, due_at, observed_task_version, source_updated_at FROM notification_deadline_schedule WHERE session_id = ? ORDER BY due_at ASC, task_id ASC LIMIT ?",
            )
            .all(session, SCHEDULE_PAGE) as DeadlineScheduleRow[])
        : (db
            .prepare(
              "SELECT task_id, session_id, scope, due_at, observed_task_version, source_updated_at FROM notification_deadline_schedule WHERE session_id = ? AND (due_at > ? OR (due_at = ? AND task_id > ?)) ORDER BY due_at ASC, task_id ASC LIMIT ?",
            )
            .all(
              session,
              lastDue,
              lastDue,
              lastTask,
              SCHEDULE_PAGE,
            ) as DeadlineScheduleRow[]);
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      lastDue = row.due_at;
      lastTask = row.task_id;
      if (!isPendingDeadlineRow(db, session, row, resumeCutoff)) {
        continue;
      }
      return {
        status,
        paused,
        controlVersion: version,
        deadline: {
          taskId: row.task_id,
          sessionId: row.session_id,
          scope: row.scope,
          dueAt: row.due_at,
          observedTaskVersion: row.observed_task_version,
          sourceUpdatedAt: row.source_updated_at,
        },
      };
    }
    if (page.length < SCHEDULE_PAGE) {
      break;
    }
  }
  return { status, paused, controlVersion: version, deadline: null };
}

export interface RecordDueDeadlinesOptions {
  /** CAS on the CURRENT control version (stale callers get zero rows). */
  expectedControlVersion: number;
  now?: number;
}

/**
 * Record due-deadline alerts for ONE session in a bounded transaction.
 * STOP disables autonomous deadline callback (`control_paused`, zero
 * recordings); a version mismatch reports `stale_epoch` with zero
 * recordings — never a fake alert. NO offline-time catchup: rows due
 * BEFORE the explicit-resume cutoff (`control.updatedAt`) are skipped
 * unless the task was meaningfully updated / created AFTER the resume; a
 * newly created explicit PAST deadline is NEW state and may log once.
 * The due scan KEYSET-DRAINS the whole due set past settled /
 * cutoff-skipped / already-alerted head rows (never a 100-row silent
 * truncation masking the 101st eligible task). Dedup is (taskId, EXACT
 * deadline) through hold / resume status changes — one alert per actual
 * deadline even after a meaningful task update; terminal tasks remove
 * only their derived schedule row. Recording NEVER marks a task held /
 * completed / resumed and NEVER creates calendar state.
 */
export function recordDueDeadlines(
  db: Database.Database,
  sessionId: string,
  options: RecordDueDeadlinesOptions,
): {
  status: "recorded" | "control_paused" | "stale_epoch";
  recorded: number;
  controlVersion: number;
} {
  const session = requireId(sessionId, "sessionId");
  if (
    !Number.isInteger(options.expectedControlVersion) ||
    options.expectedControlVersion < 1
  ) {
    throw new RepositoryValidationError("expectedControlVersion must be >= 1");
  }
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    requireSession(db, session);
    const control = db
      .prepare(
        "SELECT paused, version, updated_at FROM autonomy_control WHERE id = 'global'",
      )
      .get() as
      | { paused: number; version: number; updated_at: number }
      | undefined;
    const version = control?.version ?? 1;
    if (control?.paused === 1) {
      return {
        status: "control_paused" as const,
        recorded: 0,
        controlVersion: version,
      };
    }
    if (version !== options.expectedControlVersion) {
      return {
        status: "stale_epoch" as const,
        recorded: 0,
        controlVersion: version,
      };
    }
    const resumeCutoff = control?.updated_at ?? 0;
    const seqState = { next: readNextSeq(db, session) };
    let recorded = 0;
    let lastDue: number | null = null;
    let lastTask: string | null = null;
    for (;;) {
      const due: DeadlineScheduleRow[] =
        lastDue === null
          ? (db
              .prepare(
                "SELECT task_id, session_id, scope, due_at, observed_task_version, source_updated_at FROM notification_deadline_schedule WHERE session_id = ? AND due_at <= ? ORDER BY due_at ASC, task_id ASC LIMIT ?",
              )
              .all(session, now, DUE_SCAN_BATCH) as DeadlineScheduleRow[])
          : (db
              .prepare(
                "SELECT task_id, session_id, scope, due_at, observed_task_version, source_updated_at FROM notification_deadline_schedule WHERE session_id = ? AND due_at <= ? AND (due_at > ? OR (due_at = ? AND task_id > ?)) ORDER BY due_at ASC, task_id ASC LIMIT ?",
              )
              .all(
                session,
                now,
                lastDue,
                lastDue,
                lastTask,
                DUE_SCAN_BATCH,
              ) as DeadlineScheduleRow[]);
      if (due.length === 0) {
        break;
      }
      for (const row of due) {
        lastDue = row.due_at;
        lastTask = row.task_id;
        const task = readTaskRow(db, row.task_id);
        if (task === null || task.session_id !== session) {
          db.prepare(
            "DELETE FROM notification_deadline_schedule WHERE task_id = ?",
          ).run(row.task_id);
          continue;
        }
        if (isTerminalTaskStatus(task.status)) {
          db.prepare(
            "DELETE FROM notification_deadline_schedule WHERE task_id = ?",
          ).run(row.task_id);
          db.prepare(
            "UPDATE notifications SET outdated = 1 WHERE session_id = ? AND kind = 'deadline' AND source_id = ? AND outdated = 0",
          ).run(session, row.task_id);
          continue;
        }
        const currentDue = eligibleDueAt(task);
        if (currentDue === null || currentDue !== row.due_at) {
          // Deadline changed / cleared / became ineligible: refresh the
          // derived row, never alert on a stale value.
          projectTaskDeadlineInTx(db, task, now);
          continue;
        }
        // Offline-time rule: OLD past deadlines (due before the explicit
        // resume cutoff) stay silent unless the task was meaningfully
        // updated / created AFTER the resume. Skipped rows stay in the
        // schedule but never mask rows behind them (keyset advances).
        if (row.due_at < resumeCutoff && task.updated_at <= resumeCutoff) {
          continue;
        }
        // One alert per ACTUAL deadline: a meaningful task update stays
        // eligible, but the same task + same EXACT deadline never re-alerts.
        if (isDeadlineAlerted(db, session, row.task_id, row.due_at)) {
          continue;
        }
        const deadlineIso = task.deadline as string;
        const draft: NotificationDraft = {
          scope: task.scope,
          kind: "deadline",
          priority: "routine",
          briefText: `deadline due in scope ${task.scope}: ${truncateCp(task.title, 200)} is due at ${deadlineIso} — fixed system notice, verify against the task record`,
          sourceKind: "task_deadline",
          sourceId: task.id,
          sourceVersion: task.version,
          sourceEpoch: null,
          citedDeadlines: [deadlineIso],
          // Dedup (taskId, EXACT deadline): status / version / hold-resume
          // cycles are EXCLUDED so re-alerts never spam.
          fingerprint: deadlineFingerprint(task.id, row.due_at),
          // Deadline alerts never carry a derived question-context expiry.
          contextExpiryAt: null,
        };
        if (insertNotificationInTx(db, session, seqState, draft, now)) {
          recorded += 1;
        }
      }
      if (due.length < DUE_SCAN_BATCH) {
        break;
      }
    }
    return { status: "recorded" as const, recorded, controlVersion: version };
  });
}
