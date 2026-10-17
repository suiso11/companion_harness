-- AV04 learning durable core (migration 0016).
--
-- Committed migration 0016: creates THREE new STRICT tables. It touches NO
-- existing table (0001-0015 preserved byte-for-byte, including the 0011
-- autonomy slice, the 0012/0013 shadow queue, the 0014 notification
-- projection, and the 0015 conversation-proposal staging): the ONLY writer
-- of the new tables is the learning core in `learning.ts` (human-explicit
-- HTTP API + model proposal-only/read-only tools). No import into any
-- purpose / task / grant / control / budget / notification writer exists.
--
-- What this is: a BORING durable record of METHODS / HYPOTHESES plus
-- append-only EVIDENCE anchored to EXISTING durable sources only. A
-- hypothesis is explicitly labeled as such in every read DTO (status +
-- evidence counts, never presented as fact). Status changes ONLY via
-- explicit human transitions (support / refute / retire, CAS-checked):
-- no automatic promotion to fact exists anywhere in this migration.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - `statement` is the immutable ORIGINAL text: rows are never UPDATE-
--   rewritten except for `status` / `version` / `staged` /
--   `needs_reevaluation` / `updated_at`. Learning NEVER writes purposes,
--   tasks, grants, controls, budgets, permissions, or notifications.
-- - `kind` is the closed method|hypothesis set; `status` is the closed
--   open|supported|refuted|retired set. A `refuted` row is still labeled
--   `refuted` on read (never surfaced as supported/fact).
-- - `origin` is human|model. Model-origin rows are staged pending
--   (`staged = 1`) with a server-derived source run+turn and REQUIRE an
--   explicit human accept (staged -> 0, still `open`) or reject (-> retired)
--   before they count as adopted. Human-origin rows are never staged.
-- - `learning_evidence` is append-only: rows are never updated or deleted.
--   `polarity` is supports|refutes|neutral; `source_kind` is the CLOSED
--   shadow_job|conversation_proposal|action_receipt|task_event set and
--   `source_id` anchors to an EXISTING durable row (validated by the
--   service, same session): completed shadow jobs, decided (accepted /
--   rejected) conversation proposals, durable action receipts, durable task
--   events. Model free-text claims are NEVER valid sources. A rejected
--   conversation proposal anchors ONLY `refutes` polarity (never supports,
--   never creates purposes/preferences/permissions); success evidence never
--   alters control/grants/budget (this slice has no such columns at all).
-- - `needs_reevaluation` is a durable NOTICE (not a mutation of any user
--   purpose): when a parent purpose is revoked/superseded, hypotheses in
--   the same scope are flagged in the SAME transaction (never auto-
--   cancelled, never auto-resumed). Clearing happens only via an explicit
--   human transition. No notification rows are written for routine
--   learning (no make-work notifications).
-- - Every hypothesis lifecycle row is append-only history in
--   `learning_hypothesis_events`; rows are never updated or deleted.
-- - Query batches stay bounded (existing 50/100 list caps); no retry spin,
--   no unbounded arrays, no new numeric model bounds.

CREATE TABLE learning_hypotheses (
  id                      TEXT PRIMARY KEY,  -- UUID v4
  session_id              TEXT NOT NULL REFERENCES sessions(id),
  scope                   TEXT NOT NULL
                          CHECK (length(scope) >= 1 AND length(scope) <= 128),
  kind                    TEXT NOT NULL
                          CHECK (kind IN ('method','hypothesis')),
  statement               TEXT NOT NULL     -- immutable ORIGINAL text
                          CHECK (length(statement) >= 1),
  status                  TEXT NOT NULL
                          CHECK (status IN ('open','supported','refuted','retired')),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  origin                  TEXT NOT NULL
                          CHECK (origin IN ('human','model')),
  staged                  INTEGER NOT NULL CHECK (staged IN (0,1)),
  needs_reevaluation      INTEGER NOT NULL DEFAULT 0 CHECK (needs_reevaluation IN (0,1)),
  source_run_id           TEXT,              -- server-derived, model origin only
  source_turn_id          TEXT,              -- server-derived, model origin only
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (session_id, source_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, source_run_id) REFERENCES runs(session_id, id),
  UNIQUE (session_id, id),
  CHECK (
    (origin = 'model' AND source_run_id IS NOT NULL AND source_turn_id IS NOT NULL)
    OR
    (origin = 'human' AND source_run_id IS NULL AND source_turn_id IS NULL)
  ),
  CHECK (
    (staged = 1 AND origin = 'model')
    OR
    (staged = 0)
  )
) STRICT;

CREATE INDEX idx_learning_hypotheses_session ON learning_hypotheses(session_id, created_at);
CREATE INDEX idx_learning_hypotheses_scope ON learning_hypotheses(session_id, scope, status, created_at);
CREATE INDEX idx_learning_hypotheses_status ON learning_hypotheses(session_id, status, created_at);

CREATE TABLE learning_evidence (
  id              TEXT PRIMARY KEY,  -- UUID v4
  hypothesis_id   TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  polarity        TEXT NOT NULL
                  CHECK (polarity IN ('supports','refutes','neutral')),
  source_kind     TEXT NOT NULL
                  CHECK (source_kind IN ('shadow_job','conversation_proposal','action_receipt','task_event')),
  source_id       TEXT NOT NULL     -- anchors to an EXISTING durable row
                  CHECK (length(source_id) >= 1),
  note            TEXT              -- optional human annotation, never a fact claim
                  CHECK (note IS NULL OR length(note) >= 1),
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (session_id, hypothesis_id) REFERENCES learning_hypotheses(session_id, id),
  UNIQUE (session_id, id)
) STRICT;

CREATE INDEX idx_learning_evidence_hypothesis ON learning_evidence(hypothesis_id, created_at);

CREATE TABLE learning_hypothesis_events (
  id            TEXT PRIMARY KEY,  -- UUID v4
  hypothesis_id TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL CHECK (seq >= 1),
  event         TEXT NOT NULL
                CHECK (event IN ('created','proposed','accepted','rejected','evidence_attached','supported','refuted','retired','reevaluation_flagged','reevaluation_cleared')),
  from_status   TEXT,
  to_status     TEXT NOT NULL
                CHECK (to_status IN ('open','supported','refuted','retired')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (session_id, hypothesis_id) REFERENCES learning_hypotheses(session_id, id),
  UNIQUE (hypothesis_id, seq)
) STRICT;

CREATE INDEX idx_learning_hypothesis_events_hypothesis ON learning_hypothesis_events(hypothesis_id, seq);
