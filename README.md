# Companion Harness

Local LLM reference harness (source-run only). See `docs/operations.md`
for the full operations contract and `docs/implementation_plan.md` for the
agreed plan (planning-only; the plan file itself is never edited by tasks).

## Quickstart (source run)

Requires Node.js `24.12.0` and pnpm `11.25.0`.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm start
```

Env: `COMPANION_DB_PATH` (default OS app-data
`companion-harness/companion.sqlite`), `COMPANION_HOST` (loopback only),
`COMPANION_PORT`, `COMPANION_TIME_ZONE` (IANA), `COMPANION_LOG_LEVEL`,
`COMPANION_MARKDOWN_ROOTS_JSON` (default `[]`, strict JSON array of
`{ path, alias? }`; unset means no Markdown connector).
Config is validated and frozen at startup.

## References (M1 Markdown, read-only)

Optional local Markdown vaults via `COMPANION_MARKDOWN_ROOTS_JSON`. One
connector owns all configured roots; files are never written. Exact bounds:
10000 files/vault, 1 MiB/file, query 1-256 code points, results default 10 /
max 20, snippet max 512 code points, UTF-8 NFC (fatal decode, never
replacement text). HTTP API is stored-only (`GET references`, `GET`
reference detail, `GET` reference sets, `GET`/`PUT` context; no HTTP
search/open/refresh/related). Search/open/refresh/related run only as
internal ToolBroker tools (`markdown.search`, `reference.open`,
`reference.refresh`, `reference.related`). Root configuration is
fingerprint-bound to the DB: changing it fails startup (revert config or
use a fresh store). M2 model/agent is not implemented, so runs fail closed
instead of producing fake LLM output. Full contract: `docs/operations.md`.

## Data and permissions

DB and backups are **plaintext**; protection relies on **OS file
permissions** (POSIX: dirs `0700`, files `0600`; Windows: current-user ACL
reliance, no chmod guarantee). Secrets are never stored in the DB. Logs are
stdout/stderr with fixed codes and scalar fields only.

## Maintenance

- Manual backup (stopped-server only):
  `pnpm --filter @companion/server backup` → prints only
  `companion-manual-<UTC>-<uuid>.sqlite` (basename, never a path; no flags;
  missing DB fails without creating files)
  (backup API → `.partial` → `quick_check` → atomic rename; never rotated).
- Manual restore (stopped-only): stop → preserve db/wal/shm → copy backup
  to temp target → `quick_check` → atomic rename → remove stale wal/shm
  only while stopped → start/migrate. No auto-restore.
- Full-store deletion (stopped-only): db/wal/shm + backups. No session
  delete/export API.
- DB+WAL above exactly 1 GiB logs a warning only (no vacuum/delete).
- No telemetry, no app log files. No HTTP backup/restore/delete endpoints.

Full sequence and limitations: `docs/operations.md`.
