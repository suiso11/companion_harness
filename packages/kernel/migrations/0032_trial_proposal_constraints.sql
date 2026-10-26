-- Schema32: freeze the plan's decisions/non-goals/steps as the wire
-- `constraints` list on the existing trial proposal. Additive only: manual
-- staging keeps the empty default, and no new table/queue/engine is added.
-- Content is already prefixed and bounded by the kernel before grant; an
-- overflow is denied at authorization, never truncated here.
ALTER TABLE trial_proposals ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]';
