-- Schema33: human-only confirmation of chat-adopted goals. A purpose that
-- was adopted from a conversation proposal is stored non-explicit with
-- source_kind='self' and can therefore never authorize a trial; the
-- confirmation route flips exactly that record to an explicit user goal
-- in place. Provenance of the confirmation is recorded next to the row
-- (confirmed_from / confirmed_at) instead of forging a new user turn.
-- Additive only: existing rows keep NULL provenance.
ALTER TABLE autonomy_purposes ADD COLUMN confirmed_from TEXT;
ALTER TABLE autonomy_purposes ADD COLUMN confirmed_at INTEGER;
