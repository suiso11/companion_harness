# Operations (M0, §19)

Source-run local web app. No installers/packages, no remote access/auth,
no external telemetry, no app-managed rolling log files.

## Source run

Requirements: Node.js `24.12.0`, pnpm `11.25.0` (see `engines` +
`packageManager`).

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm start            # serve on loopback only (127.0.0.1 / localhost)
```

Manual backup (stopped-server only, no listener/scheduler started):

```sh
pnpm --filter @companion/server backup
```

Takes exactly `backup` with no arguments or path flags. The DB path comes
only from `COMPANION_DB_PATH` (or the OS default) and the backup dir is
always `<data>/backups`. Prints only the backup file basename on success;
a missing DB fails without creating any DB or backup files.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `COMPANION_DB_PATH` | OS app-data `companion-harness/companion.sqlite` | Absolute or resolved; symlinks rejected fail-closed |
| `COMPANION_HOST` | `127.0.0.1` | Loopback only (`127.0.0.1` / `localhost`) |
| `COMPANION_PORT` | `3000` | `0` = ephemeral (tests only) |
| `COMPANION_TIME_ZONE` | `UTC` | IANA name only (Intl membership) |
| `COMPANION_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

Config is Zod-validated and frozen at startup (no hot reload).

## Plaintext sensitivity and OS permissions

The DB and backups are stored **in plaintext** (no app-level encryption).
Protection relies on **OS file permissions**; credentials/secrets are never
stored in the DB.

- POSIX: app dir and `backups/` are `0700`; DB and backup files are `0600`.
  A POSIX app-dir `chmod` failure aborts startup fail-closed (fixed safe
  error, no path logged).
- Windows: there is **no chmod security guarantee**. Rely on the
  current-user profile ACL (per-user `%APPDATA%`); do not assume `chmod`
  restricts access.

Logs carry fixed codes plus scalar ids/sizes/durations only (stdout/stderr).
No message text, tool/model I/O, file paths, or secrets. Startup/shutdown
`status` values are a fixed vocabulary (`unknown` fallback); arbitrary
reason/error names never enter logs. The DB path is never logged.

## Capacity warning

DB + WAL combined size above exactly **1 GiB** emits a startup warning log
(`server.store_size_warning` with `bytes` only). Warning only: no vacuum,
no delete, no auto-shrink.

## Manual backup (stopped-server only)

- Sole copy method: better-sqlite3 `Database.backup`. Never `VACUUM INTO`
  or online raw file copy.
- Path: `<data>/backups/companion-manual-<UTC>-<uuid>.sqlite`
  (`<UTC>` = `YYYYMMDDTHHMMSSZ`).
- Procedure: `.partial` backup → private permissions (`0600`; Windows
  no-op) → `quick_check` of the copy → atomic rename.
- Manual backups are **never rotated** and never match the
  `companion-pre-migration-` prefix. The only automatic deletion is the
  newest-3 pre-migration rotation.
- Exposed only as the stopped-server CLI command above. **No HTTP
  backup/restore/delete endpoints exist.** The CLI takes no path flags,
  uses only the configured DB path, prints only the backup basename, and
  reports failures with fixed safe text only (no paths, no raw errors).

## Manual restore (stopped-only, exact sequence)

1. Stop the server.
2. Preserve the current db / wal / shm files (copy aside, do not delete yet).
3. Copy the selected verified backup to a temp target next to the
   configured DB.
4. Run `PRAGMA quick_check` against the temp copy; abort on failure.
5. Atomic rename the temp copy onto the configured DB path.
6. Only while still stopped, remove stale `-wal` / `-shm` sidecars.
7. Start the server (startup will migrate as needed).

There is no automatic restore/rollback.

## Full-store deletion (stopped-only)

1. Stop the server.
2. Delete the configured db file, its `-wal` / `-shm` sidecars, and the
   `backups/` contents under the app-data directory.
3. Start only when a fresh store is intended.

There is **no session-level delete/export API** (no per-session physical
deletion, no user export). Domain data is otherwise never auto-deleted
(RunEvent/Snapshot/Reference/Receipt kept indefinitely).

## Non-goals (explicit)

Domain retention/GC (except newest-3 backup rotation), user export,
session delete API, running-process deletion, auto-restore, DB/backup
encryption, external telemetry, app-managed log files, installers,
remote access/auth.

## Platform / TOCTOU limitations

- better-sqlite3 opens by path with no portable no-follow open; a symlink
  swap in the narrow open→recheck window cannot be fully eliminated. The
  bootstrap narrows it with pre-open lstat guards plus an immediate
  post-open recheck (fail closed).
- Backup prune re-verifies containment + non-symlink immediately before
  delete (best-effort TOCTOU narrowing).
- POSIX permission bits are not meaningful on Windows (see above).
