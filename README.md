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
`{ path, alias? }`; unset means no Markdown connector),
`COMPANION_MODEL_JSON` (unset means no model; strict JSON object
`{ adapter, baseUrl, model, apiKey? }` with `adapter` `ollama` or
`openai-compatible`). Config is validated and frozen at startup.

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
use a fresh store). M2 local model is strict opt-in via
`COMPANION_MODEL_JSON` (unset registers no strategy, so runs fail closed
instead of producing fake LLM output); when set, the server builds a
loopback-only Ollama (`{base}/api/chat`) or OpenAI-compatible
(`{base}/v1/chat/completions`) gateway and registers the agent under
`m0-default` before engine start/listen. Model base URLs must be plain
`http` loopback (`127.0.0.1`/`localhost`/`::1`, no credentials/query);
model config and keys are never logged, and no direct model endpoint
exists. Adapter/model identifier metadata only is persisted in
`model_calls`; `apiKey`, `baseUrl`, prompts, raw responses, reasoning,
and secrets are never persisted or logged. Full contract: `docs/operations.md`.

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

## E2E smoke (plan §16 partial coverage, real browser; M3 NOT complete)

Chromium-only Playwright smoke over the production UI/server/core
(`apps/server/e2e/`, config `apps/server/playwright.config.ts`): the
`webServer` builds the UI bundle then boots the real Hono app on
loopback with a temp SQLite DB and a deterministic fake `RunStrategy`
registered under `m0-default` (no real LLM; behavior chosen from input
text only). Twelve tests in source (config `testMatch` covers all
three files): four `conversation.spec.ts` (echo answer,
type-while-active + stop-cancel, fail-then-retry,
strict-CSP/minimal-localStorage) plus three
`citation_recovery.spec.ts` (escaped citation drawer + CAS-select
with stale-PUT 409, lost-delivery same-key replay + reload recovery,
unknown-pending-key resend-required) plus five `sse_history.spec.ts`
(native SSE reconnect, dropped-frame JSON gap catch-up, corrupt
cursor x2 variants, seeded older-history). No API mocks.

Status 2026-09-08 (truthful limits): historical verified green —
public CI run `34223716404` on `master@34230696647` **completed
success** (`check (windows-latest)`, `check (ubuntu-latest)`, and
`e2e` jobs all success). Per-test executed count is **unverified via
unauthenticated public REST** (job/step conclusions only; logs need
auth) — source count is 12 and the config runs all three spec files.
Locally this worker executed **0** (no browser run here; docs-only
spike, dependencies untouched).
`pnpm typecheck` (root + `apps/server`) does NOT cover `e2e/` or
`playwright.config.ts`; the dedicated config
`apps/server/tsconfig.e2e.json` plus root `pnpm typecheck:e2e` exists
for that and is exercised in the CI `e2e` job (it is not equivalent
to the full E2E run). Dependency note: root
`@playwright/test` resolves from descendant workspace modules via
normal Node upward lookup (plus pnpm root `.bin` on the script PATH);
no separate `@companion/server` declaration is required. The E2E abort
path drops its stale releaser so `/release` cannot resolve an
already-rejected hang.

Not covered (remaining §16 acceptance gaps, not full closure):
dedicated JSON status fallback and duplicate-seq E2E remain outside
the current 12-test green; the historical green above does not close
§16 acceptance.
