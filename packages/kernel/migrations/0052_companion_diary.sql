-- Companion private diary (additive, internal only).
--
-- Exactly one companion-written entry per local calendar day (`day` is the
-- primary key, so a second write for the same day is a no-op). This is the
-- companion's own first-person diary, NOT user memory: it is never written
-- by the model directly and never enters remind. `body` is bounded; read
-- through GET /api/diary.
CREATE TABLE companion_diary (
  day        TEXT PRIMARY KEY,
  body       TEXT NOT NULL CHECK (length(body) >= 1 AND length(body) <= 2000),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
