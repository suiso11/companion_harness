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
| `COMPANION_MARKDOWN_ROOTS_JSON` | `[]` | Strict JSON array of `{ path, alias? }` (see below); unset means no Markdown connector |
| `COMPANION_MODEL_JSON` | unset (no model) | Strict JSON object `{ adapter, baseUrl, model, apiKey? }` (see M2 below); unset registers no model strategy |

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

## Markdown references (M1, read-only)

Unset `COMPANION_MARKDOWN_ROOTS_JSON` (default `[]`) means no Markdown
connector and no reference tools (M0 behaviour). When set, exactly one
connector instance owns **all** configured roots.

### Root configuration format

- Exact format: a strict JSON array of objects with only `{ path, alias? }`.
  Example (POSIX): `[{"path":"/srv/notes","alias":"notes"}]`. Example
  (Windows generic): `[{"path":"C:/Notes","alias":"notes"}]`. Quoting for
  the JSON env value is shell-dependent; pass one JSON document as a single
  env value.
- `path`: non-empty absolute path, max 4096 chars, no NUL byte.
- `alias` (optional): `1-64` chars matching
  `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`; duplicates rejected. Max 1024 roots.
- Unknown keys, scalars, objects, non-absolute paths, and malformed JSON are
  rejected fail-closed at startup with a fixed safe message (no paths
  logged). The parsed roots are deep-frozen (no hot reload).

### Fingerprint-bound connector (startup gate)

- The connector identity fingerprint (derived from the resolved roots) is
  persisted on the single connector instance row with the expected root
  count. Changing roots, count, order, or aliases afterwards **fails
  startup** (fixed `connector config fingerprint mismatch`-family error).
- There is **no automatic rebinding**. Operators must either revert the
  config to the previously accepted roots, or intentionally start from a
  fresh store (see full-store deletion above) when a new root set is wanted.

### Read-only bounds, safety, and skips

- Markdown files are **never written**. There is no HTML rendering, no
  semantic/fuzzy search, and no FTS: search is whole-query literal
  substring only, under NFC normalization plus locale-independent
  per-code-point case folding.
- Exact bounds: **10000** files per vault (exceeding fails the whole
  search), **1 MiB** per file (raw or NFC-normalized UTF-8 bytes),
  query **1-256** code points, results **default 10 / max 20**, snippet max
  **512** code points (first body hit, deterministic order: title exact,
  then title substring, then body, canonical-key tie-break).
- Oversize files are never truncated: they become explicit `skipped`
  entries. Invalid UTF-8 is a fatal `invalid_utf8` skip (never replacement
  text). Bodies are stored as saved full normalized (NFC) Snapshot text.
- Safety: reads verify realpath containment inside the configured roots
  before and after reading; external symlinks are rejected, internal
  aliases fold to one canonical resource; reads use resolve+stat,
  no-follow open where available, fstat identity comparison, and post-read
  recheck.

### Expanded link graph budget (M1, agreed)

- One `markdown.search` / `reference.refresh` call may persist at most
  **256KiB** of normalized link graph metadata. There is **no per-link
  count cap**.
- Over budget, the whole call fails with **`output_too_large`**: no
  truncation, no partial writes. `reference.open` / `reference.related`
  never expand the graph. Exact accounting is defined in the
  implementation plan (§14.6).

### Stored-only reference HTTP API

- `GET /api/sessions/:sessionId/references` (saved reference list).
- `GET /api/sessions/:sessionId/references/:referenceId` (saved detail;
  returns the stored full normalized body, never rereads the external file).
- `GET /api/sessions/:sessionId/reference-sets/:setId` (saved set detail).
- `GET /api/sessions/:sessionId/reference-context` and
  `PUT /api/sessions/:sessionId/reference-context` (frozen context
  summary; optimistic version check).
- There is **no HTTP search/open/refresh/related**: those paths return
  validation/unknown-route errors. Reads create no events or grants.

### Internal-only ToolBroker tools

- Exact tool names: `markdown.search`, `reference.open` (stored-only),
  `reference.refresh` (only reread path; always a new Snapshot + rN),
  `reference.related` (saved link graph only). They are callable only from
  inside a running Run via ToolBroker (ownership/budget/audit); there is no
  direct POST endpoint for them.

### M2 local model (strict opt-in)

- Unset `COMPANION_MODEL_JSON` (default) registers **no model strategy**:
  runs fail closed with a fixed code instead of producing fake LLM output.
- When set, the value must be a strict JSON object with only
  `{ adapter, baseUrl, model, apiKey? }`. Example:
  `{"adapter":"ollama","baseUrl":"http://127.0.0.1:11434","model":"llama3.1"}`.
  `adapter` is `ollama` (POST `{base}/api/chat`) or `openai-compatible`
  (POST `{base}/v1/chat/completions`, or `{base}/chat/completions` when the
  base already ends in `/v1`). `baseUrl` must be plain `http` on a loopback
  host (`127.0.0.1` / `localhost` / `::1`) with no credentials, query, or
  fragment (normalized form is stored). `model` is `1-256` chars;
  `apiKey`, when present, is a non-empty string up to `4096` chars.
  Unknown keys, scalars, arrays, and malformed JSON are rejected
  fail-closed at startup with a fixed safe message (no URLs, names, or
  key material logged).
