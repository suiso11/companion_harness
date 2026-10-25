-- Schema31: persist the immutable per-execution materialization reference on
-- the existing auto-dispatch ledger. No new queue/table/engine is introduced:
-- one authorized execution carries the exact sealed snapshot, dependency
-- depot, executor/check/runtime digests and private bridge config produced
-- BEFORE the one-use trial grant. The public execution view projects only
-- scalar summary fields; private paths never leave the host.
ALTER TABLE autodispatch_executions ADD COLUMN materialization_json TEXT;
ALTER TABLE autodispatch_executions ADD COLUMN materialization_digest TEXT
  CHECK (materialization_digest IS NULL OR length(materialization_digest) = 64);
