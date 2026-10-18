-- I01-06: explicit per-run memory status (additive, metadata only).
-- Closed status union: used | empty | disabled | unavailable | timeout |
-- version_mismatch | limit. NULL = the run never reached the recall
-- boundary (or predates this column). Never carries memory content.
ALTER TABLE runs ADD COLUMN memory_status TEXT
  CHECK (memory_status IS NULL OR memory_status IN (
    'used', 'empty', 'disabled', 'unavailable', 'timeout',
    'version_mismatch', 'limit'
  ));