- The server builds the gateway from the frozen config and registers the
  M2 agent strategy under `m0-default` **before** engine recovery/start
  and listen. The agent reuses the M1 ToolBroker when Markdown roots are
  configured, otherwise a private empty-registration broker (no direct
  model endpoint is ever added; `answer.submit` stays a reserved
  non-broker terminal protocol).
- Security limitations: model config values and keys are **never logged**
  (only the tool count is logged); `model_calls` persists adapter/model
  identifier metadata only (adapter, model, outcome, error code, timing,
  usage token counts). `apiKey`, `baseUrl`, prompts, raw responses,
  reasoning, and secrets are never persisted or logged; single attempt per
  step (no retry, no fallback, no router, no redirects); per-step 120s
  and 300s whole-run wall budgets with at most one repair inside max 8
  steps; native tool calling only.

### Conversation memory (strict opt-in remind CLI)

- Unset `COMPANION_MEMORY_JSON` (default) means fully memoryless: no
  service, no recall hook, no outbox jobs, no timers (M0/M1/M2 behavior
  preserved exactly).
- When set, the value must be a strict JSON object with only
  `{ executable, entry, config, scope, timeoutMs?, maxResponseBytes?,
  recallLimit?, idleMs? }`. Example:
  `{"executable":"/usr/bin/node","entry":"/srv/remind/dist/src/cli.js","config":"/srv/remind/mem.json","scope":"personal"}`.
  `executable`/`entry`/`config` must be absolute paths (no shell, no
  lookup: the child is spawned with `shell: false` and exactly
  `[entry, --config, config]` plus one LF-framed JSON line on stdin).
  `scope` is `1-256` chars with no control characters; every CLI call
  carries it and cross-scope records are never surfaced.
  `timeoutMs` default `5000` (bounds `500..30000`),
  `maxResponseBytes` default `65536` (bounds `4096..1048576`),
  `recallLimit` default `5` (bounds `1..8`),
  `idleMs` default `30000` (bounds `5000..300000`).
  Unknown keys, scalars, and malformed JSON are rejected fail-closed at
  startup with a fixed safe message (no paths, scopes, or values logged).
- The remind CLI child is the ONLY remind interface: Companion never
  opens, imports, or reads the remind DB. All durable Companion-side
  state lives in `memory_outbox` / `memory_exposures` / `memory_grants`;
  the CLI idempotency key always equals the outbox job's stable key, so
  crash replays reuse the same key and never duplicate a write.
- Pre-answer recall is fail-open (any failure yields a memoryless
  response; the run never fails for memory). Structured extraction runs
  only through the EXISTING local model gateway: without
  `COMPANION_MODEL_JSON` there is no extraction (recall/outbox still
  function); invalid extraction output conservatively yields no memory.
  Feedback is granted ONLY for structural `mN` citations present in the
  ACCEPTED completed answer's citation arrays (never prose, never mere
  exposure). Idle `maintain.distill` runs one bounded batch per idle
  period anchored to the last completed run; a model-unavailable
  (LLM-disabled) distill answer acks normally with zero writes.
- Live HTTP smoke, 2026-10-15 (local, temp stores only): real Companion
  server + synthetic loopback Ollama gateway (scripted `answer.submit`
  plus `{"memories":[...]}` extraction) + REAL remind CLI against a
  temporary DB (`allowedScopes ["personal","default"]`, LLM/vectors
  disabled). Turn 1 (`I like green tea.`) completed with durable
  `event.append` + `record.remember` both `acked` (attempts 0) and a
  direct CLI `record.recall` returning 1 item with the snippet; turn 2
  (`What did you note about green tea?`) recalled and answered with
  structural `citations: ["m1"]`, and `record.feedback` acked with a
  same-run `m1` grant row; idle `maintain.distill` auto-enqueued and
  acked (degraded: LLM disabled, zero writes — scheduling proof only,
  not a model result). Foreground/start/stop preemption is covered by
  existing unit regressions, not re-demonstrated here. No fake
  real-model claims: the gateway is synthetic and labelled as such.
- Permanent live regression (real HTTP + real CLI, temp stores only):
  `apps/server/test/memory_live_http.test.ts` runs a real loopback server
  with the synthetic gateway above (honestly labeled, never a real model)
  and the REAL remind CLI (`dist/src/cli.js` via `COMPANION_MEMORY_TEST_ENTRY`
  or the sibling checkout, template `memory.config.example.json` patched at
  runtime to temp `dbPath`/`vaultPath` with `vectors/llm.enabled=false`;
  missing CLI/template fails with a prerequisite error, never a false pass).
  Runnable: `pnpm exec vitest run apps/server/test/memory_live_http.test.ts`.
  It asserts turn-1 `event.append` + `record.remember` `acked`, direct CLI
  `record.recall` returning the snippet, turn-2 structural `citations: ["m1"]`
  with a same-run `m1` grant and acked `record.feedback`, no grants/feedback
  for the uncited first turn, idle `maintain.distill` `acked` (degraded
  scheduling proof only), and graceful shutdown with a reaped child.
  Verified 2026-10-15: 1/1 passed (~16s). Limits: synthetic gateway only
  (no real-model result), foreground/shutdown preemption edges remain
  covered by `memory_service.test.ts` unit regressions, Windows manual
  smoke and current remote CI remain open.
- Not implemented (unchanged): memory perception/reactivation/
  retirement, user export, and memory/session deletion APIs. There is no
  per-session memory delete/export endpoint.

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
