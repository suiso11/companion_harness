-- Host-observed bridge diagnostics for sealed trial reports (#167).
-- The bridge stderr head is observed by the HOST runner, so it must not be
-- stored in unresolved_json (guest-reported-unattested). One bounded array
-- (max 4 items x 512 bytes UTF-8) with its own provenance. Additive column:
-- pre-existing rows read back as an empty list.
ALTER TABLE trial_worker_reports
  ADD COLUMN host_diagnostics_json TEXT NOT NULL DEFAULT '[]'
  CHECK (length(host_diagnostics_json) <= 4096);
