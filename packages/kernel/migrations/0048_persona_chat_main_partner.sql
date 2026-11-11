-- Main-agent partner for persona conversations. `partner_id` stays a FK to
-- personas for persona partners; `partner_main = 1` marks the real main
-- agent instead (mutually exclusive with partner_id, enforced in the store).
ALTER TABLE persona_chats
  ADD COLUMN partner_main INTEGER NOT NULL DEFAULT 0 CHECK (partner_main IN (0, 1));
