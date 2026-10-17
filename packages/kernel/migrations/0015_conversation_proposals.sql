-- AV03 conversation-proposal durable core (migration 0015).
--
-- Committed migration 0015: creates TWO new STRICT tables. It touches NO
-- existing table (0001-0014 preserved byte-for-byte, including the 0011
-- autonomy slice, the 0012/0013 shadow queue, and the 0014 notification
-- projection): the ONLY writer of the new tables is the conversation-
-- proposal core in `autonomy.ts` (staged by the model proposal-only tools
-- `purpose.propose` / `task.propose`, decided by the trusted human
-- accept/reject kernel API). No import into any M5 / memory / notification
-- writer exists.
--
-- What this is: a BORING durable PROPOSAL-ONLY staging area for inferred
-- conversation drafts. A proposal records the immutable ORIGINAL source
-- quote (an exact verbatim substring of the CURRENT ordinary `user_text`
-- turn body the calling run was dispatched from — server-derived from
-- `ctx.runId`, never model input) plus the SEPARATELY stored model
-- interpretation. Staging creates NO purpose, NO task, NO grant, NO
-- calendar write, NO memory heat, NO notification, and never resumes the
-- global stop control. Only the explicit trusted human adoption API
-- creates the actual purpose/task, atomically with the accept decision in
-- ONE transaction (no check-then-write gap, no crash window).
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - `source_quote` is the immutable ORIGINAL quote: rows are never UPDATE-
--   rewritten except for `status` / `version` / `updated_at` /
--   `accepted_target_id`. The model interpretation lives in the SEPARATE
--   `interpretation` column, never merged into the quote.
-- - `source_kind` is hardcoded `model` (inference, never a user instruction
--   and never an actual permission grant). A recorded `permission`-kind
--   purpose proposal is ONLY a claim: no executable grant, capability
--   write, OAuth, or config row exists in this migration.
-- - `draft_kind` is the explicit closed casual/wish/problem/task/deadline
--   set: a casual remark stays a casual draft (no mandatory taskization; a
--   model do-nothing stages nothing).
-- - `target` selects the adoption shape (`purpose` or `task`). Task drafts
--   REQUIRE an explicit parent purpose (id + expected version, same
--   session/scope, active, checked at stage AND re-checked at adopt); the
--   model can never auto-pick a parent. Purpose drafts carry no parent.
-- - NO model dates exist here: there is no deadline / validFrom / validUntil
--   column. Task drafts adopt with a NULL deadline unless the trusted human
--   supplies an explicit strict-RFC3339 deadline at accept time; purpose
--   drafts adopt with a NULL window unless the human supplies an explicit
--   strict window. The human deadline/window is validated by the service
--   against the existing strict grammar (never inferred, never parsed from
--   prose by this slice).
-- - `status` is pending/accepted/rejected. Accepted/rejected rows are
--   terminal and are never revived. No physical DELETE exists anywhere here.
-- - Dedup is semantic-state based: `request_hash` covers the full exact
--   draft input (session / scope / target / draft-kind / kinds / quote /
--   interpretation / parent / source turn+run) and EXCLUDES the broker call
--   id, so an ordinary repeated model call with identical input replays the
--   existing pending draft instead of duplicating. A meaningfully new
--   source (different quote) hashes differently and stages a new draft.
-- - Accept/reject decisions are append-only history rows in
--   `conversation_proposal_events`; rows are never updated or deleted.
-- - Query batches stay bounded (existing 50/100 list caps); no retry spin,
--   no unbounded arrays, no new numeric model bounds.

CREATE TABLE conversation_proposals (
  id                      TEXT PRIMARY KEY,  -- UUID v4
  session_id              TEXT NOT NULL REFERENCES sessions(id),
  scope                   TEXT NOT NULL
                          CHECK (length(scope) >= 1 AND length(scope) <= 128),
  target                  TEXT NOT NULL
                          CHECK (target IN ('purpose','task')),
  draft_kind              TEXT NOT NULL
                          CHECK (draft_kind IN ('casual','wish','problem','task','deadline')),
  purpose_kind            TEXT              -- set exactly when target = 'purpose'
                          CHECK (purpose_kind IS NULL OR purpose_kind IN ('goal','preference','constraint','permission','wish','temporary_state')),
  task_kind               TEXT              -- set exactly when target = 'task'
                          CHECK (task_kind IS NULL OR task_kind IN ('chat','wish','problem','task')),
  source_quote            TEXT NOT NULL     -- immutable ORIGINAL exact quote of the source user_text body
                          CHECK (length(source_quote) >= 1),
  interpretation          TEXT NOT NULL     -- SEPARATE model interpretation, never merged into the quote
                          CHECK (length(interpretation) >= 1),
  source_kind             TEXT NOT NULL DEFAULT 'model'
                          CHECK (source_kind = 'model'),
  source_turn_id          TEXT NOT NULL,    -- server-derived CURRENT ordinary user_text turn (same session)
  source_run_id           TEXT NOT NULL,    -- server-derived calling run (same session)
  parent_purpose_id       TEXT,             -- REQUIRED for task drafts (same-session/scope owned purpose)
  expected_parent_version INTEGER           -- REQUIRED for task drafts (CAS-checked at stage AND adopt)
                          CHECK (expected_parent_version IS NULL OR expected_parent_version >= 1),
  request_hash            TEXT NOT NULL     -- semantic exact-input hash (excludes broker call id)
                          CHECK (length(request_hash) = 64),
  stage_call_id           TEXT NOT NULL,    -- first staging broker call id (UUID v4, audit only)
  status                  TEXT NOT NULL
                          CHECK (status IN ('pending','accepted','rejected')),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  accepted_target_id      TEXT,             -- adopted purpose/task id, set exactly on accept
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (session_id, source_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, source_run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (session_id, parent_purpose_id) REFERENCES autonomy_purposes(session_id, id),
  UNIQUE (session_id, id),
  CHECK (
    (target = 'purpose' AND purpose_kind IS NOT NULL AND task_kind IS NULL
      AND parent_purpose_id IS NULL AND expected_parent_version IS NULL)
    OR
    (target = 'task' AND task_kind IS NOT NULL AND purpose_kind IS NULL
      AND parent_purpose_id IS NOT NULL AND expected_parent_version IS NOT NULL)
  ),
  CHECK (
    (status = 'accepted' AND accepted_target_id IS NOT NULL)
    OR
    (status != 'accepted' AND accepted_target_id IS NULL)
  )
) STRICT;

CREATE INDEX idx_conversation_proposals_session ON conversation_proposals(session_id, created_at);
CREATE INDEX idx_conversation_proposals_status ON conversation_proposals(session_id, status, created_at);
CREATE INDEX idx_conversation_proposals_hash ON conversation_proposals(session_id, request_hash);

CREATE TABLE conversation_proposal_events (
  id          TEXT PRIMARY KEY,  -- UUID v4
  proposal_id TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  event       TEXT NOT NULL
              CHECK (event IN ('proposed','accepted','rejected')),
  from_status TEXT,
  to_status   TEXT NOT NULL
              CHECK (to_status IN ('pending','accepted','rejected')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id) REFERENCES conversation_proposals(session_id, id),
  UNIQUE (proposal_id, seq)
) STRICT;

CREATE INDEX idx_conversation_proposal_events_proposal ON conversation_proposal_events(proposal_id, seq);
