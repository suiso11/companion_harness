-- I04 (F-I04-03/F-I04-05): revision-pinned memory evidence (additive).
-- - `memory_exposures.revision` pins the record revision DELIVERED at
--   recall time (NULL = pre-I04 row or unrevisioned source; never
--   backfilled).
-- - `memory_exposures.kind` mirrors the recall item's provenance kind
--   (closed union; NULL = unknown/absent, never presented as fact).
-- - `memory_grants.revision` is copied from the SAME-run exposure when a
--   cited `mN` is granted (citation pinned to the delivered revision).
-- Rows are immutable after creation: no UPDATE path ever rewrites these
-- columns. Old rows keep NULL (upgrade-safe ALTER TABLE ADD COLUMN).
ALTER TABLE memory_exposures ADD COLUMN revision INTEGER
  CHECK (revision IS NULL OR revision >= 1);
ALTER TABLE memory_exposures ADD COLUMN kind TEXT
  CHECK (kind IS NULL OR kind IN ('user_fact','model_inference','summary'));
ALTER TABLE memory_grants ADD COLUMN revision INTEGER
  CHECK (revision IS NULL OR revision >= 1);
