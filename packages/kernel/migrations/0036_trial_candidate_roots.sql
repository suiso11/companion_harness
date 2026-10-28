-- Claim-time resolved candidate roots for stable review (#175).
-- The runner resolves the operator template and sealed source snapshot at
-- claim time; persisting them keeps artifact lookup tied to the execution's
-- own frozen tree instead of the currently published template. Nullable:
-- legacy rows fall back to the current template.
ALTER TABLE trial_grants ADD COLUMN candidate_state_dir TEXT
  CHECK (candidate_state_dir IS NULL OR (length(candidate_state_dir) BETWEEN 1 AND 4096));
ALTER TABLE trial_grants ADD COLUMN candidate_source_dir TEXT
  CHECK (candidate_source_dir IS NULL OR (length(candidate_source_dir) BETWEEN 1 AND 4096));
