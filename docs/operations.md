# Operations (M0, §19)

Source-run local web app. No installers/packages, no remote access/auth,
no external telemetry, no app-managed rolling log files.

## Source run

Requirements: Node.js `26.12.0`, pnpm `11.25.0` (see `engines` +
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
| `COMPANION_TIME_ZONE` | `UTC` | IANA name only (Intl membership). The production launcher `run-google-readonly.sh` (systemd `companion.service` ExecStart) defaults it to `Asia/Tokyo` only when unset; an explicit export wins |
| `COMPANION_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `COMPANION_MARKDOWN_ROOTS_JSON` | `[]` | Strict JSON array of `{ path, alias? }` (see below); unset means no Markdown connector |
| `COMPANION_MODEL_JSON` | unset (no model) | Strict JSON object `{ adapter, baseUrl, model, apiKey? }` (see M2 below); unset registers no model strategy |
| `REMIND_LLM_API_KEY` | unset | Bearer token for the remind CLI retention classifier (`activation.llm.apiKeyEnv`). `run-google-readonly.sh` derives it from `.env.litellm` `LITELLM_MASTER_KEY` only when it is not already set, and never logs it. The child inherits it because Companion spawns remind without an `env` override. Same key is already present in `COMPANION_MODEL_JSON` / the LiteLLM proxy config, so the exposure is unchanged |
| `COMPANION_EXECUTION_RECORDS_JSON` | unset (no private records) | Strict JSON object `{ directory, retentionDays? }`: absolute `directory`, `retentionDays` integer `0..3650` default `30` (see "Private execution records" below); no HTTP surface |
| `COMPANION_CALENDAR_JSON` | unset (no Calendar) | Strict JSON object `{ selection, connector }` (see C14 below); unset registers no Calendar connector |
| `COMPANION_CALENDAR_PROFILE` | unset (no profile) | Strict opt-in profile selector (see C14 profile below). Unset keeps the previous behavior (explicit host `mcpDefinitions` injection or fail-closed incomplete opt-in). Only `google-readonly` is accepted; any other value fails startup. Requires `COMPANION_CALENDAR_JSON` describing exactly the adopted candidate. |
| `COMPANION_ACTIONS_JSON` | `{"optIn":false,"writeEnabled":false}` | Strict JSON object `{ optIn?, writeEnabled? }` (booleans, default false). HINT ONLY: never supplies a write capability, a category or a binding — see "C21 M5 Action composition" below |
| `COMPANION_REMOTE_JSON` | unset (remote disabled) | Strict JSON object `{ enabled?, allowedOrigins?, passwordFile?, absoluteTimeoutMs?, idleTimeoutMs?, maxFailures?, lockoutMs? }` (see "Remote access" below); unset means loopback-only behavior, unchanged |
| `COMPANION_WEB_SEARCH_JSON` | unset (web search disabled) | Strict JSON object `{ enabled?, searxng_base_url?, max_results?, timeout_ms?, per_turn_budget?, max_response_bytes? }` (see "Web search (SearXNG)" below); unset means no `web.search` tool |

Config is Zod-validated and frozen at startup (no hot reload).

## Remote access (allowlist + single-user login, default-off)

Slices (a) + (b) of the Linux remote-access plan: an explicit
Origin/Host allowlist plus single-user password login with server-issued
session cookies, **default-off**. The server always binds loopback-only
(`COMPANION_HOST` stays `127.0.0.1` / `localhost`; `0.0.0.0` is still
rejected). Remote reachability is provided outside the app (for example
`tailscale serve` terminating tailnet HTTPS and proxying to
`127.0.0.1:<port>`); the app itself holds no TLS keys.

- Format: `COMPANION_REMOTE_JSON='{"enabled":false,"allowedOrigins":["https://<host>.<tailnet>.ts.net"]}'`.
  `enabled` defaults to `false`; `allowedOrigins` defaults to `[]` (max 16
  entries, 256 chars each). Every entry must be an exact `https://<host>`
  origin: https scheme, no credentials, no explicit port, no path, query,
  fragment, or trailing slash (the entry must equal its own `URL.origin`
  serialization). Unknown keys, duplicates, and malformed JSON fail
  startup with a fixed safe message (no values logged). Unset is the
  same as disabled; malformed JSON fails startup fail-closed (never a
  silent disable).
- Disabled (default): Host/mutation checks behave exactly as before
  (loopback Host only, loopback same-origin mutations, no read check).
  There is no login surface (`/api/remote/login` answers 404).
- Enabled: the Host header must equal an allowlist origin's host or a
  loopback host (health endpoints included); mutations require an exact
  Origin match against the allowlist plus the current loopback
  same-origin; GET API routes and SSE additionally require a present
  Origin to match (an absent Origin on same-origin GETs stays accepted,
  but `Sec-Fetch-Site: cross-site` is rejected). `Origin: null` is always
  rejected. Decisions use only Host/Origin/Sec-Fetch-Site headers — never
  `remoteAddress` or `X-Forwarded-*` (proxied requests all look like
  `127.0.0.1`, so the login rate limit is a single global counter, not
  per-IP) — and no CORS headers are emitted.
- Login/sessions (slice b): single-user password plus server-issued
  session cookie (`companion_remote`: opaque 256-bit random, `HttpOnly` /
  `Secure` / `SameSite=Strict` / `Path=/`). The scrypt password hash
  lives in a file OUTSIDE SQLite at the absolute path in `passwordFile`
  (required when enabled; POSIX mode must be 0600 — any group/other
  access bit refuses startup; created via `pnpm --filter server
  set-password`, which reads the password twice from TTY/stdin and never
  from env/argv). Sessions persist only SHA-256 token hashes in SQLite
  (`remote_sessions`, additive migration `0023_remote_sessions.sql`).
  The global login failure counter and lockout are persisted in
  SQLite too (`remote_login_lockout`, additive migration
  `0024_remote_login_lockout.sql`), so a process restart (including an
  auto-deploy restart) cannot clear an active lockout.
  Tunables with 案 defaults: `absoluteTimeoutMs` (30d),
  `idleTimeoutMs` (7d), `maxFailures` (5), `lockoutMs` (15min).
  All API + SSE
  require a session (401 JSON); `/health/live` stays open while
  `/health/ready` requires a session. A browser form POST to
  `/api/remote/login` redirects to `/` (303) on success; JSON logins
  answer `{ ok: true }`.
- Fail-closed: `enabled: true` with an empty allowlist refuses to start.
  Flipping `enabled` back to `false` restores loopback-only operation.

## Plaintext sensitivity and OS permissions

The DB, backups, and the opt-in private execution-record files are stored
**in plaintext** (no app-level encryption). Protection relies on **OS file
permissions**; credentials/secrets are never stored in the DB.

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
- Manual backups are never rotated by the server itself and never match the
  `companion-pre-migration-` prefix. The only automatic deletion is the
  newest-3 pre-migration rotation. The daily backup job additionally prunes
  legacy `companion-manual-*.sqlite` generations in `<data>/backups/` to the
  newest `COMPANION_BACKUP_KEEP` (default 7).
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

## Web search (SearXNG, default off)

`web.search` is a single read-only model tool that submits a bounded query
to ONE self-hosted SearXNG endpoint and materializes the hits as session
references (`r1..rN`), never as raw upstream payloads. Unset
`COMPANION_WEB_SEARCH_JSON` (default) means no web connector, no
registration and NO tool in the model-facing tool list (fail-closed).

### Enabling steps (requires a slice-1 SearXNG deployment)

1. Deploy a local SearXNG instance reachable on the loopback interface
   (e.g. `127.0.0.1:8888`); only loopback http(s) URLs are accepted.
2. Start the server with:

   ```
   COMPANION_WEB_SEARCH_JSON='{"enabled":true,"searxng_base_url":"http://127.0.0.1:8888"}'
   ```

3. Optional strict fields (validated, defaults shown): `max_results: 5`
   (1..8), `timeout_ms: 10000` (1000..60000), `per_turn_budget: 3`
   (1..8, per-run `web.search` calls), `max_response_bytes: 1048576`
   (1024..8388608).
4. Verify the tool is advertised: a model turn may now call `web.search`
   and cite the resulting `rN` references. Disabled (unset) never
   advertises the tool, and invalid JSON / non-loopback URLs fail startup
   closed (never silently disabled).

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
  `{ adapter, baseUrl, model, apiKey?, toolChoice?, reasoningBudgetTokens? }`.
  Example:
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
- Optional **main-conversation thinking budget**:
  `reasoningBudgetTokens` (integer `0..2147483647`, `openai-compatible`
  only; Ollama rejects it fail-closed). It is serialized as the top-level
  `reasoning_budget_tokens` field on every main-agent step and repair, and
  never on auxiliary memory/voice/learning calls (those keep their own
  reasoning-off requests). The stock launcher leaves
  `reasoningBudgetTokens` unset (no app-level thinking cap); the local
  llama-server for the main model enforces a 2048-token server-side
  `--reasoning-budget` (2026-10-26), so runaway thinking cannot consume the
  output budget and 300s step budget. Every foreground agent step (repair
  included) additionally sends an explicit `maxOutputTokens` of
  `AGENT_MAX_OUTPUT_TOKENS` = 8192 (`max_tokens` for OpenAI-compatible,
  `num_predict` for Ollama). 8192 covers the 2048-token thinking budget plus
  a normal answer and costs at most ~136s at the production ~60 tok/s,
  inside the 300s step budget and the 65536-token production context. An
  already-exported `COMPANION_MODEL_JSON` wins for the gateway target and
  may add `reasoningBudgetTokens`; the output cap is fixed by the agent.
  Timeouts, answer limits, retries, and model choice are unchanged.
  Production evidence without the server budget: chat thinking never
  terminated, requests were observed/reported at 4096 output tokens at
  ~20 tok/s (two concurrent duplicates), and the chat turn timed out at
  300.22s. That 4096 was not configured in `compose.yaml` or
  `litellm_config.yaml` (llama.cpp's `n_predict` default is -1 and the
  LiteLLM openai provider sends no `max_tokens` when omitted), so its exact
  source is inferred (LiteLLM's global `DEFAULT_MAX_TOKENS` accounting
  default), not confirmed; the agent now sends 8192 explicitly. Normal
  reasoning measured <=1251 chars, so 2048 only cuts runaway thinking.
- Truncated steps: model-local maps OpenAI-compatible `finish_reason`
  "length" (non-stream and stream) and Ollama `done_reason` "length" to
  `stopReason: "length"`. A valid lone `answer.submit` is still accepted; a
  truncated step without one consumes the single repair slot with a
  length-specific hint (truncated ordinary calls are never executed). If
  the repair is also truncated the Run fails with the existing answer error
  code and `model.step.failed.reason = "output_truncated"`; the UI shows
  「出力が上限で途中で切れました」.
- Fixed safe failure diagnostics: `model.step.failed` may include
  `gatewayErrorCode` (model-local closed code such as `request_failed`,
  `timeout`, `invalid_response`), `invalidResponseCause` (`response_too_large`
  or `malformed_json`), and numeric `httpStatus` (100..599). These are
  allowlisted fixed/numeric values only; prompts, bodies, headers, raw
  errors, and secrets are never logged. The public M2 error code is
  unchanged.
- Tolerant citations: when `answer.submit` fails **only** because individual
  citation entries are invalid (too long, bad `rN`/`mN` format, unknown or
  unresolvable reference id, or more than 8 per part), the kernel drops those
  entries and accepts the answer with its text unchanged. The first eight
  structurally valid entries per part survive; no citation is invented,
  rewritten, or re-targeted. Non-citation failures (parts/text size, total
  bytes, unknown keys, non-citation shape) still take the existing
  `answer_invalid` repair path. Each accepted drop emits the fixed
  `answer.citations_dropped` log with `{ runId, step, dropped, reasons }`
  (`too_long|invalid_format|unresolved|over_limit`) and never carries citation
  ids or model text. There is no minimum-citation rule: an answer whose
  citations are all dropped is accepted with none.
- Security limitations: model config values and keys are **never logged**
  (only the tool count is logged); `model_calls` persists adapter/model
  identifier metadata only (adapter, model, outcome, error code, timing,
  usage token counts). Public logs/audit never persist `apiKey`, `baseUrl`,
  prompts, raw responses, reasoning, or secrets; the ONLY exception is the
  explicit private execution-record store below (default off), which also
  never records `apiKey` or headers. Single attempt per
  step (no retry, no fallback, no router, no redirects); per-step 300s
  and 600s whole-run wall budgets with at most one repair inside max 8
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
- Speaker grounding (2026-10-26): extraction input wraps the user turn in
  `<user_message>` and the answer in `<assistant_message>`, entity-escaping
  each segment so content cannot break out of its own block. The strict
  `{"memories":[...]}` schema adds an optional `evidence` string (bounded
  to 500 code points) that is REQUIRED for `user_fact`: it must be a
  verbatim quote from the user turn (NFKC + whitespace-normalized
  substring). Missing, paraphrased, or assistant-only evidence downgrades
  the item to `model_inference` (the memory is kept, never dropped, and
  never presented as a user fact); `evidence` is grounding input only and
  is never persisted. `summary`/`model_inference` may omit it. Prompt rule:
  assistant-only suggestions, assumptions, and inferences are never
  restated as user facts. Recall already carries each item's kind and
  renders it as `- mN [kind]: ...`, with only `user_fact` labeled as a
  user-stated fact.
- Learning speaker grounding (2026-10-27): conversation-learning extraction
  now uses the same shared delimiters/escaping and grounding helper
  (`apps/server/src/extraction_grounding.ts`) as memory. The extraction
  input wraps the accepted turn in `<user_message>` / `<assistant_message>`
  (entity-escaped), and a `user_confirmed_feedback` lesson is accepted ONLY
  when its `evidence` is a verbatim NFKC/whitespace-normalized substring of
  the user's own message. Assistant-only evidence is downgraded to
  `observation` (kept, never user-confirmed); evidence grounded in neither
  speaker is still dropped. The approved-lesson advisory block labels every
  kind and states that only `[user_confirmed_feedback]` reflects what the
  user said; all other kinds are unverified model observations. The
  pending/approval flow is unchanged.
- Memory dates: extraction anchors relative dates (`今日暑い`,
  `今週の金曜日`, `一昨日`) to the turn's date in
  `COMPANION_TIME_ZONE` and writes ABSOLUTE dates into the extracted
  memory. Recall lines show the record date as `(記録: YYYY-MM-DD)` in
  the same zone (omitted when unavailable), and the memory panel/detail
  surfaces the same date. Chat receives a per-turn `現在日時: …` line
  appended to the current user content — never in the static system
  prompt, so the cached prefix is unchanged. Extraction runs with
  reasoning off. The zone is frozen per turn from startup config; the
  host's OS zone is never consulted.
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
   Verified 2026-10-15: 1/1 passed (~16s). CI provides the REAL CLI: the
   workflow checks out the pinned remind source
   (`suiso11/remind@3a0afdcae71d11ada65239dfae2bb1b25bac4b6c`,
   remind master incl. remind#16 recall fields + remind#19 privacy support
   + remind#28 graph ops + remind#29 topic/auto-association;
   remind#29 merge commit 3a0afdc) into `.ci/remind`, builds it (`npm ci` + `npm run build`,
   no models), and sets `COMPANION_MEMORY_TEST_ENTRY` /
   `COMPANION_MEMORY_TEST_CONFIG_TEMPLATE` to the built entry + template.
   Limits: synthetic gateway only
   (no real-model result), foreground/shutdown preemption edges remain
   covered by `memory_service.test.ts` unit regressions; Windows manual
   smoke remains open. Re-verified 2026-10-16 on the baseline branch with
   the pinned `.ci/remind` CLI: 1/1 passed (~16s); baseline-worktree full
   suite 112 files / 1362 tests green, `tsc --noEmit` exit 0,
   `biome check .` clean.
- Explicit management (search / correct / retire / reactivate),
  2026-10-15 (local, temp stores only): `POST .../memory/search` is
  explicit user-directed only and returns opaque session-scoped `mN`
  handles for active AND retired records (never archived/superseded);
  a search never heats, reactivates, or grants feedback (zero
  `record.feedback` jobs from search). `GET .../memory/detail` keeps
  the immutable cited snapshot distinct from the live current record
  (provenance source `companion:conversation`); the UI confirm panel
  shows current vs snapshot before staging a mutation. `record.correct`
  stages a REAL `event.append` (raw source carrying the user's
  replacement) followed by `record.correct`, both `acked` in the
  Companion outbox under one stable idempotency key; same key+body
  replays the stored operation, same key+drifted body is 409 (no
  silent rebind). `record.retire` excludes the record from REAL CLI
  `record.recall` while a fresh explicit search still returns the
  handle with status `retired`; `record.reactivate` restores it
  (search shows active again, CLI recall returns the snippet). This
  is reversible retirement, not deletion/hiding: no delete/export/
  perception surface exists. UI races are closed synchronously:
  search/target invalidation with monotonic generation guards (stale
  responses never apply), new-operation staging resets pending state
  and binds poll identity to the fresh operation (no stale ack reuse).
  Integrity edges are covered by unit regressions: ambiguous-model
  refusal, atomic op/outbox/followup staging, replay-first state
  recovery, terminal-failure marking, and cancellation.
- Read-only graph view (list/graph switch in the memory panel):
  `GET /api/sessions/:sessionId/memory/graph` returns the global graph
  (`includeRetired=false` by default);
  `GET /api/sessions/:sessionId/memory/graph/local?searchId=&handle=&depth=1|2`
  expands one already-bound handle. Both are strict-query, run-owned,
  read-only (never heat or grant feedback), and return opaque `mN`
  handles only. The client lays the graph out in the measured canvas size,
  greedily declutters labels (selected/hovered and their neighbours first,
  then topic hubs, then degree), and offers zoom in/out/全体表示 plus a
  display-only 「自動関連を表示」 toggle for similarity edges. Topic hubs are
  minted only for topics shared by at least two visible memories; a
  single-member topic stays on the memory's tooltip instead of adding a
  perimeter hub. Handles are
  reused per `(record_id, status)` through
  `memory_graph_searches` (one durable `query='graph'` search per
  `(session, scope)`), so re-opening a graph never grows rows; edges are
  rewritten to handles before serialization, and an unchanged
  `graph.version` reuses the bounded in-process cache. If the remind
  build has no graph ops the routes answer
  `503 memory_graph_unavailable` and the UI shows
  「グラフ機能は記憶サーバーの更新後に利用できます」 while the list
  stays usable; this clears once a graph-capable remind build is deployed
  (suiso11/remind#28 is merged; CI is pinned to its merge commit
  `1d79cf2`). Verified 2026-10-22 with the `1d79cf2` build: graph live
  and e2e run (never skip). Verified 2026-10-21: graph unit/HTTP/UI + kernel suites
  green, typecheck/lint clean, real-CLI live
  `memory_graph_live.test.ts` 1/1 and `memory_manage_live.test.ts` 1/1.
  Real browser:
  `COMPANION_E2E_MEMORY=1 COMPANION_MEMORY_TEST_ENTRY=<remind dist/src/cli.js>
  COMPANION_MEMORY_TEST_CONFIG_TEMPLATE=<remind memory.config.example.json>
  pnpm --filter @companion/server exec playwright test --config
  playwright.config.ts` runs the memory specs, including
  `e2e/memory/memory_graph.spec.ts` (2/2).
- Permanent regressions (temp stores only, no user DB writes):
  `pnpm exec vitest run apps/server/test/memory_manage.test.ts`
  (unit: guards, idempotent replay + partial-chain recovery, no-heat
  search, retire/search/reactivate lifecycle, immutable citations,
  native tool-flow budgets; real migrated `:memory:` kernel DB +
  injected fake CLI);
  `pnpm --filter @companion/server exec vitest run
  test/memory_manage_live.test.ts` (live: real HTTP + synthetic
  gateway, honestly labeled NOT a real model, + REAL remind CLI temp
  DB; proves search-incl-retired/no-heat, snapshot-vs-current detail,
  real correct chain acked + stored-operation replay, retire/reactivate
  against REAL CLI recall);
  `COMPANION_E2E_MEMORY=1 pnpm --filter @companion/server exec
  playwright test --config playwright.config.ts` (real browser:
  `e2e/memory/memory_manage.spec.ts` drives the REAL memory panel UI
  against the REAL Hono app + RunEngine + REAL remind CLI temp DB;
  synthetic scripted gateway cultivates one fact, never a real model).
   Verified 2026-10-15: full Vitest **113 files / 1370 tests passed**,
   real-browser memory spec GREEN, live HTTP/real-CLI GREEN, root +
   e2e `tsc --noEmit` exit 0, `pnpm lint` GREEN. The remote `e2e` job
   runs the same real-browser memory spec with `COMPANION_E2E_MEMORY=1`
   against the CI-built pinned remind CLI above. Limits: synthetic
   gateway only (no real-model result); Windows manual smoke remains
   open.
- Topic-based association (remind#29, 2026-10-22): extraction may return
  additive `topics` (0..3 general-category nouns, each 1..12 code points,
  NFKC+trim, deduped) that ride `record.remember` as `tags` (sliced to
  remind's `tagsMax`=5); an invalid topics field is dropped per field and
  never drops the memory. Idle maintenance backfills older records:
  `topic.pending {scope, limit:8}` → one conversation-model
  classification call per item (same gateway/model/abort/timeout as
  extraction) → a direct `topic.set {id, bodyHash, topics}` keyed by
  `(id, bodyHash)`, bounded per tick and preemptible by foreground
  activity/stop, then `maintain.associate {scope}` once after each new
  remember and while the last pass reported `remaining > 0`. The graph
  adds derived `similar` edges plus client-only topic-hub nodes
  (Obsidian-style tags; a hub is not a memory, so it never opens detail),
  and the list view browses every memory with internal scrolling (the
  search results remain one click away via 「すべて表示」). Dependency:
  suiso11/remind#29 must merge first; an old remind answers `BAD_REQUEST`
  for `topic.pending`/`maintain.associate`, so those surfaces latch off
  silently until restart while the legacy graph/list keep working.
- Derived consolidation + activation (remind >=`795c476`, 2026-10-24):
  the same idle tick continues after association with
  `maintain.consolidate {scope}` — NO `limit`, because remind's
  `consolidate.batchMax` (default 5) rejects a larger limit with
  `LIMIT_EXCEEDED` and the CLI applies its configured batch size (clusters
  depend on topics and edges, so it runs after `maintain.associate`;
  re-armed by a new remember or association pass, and for the next idle
  tick only while the real response reports `applied > 0`; deferred/
  no_grounded clusters wait for that re-arm instead of looping) —
  and `maintain.activation {scope, limit:20}` (armed by a remember or
  consolidation, at most once per idle pass). Each metric is one event
  with a numeric `status` (the logger preserves numbers): consolidation
  emits `memory.idle.consolidate.applied` / `.written` / `.unchanged` /
  `.no_grounded` / `.deferred` / `.degraded` (0|1); activation emits
  `memory.idle.activation.scored` / `.score_failed` / `.would_retire` /
  `.would_reactivate` / `.retired` / `.reactivated` / `.degraded` (0|1),
  so the preview signal (`wouldRetire`/`wouldReactivate`) is visible in
  structured logs. An unparseable response logs
  `memory.idle.consolidate.invalid` / `memory.idle.activation.invalid`
  with `status:1`. Activation is
  PREVIEW-ONLY by decision (2026-10-24): remind's config keeps
  `activation.apply=false`, so Companion never sends `apply:true` — the op
  scores derived importance and reports what would change without changing
  record status. Both calls use per-pass idempotency keys, the distill-grade
  timeout, foreground preemption/stop abort, single-flight, and the same
  old-remind `BAD_REQUEST` latch-until-restart (silent, no retry storm).
  `LIMIT_EXCEEDED` is treated as a permanent misconfiguration: logged once
  and latched off until restart, never retried every tick.
- Not implemented (unchanged): memory perception, user export, and
  memory/session deletion APIs. There is no per-session memory
  delete/export endpoint.
- Shutdown/job bounds (verified 2026-10-16 on the baseline branch;
  baseline-worktree evidence: live real-CLI regression 1/1, full suite
  112 files / 1362 tests green, `tsc --noEmit` exit 0, `biome check .`
  clean):
  `memory.stop()` runs FIRST on every teardown path (graceful shutdown,
  listen-failure catch, outer startup-failure catch) — idle timer
  cancelled, then every active drain tick's own `AbortController` aborted
  (recovery, foreground, and idle ticks alike) and the in-flight tick
  awaited, so no CLI child outlives a rejected startup or touches the
  repo/DB after close. Each drain tick executes at most
  `MEMORY_DRAIN_BATCH = 5` jobs TOTAL (claim bound shrinks with the
  remaining budget; follow-up chains continue on a later drain). CLI stdin
  failures (EPIPE/write) kill and settle only at the `close` reap, never
  overlapping a retry with a live child. Deterministic regression:
  `bootstrap.test.ts` "stops memory before DB close when listen fails on
  an occupied port" defers the REAL `EADDRINUSE` bind (test-only
  `net.Server.listen` wrapper, no production hook) until the recovery
  child observably started, then asserts the rejection reaped it
  (`kill(pid, 0)` throws), signal counts restored, DB reopens, and a free
  port retry succeeds.

## Private execution records (opt-in, no HTTP surface)

Unset `COMPANION_EXECUTION_RECORDS_JSON` (default) keeps the previous
behavior: public `run_events` / `model_calls` / `tool_calls`, SSE,
history, logs, and memory stay metadata-only. When set, the value must
be a strict JSON object with only `{ directory, retentionDays? }`:

- `directory`: absolute host path, 1-4096 chars, no NUL. Every ancestor
  is `lstat`-checked; symlinks/non-directories refuse startup.
- `retentionDays`: integer `0..3650`, default `30`; `0` prunes every
  record older than the startup time. Unknown keys and malformed JSON
  fail startup fail-closed.
- The store is separate from SQLite and the public audit. No HTTP route
  returns or deletes records.

Recorded kinds (private, debug-oriented): `model.request` (provider,
base/chat URL, model, messages, tool definitions, step settings, system
prompt, prompt variant, harness fingerprint), `model.response.raw`
(status plus the received body, including streaming SSE bytes and
malformed bodies; streaming raw bytes are retained only up to the
effective per-call response cap, so the record stores a bounded prefix
when SSE framing exceeds it; headers are never captured), `model.response`
(normalized text/tool calls/stop reason/usage/duration),
`model.outcome`, `tool.input`, `tool.result`, `tool.error`,
`tool.handler.result` / `tool.handler.error` (raw handler settlement,
including late/discarded dispositions). `web.search` (SearXNG) calls
are recorded like any other tool. Cancellation/timeout produces no raw
response record.

Redaction is structural only: credential-shaped object keys
(case-insensitive, `_`/`-` ignored) are removed, and encoded JSON
request/response bodies or tool arguments are parsed and filtered
recursively. Free text (e.g. message content) is preserved verbatim and
may contain secrets. Files are not encrypted at rest.

Permissions: constructed directories `0700`, files `0600` on POSIX;
pre-existing ancestors (e.g. `/tmp`) are never re-permissioned. Writes
are atomic (`.tmp-*` → fsync → rename); a crash may leave an incomplete
entry that `list` reports (never silently counted). Per-record size is
bounded; an oversized record carries explicit `omitted` metadata. A
recording write failure fails that model/tool invocation and the Run
rather than producing a silent partial record; if a public audit row
already exists, it settles before the failure is raised.

Operator CLI (local only; fails closed when the variable is unset;
stderr carries fixed safe text, never paths/ids/payloads):

```sh
pnpm records list
pnpm records show <recordId>
pnpm records export <runId>   # full records for one run as JSON on stdout
pnpm records delete <recordId>
pnpm records prune [days]     # default = configured retentionDays
```

## Voice layer (strict opt-in, local only)

Unset `COMPANION_VOICE_JSON` (default) keeps every answer canonical and
omits `voice` from RunResult. When set (and `COMPANION_MODEL_JSON` is also
configured), the value must be a strict JSON object with only
`{ profile, timeoutMs? }`:

```sh
COMPANION_VOICE_JSON='{"profile":"shunkin","timeoutMs":30000}'
```

- `profile` must be a bundled profile id (currently only `shunkin`); no
  filesystem path is accepted. `timeoutMs` is an integer `1000..120000`,
  default `30000`. Unknown keys, malformed JSON, and unknown profiles fail
  startup closed. Disabling voice restores byte-identical pre-voice results.
- The canonical StructuredAnswer is validated first. Only after the step's
  model_calls row and terminal event are durable does one auxiliary model
  call run, with reasoning off and an output cap derived from the canonical
  character count (clamped to 256-4096 tokens). Any parsing-valid response
  with one part per canonical part is accepted and shown; the prompt asks
  the model to preserve facts, numbers, URLs, citation markers, and code,
  but there is no structural fidelity gate. Only timeout, provider error,
  malformed/empty output, a wrong part count, or an oversized canonical
  answer falls back to the canonical text with a fixed reason.
- The call is not an agent step: it writes no `model_calls` row, consumes no
  step/tool budget, and never extends the 600s run wall. It is bounded by
  `timeoutMs` and the remaining wall budget. The current main model takes
  roughly 1-4s per answer.
- Canonical text remains authoritative for history projection, memory
  intake, citations, and comparison output. `RunResult.voice` is only an
  optional projection; the UI defaults to voiced text and offers an
  「原文」/「話し方」 toggle per answer. Voiced text is never streamed: the
  draft streams canonical and the voiced version appears at completion.
- The `shunkin` profile draws on 谷崎潤一郎『春琴抄』 (青空文庫, public
  domain) and 船場言葉 features documented at Wikipedia 大阪弁#船場言葉.
- Limits: without the gate, a voiced rendering can change negation or
  ASCII wording if the model drifts; prompt-based style can drift across
  models; LoRA is future work (a per-request LoRA would apply only to the
  voice call). Because `voice` extends the strict RunResult schema, a
  pre-voice build cannot read rows that contain it.

## Fixed-task comparison CLI (experimental)

`pnpm compare -- /abs/input.json` is an operator experiment, not a
production feature. It runs the real RunEngine + agent strategy twice:
baseline uses only the immutable base system prompt; the variant appends
the operator guidance to that same base prompt (never replaces it).
`COMPANION_MODEL_JSON` is required and uses the same strict
loopback-only parser as the server.

Input is strict version-1 JSON: `version` (`1`), `prompt` (1..20000
chars), `docs` (1..6 `{ key, path, title? }`; absolute non-symlink
regular UTF-8 files ≤32 KiB each, unique keys
`^[a-z][a-z0-9_-]{0,63}$`, title defaults to the basename),
`storageDirectory` (absolute), `variant` (`{ label, systemPrompt }`,
label `^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$`, guidance 1..8000 chars),
`timeoutMs?` (integer 1..900000, default 180000), `maxSteps?`
(integer 1..8). Unknown keys, non-absolute paths, and invalid documents
fail closed.

`storageDirectory` is created `0700` when missing (symlink/non-directory
rejected). Each invocation creates a fresh `comparison-*` directory
containing a dedicated SQLite DB and private `records/` store. Only the
fixed document tool (`experiment.read`) and the terminal
`answer.submit` are available; production MCP/Calendar/Web tools are
never registered. Output is JSON on stdout: task/document hashes, model
adapter/model, and for baseline and variant the actual answer
parts/citations, citations, tool calls, token counts, durations, status,
error code, and private-record count/kinds. It computes no score and
never auto-adopts a variant.

### MCP library wire identity (C09; not server-enabled)

- The connector's trusted config must carry an explicit `expectedServerName`
  and `version`. Both are compared **exactly** (case-sensitive) against the
  ACTUAL `initialize.serverInfo` `name`/`version` of the bound MCP server.
  There is no default and no inference from `serverId` (a logical id) or the
  actual response; a programmatic config that omits either fails closed.
- The wire gate runs on **every real transport, before any `tools/list` and
  before any binding is enabled**. A missing/mismatched identity disables ALL
  configured bindings, closes the half-open child, and reports the existing
  fixed `mcp_schema_mismatch` (no raw identity is surfaced). A malformed SDK
  initialize that the SDK connect rejects or cannot parse stays the existing
  fixed `mcp_unavailable`; a post-connect mismatched wire identity stays the
  fixed `mcp_schema_mismatch`.
- Only after the wire gate passes are `tools/list` pages followed (bounded)
  and each binding verified by exact upstream tool name + canonical
  input-schema SHA-256. Correct wire identity with one drifted tool is
  partial drift: the matching tool stays callable, the drifted tool stays
  denied with the same fixed `mcp_schema_mismatch`.
- `isAllowed`/`stats().enabledBindings` advertise **only** bindings validated
  on the current live connection; configured-but-drifted names stay lazy and
  never trigger an upstream call. Shutdown or a failed logical call clears
  them.
- NOT added here: readonly-binding registration, upstream fork pinning,
  OAuth, or server enablement. The formal status stays **HOLD**; other C09
  lifecycle checks and the C10/C11 gates remain open. The CURRENT constructor
  additionally requires the reviewed host `McpBindingDefinition[]` second
  argument (see "C09-01 / C09-04 / C09-07 / C09-08" below): the
  `new McpConnector(cfg)` calls in the PR15/PR16 archives are the HISTORICAL
  API, not a compatibility shim, and this phase still registers nothing.

Config fragment (trusted fields only; **not** a production command, profile,
or complete activate config):

```json
{
  "kind": "mcp",
  "serverId": "<logical id; never compared to the wire name>",
  "expectedServerName": "<exact initialize.serverInfo.name>",
  "version": "<exact initialize.serverInfo.version>",
  "bindings": [
    { "upstreamTool": "<exact tool name>", "canonicalSchemaHash": "<64 hex>" }
  ]
}
```

### C09-02 / C09-03 demand lifecycle verification status

- This subsection records **only** C09-02 (lazy-on-demand connect + exact
  backoff) and C09-03 (per-instance concurrency / no automatic resend /
  independent instances); it is not a global "only these are verified" claim.
- Lazy: the first configured demand dials immediately; construction and idle
  time never create a transport. A valid live client/handshake is reused across
  later demands (no new factory call).
- Failure backoff follows exactly `1s, 2s, 5s, 10s, 30s, 30s` (max `30s`); a
  successful connect resets the failure counter, so the next loss waits `1s`
  again.
- A failed in-flight logical call is never automatically resent. A distinct
  new/queued call may dial a fresh connection after the reset backoff.
- Per instance the connector serializes demand with true concurrency `1`
  (FIFO queue); separate instances share no global mutex and stay independent.
- CI-compatible regression coverage (committed regression,
  `packages/connector-mcp/test/connection-lifecycle.test.ts`, 5 cases): the
  REAL `@modelcontextprotocol/sdk` `Client` + `McpServer` linked by
  `InMemoryTransport` under a deterministic fake clock
  (`setTimeout`/`clearTimeout`/`Date` only) — a framework-level contract test.
- Local non-CI proof additionally ran the same connector over a genuine SDK
  **stdio fixture** process (actual spawn / spawn-ENOENT, same-PID reuse,
  handler drop / FIFO gate). This is a fixture smoke only — it is **not**
  evidence of the upstream fork, OAuth, or live Google compatibility.
- Existing wire-gate / `serverId`-vs-`expectedServerName`+`version` semantics
  are unchanged. The formal status stays **HOLD**; the remaining unverified
  C09 gates and the C10/C11 gates stay open, and no Calendar-adoption decision
  is made here (C09-02/03 and C09-05/06 scope are separated below).
- Graph-budget CI coverage note (same PR run): the real-vault
  `packages/connector-markdown/test/graph_budget_integration.test.ts` (5 cases)
  previously reported a **Windows CI** timeout at **6099ms** on the
  ambiguous-link case, whose large same-basename fixture was the cost. It now
  drives the REAL connector over a bounded **16-directory / 18-real-`.md`-file**
  temp vault whose wide canonical candidate keys retain the 256KiB cap proof
  (160 repeats ≈317653 bytes reject `output_too_large`; a 2-link control
  ≈3969 bytes stays under cap) without the large filesystem setup. This is
  **local proof only** (target file 5/5, root `tsc`, scoped Biome clean); it
  does not raise the timeout, skip the case, or change the production budget.

### C09-05 / C09-06 transport bounds & shutdown status

- This subsection records **only** the local, owned-branch verification of
  C09-05 (stdio stderr-bounded termination) and C09-06 (bounded shutdown /
  kill timeout), plus the loopback-HTTP cleanup path.
- Real STDIO local non-test smoke (actual Node 24 + real SDK 1.30.0 real
  `StdioServerTransport` children): **8/8 green**. Latest archived real-stdio
  stdout: S7 stubborn shutdown **111.528ms** with a real `onclose`, owned PID
  gone, exactly one actual production SIGKILL; S8 cooperative **3.918ms** /
  no kill; actual `finalOwnedPidsAlive=[]`.
- Real loopback HTTP local non-test smoke (actual Node 24 + real SDK
  `McpServer` + `StreamableHTTPServerTransport`, historical PR16 API
  `new McpConnector(cfg)` default HTTP transport — NOT the current
  constructor and NOT a compatibility shim): **7/7 green** — positive
  `initialize`/`tools/list`/`tools/call`; pending-RPC shutdown with a
  preserved prior `onclose`; 3xx refusal for 301/302/303/307/308/304 with zero
  destination hits; post-connect `tools/call` 307 refusal with no resend;
  direct-fetch refusal for every input form; streaming-body cancel; and the
  schema-bypass no-network tripwire (actual fetch count `0`).
- Deterministic controlled-SDK unit coverage: **26 cases** (9
  transport-bounds / stderr-cap, 12 shutdown-race, 5 HTTP redirect-cleanup)
  inside the full **1123 tests / 92 files**; root + e2e typecheck clean;
  Biome 190 files with 0 warnings (one pre-existing recommended-rule info).
- Bounds: stdio stderr is COUNT-ONLY per connection, saturating at 64KiB;
  byte 65537 aborts open/call/idle into fixed `mcp_unavailable`, synchronous
  state clear, and bounded cleanup. `shutdownWaitMs` stays `100..10000`
  (default `3000`) as the GRACE window, plus a fixed additional **2000ms**
  force-close wait; the real owned positive public-SDK PID is captured before
  `close()` clears the getter, and the exit proof is an actual close event,
  not `close()` promise resolution. Generic/HTTP settle waits are HOST-bounded
  and do NOT prove external process death; a numeric PID public API cannot
  guarantee a durable OS identity or process tree.
- Fixture/local evidence only: NOT upstream-fork / OAuth / auth,
  ordinary-CLI, or live-Google proof. Commands and counts are typed observed
  values, not future CI or head-SHA claims. The formal status for the
  remaining C09/C10/C11 gates and Calendar adoption stays **HOLD**.
- Retained archives live OUT-OF-REPO under
  `/home/molmot/.local/share/opencode/tool-output/c09-transport-verify/`:
  `after-http/` (`harness.ts`, `tsconfig.json`, `stdout.json`, `result.json`,
  `records-result.json`, `commands.txt`, `fail-history.txt`) and the
  `after-stdio/` archive; the earlier `before/` archive is unchanged. The
  in-repo `.c09-proof/http-final` helper and its compiled output were
  TEMPORARY and deleted after publication, so it is NOT a retained archive.
  The prior root 54 env-load-failure full run (with the stale idle-trigger and
  SDK fixture-typing failures) is preserved under `final-checks/`; the final
  full pass, which followed the OWNED workspace-resolved dependency borrow,
  is under `final-checks-with-deps/`.

### C10 Calendar consumer normalization (implemented; adoption HOLD)

- This subsection records the CURRENT C10 scope only. It is NOT a live-Google,
  OAuth, fork-compatibility, profile-registration or adoption claim, and no
  package pin changed (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`). The
  only new dependency edge is the owned workspace
  `@companion/connector-mcp` (for the public `CallResult` / `McpErrorCode`
  types), added to `packages/connector-calendar` with the exact pnpm-lock
  importer entry (no external install/pin).
- Consumer decoder (package-owned, no new provider framework, no retries,
  logs, telemetry or dispatch): `normalizeSearchResult(result, options)` →
  `{ok:true,events,cursor?}` / `{ok:false,code}` and `normalizeGetResult(result,
  options)` → `{ok:true,event}` / `{ok:false,code}`, both over the merged
  `CallResult`. `normalizeEvent(raw, {connectorInstanceId})` remains the
  primitive and rejects with the fixed `Error("calendar_response_invalid")`
  (no cause/raw value/Zod issue). `structuredContent` is selected by
  OWN-PROPERTY presence; a present `null`/`undefined`/wrong-shaped value is the
  only source and is never rescued by `text`. Only an ABSENT
  `structuredContent` permits parsing the ENTIRE `text` as strict JSON (no
  fences, prose, prefix/suffix scanning, event synthesis or auto-pagination).
  An incoming fixed MCP failure code is preserved verbatim.
  Transport seam (documented, not an end-to-end claim): the merged MCP client
  omits `structuredContent` when its value is `undefined`, so a direct
  own-property `undefined` is rejected at the Calendar boundary but an
  upstream property-present `undefined` is indistinguishable from absence
  after transport (illegal JSON cannot carry it).
- Exact root envelopes: `list-events` and `search-events` pages
  (`{events,totalCount,nextPageToken?}` plus each operation's source-proven
  optional metadata) selected by an explicit `operation` option, and
  `get-event` `{event}`. `totalCount` must equal the PAGE `events.length`; a
  page with more than the requested `1..20` events is rejected (never sliced);
  unknown root fields, wrong-operation envelopes and cross-calendar raw ids are
  rejected; no id/calendarId is derived from the root.
- Event projection: the REAL nested `{dateTime?,date?,timeZone?}` endpoint union
  (exactly one of `date`/`dateTime`); all-day DATE values stay DATE strings with
  an exclusive end; explicit-offset timed instants are canonicalized to UTC.
  Required consumed fields (`id`, `calendarId`, `status`, `summary`, endpoints)
  are strict CONSUMER policy (the candidate producer marks `summary`/`status`
  optional) — no fabricated title/confirmed status. The seven privacy keys
  (`creator`/`attendees`/`organizer`/`conferenceData`/`hangoutLink`/`htmlLink`/
  `extendedProperties`) plus all unknown extras, `accountId`, page metadata and
  source identifiers are stripped and excluded from the snapshot and hash.
  Allowed `title`/`description`/`location` plaintext may itself contain
  emails/URLs; no general free-text redaction is claimed.
- Revision precedence unchanged: non-empty opaque `etag` (quotes preserved) >
  canonical `updated` > normalized-projection hash (computed after temporal
  canonicalization and truncation, excluding identity/revision/private fields).
  `canonicalKey` stays `SHA-256(JSON([connectorInstanceId, calendarId,
  eventId]))`. C11 deletion behavior is unchanged (untouched by C10).
- Candidate compatibility gap (explicit): the candidate source regex accepts
  only WHOLE-second `Z`/`±HH:MM` datetimes, while the agreed consumer input
  keeps fractional-second ISO precision (the exact 90d+1ms boundary depends on
  it). The mapper does not silently truncate/round/narrow, so this remains a
  documented gap and an additional adoption HOLD; no full-fork-compatibility
  claim is made.
- **C10-08 production mapping gate (UNRESOLVED):** no adopted
  `McpBindingDefinition`, pin, profile, OAuth flow or live-Google wiring
  exists. The candidate mapping is proven only against the retained
  synthetic-provider C08 archive (provider bodies are unadopted compatibility
  targets). Calendar consumer-readiness ≠ profile-connected/adopted, and the
  formal C08 adoption status stays **HOLD / NOT ADOPTED**. Test counts and
  command results observed for this patch are recorded by the parent's
  verification phase; no count is claimed here.
- **Final verification (observed; full patch, each check run once):** direct Node
  24.12 CLIs from the OWNED worktree node_modules (no pnpm exec/install/relink/
  dlx/npx, no test filter). FIRST attempt: `tsc --noEmit -p
  apps/server/tsconfig.e2e.json` PASS (exit 0); full `vitest run` PASS (exit 0,
  94 test files / 1164 tests, 0 failed/skipped); `tsc --noEmit -p tsconfig.json`
  FAIL (exit 2, 3× TS18048 `'zone' is possibly 'undefined'` at
  `packages/connector-calendar/src/time.ts` lines 96/97/98); `biome check .` FAIL
  (exit 1, 191 files, 1 error `assist/source/organizeImports` at
  `packages/connector-calendar/src/index.ts:1`, 1 warning
  `lint/suspicious/noPrototypeBuiltins` at
  `packages/connector-calendar/src/normalize.ts:344`, 2 infos
  `lint/complexity/noUselessUndefinedInitialization` at `normalize.ts:402` plus
  the pre-existing `biome.json` deprecated-`recommended` config note).
- **Bounded type/lint fix (CURRENT):** type-only mandatory-zone-capture assertion
  in `time.ts` (no runtime change; offsets/normal path byte-identical),
  `normalize.ts:344` own-property presence via `Object.hasOwn` (same semantics
  incl. present null/undefined and prototype-safety), removal of the useless
  `= undefined` initializer at `normalize.ts:402`, and an organizeImports reorder
  in `index.ts`. Re-running ONLY the two previously-failed checks once each:
  `tsc --noEmit -p tsconfig.json` PASS (exit 0, empty output); `biome check .`
  PASS (exit 0, 191 files, 0 errors / 0 warnings, 1 info = the pre-existing
  `biome.json` deprecated-`recommended` note). The changed presence branch was
  smoked against the retained C08 bodies over the ACTUAL public decoders
  (11/11 pass: own `structuredContent` priority, present null/undefined rejects,
  absent -> strict text, inherited/shadow `hasOwnProperty` irrelevant); the
  throwaway `.review-proof` was removed and archived at
  `c10-calendar-verify/failed-check-fix/`. The earlier e2e typecheck PASS (exit 0)
  and full 94 files / 1164 tests PASS are preserved and NOT rerun by this
  type/lint-only patch; no new full-test run is claimed. The touched-TS
  `biome format --write` run (7 files, 4 rewritten) was syntax-only and is not
  rerun.
- **time.ts native-review regression proof (archived out-of-repo):** the two
  fixes (year-0000 leap-day construction; 3-digit bounded fractional ms) are
  proven by actual Node 24.12.0 public/source-API probes at
  `c10-calendar-verify/time-review/` (14 files, byte-hash verified); the worktree
  `.review-proof` was removed after the copy. BEFORE the failure mode was split,
  not a blanket rejection: the timed year-0000 leap-day and `+01:00` offset
  normalizations returned `ok:true` with silently corrupted instants
  (`0000-02-29` shifted to `0000-03-01`, and the offset start off by one day,
  under the old `Date.UTC(0,…)` → 1900 non-leap rollover), and where a
  `.999999999999999999` fraction was accepted it advanced to `09:00:01.000Z`
  with a `sourceRevision` differing from `.999Z`; only the all-day year-0000
  leap-day range and the long-fraction interval failed closed with
  `calendar_response_invalid`. AFTER: `0000-02-29` parses as-is, `+01:00` offset
  → `0000-02-28T23:00:00.000Z`, long fraction → `09:00:00.999Z` (no next-second
  carry), and `.999Z` vs the long fraction give identical `sourceRevision`; the
  normal path is byte-identical. esbuild used was `0.25.12` (root pnpm store
  leaf; root also has `0.28.2`, which was NOT used).
- The incidental unit test that echoed an incoming fixed failure code verbatim
  (`preserves incoming fixed MCP failure codes without decoding`) was deleted; no
  mock-echo/forwarding replacement was added. MCP failure-code propagation is
  covered by the genuine SDK not-found runtime path, not by a unit echo. C11
  deletion behavior and the formal C08 HOLD / C10-08 production mapping gate are
  unchanged.

### C11 deletion-evidence boundary (consumer invariants; C11-01 BLOCKED)

- This subsection records the CURRENT C11 scope and supersedes the earlier
  design-time "deletion classifier" placeholder. It is NOT an adoption,
  live-Google, OAuth, pin or positive-tombstone claim. No package pin changed
  (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`); `packages/connector-calendar`
  adds the SDK ONLY as a test-only `devDependency` (the already-resolved
  `1.30.0(zod@4.5.4)`) with the exact lockfile importer entry, no production
  dependency, no provider adoption.
- Removed dead stub: `classifyDeletion` / `DeletionVerdict` and their
  `src/index.ts` exports were deleted. They switched only on the proposed
  `get-tombstone` / `list-showDeleted-tombstone` labels and were never called
  by any producer or runtime; no always-unknown / no-op / alias / deprecated
  replacement API was added. The normative `normalizedEventSchema` keeps the
  `deleted` status (§17.5); only the unverified classifier type was removed.
- Genuine-wire consumer regression:
  `packages/connector-calendar/test/deletion-boundary.test.ts` drives the real
  `McpConnector` over a genuine lower-level SDK `Server` +
  `InMemoryTransport` linked pair (dummy loopback config with an injected
  in-memory transport, so no HTTP/stdio/OAuth is dialled) and runs the returned
  `CallResult` through the real `normalizeGetResult` /
  `normalizeSearchResult`. Six negative invariants: (1) a valid `confirmed`
  then `cancelled` get for the SAME canonical key yields normalized
  `cancelled` with a new etag revision, never `deleted`; the prior snapshot is
  NOT asserted persisted (that is the unwired C12 pipeline). (2) an
  `isError:true` body with a private synthetic 404 marker AND a conflicting
  `structuredContent.event.status:"deleted"` yields the fixed
  `calendar_upstream_error` with the marker absent and no Text rescue. (3) a
  thrown SDK `McpError` (`ErrorCode.InternalError`) carrying a private
  synthetic 410 marker is rejected by the genuine SDK to the fixed
  `mcp_unavailable`, with exactly one dispatch (no logical auto-resend). (4)
  a prior valid get followed by ONE empty search page with an opaque
  non-empty continuation token yields `events:[]` plus the cursor verbatim,
  with search-call count 1 (not an all-page omission proof, not a delete).
  (5) a get SUCCESS whose raw consumed `status` is `deleted` is rejected as
  `calendar_response_invalid` (the consumed enum cannot accept the future
  normalized value). (6) a get `confirmed` body with unknown raw
  `deleted:true` / `tombstone:true` / `get-tombstone` provenance text strips
  the flags and keeps a valid `confirmed` event, trusting no extra heuristics.
- C11 gate table (source-backed; the consumer regressions below were
  subsequently exercised by a real-SDK wire smoke and the new vitest file, but
  no formal gate PASS/adoption is claimed):

  | item | status | boundary / evidence |
  | --- | --- | --- |
  | C11-01 | **BLOCKED** | No adopted operation-specific POSITIVE tombstone evidence exists. Candidate `get-event` has no `showDeleted` and no deleted-semantics contract; candidate `97a3dc3` source is read-only reviewed. Positive gate not met → no `deleted` mapping. |
  | C11-02 | IMPLEMENTED (consumer) | `cancelled` decodes to normalized `cancelled` (same canonical key, new etag revision); never `deleted`. Regression (1). Existing-snapshot retention is C12 (unwired). |
  | C11-03 | IMPLEMENTED (consumer) | Bare 404 (`isError:true`) → `calendar_upstream_error`; a THROWN RPC error → distinct `mcp_unavailable`; no tombstone. The retained C08 get-miss is an inert-provider `-32603` `isError`, NOT an actual Google HTTP 404/410. Regressions (2)(3). |
  | C11-04 | IMPLEMENTED (consumer) | A single empty search page returns `events:[]` + opaque cursor verbatim; one search call; omission is never deletion. Regression (4). |
  | C11-05 | PARTIAL | Uncertain results map to the fixed `calendar_upstream_error` / `mcp_unavailable` / `calendar_response_invalid`. "Never erase an existing snapshot" requires the C12 pipeline, which is unwired. |
  | C11-06 | DOCUMENTED (no new policy) | Existing demand-driven backoff `1/2/5/10/max30` applies to the next logical call; NO automatic logical resend (C09). Explicit retry is a NEW Run on the SAME frozen Turn context. Stored-only open vs explicit refresh (success → newSnapshot/rN) is existing architecture NOT wired to Calendar. C13 owns retry budgets/UI. Failures are not observations/tombstones; a future C12 adapter must retain prior refs/storage, never map an accidental missing to `deleted`. |
  | C11-07 | DOCUMENTED (METADATA ONLY; HTTP status UNKNOWN) | Record format: source kind (static candidate / retained inert provider / new synthetic SDK wire), immutable archive/candidate refs, operation, request field NAMES (not raw IDs/cursors/query/emails/error body), observed MCP envelope and the fixed consumer error. No runtime logger/telemetry/status-diagnostic channel was added and error privacy was not weakened. Actual HTTP status is NOT captured; synthetic 404/410 markers are NOT provider HTTP evidence. |
  | C11-08 | RESOLVED (documentation) | The spike's cancelled/404 limitations are NOT formal implementation evidence: formal C08 stays **HOLD**, C10-08 production mapping stays **UNRESOLVED**, the candidate whole-second regex fraction gap persists, and no OAuth/live/fork/pin/profile exists. |
- Positive-proof prerequisites (source-reviewed; NONE exists for candidate
  `97a3dc3`, so C11-01 stays BLOCKED and is NOT sufficient as a Google
  contract): an ADOPTED operation-specific positive-evidence schema with
  verified official semantics; a prior KNOWN target (exact connector /
  calendar / event), not a caller-supplied `priorKnown` boolean; an accessible
  calendar/read-permission context; and an actual positive observation matching
  the operation + exact target + recurrence distinctions. Search omission, list
  `showDeleted`, `cancelled`, bare 404/410 are NEVER positive evidence; `get`
  `showDeleted` does not exist (do not invent it). A positive / real HTTP status
  for C11-07 remains BLOCKED and actual upstream HTTP status stays UNKNOWN.
- Observed verification (this C11 verification run; evidence archived out of
  repo, source unchanged): a disposable real-SDK runtime smoke
  (`.review-proof/c11-runtime.ts`, deleted after archive) drove `McpConnector`
  over a genuine low-level SDK `Server` + `InMemoryTransport` and exercised all
  SIX negative invariants through the real public API with NO HTTP/stdio/OAuth:
  6 distinct cases / 27 checks, all pass (Node 24.12.0, SDK 1.30.0, esbuild
  0.25.12). No case produced a tombstone; the private 404/410 sentinels never
  appeared; request counts were get=2 (case 1), get=1 (cases 2/3/5/6) and
  get=1+search=1 (case 4, no implicit next page). The new
  `packages/connector-calendar/test/deletion-boundary.test.ts` ran 6/6 in the
  full suite (95 files / 1168 tests, 0 failed / 0 skipped); root typecheck exit 0
  and e2e typecheck exit 0. The first `biome check .` exited 1 with ONE error
  (`assist/source/organizeImports`, import-name order, in
  deletion-boundary.test.ts) plus the pre-existing `biome.json` `recommended`
  info. That FIXABLE ordering was then applied manually exactly as the reported
  safe fix and the root `node node_modules/@biomejs/biome/bin/biome check .` was
  re-run ONCE: **exit 0, 192 files checked, 0 errors / 0 warnings**, only the
  pre-existing `recommended` info remains. No new error/warning is outstanding;
  the reorder is behaviour-neutral and changes no runtime semantics. These are
  consumer boundary verifications only: C11-01 remains **BLOCKED**, C11-05 retention
  stays C12/unwired, C11-07 actual HTTP status stays UNKNOWN, and the formal C08
  HOLD / C10-08 production-mapping gate is unchanged — no live-Google, OAuth,
  pin, profile or adoption claim. The test-only
  `packages/connector-calendar/node_modules/@modelcontextprotocol/sdk` symlink
  (raw target
  `../../../../node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.5.4/node_modules/@modelcontextprotocol/sdk`,
  same form as the connector-mcp link, read-only borrow) was added so the SDK
  resolves from the Calendar test source directory; no install/relink ran.

### C12 internal Calendar pipeline (implemented end-to-end consumer; adoption HOLD)

- This subsection records the CURRENT C12 scope: the internal pipeline that
  wires the C10 normalized connector into the kernel's ReferenceManager
  through a dependency-inverted port. It is a REAL-SDK, credential-free,
  in-memory-transport consumer verification only — it is NOT an adoption,
  live-Google, OAuth, pin (formal C08 stays **HOLD**) or provider claim. The
  actual upstream HTTP transport and error statuses stay UNKNOWN.
- Architecture (as implemented, `packages/kernel/src/calendar_tools.ts`):
  `calendar.search` is a ToolBroker registration built over a
  `CalendarConnectorBinding` (stored `connector_instances` row of kind
  `calendar` + an already policy-validated `McpConnector` adapter). The kernel
  owns the port shape and never imports the connector package. The frozen
  IANA zone is resolved PER CALL from the Run's immutable Turn frozen context
  (`turn.frozenContext.temporal.timeZone`), never from a construction state,
  clock or env read; `get` needs no zone. Host-private upstream `get-event`
  targets (calendarId/eventId/account) are returned by the adapter alongside
  the decoded page and persisted by the kernel inside the SINGLE
  `ReferenceManager.presentObservations` `BEGIN IMMEDIATE` transaction
  (through the `onApplied` hook), AFTER the running-status/CAS recheck:
  a cancelled/terminal/late observation writes no target and a committed
  Snapshot/rN cannot exist without its target (`C12-07`).
- Private storage: committed migration `0006_m4_calendar_targets.sql` adds the
  STRICT, non-joined `calendar_get_targets` table (canonical_key PK, valid
  JSON target, no secret/credential). The production server injects
  `createDurableCalendarTargetStore(db)` (survives restart); the in-memory
  store is a test-only default. Provider ids live ONLY in this private table —
  never in the Snapshot body, model-facing output, public DTO, or a fixed
  error (`C12-07`/provenance). The bodies carry an opaque
  `calendar:<sha256>` canonicalKey; `calendar.search` output hits carry
  structural ids + title + status + snippet only.
- Reuse semantics (delegated entirely to the existing M1 ReferenceManager,
  `C12-08`): normal presentation reuses the session's latest matching
  Snapshot (revision NULL-safe exact + content hash) with the same rN; a
  changed upstream revision (etag) with identical content materializes a NEW
  Snapshot + new rN; a content change with the same revision also materializes
  a new Snapshot; an explicit refresh always creates a new Snapshot + new rN.
  `reference.open` is stored-only (no external request). A failed
  (`calendar_upstream_error` / `mcp_unavailable` / `mcp_schema_mismatch` /
  `calendar_response_invalid` / `calendar_range_invalid`, closed map) or an
  empty page never erases or mutates an existing Snapshot: history retains
  (`C12-06`). Missing private target on a calendar refresh yields the closed
  `reference_not_found` — the kernel NEVER guesses provider ids.
- Server composition: `apps/server/src/bootstrap.ts` exposes an injectable
  `calendarBinding` seam. Injection is fail-closed: the stored row must exist,
  be kind `calendar`, and its metadata-only `{version,calendarId,account?}`
  selection must match the injected selection exactly
  (`verifyCalendarBinding`); absent injection keeps the registry
  network-disabled (Markdown-only). Per-call frozen-zone resolution and the
  registration-validated bindings are exercised by the kernel regressions
  (C12-08 binding-kind / missing-target / rollback cases).
- Observed regressions (Vitest, this worktree, local runs): genuine-SDK
  `packages/connector-calendar/test/c12-smoke.test.ts` (low-level SDK `Server`
  + `InMemoryTransport` linked pair; inert synthetic provider; no HTTP/stdio/
  OAuth/network) drives the real `McpConnector`, real adapter, real kernel
  broker + ReferenceManager + SQLite: 9 passing cases (8 pipeline + 1
  adapter-level) covering one-page
  frozen-zone materialization with verbatim cursor + durable private target,
  same-revision reuse vs revision-change / content-change new Snapshot+rN,
  stored-only `reference.open` (zero external calls), explicit refresh with
  identical contents (new Snapshot + new rN, one `get-event`, zero
  `search-events`), failed/empty follow-ups retaining old snapshots, a genuine
  late-cancelled result writing no snapshot/rN/set/ref/event/target, opaque
  provenance with provider ids excluded from `modelFacing` but present in the
  private table, and a restart-durable refresh target (new process reuses
  stored target, `get-event` only). Adapter-level cross-calendar get refusal
  (`calendar_range_invalid`, zero upstream calls) is covered. The kernel
  `packages/kernel/test/calendar_tools.test.ts` adds 11 C12-01..08 cases
  including the throwing-target-write full rollback and binding validation.
  Full observed suite/typecheck/lint results are recorded below in "C12 final
  checks". C12-05 (durable private storage) is verified by the restart case
  against real SQLite (migration 0006); formal gates stay separate: C08
  **HOLD**, C10-08 **UNRESOLVED** (production mapping), C11-01 **BLOCKED**,
  actual upstream HTTP status **UNKNOWN**.

#### C12-01..08 gate table (implemented; no adoption claim)

  | item | status | boundary / evidence |
  | --- | --- | --- |
  | C12-01 | IMPLEMENTED | One-page `calendar.search` with the per-Turn frozen zone, ONE upstream call, verbatim cursor; real adapter → real broker → SQLite resource/snapshot/rN/set/events; private target persisted in the SAME observation transaction. Kernel C12-01 + smoke case 1. |
  | C12-02 | IMPLEMENTED | Same revision+content reuses session-latest Snapshot/rN; changed revision (etag) with identical content, or changed content with same revision, materializes new Snapshot+rN. Kernel C12-02 + smoke case 2 (etag + rename). |
  | C12-03 | IMPLEMENTED | Explicit `reference.refresh` with identical contents always creates a new Snapshot+rN and rereads upstream via the private target (one `get-event`, no re-search). Kernel C12-03 + smoke case 4. |
  | C12-04 | IMPLEMENTED | `reference.open` is stored-only: full body from SQLite, zero external requests. Kernel C12-04 + smoke case 4 open phase. |
  | C12-05 | IMPLEMENTED (consumer) | Durable private `calendar_get_targets` (migration 0006) survives a real process restart; refresh reuses the stored target without any search. Smoke cases 5/8 against real SQLite. |
  | C12-06 | IMPLEMENTED (consumer) | Failed (`calendar_upstream_error`) and empty-page observations retain prior Snapshots/history; no deletion is ever inferred; stored open still serves the retained body. Kernel C12-06 + smoke case 5. |
  | C12-07 | IMPLEMENTED | A genuinely late-cancelled observation writes NO snapshot/rN/set/reference/target; a throwing target write rolls back the whole observation transaction; provenance stays opaque (rN + opaque key + structural ids) and provider ids are excluded from model-facing output while surviving only in the private table. Kernel C12-07 (x2) + smoke cases 7/9. |
  | C12-08 | IMPLEMENTED | The pipeline allocates through the single existing ReferenceManager path only; `calendar.search` registers exclusively over a validated kind-`calendar` binding; per-call frozen zone; missing private target never guesses (`reference_not_found`); bootstrap seam validates injected bindings fail-closed. Kernel C12-08 (x2) + registration validation. |

- C12 final checks (observed local run on this worktree, Node 24.12.0):
  targeted Vitest runs show 9 genuine-SDK smoke cases, 11 kernel C12 cases,
  21 migration cases, and 39 contracts cases green, and root
  `tsc --noEmit` exits 0. Earlier claims of a full-suite and lint run in this
  window were not re-observed for these final corrections and are explicitly
  NOT claimed here; the formal C08 / C10 / C11 gates above are unchanged.
  Additionally, an INDEPENDENT runtime smoke (not vitest: plain node script
  via the repo's vite-node with `node:assert`, reusing the c12-smoke fixture
  shape minus describe/it, inert synthetic provider, real SDK `Server` +
  `McpConnector` + adapter + kernel broker + `ReferenceManager` + durable
  SQLite, deleted after the run) observed end-to-end, in one sequence:
  `calendar.search` succeeded with EXACTLY ONE upstream `search-events` call
  and 1 hit; the private `calendar_get_targets` row carried the exact
  host-side target (`calendarId`/`eventId`/`account`); `reference.open`
  served the stored body with ZERO added upstream calls; an explicit
  `reference.refresh` reread via exactly one `get-event` (no re-search),
  materialized a NEW Snapshot + NEW reference id; and an upstream-failed
  refresh observed `calendar_upstream_error` while the prior snapshot count
  and stored body (retained via `reference.open`) stayed unchanged. Exact
  observed ids (synthetic run): search slice reference
  `9c537b00-eb03-41fc-90e2-ddb289ec89da` / snapshot
  `93394e50-f075-4d4a-82a2-8c5e17ec4521` / canonicalKey
  `calendar:9896429c…f6f8`; refresh snapshot
  `a4e74081-2dd4-45b4-8eb6-b514f5e26cfc` / new reference
  `d29a8066-f39d-4428-af0a-b07364d38e10`; all success booleans true except
  the deliberately failed refresh (`calendar_upstream_error`). This
  synthetic-only run makes NO live-Google/OAuth claim.

### C13 calendar.search Broker exposure / frozen temporal context / cross-source

- This subsection records the CURRENT C13 scope on top of the C12 pipeline
  above. It does NOT change the C12/C08/C10/C11 boundaries (adoption stays
  HOLD, tombstone rules unchanged) and adds NO contracts/schema/migration/
  server changes. Because the whole C13–C15 verification pass is deliberately
  deferred (single final suite after C13–C15), the C13 test additions below
  are recorded as **ADDED, NOT YET RUN** — no executed-verification claim is
  made here.
- `packages/kernel/src/calendar_tools.ts`: the search registration now reads
  the COMPLETE frozen temporal context (not only the zone):
  `turn.frozenContext.temporal` is passed per call to the connector port as
  both `timeZone` and `now` (`CalendarSearchCallOptions` gains the required
  frozen `now`). Frozen values come ONLY from the immutable `turns`
  `frozen_context` row (validated by the existing `FrozenContextSchema`);
  nothing is recomputed, defaulted, clock-derived or rewritten per Run, so a
  Retry (a NEW Run on the SAME Turn via the existing `postRetry`
  next_run_attempt allocator) consumes the identical frozen now/zone.
- `packages/kernel/src/agent.ts` (C13-01/C13-08): `calendar.search` is now a
  model-visible tool. `AGENT_CALENDAR_SEARCH_PARAMETERS` (exported; closed
  literal `additionalProperties:false` schema mirroring
  `CalendarSearchToolInputSchema`: optional `query`, required `start`/`end`,
  `limit` 1-20 default 10, optional opaque `cursor`; NO `freshness` field —
  the Calendar contract has none) is advertised through
  `AGENT_BROKER_TOOL_PARAMETERS`, so `buildAgentToolDefinitions` exposes the
  ONE `calendar.search` descriptor (real `ToolDescriptor` description,
  category `read`) and never the connector-internal
  `list-events`/`search-events`/`get-event` tools. Grants/ordinals/mixed
  references need no new paths: calendar hits flow through the same M1
  delivered-output/grant extraction (`extractGrantCandidates`,
  structural-UUID/rN translation) as Markdown hits.
- C13-02/C13-03 (budget/dedup/timeout/audit): the registration already rides
  the existing ToolBroker pipeline; this slice keeps `dedupMode: "normal"`
  (same-Run same-fingerprint reuse consumes cumulative budgets; failed calls
  clear their cache entry) and maps upstream failures through the closed
  `mapCalendarCode` set. Audit stays metadata-only (fixed codes + digests,
  ordered `budget_reserve -> classify -> validate -> dedup -> execute ->
  normalize -> audit`). No budget/dedup code changed.
- C13-06/C13-07 (cross-source): the shared `ReferenceManager` path is
  UNCHANGED and source-agnostic — one session reference sequence covers
  Markdown and Calendar resources; `reference.open` / `reference.related`
  stay stored-only (Calendar-origin `reference.related` resolves the stored
  link graph deterministically and invents no Markdown rNs, and upstream
  Tombstone/deletion rules are untouched). A failed calendar call audits only
  the fixed code and never adds stale/uncited references or mutates prior
  evidence.
- API surface changed (all add-only, no contracts/migration touched):
  `CalendarSearchCallOptions.now` (required, frozen Turn instant), frozen
  `AGENT_CALENDAR_SEARCH_PARAMETERS` export, one new
  `AGENT_BROKER_TOOL_PARAMETERS` entry (`calendar.search`).
- Focused consumer-visible tests ADDED (packages/kernel/test/
  calendar_tools.test.ts, NOT YET RUN — verification deferred to the single
  final C13-C15 pass): C13-01 exposure (one descriptor, closed parameters,
  upstream tools never exposed, category `read`), C13-02 budget (reserve
  before dedup/execute; dedup reuse still reserves; third call over budget
  blocked with `budget_exceeded` and zero upstream calls), C13-03 dedup
  reuse + stalled-call timeout (`execution_timeout`, nothing materialized),
  C13-04/05 Retry (attempt 2 via `postRetry` reuses the identical frozen
  zone+instant; immutable Turn row unchanged; exactly one upstream call per
  Run, no auto resend), and C13-06/07 mixed-source session (Markdown+
  Calendar one ordinal sequence; store-only `reference.open`/`related` on
  the Calendar-origin reference with zero upstream reads; failed call keeps
  prior references and adds none).
- Remaining integration needs (NOT part of C13): C14 wires the frozen
  instance config/opt-in bootstrap + lazy connection lifecycle (bootstrap.ts
  already owns the validated `calendarBinding` injection seam), and C15 adds
  the fake MCP + fake model + real UI conversation→search→rN→refresh /
  tombstone E2E and CI; the C13 tests above feed the deferred final suite.

### C14 startup composition / strict opt-in Calendar-MCP config

- This subsection records the CURRENT C14 scope on top of C12/C13. It does
  NOT change the C12/C08/C10/C11 boundaries (adoption stays **HOLD / NOT
  ADOPTED**: this build ships NO provider profile, NO adopted binding
  definition and NO category data of its own) and adds NO kernel
  schema/migration/contracts changes. Like C13, the C14 test additions below
  are recorded as **ADDED, NOT YET RUN** — the C13–C15 verification pass is
  deliberately deferred (single final suite after C15); no
  executed-verification claim is made here.
- `apps/server/src/config.ts` (strict opt-in, DEFAULT DISABLED): new frozen
  `COMPANION_CALENDAR_JSON` config (`parseCalendarConfig`), unset ⇒
  `calendar: null`. It must be an exact `{ selection, connector }` object.
  `selection` is a metadata-only host choice (`calendarId` required 1..512,
  optional `account`, no NUL bytes) persisted later ONLY as
  `connector_instances` metadata — never a provider credential. `connector`
  is validated against the shared connector-mcp schema WITHOUT its
  `connectorInstanceId` field (the server itself must fill the exact id it
  registers; an env hint can never claim a stored instance id it does not
  own). Unknown keys, arrays and schema violations fail closed with fixed
  path-free messages. Everything in this file is a CONFIG HINT bound to
  exact identity/transport/binding-hash values.
- Separation of trust (load-bearing invariant): the trusted read-only
  binding definitions (`McpBindingDefinition[]` with their `category`
  vocabulary) are NOT part of this config and CANNOT be expressed through
  env. No env/config path can ever enable a call: the connector hint carries
  no category field, and the parser rejects one if present. Definitions must
  be injected separately by trusted host code; default deny and the exact
  identity/schema-hash lattice (config hint hash ⇒ host definition hash ⇒
  live tools/list hash) remain owned by the connector.
- `apps/server/src/bootstrap.ts` (owned composition + lifecycle): when
  `config.calendar` is set, the composition REQUIRES the separate host
  trusted `mcpDefinitions` option (an opt-in without them is INCOMPLETE and
  fails closed with a fixed `server_config_invalid` before listen — never a
  silent disable and never a discovered/model-defined registration). The
  C12 injected-adapter seam (`calendarBinding`) and the owned C14
  composition are mutually exclusive (fail closed on the conflict). Before
  any side effect, a fail-closed preflight requires every exact adapter
  tool (`list-events`/`search-events`/`get-event` defaults) to be a
  configured hint binding linked to exactly one non-ambiguous host
  definition of category `read` with an EQUAL hash; an incompatible
  configuration therefore never registers an instance, never attempts any
  connection and never starts the listener. The preflight only responds to
  already-injected host definitions; final enforcement stays inside the
  connector (config/definition/live-hash gate + default deny).
- Registered lifecycle (server-OWNED): after the preflight, ONE metadata
  `calendar` connector instance is registered via the existing kernel
  `ensureCalendarConnectorInstance` (display name
  `CALENDAR_CONNECTOR_DISPLAY_NAME = "calendar-mcp"` for the unprofiled
  composition, `GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME =
  "calendar-mcp-google-readonly"` for the pinned profile — never shared, so
  the two compositions cannot reuse each other's rows, `version:1`, exact
  selection reconciliation — a changed selection fails closed), the hint's
  connector config is merged with the just-registered exact
  `connectorInstanceId`, one `McpConnector` is constructed (NO I/O at
  construction), the persisted row is re-verified (defense-in-depth exact
  identity), and the already-validated `createCalendarConnector` adapter is
  bound to that instance over the durable private target store. The
  C13 seam (`calendarBinding`) stays available for out-of-server callers.
- Non-blocking semantics: a DISABLED calendar (no env) never registers
  anything, and an UNAVAILABLE upstream (dead MCP endpoint/child) can never
  block server start — connection is lazy (first allowed call), failures
  surface per-call as the fixed `mcp_unavailable`. Calendar is fully usable
  WITHOUT any Markdown root: with no roots and an owned calendar, the
  single ToolBroker carries exactly `calendar.search`,
  `reference.open`, `reference.refresh`, `reference.related` (no
  `markdown.search`); counts are logged via a fixed `server.calendar_ready`
  event (never URLs/ids). The existing Markdown bound-roots guard is
  unchanged.
- Bounded shutdown (C14): on graceful drain, after the engine drain and
  BEFORE the DB close, the ONE owned connector is shut down under an outer
  backstop budget (`MCP_SHUTDOWN_BOUND_MS = 10_000`, exported
  `boundedMcpShutdown`; `options.mcpShutdownMs` is a test override capped at
  60 s). A budget loss only logs a fixed `server.calendar_mcp_shutdown_timeout`
  warn and lets the shutdown continue — the connector keeps its own internal
  stdio bounds (config `shutdownWaitMs` + fixed force-kill window). The
  listener-failure and generic startup-failure paths stop the owned
  connector best-effort as well (engine ⇒ connector ⇒ DB close order).
  With conversation memory configured, BOTH failure paths additionally
  stop the memory service FIRST (CLI children reaped and tick awaited
  before the engine drain and DB close); a rejected startup never leaves
  its crash-recovery CLI/timer alive. Verified 2026-10-16: full suite
  112 files / 1362 tests green including the deterministic occupied-port
  memory-cleanup regression (see "Conversation memory").
- Fake E2E seam inventory (exact API used by C15): `startServer({
  env: { ..., COMPANION_CALENDAR_JSON }, mcpDefinitions: readonly
  McpBindingDefinition[], mcpTransportFactory?: TransportFactory,
  mcpShutdownMs?: number, calendarBinding?: CalendarServerBinding | null,
  modelGateway?: ModelGateway | null, modelFetch?: FetchImpl,
  drainMs?: number, logger?, now?, stat?, platform?, chmod? })` — the fake
  MCP path uses the config opt-in + host definitions + an injected
  `mcpTransportFactory` (real SDK `Transport`, e.g. an in-memory pair) and
  goes through the real owned registration/adapter/connector pipeline; the
  deeper `calendarBinding` adapter seam stays for tests that build the
  port themselves. No production path passes these test-only options.
- Tests ADDED, NOT YET RUN: `apps/server/test/config.test.ts` (calendar
  opt-in defaults/parsing/deep-freeze, unknown-key and category-in-hint
  rejection, shared-schema violations, fixed-message boundaries) and
  `apps/server/test/bootstrap.test.ts` (incomplete opt-in fail closed;
  incompatible-definition fail closed with zero registration and zero
  factory invocations; mutual-exclusion fail closed; exact single calendar
  instance + four-tool broker with NO Markdown roots and a zero-dial lazy
  factory; outer shutdown bound cap). Apps/server now also declares
  workspace dependencies on `@companion/connector-mcp` and
  `@companion/connector-calendar`.

### C14 pinned google-readonly profile (CURRENT: adopted as host composition)

- HISTORICAL (above in this section): no provider profile adopted. CURRENT:
  the host-owned pinned profile `google-readonly`
  (`apps/server/src/calendarReadonlyProfile.ts`, strict opt-in
  `COMPANION_CALENDAR_PROFILE=google-readonly`) ADOPTS the reviewed
  candidate as the normal-startup composition. It is NOT a rewrite of the
  pipeline: the JSON hint, the owned registration, the lazy connector, the
  adapter and the fail-closed gates are unchanged; the profile only supplies
  the exact trusted definitions from host code and pins the hint to the
  candidate. Profile-adopted is live-accepted for authenticated reads:
  user OAuth is COMPLETED and authenticated live reads are OBSERVED
  (see "Live readonly acceptance ledger"); only fresh consent-screen
  scope display remains unobserved (never a missing-consent claim, never
  force reconsent). Still open: live production/C11 positive (BLOCKED)
  and manual Win11 smoke.
- Adoption pin (exact form, verified against a real fork checkout):
  `suiso11/google-calendar-mcp`
  commit `cefb63c24f062ef6a49889d7b635330dee884f63`
  (reviewed fork PR4 head: persisted-grant runtime + bounded pageSize +
  single-account string; base `6939311` in ancestry;
  tree `624968c65f499f5d30141f4d936aca66d016b531`,
  package `@cocal/google-calendar-mcp@3.0.0-readonly.2`, lock SHA-256
  `63261d25…bd533`), wire identity `{name:"google-calendar",
  version:"3.0.0-readonly.2"}`, exactly
  `list-events`/`search-events`/`get-event` with the live-wire hashes
  (`01c3d647…`, `d94166b7…`, `8c6736e2…` — SDK wire bytes, NOT the
  registry-direct `a065/012e/913…` diagnostic bytes). The list/search
  rotation vs the superseded 6939311 hashes (`81222b89…`, `d48ba36e…`)
  is the reviewed single optional `account` string (arrays refused) plus
  `pageSize` 1..20 honored with `maxResults` default 20; `get-event` is
  byte-identical. Scope stays
  `calendar.events.readonly` only; no `CalendarList` metadata lookup on the
  MCP path; no writes; `list-calendars` absent (denied, never registered).
- Selection rules (all fail closed with fixed messages, before listen):
  unset profile keeps the previous behavior; an unknown profile name is
  rejected; a set profile without `COMPANION_CALENDAR_JSON` is an incomplete
  opt-in; profile + explicit `mcpDefinitions` injection conflict; the hint
  must carry the exact pinned identity, stdio transport, and exactly the 3
  pinned bindings (a substituted version/name, an HTTP transport, an added
  `list-calendars`/write binding, a dropped binding, or a rehashed binding
  all fail; an arbitrary user binding/hash can never grant read or write).
  The optional `selection.account`, when present, must match the pinned fork
  grammar `^[a-z0-9_-]{1,64}$` (lowercase ASCII; email/uppercase/overlength/
  other characters fail as `calendar profile account mismatch`); omitted
  stays valid. The generic non-profile account contract (1..512, no NUL) is
  unchanged. All of the above — frozen selector, completeness, injected
  conflicts, exact profile compatibility — resolve synchronously BEFORE
  `ensureDbDir`/open/migrations, so a failing profile creates neither the DB
  file nor its parent dir and leaves an existing older DB byte-identical.
  The profile registers under its own boring persisted display name
  `calendar-mcp-google-readonly` (never the generic `calendar-mcp`), so a
  previously injected generic row with the same selection is never reused;
  canonical keys (over the instance id) separate, and an old generic target
  cannot refresh through the new provider (`reference_not_found`, no `get`
  call). Legacy/mismatched display-name rows fail closed on re-verify.
- Explicit preparation / auth / run (all USER-OPERATED, outside the repo;
  this worker never launches a browser, OAuth consent, or a real Calendar
  RPC; no secret is read or pasted anywhere below):
  1. Google Cloud prerequisites (user's own project, outside the repo):
     create a project and enable the Google Calendar API (official guide
     `https://developers.google.com/workspace/guides/create-project`);
     configure the OAuth consent screen as user type External with publishing
     status Testing and add your Google account as a test user (official
     guide `https://developers.google.com/workspace/guides/configure-oauth-consent`;
     Testing-mode grants expire and need re-consent — expected, unrelated to
     the readonly scope); then create an OAuth client ID of application type
     "Desktop app" and download its JSON (official guide
     `https://developers.google.com/workspace/guides/create-credentials#oauth-client-id`).
     The download carries a top-level "installed" object. A "Web application"
     download (top-level "web") is UNSUPPORTED: the pinned fork's
     `loadCredentialsFromFile` (`src/auth/client.ts` at the commit below)
     accepts ONLY the "installed" shape (or direct `client_id`/`client_secret`
     fields) and rejects anything else with `Invalid credentials file format`.
  2. Fork checkout, verification, then build (exact pin form; verification
     runs BEFORE any install/build):
     repo `https://github.com/suiso11/google-calendar-mcp`, commit
     `cefb63c24f062ef6a49889d7b635330dee884f63`, tree
     `624968c65f499f5d30141f4d936aca66d016b531`, package
     `@cocal/google-calendar-mcp@3.0.0-readonly.2`, `package-lock.json`
     SHA-256
     `63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533`.
     Run from the Companion checkout root (the directory containing
     `pnpm-workspace.yaml`); record its absolute path FIRST so step 5 can
     return to it. Requires the already-available exact engine `node
     v24.12.0` (see Source run above; no installer is fetched here). The
     whole clone/checkout/pin/install/build sequence runs in its OWN
     subshell with `set -eu`, so a pasted `test` failure aborts BEFORE
     `npm ci` / `npm run build` even in an interactive paste, without
     leaking `set -e` into the user's interactive shell options, and the
     outer Companion cwd is preserved (there is deliberately no bare
     `cd "$FORK_DIR"` outside the subshell):
     ```bash
     COMPANION_DIR="$PWD"  # absolute Companion checkout root (contains pnpm-workspace.yaml); keep for step 5
     FORK_DIR="$HOME/gcal-readonly"
     PIN_COMMIT="cefb63c24f062ef6a49889d7b635330dee884f63"
     PIN_TREE="624968c65f499f5d30141f4d936aca66d016b531"
     PIN_PKG="@cocal/google-calendar-mcp@3.0.0-readonly.2"
     PIN_LOCK="63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533"
     test "$(node -p "process.version")" = "v24.12.0"
     (
       set -eu
       git clone https://github.com/suiso11/google-calendar-mcp.git "$FORK_DIR"
       cd "$FORK_DIR"
       git fetch origin "$PIN_COMMIT"
       git checkout "$PIN_COMMIT"
       test "$(git rev-parse HEAD)" = "$PIN_COMMIT"
       test "$(git rev-parse 'HEAD^{tree}')" = "$PIN_TREE"
       test "$(node -p "require('./package.json').name + '@' + require('./package.json').version")" = "$PIN_PKG"
       test "$(node -e "const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'))")" = "$PIN_LOCK"
       npm ci --ignore-scripts
       npm run build
       node build/index.js version
     )
     ```
     The lock digest above uses the required Node `crypto` (portable
     Linux/macOS; no `sha256sum`/`Get-FileHash` needed). The last line
     prints `Google Calendar MCP Server v3.0.0-readonly.2`
     (wire identity `{name:"google-calendar", version:"3.0.0-readonly.2"}`:
     the name is hardcoded in fork `src/server.ts`, the version is read from
     `package.json` at runtime at the pinned commit).
  3. Secrets (user-private dir, OUTSIDE the repo, never committed):
     ```bash
     PRIV="$HOME/.config/companion-private"
     mkdir -p "$PRIV"
     chmod 700 "$PRIV"
     cp /path/to/downloaded-desktop-client.json "$PRIV/gcp-oauth.keys.json"
     chmod 600 "$PRIV/gcp-oauth.keys.json"
     export GOOGLE_OAUTH_CREDENTIALS="$PRIV/gcp-oauth.keys.json"
     export GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH="$HOME/.config/google-calendar-mcp-readonly/tokens.json"
     ```
     Token-file resolution at the pin (`src/auth/paths.js`): the
     `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH` env path first, else
     `XDG_CONFIG_HOME`, else `~/.config/google-calendar-mcp-readonly/tokens.json`
     (mode `0600`, written by the fork on consent). The broad-scope
     `GOOGLE_CALENDAR_MCP_TOKEN_PATH` is intentionally IGNORED there, a legacy
     single-account token file is REJECTED, and a stored grant whose scope is
     not exactly `https://www.googleapis.com/auth/calendar.events.readonly`
     is rejected (`src/auth/scopes.ts` `READONLY_CALENDAR_SCOPES`,
     `src/auth/tokenManager.ts`): an old broader token can never be reused —
     fresh readonly consent is required.
  4. Consent (USER-INTERACTIVE on the user's machine; NEVER run by a worker):
     ```bash
     node "$FORK_DIR/build/index.js" auth
     ```
     consent for the default local account (mode `normal`), or
     `node "$FORK_DIR/build/index.js" auth work` for a named LOCAL account id
     (lowercase 1-64 `[a-z0-9_-]`, e.g. `work` — a local key, NOT a Google
     account name or email; `src/auth/paths.js`
     `getAccountMode`/`validateAccountId` at the pin). The fork serves the
     loopback callback `http://localhost:<3500-3505>/oauth2callback`
     (`src/auth/server.ts` at the pin) and opens the browser; consent shows
     ONLY the `calendar.events.readonly` scope.
  5. Normal run (POSIX snippet below is fully runnable on Linux/macOS;
     PowerShell differences are listed after it; a manual Windows 11 run is
     still pending). `calendarId` is the real user choice (`primary` works);
     `account` is the LOCAL account id used at consent step 4 (`normal` when
     `auth` ran without an id), or omit `account` for the default. The hint
     JSON is GENERATED (never hand-edited): the absolute node command ONLY
     (`process.execPath`; the SDK spawns with `shell:false`, so a shell
     command line is never valid), the args array with the absolute fork entry
     plus the explicit `--enable-tools` comma list, the OS-platform SDK
     implicit allowlist plus the three explicit `GOOGLE_*` names, and the
     three full pinned live-wire hashes (SDK wire bytes, NOT the
     registry-direct `a065/012e/913…` diagnostic bytes):
      ```bash
      # Absolute Companion checkout root recorded in step 2 (if this is a
      # new shell, set it to that path first; it contains pnpm-workspace.yaml).
      # Example: COMPANION_DIR="$HOME/companion_harness"
      FORK_DIR="$HOME/gcal-readonly"   # verified checkout from step 2
     ACCT="normal"                    # local account id from step 4
     cat > /tmp/gen-calendar-json.mjs <<'EOF'
     import os from "node:os";
     import path from "node:path";
     const forkDir = process.argv[2];
     const account = process.argv[3] === "" ? undefined : process.argv[3];
     const posixBase = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
     const winBase = ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"];
     const base = os.platform() === "win32" ? winBase : posixBase;
     const doc = {
       selection: account === undefined ? { calendarId: "primary" } : { calendarId: "primary", account },
       connector: {
         serverId: "calendar-readonly",
         kind: "mcp",
         expectedServerName: "google-calendar",
         version: "3.0.0-readonly.2",
         transport: {
           kind: "stdio",
           command: process.execPath,
           args: [path.resolve(forkDir, "build", "index.js"), "--enable-tools", "list-events,search-events,get-event"],
           envAllowlist: [...base, "GOOGLE_OAUTH_CREDENTIALS", "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH", "GOOGLE_ACCOUNT_MODE"],
         },
         bindings: [
           { upstreamTool: "list-events", canonicalSchemaHash: "01c3d647c272fdbd0de1028f73c76cd8baab931f177733146cd6287b9683d1fe" },
           { upstreamTool: "search-events", canonicalSchemaHash: "d94166b755b694710c925fcc96e6ecff1016ea53f470264428494656791be7f6" },
           { upstreamTool: "get-event", canonicalSchemaHash: "8c6736e2a1f397d0735efa5c0881f5c350c300b21a0b026e80c112258b596bda" },
         ],
       },
     };
     process.stdout.write(JSON.stringify(doc));
     EOF
     export COMPANION_CALENDAR_PROFILE=google-readonly
      export COMPANION_CALENDAR_JSON="$(node /tmp/gen-calendar-json.mjs "$FORK_DIR" "$ACCT")"
      export GOOGLE_ACCOUNT_MODE="$ACCT"
      cd "$COMPANION_DIR" && pnpm start  # launches Companion (root pnpm start contract), NOT the fork; never run pnpm start inside $FORK_DIR
      ```
     The SDK implicit names above are the live SDK 1.30.0
     `DEFAULT_INHERITED_ENV_VARS` (`dist/esm/client/stdio.js`: POSIX 6 /
     win32 12; `shell:false` at the spawn call site) — no other inherited
     name is passed, and the three exported `GOOGLE_*` values travel ONLY
     because they are both exported here AND allowlisted there (strict
     allowlist: anything else is never passed to the child). Missing auth
     surfaces as the fixed `mcp_unavailable` per call (never fake success);
      shutdown stays bounded and clean. PowerShell differences (not a full
      Windows run): `export X="..."` is `$env:X="..."`; the pin digest and
      package-identity checks are the same portable `node` one-liners above
      (no `sha256sum` / `Get-FileHash` needed), and there is no
      `chmod` guarantee (rely on the per-user profile ACL); the node generator
      itself is cross-platform via `os.platform()`. Manual Windows 11 is still
      pending.
  Credential-free runtime proof (no OAuth, no browser, no live Google):
  `docs/evidence/calendar-readonly-profile/smoke-profile.result.json`
  (22/22: pin reality, auth-gate source check, real SDK initialize/tools-list
  over actual fork code via InMemory + fixture provider, profile 3/3 enable,
  adapter search/get runnable, list-calendars denied with zero metadata I/O,
  mismatch fail-closed, normal `startServer` ownership + lazy + error path,
  zero network attempts) and
  `docs/evidence/calendar-readonly-profile/cli-profile.result.json` (actual
  normal-CLI `pnpm start` acceptance with missing credentials). What those
  artifacts prove is the RUNTIME side only — wire identity, the three
   live-wire hashes, and behavior. They do NOT re-verify the source SHA: the
   full commit/tree/package/lock verification in step 2 above is the prerequisite that
  must pass BEFORE `npm ci --ignore-scripts` + `npm run build`, and the
   runtime proof assumes that prerequisite was met.

  Durable local run (checked-in launcher, env-only secrets):
  `run-google-readonly.sh` (repo root, POSIX `sh`) generates
  `COMPANION_CALENDAR_JSON` exactly per the step-5 generator above
  (`primary`, account from `GOOGLE_ACCOUNT_MODE` default `normal`,
  pinned wire identity + 3 live-wire hashes, explicit `GOOGLE_*`
  allowlist) and execs `pnpm start` with
  `COMPANION_CALENDAR_PROFILE=google-readonly` on loopback port
  `COMPANION_PORT` (default `3000`). It embeds no secret: credentials
  come from `GOOGLE_OAUTH_CREDENTIALS` (launcher actual default
  `$HOME/gcal-readonly/gcp-oauth.keys.json`) and the token path env
  (default `~/.config/google-calendar-mcp-readonly/tokens.json`).
  The step-3 `$PRIV/gcp-oauth.keys.json` path above is a template only:
  the current live path is the launcher default (overridable via
  `GOOGLE_OAUTH_CREDENTIALS` env), keys are not moved.
   Actions stay disabled (`COMPANION_ACTIONS_JSON` explicitly unset).
  Model: an already-exported `COMPANION_MODEL_JSON` wins; otherwise the
  launcher builds one from the private git-ignored runtime file
  `.env.litellm` (0600, never committed/logged) against the existing local
  LiteLLM proxy (`openai-compatible`, loopback, no new keys or policy
  changes); with neither, runs fail closed while health + calendar
  registration stay verifiable. Observed: model `qwen-local` via the
  loopback proxy; a live read-only conversation completed end to end
  (`run.completed`, one `calendar.search` succeeded/accepted, one
  `reference.presented` with a snippet evidence grant = `[r1]` cited, turn
  selected). Earlier unguided prompts failed closed after repeated
  `calendar_range_invalid` (model-sent ranges without explicit offsets)
  plus step/whole-run timeouts; the proving prompt carried an explicit
  RFC3339 range (`2026-10-14T00:00:00Z` to `2026-10-15T00:00:00Z`). DB is the normal OS app-data
  default; no migration beyond standard startup. Logs stay on
  stdout/stderr (no app log files); for persistence run it under
  `tmux new-session -d -s companion-cal ./run-google-readonly.sh` and
  read back scrollback instead of a log file.

  Note (2026-10-19): the `qwen-local` observation above is historical and is
  left unchanged. The launcher now requests the model-agnostic LiteLLM alias
  `local-chat` (currently mapped to Huihui Ornith 1.5 35B A3B); the `qwen-local` alias
  is being removed.

### C15 Calendar fake E2E harness fixes (observed: refresh + tombstone scenarios)

- The two failing C15 browser scenarios were ROOT-CAUSED against the real
  agent strategy, not worked around. `reference.refresh` was rejected by the
  broker with `invalid_input` on BOTH scenarios: the model addressed `r1`,
  but `translateReferenceArgs` seeds the per-run `rN` -> UUID map ONLY from
  the turn's FROZEN reference context, and the session reference context is
  written ONLY by the real §14.8 CAS `PUT` that the UI performs when the user
  OPENS a citation. The refresh/tombstone scenarios re-addressed `r1` in a
  later turn without ever opening it, so `r1` was legitimately not
  addressable. The fix is in the harness, not in production semantics: the
  scenarios now perform the REAL user selection step (click the delivered
  `r1` citation, drawer opens, real conditional `PUT` runs) before the
  follow-up turn. No selection is faked server-side and no UI path is
  bypassed.
- The scripted fake model (`apps/server/e2e/calendar/model.ts`) is now
  STATELESS: the fixed plan is selected from the CURRENT turn request text
  (the last user message framed `User request:`), the plan step is the count
  of real tool feedbacks in that turn's own transcript, and the answer
  citation is the highest `rN` ordinal those feedbacks actually delivered.
  The previous gateway-global `GatewayState` (plan/turn/step/learnedOrdinal
  reset via `userMessageCount`) could reset a plan or lose a delivered grant
  on a turn change and leaked state across sessions sharing one gateway;
  that shared state is gone. `Reference.refresh` itself needed no production
  change — the observed `invalid_input` was correct behavior for an
  unselected `rN`.
- Observed verification (only the two previously failing scenarios were
  re-run; the two passing scenarios were NOT re-run):
  `COMPANION_E2E_CALENDAR=1 playwright test --grep 'refresh|tombstone'`
  -> **2 passed** (`/tmp/calendar-refresh-fixed.log`), plus
  `tsc --noEmit -p apps/server/tsconfig.e2e.json` exit 0 and
  `biome check` on the two touched e2e files, 0 findings.

#### C15 POSITIVE authoritative tombstone — final browser proof (observed)

- The positive tombstone scenario
  (`apps/server/e2e/calendar/tombstone.spec.ts`) is now GREEN in a real
  chromium browser. Observed verification (FRESH harness, no reused state):
  from `apps/server`, `COMPANION_E2E_CALENDAR=1 pnpm exec playwright test
  --config playwright.config.ts --grep 'positive authoritative'` →
  **1 passed (4.6s)**, full log retained at
  `/tmp/calendar-authoritative-tombstone-final.log`. The harness's own
  `_diagnose.ts` / `_drive-stage.mjs` root-cause probes were removed after
  the proof.
- Fixture binding root fix
  (`apps/server/e2e/calendar/authoritativeBinding.ts`): the fixture's raw
  `McpConnectorConfig` now carries the explicit root fields
  `clientName: "companion-harness"` / `clientVersion: "0.0.0"` (no schema
  inference). App C (port 4185) boots the REAL production Calendar adapter
  over a REAL `McpConnector` on the official inert SDK
  `InMemoryTransport`, whose scripted fake MCP server additionally
  advertises the trusted read binding `get-event-authoritative`.
- The tombstone is produced ONLY by the explicit host-trusted fixture gate:
  the loopback control seam arms `authoritativeDeleted`; only then does
  `get` perform a SEPARATE real wire `tools/call` of
  `get-event-authoritative`, decoded by the UNCHANGED production
  `normalizeGetResult` (exact synthetic revision + `etag` basis +
  `cancelled`), and the fixture wrapper (never the production normalizer)
  flips it to `status: "deleted"`. Anything else degrades to the ordinary
  adapter read. This stays a test-only synthesis; it does NOT loosen the
  C11-01 policy and is NOT a live/OAuth/production tombstone claim.
- Observed scenario assertions (all through the REAL UI/API): turn 1
  delivers r1 and the REAL citation click freezes r1 via the real §14.8
  conditional `PUT`; the armed turn 2 `reference.refresh` over the real
  adapter/broker materializes a NEW r2 citation whose drawer body carries
  `"status":"deleted"`; the prior r1 drawer body still shows
  `"status":"confirmed"` with the original title/start (history retained,
  open prior rN); control status shows `tombstoneGetCalls=1` (exactly one
  authoritative get, reached only after the gate was armed). No DB seeding,
  no manual reference presentation, no UI bypass, no snapshot fabrication
  outside the explicit gate.

### C21 M5 Action composition (triple gate)

- This subsection records the CURRENT C21 scope on top of C17-C20. Focused
  verification observed on this worktree (Node 24.12.0):
  `apps/server/test/action_composition.test.ts` 9/9 green over real
  `startServer` + temp SQLite (disabled direct capability-reads 0 / close 0,
  disabled derived factory 0 / close 0, enabled owned close exactly 1,
  enabled caller-owned close 0, enabled absent/both/neither/invalid-capability/
  mismatched-instance fail closed before listen with no listener leak) and
  root `tsc --noEmit -p tsconfig.json` exit 0. No full-suite rerun is claimed
  here.
- Listen-failure follow-up (independent review
  `ReviewReplayCompositionIdentity` on repair branch `99124aa`; ground truth
  per task, not rerun pre-fix): the listen-failure catch invoked the adopted
  enabled owned write-port hook and then the outer startup-failure catch
  invoked the SAME hook again (2 closes; the injected hook is never required
  to be idempotent). `apps/server/src/bootstrap.ts` now CONSUMES the adopted
  hook (`takeOwnedActionShutdown`: cleared BEFORE invoke, so a sync throw or
  rejected promise still counts as used) at every invoke site
  (listen-failure catch, outer startup catch, post-drain shutdown), keeping
  only enabled owned adoption (disabled never closed, caller-owned never
  closed) with all failed-startup/drain cleanup paths exactly once and the
  listener error still rethrown. Regression:
  `apps/server/test/action_composition.test.ts` gains a REAL
  occupied-loopback-port fixture (live holder server, second `startServer`
  on the same port): genuine `EADDRINUSE` propagates, owned shutdown count
  is exactly 1, SIGINT/SIGTERM counts are stable, the holder still serves
  (disabled approve 409), and the same DB path restarts cleanly with a
  further exactly-1 close. Actual-runtime proof: the same standalone smoke
  (`.review-plan-work/smoke-replay-shutdown.ts` via repo tsx, removed after
  the T2 note above; review JSON kept) 12/12 checks, incl.
  `code=EADDRINUSE closed=1` with SIGINT/SIGTERM `1/1` stable. Focused
  `action_composition` 10/10 green (9 prior + 1 new), owned `biome check`
  clean. No push/resolve; thread IDs are for the parent to publish.
- Config (strict opt-in, DEFAULT DISABLED on both flags):
  `COMPANION_ACTIONS_JSON` is an exact `{ optIn?, writeEnabled? }` object
  parsed by `parseActionConfig`; both flags default to `false` and the
  frozen result is exposed as `config.actions`. Unknown keys, non-boolean
  values and non-objects fail closed with a fixed message. These flags are
  HINTS ONLY: they can never carry a write capability, a category, a
  connector instance id or any authorization decision.
- Dedicated write binding (trusted host code ONLY): the exact
  `CalendarActionWritePort` is injected through
  `startServer({ actionWriteBinding: { port, shutdown?, owned? } })`. It is
  never read from env/config. `owned: true` (explicit) transfers the port's
  lifecycle to the server ONLY when the triple gate actually opens, which
  then closes it after the engine drain and
  before the DB close; a caller-owned port (the default) is never closed by
  the server and extra caller-owned ports are never closed arbitrarily.
  `derivePort` fires for BOTH compositions: the owned `config.calendar`
  selection and the injected `calendarBinding` selection (active selection +
  server-registered instance id, exact-identity match still fail-closed).
- TRIPLE gate: `m5-action` and the proposal-only `calendar.reschedule`
  registration exist ONLY when (1) `config.actions.optIn`, (2)
  `config.actions.writeEnabled`, and (3) a dedicated trusted write port whose
  enabled capability (`tool: calendar.reschedule`, editable fields exactly
  `["start","end"]`, `writeEnabled: true`) names the EXACT ACTIVE Calendar
  instance of the composed read binding — all three hold. When the config
  opts in and the write binding is absent, unusable (both/neither of
  port/derivePort), invalid, or does not match, startup fails closed
  (`server_config_invalid`, before listen); an injected port with the config
  disabled is simply never adopted (no derive call, no capability read, no
  use, no owned shutdown). There is deliberately NO production write
  binding selected in this codebase. The canonical write-connector identity
  (non-empty server name <= 128 / version <= 64, same rule as the normal
  composition) is validated in the pure preflight BEFORE any DB side effect,
  with any factory (explicit inert-transport test seams skip only the
  OS-env allowlist gate, never the identity rule).
- Wired composition when the gate is open: one existing `ReferenceManager`
  (same DB), one `ActionExecutionService`, the authoritative read port
  `createCalendarActionReadPort` over the EXISTING Calendar `get` binding +
  the DURABLE private target store (real `deleted` observations pass
  through; nothing is synthesized; abort is respected before any call), the
  repository's SINGLE shared proposal stager with `writeEnabled: true`, the
  `calendar.reschedule` proposal-only registration, and the deterministic
  `m5-action` RunStrategy over `createActionStrategy`.
- Disabled behaviour: with the gate closed nothing can be staged (the stager
  refuses) and `POST .../proposals/:id/approve` returns a fixed
  `409 action_execution_disabled` BEFORE any repository call, so no queued
  Action Run (and therefore no orphan execution) can be created. Decision
  READS (`GET .../proposals`) keep listing existing state unchanged, and
  reject stays state-only.
- Read-back: the strategy verifies the post-write observation by STRICT JSON
  parsing of the canonical event body and exact `start`/`end` equality
  against the normalized intended instants (no substring matching), plus the
  same target identity and a non-deleted status; anything else is
  `succeeded_unverified`/fail-closed. Write proposal/port instants must be
  millisecond-representable: genuine sub-ms (nonzero past the ms position,
  e.g. `.1234`) is rejected at staging and by the write port before any
  dispatch, while ms-expressible fractions (`.12`, `.123`, `.123000` all-zero
  tail = same ms) stage normally; read-back compares the same instant
  (equivalent offsets accepted), never the same string. The write receipt is
  classified from `structuredContent` when own-property present (present
  null/wrong-shaped fails closed to `unknown`, never rescued by text); strict
  JSON `text` is the fallback ONLY when `structuredContent` is absent.
- Fake harness seam for C22 (exact API): inject deterministic fakes through
  `actionWriteBinding` (write port) and the existing `calendarBinding`
  (read/search port) seams; production passes neither. The write port must
  be pre-bound to the Calendar instance id the harness provisions (the
  server re-verifies it), and it must never retry `update`.

### C09-01 / C09-04 / C09-07 / C09-08 trusted read policy, model exposure & real stdio

- This subsection records the CURRENT new-scope observed work: C09-07 trusted
  read-only binding policy, C09-01 / C09-04 model-visible tool exposure, and
  C09-08 the production DEFAULT stdio transport. It supersedes the remaining
  "unverified" C09 naming as the current scope, but the historical PR15/PR16
  counts and the earlier wire/transport subsections above remain historical
  evidence and are NOT restated as this run. It is not a global live-Google /
  Windows / production-registration claim, and no package pin changed
  (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`, provider pins unchanged).
- CURRENT constructor is `new McpConnector(config, readonly
  McpBindingDefinition[], factory?)`: the trusted `McpBindingDefinition[]`
  (readonly `upstreamTool` / `canonicalSchemaHash` / `category`) is the
  REQUIRED second argument; `factory` stays the optional third. `category`
  reuses the contracts `ToolCategory` vocabulary (`read` / `write` /
  `sensitive` / `unclassified`). This is an internal, breaking-library API
  change; the `new McpConnector(cfg)` calls in the PR15/PR16 HTTP/stdio
  archives are the HISTORICAL API (recorded as such), not a compatibility shim.
- Real in-memory SDK BEFORE → AFTER policy (`before-policy/` and
  `after-policy/` under the out-of-repo `c09-security-verify/`): BEFORE, an
  unclassified fake writer with a neutral-looking `search` name was callable
  and produced a provider effect (`providerEffects=1`), and the model surface
  exposed non-read descriptors. AFTER, trusted `write` / `sensitive` /
  `unclassified` definitions and missing definitions deny `callTool` AND
  `ensureConnected` with fixed `mcp_binding_not_allowed`, `dials=0`,
  `handlerCalls=0`, `providerEffects=0`, `enabledBindings=[]`; the model
  advertisement of four KNOWN descriptors yields only `markdown.search` plus
  the reserved `answer.submit` LAST. A caller-claimed `category:"read"` /
  `readOnlyHint:true` cannot upgrade any class.
- Valid READ-positive: the ORIGINAL `after-policy` read positive is
  SUPERSEDED (its fixture incremented a writer counter; `providerEffects=1`)
  and MUST NOT be cited as a read proof; its supersession note
  (`SUPERSEDED-read-positive.txt`) is retained and the original artifacts are
  unchanged. The corrected, source-distinct immutable-read proof is
  `after-policy/corrected-read-positive/result.json`: `delete-event`
  (`readOnlyHint:false`), config/trust/wire hash linked, `ensureConnected` /
  `callTool` ok, `handlerCalls=1`, `providerEffects=0`, connector shut down
  (`connectedAfterShutdown=false`), fixture server closed. The negative and
  model halves of the original `after-policy` proof remain valid and were NOT
  re-run here.
- Real production DEFAULT stdio (Linux, Node 24.12, SDK 1.30.0 child) in
  `after-stdio/{result,summary,commands}`: the allowed canary is present and
  the excluded canary is ABSENT; the literal six injection-shaped args produce
  no shell marker and no model marker; model-supplied command/args/env travel
  only in the RPC payload (fixed transport), with the actual 2 calls sharing
  one child PID. A missing live-SDK default env name yields fixed
  `mcp_unavailable` with no START record and zero spawns. A direct real-SDK
  ENOENT on the owned path is rejected with the path/canary present, while the
  production connector returns the fixed redacted result with failure count 1.
  Cleanup observed `ownedPidsObserved=2` / `finalOwnedPidsAlive=[]` via the
  owned startup PID + `process.kill(pid, 0)` after shutdown. NO public
  `onclose` claim, NO Windows physical proof, NO fork / OAuth / live Google /
  production registration.
- Default SDK env: EVERY effectively inherited SDK default name must be
  explicitly allowlisted even when unset; there is no extra function-value
  policy or filter. `shell=false` is the SDK pin behavior plus an actual
  metacharacter proof. The PR16 transport bounds and actual `onclose` semantics
  are unchanged. Frozen startup snapshot: every allowlisted inherited name
  must resolve to a frozen inheritable value (shell-function `()...` exports
  never inheritable); a missing/uninheritable frozen value rejects pre-spawn
  with fixed `mcp_unavailable` (no live-env fallback, no spawn, no invented
  empty PATH). Win32 is case-insensitive: allowlist membership, frozen lookup
  and child-env key all resolve to the canonical SDK name (exactly one key).
- Before/after actual-SDK archives (all under the out-of-repo
  `c09-security-verify/`; source + commands + failure history retained there,
  in-repo temporaries removed and not retained in the repo): `ambiguity`
  (6 malformed host variants in both orders permitted before, denied locally
  with zero I/O after; live conflict denied both orders `N` with 0 calls while
  the unrelated `M` read actually succeeds and is the only enabled name),
  `catalog` (before, an unfinished prefix authorized `N` with 1 call; after,
  all bindings disabled, `mcp_schema_mismatch`, `listCount=10`, 0 calls;
  complete tenth page actually succeeds; complete-catalog partial drift
  preserved), and `catalog-shutdown` (before, shutdown during the real
  final-page digest wrongly returned `mcp_schema_mismatch`; after,
  `mcp_unavailable` with `enabled=[]` and 0 calls). These are actual
  observations, not inflated case counts or upstream-compatibility claims.
- Latest local full-battery result (OBSERVED, after this patch set; recorded under
  the out-of-repo `c09-security-verify/final-checks/`): root `pnpm run
  typecheck` exit 0, `pnpm run typecheck:e2e` exit 0, `pnpm test` **94 files /
  1137 passed / 0 skipped** (Linux), and whole-repo `pnpm run lint`
  (`biome check .`) **192 files, 0 errors / 0 warnings / 1 pre-existing info**
  (the `biome.json` `recommended` deprecation is not a new warning). The first
  lint run counted the temporary in-repo `.security-proof/` helpers (216 files,
  33 errors / 60 warnings) which are NOT product code; they were archived
  out-of-repo and removed from the repo, and the affected lint was re-run. This
  is a local, owned-branch observation and not a future CI or head-SHA claim.
  The historical PR16 baseline (1123 tests / 92 files) is NOT used to predict it.

### PR16 review followup: retired cleanup join & late-closure renewal

- This followup records **only** the PR16 review-thread fixes on the C09-05/06
  transport bounds. It does not widen scope: the C09 security PR17 read-only
  policy (mandatory definitions / hints / readOnly sidecar) is **NOT** part of
  PR16, the Calendar-adoption status stays **HOLD**, and no wire config, pin, or
  public API changes. The 8/8 stdio smoke, 7/7 loopback-HTTP smoke, and root
  1123 tests / 92 files above remain the HISTORICAL PR16 truth; the observed
  final counts below are a separate, later section and do not replace them.
- P1 shutdown join (thread `PRRT_kwDOUNdW7s6rYfGY`): an overflow-detached
  bounded cleanup is registered centrally through
  `OwnedConnectionHooks.onCleanupStarted`, and explicit shutdown joins every
  STARTED cleanup until its ORIGINAL bounded deadline (no reset/restart).
  Observed BEFORE (`before-runtime/`): shutdown returned while a fresh cleanup
  was still unsettled (~997ms stale wait before the owned 1s). AFTER
  (`after-runtime-pr16/`): shutdown ~314ms, the owned positive public-SDK PID
  was gone at return, exactly one production SIGKILL at ~299ms (the original
  300ms grace), no helper safety kill, final owned PIDs alive `[]`.
- P2 cancellable backoff (thread `PRRT_kwDOUNdW7s6rYfGX`): each connect
  singleflight entry owns a fresh `AbortController`; shutdown aborts it
  synchronously so a fenced demand resolves fixed `mcp_unavailable` without
  sleeping the stale delay or holding the mutex. Observed AFTER
  (`after-runtime-pr16/`): the old fenced demand settles fixed-unavailable ~3ms
  after shutdown with the failure count preserved at 1 and the stale timer
  removed; the fresh post-shutdown demand owns its FULL fresh 1000ms backoff
  (scheduled at +0ms) and is the only call that reaches upstream (two 1000ms
  timers total, no auto-replay).
- Late-closure renewal (native review, fixed in-session): a RENEWED generic
  bounded cleanup must not settle on a superseded generation's SDK client-close
  memo or the already-resolved global close-observed latch. A numeric
  `closeGeneration > 1` guess missed the OBSERVED pre-handoff close (raw
  `onclose` with no physical close, generation 0); the final fix is an explicit
  private renewal PHASE (`lateCleanupPhase`, initial false, set true only in
  `startLateCleanup` on the generic path) so a renewed generation waits ONLY on
  its own matching `rawClose` or the configured finite grace. `closeGeneration`
  remains solely the stale-memo completion identity guard, and the real stdio
  path and its candidate selection are unchanged. Observed with the generic
  late-closure helper over the production `McpConnector` and real SDK `Client`
  (paths `generation/observed-close/{before,after}`): BEFORE shutdown settled
  while the first close gate was held and the new resource was still open; AFTER
  it stays pending until the matching renewed raw close, then settles.
  Permanent regression: the `shutdown-race.test.ts` renewed-cleanup case FAILS
  against the heuristic and PASSES against the phase; deterministic fake-clock
  coverage consumes 123ms of the original grace before shutdown, stays pending
  at 499ms, and settles at the original 500ms (never a restarted 623ms), plus
  the max-30s lifecycle cases (cancel without advancing the old timer, queued
  fence, fresh own full 30s).
- PR17 remains OUT of PR16: the read-only / mandatory-definition / hints /
  readOnly sidecar policy is not promoted into this document, and the
  unregistered/adoption **HOLD** and wire config are unchanged. This followup
  review touches only the C09-05/06 transport-bounds scope.
- Evidence retention: exact BEFORE/AFTER commands and JSON proof are archived
  OUT-OF-REPO under
  `/home/molmot/.local/share/opencode/tool-output/c09-review-response/`
  (`before-runtime/`, `after-runtime-pr16/`, `generation/{before,after}`,
  `generation/observed-close/{before,after}`, and the final owned scaffolding
  archive `final-checks-pr16/`). The in-repo `.review-proof/` helper scaffolding
  was TEMPORARY: it was archived first, then deleted so it cannot pollute
  whole-repo lint. Helper evidence is fixture/local only — no Windows
  process-tree or durable-PID claim, and the generic path stays HOST bounded.

### PR16 final checks (observed on base 026466a)

- Battery run ONCE after the doc/comment patches and the format-only pass, on
  the owned branch with no repo config change and no helper scaffolding present:
  - `pnpm run typecheck` -> exit 0 (root `tsconfig.json`; strict +
    `exactOptionalPropertyTypes` + `noUnusedLocals`/`noUnusedParameters`).
  - `pnpm run typecheck:e2e` -> exit 0 (`apps/server/tsconfig.e2e.json`).
  - `pnpm test` (Vitest) -> **92 test files passed, 1129 tests passed**.
  - `pnpm run lint` (Biome `check .`) -> **190 files checked, 0 warnings**,
    1 pre-existing recommended-field info, exit 0.
- These are the ACTUAL observed values on this working tree; they are not a
  prediction of any future CI run or head SHA. The earlier PR16 root **1123 /
  92** above is preserved as historical truth; the +6 tests are the new
  review-followup regression cases (backoff interruption, retired-cleanup join,
  and the late-closure renewal).
- Scope: C09-05/06 transport bounds only. PR17 read-only/security policy and
  the unregistered Calendar adoption remain **HOLD** and unchanged.

### PR17 merged runtime follow-up (observed on 71961c9)

- This subsection records the merged PR17 runtime (`71961c9c29205b6f18c1bf49088214138886f287`,
  merge of `8e87219` PR16-followup into `d3f1878` old-PR17) on branch
  `fix/c09-remaining-security`. The merge-updated constructor is
  `new McpConnector(config, readonly McpBindingDefinition[], factory?)`: the
  trusted, source-reviewed `McpBindingDefinition[]` (`upstreamTool` /
  `canonicalSchemaHash` / `category`) is the REQUIRED second argument and
  `factory` stays the optional third. The PR15/PR16 archive calls
  `new McpConnector(cfg)` / `new McpConnector(cfg, factory)` are the HISTORICAL
  API; there is **no** two-arg compatibility shim, and no wire config, package
  pin (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`), or source behavior was
  changed by this follow-up.
- The verified PR16 OUT-archive runtime helpers were REUSED (not re-derived)
  from `c09-review-response/{before-runtime,after-runtime-pr16,final-checks-pr16}`,
  adapted ONLY for the constructor signature above. Every helper declares an
  explicit source-reviewed READ definition (`upstreamTool` + probed
  `canonicalSchemaHash` + `category:"read"`) from its fixture schema; the
  definition is never inferred, defaulted, or approved from the connector
  config. All four cases ran the actual merged production source (real SDK
  `Client`), not a reimplementation.
- P2 cancellable backoff (`after-runtime-pr17/backoff`, public observations
  only): the first demand records one failure; the fenced old demand enters the
  pre-construction `1000ms` backoff, and explicit shutdown aborts its
  per-attempt controller so it settles fixed `mcp_unavailable` promptly with
  the failure count preserved at `1` and the mutex released (no stale sleep);
  the fresh post-shutdown demand owns its OWN full `1000ms` backoff (scheduled
  at `+0ms`, before the old stale wait would have been due) and is the only
  call that reaches the upstream handler (`handler_args=["fresh"]`, two
  `1000ms` timers, no auto-replay, factory calls `2`). The merged `P2` run is
  `FIX-VERIFIED`, exit 0.
- P1 default stdio detached cleanup (`after-runtime-pr17/stdio`, public
  `stats()` + `process.kill(pid,0)` on the fixture's OWNED startup-record PID):
  the real default `defaultTransportFactory` spawns a genuine Node child; a
  `tools/call` writes `65537` bytes to stderr and hangs, so the count-only
  latch saturates at `65536`, the connection clears (`connected:false`,
  `consecutiveFailures:1`, `enabledBindings:[]`) and the detached cleanup is
  registered before it finishes. Explicit shutdown joins it: at return the
  child is already dead from the connector's OWN production SIGKILL (exactly
  one, at the original `300ms` grace, `+~308ms` shutdown duration), the
  in-flight overflow call settles fixed `mcp_unavailable`, and
  `final_owned_pids_alive=[]` with no helper safety kill. The merged `P1` run
  is `FIX-VERIFIED`, exit 0.
- Late-handoff generation / observed pre-handoff (`after-runtime-pr17/generation`
  and `generation/observed`), generic controlled PUBLIC transport (no process,
  no pid, no OS-death claim): AFTER the merged explicit `lateCleanupPhase`
  renewal, a renewed generic bounded cleanup waits ONLY on its own matching
  `rawClose` or the configured finite grace — never the superseded SDK
  client-close memo or the already-resolved global close-observed latch. Both
  cases observe that `shutdown()` stays pending while the matching close gate is
  held and the host resource is still open, then settles after release; the
  observed pre-handoff case issues the raw `onclose` with NO physical close
  (`close_count=0`, generation 0), so `closeGeneration` stays a completion
  identity guard only. Real-stdio candidate selection is unchanged. Both runs
  are `VERIFIED`, exit 0.
- Each helper run is archived OUT-OF-REPO under
  `c09-review-response/after-runtime-pr17/` (per case: `stdout.txt`,
  `stderr.txt`, `exit.txt`, `observation.json`, source + bundle + `command.txt`;
  plus `versions.json`, `commands.txt`, `helpers/`, `history/`). The in-repo
  `.review-proof/` scaffolding was TEMPORARY: it was archived first
  (`c09-review-response/final-checks-pr17/` with a 12-file sha256 manifest and
  `pr17-helper-reuse-paths.txt`), then deleted so it cannot pollute whole-repo
  lint. No prior PR16 or `c09-security-verify` archive was overwritten.
- Latest local full-battery result AFTER the merged runtime patch set (in-repo
  scaffolding removed), 94 files / 1143 tests observed: `pnpm run typecheck`
  exit 0; `pnpm run typecheck:e2e` exit 0; `pnpm test` (Vitest) **94 test files
  / 1143 passed / 0 skipped** (Linux); whole-repo `pnpm run lint`
  (`biome check .`) **192 files, 0 errors / 0 warnings / 1 pre-existing info**
  (the `biome.json` `recommended` deprecation info). The historical PR17
  security `final-checks` **1137 tests / 94 files**, PR16 **1129 / 92**, and
  earlier **1123 / 92** remain HISTORICAL truth and are NOT restated as this
  run. `pnpm` performed an implicit local relink of **191** workspace
  `node_modules` entries from the local store (no network, no lockfile change)
  during the run. These are local owned-branch observations, not a future CI or
  head-SHA claim; the formal C09/C10/C11 gates and Calendar adoption stay
  **HOLD**, and no source/test fix was needed (no observed machine failure).

## C24 action-core review fixes (verified)

Four evidence-backed review bugs on the m5-action core, each fixed in its own
commit with a focused regression test; all four reviewed ranges are the ONLY
source touched (no scope broadening, no UI/server/browser changes).

- **Fix 1 — expired pending proposal still occupied the session cap**
  (`action_proposals.ts` `commitStaged`, before the one-pending-per-session
  recheck; commit `1d736779c1351e3e5bc0273fa8043aeb6a7489b7`): Within the
  caller's completion transaction, older pending rows with
  `expires_at <= now` are expired FIRST (`status='expired'`,
  `resolved_at=now`, `decision_turn_id=NULL`, satisfying the
  `action_proposals` CHECK), so an unattended expiry no longer blocks a fresh
  proposal in the same session. Boundary is EXACT 15min (`expires_at <= now`
  matches the stager's `now >= entry.expiresAt`). A failed completion rolls
  the sweep back with everything else (single transaction). Regression:
  `packages/kernel/test/action_proposals.test.ts` "expires an unattended
  pending proposal at commit time and frees the session cap (exact 15min
  boundary)" — unattended expiry, then the new proposal commits, old row is
  `expired/resolved@now/decision NULL`, and the forced-rollback restores the
  un-swept pending row.

- **Fix 2 — `resolveTarget === undefined` after the grant wrongly returned
  `succeeded_unverified` with 0 writes**
  (`action_strategy.ts` step 2; commit
  `da951228a10952f0c8b467efd0c25c8d8df267c3`): The host-private target is
  now resolved BEFORE `runActionPreflight` can consume the one-shot grant.
  A missing target fails through the EXACT real preflight-failure terminal
  (failed receipt + non-terminal `action.preflight_failed` + `run.failed`,
  marker NULL, UNCONSUMED grant, zero writes); a success claim is never made
  for an unattempted write. The later post-gate undefined-target
  `succeeded_unverified` branch is removed; injection-binding defaults are
  untouched. Regression: `action_scheduler_pickup.test.ts`
  "fails closed through the REAL preflight-failure terminal when the host
  cannot resolve the private target" — real RunEngine pickup, `writes: []`,
  `consumed_at` NULL, `externalCallStartedAt` NULL, last event `run.failed`.

- **Fix 4 — recovery sweep INNER JOIN excluded m5-action runs whose
  execution row is missing** (`action_executions.ts`
  `validateAndRecoverActionRuns`; commit
  `043c0a211675192161e152839925ea5eaf2d59a6`): the sweep now queries ALL
  `strategy='m5-action'` runs directly (the previous inner join silently
  skipped a real orphan). The existing validation pass rejects a missing
  execution with `DatabaseStateInvalidError` BEFORE any mutation, so the
  whole sweep fails closed with zero writes. Regression:
  `action_executions.test.ts` "fail-closes the WHOLE sweep when an
  m5-action run has NO execution row (real orphan is never silently
  skipped)" — a recoverable executing orphan plus an execution-less m5-action
  run throw `/has no execution/` and BOTH pairs stay untouched.

- **Fix 3 — recovery classifier rejected a valid post-marker
  `definite_failure` terminal** (`action_executions.ts`
  `classifyActionPair`; commit
  `9582355843d4e47974014a7ba13d65d729aeb5a9`): `failed` is now legal in BOTH
  marker states — pre-marker failure (preflight failure / pre-marker cancel,
  marker NULL) AND post-marker `definite_failure` (marker + CONSUMED grant
  + failed receipt both required by the unchanged follow-up checks). Invalid
  combos still fail closed, including a consumed grant on a pre-marker
  failed execution (never producible). Regression: "accepts an
  ALREADY-terminal post-marker definite_failure pair as unchanged"
  (startup/drain idempotency: `unchanged:1`) and "fails closed on a
  pre-marker failed execution with a consumed grant".

- Temporary scaffold deletions from the C15 commit `347dce3`
  (tracked `tombstone-run.log` copies, `test-results/.last-run.json`, and
  `logfile/tmp/*.log` action-browser-safety/approve scans — all authored by
  agents, none user-owned) were deleted in commit
  `c5b336c0f9827d32f456999cca5613a1c2f51f8c`, separate from the fixes.

- Verification observed AFTER all edits (Linux, local): focused suites
  `packages/kernel/test/{action_proposals,action_executions,
  action_scheduler_pickup}.test.ts` **31 passed / 0 failed**; full kernel
  battery **46 files / 474 passed / 0 failed**; `tsc --noEmit` for
  `packages/kernel` exit 0. The missing-target and definite-failure-recovery
  regressions run against REAL temp-dir SQLite databases, the REAL
  `ActionExecutionService` and REAL `createActionStrategy`/`RunEngine`
  pickup (no fixtures faking persistence). Whole-repo `biome check`
  retains its pre-existing errors at HEAD (confirmed by stashing and
  re-checking before the fixes).

## C24 action pause handoff (2026-10-13)

Work is PAUSED at a clean boundary at the user's explicit request to change
model configuration. No new feature/fix was implemented in this handoff and no
checks were run.

- HEAD at pause: `518636c563f6e157e5765d3494020e0efbd2135e`
  (`518636c docs(operations): record C24 action-core review fixes …`);
  `git status --short` was empty (clean tree) before this handoff commit.
- The latest completed worker fixed 4 core m5-action review bugs in commits
  `1d73677` (expired pending proposal / session cap), `da95122` (target
  resolved before the grant gate), `043c0a2` (recovery sweep without the
  inner join, fail-closed on a missing execution) and `9582355` (post-marker
  `definite_failure` terminal accepted). Verification is the prior worker's
  OBSERVED record only — 31 focused kernel cases and a 474-test kernel
  battery — NOT a new run for this handoff (see the section above for full
  hashes and regressions). Scaffold deletions out of C15 `347dce3` were
  detected as out-of-scope but agent-authored and intentional, landed as
  `c5b336c` beside the doc commit `518636c`.
- Remaining review UI bugs (NOT started): (a) the generic composer's Stop,
  after a reload, is still marked/routed as an in-flight Action; (b) the
  `cancelAction` handler ignores the response's actual terminal status and
  claims "stopped" on any 200 — it must claim cancelled ONLY when the
  response actually terminalises as cancelled (fail-closed on other
  outcomes).
- Whole-repo lint is NOT closed at HEAD. A blanket "pre-existing errors"
  claim is deliberately NOT made here: the prior worker's stash-based
  baseline check (documented above as "confirmed by stashing and
  re-checking") is unreliable because stashing is prohibited for
  preservation of unrelated changes, so remaining errors must be re-observed
  directly against HEAD by an allowed method.
- Publication blockers (last actual push; no PR was created): the HTTPS
  remote prompt had NO username supplied, the SSH public key was DENIED by
  the host, and `gh` is NOT logged in. Consequently there is no PR and no
  verified compare URL for this branch/pause state; publishing requires an
  authenticated remote or a working credential before any C22 label is
  applied.
- Next concrete steps (for the resuming worker): 1) fix the composer Stop
  post-reload marked-Action bug in the UI layer; 2) fix `cancelAction` to
  honour the actual terminal status (cancelled only on a cancelled terminal,
  never on a bare 200); 3) re-run whole-repo `biome check .` against HEAD
  without stashing and close outstanding errors; 4) only after UI review
  closes, re-run the full battery and record observed numbers. Do NOT call
  C22 done while the two UI review bugs above remain open.

## C24 action Stop-fix resume (2026-10-13, resume-stop-finish)

Resumes the paused handoff above WITHOUT rewriting it. The two remaining UI
review bugs are now FIXED, each committed separately (model kept as
configured `opencode-go/muse-spark-1.3-contributor`, no override):

- `c0327bc50714a745861cf44e351bd6affa041559` fix(ui): gate generic composer
  Stop on actual Action execution marker/cancellability (composer tracks the
  real execution view per run id; hides/disables Stop past the committed
  marker, on refused cancellability, or on terminal execution).
- `bf2b33eac12639c15c38ca064cd73ef158bc6518` fix(ui): claim action stop only
  on actual cancelled terminal, refresh otherwise (`cancelAction` parses the
  validated `run.status`; stopped notice ONLY on a cancelled terminal).

Regressions + type-only drift fixes (working tree at resume, committed by
this worker in coherent chunks — see hashes below):

- `apps/server/e2e/calendar/action.spec.ts`: 2 new actual-browser cases —
  reload-during-held-post-marker-write (no Stop anywhere, cancel API 409s,
  release verifies success) and late-cancel-on-terminal (200 keeps actual
  receipt, no stop claim).
- `apps/server/test/action_ui.test.ts`: unit gate for `parseCancelRunStatus`
  (cancelled only on cancelled; live/terminal-race statuses refresh;
  malformed bodies fail closed to null).
- Type-only (no runtime change): `authoritativeBinding.ts`
  `CalendarGetPortResult`/`CalendarSearchPortResult` → `CalendarGetResult`/
  `CalendarSearchResult`; `mcpFake.ts` spread cast to
  `Record<string, unknown>`.

Verification: per the declared prior-worker record, focused UI tests, types,
and the 2 new browser cases were ALL GREEN before this resume; this worker
ran NO passing checks again (no tests/build/browser rerun per scope). The
retained log `/tmp/resume-action-stop.log` (and `/tmp/resume-action-*`) was
NOT readable in this session (tool permission denial on `/tmp` outside
`/tmp/opencode`), so exact green counts are NOT re-quoted here — see the
prior evidence section above (31 focused kernel / 474 kernel battery) and
the Stop-fix commits for the code change.

Lint: no lint recheck was run here (explicit no-recheck scope); whole-repo
`biome check .` therefore remains NOT closed, and remaining ROOT errors on
touched files (if any) are still open — no lint/type fix beyond the retained
type-only drift fixes above was applied.

Publication: PR #20 is published for this branch, SUPERSEDING the pause
handoff's historical "no PR / publication blockers" block above (SSH denied,
HTTPS prompt, `gh` not logged in at pause time). History is not rewritten:
the pause block stands as the observed state at pause; this note records
that it is superseded.

## C24 Stop-fix lint close (2026-10-13, resume-close-lint)

Whole-repo lint was re-observed directly against the current tree (no stash,
no revert, model kept as configured, no override). Full `pnpm run lint`
(`biome check .`) was run ONCE pre-fix and ONCE post-fix; no
passing tests/types/browser reruns were done for this lint-only slice.

- PRE (HEAD `f64f169`, before fixes): `biome check .` exit 1 —
  **217 files checked, 40 errors, 1 info** (the `biome.json`
  `recommended`-deprecation info). Owned errors (ROOT, on files this
  branch touches per `git diff origin/feat/c12-calendar-snapshots...HEAD`):
  `action.spec.ts` format; `authoritativeBinding.ts` organizeImports +
  format; `mcpFake.ts` format; `src/ui/client.ts` organizeImports +
  format; `src/ui/reducer.ts` format; `test/action_ui.test.ts`
  organizeImports + format (10 diagnostics). Raw output retained at
  `.verification-log/resume-lint.log` (not committed).
- FIX (no semantics, no mass format): `biome check --write` applied ONLY
  to the 6 owned files above — import-name ordering plus formatter
  rewraps; diff-verified as reorder/whitespace only. No enum/source/table
  count test existed in the touched files, so nothing was deleted or
  repinned. The untracked owned Playwright scaffold
  `apps/server/test-results/.last-run.json` (empty `test-results/` dir,
  `{"status":"passed","failedTests":[]}`, from the Stop-fix browser runs)
  was deleted; no unknown files were touched.
- POST (after fixes, formatter step done): `pnpm run lint` exit 1 —
  **216 files checked, 30 errors, 1 info** (same pre-existing info).
  All 6 owned files are clean (zero diagnostics). The remaining 30 errors
  are all in files this branch does NOT touch (per the same base diff):
  `e2e/calendar/actionPort.ts`, `e2e/calendar/server.ts`,
  `e2e/calendar/tombstone.spec.ts`, `playwright.config.ts`,
  `src/app.ts`, `src/bootstrap.ts`, `test/action_composition.test.ts`,
  `test/proposals.test.ts`, `packages/contracts/*`,
  `packages/kernel/*` (format + organizeImports only; full list truncated
  by Biome's diagnostic cap — see `.verification-log/resume-lint-postfix.log`,
  not committed). They are reported as unrelated blockers, not fixed here
  per scope (no unrelated mass format). Whole-repo lint is therefore NOT
  closed; owned lint is closed.

## C13–C22 all-lint finish (2026-10-13, c13-c22-all-lint-finish)

SUPERSEDES the ownership claim in the section above: the "30 remaining
errors are all in files this branch does NOT touch (per ... origin/feat/
c12-calendar-snapshots)" line was an ownership mistake. That remote ref
already contains our C13–C22 implementation, so it is the wrong base. The
correct base is the known initial base `228c403`; per `git diff
228c403...HEAD` the files `e2e/calendar/actionPort.ts`,
`e2e/calendar/server.ts`, `e2e/calendar/tombstone.spec.ts`,
`playwright.config.ts`, `src/app.ts`, `src/bootstrap.ts`,
`test/action_composition.test.ts`, `test/proposals.test.ts`,
`packages/contracts/*`, `packages/kernel/*` are ALL owned by the current
user request (C13–C22), so all 30 postfix diagnostics were IN SCOPE.

- PRE: retained `.verification-log/resume-lint-postfix.log` (not rerun to
  confirm) — **216 files checked, 30 errors, 1 info** (same
  `biome.json` `recommended`-deprecation info), format + organizeImports
  only.
- FIX (no semantics, no mass unrelated format, no behavior-contract
  change): `biome check --write` applied ONLY to owned files —
  `actionPort.ts`, `server.ts`, `tombstone.spec.ts`,
  `playwright.config.ts`, `app.ts`, `bootstrap.ts`,
  `action_composition.test.ts`, `proposals.test.ts`,
  `contracts/src/action.ts`, `contracts/src/events.ts`,
  `contracts/src/http.ts`, `contracts/src/index.ts`,
  `kernel/src/action_proposals.ts`, `kernel/src/action_strategy.ts`,
  plus the diagnostic-cap-hidden owned files `kernel/src/broker.ts`,
  `kernel/src/index.ts`, `kernel/src/repository.ts`,
  `kernel/src/schema.ts`, `contracts/test/m1-references.test.ts`,
  `contracts/test/m2-contracts.test.ts`,
  `kernel/test/action_proposals.test.ts` (import/export ordering plus
  formatter rewraps; diff-verified reorder/whitespace only). Grep over
  `packages` + `apps/server/test` found no incidental latest-enum/source/
  table-count tests, so nothing was deleted or repinned.
- POST (ONE final `pnpm run lint` after fixes; no passing
  tests/types/browser reruns for this whitespace/import-format slice):
  `biome check .` exit 0 — **216 files checked, 0 errors, 1 info**
  (only the pre-existing recommended-deprecation info). Raw output was
  retained accessibly at `/tmp/opencode/resume-lint-final.log`; the
  working `.verification-log/` was removed before commit, so no logs are
  committed.

## C12–C22 final integration gate (2026-10-13, c12-c22-final-integration)

Final integration run ONCE after the core/Stop fixes and the all-lint
close (`52d61ba`). The earlier root 1242-pass predates the core/Stop
fixes, so this is NOT a mere confirm. Per scope, the already-green
browser / new Stop cases / full browser / lint were NOT rerun. Model
kept as configured (`opencode-go/muse-spark-1.3-contributor`), no
override. No new feature/live/OAuth/pins/secrets.

- `pnpm test` → exit 0, **103 test files passed, 1251 tests passed,
  0 failed / 0 skipped** (Linux, Node 24.12.0, ~11.7s). Raw stdout
  captured in local `.final-gate-tmp/test2.log` (removed after
  evidence; summary lines `Test Files 103 passed (103)` /
  `Tests 1251 passed (1251)`).
- `pnpm run typecheck` (root `tsconfig.json`) → exit 0, empty output
  (`.final-gate-tmp/typecheck.log`, removed after evidence).
- `pnpm run typecheck:e2e` (`apps/server/tsconfig.e2e.json`) → exit 0,
  empty output (`.final-gate-tmp/typecheck-e2e.log`, removed after
  evidence).
- Each command run ONCE (first `pnpm test` failed with 3 regressions, fixed below, then rerun ONCE green; the two typechecks
  ran once each and passed first try). No browser/lint rerun.

Gate fix (consumer root-cause only, no repin, no noop): the first
`pnpm test` failed 3/3 cases in `apps/server/test/proposals.test.ts`
(C18 proposal decisions) with `RepositoryValidationError: target
snapshot body is not a stored SnapshotBody` at
`packages/kernel/src/action_proposals.ts:252`. Root cause is a STALE
test fixture, not production: the test seeded `resource_snapshots`
via raw SQL with the raw calendar event object, while the stored
contract (written by the real ReferenceManager since C17) is the
`SnapshotBody` wrapper `{ version: 1, text }` with the normalized
event produced by `calendarEventBodyText` inside `text`. The fix
aligns the seed with the exact stored shape
(`SnapshotBodySchema.parse({ version: 1, text:
calendarEventBodyText({...}) })`, same pattern as the kernel
`action_proposals.test.ts` fixture); no production code changed, no
assertion wording/source/default counts repinned, no test deleted
(the 3 C18 decision cases are real behavior coverage: keyed
approve/replay, keyless reject, 409/404 conflicts). No semantics
change, so no separate runtime script was required — the changed path
(staging over the wrapper body) is exercised by the 3 fixed cases
themselves (`apps/server/test/proposals.test.ts` 3/3 green in the
final run).

Current C12–C22 milestone table (honest status; implemented vs fake
vs formal HOLD; no C24 scope inferred):

| item | status | boundary / evidence |
| --- | --- | --- |
| C12 internal Calendar pipeline | IMPLEMENTED (consumer) | Real-SDK `c12-smoke` (9) + kernel `calendar_tools` (11) green in final 1251; durable private targets via migration 0006. Adoption HOLD. |
| C13 broker exposure / frozen temporal | IMPLEMENTED (consumer) | `calendar.search` model-visible, frozen now/zone per Turn, budget/dedup/timeout via existing broker; cross-source stored-only open/related. |
| C14 startup composition / opt-in config | IMPLEMENTED | Strict `COMPANION_CALENDAR_JSON` opt-in (default disabled), trusted-definition preflight, lazy connect, bounded shutdown; no provider profile adopted. |
| C15 fake E2E harness | IMPLEMENTED (fake) | Real chromium scenarios incl. positive authoritative tombstone via the test-only `get-event-authoritative` gate; NOT a live/OAuth/production tombstone claim. |
| C16–C20 engine/M2/UI slices | IMPLEMENTED | Covered by the final 103-file / 1251-test battery, root + e2e typecheck clean, whole-repo lint closed at `52d61ba` (216 files, 0 errors, 1 pre-existing info; NOT rerun here). |
| C21 M5 Action composition | IMPLEMENTED (triple gate) | Config hints + dedicated write port + exact-instance match; disabled gate refuses staging / 409-before-repository; no production write binding selected. |
| C22 action lifecycle E2E | IMPLEMENTED (fake) | Fake harness seams only; real-UI conversation→search→rN→refresh coverage via fakes, not live. |
| M6 calendar.create extension (agreed, M5 non-goal exception) | IMPLEMENTED (opt-in, create-only safe) | `calendar.create` (TIMED title/start/end only) on the same approval flow; targetless rows, 1 grant -> 1 `create-event` POST (`{id,summary,start,end}` only), verified-only new rN. Fork `google-calendar-create@1.0.0-create.1` pinned at CURRENT `7b40eaf`/tree `a5661f1b`/lock `63261d25` (historical: `5f07029`/tree `9a232e2` at exact-id 2xx proof; wire hash `983c1548…5234e` unchanged; stream-cap/symlink-bin/scope-validator hardening in CURRENT); create runtime reuses the SHARED `M5_RESCHEDULE_*` grant namespace (no `M6_CREATE_*` credentials). Host profile `M6_CALENDAR_CREATE_PROFILE=google-create` + `M6_CREATE_CONNECTOR_JSON`; explicit `createEnabled` triple; create-only startup needs no reschedule binding (`createWriteStartup.test.ts` 3/3). Proof: B-result stdio REAL 1-POST/1-GET/receipt `succeeded`/r1/0-extra (liveGoogleCalls 0) + browser create 3/3 + action 26/26 + migration 24/24. |
| C08 adoption / C10-08 production mapping / C11-01 positive tombstone | FORMAL HOLD / UNRESOLVED / BLOCKED | Unchanged: no adopted binding, pin, profile, OAuth, or live-Google wiring anywhere in this branch. |

Review/PR linkage: PR #20 is published for this branch (see the
resume-stop-finish section; it supersedes the pause-time publication
blockers). The two remaining Stop review bugs are CLOSED by
`c0327bc` (composer Stop gated on actual execution
marker/cancellability) and `bf2b33e` (`cancelAction` claims stopped
only on an actual cancelled terminal), with regressions in
`apps/server/e2e/calendar/action.spec.ts` (2 browser cases) and
`apps/server/test/action_ui.test.ts` (unit gate) — all green per the
prior record and NOT rerun here per scope.

Scaffolds: `.final-gate-tmp/` (local stdout capture) removed after
evidence; no new docs/logs committed besides this section; no
`test-results/`, `.verification-log/`, or `.review-proof/` residue in
the tree at gate time.

## PR20 T2 proposal approve idempotency lookup + draining replay (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYSd` (thread
`PRRT_kwDOUNdW7s6ryb6o`) on `feat/c12-calendar-snapshots` HEAD `814eac5`:
`IdempotencyScopeSchema` accepts `proposal:<uuid>:approve` but
`lookupIdempotencyForSession` recognised only session-message/turn-retry, so
the public lookup 404d a stored approval and `tryReplayStoredApprove`
returned 503 for a committed approval during drain. Ground truth per task
(not rerun to reproduce).

- `packages/kernel/src/repository.ts`: `lookupIdempotencyForSession` now
  parses the closed `proposal:<uuid-v4>:approve` scope, requires the actual
  proposal row owned by the same session (`requireOwnedProposal`; foreign or
  missing proposal 404s before any lookup, same pattern as turns), then
  delegates to the existing stored lookup. No unknown-scope fallthrough
  change; hash/scope validation stays the exact existing approve path, so a
  stored 202 replays during drain with same key/hash (no extra
  Turn/Run/Grant/events), same-key hash mismatch stays 409 with no writes,
  and fresh approvals during drain stay 503 without persisting.
- Regressions: `packages/kernel/test/proposal_idempotency_lookup.test.ts`
  (owned lookup found, foreign/missing 404, mismatch 409 with row counts
  unchanged) and
  `apps/server/test/proposal_approval_replay.test.ts` (real-SQLite Hono
  smoke: approve 202 -> GET lookup same 202 -> drain same-key replay same
  202 with 1 execution/grant -> fresh-key drain 503 with no persistence;
  plus same-key mismatch 409 with no extra rows). No mocked forwarding, no
  UI/browser needed for this path.
- Observed final-once verification (Linux, Node 24.12.0): focused
  `proposal_idempotency_lookup` 3/3, `proposal_approval_replay` +
  `proposals` 5/5, root `tsc --noEmit` exit 0. No push/comment/resolve;
  review thread IDs are for the parent to publish.

## PR20 T2 follow-up: draining stored-key mismatch replays 409 (2026-10-13)

Follow-up to the T2 section above (independent review
`ReviewReplayCompositionIdentity` on repair branch `99124aa`; ground truth
per task, not rerun pre-fix): `tryReplayStoredApprove`
(`apps/server/src/app.ts`) swallowed `IdempotencyConflictError` while
DRAINING, so a committed key retried with a different schema-valid
`proposalHash` returned 503 instead of the required 409
`idempotency_key_reused`.

- `apps/server/src/app.ts`: the draining approve replay now returns the
  existing `mapDomainError` for a stored-key permanent conflict
  (`IdempotencyConflictError` -> 409) and for session/proposal ownership
  drift (`RepositoryNotFoundError` -> 404). A fresh key (lookup miss, kernel
  never invoked, nothing persisted) and transient failures still fall
  through to the 503 drain rejection. No new approval scope.
- Regression: `apps/server/test/proposal_approval_replay.test.ts` gains a
  draining-mismatch case over real SQLite/Hono (approve 202 ->
  `markDraining` -> same-key different valid hash 409
  `idempotency_key_reused` with turns/runs/idempotency/executions/grants/
  events unchanged -> same-key same-hash replays the identical 202 with
  counts still unchanged).
- Actual-runtime proof: standalone Hono/SQLite smoke
  (`.review-plan-work/smoke-replay-shutdown.ts` via repo tsx, removed after
  this note; review JSON kept) 12/12 checks, incl. draining mismatch 409
  with row counts `turns=2 runs=2 api_idempotency=3 action_executions=1
  action_execution_grants=1 run_events=6` unchanged and the identical-202
  replay. Focused `proposal_approval_replay` 3/3 +
  `action_composition` 10/10 green, owned `biome check` on all touched
  files clean. No push/resolve; thread IDs are for the parent to publish.

## PR20 T5 calendar wrong-event get rejected, refresh closed (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYS6` (thread
`PRRT_kwDOUNdW7s6ryb6_`) on `feat/c12-calendar-snapshots`: a valid
`get-event` result from the selected calendar with an ID different from
`target.eventId` was accepted (normalization checked only the calendar
ID), so `reference.refresh` could materialize an unrelated event. Ground
truth per task (not rerun to reproduce the pre-fix acceptance).

- `packages/connector-calendar/src/adapter.ts`: `get` now compares the
  decoded opaque `canonicalKey` against the existing
  `normalize.canonicalKey(connectorInstanceId, target.calendarId,
  target.eventId)` helper (imported, no shim/new profile) and returns the
  fixed `calendar_response_invalid` on mismatch (no IDs/raw payload in the
  error). `normalizeGetResult` is unchanged, so strict
  structured-first/text-fallback decoding, malformed/upstream error codes,
  and matching-target behavior propagate exactly as before; no
  tombstone/user/account validation extras.
- Regression: `packages/connector-calendar/test/c12-smoke.test.ts` gains a
  genuine-SDK case (real `Server` + `InMemoryTransport` + `McpConnector` +
  broker over SQLite, deterministic zero-network fixture with a
  misdirect seam, no echo/mock forwarding): wrong-event `get` ->
  `calendar_response_invalid` with no provider ID in the error,
  structured-wrong vs text-matching still invalid, `reference.refresh` ->
  failed `calendar_response_invalid` with zero new
  resource/snapshot/rN/target/set/link rows, stored prior ref still opens
  with retained history, and a matching `get` still succeeds.
- Actual-runtime proof (throwaway script inside `.review-plan-work/`, run
  once via the repo tsx toolbin, removed after this note; 15/15 checks):
  wrong-event `get` fixed code, conflict still invalid, refresh failed
  closed with reference-table counts unchanged, prior open retained,
  matching `get`/`refresh` succeed; plus the still-pending T3/T4 standalone
  actual-`startServer` smoke (disabled injected owned port: `GET
  /health/ready` 200 then stop with 0 capability reads / 0 closes; enabled
  owned port: ready 200 then stop with exactly 1 close). Focused
  `c12-smoke` 10/10 + `normalize`/`deletion-boundary`/`calendar_tools`
  54/54, root `tsc --noEmit` exit 0, owned `biome check` clean. No
  push/resolve; thread IDs are for the parent to publish.

## PR20 T1 approval history owns its execution projection + reload dedup (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYSV` (thread
`PRRT_kwDOUNdW7s6ryb6i`) on `feat/c12-calendar-snapshots`: an approved
action ending failed/unknown/cancelled/abandoned created no
`turn_selections` row (completed-only by design), so history returned
`selectedRun: null` and the UI showed only the approval intent with no
receipt after reload.

- `packages/contracts/src/http.ts`: `ActionRunHistorySelectionSchema`
  now carries `runStatus` (required), `finishedAt` (nullable),
  `result` (nullable; present only for completed runs with persisted
  `result_json`), and `executionStatus` (nullable) alongside the existing
  `runId`/`attempt`/`receipt`. Non-completed terminals carry
  `result: null` with the actual receipt; active runs carry
  `receipt: null` with live statuses (frozen intent + progress, never a
  fake failure). `action_rejection` keeps `selectedRun: null` (kind is
  the discriminant).
- `packages/kernel/src/repository.ts`: `getHistory` projects approvals
  via `approvalRunProjection` keyed ONLY on owned execution identity
  (`action_executions.session_id` = history session AND
  `approval_turn_id` = this turn AND run `session_id`/`turn_id` match).
  Independent of `turn_selections` (which stays completed-only for the
  `user_text` path); a regular failed `user_text` turn stays
  `selectedRun: null`.
- `apps/server/src/ui/client.ts`: approval turns render the actual
  terminal receipt (incl. failed/unknown/cancelled/abandoned and
  recovered) or live `ACTION_PROGRESS_TEXT` for active approvals; every
  projected `runId` registers in `renderedAnswers` plus a
  `data-action-run` anchor so a captured-active reload never duplicates
  the terminal (`renderRunView`); result part TEXT is not re-rendered
  (only fresh rN citation buttons).
- Regression: `packages/kernel/test/action_history_receipt.test.ts`
  (real SQLite service lifecycle, no mocks/seeds/UI bypass): failed,
  unknown, pre-marker cancelled, recovered-abandoned pre/post-marker
  (receipt retained, non-null selection, `result: null`, zero
  `turn_selections` rows), blocked_stale/succeeded_unverified/verified
  (ID-free text, fresh rN, completed selection intact), regular failed
  `user_text` unselected.
- Actual-runtime proof: standalone Hono/SQLite history smoke
  (`.review-plan-work/smoke-history-t1t6.ts` via repo tsx, real TS APIs,
  HTTP approve + HTTP history) 53/53 checks incl. abandoned
  (`runStatus abandoned`, receipt `failed`, `result null`) and regular
  failed (`user_text`, `selectedRun null`); log
  `.review-plan-work/smoke-history-t1t6.log` (own log, removed after this
  note; review JSON kept). NEW browser cases only
  (`COMPANION_E2E_CALENDAR=1`, bounded): reload-after-unknown-terminal
  keeps the manual-check receipt with no extra write and no stop claim,
  2/2 passed; log `.review-plan-work/browser-t1t6.log` (own log, removed
  after this note). Focused `action_history_receipt` 9/9,
  `packages/kernel` `tsc --noEmit` exit 0, owned `biome check` on all
  touched files clean; broader types/units retained green per the prior
  session, not rerun. No push/resolve; thread IDs are for the parent to
  publish.

## PR20 T6 action rendered text carries no internal IDs (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYTF` (thread
`PRRT_kwDOUNdW7s6ryb7I`) on `feat/c12-calendar-snapshots`: completed
verified/unverified `RunResult` text embedded `calendar.reschedule` and
the raw proposal UUID, rendered verbatim in conversation history.

- `packages/kernel/src/action_executions.ts`: persisted completed
  results now render `${previewSummary} — ${safeOutcome}` (preview
  summary minus the `calendar.reschedule:` prefix, safe human outcome
  incl. manual-check guidance); stored `preview_json` contract
  unchanged; structured audit fields keep all IDs.
- `packages/kernel/src/action_strategy.ts`: the in-memory failed-run
  fallback renders the same ID-free preview + safe outcome (receipt
  outcome via the real view, never a fabricated success).
- `apps/server/src/ui/client.ts`: history receipt summaries strip the
  `calendar.reschedule:` prefix for display only (stored `summary_json`
  unchanged); visible history text never contains proposal/execution/run
  UUIDs or the tool name (IDs live only in structured fields/DOM
  metadata).
- Fixture wording pins deleted (behavior predicates only, e.g. outcome
  non-empty and stop-claim-free): `apps/server/test/action_ui.test.ts`,
  `packages/kernel/test/repository.test.ts`,
  `packages/kernel/test/structured_result.test.ts` (completed-selection
  type narrowing to the `user_text` variant).
- Actual-runtime proof: same 53/53 smoke (blocked/verified cases assert
  no tool name, no proposal/execution/run ID, V2 result with one fresh
  rN citation); NEW browser case only: completed verified history shows
  no internal IDs or tool name with the fresh citation surviving reload
  and write count unchanged, 2/2 passed with the T1 browser case above.
  Same focused/lint/type evidence as T1. No push/resolve; thread IDs are
  for the parent to publish.

## PR20 T1 follow-up: deduped active-approval terminal still hydrates (2026-10-13)

Fixes the T1 independent-review follow-up on `feat/c12-calendar-snapshots`:
T1 registers EVERY projected Action `runId` (incl. live
queued/preflight/executing progress) in `renderedAnswers`, so a reload
while the approval is active anchors the history — but the replayed
`run.completed` then hit the `renderRunView` answered-dedup early return
AFTER `finishActiveRun` and BEFORE the single-owner terminal hydration.
The approved proposal renders no card, so no execution watch drove the
update: visible progress stuck, terminal receipt/fresh rN missing.

- `apps/server/src/ui/client.ts`: the answered-dedup branch keeps the
  no-duplicate-answer guard but still claims `claimTerminalHydration`
  and runs `hydrateHistory` + `scheduleActionSync` (existing single-owner
  helper, no second watch/polling); already-hydrated terminals claim
  once, regular completed runs render unchanged. Failed/cancelled SSE
  branches additionally `scheduleActionSync` after hydration so live
  Action cards reach the same real terminal (retry append order kept).
- `apps/server/e2e/calendar/action.spec.ts`: the held post-marker
  reload case now asserts the REAL visible transition without a second
  reload — live progress after reload, verified receipt + fresh (non-r1)
  rN citation after release, exactly one history item/receipt/citation,
  no proposal/run UUID or tool name in visible text, composer released
  with no stop claim, exactly one write.
- Actual-runtime proof (`COMPANION_E2E_CALENDAR=1`, bounded): full
  `e2e/calendar/action.spec.ts` 13/13 passed (incl. the amended case);
  `apps/server` `tsc --noEmit` exit 0, e2e `tsc --noEmit` exit 0,
  `action_ui` 8/8, owned `biome check` clean. No push/resolve; thread
  IDs are for the parent to publish.

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

## PR20 integrated plan verification (2026-10-13, pr20-integrated-plan-verification)

FINAL integrated acceptance on HEAD `61b3573` (review6 threads fixed
plus the independent-review follow-ups `93f197f`/`72e5b37`/`61b3573`).
The C12–C22 gate (`814eac5`, 103 files / 1251 tests) predates the PR20
fixes, so the root full suite + both typechecks + lint below were run
ONCE against the new changes; the 13/13 browser action cases already
green at `61b3573` are confirmed by the T1 follow-up record above and
NOT rerun. Model kept as configured, no override. No new
features/tests/scaffolding, no live OAuth, no provider writes, no
adoption, no Remind work, no dependencies, no stack rewrite.

### Final checks (each run ONCE; Linux, Node 24.12.0, pnpm 11.25.0)

- `pnpm test` → exit 0, **106 test files passed, 1270 tests passed,
  0 failed / 0 skipped** (~12s).
- `pnpm typecheck` (root `tsconfig.json`) → exit 0, empty output.
- `pnpm typecheck:e2e` (`apps/server/tsconfig.e2e.json`) → exit 0,
  empty output.
- `pnpm lint` (`biome check .`) → exit 0 on the post-cleanup
  recheck (run ONCE after parsing and removing the own temporary
  `.review-plan-work/reviews-companion.json` /
  `.review-plan-work/reviews-fork.json` plus the now-empty
  `.review-plan-work/` directory): **219 files checked, 0 errors,
  1 pre-existing info** (deprecated `recommended` field in
  `biome.json`). Earlier exit-1 ground truth was exactly **2 format
  diagnostics on those two own-temp files only**; every
  product/source file was already clean. No ignore change, no
  reformat-suppress, no unrelated change.
- Browser: `apps/server/e2e/calendar/action.spec.ts` **13/13 passed at
  `61b3573`** per the T1 follow-up record above; confirmed only.

### §19 source-run acceptance (actual OPERATIONS CLI, own disposable tempstore)

First actual source-run of the documented §19.2/§19.5 path on this
branch (not a unit mock echo): real `pnpm start` cold starts, real
`GET /health/live` + `/health/ready`, real stopped-server
`pnpm --filter @companion/server backup`, real stopped-only manual
restore, real second cold start. Disposable store
`.review-plan-work/source-run-smoke/store/` only (removed after
evidence; review JSON kept). Environment was explicit and
credential-stripped: `COMPANION_DB_PATH` = own store path,
`COMPANION_HOST=127.0.0.1`, `COMPANION_PORT=44831` (probed free),
`COMPANION_TIME_ZONE=UTC`, `COMPANION_LOG_LEVEL=info`, plus inherited
`PATH`/`HOME` only; `COMPANION_MODEL_JSON` / `COMPANION_CALENDAR_JSON`
/ `COMPANION_MARKDOWN_ROOTS_JSON` / `COMPANION_ACTIONS_JSON` all unset
(verified absent beforehand), no Calendar/model config, no
Google/OAuth, no non-loopback network. No port/host value assumed from
outside: host/port came from the explicit env above against the
`config.ts` contract (loopback-only `127.0.0.1`, DB symlink guards).

- Cold start 1 (`pnpm start`): `server.starting port 44831`,
  `server.migrated status 7`, `server.recovered status 0`,
  `server.listening port 44831`. `GET /health/live` → 200
  `{"status":"live"}` (1/1). `GET /health/ready` → 200
  `{"status":"ready"}` (1/1). Marker session
  `POST /api/sessions` (fresh `Idempotency-Key`) → 201, id
  `d4685063-3e95-484f-ac57-b4c04c274161` (1/1).
- Stop 1: SIGTERM to the node server process → `server.draining
  status sigterm` → `server.stopped status sigterm`; port 44831
  closed, no server process left (2/2 stops clean in this smoke).
  Operational note: the signal must reach the node process — killing
  the `pnpm`/`sh` wrapper alone leaves the listener up (observed once,
  then corrected; no product change).
- Manual backup (stopped server, documented command
  `pnpm --filter @companion/server backup`): exit 0, stdout basename
  only `companion-manual-20261013T114053Z-87b91b9a-7d33-4342-b24e-0fd5363f0324.sqlite`
  (1/1, exact `companion-manual-<UTC>-<uuid>.sqlite` shape). Store and
  `backups/` dirs `0700`, backup file `0600` (3/3). `PRAGMA
  quick_check` of the backup copy → `ok` (1/1). Observation (product
  behavior unchanged): the run leaves
  `companion-manual-….sqlite.partial-shm` / `.partial-wal` residue in
  `backups/`; the CLI contract (basename-only stdout, fixed safe
  errors, stopped-only, no path flags) held.
- Stopped-only manual restore (documented exact sequence, with loss):
  (1) server stopped; (2) current db preserved aside (331776 B; the
  `-wal`/`-shm` sidecars were already checkpointed away by the clean
  drain); (3) live db removed to simulate loss; (4) verified backup
  copied to `restore.tmp.sqlite` next to the DB; (5) `PRAGMA
  quick_check` of the temp copy → `ok`; (6) atomic same-dir rename
  onto the DB path (mode `0600`); (7) no stale `-wal`/`-shm`
  while still stopped. (7/7 steps as documented.)
- Cold start 2 on the restored store: `server.migrated status 7`
  (no-op), `server.recovered status 0`, `server.listening port
  44831`; `GET /health/ready` → 200 `{"status":"ready"}` (2/2 across
  starts), `GET /health/live` → 200 (2/2). Marker session
  `GET /api/sessions/<id>/active-run` → 200 `{"run":null}` (data
  survived the loss+restore; not a fresh DB), unknown session id →
  404 (no false positive).
- Stop 2: draining → stopped, port closed. Own runtime files
  (smoke store, preserved copy, server logs, capture files) removed
  after this evidence; `.review-plan-work/reviews-*.json` parsed for
  publication data, then removed (publication step).

Smoke counters: cold starts 2/2 ready, health live 2/2, health ready
2/2, marker sessions created 1/1, backups 1/1 (basename + 0600 +
quick_check), restores 1/1 (7/7 documented steps), post-restore data
proofs 2/2, clean stops 2/2.

### Plan residual map (C01–C22 fake implementation/review proof vs formal release gates)

Nothing below closes a formal gate or authorizes an unapproved
decision. "IMPLEMENTED" means consumer/fake-harness implementation
with review proof; formal release gates stay explicit.

| item | status | boundary |
| --- | --- | --- |
| C01–C07 milestones / browser resilience / aggregate CI | HISTORICAL EVIDENCE (see README + C07) | 23/23 browser CI aggregate pinned to `56b7952a`; not re-asserted for this HEAD. |
| C08 upstream adoption | **HOLD / NOT ADOPTED** | No adopted binding, pin, profile, or registration anywhere in this branch. |
| C09 MCP library policy | IMPLEMENTED (library) / server enablement HOLD | Mandatory host definitions, read-only lattice, stdio/HTTP bounds proven by review smokes; production registration absent. |
| C10 consumer normalization | IMPLEMENTED / C10-08 production mapping **UNRESOLVED** | Whole-second-regex vs fractional-ISO gap persists as an adoption hold. |
| C11 deletion boundary | IMPLEMENTED (consumer negatives) / C11-01 **BLOCKED** | Cancelled / bare 404-410 / thrown RPC / search omission are never positive evidence; actual upstream HTTP status UNKNOWN. |
| C12–C16 pipeline / broker / config / fake E2E | IMPLEMENTED (consumer/fake) | Real-SDK + fake-harness proofs only; adoption HOLD. |
| C17–C20 engine / M2 / UI slices | IMPLEMENTED | Covered by the 106-file / 1270-test battery above. |
| C21 M5 Action composition | IMPLEMENTED (triple gate) | Config hints + dedicated write port + exact-instance match; disabled gate refuses staging / 409-before-repository. **No production write binding selected; dedicated write binding / adoption + triple-gate live use NOT authorized.** |
| C22 action lifecycle E2E | IMPLEMENTED (fake) | Fake seams + real chromium (13/13 at `61b3573`, confirmed not rerun); not live. |
| Windows 11 x64 manual smoke | **NOT EXECUTED** | Linux-only evidence here; §19.6 support gate stays open. |
| Fresh OAuth | **SEPARATE DECISION, untouched** | No flow, token, or status read here (`No authstatus/login/tokenread`). |
| Remind I01–I05 | **UNAPPROVED, untouched** | Other repo; no C23/C24 invented, nothing solved here. Superseded 2026-10-18 (status sync with docs/plan/active_projects_tasks.md:17, I05 現況): I02/I03 adapter + 二パス implemented with unit regressions; I05-equivalent live smoke (real Companion HTTP + synthetic gateway + REAL remind CLI tempDB) completed 2026-10-15. I01/I04 formal adoption decision, Windows manual smoke, current-HEAD CI remain open; perception/export/deletion not implemented. Superseded 2026-10-18 (implementation): I01/I04 adopted and implemented (remind #15/#16/#19/#20/#21/#22, companion #55/#57/#58/#59/#60; #61/#62 open); privacy F-I01-05 implemented; perception/export/deletion still not implemented. |
| Candidate PR21/22 | **STACKED REVIEW ONLY** | PR20 baseline pins have known gaps; the newest candidate is NOT claimed as the current binding. |

§20 write-binding source facts (parent-read, directly relevant to the
residual gate design only — SOURCE facts, not actual Google provider
proof; no write binding implemented/adopted, no extra docs/spike
tests created): fork `6939311` `UpdateEventHandler` is
dormant/unregistered; it performs `getCalendarTimezone` /
`detectEventType` plus broad-field and recurring-split paths; its
`events.patch` calls lack `If-Match`; no approved narrow reschedule
port exists. Google version-resources semantics: setting `If-Match`
against a concurrent revision rejects with `412`. Gate-design
consequence (still unapproved): any future narrow reschedule port
must carry the exact revision in `If-Match` and treat `412` as the
concurrency signal — recorded here only so the residual gate is
designed against the source truth.

Reachable-work check: every §19 agreed item reachable locally
(source-run, backup/restore/health exact paths, full suite +
typechecks) is observed above; all unapproved decisions (OAuth,
adoption, write binding, Remind, Windows manual, C23/C24) are
untouched. The authoritative `active_projects_plan.md` of the
external parent repo was not copied or created (not present in this
worktree); plan execution is recorded in the existing docs only
(operations here + README progress section).

Scaffolds: `.review-plan-work/source-run-smoke/` removed after
evidence; `.review-plan-work/reviews-*.json` parsed for publication
data, then removed with the now-empty `.review-plan-work/` directory
(publication cleanup; post-cleanup `pnpm lint` exit 0, 219 files,
0 errors, 1 pre-existing info — see above); no `test-results/`, `.verification-log/`, `.final-gate-tmp/`, or
`.review-proof/` residue; no test file touched by the lint ground
truth above.
## resume-calendar-default (2026-10-13)

Recovered checkpoint (observed, not asserted from docs): branch
`feat/calendar-readonly-production-profile`, HEAD `f23e245`
(`docs(operations, readme): fail-fast subshell fork-install guard …`),
`git status --short` empty (clean tree). This branch is the
google-readonly profile line stacked on the PR20 base: 7 commits since
`origin/feat/c12-calendar-snapshots` (`b2deab7` profile composition,
`094bc23` smoke evidence, `3a0d3de` CLI proof, `2b96350`/`202b476`
profile-freeze fixes, `932a811`/`f23e245` setup-accuracy docs). The
C24/C22 material above is history from the base line, not this
branch's scope.

Stale-claim supersession (no history rewrite): the C13 subsection's
"whole C13–C15 verification pass is deliberately deferred … ADDED, NOT
YET RUN" and the C14 subsection's matching "ADDED, NOT YET RUN" lines
are superseded. The deferred suites they name
(`packages/kernel/test/calendar_tools.test.ts` C13-01..07 exposure/
budget/dedup/Retry/cross-source cases;
`apps/server/test/config.test.ts` + `apps/server/test/bootstrap.test.ts`
C14 opt-in/preflight/lifecycle cases) were executed by the later
observed batteries on the base line: C12–C22 final integration
(`52d61ba`: 103 files / 1251 tests, both typechecks exit 0) and the
PR20 integrated verification (`61b3573`: 106 files / 1270 tests, both
typechecks exit 0, lint 219 files 0 errors / 1 pre-existing info).
Profile-branch additions (`calendarReadonlyProfile.test.ts`, 16 cases;
`calendarReadonlyProfile.ts` freeze-before-first-await) are covered by
this worker's final battery on this branch (observed once, Linux, Node
24.12.0, after the docs edit above — no code changed since): `pnpm
test` exit 0, **107 files / 1286 tests passed** (+1 file / +16 tests
vs the PR20 106/1270 baseline, exactly the profile suite); root
`pnpm run typecheck` exit 0; `pnpm run typecheck:e2e` exit 0; `pnpm
run lint` exit 0 (**223 files, 0 errors, 1 pre-existing
`biome.json` recommended-deprecation info**). No browser rerun for
this docs-only slice (both browser suites already green above).

Fresh credential-free harness evidence (this worker, Linux, Node
24.12.0, installed Playwright 1.63.0 CLI direct, no pnpm exec, no
OAuth, no live Google, no secrets — fake MCP over real SDK
InMemoryTransport + scripted fake model + real UI/API, temp SQLite
under owned `/tmp/opencode/calendar-resume-XFncqG`, traces on):

- Default browser suite: **23/23 passed** (conversation 4,
  citation_recovery 3, polling 4, sse_history 12 incl. 2 generated
  corrupt-cursor cases; ~1.3m). Confirms the base-line browser
  behavior unchanged on this branch.
- Calendar-mode suite (`COMPANION_E2E_CALENDAR=1`): **18/18 passed,
  0 unexpected / 0 flaky / 0 skipped** (JSON stats duration
  ~45.8s): `action.spec.ts` 13/13 (approve/reject/assent/stale/
  deleted/read-back/unknown/Stop-before/Stop-after/T1-reload/
  T6-IDs/held-reload/late-cancel), `calendar.spec.ts` 4/4
  (search→rN→open, reload, refresh V1→V2, tombstone-keeps-open),
  `tombstone.spec.ts` 1/1 (positive authoritative deleted rN, prior
  rN retained). JSON stats `expected:18`.
- Post-run `ss` on 4173/4174/4175: no listeners (both runs).
- Pinned-profile proof artifacts retained and accurate (runtime-side
  only, no source-SHA re-verification, no live claims):
  `docs/evidence/calendar-readonly-profile/smoke-profile.result.json`
  (22/22) and `cli-profile.result.json` (actual `pnpm start`
  missing-credential acceptance; CORRECTED 2026-10-14: reran full
  acceptance with valid local account `normal`, 12/12 — the prior
  `me@example.com` env is rejected by the profile account grammar
  `^[a-z0-9_-]{1,64}$`, so it could not have produced a cold start).

Branch-status note (CURRENT, supersedes the base-line residual table's
"no profile anywhere in this branch" row for THIS branch only): the
host-owned pinned `google-readonly` profile IS adopted here as normal-
startup composition (exact pin/commit/tree/lock/wire-hashes in the C14
profile subsection above). Authenticated live reads are OBSERVED (user
OAuth COMPLETED; see "Live readonly acceptance ledger"): only fresh
consent-screen scope display, live production/C11-01 (BLOCKED), and
manual Windows 11 smoke remain open external gates and are untouched
by this worker.

## PR23 final proof (2026-10-13, observed)

Focused verification only (no production change in this pass; no
browser or full-suite claim). Linux, Node 24.12.0, pnpm 11.25.0:

- `pnpm vitest run apps/server/test/calendarReadonlyProfile.test.ts
  apps/server/test/bootstrap.test.ts apps/server/test/config.test.ts`
  -> exit 0, **3 files / 78 tests passed** (profile 25, bootstrap 28,
  config 25), 0 failed.
- `pnpm run typecheck` -> exit 0; `pnpm run typecheck:e2e` -> exit 0.
- `pnpm run lint` -> exit 0, **224 files, 0 errors**, 1 pre-existing
  `biome.json` recommended-deprecation info.
- Independent throwaway credential-free smoke (tsx, removed after the
  run; no OAuth, no live Google, no secrets): invalid profile AND
  invalid account each create **no DB file and no parent dir**;
  generic `calendar-mcp` and profile `calendar-mcp-google-readonly`
  rows get **distinct instance IDs**; **restart reuses the profile ID**
  (still 2 rows); old generic target refresh through the new provider
  fails `reference_not_found` with **0 `get` calls**.
- Retained: `docs/evidence/calendar-readonly-profile/
  pr23-final-proof.result.json` (focused commands + concise smoke JSON
  + historical_reference; CORRECTED 2026-10-14: full `pnpm test` and both
  Playwright suites were never run in this focused pass, so they are
  recorded only as historical references to the resume-calendar-default
  battery above, not as PR23 results).
  Prior `smoke-profile.result.json` (22/22) unchanged;
   `cli-profile.result.json` corrected separately (valid account
  `normal` rerun, see resume note above).

## C22 approval-card target preview + bounded pending expiry (2026-10-13, observed)

Stacked on PR23 (`feat/calendar-readonly-production-profile`); no
OAuth/provider writes, no schema/policy expansion, no persisted-proposal
mutation, no mocked UI/seeded proposals in E2E.

- `packages/kernel/src/action_proposals.ts`: `loadTarget` now reads
  `sr.ordinal`; `freshSnapshotRevision` also returns the immutable
  normalized event title; the staged preview is a deterministic human
  summary `{title} (rN): start= end=` (title NFC/trimmed/whitespace-
  collapsed/128-code-point cap, blank falls back to `calendar event`).
  No tool-name prefix, no UUID/provider IDs, no upstream reads; the
  `{ summary }` seam, hash coverage, and DDL are unchanged. The legacy
  `calendar.reschedule:` display-prefix strips (execution/history
  rendering) stay as backward-compatible no-ops.
- `packages/kernel/test/action_proposals.test.ts`: the wording-pinning
  preview assertion is deleted; semantic cases assert target (title +
  current rN, incl. r2 after a retitling observation), deterministic
  hash, single-line plaintext, and privacy (no description/IDs).
- `apps/server/src/ui/client.ts`: each pending card owns at most one
  bounded one-shot expiry timer (identity-checked on fire, cleared on
  removal/decision); execution-owned/receipt/awaiting cards are never
  retired by an old timer. `syncActions` retires only still-local
  pending cards and never downgrades decision-in-flight; approve/reject
  recheck the local deadline, guard while the real POST is awaited, and
  the server stays authoritative. `visibilitychange` reconciles locally
  with no polling/provider calls.
- `apps/server/e2e/calendar/action.spec.ts` (+4, clock installed
  BEFORE goto): staged preview shows `E2E Standup` + r1 with no
  `calendar.reschedule`; `pauseAt(deadline-1)` keeps controls enabled
  and `fastForward(1)` retires the card with 0 writes; `setSystemTime`
  (no timer fire) + real `visibilitychange` retires with 0 writes;
  gated real approve-202 fulfilled across the old deadline keeps the
  live execution card, release lands the verified receipt (1 write).

Final battery (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm test` -> exit 0, **107 files / 1296 tests passed**, 0 failed.
- `pnpm run typecheck`, `pnpm run typecheck:e2e`,
  `pnpm --filter @companion/server typecheck` -> exit 0.
- `pnpm run lint` -> exit 0 (**224 files, 0 errors**, 1 pre-existing
  `biome.json` recommended-deprecation info).
- Default browser suite (Chromium): **23/23 passed**.
- Calendar-mode suite (`COMPANION_E2E_CALENDAR=1`, Chromium):
  **22/22 passed** (`action.spec.ts` 17/17 incl. the 4 new cases,
  `calendar.spec.ts` 4/4, `tombstone.spec.ts` 1/1).

## C22 independent-review lifecycle fixes (2026-10-13, observed)

Followup on the same PR24 branch (`fix/c22-approval-card-target-expiry`);
review observations taken as ground truth, no failing-before rerun. No
mocked cards, DB seeding, new polling, or live provider/OAuth.

- `apps/server/src/ui/client.ts` `reject()`: the real reject POST is now
  `try/catch`. A transport abort before the server sees it releases
  `deciding`, shows the fixed retry notice
  (`却下できませんでした。もう一度お試しください`), and reconciles via
  the real proposals read: still-pending restores buttons/deadline, an
  accepted rejection retires on the real summary. Nothing is claimed
  rejected.
- `apps/server/src/ui/client.ts` `syncExecution()`: an authoritative
  non-pending summary takes card ownership BEFORE the execution GET
  (status transfer, `deciding=false`, pending timer cleared). Approved
  renders disabled decisions (known run preserved) and arms the EXISTING
  bounded execution watch for recovery when the GET resumes — no new
  polling. Rejected/expired retire on the real summary (pre-GET and
  post-GET paths) with history hydration; approved/terminal receipts keep
  their existing lifecycle.
- `apps/server/e2e/calendar/action.spec.ts` (+2, real UI/API only):
  abort-first-reject recovers pending controls then the real reject lands
  rejection history with 0 writes; real approve `route.fetch` + abort
  delivery with execution-GET failed keeps the server-accepted card
  (`approved`, controls disabled) across the original deadline, then
  resume + preflight release verifies the real receipt with exactly
  1 write.

Verification (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm vitest run apps/server/test/action_ui.test.ts` -> exit 0,
  **8/8 passed**.
- `pnpm run typecheck`, `pnpm run typecheck:e2e` -> exit 0.
- `pnpm run lint` -> exit 0 (**224 files**, 1 pre-existing
  `biome.json` recommended-deprecation info).
- Calendar action suite (Chromium, `COMPANION_E2E_CALENDAR=1`):
  **19/19 passed** (`action.spec.ts` 17 existing + 2 new, ~48s).
  No default-browser or full-1296 rerun (unchanged paths).
- PR23/PR24 CI at push time: all checks SUCCESS (PR24 6/6 incl. e2e;
  PR23 6/6); no failed logs to repair.

## C22 clock-skew pending-expiry rearm (2026-10-13, observed)

Followup on the same PR24 branch (`fix/c22-approval-card-target-expiry`);
independent-reviewer defect taken as ground truth, no before-fix rerun. No
polling, provider/network, or authority change.

- `apps/server/src/ui/client.ts` `schedulePendingExpiry()`: the capped
  one-shot callback now calls `this.schedulePendingExpiry(current)` before
  the `Date.now() < deadline` early return. A client wall clock >15min
  behind the server (or rolled back after arming) no longer consumes the
  only timer forever: the single bounded timer re-arms for the remainder
  (still 1 timer, still 15min cap). Existing identity, accepted/decision,
  and execution/terminal guards are unchanged; the server stays
  authoritative.
- `apps/server/e2e/calendar/action.spec.ts` (+1, real proposal + client
  clock only): fake clock installed before goto, client set 20min behind
  before the real staged proposal, first capped 15min `fastForward` keeps
  the pending card with live controls, then advancing the actual remaining
  `expiresAt` retires the card with 0 writes and no
  visibility/network refresh. Real `expiresAt`, no DB mutation.

Verification (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm run typecheck`, `pnpm run typecheck:e2e` -> exit 0.
- `pnpm exec biome check` on the owned files -> exit 0.
- Calendar action suite (Chromium, `COMPANION_E2E_CALENDAR=1`,
  `action.spec.ts` only): **20/20 passed** (~48s). No
  default-browser or full-suite rerun (unchanged paths).

## C22 preview-ambiguity + CI failure followup (2026-10-13, observed)

Followup on the same PR24 branch (`fix/c22-approval-card-target-expiry`);
the new GitHub review thread (title ambiguity) and the two CI e2e failures
on head `e4f6bf1` (PR run 38449588750: `action.spec.ts:841` lost-approve +
`calendar.spec.ts:80` date assertion; push run 38449579628 SUCCESS) taken
as ground truth, no failing-check rerun. No seeded proposals, fake HTTP
success, wording pins, timeout/skip/retry changes, or provider/normalizer
changes.

- Kernel preview (`packages/kernel/src/action_proposals.ts`
  `buildPreview`): new immutable previews now open with the unambiguous
  human marker `対象イベント: <whole title> (rN): start=… end=…`. An
  arbitrary normalized title beginning with `calendar.reschedule:` can no
  longer sit at position 0, so the legacy tool-prefix strips in
  `action_strategy.readRenderedPreviewForRun`,
  `action_executions.renderedPreviewSummary`, and the client history
  renderer never cut the real title. Reader logic is unchanged and still
  renders historical (`calendar.reschedule: …`) stored previews correctly;
  only their comments plus the stale client "staged preview carries the
  tool prefix" claim were corrected.
- `apps/server/src/ui/client.ts` `approve()`: a POST transport failure now
  awaits `reconcileLostApprove()` with `deciding` held (timer + stale lists
  cannot retire/downgrade the card mid-reconcile). A server-approved summary
  takes approved ownership immediately (timer cleared, decisions disabled,
  existing bounded watch started); still-pending re-renders controls with a
  re-armed bounded timer; unreadable falls back to sync. Root cause of the
  CI `action.spec.ts:841` failure: the fire-and-forget recovery sync could
  be deduped while an older sync held a stale pending view, leaving a
  server-approved card on its live expiry timer until `fastForward` retired
  it (card gone at line 877). The same stale approved run (read barrier
  never released) leaked into `calendar.spec.ts:80`: the next test's
  `/reset` released the barrier, the orphan run's write landed 11:00/12:00
  upstream mid-search, and the drawer showed the overwritten boundaries
  instead of the fixture 09:00. Both failures share this single root cause;
  no harness/test change was needed beyond the client fix.
- E2E seam (`mcpFake.ts` `titleOverride` + `POST /set-title`, cleared by
  `/reset`): `action.spec.ts` (+1, real
  search/select/stage/approve/reload flow, exactly 1 write) freezes the
  real title `calendar.reschedule: quarterly planning` and asserts it
  survives the initial card, the execution receipt, and the reloaded
  durable history in full.
- Kernel regressions (no wording pins): `action_proposals.test.ts` stages
  the adversarial title (marker prefix, full title, current rN, single
  line, ≤1024 chars, never at position 0); `action_executions.test.ts`
  drives a stored new-format preview through the real `blocked_stale`
  terminal and asserts the RunResult text keeps the whole title while the
  receipt `summary_json` is byte-preserved.

Verification (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm test` -> exit 0, **107 files / 1298 tests passed** (+2 new), 0 failed.
- `pnpm run typecheck`, `pnpm run typecheck:e2e`,
  `pnpm --filter @companion/server typecheck`, root `tsc --noEmit` ->
  exit 0.
- `pnpm run lint` -> exit 0 (**224 files, 0 errors**, 1 pre-existing
  `biome.json` recommended-deprecation info).
- Default browser suite (Chromium): **23/23 passed**.
- Calendar-mode suite (`COMPANION_E2E_CALENDAR=1`, Chromium):
  **26/26 passed** (`action.spec.ts` 21/21 incl. the new title case,
  `calendar.spec.ts` 4/4, `tombstone.spec.ts` 1/1), plus a second
  consecutive 26/26 run.

## C22 delivery-vs-gate (2026-10-14, delivery/c22-approval-flow)

DELIVERED consumer code (this branch, fake transport only): target-aware
frozen preview (title + session rN), bounded one-shot pending expiry with
skew rearm + visibility reconcile, approve/reject error recovery with
authoritative lost-approve reconcile, kernel + E2E regressions above.
Production binding stays read-only (exact 3 tools); no write API invented.

EXTERNALLY GATED (not code, needs upstream decision/proof): write-capable
provider pin + tool-schema/API choice + OAuth scope selection, positive
deletion contract adoption, fresh OAuth/live/manual verification. No
guessed deletion positives or write capability claimed.

## M5 decision-turn retry denial (2026-10-14)

Fixes the §18 review finding on `origin/master` (`2474572`):
`repository.postRetry` accepted `action_approval` / `action_rejection`
Turns and queued a generic Run for them. A rejection Turn owns no Run
and an approval Turn owns its Action Run, so the generic generation
retry could duplicate or fabricate an external write; a terminal
(failed/unknown/abandoned/cancelled) Action must never be re-executed
through it. Pre-fix ground truth (throwaway repo/API smoke over real
SQLite, removed after this note): retry on a rejection Turn was
ACCEPTED (`202`, new queued generic Run), and retry on an approval Turn
failed only by accident of `UNIQUE(turn_id, attempt)` surfacing as a
misleading `409 session_busy`.

Fixed externally visible contract: the generic retry
(`POST /api/sessions/:sessionId/turns/:turnId/retries`) is
**user_text-only**. A decision Turn is rejected with the existing fixed
`400 validation_error` (`request validation failed`) with no new Run,
no events, no execution/grant change, no allocator bump, and no
idempotency persistence (a second key is denied identically; a stored
pre-fix success never replays). Ordinary failed/abandoned `user_text`
retry is unchanged (still `202`, same Turn, new queued Run).

- `packages/kernel/src/repository.ts`: `postRetry` parses the owned
  Turn's immutable `input_json` immediately after the session/turn
  ownership check and throws the existing `RepositoryValidationError`
  for any non-`user_text` kind — before the idempotency lookup, the
  busy admission, the `next_run_attempt` CAS, and every insert. Both
  `app.ts` call sites (live route + draining replay) inherit the denial
  through the existing `validation_error` mapping; no new error code,
  schema, or shim.
- `packages/contracts/src/http.ts`: `PostRetryRequest` doc states the
  exact user_text-only policy (schema unchanged).
- `apps/server/src/ui/reducer.ts` + `apps/server/src/ui/client.ts`:
  pure `isRetryableTurnKind` policy (unknown kinds fail closed) plus a
  client Turn-kind map hydrated from the ACTUAL history projection (and
  seeded `user_text` for fresh sends/retries). The failure-only retry
  control is appended only for `user_text` Turns and `retry()` refuses a
  known decision Turn locally with the same fixed notice; reloaded
  action results already render no control (`buildTurn` early return)
  and are unchanged.
- Regressions: `apps/server/test/proposals.test.ts` gains the
  decision-turn denial battery over real SQLite/Hono (approval retry
  400 while queued AND after terminal pre-marker cancel with
  turns/runs/events/executions/grants/idempotency unchanged + approval
  projection intact; rejection retry 400 twice with counts unchanged +
  single rejection Turn + null execution; `user_text` retry still 202
  with one new queued Run); `apps/server/test/action_ui.test.ts` pins
  `isRetryableTurnKind` (`user_text` only, both decision kinds and
  unknown inputs denied).
- Observed final-once verification (Linux, Node 24.12.0): focused
  `proposals` 6/6 + `action_ui` 9/9 green; root `tsc --noEmit` exit 0;
  real-chromium browser proof on the production UI bundle via the
  existing Calendar fake harness (throwaway spec, removed after this
  note) 2/2 — rejection retry 400 twice with 0 writes and no retry
  control before/after reload, unknown-approval retry 400 with exactly
  1 write and no retry control before/after reload; existing M3
  `failure surfaces a retry that succeeds` 1/1 (ordinary text retry
  preserved in the real browser). Throwaway smokes/specs and
   `test-results/` removed; no `pnpm` dependency change (offline
   store-link install only).

## M5 action evidence navigation (BEFORE/AFTER stored-only, 2026-10-16, observed)

Action result/receipt history and the live card carry distinct evidence
buttons: BEFORE (the ORIGINAL staged snapshot) is display metadata resolved
from the owning proposal's immutable `target_ref_id` plus session ownership
(the staged source reference's `rN` ordinal) and rides both the
server-owned execution view (`GET .../proposals/:id/execution`
`targetCitation`) and the action history projection (`selectedRun`
`targetCitation`); AFTER (the verified new snapshot) comes ONLY from the
authoritative `run.result` via `runResultToAnswerParts` when the receipt
outcome is exactly `succeeded` with actual result citations. Every other
outcome (`unknown` / `succeeded_unverified` / `failed` / `blocked_stale` /
live `null`) yields BEFORE alone — a `succeeded_unverified` V1 text result
(which by construction carries no structured citations, and even a result
that happened to carry preflight citations) is never presented as verified
AFTER. Opening either button reuses the existing stored-only citation
drawer (exact stored `SnapshotBody` text, `textContent` only): no
Google/upstream GET/PATCH after opening, no automatic refresh/retry, no
`rN` derived from preview prose or the current latest resource. History
reload retains both buttons; one Run never renders four evidence buttons
(card BEFORE at most one + history BEFORE/AFTER). No durable receipt /
`RunResult` / grant / proposal-hash / DB-schema change: the label is
metadata on the existing safe execution and history views (no N+1, no
async stale races); old proposals resolve without rewriting hash/preview/
snapshot, and non-action `user_text` history omits the field entirely.

- Contracts/kernel (`packages/contracts/src/action.ts`,
  `packages/contracts/src/http.ts`, `packages/kernel/src/repository.ts`):
  `ActionTargetCitationSchema` (`rN`) + required `targetCitation` on
  `ProposalExecutionView` and `ActionRunHistorySelection` (`user_text`
  omits it); `targetCitationForProposal` resolves the owned ordinal and
  fails closed cross-session (no citation info leaked).
- Client (`apps/server/src/ui/reducer.ts` pure `actionEvidenceButtons`
  + `apps/server/src/ui/client.ts`): card renders stored BEFORE only;
  history renders BEFORE plus verified AFTER only; both open via the
  existing `openCitation` stored path.
- Observed final verification (Linux, Node 24.12.0, this worktree):
  kernel `action_evidence_navigation` 9/9 (real SQLite service lifecycle:
  pending/live/failed/unknown/unverified/blocked keep BEFORE alone,
  verified succeeded keeps BEFORE + distinct fresh AFTER, wrong-session
  fails closed, `user_text` omits the field); server `proposals` 9/9
  (execution BEFORE for pending/approved + foreign 404 with no evidence,
  history live BEFORE-only, history verified BEFORE + fresh AFTER,
  history unverified BEFORE + citation-less V1, cross-session history
  leaks nothing) + `action_ui` 13/13 (pure BEFORE/AFTER policy);
  `tsc --noEmit` exit 0 (server/kernel/contracts); owned `biome check`
  clean on touched files (one pre-existing `useLiteralKeys` in untouched
  memory code left as-is). Real-Chromium browser proof via the existing
  Calendar fake harness (`apps/server/e2e/calendar/evidence.spec.ts`,
  kept) 2/2: verified run shows BEFORE r1 + distinct AFTER, both open
  the EXACT different stored bodies (09:00 vs 11:00), fixture counters
  (`searchCalls`/`listCalls`/`getCalls`/`writeCalls`) byte-identical
  across both opens and across reload (exactly 1 write total, 0 extra
  upstream GET/PATCH); unverified run shows BEFORE alone with the real
  manual-check outcome, 0 AFTER/citation nodes, stored original opens
  with identical counters, reload retains BEFORE-only with 0 extra
  writes. `test-results/` removed; no dependency change.

## Live readonly acceptance ledger (2026-10-14, current profile)

Current accepted activation: the host-owned pinned profile
`google-readonly` as the normal-startup composition (parent-verified
merged provenance: original-stack PR23
(`https://github.com/suiso11/companion_harness/pull/23`, head
`9e9bb94`) + PR24 merged, carried into main by merged DELIVERY
successors PR27 (`https://github.com/suiso11/companion_harness/pull/27`)
and PR28 (`https://github.com/suiso11/companion_harness/pull/28`);
PR27/28 preserved, not erased). C22 flow via PR28. Profile-adopted is the
acceptance baseline below; it does not close the residual gates listed at
the end. No code changed in this pass; prior uncommitted
`run-google-readonly.sh` launcher notes above are preserved as-is.

- Pin / schema mapping (verified this worker from actual candidate source
  and the current adapter; no secrets read, no live mutation):
  `suiso11/google-calendar-mcp` commit
  `6939311fd3eae9846648e0a175e304c9500f578e`, package
  `@cocal/google-calendar-mcp@3.0.0-readonly.2`, wire identity
  `{name:"google-calendar", version:"3.0.0-readonly.2"}`, scope
  `calendar.events.readonly` only, exactly the 3 live-wire hashes
  (`81222b89…`, `d48ba36e…`, `8c6736e2…`) matching
  `apps/server/src/calendarReadonlyProfile.ts`. `list-calendars` is
  absent by design (denied, never registered). Deletion-positive was not
  fabricated: 404/410/`cancelled`/omission remain errors/unknown and
  C11-01 stays BLOCKED.
- Proposal-era seven rows
  (`docs/google_calendar_readonly_binding_design.md` §4, current
  `readonly.2` deliberately removes the `list-calendars`/`calendarlist`
  scope — not restored to satisfy the old checklist):
  1) consent scope display — static pin ACCEPTED (events.readonly only,
  exact-grant validator); fresh consent-screen re-observation NOT claimed
  (live run reused the existing authorized grant, no new consent);
  2) `list-calendars` ok — INTENTIONALLY UNAVAILABLE (removed in
  readonly.2); 3) `list-events` one page + `nextPageToken` round-trip —
  ACCEPTED (one-page verbatim opaque cursor); 4) `search-events` q+window
  — ACCEPTED (live `calendar.search` succeeded/accepted);
  5) `get-event` 404 path — PARTIAL (miss maps to fixed
  `calendar_upstream_error`, never a tombstone; positive stays BLOCKED);
  6) write tool absent — ACCEPTED (events-only 3-tool surface, actions
  disabled); 7) stderr/log no tokens — ACCEPTED by construction (fixed
  codes + scalar ids only, no secrets persisted).
- Harness conversation / refresh: a live read-only conversation completed
  end to end (`run.completed`, one `calendar.search` succeeded/accepted,
  one `reference.presented` with snippet grant `[r1]` cited, turn
  selected; see the durable-run paragraph above). Live
  `reference.refresh` OBSERVED 2026-10-14 via a throwaway owned-temp
  SQLite proof against the real pinned google-readonly pipeline (fixed
  counting wrapper preserves the full call interface; no production
  gate/code change): list 10 hits (`list-events` x1, opaque cursor
  present), query mapping (`search-events` x1), stored-only open 0 new
  wire calls with non-empty body, explicit refresh via `get-event` x1
  only with a new snapshot (10->11) and new rN (refs +1, revision
  unchanged), prior rN re-openable with 0 new wire calls
  (`deduplicated`), fresh snapshot body keys `[text, version]` with 0
  excluded privacy keys, 3 distinct upstream tools / 3 total wire calls,
  second page `succeeded` (1 hit), `proof=live_refresh_observed`.
  Throwaway repository scaffolds (`.live-proof-tmp/`,
  `apps/server/.live-proof-tmp/`) removed; no owned repo scaffold DB
  remains. One private temp artifact `/tmp/live-refresh-proof-LMZ0zi`
  (owned 3 SQLite files) remains permission-blocked (tool
  external-directory deny), with no active process; oc13 had no stale
  proof process and live `:3000` was untouched.
- Live server health (this worker, non-disruptive readonly probes only):
  `GET /health/live` 200 + `GET /health/ready` 200 on loopback `:3000`;
  server left running. UI freshness re-verified 2026-10-14 ~17:41 UTC:
  the pre-restart served bundle predated current `client.ts` (no
  `reconcileLostReject`), so the server was safely restarted once via
  the existing `run-google-readonly.sh` (DB/model preserved, profile
  `google-readonly`, `COMPANION_ACTIONS_JSON` unset, no Google calls);
  `prestart` rebuilt `dist/assets/client.js` from current source and the
  served `/assets/client.js` (40434 bytes) now hash-matches dist and
  contains `reconcileLostReject`; `GET /` 200 references
  `/assets/client.js`; health re-probed 200/200 after restart.
  Report carries counts/codes/tool/reference transitions only — no events, tokens, or raw prompts.
- Reused automation counts (oc10 record, PRE-PR28-CODE-CHANGE baseline,
  labeled, NOT a current full-suite claim): lint 229 files 0 errors +
  1 pre-existing info; both typechecks exit 0; units 107 files / 1307
  tests; real default Chromium 24/24; fake Calendar 26/26 (action 21 /
  calendar 4 / tombstone 1). CURRENT final (oc21 observed after the 4
  PR28 race fixes; reviewer oc22 confirmed strengthened PR28-2/4
  non-vacuous): default 24/24 prior value unchanged (not rerun,
  test-only change in `calendar/action.spec.ts`); calendar 30/30
  (action 25 + calendar 4 + tombstone 1); final units 107 files / 1307
  tests pass; both typechecks exit 0; `biome check .` exit 0 (229 files,
  0 errors, 1 pre-existing info).
- Spike conclusion: the existing readonly surface cannot write; the
  dormant broad `UpdateEventHandler` lacks `If-Match` (verified absent at
  the pinned fork commit); a dedicated narrow reschedule needs an exact
  etag conditional patch with 412-stale handling, no auto resend, and a
  readback; recurring behavior, scope/tool choice, and write consent are
  unresolved source-only decisions; no live writes authorized.
- Remaining genuine blockers: Windows 11 x64 manual smoke; positive
  deletion evidence (C11-01 BLOCKED); M5 live/write gates (no production
  write binding, triple-gate never opened live); fresh OAuth
  consent-screen scope display as a separate untouched decision (OAuth
  itself COMPLETED, authenticated reads OBSERVED — never force
  reconsent). PR21/22 superseded-close is DONE (see next section; fork PR2
  left draft-open).

## PR21/PR22 superseded close (2026-10-14, observed remote actions)

Parent-verified baseline: PR23 + PR24 merged into the original stack;
PR27/PR28 are merged DELIVERY successors carrying the changes/evidence
into main (reconciled here, not erased). PR21/22 draft open at the
time; fork PR2 draft open. Ancestry/preservation investigated via `git`/`gh`/API
(read-only; no destructive commands, no source edits):

- PR21 (`feat/calendar-readonly-candidate-pin` @ `9630b25`, base
  `feat/c12-calendar-snapshots`, 3 files) is NOT an ancestor of
  `origin/master`. Its unique pin JSON was superseded by PR22's updated
  record (same path, now 6939311/readonly.2); its spike/operations text
  is superseded by merged PR23 + follow-ups.
- PR22 (`feat/calendar-readonly-compatibility` @ `6f219d8`, base
  PR21's branch, 8 files) is NOT an ancestor of `origin/master`. Its
  unique evidence files verified per-file against `origin/master`:
  `calendar-readonly-candidate-pin.json`,
  `candidate-3.0.0-readonly.2.result.json`,
  `consumer-smoke-3.0.0-readonly.2.result.json`,
  `probe-consumer-smoke.source.mts` all SAME; only
  `probe-tools-list.source.mts` DIFFERS by the later `083453f`
  fork-replay-checkout correction (clone + `git -C` detach). Design /
  spike / operations text superseded by merged PR23 + follow-ups.
- Performed (evidence-backed, non-destructive; no merges, no branch
  deletion, no rebase): closed PR21
  (`https://github.com/suiso11/companion_harness/pull/21`) and PR22
  (`https://github.com/suiso11/companion_harness/pull/22`) with precise
  superseded links + reasoning comments above, preservation verified
  per-file in merged successors on `origin/master` (see bullets above).
  Branches retained.
- Fork `suiso11/google-calendar-mcp#2` (`feat/companion-readonly-
  compatibility` → `feat/readonly-mode`, draft open, unmerged,
  head `6939311fd3ea`) contains real code changes not necessarily merged;
  left untouched — not ready-for-review evidence for Companion, no fork
  merge, no external modification. Post-close `gh pr list --state open`
   on companion_harness returns empty; fork PR2 (separate repo) stays open
   by design.

## PR28 UI race fixes + permanent browser regressions (2026-10-14, observed)

Four ground-truth defects in the C22 approval client
(`apps/server/src/ui/client.ts`), each fixed plus one permanent real-browser
regression over the existing Calendar fake harness (real UI + real fake
seams, no synthesized bodies, no source/incidental assertions):

- PR28-1 lost reject dropped while an action sync is in flight: the reject
  POST transport failure used to release decision ownership and rely on the
  deduped background sync, which is dropped while an older sync runs —
  leaving buttons disabled with the pending timer consumed. Fix: new
  `reconcileLostReject` holds `deciding` across ONE authoritative proposals
  re-read (rejected/expired retires, approved takes approved ownership,
  pending restores controls + fresh bounded timer, unreadable falls back to
  normal sync). Regression replays a held proposals list + aborted first
  reject, then proves live controls and a real second reject (200, history
  `action_rejection` x1, 0 writes).
- PR28-2 stale pending list downgrades runId-less approved ownership: a
  lost-approve card (approved, no runId yet, execution GET failed) was
  reverted to actionable pending by a stale pending replay. Fix: pending
  application and `ensureActionCard` now skip any card whose local status
  already left `pending`. Regression (strengthened 2026-10-14; the first
  version installed its stale route after approval with no ensuing list
  GET, so it never fired): the next proposals list — the real
  assent-terminal sync sent while the card is still pending — is fetched
  while genuinely pending but its delivery is held past the server commit
  and the lost-approve authoritative re-read; the held stale summary is
  released only after approved ownership with no runId, and the test
  proves the held delivery happened (exact route hits ≥3), the card stays
  approved/disabled across the original deadline, and the real receipt
  lands (1 write).
- PR28-3 historic rejections multiply full-history hydrations: every
  decided proposal's `syncExecution` hydrated history directly, so N
  historic rejections cost N full history GETs. Fix: `syncExecution` returns
  a history-need boolean and the caller hydrates exactly once per sync;
  historic rejections with no local card report no need. Regression stages
  two real reject cycles, reloads counting history GETs, and proves both
  `action_rejection` rows render with at most 2 history GETs (boot + one
  batch) and 0 writes.
- PR28-4 duplicate watch read starts before the current execution GET and a
  late live read overwrites the terminal receipt: the approved-ownership
  path started `watchAction` before the current execution GET (two
  concurrent reads), and a delayed live response could overwrite a rendered
  receipt and re-offer Stop. Fix: the watch starts only after a failed
  current execution GET, and any execution read arriving after
  `card.terminal` is ignored. Regression (strengthened 2026-10-14; the first
  version reloaded, which renders no approved card, so the terminal-wins
  guard was never reached): no reload — the live card stays alive, the next
  clock-driven watch poll is fetched while genuinely live (receipt-free)
  but its delivery is held, the run is released to its real terminal
  (Node-observed `succeeded`, 1 write), the terminal renders on the same
  card through a real assent-terminal client sync while the stale read
  stays held, and only then is the stale live read released: receipt,
  hidden Stop, and no stop claim stay stable (exact execution route hits
  ≥2).

Measured evidence (this worker, Linux, Node 24.12.0, real Chromium, owned
fake harness on loopback 4183–4186; user `:3000` service untouched):
`calendar/action.spec.ts` 25/25, `calendar/calendar.spec.ts` +
`calendar/tombstone.spec.ts` 5/5 — all exit 0, 0 retries (1.1m). Full unit
`vitest run` 107 files / 1307 tests pass. Static once after final edits:
e2e `tsc -p tsconfig.e2e.json` exit 0, root `tsc -p tsconfig.json` exit 0,
`biome check .` exit 0 (229 files, 0 errors, 1 pre-existing `biome.json`
info). The default suite (conversation/citation_recovery/sse_history/
polling) 24/24 is the prior observed value, NOT rerun here (this change is
test-only inside `calendar/action.spec.ts`, no production code touched).
Prior oc17 static runs are NOT re-claimed here (no retained oc17 logs
found; only its PR28-4 failure error-context survived and the capture was
reworked above). Owned `apps/server/test-results/` removed; no owned
servers/processes
   left. One private temp artifact `/tmp/live-refresh-proof-LMZ0zi`
   (owned 3 SQLite files) remains permission-blocked, no active process
   (see ledger cleanup note above).

## PR29 Windows stall fix (2026-10-14, CI ground truth, no timeout masking)

PR-event run `38608822921` (head `b04970b`) failed ONLY
`check (windows-latest)`: 4 `Test timed out in 5000ms` with zero assertion
failures — `apps/server/test/action_composition.test.ts:131`,
`packages/kernel/test/action_history_receipt.test.ts:258`,
`packages/kernel/test/action_scheduler_pickup.test.ts:239` and `:371`.
Ubuntu `check` and `e2e` on the same run passed, and the same-head push run
`38608803181` passed Windows: a load flake, not a logic regression. No
check was rerun for confirmation and no timeout was raised or suppressed.
Evidence for a concurrency/resource cause (not product behavior): the
failing files' own passing siblings took 3.6–4.7s each (e.g. the no-op
unapproved-bound pickup took 4669ms), total collect was 89.15s, and every
timeout fired while the test body was still running — no error log, no
receipt mismatch. Two avoidable contributors fixed minimally, behavioral
assertions/contracts untouched:
- `action_scheduler_pickup.test.ts`: the engine-idle poll slept
  `setTimeout(..., 2)` up to 500 times, so a starved Windows event loop
  stretched the wait itself past the 5s budget. It now yields via
  `setImmediate` (no wall-clock sleep): the launched strategy only awaits
  immediately-resolved ports, so it settles within a handful of yields,
  and a genuinely stuck run fails fast on the existing `inflightCount`
  assertion instead of timing out.
- `vitest.config.ts`: `maxWorkers: 2` on CI only (`CI`/`GITHUB_ACTIONS`
  env; local parallelism unchanged), so full parallel forks no longer
  thrash synchronous better-sqlite3 plus real loopback servers on
  Windows runners.
Local proof after edits (Linux, Node 24.12.0, single pass, no midflight
runs): focused `action_scheduler_pickup.test.ts` 3/3, full `vitest run`
107 files / 1307 tests, root typecheck exit 0, `biome check .` exit 0
(229 files, 0 errors, 1 pre-existing info). New-head CI observed after push,
head `7cf085b`: PR-required run `38610182826` success — `check
(ubuntu-latest)` success, `check (windows-latest)` success, `e2e` success;
same-head push run `38610174325` success (ubuntu success, windows success,
e2e success). PR29 required context is the PR-event run.

## M5 dedicated write binding — continued §20 #1 spike decision (2026-10-15, source-only, no implementation)

Continuation after the live readonly acceptance ledger. No code changed, no
live writes, no OAuth/scope/key changes, no userDB/service interruption. The
readonly fork was not modified (not even re-read from its external checkout:
this worker's tool boundary denies external directories, so the fork source
facts below reuse the recorded pin-commit evidence at `m4_dependency_spike.md`
L623-629 + operations L2192-2204, and this worker re-verified everything
reachable in-repo). The running readonly user service was untouched.

- In-repo verification (this worker, reached paths only):
  `packages/connector-calendar/src` contains no update/patch/`If-Match`/write
  path (only the read-side etag revision basis in `normalize.ts`); the C21
  triple gate + `CalendarActionWritePort` contract in
  `packages/kernel/src/action_strategy.ts` + `apps/server/src/bootstrap.ts`
  are unchanged (exact `["start","end"]` capability, one-shot `update`, exact
  three-value outcome, no retry); no production write binding is selected
  anywhere. Kernel side is ready; the independent provider side is missing.
- Exact missing independent write-provider contract (decision-ready):
  1) Narrow tool: fork `6939311` `UpdateEventHandler`
  (`src/handlers/core/UpdateEventHandler.ts`) is dormant/unregistered and
  broad-field (`getCalendarTimezone`/`detectEventType` + broad-field +
  recurring-split paths); its `events.patch` calls lack `If-Match`, so
  `expectedRevision` cannot be carried. No approved narrow start/end-only
  reschedule port exists.
  2) Conditional mutation: exact-etag `If-Match` + `412`-as-stale is recorded
  design-only (Google version-resources semantics), never provider-proven for
  this fork path; a preflight-to-write race `412` has no agreed port mapping
  beyond the closed three-value return.
  3) Idempotency capability (§20 #1 open item): kernel gives at-most-once per
  committed grant with no auto resend, but whether upstream offers update
  tokens/etag idempotency signals against duplicate delivery is unconfirmed.
  4) Scope/consent: any write needs scope beyond `calendar.events.readonly`
  plus an explicit user write-consent decision; current authorization covers
  implementation, NOT live writes or OAuth broadening.
- Smallest safe choice (user decision, no guessing): keep the triple gate
  closed; next step is a fork-side narrow-tool proposal (start/end-only,
  exact-etag `If-Match`, `412` propagation, no recurring split) + a
  write-capable pin decision + a scope/consent decision, BEFORE any binding
  code. Adopting the dormant broad handler as-is is REJECTED (violates §18.1
  start/end-only + §18.5 exact-revision preflight; it would invent an
  incompatible API). The fake-harness browser approval→receipt path (exactly
  1 fake write) already proves the kernel side; rerunning it proves nothing
  new and was not rerun.
- Genuine remaining gates (unchanged): Windows 11 x64 manual smoke; C11-01
  BLOCKED; M5 live/write gates (no production binding, triple gate never
  opened live); fresh OAuth consent-screen scope display as a separate
  untouched decision; §20 #1 UI phrasing still open.

## M5 isolated reschedule binding — real runtime (2026-10-15, no live writes)

SUPERSEDES the "fixture-only" note above: the fork-side SEPARATE
ENTRYPOINT is now a REAL production runtime (defaults disabled, no live
Google mutation, no OAuth consent/scope activation, readonly checkout
untouched — external reads were boundary-denied, so no readonly code was
copied; the entrypoint is a standalone narrow surface with its own pin).

- Real Google adapter (fork `src/google.ts`): exact events.get/patch
  shape normalization, recurring/instance/cancelled/deleted/all-day
  rejects, GET 404/410 no-write definite (never deletion proof), PATCH
  start/end ONLY with `If-Match` exact etag, 412 definite `etag_mismatch`,
  5xx/timeout/abort/disconnect/malformed-2xx after dispatch `unknown`
  (never resend); single fetch each, bounded timeout/abort/response-size,
  `redirect: manual` (never follows; no credential leak).
- Real auth (fork `src/auth.ts`, separate `M5_RESCHEDULE_*` namespace):
  exact-whitespace scope tokens (prior substring match removed, so
  `calendar.events.foo` cannot pass), exact account selection, no
  readonly token reuse, refresh-BEFORE-dispatch only (single RFC6749
  grant, no interactive flow, no scope broadening), separate 0600 token
  persistence. No live OAuth/Google invocation (fake token endpoint in
  tests only).
- Executable CLI (fork `src/cli.ts`, bin `calendar-reschedule-mcp`,
  `start` runs `dist/cli.js`; build/start are distinct commands);
  production Google URL FIXED (test endpoint only via the explicit
  `M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE=1` seam, never set in
  production); strict tool schema (`additionalProperties: false`, exact
  ISO `start < end`, opaque etag); SDK signal cancellation; real bounded
  stdio shutdown race (not a comment).
- Production fixture provider REMOVED from production (fixtures live in
  tests only). Harness `rescheduleWrite.test.ts` is self-contained (no
  relative import from the ignored nested repo); new
  `rescheduleProcess.test.ts` drives the ACTUAL built executable over
  real stdio MCP into a local Google-shaped fixture (success exact
  fields/If-Match, stale-etag definite, zero PATCH on rejects). Fork is a
  workspace member with the same durable pins (SDK 1.30.0, zod 4.5.4).
- Harness side unchanged in trust: `createRescheduleWritePort` (exact
  `reschedule-event`/instance binding, committed-grant etag only, one
  call, loss -> unknown) + `createDedicatedWriteBinding` into the
  existing triple-gate seam (all defaults disabled; readonly
  entrypoint/tools/scopes/pin untouched).
- Verification (Linux, Node 24.12.0 — each run ONCE, 2026-10-15):
  fork `tsc` build clean (`dist/cli.js` present); port suite 8/8 +
  real-process stdio suite 1/1 green; root typecheck + full suite +
  biome re-run recorded below. No live writes/scopes.
- Normal-startup write-profile proof (2026-10-15, default OFF unchanged):
  `apps/server/test/rescheduleWriteStartup.test.ts` 21/21 — the prior
  14/15 success case (`unknown` instead of `succeeded`) was a fixture-hint
  cause only (E2E stdio hints omitted the mandatory SDK inherited
  allowlist, so the fail-closed stdio guard denied before spawn); fixed by
  adding the exact live `STDIO_IMPLICIT_ENV_VARS` to the three real-stdio
  E2E hints. PR31 review findings (2026-10-15, same file +6): P1 —
  production-factory hints now validate the platform implicit allowlist in
  preflight (fixed `env allowlist is invalid`, no DB/child/patch; inert
  `writeMcpTransportFactory` seams skip it); P2 — explicit
  `actionWriteBinding: null` normalizes to absent (only non-null conflicts);
  P2 — write commands accept absolute paths incl. Windows
  `C:\Program Files\...\node.exe` and spaced POSIX paths (shell lines /
  interpolation / NUL / controls still rejected; real spaced-binary
  production spawn smoked). Production parsing still rejects `M5_RESCHEDULE_TEST_*`
  (fixture endpoint travels in the options-injected CHILD env only, never
  the hint). Success path verified end to end: staged HTTP approve ->
  exactly ONE conditional PATCH (`If-Match` = committed etag, start/end
  only) -> strategy readback -> `succeeded` receipt; stale grant ->
  `blocked_stale` with 0 patches; drifted identity -> `unknown` with 0
  patches; committed-grant resolver reads the exact stored hash+revision.
  Final: root suite 114 files / 1350 tests green, `tsc --noEmit` exit 0,
  `biome check .` clean, throwaway normal-startup `tsx` smoke
  (`/health/live` -> `{"status":"live"}`, default profile unselected) OK.
  No live Google/OAuth/user-DB writes; no production guard weakened.
- Remaining: nested-fork push to suiso11/google-calendar-mcp SUCCEEDED
  (branch `feat/m5-reschedule-entrypoint`, commit `164cb83`, no merge);
  draft PR BLOCKED with the exact reason `branch has no history in common
  with main` (the nested repo was built standalone because the external
  readonly clone was boundary-denied, so no shared history exists);
  actual fork-readonly-code checkout BLOCKED by external-directory read
  denial (no code copied, original untouched by construction); Windows 11 x64
  manual smoke; C11-01 BLOCKED; M5 live/write gates (triple gate never
  opened live).

## Prior M5 fixture-only record (2026-10-15, superseded — kept for history)

SUPERSEDES the "no implementation" note above: the fork-side SEPARATE
ENTRYPOINT is now implemented end-to-end against a local real-HTTP fixture
(no live Google mutation, no OAuth consent/scope activation, readonly
`6939311` checkout untouched — external reads were boundary-denied, so the
fork was built in-repo from the recorded contract and never re-read).

- Separate entrypoint (nested fork `.m5-write-fork`, own branch
  `feat/m5-reschedule-entrypoint`, parent tracks sources but ignores nested
  `.git` via `.gitignore`): identity `google-calendar-reschedule` /
  `1.0.0-reschedule.1` (distinct from readonly `google-calendar` /
  `3.0.0-readonly.2`); tool `reschedule-event` ONLY (strict start/end +
  opaque calendar/event/account + committed-grant `expectedEtag`; unknown
  keys rejected); injectable provider boundary (fixture HTTP provider +
  documented Google `events.patch` mapping); read-before-patch rejects
  recurrence/instances, cancelled/deleted, all-day, missing etag with NO
  patch; exactly ONE conditional PATCH with `If-Match` (retry:false, no
  redirect follow, no recurring split); HTTP 412 -> `definite_failure`
  (`etag_mismatch`, provider proves NO patch); transport loss after possible
  dispatch -> `unknown` (never resend, never cancel); classified outcomes as
  non-error payloads, `isError` only for lost responses (never definite on
  loss); separate `M5_RESCHEDULE_*` credential namespace + write-scope
  validation, no OAuth flow, no scope broadening.
- Harness side: `packages/connector-calendar/src/rescheduleWrite.ts`
  (`createRescheduleWritePort`, structural `CalendarActionWritePort`;
  committed-grant etag ONLY via `resolveExpectedEtag`, hash/updated-only
  revisions safely rejected with NO dispatch, exact 412 -> definite_failure,
  loss -> unknown, one call per update) +
  `apps/server/src/rescheduleWriteBinding.ts`
  (`createDedicatedWriteBinding` -> existing `derivePort` triple-gate seam;
  all defaults disabled). Readonly entrypoint/tools/scopes/pin unchanged
  (no write tool registered there; `calendarReadonlyProfile.ts` untouched).
- Verification (Linux, Node 24.12.0, pnpm 11.25.0 — each run ONCE, 2026-10-15):
  typecheck clean (`connector-calendar`, `server`); `biome check .` clean;
  new `rescheduleWrite.test.ts` 8/8 over a real loopback HTTP fixture
  exercising the real wire adapter + port (success exact fields/If-Match,
  412 definite with no patch, recurring/cancelled/deleted/all-day with zero
  dispatch, hash-only revision rejected undispatched, abort -> unknown with
  exactly 1 attempt, lost/unparseable -> unknown never definite, wrong
  tool/instance refused); throwaway full-pipeline smoke PASSED then deleted
  (dedicated MCP identity `google-calendar-reschedule`/`1.0.0-reschedule.1`
  + sole `reschedule-event` tool over the real SDK wire, direct success +
  stale-etag definite_failure, then approval -> committed grant -> MCP ->
  fixture PATCH -> readback -> `succeeded` receipt via the real scheduler);
  focused regression 134/134 across connector-calendar + kernel action +
  server action/bootstrap suites; readonly-unchanged proof: modified tracked
  files are only `.gitignore` (nested `.git` ignore), `docs/operations.md`,
  `connector-calendar/src/index.ts` (additive exports); readonly profile,
  bootstrap gates, kernel, connector-mcp untouched.
- Remaining: nested-fork push/draft-PR blocked (no remote configured; worker
  does not invent push targets); Windows 11 x64 manual smoke; C11-01
  BLOCKED; M5 live/write gates (triple gate never opened live); §20 #1 UI
  phrasing.

## M5 fork-history recovery — proper derived PR (2026-10-15, no live writes)

SUPERSEDES the two blocked-PR notes above (standalone history problem is
RESOLVED; history sections kept). No live Google mutation, no OAuth
activation, no user service/DB/model changes, no user-branch deletion.

- Derived checkout: `.m5-write-fork-derived` cloned from the KNOWN
  accessible GitHub remote (`https://github.com/suiso11/google-calendar-mcp.git`,
  branch `feat/companion-readonly-compatibility`, HEAD exactly
  `6939311fd3eae9846648e0a175e304c9500f578e` — no external-filesystem
  reads needed). New branch `feat/m5-reschedule-entrypoint-v2` (no
  force-push; orphan `feat/m5-reschedule-entrypoint` / `164cb83` retained
  on the remote for reference, superseded, never deleted).
- Separate entrypoint with TRUE ancestry (commit `f1dcde8` on top of
  `6939311`): `src/reschedule/*` ported byte-identical from `164cb83`
  (sha256-verified per file) + entry `src/reschedule-cli.ts` ->
  `build/reschedule-cli.js` (bin `calendar-reschedule-mcp`, identity
  `google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
  `reschedule-event` ONLY). Readonly byte/behavior unchanged: only
  `package.json` (bin + additive `build:reschedule`/`start:reschedule`
  scripts) and `scripts/build.js` (additive bundle) modified; `src/index.ts`,
  `src/server.ts`, auth, handlers, tools, name/version
  `3.0.0-readonly.2` untouched (diff proof: 2 files, +39/-2; all else new
  files). `RESCHEDULE.md` records provenance + pin.
- Fork verification (Linux, Node 24.12.0): `npm run lint` exit 0,
  `check:imports` clean, full `npm run build` green, unit suite 821/821
  pass, real stdio smoke of `build/reschedule-cli.js` vs loopback fixture
  PASS (identity exact, one tool, success exact If-Match start/end-only,
  stale etag definite `etag_mismatch` with zero extra PATCH, no-credential
  exit 2). No live writes/scopes.
- Draft fork PR (NOT merged): suiso11/google-calendar-mcp#3
  (`feat/m5-reschedule-entrypoint-v2` -> `feat/companion-readonly-compatibility`,
  true ancestry, diff confined to the additive reschedule surface).
- Harness clean-clone durability (this worktree): `.m5-write-fork`
  standalone scaffold DELETED (directory + `pnpm-workspace.yaml` member +
  lock importer pruned via `pnpm install`); no test imports any ignored
  repo. `rescheduleProcess.test.ts` now spawns a REAL child-process MCP
  server over REAL stdio: TRACKED fixture
  (`test/helpers/rescheduleFixtureServer.mjs`, own
  `*-test-fixture` identity) by DEFAULT — always runs, never skips — and
  the REAL fork bundle only under explicit `M5_RESCHEDULE_FORK_CLI`
  (set-but-missing is a hard error). `rescheduleWrite.test.ts` header
  updated; `.gitignore` now ignores only
  `.m5-write-fork-derived/.git`. Single production implementation (fork
  branch); Harness keeps only the binding port + fixture provider in tests.
- Harness verification after final edits (Linux, Node 24.12.0, pnpm
  11.25.0 — each run ONCE, 2026-10-15): port suite 8/8 + real-process
  suite 1/1 green on the DEFAULT fixture path; explicit-fork path 1/1
  green against `build/reschedule-cli.js` (`f1dcde8`); explicit-missing
  path hard-fails (no silent skip); root typecheck + full `vitest run` +
  `biome check .` re-run recorded below. Readonly entrypoint/tools/scopes/
  pin untouched (`calendarReadonlyProfile.ts`, bootstrap gates, kernel,
  connector-mcp unchanged).
- Remaining: fork PR #3 review/merge decision (not this worker); Windows 11
  x64 manual smoke; C11-01 BLOCKED; M5 live/write gates (triple gate never
  opened live); §20 #1 UI phrasing.

## M5 reschedule hardening + wire-hash pin (2026-10-15, oc38 record, no live writes)

SUPERSEDES nothing: implements the remaining hardening on top of the
derived-PR record above. No live Google mutation, no OAuth consent/scope
activation, no user service/DB changes. Readonly surface/scopes/pin
untouched (zero write tools on the readonly entrypoint; this module never
enters the read allowlist).

- Fork (`feat/m5-reschedule-entrypoint-v2`, committed `0e61265`
  `0e612655e7054130fe37601cbe80378f73f418ea`, normal ff push, NOT
  merged): provider default-behavior hardening (`src/reschedule/google.ts`,
  `auth.ts`, `cli.ts`, `provider.ts`) — ONE deadline spans headers AND
  body (hang-safe abort), exact-account pre-check BEFORE any token or
  provider I/O, refresh-BEFORE-every GET and PATCH, `read_transport_lost`
  definite pre-dispatch, `unknown` only after possible dispatch (single
  attempt, never resend); server advertises and validates with THE SAME
  strict `RescheduleEventInputSchema` object (hand-written
  `rescheduleInputJsonSchema` removed, cannot drift). Wire identity
  unchanged (`google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
  `reschedule-event` ONLY). New permanent tests
  `src/tests/unit/reschedule/googleReschedule.test.ts` (6 cases, injected
  `fetch` only: body-deadline/abort, exact account, per-request refresh,
  single-GET observation, after-dispatch unknown, pre-dispatch definite).
- Host (this branch): owned-write bounded shutdown in
  `apps/server/src/bootstrap.ts` (adopted owned-hook close paths bounded;
  a hanging hook never stalls shutdown past the bound — new hang test in
  `action_composition.test.ts`); committed-grant revision proof in
  `rescheduleWrite.ts` + `rescheduleWriteBinding.ts` (resolver keyed by
  the exact committed grant; content-hash/updated-timestamp fallbacks and
  resolver substitution rejected with NO dispatch — 4 new cases in
  `rescheduleWrite.test.ts`); `category: "write"` gate in
  `connector-mcp/src/client.ts` (default readonly connector refuses
  trusted `write` definitions with `mcp_binding_not_allowed` before any
  dial; dedicated `["write"]` connector enables ONLY write — 4 cases in
  `write-category-gate.test.ts`); host-owned wire-hash pin in new
  `apps/server/src/rescheduleWriteProfile.ts` (+ 4 pin tests) and live-wire
  stdio proof in `rescheduleWireHash.test.ts` (2 cases, tracked fixture —
  clean-clone safe). Base pin `6939311` in the profile is the branch base
  (unchanged and still exact); wire hash unchanged (no reprobe needed).
- Wire-hash pin (probed oc37, recorded in `rescheduleWriteProfile.ts`):
  live-wire canonical input-schema SHA-256
  `9f59e35bf76bfec75a99546fc3c22348cd20e33e9414154ea321d414186d09b7`,
  probed over REAL stdio against BOTH the freshly built fork bundle
  (`build/reschedule-cli.js`) and the tracked contract-mirror fixture —
  byte-identical STRICT schemas (`additionalProperties: false` + `$schema`
  key). oc38 adopts that exact strict schema object fork-side, so the pin
  stands without rebuild/reprobe.
- Verification carried from the oc38 handoff (implementation + all gates
  passed before the worker timed out at docs-recording; NOT rerun by this
  worker per scope): fork provider behavior tests pass; bootstrap
  owned-write bounded-shutdown all-paths + hang test pass; grant-revision
  proof tests pass; Harness typecheck/lint clean; fork final gates + build
  green; real-fork stdio smoke green; full Harness suite green; trusted
  approval→grant→real-stdio→local-Google-fixture→readonly-readback→receipt
  smoke PASS (temp removed); real UI approval suite all-green. Exact
  per-suite log counts are UNKNOWN (oc38 logs not retained in-repo; only
  structural counts are verifiable here: fork 6 + profile-pin 4 +
  wire-hash 2 + write-gate 4 + grant-revision 4 + shutdown-hang 1 new
  cases; retained `test-results/.last-run.json` read `passed`/zero-failed
  and was then deleted as a generated artifact).
- Remaining: fork PR #3 review/merge decision (not this worker); Harness
  PR #30 review/merge decision (not this worker); Windows 11 x64 manual
  smoke; C11-01 BLOCKED; M5 live/write gates (triple gate never opened
  live); §20 #1 UI phrasing.

## M5 production boundary final (2026-10-15, oc40 fixes, no live writes)

- POST-dispatch 3xx is `unknown` (fork `google.ts` + host mirror
  `testWirePatch`): the PATCH was already received by the server
  (`redirect: manual`, never followed), so no definite no-commit proof
  exists; exactly one attempt, no resend. Fork
  `googleReschedule.test.ts` + host `rescheduleWrite.test.ts` prove
  server-received-PATCH-then-3xx -> `unknown` with patchCount 1.
- Immutable production endpoint: shipped CLI (`src/reschedule/cli.ts`,
  bin `calendar-reschedule-mcp`) reads NO `M5_RESCHEDULE_TEST_*` env and
  never sets `endpointBase` (always the FIXED Google host). Fixture
  injection lives ONLY in the unshipped test-only runner
  (`src/tests/helpers/rescheduleTestRunner.ts` +
  `rescheduleTestStdio.ts`, outside `bin`/`files`/`scripts/build.js`),
  exercising the SAME production provider + MCP server factory
  (import-identity asserted). Host `rescheduleProcess.test.ts` explicit
  fork path now spawns that runner via tsx (never the shipped CLI with
  bypass env); new host `rescheduleEndpointIsolation.test.ts` proves the
  shipped CLI ignores test env + the committed-grant resolver contract
  with no live Google calls.
- Exact least-privilege scope: `WRITE_SCOPES` is
  `calendar.events` ONLY (broad `calendar` refused). Refresh-response
  `scope`/`scopes`, when the server reports one, must contain the exact
  write scope or the refresh is refused (config alone never equals a
  grant). Fork `productionBoundary.test.ts` covers exact/broad/readonly/
  spoof + refresh-scope verify.
- Write provenance pin (readonly pin untouched):
  `apps/server/src/rescheduleWriteProfile.ts` now pins
  branch `feat/m5-reschedule-entrypoint-v2`, base
  `6939311fd3eae9846648e0a175e304c9500f578e`, source commit
  `4f9c06dd9318c11ee9d352d61825c3f75f9ac8a6`, source tree
  `9eec88aa21951e1ea9564a62e89a40eeb2bcceef`, package-lock SHA-256
  `63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533`
  (deps unchanged from the readonly base).
- Host vs fork CI scopes (no new flaky clone job added: host CI keeps no
  fork-fetch pattern; fork CI is the actual provider proof):
  fork default `npm test` (`vitest run src/tests/unit`) includes
  `src/tests/unit/reschedule` (832/832 green incl. 3xx/scope/boundary);
  fork `.github/workflows/ci.yml` now triggers on `feat/**` too so PR #3
  runs build + `lint` (`tsc -p tsconfig.lint.json`) + `check:imports` +
  unit tests with coverage. Host CI (`ci.yml` check + e2e) proves the
   tracked-fixture mirrors, static gates, and full pipeline smoke only;
   host `rescheduleProcess`/`rescheduleWrite` mirrors are NOT provider
   proof (stated here, not substituted).

## PR31 citation CI race fix (2026-10-15, test sync only, no product change)

CI ground truth: push run `38716307351` (head `a77cd1e`) failed ONLY
`e2e` with 2 failures in `apps/server/e2e/citation_recovery.spec.ts`
(stale-PUT CAS test `:71` + genuine-concurrent-409 test `:135`); both
`check` jobs passed and the same-head PR-event run `38716314333`
passed. Both failures are the identical line
`sessionIdOf (.../citation_recovery.spec.ts:42)`:
`expect(typeof id).toBe("string")` got `typeof null === "object"` —
the page's `localStorage ch.sessionId` was still empty. No seed,
409, expiry, collision, or route-capture behavior is implicated: the
read happens before `/seed-citation` and before any route is
installed. Root cause is a test/fixture race: `beforeEach` gates on
`#composer` visible + `#composer-send` enabled, which the static HTML
already satisfies before async `boot() -> ensureSession()` finishes
`POST /api/sessions` and writes `ch.sessionId`. Cold CI starts lose
the race (first two tests); warm runs win it (later tests +
same-head rerun passed). Fix (test-only, assertions kept):
`sessionIdOf` now `waitForFunction`s the real product signal
(`ch.sessionId` non-empty, 15s budget matching the file's other
waits) before reading/asserting. No M5 startup code touched, no
`client.ts`/`app.ts` product change, no timeout/retry/suppression,
readonly `:3000` service untouched. Local proof (Linux, real
Chromium, owned temp harness): the 2 affected cases pass
(`-g "citation drawer"`, 2/2, ~4s); `biome check` on the touched
spec clean. New-head CI after push, head `5195fef`: push run
`38717280204` success (e2e success, check ubuntu success, check
windows success) and PR-event run `38717286888` success (e2e
success, check ubuntu success, check windows success); zero review
comments on PR31 at observation time.
- HISTORICAL PR30 helper API (not the CURRENT normal-startup wiring):
  Concrete host resolver (closed contract, trusted-code-only, default
  OFF): `createCommittedGrantResolver` (connector-calendar, re-exported
  by `rescheduleWriteBinding.ts` + `createCommittedGrantWriteBinding`
  helper) keyed by execution/proposal/hash -> immutable
  `expectedRevision` with real source-etag basis; unknown/mismatched/
  hash-only/updated-only -> null (safe definite rejection, no dispatch).
  Nothing auto-wires: the host passes the resolver explicitly with its
  committed-grant store. Resolver answers are equality-checked against
  `grant.expectedRevision`; a throwing resolver pre-dispatch stays a
  safe definite failure (no dispatch happened). HISTORICAL scope ends here:
  in this helper the host passes the resolver explicitly. CURRENT PR31
  normal-startup composition instead auto-wires a concrete DB resolver —
  the frozen write profile (`M5_RESCHEDULE_WRITE_PROFILE=google-reschedule`
  + strict `M5_RESCHEDULE_CONNECTOR_JSON` hints) builds an inline
  `resolveExpectedEtag` over `repo.readCommittedGrantRevision`
  (`apps/server/src/bootstrap.ts`), equality-checked against the committed
  grant; see "M5 reschedule hardening + wire-hash pin" and the normal-startup
  write-profile proof above.
- Verification (this worker, no live Google/OAuth/writes): fork
  `npm run build` + `npm run lint` + `npm test` green; host units +
  typecheck/lint + pipeline smoke re-run below. Fork commits pushed
  ff-only on `feat/m5-reschedule-entrypoint-v2` (no merge, no force).

## PR30 integration head (PR31 merged 2026-10-15, no product change)

Merge `36b4b63` (parents `9c7ef78` + `b59c700`; PR31 head is an
ancestor, verified via `merge-base --is-ancestor`). Fork pin unchanged:
`feat/m5-reschedule-entrypoint-v2 @ 4f9c06d` (matches fork PR #3 head
via `ls-remote`; no repin). Test-count reconciliation: `1335 + 21` (new file
`rescheduleWriteStartup.test.ts`: 15 in `a77cd1e`, +6 in `b59c700`)
= `1356` root green.
Merged-head CI (exact head `36b4b63`): push run `38725542758`
success (check ubuntu/windows + e2e) and PR-event run `38725549293`
success (same jobs); fork CI run `38686976091` success on the exact
fork pin (test pass, tool-analysis skipped). Zero review threads on
host PR #30 and fork PR #3. Observed on the merged head (owned
worktree, no live Google/OAuth/writes, user `:3000` untouched):
`rescheduleWriteStartup.test.ts` 21/21 green,
`rescheduleWriteProfile.test.ts` 5/5 green, throwaway production CLI
normal startup (owned temp store, default profile unselected)
`GET /health/live` 200 `{"status":"live"}` +
`GET /health/ready` 200 `{"status":"ready"}` with no write child
 spawned (only the tsx loader chain under the server pid).

## PR30 repin to fork f196558 + review-thread fixes (2026-10-15)

Fork PR #3 review fixes landed as `f196558e7d768effd969cf70ada2721d7d504b23`
(tree `b50f74550a5269ec1af4e57c6d4cc03e76a9aebd`, lock digest unchanged
`63261d25…533`); host write pin repinned from `4f9c06d` (hash unchanged).
Fresh REAL-stdio wire probe (trusted TEST-ONLY runner bundle — same
production provider + server factory, fixture credentials, loopback endpoint
unused by tools/list; production CLI cannot launch without credentials):
`reschedule-event` hash `9f59e35b…8609d7`, identical to the pin and the
tracked fixture mirror (strict-date refines are runtime-only, wire unchanged).
Focused host fixes for PR #30 threads `4282825244` (throwing grant resolver
-> definite_failure pre-dispatch, 0 calls) and `4282825247` (frozen startup
snapshot feeds the lazy write child via `startupEnvTransportFactory`).
Proof after repin: profile 5/5 + wire-hash 2/2 + startup 22/22 + focused
  reschedule/stdio-env 18/18 = 47/47 green, biome clean; no live Google/OAuth,
  readonly `:3000` untouched, `.m5-integration-review/` worktree preserved.

## M5 all-day → timed conversion (2026-10-15, no live writes)

  Valid all-day sources CONVERT to timed (strict YYYY-MM-DD bounds retained,
  exclusive end > start; malformed/mixed bounds are `invalid_input` with NO
  patch, `allday_unsupported` removed). The conditional PATCH sends
  start/end ONLY with exact `If-Match`; conversions clear the stale field
  (`date: null` + new `dateTime`, timed sources keep `dateTime`-only).
  Etag/recurrence/cancelled/412/unknown guards unchanged. Stager untouched:
  staged requests stay both-instants (all-day snapshot + TIMED 15:00-16:00
  stages without loosening canonical/revision rules). Tracked fixture
  mirror classifies the loopback source identically; new full-pipeline
  regression (all-day snapshot → TIMED stage → local-fixture approve →
  ONE date-clearing PATCH → timed readback into a new rN, old all-day rN
  still valid) lives in `rescheduleWriteStartup.test.ts`; fork
  `alldayConversion.test.ts` pins the provider/server contract. Wire
  identity/schema hash unchanged (refines are runtime-only). Port-level
  mirror (`rescheduleWrite.test.ts`) converts valid all-day (ONE `date:
  null` PATCH, exact `If-Match`) and rejects malformed bounds
  (`invalid_input`, NO patch); timed bodies stay `dateTime`-only.

  Fork landed as `33483f458979d1d5a436d1a1047eb0f2a4d79dd7`
  (tree `83e72c3dc10e601b4dab25a88a2a88170fe19d73`, fork PR #4; base
  `6939311` + lock digest unchanged, readonly untouched). Host write
  profile repinned to the new source SHA/tree; live-wire input-schema
  hash re-probed over REAL stdio against the fork runner at `33483f4`:
  `9f59e35b…8609d7`, byte-identical, pin unchanged.

  Read-back verification is same-INSTANT, not same-string (2026-10-16 fix):
  the approved proposal stores the intended bounds exactly as staged
  (`+09:00`, no millis) while the readonly normalization canonicalizes
  timed bounds to UTC (`…Z` with millis), so an exact-string compare could
  never verify a landed conversion and every real write finished
  `succeeded_unverified`. `boundariesMatch`
  (`packages/kernel/src/action_strategy.ts`) now compares epoch instants
  under the existing strict RFC3339 convention (explicit offset, real
  calendar validation, no `Date.parse`; invalid fails closed), with the
  exact-string case kept as a fast path. Identity/deletion/revision/unknown
  gates are unchanged: wrong date/start/end, stale all-day bodies, deleted
  events, key mismatches and read failures still finish
  `succeeded_unverified` with no resend (pinned by
  `action_readback_instant.test.ts` 9/9 plus the pipeline test, whose
  read binding now decodes the provider-shaped fixture GET through the
  REAL `normalizeEvent`, asserting canonical-UTC read-back bounds).

## Citation drawer last-intent guard (2026-10-16, no new APIs/storage/retries)

  rN stored citations and mN run-bound memory citations share ONE drawer
  with no generation guard (before fix): an older delayed response
  overwrites a newer body, reopens the drawer after close, or latches a
  stale memory error/`memoryDisabled` over the newer stored citation.
  Fix (`apps/server/src/ui/client.ts`): ONE shared monotonic
  `citationDrawerSeq` for every drawer open plus `closeDrawer`,
  incremented synchronously before the first await; the session is
  frozen per open and every await is guarded (UI body/notices/disabled,
  further requests, CAS re-read/PUT retries). New intent invalidates
  old content immediately (synchronous clear+hide); close invalidates
  pending opens. rN stays stored-only (existing contextCAS, no upstream
  GET/PATCH) with exact immutable snapshots; mN stays bound to the
  originating-run recall endpoint (no latest-search fallback).
  Already-dispatched context PUTs stay committed (never rolled back).
  Fixtures (`e2e/server.ts`/`ports.ts`): `cite-two` (V2 r1+r2 answer),
  `cite-mem` (V2 m1 answer), `seed-citation` accepts plain-text `text`
  (bounded, control-char free). Three deterministic race regressions in
  `e2e/citation_recovery.spec.ts` (genuine forwarding via route.fetch +
  fulfill unchanged, no sleeps): older stored detail resolving late
  cannot overwrite newer; close-while-pending never resurrects;
  stale memory-citation error cannot replace the newer stored citation
  (nor latch notices/disabled). Failing-before on the pre-fix client:
  3/3 fail (late-overwrite, reopen, `記憶は無効です` latch). Passing-after:
  full `citation_recovery.spec.ts` 13/13 green (real Chromium, temp
  SQLite/fixture backend; mN recall is the genuine 404 of the real
  route — no real remind CLI dataset, stated honestly). Units 120 files /
  1458 passed (2 known missing-remind live files excluded, not rerun);
  root + e2e typecheck exit 0; `pnpm lint` exit 0 (2 pre-existing infos:
  `payload["correctionBody"]` present on clean HEAD, deprecated
   `recommended` field in `biome.json`).

## M5 approval before→after preview (2026-10-16, no live writes)

  Approval cards show the frozen BEFORE range beside the proposed AFTER
  range in one deterministic kernel summary (same `{ summary }` seam,
  same hash coverage, still ≤1024 chars, single line, `textContent` only).
  BEFORE comes from THE SAME based-on immutable snapshot validated for
  staging (title/rN/start/end/all-day); no upstream re-read, no hash
  rewrite of historical rows, no new DB columns/API/deps. Timed bounds
  stay verbatim (original offset/UTC, never browser-local); all-day
  bounds stay date-only with the exclusive end denoted (never an invented
  midnight); all-day→timed is visible from the two kind labels. The card
  renders only this summary block (duplicate raw start/end rows removed);
  receipts/history already persist the stored summary, so old rows render
  unchanged and old hashes still approve. Limits: BEFORE is the observed
  source at proposal time, not a live upstream claim (preflight still
  checks); the UI never parses prose back into times/identity.

  Tested facts (this worker, Chromium, real app + temp DB): timed card
  shows source + proposed offsets and approves to 1 write + verified
  receipt with a fresh rN; all-day fixture card shows `2026-10-13` →
  `2026-10-14` exclusive-end dates plus the timed conversion and approves
  once with old r1 retained. Kernel adds frozen-source, all-day, and
  upstream-advance invariants; `action_proposals` 15/15,
  `action_executions` 20/20 pass. Full unit has only the 2 pre-existing
  live-memory CLI prerequisite failures (ground truth, unrelated).
  Create verifies the FULL authoritative title, not the bounded display
  (2026-10-16 fix): `observation.title` stays 128-bounded for display, but
  both the strategy pre-verify and the terminal re-verify compare the FULL
  normalized title parsed from the canonical JSON `observation.text`
  (`authoritativeCreateTitleMatches` in `packages/kernel/src/calendar_tools.ts`;
  missing/malformed/non-string text titles fail closed, never a truncation
  fallback). A correct 129-char title now verifies; a same-128-prefix wrong
  suffix stays `succeeded_unverified` (pinned by
  `action_create_long_title.test.ts` 4/4 plus browser `create.spec.ts` 3/3).
  Provider side, a 2xx insert body that is empty or a JSON non-event
  (null/array/`{}`/wrong id) is `unknown` — only the exact requested stable
  id proves the commit (pinned by fork `googleCreate.test.ts`).

## M5 persisted write-grant auth (2026-10-16, no live writes)

Adopts the fork persisted-grant runtime (fork PR #4 review fixes) as the
recommended host flow: the normal-startup write child authorizes from the
out-of-band persisted grant file, with NO manual env secret copy. No live
Google mutation, no new consent, no reconsent, no deploy changes; readonly
`:3000` and the own `:3001`/launcher/store/creds paths unchanged.

- Fork landed as `cefb63c24f062ef6a49889d7b635330dee884f63`
  (tree `624968c65f499f5d30141f4d936aca66d016b531`, fork PR #4
  `feat/m5-allday-conversion` -> `main`; base `6939311` in ancestry, lock
  digest unchanged `63261d25…533`, write wire unchanged). The same reviewed
  head also rotates the readonly list/search schemas (single optional
  `account` string, bounded `pageSize`/`maxResults` default 20) — the host
  readonly pin is repinned alongside (see "read-only repin" below), so the
  write adoption and the readonly adoption agree on one fork commit. Host write
  pin repinned to the new source SHA/tree (branch + provenance comments
  updated; wire hash + identity + scope constants unchanged).
- Runtime auth (fork `src/reschedule/cli.ts`
  `resolveWriteRuntimeCredential` + `src/reschedule/writeTokenStore.ts`
  `loadWriteStoredGrant` / `updateWriteStoredAccessToken`): the account
  selector is EXACT `M5_RESCHEDULE_ACCOUNT` (fork `^[a-z0-9_-]{1,64}$`
  grammar — this codebase has no `M5_RESCHEDULE_ACCOUNT_ID`; display
  names/emails are refused). Explicit `M5_RESCHEDULE_*` env mode wins only
  when fully valid; ANY partial env credential refuses WITHOUT file
  fallthrough. Otherwise the per-account persisted grant (exact
  `https://www.googleapis.com/auth/calendar.events` scope + refresh
  token, written by the separate `auth:write` consent CLI) combines with
  the existing OAuth client registration (`loadCredentials`, client file
  via `GOOGLE_OAUTH_CREDENTIALS`). Missing/ambiguous/readonly-only/broad
  (`.../auth/calendar` anywhere)/mismatch grants refuse with NO readonly
  fallback; refreshed access tokens persist back atomically into the SAME
  per-account file (other accounts preserved, 0600). Production endpoint
  immutable: the shipped CLI never reads `M5_RESCHEDULE_TEST_*`.
- Live-wire re-probe 2026-10-16 at `cefb63c` against the REAL shipped
  production CLI (`build/reschedule-cli.js`) over REAL stdio with a temp
  exact-scope persisted grant + temp Desktop client file and file-only
  child env: `reschedule-event` hash `9f59e35b…8609d7`, byte-identical,
  pin unchanged (auth work touches credential resolution only).
- Recommended file-only operator setup (copy-pastable from the Companion
  checkout; secrets stay in files, never in env/DB/model messages — bind
  these once, then reuse verbatim): `WRITE_FORK` (a NEW dedicated
  clone/worktree path, e.g. `WRITE_FORK="$HOME/google-calendar-mcp-write"`
  — never `git checkout` a dirty working tree to reach the pin),
  `WRITE_ACCT` (the EXACT active Calendar selection `account`, e.g.
  `WRITE_ACCT="ops-write"` — must match `^[a-z0-9_-]{1,64}$`),
  `WRITE_CLIENT` (Google Cloud Desktop-app OAuth client JSON, `chmod 600`),
  `WRITE_TOKENS` (grant file, e.g.
  `WRITE_TOKENS="$HOME/.config/google-calendar-mcp-write/tokens.json"`,
  override `M5_RESCHEDULE_WRITE_TOKEN_PATH`; 0600; never the readonly token
  file — equal resolved paths refuse in the write child before any token
  load), `READONLY_TOKENS` (the custom readonly token path, only when one
  is configured).
  0. Verify the fork BEFORE `npm ci`/build/consent (the runtime only
     authenticates name/version/schema hash, so it cannot tell `cefb63c`
     from a stale or modified checkout — an unverified build could hand
     write-scope credentials to unreviewed code). Provision the dedicated
     path, then detach the exact pin (no destructive checkout of any
     existing tree, no force, no discarding user files):
     `git clone https://github.com/suiso11/google-calendar-mcp "$WRITE_FORK"`
     (or `git worktree add "$WRITE_FORK"` from an existing clone), then in
     `$WRITE_FORK`: `git fetch origin`, `git checkout --detach
     cefb63c24f062ef6a49889d7b635330dee884f63` (exact source commit),
     `test "$(git rev-parse HEAD)" =
     "cefb63c24f062ef6a49889d7b635330dee884f63"` (HEAD is the pin),
     `git merge-base --is-ancestor
     6939311fd3eae9846648e0a175e304c9500f578e HEAD` (readonly base in
     ancestry), `test "$(git rev-parse 'HEAD^{tree}')" =
     "624968c65f499f5d30141f4d936aca66d016b531"` (exact tree),
     `test -z "$(git status --porcelain)"` (no modifications — a dirty
     tree keeps the same commit id, so only a clean status proves the
     build matches the review), `node -e
     "const p=require('./package.json');if(p.name!=='@cocal/google-calendar-mcp'||p.version!=='3.0.0-readonly.2')process.exit(1)"`
     (package identity) and `sha256sum package-lock.json` starting with
     `63261d25` and ending `533` (full digest
     `63261d25…533`, unchanged from the readonly base). Only then `npm ci`
     (locked, reproducible — hooks run only AFTER the verification above)
     and `npm run build` (produces `build/reschedule-cli.js` AND
     `build/write-auth-server.js`; never reuse a stale ignored `build/` —
     remove this checkout's OWN `build/` first or build fresh).
  1. Prerequisites: the `$WRITE_CLIENT` file (`chmod 600`) plus the
     verified fork built above.
  2. Separate narrow consent (out of band, exact scope only, no
     calendar reads/writes, no write flags enabled) FROM THE FORK CHECKOUT
     — this repository's root `package.json` has NO `auth:write` script, so
     a bare `npm run auth:write` here fails before creating any grant:
     `npm --prefix "$WRITE_FORK" run auth:write -- --account "$WRITE_ACCT" --port 3500 --ttl-minutes 12 --no-browser`.
     Output: the per-account grant merged into `$WRITE_TOKENS` (0600).
     Routing smoke with NO OAuth server/network: `npm --prefix
     "$WRITE_FORK" run auth:write -- --help` refuses immediately
     (`write-auth: invalid account or arguments`, no listener, no network)
     — proving the script resolves in the fork package, not the root.
  3. Normal startup (defaults OFF unchanged): `COMPANION_ACTIONS_JSON`
     `{ "optIn": true, "writeEnabled": true }` (triple gate: opt-in pair +
     dedicated port on the ACTIVE Calendar instance) plus
     `M5_RESCHEDULE_WRITE_PROFILE=google-reschedule` and
     `M5_RESCHEDULE_CONNECTOR_JSON` with `{ "command": "node", "args":
     ["$WRITE_FORK/build/reschedule-cli.js"], "envAllowlist": [<SDK
     inherited names>, "GOOGLE_OAUTH_CREDENTIALS",
     "M5_RESCHEDULE_WRITE_TOKEN_PATH", "M5_RESCHEDULE_ACCOUNT",
     "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH"] }`, with
     `GOOGLE_OAUTH_CREDENTIALS` (`$WRITE_CLIENT`),
     `M5_RESCHEDULE_WRITE_TOKEN_PATH` (`$WRITE_TOKENS`), and
     `M5_RESCHEDULE_ACCOUNT` (`$WRITE_ACCT`) in the frozen startup env.
     `$WRITE_ACCT` MUST equal the active Calendar selection `account`
     whenever the selection carries one (exact, case-sensitive — host
     startup fails closed on mismatch, otherwise every approved action
     would fail the provider precheck AFTER the grant commit). The
     readonly-path name MUST be allowlisted whenever a custom readonly
     path is configured (`$READONLY_TOKENS` visible to the child — host
     startup fails closed when it is configured-but-hidden, otherwise the
     fork compares against the wrong default and can miss the collision).
     No `M5_RESCHEDULE_CLIENT_*` / `M5_RESCHEDULE_REFRESH_TOKEN` /
     `M5_RESCHEDULE_GRANTED_SCOPE` / `M5_RESCHEDULE_ACCESS_TOKEN` values
     anywhere. Explicit env credentials remain a SUPPORTED fork mode when
     fully valid; the host simply never needs them.
- Verification (Linux — scope labels accurate): AUTH-PARSE via the real
  CLI (`reschedulePersistedGrant.test.ts` 7/7 under explicit
  `M5_RESCHEDULE_FORK_CLI`: 1 file-only `tools/list` with pinned identity
  + hash, 6 refusals — missing account, readonly-only scope, broad scope
  alongside the exact token, foreign account, partial env WITH a valid
  grant file, write/readonly path collision — each exit 2 `auth_refused`
  with the grant file byte-identical; `tools/list` only, no refresh
  network, 0 Google writes) + NORMAL-HOST PIPELINE via the tracked
  contract-mirror fixture (`rescheduleWriteStartup.test.ts` file-only
  8/8, NO injected transport seam — the default production frozen-env
  factory spawns the `--file-auth` fixture child: 1 positive (zero secret
  values in startup env, staged approve -> exactly ONE conditional PATCH
  (`If-Match` = committed etag, start/end only) -> strategy readback ->
  verified `succeeded` receipt, grant file byte-identical, configured
  account == selection account), 3 omissions (account / grant path /
  client path each refuse with 0 patches, files unchanged), 1 frozen-env
  proof (post-start live mutation with valid alternative files cannot
  change the child values), 1 startup mismatch refusal (configured !=
  selection, no DB), 1 startup hidden-readonly-path refusal (no DB), 1
  host-level write/readonly collision refusal (0 patches, file unchanged).
  The fixture is a contract mirror, not the shipped CLI — labelled as
  such in the test header. Refresh
  persistence (bounded, same-file atomic merge) is covered by the fork's
  own suite (873 passed at `cefb63c`); the shipped CLI takes no test
  endpoint override, so no refresh/pipeline runs against production here
  by design. Full host gates re-run after the repin (record below).
  No user IDs/secrets in logs or tracked files; throwaway temp
  clients/grants/DBs removed after proof (sanitized aggregate PROOF.log
  only, ignored).
- Read-only repin to the same reviewed head (no new surface, no write
  from readonly): `apps/server/src/calendarReadonlyProfile.ts` now pins
  commit `cefb63c…` / tree `624968c…` (package, lock, wire identity, and
  scope unchanged) with live-wire hashes `01c3d647…` / `d94166b7…` /
  `8c6736e2…` (get-event byte-identical). Re-probed 2026-10-16 over REAL
  stdio against the real `build/index.js` with a temp readonly grant +
  temp client file and file-only child env (`tools/list` only, 0 Google
  writes, grant byte-identical). Permanent proof:
  `calendarReadonlyWireProbe.test.ts` 1/1 under explicit
  `M5_RESCHEDULE_FORK_CLI` (real entry, real `canonicalSchemaHash`,
  superseded literals rejected, skips cleanly when unset) +
  `calendarReadonlyProfile.test.ts` cutover boundaries (superseded
  6939311 hashes and the old array `account` form both fail closed).

## AV autonomy foundation — purposes/tasks/stop control + consumer UI boundaries (2026-10-16, observed)

Implements the AV01/AV03/local+global-stop foundation only (NOT all of
autonomy): session-owned purposes (create with scope/kind/provenance/
interpretation/applicability window, explicit correction appending a new
record while the original is preserved + superseded, revoke/achieve,
explicit pair conflict record — same-kind goals never auto-conflict),
explicit tasks (standalone or attached with scope inheritance, null
deadline default, start/hold with reason/resume with evidence + optional
explicit replacement parent/complete/cancel, revoke/correct/achieve of a
parent holds non-terminal dependents, blind resume 409s, permission
purposes are claims only and grant nothing), the durable global stop
control (CAS version, defaults paused, production restart fence re-pauses
a resumed control with version+1 and logs `restart_fence`), and the
consumer UI boundaries (statement-only correction preserves
kind/scope/interpretation/window from the selected record; task resume
reparents ONLY via the explicit replacement checkbox + evidence; purpose/
task selection clears drafts synchronously, late detail GETs are discarded
by selection generation, and every mutation CAS uses the captured
selected-view version so a backend mutation + refresh invalidates stale
drafts instead of applying them to the new version).

- Owned new sources: `packages/contracts/src/autonomy.ts` (DTO/error/
  scope-key contracts), `packages/kernel/src/autonomy.ts` +
  `packages/kernel/migrations/0011_autonomy.sql` (tables
  `autonomy_purposes/_events/_conflicts`, `autonomy_tasks/_events`,
  `autonomy_control`, `autonomy_activity`; CAS/versioned transitions),
  `packages/kernel/test/autonomy_slice.test.ts`,
  `apps/server/test/autonomy_http.test.ts`,
  `apps/server/e2e/autonomy.spec.ts` (permanent browser regressions),
  routes + UI in `apps/server/src/app.ts` /
  `apps/server/src/ui/client.ts` (`AutonomyPanel`) / `page.ts`.
- Next-worker interfaces (shadow + notification stages): repo surface
  `createPurpose/correctPurpose/revokePurpose/achievePurpose/
  recordPurposeConflict/createTask/startTask/holdTask/resumeTask/
  completeTask/cancelTask/getAutonomyControl/setAutonomyControl/
  applyAutonomyRestartFence/listAutonomyActivity/isAutonomousWorkAllowed`;
  idempotency scopes `purposeCreateScope/taskCreateScope/purposeOpScope/
  taskOpScope` + `IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL`; resume DTO
  `TaskResumeRequest{expectedVersion, evidenceKind, evidence,
  newParentPurposeId?}`; activity kinds `user_message/autonomy_stopped/
  autonomy_resumed/restart_fence/interrupted_note`; HTTP `GET+POST
  /api/autonomy/control {paused, expectedVersion}` (global, versioned),
  session `purposes|tasks|purpose-conflicts` CRUD + `correct|revoke|
  achieve|start|hold|resume|complete|cancel` transitions (all CAS 409 on
  `autonomy_version_conflict`, illegal lifecycle 409 on
  `autonomy_state_conflict`).
- Verified 2026-10-16: permanent `autonomy.spec.ts` 4/4 over REAL Chromium
  + REAL HTTP with a freshly built bundle (statement-preserve, explicit
  reparent, late-response draft guard purposes+tasks, stale-draft
  invalidation purposes+tasks); full default e2e 28 passed;
  `autonomy_http.test.ts` 3/3 + `autonomy_slice.test.ts` 11/11; Biome
  clean on changed files; root `tsc` shows only the pre-existing
  worktree `better-sqlite3` TS7016 environment noise (0 other errors).
  The earlier temporary `autonomy-proof.local.ts` harness (HTTP/Chromium/
  restart lifecycle) was deleted before commit; its log stays in tmp only.
- Remaining (NOT claimed): AV02 shadow, AV04 learning, AV05
  notification, AV06 priority, AV07 supervisor/reconcile, AV08
  maintenance/handoff.

## AV02 shadow-deliberation durable CORE — kernel/contracts only (2026-10-17, observed, branch feat/av-shadow-deliberation)

Implements the CONCRETE shadow kernel/contracts/durable core only (NOT the
full vertical): model proposals NEVER become execution authority. Actual
SQLite queue/projection/policy/transition API + runtime proof below.
The full vertical (model gateway service + HTTP + UI) is STILL IN PROGRESS
and arrives via the NEXT bounded worker; NO PR is published for this
branch until that lands.

- Owned new sources: `packages/contracts/src/shadow.ts` (strict MODEL
  output + job/context/policy DTOs + `shadowRequestScope`), migration
  `packages/kernel/migrations/0014_shadow.sql` (FOUR new STRICT tables:
  `shadow_scope_epochs`, `shadow_inbox`, `shadow_jobs`, `shadow_job_events`;
  BUNDLED_SCHEMA_VERSION 11 -> 12; Drizzle mirror in
  `packages/kernel/src/schema.ts`), `packages/kernel/src/shadow.ts`
  (ONLY writer of the shadow tables; `autonomy.ts` imports the enqueue /
  reconcile entries FROM it — never the reverse, enforced by the
  `ShadowPolicyReader` port the repository implements from existing
  getters), same-TX hooks in `packages/kernel/src/autonomy.ts`
  (purpose/task/conflict mutations enqueue; pause holds pending globally;
  resume skips paused-time inbox; restart fence reconciles), repository
  facade (`requestShadowDeliberation/listShadowJobs/getShadowJob/
  listShadowJobEvents/listShadowInbox/getShadowJobContext/claimShadowJob/
  completeShadowJob/holdShadowJob/failShadowJob/cancelShadowJob`).
- MODEL contract: decision execute|hold|ask|do-nothing + evidence ids
  (frozen sP/sT/sM/sF labels only) + brief reason (<=500cp, not CoT) +
  nullable structured action (kind/summary/optional LOCAL task draft) +
  completion + stop conditions + uncertainty + counterargument; strict
  unknown-field reject (no grant/permission/budget/bypass); task-draft
  deadlines only when matching the EXPLICIT deadline of a task ACTUALLY
  cited in evidence (windows are never deadlines, uncited dates rejected);
  execute requires an action, do-nothing forbids one. CODE policy (never
  model-chosen): shadow_only/missing_grant/
  wish_not_command/external_no_authority/needs_clarification/no_action.
  Recorded permission NEVER becomes a grant (CLAIM != GRANT: execute with
  or without a claim stays missing_grant); zero execution performed.
- Verified 2026-10-17: permanent `shadow_core.test.ts` 15/15 (ownership,
  atomic same-TX queue, stable-key replay/drift, epoch-drift hold,
  pause/restart holds, no-catchup, wish/external/missing-grant policies
  incl. WITH-claim still missing_grant, genuine do-nothing, strict
  rejects, foreground abort, redacted fail, scope-completeness overflow,
  time-applicability, deadline provenance); affected `autonomy_slice`
  11/11 + `migration` 21/21 + full kernel 545/545 + contracts 135/135;
  Biome clean; root `tsc` only the pre-existing better-sqlite3 TS7016
  noise; throwaway SQLite smoke (deleted after run): claim froze ctx (1
  purpose + 1 task, epoch 2, control v2) -> mid-call constraint held late
  output (scope_epoch_drift) -> fresh state completed missing_grant with
  zero grant/calendar/tool surface and 0 executions / 0 grants. Feature
  vertical STILL in progress (gateway/service/HTTP unstarted).
- Remaining (NOT claimed): model gateway, shadow service, HTTP routes,
  UI; then feature publication.
- Service+HTTP LIVE (2026-10-17, branch feat/av-shadow-deliberation):
  actual `startServer` + temp-DB + real HTTP app + real configured gateway
  to a synthetic loopback provider (NOT a real model): resume -> purpose ->
  1 native call -> stored MODEL execute -> CODE `missing_grant`, zero
  action_executions/proposals/memory-outbox; foreground chat preempts
  (`aborted_foreground`, ordinary `answer.submit` still completes); restart
  re-pauses with zero catchup/replay, fresh resume + new purpose deliberates
  exactly once. Production fixes: deliberation tool renamed to
  `autonomy_deliberation.submit` (two-dot name failed the shared
  `namespace.verb` gateway gate -> every real round trip `model_error`);
  bootstrap re-applies the shadow-priority repo wrapper after the gated
  rebuild (foreground notify/settlement wake were lost). Focused unit:
  `shadow_service_http.test.ts` 12/12 incl. wire-normalization regression;
  Biome clean; root `tsc` only pre-existing better-sqlite3 TS7016. Whole
  feature UI STILL IN PROGRESS (service/HTTP done, UI unstarted).
- Final review proof (2026-10-17, branch feat/av-shadow-deliberation):
  repaired OWN `packages/kernel` + `apps/server` `@types` links (they were
  absolute symlinks into the parent checkout, so the relative
  `@types/better-sqlite3` hop resolved to a store that lacks 9.6.0):
  replaced with real OWN dirs holding ABSOLUTE links to the OWN
  `node_modules/.pnpm/@types+better-sqlite3@9.6.0` (159-line DTS) and
  `@types+node@24.12.4` caches; root `tsc` now fully clean, zero TS7016,
  no shims/suppressions. Live-test fix (test-only, CSRF unchanged):
  `shadow_stop_abort_live.test.ts` now sends same-origin `Origin` on real
  loopback POSTs (Node 24 fetch emits `sec-fetch-mode`, so missing-Origin
  is browser-like -> 403). Verified: kernel `shadow_core` 19/19 +
  `autonomy_tools` 7/7, `shadow_service_http` 14/14,
  `shadow_deliberation_http` (envelope `{context,modelDecision}` read-only)
  1/1, `shadow_stop_abort_live` 1/1 (pure STOP aborts parked call,
  `control_paused`; sP999 -> `model_error` terminal + lease clear; GOOD
  next completes), production smoke (real `startServer` + real provider
  HTTP loopback) 17/17; `tsc` + Biome clean. UI browser proof STILL
  unverified (Chromium regression is the handoff).
- Shadow browser 4/4 Chromium (2026-10-17, branch feat/av-shadow-deliberation,
  fresh `build:ui`): `e2e/shadow.spec.ts` 4/4 green on real HTTP+SQLite+SSR
  (per-test fixture server + synthetic gateway). Retry button moved out of
  hidden detail (REAL SSR bug: uncertain POST retry was unreachable);
  test3 seeds scope-a+scope-b while paused so ask evidence sP1 exists in
  each frozen scope; test4 re-focuses composer after explicit STOP so the
  held landing alone proves no draft/focus/selection clobber. `tsc` + Biome
  clean.
- AV02 shadow-deliberation FULL VERTICAL published (2026-10-17, branch
  feat/av-shadow-deliberation, full acceptance observed): kernel durable
  core + model-gated shadow service + read-only HTTP + consumer UI. Model
  proposals NEVER execute: CODE policy `missing_grant` (claim != grant,
  with or without a permission claim), zero `action_executions` /
  proposals / memory-outbox writes.   Read-only views: scope purposes/tasks via repository getters
  (`ShadowPolicyReader.listScopePurposes/listScopeTasks`, no Markdown or
  memory connectors; labels/statement/interpretation/explicit deadlines
  only).
  Durable queue: explicit request persists, input-complete fences
  (foreground userMessage/retry/cancel aborts the shadow's OWN call only),
  STOP holds pending globally, restart fence re-pauses with zero
  catchup/replay. Frozen context: memory recall (when configured) is
  UNTRUSTED evidence, exactly ONE bounded gateway call per job
  (`autonomy_deliberation.submit`, ONE dot — the two-dot name failed the
  shared `namespace.verb` gate). UI `ShadowPanel`: latest-intent list/
  detail (held GET never restores stale selection), stable retry OUTSIDE
  hidden detail, XSS inert (`textContent`, no `img`/`script` nodes),
  composer draft/focus/selection never clobbered by STOP-held background
  output. Full proof: Vitest 136 files / 1557 tests passed (8 skipped,
  real remind CLI via `COMPANION_MEMORY_TEST_ENTRY`, LLM/vectors
  disabled); full default browser 32 passed (28 prior + new shadow 4);
  prior production smoke 17/17 real HTTP loopback (synthetic provider,
  NOT a real model); root `tsc` + e2e `tsc` exit 0; root Biome exit 0.
  Own `apps/server/test-results/` Playwright output removed + standard
  `test-results/`/`playwright-report/` gitignore added (own artifacts
  only). NO real model / GPU perf / Google writes / OAuth / user DB /
  device / listeners / grants claimed.
- Next-worker interfaces (AV05 notifications consumer, declarations only):
  kernel `completeShadowJob(jobId, …)` appends the terminal
  `shadow_job_events` row (completion note source) + `listShadowJobEvents`
  / `listShadowJobs`; task helper `appendTaskEventInTx` (module-private,
  via public task transitions) + `listAutonomyActivity`; server control
  hooks `shadowWake` / `shadowControlChanged` (app deps) =
  `ShadowService.wake()` / `notifyControl()` / `notifyForeground()` /
  `onRunSettled()`; UI `ShadowPanel.refreshList(): Promise<void>` +
  `ShadowPanel.selectJob(jobId, version): Promise<void>` (public).
  Remaining NOT claimed: AV05 notifications, AV06 shared resources, AV07
  external supervisor/recovery, AV04 methods learning, AV03 conversation
  task-proposals + actual pi-orch handoff, AV08 maintenance, unresolved
   device/standing/external rollout.
## AV autonomy base (2026-10-16, base-only, `feat/av-autonomy-continuation`)

Scope: durable purposes + explicit local tasks + global stop control
(schema 11) with HTTP/UI/control/fence wiring. Recorded `permission`
rows are claims only (no grant/capability/external write anywhere);
tasks never become calendar events; deadlines/validity windows are never
inferred (absent stays NULL, present must be strict explicit-offset
RFC3339, `validUntil` after `validFrom`). Two independent review bugs
fixed with behavior regressions (no source assertions): (1)
correction idempotency now presence-flags `validFrom`/`validUntil`
(omission=preserve vs explicit null=clear per field; same key + changed
command is `IdempotencyConflictError`; exact terminal replay stays
verbatim after later state changes; owner lookup before cache); (2)
purpose/task histories are bounded lossless pages (`afterSeq`+`limit`
default 50/max 200, `seq > cursor ORDER BY seq LIMIT limit+1`,
`events <= 200` + `nextAfterSeq: number | null`) across contracts,
kernel, facade, strict HTTP query routes (unknown/invalid queries are
400; ownership before history), and UI Load more with session/target/
generation stale-response guards; all audit rows immutable. Verified on
temp stores only (throwaways removed): contracts/kernel/server/root/e2e
`tsc --noEmit` exit 0 with genuinely green output (exact frozen offline
relink restored `@types/better-sqlite3`; no declaration-any,
suppressions, or tsconfig narrowing); focused Vitest 21/21
(`autonomy_slice` 15, `migration_create_0010` 3, `autonomy_http` 3,
incl. >=201-event consecutive-page exactness both layers and both
null-vs-omission directions/bounds); temp app-request smoke
(custom scope, explicit goal+validity, correction-vs-original
history/pagination, hold with separate reason/trigger, revoked parent
blocks resume until a NEW active same-scope parent, Stop/reopen paused
while chat 202, proposals 0); real-Chromium `e2e/autonomy.spec.ts` 2/2
(base lifecycle incl. guarded resume + 201-event UI Load more).
Limits: base-only (no v12 executions / pi bridge); history pages cap
200, lists cap 100; control gates only new autonomous background work.
Prior pin7b40/M6 fixes and historical records elsewhere are preserved.

## Autonomous trial execution (opt-in)

Strict opt-in workspace-trial runner (schema 12 trial authority). Unset
`COMPANION_AUTONOMY_JSON` (default) disables the whole path: no
proposals, grants, runner, or bridge spawn.

Relayed trial model calls carry a fixed `presence_penalty` of 1.0 (a
guest-sent value is ignored) to damp the token-level repetition loops that
previously aborted a write trial; guest observations also keep a bounded,
redacted `lastAssistantTail` so such aborts stay diagnosable.

### Configuration

- `COMPANION_AUTONOMY_JSON` must be one strict JSON object with exactly
  the profile block `{ available, enabled, mandatoryChecks,
  configFingerprint, sourceRevision, currentModel,
  disclosedWholeRepoRead, timeoutMs, maxOutputBytes, workspaceAlias,
  allowedPaths, modelRoute }` plus a `runner` block `{ nodeRealpath, bridgeScriptPath,
  bridgeConfigTemplatePath, systemctlRealpath, xdgRuntimeDir, relay,
  observe, pollMs }`, where `relay` carries `{ maxRequestBytes,
  maxModelCalls, maxOutputTokens, maxResponseBytes, perCallTimeoutMs,
  maxConcurrent }` and `observe` carries `{ activeTimeoutMs,
  goneTimeoutMs, pollIntervalMs }`. Every field is required; there are
  no defaults. Unknown keys, wrong types, or out-of-range values fail
  startup closed with a fixed safe message.
- `COMPANION_MODEL_JSON` is additionally required: without a model
  gateway there is no extraction and no trial model leg.
- The bridge path is the Own-pi wholejob capsule guest
  (`bridgeScriptPath` + `bridgeConfigTemplatePath`, spawned via
  `nodeRealpath` under a systemd scope checked via `systemctlRealpath`
  / `xdgRuntimeDir`). No other bridge is supported.
- The real-pi guest pins its own `--tools` allowlist after the launcher's
  injected list: `read,grep,glob` for read-only jobs and
  `read,grep,glob,write` for write jobs. Coordinator delegation tools
  (`task`, `wait`, `opencode_*`) are never exposed to the sealed guest.
- A guest that recovered from failed tool calls still completes when at
  least one call and the final call succeeded; the report records
  `guest recovered from N failed tool call(s) (unattested)`, while a
  trailing failure still downgrades the run to error.
- The bridge is launched with the approved write scopes and route; if it
  exits nonzero before writing a journal report (e.g. wire validation),
  the runner keeps a bounded (≤2048-byte) UTF-8-safe redacted stderr head
  and stores its lines as `report.unresolved` entries prefixed `bridge: `
  with a fixed summary, so the reason is visible instead of only
  `bridge-exit:N`; the same host-observed bridge failure reasons are
  mirrored in `report.hostDiagnostics` (bounded to 4 entries × 512 bytes).
- The wait for the capsule scope to reach `active` is floored at 60s (or
  the frozen trial budget, whichever is smaller), regardless of
  `observe.activeTimeoutMs`: real sealed startup covers frozen-snapshot
  verification plus the `systemd-run` containment preflight, so a 5s
  `activeTimeoutMs` would cancel healthy launches. The same stderr head is
  persisted as `hostDiagnostics` for a `stopped-before-active` launch
  failure.
- A pathless read-only trial (no literal patch paths) sends the frozen
  profile's `allowedPaths` as the wire `relevantPaths`, bounded to the
  16-path wire cap (still a subset of allowed scope); it never invents
  whole-repo `.`, which a scoped profile rejects (`exit 2`). Pathless write
  trials are still refused at stage time.
- A nonzero executor remains exit 10, but the journal report now carries
  bounded (2048-byte) redacted diagnostics: guest observation fields
  (`engine`, `executorKind`, `ompExitCode`, `timedOut`, tool counts,
  `error`) when `guest.json` exists, plus stdout/stderr heads.
- Stage-time validation mirrors the bridge's wire checks against the
  frozen profile, so a request that the bridge would reject never
  becomes a staged proposal. Literal patch paths must fall inside one of
  the frozen `allowedPaths` (segment boundary: `apps` admits `apps/x`
  but never `appsx`), and external-data consent is refused when
  `modelRoute` is not `external`. Failures use dedicated codes
  `trial_path_outside_profile`, `trial_external_consent_unavailable`,
  and `purpose_not_confirmed` (non-explicit/non-user goal), rendered as
  fixed Japanese notices by `/trials`.
- `bridgeConfigTemplatePath` is the FROZEN approved V2 OperatorConfig
  JSON, not a legacy template. For each manual execution it is parsed
  (`parseOperatorConfig`) and recomputed (`computeEffectiveProfile`);
  the effective fingerprint must equal `configFingerprint`, the
  operator-declared `active.configFingerprint` must match that computed
  value, `active.sourceRevision`/computed source revision must equal
  `sourceRevision`, and the sorted effective check IDs must equal the
  approved `mandatoryChecks`. Any mismatch aborts the claimed grant
  before boot as known quiescence (`config-setup`; never authorized).
  Its `profile.model.sockHostPath` is used verbatim, the parsed config is
  copied verbatim into the execution's private `0700` run dir as a
  `0600` file, and no active fingerprint is ever rewritten/recomputed.
  The manual relay budget is the template's storage/`limits` mapped to
  relay caps intersected with the host static `runner.relay` caps, so
  neither side can widen the other.

### UI staging (native /trials)

The native `/trials` page can create one DATA-only proposal without
leaving the UI. It first reads `GET
/api/sessions/:id/trial-profile` (pure read; fixed `trials_disabled` 404
when unset) for the frozen form facts: `workspaceAlias`,
`mandatoryChecks`, `allowedPaths`, `modelRoute`, the
`timeoutMs`/`maxOutputBytes` ceilings, and every allowed operation with
its derived `readOnlyMode`. Nothing on that
response is editable in the browser. The form then offers:

- target task (only session tasks in `open`/`in_progress`; there is no
  create-task path here, the hint links to 「タスク・目的」),
- objective, 1–16 acceptance lines, and 1–16 literal target paths,
- operation (`調査`/`実装`/`検証`/`保守（試行）`); `readOnlyMode` is
  derived automatically (`investigate`/`verify` = read-only),
- expiry (local `datetime-local`, default now + 3h, converted to an
  RFC3339 UTC instant),
- timeout / output cap (default = the operator ceiling, clamped to the
  ceiling and the schema minimum), external-data consent (default off),
  and the frozen `mandatoryChecks` shown read-only.

Submit is a `POST /api/sessions/:id/trials` with a fresh
`Idempotency-Key`; server error codes render as fixed Japanese notices,
and success refreshes the list and selects the new staged proposal.
Approval remains the separate explicit 「承認する」 button (unchanged).
The legacy `/legacy` trial panel is list/approve/expire only: this
staging form is native-only by design.

### Runtime behavior

- Startup boots with the global control paused; autonomous work starts
  only after an explicit resume (guarded: a revoked parent requires a
  NEW active same-scope parent before resume).
- Approval is explicit in the UI: one approval stages exactly one grant
  plus one execution UUID (`UNIQUE proposal_id` blocks double-approve).
  The runner executes strictly one claimed grant at a time.
- STOP revokes only `claimed` grants (`queued` survives; reclaim needs a
  fresh resume). Foreground work preempts background trials; shutdown
  drains the runner (bridge child reaped, no orphan scope).
- The relay binds its configured socket path exclusively and never
  unlinks an existing path before `listen`. An occupied path (including
  a stale socket/file with no listener) fails closed as `launch-failed`
  (`relay-start`); the operator must remove it. Only a relay that
  actually bound the path unlinks it on `close`.
- A trial that fails before its capsule scope starts (for example the
  bridge's containment preflight rejecting) keeps the bridge's own result
  line in the stored report (summary/unresolved/checks plus the observed
  exit code) and is never authorized; run the server with
  `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` exported so the user
  systemd bus is reachable.
- Every relayed model call is sent with `reasoning: "off"`: the sealed
  guest never sees thinking text, so unrequested hybrid-model thinking
  only burns the per-call timeout.
- An unknown execution raises a durable per-alias fence that denies
  further stage/approve/claim for that workspace alias until the exact
  fence row is cleared; unrelated scopes/aliases continue.
- Results are workspace trials only: journal lines always carry
  `productionApplied: false`, and trial completion never auto-completes
  the owning Task/Goal (they stay `open`/`active`).
- The sealed trial result is no longer journal-only: the bridge result
  line already carries the bounded report, and schema 33
  (`trial_worker_reports`, BUNDLED 33) persists it with the worker outcome
  in the same transaction. `GET /api/sessions/:id/trials/:proposalId`
  returns `report` = `{summary ≤2KB, findings ≤16×1KB, unresolved ≤8,
  checks [{name,outcome,exit}], artifact|null {sha256,entryCount},
  verified, provenance}`. Provenance is explicit: findings/summary/
  unresolved are `guest-reported-unattested` (plain text only, never HTML
  or authority); checks/artifact are `host-checked`. The server never reads
  the frozen bridge journal. `/trials` renders 報告 / ホスト検証 /
  ゲスト報告（未検証）/ 未解決, and a terminal chat trial card shows a
  one-line summary plus a link to `/trials`.
- Retained candidate review (read-only): a completed write trial keeps
  `<stateDir>/runs/<executionId>/artifact.json` plus `candidate/<path>` under
  the operator state root (stateDir is read from the operator template named
  by the trial runner). `GET /api/sessions/:id/trials/:proposalId/candidate`
  requires the stored host-checked `report.artifact` digest, re-hashes the
  exact artifact bytes (`candidate_digest_mismatch` on drift), re-hashes every
  candidate file, and enforces the grant's literal patch paths plus the
  profile write scopes. Base bytes come from the server's own configured
  source checkout (`sourceRepoPath`, emitted by the trial-operator builder and
  required when trials are enabled) via `git show <sourceRevision>:<path>`;
  a missing or mismatched base fails as `base_mismatch`. Pruned/absent runs
  fail closed as `candidate_unavailable` (404 when no artifact was stored).
  The response carries per-file kind/mode notes and a plain-text unified diff
  capped at 64 KB with a `truncated` flag; `/trials` renders it in a `<pre>`
  with fixed Japanese error messages and never interprets it as HTML.
- Human-clicked adoption (draft PR only): `POST
  /api/sessions/:id/trials/:proposalId/adopt` with the reviewed
  `artifactSha256` and an Idempotency-Key. The first click claims the
  proposal and pushes a `trial/<execution>` branch, then opens a DRAFT PR:
  201 with `{status:"done", branch, prUrl, errorCode:null}`. While that
  attempt is still running a concurrent click answers **202** with the same
  pending shape (never a second push); a replay after completion answers
  200 with the identical branch/prUrl (the executor runs once). A digest
  mismatch answers 409 `artifact_mismatch` without pushing. Adoption state
  is durable per proposal, so a server crash/restart during a push would
  otherwise leave `pending` forever: on startup any row still `pending`
  (this process owns no attempt) is settled as `failed` with the fixed
  `errorCode:"interrupted"` and the repo gets a best-effort `git worktree
  prune` (the temp worktree itself is gone with the OS tmp cleanup). A
  pending row older than 15 minutes is settled the same way on read or the
  next click, so a stale claim never blocks a retry.
- Verified 2026-10-17, synthetic only (fixed `synth-e2e-model` over a
  loopback relay, never a real model): full server A+B driver green —
  scenario A `consumed`/`authorized`/`bridge-exit:0` (12 model calls,
  all fixed-model, all within the 2048-token cap, unit gone, Task open,
  Goal active, git clean) and scenario B STOP `revoked`/unauthorized/
  `bridge-exit:143` with the unit gone. Evidence:
   `.all-plan-progress/AV-E2E-RESULTS.json` (`run7`); the throwaway
   `.e2e-trial/` driver was deleted afterwards.

## AV05 notifications durable core (kernel/contracts only, 2026-10-17, branch feat/av-notifications)
- Real owned immutable/deduped notification store + explicit acks + durable per-source cursors + explicit-deadline projection core (NO UI/SSE/service/PR in this slice; NEXT worker provides the real end-to-end surface). Migration 0014 (`notification_cursors` / `notifications` / `notification_acks` / `notification_deadline_schedule`, STRICT rowid tables; BUNDLED 14; note: 0013 was already the shadow single-claim index, so notifications took 0014) + Drizzle mirror + strict closed DTOs (`packages/contracts/src/notifications.ts`).
- Projection is boring+durable from EXISTING append-only sources in ONE atomic TX: `shadow_job_events` COMPLETED (validated immutable modelOutput + CODE policy; do-nothing => ZERO rows) + `action_receipts` actual `unknown`/`succeeded_unverified` => URGENT commitment notice with fixed safe content (fires while paused) + `autonomy_task_events` => derived deadline projection. Cursors baseline lazily at MAX(rowid) (no mass-notify of history); renumber/rebuild => honest `notification_projection_reset_required`, never silent skip. Dedup fingerprint = semantic state only (scope/epoch/kind/subject; excludes paraphrase/model text/job id). Ack = separate immutable receipt (stable-key replay, drift 409, foreign 404); reads never auto-ack; ack changes NOTHING else. Deadlines: user-explicit kind=task + speaker=user + non-terminal + strict-RFC3339 only (borrowed grammar + Date.parse, no new parser); full-iterate rebuild (213-task proof, no truncation); resume-cutoff stops offline catchup; (taskId, EXACT deadline) dedup through hold/resume; terminal drops only the derived row; paused/stale callers get honest zero recordings.
- No imports into the M5 receipt writer (old M6/v9 paths never need the new tables); no job enqueue from notification paths; claims never become grants (brief keeps the honest `missing_grant` diagnostic; zero executions/grants created); no model/tool/worker/calendar execution, no devices/push.
- Proof: new `packages/kernel/test/notifications.test.ts` 13/13 (real temp SQLite: real completed shadow jobs, real owned `unknown` receipt via existing stager+approval+execution service, real task deadlines; ownership/replay/drift/rollback/dedupe/do-nothing-0/claims-not-grant/ack-0-effect/urgent-while-paused/no-catchup/new-once/terminal-no-alert). Affected regressions green (migration 21 + autonomy 11 + shadow 19 + receipts 9 + proposals 12 + executions 20 + contracts); kernel + contracts `tsc` exit 0; Biome clean on touched files. Full 1557/32/17 suites NOT rerun (prior green preserved).
- NEXT service/HTTP/UI integration APIs (owned repo, sync): `ingestNotifications(sessionId, {now})`, `listNotifications(sessionId, query)`, `getNotification(sessionId, id)`, `getNotificationHistory(sessionId, id)`, `getLatestNotificationCursor(sessionId)`, `ackNotification(sessionId, id, {key, now})`, `buildDeadlineSchedule` / `reconcileDeadlineSchedule(sessionId, {now})`, `getNextDeadline(sessionId, {now})`, `recordDueDeadlines(sessionId, {expectedControlVersion, now})`. Full vertical (service/HTTP/UI) still IN PROGRESS.

## AV05 notifications projection boundaries (kernel/contracts only, 2026-10-17, branch feat/av-notifications)
- No first-source loss: migration 14 now INSERTs one cursor row per (pre-existing session, source) at that session's current MAX(source rowid, NULL key anchor), and an AFTER-INSERT-ON-sessions trigger starts every NEW session at rowid 0 / NULL anchor. The kernel NEVER lazily baselines at MAX on first ingest: a new session's FIRST completed job / first uncertain receipt notifies with NO prior ingest, while upgrading a populated v13 store never mass-notifies history. A missing cursor after migration/trigger is an honest `notification_projection_reset_required`, never a silent skip. Session-idempotent replay (no INSERT) never resets cursors.
- Anchored cursors: every advance stores the source KEY at the frontier rowid (`shadow_job_events.id`, `action_receipts.execution_id`, `autonomy_task_events.id`) in the SAME TX (NULL anchors grandfather migration baselines / fresh inits); before advancing the kernel verifies the rowid at the stored cursor still carries the anchored key for the OWN session. A rowid reuse carrying another immutable event's key at the SAME MAX surfaces an honest reset with ZERO partial progress (cursor untouched, no new notice). No external DB repair / auto-reset / forged history; UUID source originals preserved.
- Real pagination + pure reads: newest-page `listNotifications(sessionId, {limit, beforeSeq?, now?})` (`ORDER BY seq DESC`, LIMIT+1 probe, truthful `hasMore`/`nextBefore`) plus forward read-after `listNotificationsForward(sessionId, {after, limit?, now?})` (`seq > after ORDER BY seq ASC`, truthful `hasMore`/`nextAfter`), strict 1..100 caps, shared DTO mappers, unread counts excluding derived-outdated. Feed cursor GET stays a pure SELECT (no ack/ingest/baseline). 105-notice proof pages after=0 exactly once by seq with equal createdAt; foreign sessions never read/ack.
- Derived question expiry: `notifications.context_expiry_at` (nullable technical column) computed ONCE at creation as the min FUTURE boundary from the frozen job context (applicable-at-claim purpose `validUntil` + future cited EXPLICIT task deadlines; already-inapplicable/expired history never blanket-outdates; past cited deadlines never instantly expire a NEW post-deadline question; purpose windows never stored as task deadlines). Reads map `outdated` as stored-flag OR `expiry <= readNow` with NO stored mutation and zero unread; scope-epoch/terminal outdated paths unchanged; brief/ack paths stay authority-free (existing pure time grammar + Date.parse, no new parser/poll).
- Cleanup: the `reconcileDeadlineSchedule` alias (same-args call-through of `buildDeadlineSchedule`) is deleted with its exports/callers; startup uses the one real builder, ongoing projection uses the durable task-event cursor. New unpublished core, our code only.
- Proof: `packages/kernel/test/notifications.test.ts` 20/20 real temp SQLite (first-event-no-prime, v13-upgrade backfill, missing-cursor reset, same-MAX anchor reset with cursor/no-notice intact, 105-page forward+history exact-once with foreign 404s, window-expiry without source event + stored-no-mutate + old-expired-no-hold, post-deadline actionable + authority-free ack, replay-no-reset, plus the 13 prior). Affected green in ONE run: notifications 20 + migration 21 + autonomy_slice 11 + autonomy_tools 7 + shadow 19 + receipts 9 + proposals 12 + executions 20 + contracts 135 (15 files / 254 tests); kernel + contracts `tsc` exit 0; Biome clean on touched files. Full 1557/32/17 suites NOT rerun (prior green preserved).
- NEXT service/HTTP/UI integration APIs (owned repo, sync): `ingestNotifications(sessionId, {now})`, `listNotifications(sessionId, {limit, beforeSeq?, now?})`, `listNotificationsForward(sessionId, {after, limit?, now?})`, `getNotification(sessionId, id, {now?})`, `getNotificationHistory(sessionId, id, {now?})`, `getLatestNotificationCursor(sessionId)` (pure read), `ackNotification(sessionId, id, {key, now})`, `buildDeadlineSchedule(sessionId, {now})`, `getNextDeadline(sessionId, {now})`, `recordDueDeadlines(sessionId, {expectedControlVersion, now})`. Full vertical (service/HTTP/UI) still IN PROGRESS.

## AV05 notifications consumer UI vertical (2026-10-17, branch feat/av-notifications)
- Real `apps/server/src/ui/notification_panel.ts` (separate module, `shadow_panel.ts` pattern): durable paged history with honest unread + explicit older control, human-readable kind/scope/time/status (textContent only, no UUID wall/URLs), routine briefs ONLY on natural break (no active run + composer empty + visible) else quiet pending badge, routine questions grouped (general vs cited-TASK-deadline separate, `contextExpiryAt` never a deadline, locally re-checked via `Date.now()` before display, outdated stays history-only), urgent receipt alerts immediately even paused with zero focus/selection/composer interference, opening/reading never acks, explicit「確認済みにする」only (frozen key+N+{} in-memory same-key retry, no body in localStorage), session generations + feed abort on switch/destroy, cursor-baseline-first boot with seq dedup, durable `?after=` SSE reconnect, source button ONLY the existing readonly `ShadowPanel.selectJob(jobId, version)` seam (no fake buttons, no approval/action dispatch, no draft-loss forcing). Wired in `page.ts` (`#notifications` SSR) + `client.ts` boot (natural-break + composer hooks).
- Backend safety cleanup (HTTP only, kernel test-clock injection untouched): production reads use the trusted server clock (`now()`), `?now=` is strict 400 on all four read paths via app-local `omit({now:true})` schemas (single-field read schema omits to strict empty); cursor/seq reads additionally require `Number.isSafeInteger` (SQLite-unsafe magnitudes 400, no new arbitrary bounds).
- Proof: `apps/server/test/notifications_live.test.ts` 6/6 (5 prior + new trusted-clock/safe-int HTTP regression, real temp SQLite + app HTTP + real production `startServer` shutdown-open-feed smoke); NEW `apps/server/e2e/notifications.spec.ts` 4/4 Chromium (real per-test fixture `notifications_fixture.ts`: real kernel seeding, production bundle via `build-ui.mjs`): routine-defer/group+XSS-inert, urgent-paused-no-clobber, aborted-ack-frozen-retry-one-receipt-no-authority-change, old-session-hold-no-clobber + >50 older paging. Server `tsc` exit 0; Biome clean on touched files; full/default suites NOT rerun (prior 32 preserved).

## AV05 notifications full vertical published (2026-10-17, branch feat/av-notifications, stacked on feat/av-shadow-deliberation)
- Complete: durable projection (migration 14, anchored cursors, new-session trigger, explicit-deadline schedule + derived question expiry) + background service (bounded-drain wake, HTTP paged read + explicit ack, SSE bootstrap drain) + conversation-safe consumer UI. Reads never auto-ack; claims never become grants (zero executions); no model/tool/worker/calendar execution, no devices/push.
- Review fixes on this branch: `02de175` deadline keyset drain (no 100-row silent truncation), pending-timer single-arm, backlog continuation converge, frozen-window expiry; `c413d09` five UI races (checkpoint/delivery/ack/view) with browser proof (`apps/server/e2e/notifications.spec.ts` now 8 = original 4 + new 4; new 4 failed before the fix, pass on the rebuilt bundle). Own `@types` absolute-link repair preserved; no shims/casts/ts-ignore.
- Proof prior slices (commits on this branch, NOT rerun here): full Vitest 138 files / 1583 passed (8 skipped); Chromium 36 green (incl. notifications 8/8); root/e2e `tsc` + Biome green at acceptance.
- This slice observed: focused Vitest 4 files / 30 passed (`notifications` 20 + `notification_review_fixes` 3 + `notifications_live` 6 + `notification_review_backlog` 1, real temp SQLite); root `tsc` exit 0; e2e `tsc` exit 0; `biome check .` exit 0 (1 pre-existing warning + 1 info only). Fixed 4 implicit-any TS7022 in `getNextDeadline`/`recordDueDeadlines` keyset pages with explicit `DeadlineScheduleRow[]` annotations (no casts added).
- Boundaries: no real model / Google writes / OAuth / user DB / runtime authority claimed; upstream core4/UI5 review threads noted as fixed locally, upstream review itself not claimed.

## AV03 conversation-proposal durable CORE — kernel/contracts/tools only (2026-10-17, observed, branch feat/av-conversation-proposals)
- Proposal-only staging core (NO HTTP/UI/service in this slice; NEXT worker owns the HTTP + UI vertical; NO PR published). Migration 0015 (STRICT `conversation_proposals` / `conversation_proposal_events`, BUNDLED 14 -> 15; touches no existing table) + strict DTOs (`packages/contracts/src/autonomy.ts`: `PurposeProposeRequest` / `TaskProposeRequest` / `ConversationProposalView` / `...ListResponse` / `...AcceptRequest|Response` / `...RejectRequest|Response`) + kernel core (`autonomy.ts`, ONLY writer; `repository.ts` facade; canonical `conv_proposal_stage|accept|reject` v1) + two native proposal-only tools (`purpose.propose` / `task.propose`, single-dot, `createConversationProposalRegistrations`, wired in `bootstrap.ts` agent broker; agent JSON schemas `AGENT_PURPOSE_PROPOSE_PARAMETERS` / `AGENT_TASK_PROPOSE_PARAMETERS` — model supplies scope/draftKind/kind/quote/interpretation + explicit parent for tasks; NO source/run/turn/date fields, strict unknown-field reject).
- Guarantees: server-derived source (session/run/turn from `ctx.runId`, CURRENT ordinary `user_text` body only; action-approval turns fail closed); `sourceQuote` immutable exact substring (purpose <=2000cp, task <=256cp; separate interpretation, never merged); `sourceKind` hardcoded `model`; NO model dates (NULL deadline/window unless trusted human supplies explicit strict-RFC3339 at accept); task drafts REQUIRE explicit owned active same-scope parent (checked at stage AND re-checked at adopt); staging creates NO purpose/task/grant/calendar/notification and never touches stop control; adoption is ONE atomic TX (accept creates purpose|task + acceptedTargetId link + decision history); idempotence (broker dedup + semantic exact-input hash replay + stable-key accept/reject replay; stale-version 409, drifted-key 409).
- NEXT HTTP/UI handoff (exact, declarations only): kernel `stageConversationProposalFromModel(runId, {target, scope, draftKind, purposeKind?|taskKind?, sourceQuote, interpretation, parentPurposeId?, expectedParentVersion?}, {key})`, `listConversationProposals(sessionId, {limit?, cursor?, status?}) -> {items, nextCursor, hasMore, pendingCount}`, `getConversationProposal(sessionId, id)`, `acceptConversationProposal(sessionId, id, {expectedVersion, deadline?, validFrom?, validUntil?}, {key, now}) -> {status:201, body:{proposal, purpose|null, task|null}}`, `rejectConversationProposal(sessionId, id, {expectedVersion}, {key, now}) -> {status:200, body}`; UI/HTTP MUST send the CURRENT user-visible body with `sourceQuote` as exactly one verbatim occurrence in it and human-explicit dates only (never model-inferred); adopted purpose keeps quote+interpretation with `sourceKind:self, explicit:false`, adopted task keeps quote as title / interpretation as body / `speaker:self` / parent link, `proposal.acceptedTargetId` = created id.
- Proof (this slice, observed): `conversation_proposals` 12/12 (real in-memory SQLite + real migrator + real ToolBroker, zero mocks) + affected `autonomy_slice` 11/11 + `autonomy_tools` 7/7 + `migration` 21/21 (4 files / 51 tests); live smoke (real broker + real SQLite): `purpose.propose` succeeded -> pending (`sourceKind:model`), identical replay `deduplicated` (1 proposal row), manual accept 201 with `purpose.sourceKind:self`, `acceptedTargetId` linked, 1 purpose / 0 tasks / 0 grants; root `tsc --noEmit` exit 0; Biome clean on touched files. Full 1557/32/17 suites NOT rerun (prior green preserved).

## AV03 conversation-proposal FULL VERTICAL published (2026-10-17, observed, branch feat/av-conversation-proposals)
- Complete: proposal-only kernel core (migration 0015, atomic trusted adoption) + session HTTP review/adopt routes + quiet consumer UI review drawer + native propose-to-human-adopt kernel proof. No PR published for this branch; review findings pending.
- HTTP (`apps/server/src/app.ts` + `apps/server/src/ui/proposal_panel.ts` wiring, `apps/server/src/ui/client.ts|page.ts`): session `GET/POST /api/conversations` handoff extended with `list/get` (200) + `accept` (201 on first create, frozen same-key retry) + `reject` (200); UUID/Idempotency-Key/CSRF/error/503-drain/CAS patterns preserved; adopted purpose keeps quote+interpretation (`sourceKind:self, explicit:false`), adopted task keeps quote as title / interpretation as body / `speaker:self` / parent link.
- UI (`proposal_panel.ts`, 598 lines): quiet review drawer (badge + natural-break brief, quote apart from interpretation, immutable parent title, human-only strict dates, frozen same-key retry, `textContent`-only inert markup).
 - Proof (integrated acceptance ONCE, this worktree, observed): `node scripts/build-ui.mjs` rebuilt; full Vitest 143 passed / 2 skipped files, 1606 passed / 8 skipped tests (real remind CLI via `COMPANION_MEMORY_TEST_ENTRY` + template, LLM/vectors disabled); default Chromium 42 passed (28 prior + shadow 4 + notifications 8 + proposals 2: adopt/reject, parent/deadline, inert markup, reload-once); root `tsc` exit 0; e2e `tsc` exit 0; `biome check .` exit 0 (1 pre-existing warning + 1 info only). Own `@types` absolute-link repair preserved; no shims/casts/ts-ignore. No real model / Google writes / OAuth / user DB / device / listeners / grants claimed.

## AV background resources review fixes (2026-10-17, branch feat/av-background-resources)
- Shared background admission (`apps/server/src/background_resource.ts`, bootstrap-owned, injected into memory + shadow): at most ONE model-heavy background unit at a time across memory post-completion extraction, shadow deliberation, and idle-owned remind cultivation (`runIdleDistill`). Foreground work (ordinary chat, explicit UI search/stage/recall, notification projection) NEVER acquires it and is never blocked by it. Identity-token reservation: `tryAcquire` admits only when open AND unheld; `release` frees only on token match (stale owners free nothing); each release runs registered wakes at most once; `close` (STOP/shutdown) admits nothing new; `shutdown` clears wakes.
- Four P1 integration defects fixed (independent review), all with consumer-boundary regressions:
  1. Restart admission now initializes CLOSED from the ACTUAL persisted `autonomy_control` row AFTER `applyAutonomyRestartFence` and BEFORE services start (`bootstrap.ts`): a fence-paused restart's first ordinary chat runs zero background extraction until an explicit current-version resume reopens admission. Ordinary chat + explicit memory management stay available while paused.
  2. STOP/foreground preemption aborts ONLY background-owned in-flight work: the parked extraction gateway call plus tracked automatic-distill CLI children (per-job controllers, whatever tick launched them). Explicit manage/foreground-recall calls are never aborted; closing the gate is not itself an abort — an automatic lease releases only after its guarded call settles (no late-child overlap).
  3. Automatic `maintain.distill` (the one outbox op that launches the remind local LLM) admits the shared unit at its OWN execution boundary inside `drainOnce`, on EVERY caller path (completion, recovery, idle). A busy/closed gate skips ONLY that execution: still pending, attempts/backoff untouched (no busy-fail, no backoff poisoning), and the tick continues with the next eligible job (no head-of-line starvation). The outbox due-selection is a read-only read, so a skipped job needs no unclaim. Foreground/STOP abort a distill child even from completion/recovery ticks (tracks the actual background controller, not an idle-origin flag). The CLI-child signal path is honest: it cannot observe remind-internal compute beyond serializing our calls plus every gateway call (no GPU/resource coverage claimed).
  4. The batch-wide idle gate is removed: explicit operation-linked work (`record.retire`/`record.reactivate`, correction `event.append` + `record.correct`) always drains, even while STOP closed the gate; automatic distill beside it stays durable pending. Eligibility is the trusted operation linkage (FK/metadata), never a model-assumed body field; both correction steps stay linked; foreground intent never authorizes autonomous distill.
- Proof (this worktree, observed): unit `background_resource.test.ts` 15/15 (10 prior incl. max-concurrency-1 contention, busy-defer-then-complete, parked-extraction abort, STOP-close/reopen, held-gate idle defer + foreground-recall pass-through; 5 new P1 boundary tests, each failing on the pre-fix shape); neighboring `memory_service` + `memory_manage` green; live `background_resource_live.test.ts` 2/2 with REAL production `startServer` + REAL remind CLI (temp DB/vault, `vectors/llm.enabled=false`, env `COMPANION_MEMORY_TEST_ENTRY=/home/molmot/remind/dist/src/cli.js` + sibling template) + synthetic loopback model over real sockets: (a) prior max-BG1 contention / foreground-preempt / STOP-abort proof preserved (~4.5s), (b) NEW restart/STOP-management proof (~33s): first chat cultivates (`event.append` acked), STOP leaves a due distill pending while HTTP search + staged retire/reactivate/correct each reach terminal `acked` with zero new chats, restart with control still paused serves ordinary chat with ZERO new extraction calls and ZERO outbox rows for the new run, and an explicit current-version resume reopens cultivation on the next chat. `tsc --noEmit` exit 0; Biome on touched files clean. Limits: synthetic gateway only (no real-model result, no GPU/hardware claim); remind-internal local compute (embeddings/vectors) not observable beyond call serialization; Windows manual smoke remains open.

## AV07 external supervisor (2026-10-17, branch feat/av-supervisor, local only, no PR)
- Opt-in FOREGROUND process manager for the fixed own server entry (`apps/server/src/index.ts` via current Node + cached tsx loader, `shell:false`, no arbitrary command). Same env as `pnpm start` (same DB/model settings, no new provider/budget). Files: `apps/server/src/supervisor.ts` (state machine: spawn gate, crash budget, lock, IPC vocab), `apps/server/src/supervisor_cli.ts` (`supervise` script), `apps/server/test/supervisor.test.ts`, IPC hooks in `apps/server/src/bootstrap.ts` (gated on supervisor-set `COMPANION_SUPERVISED=1`; normal vitest workers send/receive nothing).
- Usage: `pnpm --filter @companion/server supervise start|stop|resume|restart|status|service-print` (foreground `start` also takes stdin `stop|resume|restart|status|help`; SIGINT/SIGTERM to the supervisor = operator stop). `stop` persists stop BEFORE child termination; relaunch holds until explicit `resume` (also resets crash budget); `restart` = planned restart at the graceful-drain safe boundary only (drain failure HOLDS, never force-kills); `service-print` prints a sample unit and NEVER installs/enables anything.
- State: `<dbdir>/supervisor/supervisor-state.json` (+ `supervisor.lock` + `supervisor-mutex.sqlite`), private 0600, atomic tmp+fsync+rename, symlink-guarded, version 1, fixed vocabulary only (`none|operator_stop|operator_resume|crash|startup_failed|address_in_use|newer_database|drain_failed|planned_restart|exhausted`, counters, nonce; no conversation/model/credential content). Single instance via exclusive lock whose inspect-decide-reclaim runs INSIDE the OS-backed SQLite mutex (`BEGIN IMMEDIATE`, existing better-sqlite3, no new deps): two starters racing a stale dead-PID lock serialize (at most one owner); live/ambiguous EPERM/unparseable/mutex-contention fails closed, never kills any PID; port collisions degrade to bounded retry, foreign listeners never touched. EVERY state read-modify-write (stop/resume/restart, ready, crash budget, drain hold) commits inside the same mutex on the LATEST state, so a concurrent operator stop is never overwritten by stale bookkeeping (ready never clears STOP/hold; crash accounting never clears STOP/hold; a failed commit HOLDS and retries the commit, never the child).
- Crash budget: existing MCP schedule `nextBackoffMs` = 1s/2s/5s/10s/30s then hold (MAX_CRASH_RESTARTS=6); ready does NOT reset the budget (only genuine operator resume does); crash never creates operator stop; supervisor resume NEVER resumes autonomy (server restart fence re-pauses background intent); unbootable/newer schema holds with the DB preserved (never restores backup); unknown-commit rows stay durable and are never retried.
- Proof (this worktree, observed): unit `supervisor.test.ts` 10/10 (spawn gate incl. stop-persist/relaunch-hold/resume-reset, budget schedule + ready-keeps-budget, port-collision retry, newer-schema hold, stale-lock release + ambiguous fail-closed, fixed-vocab state, unreadable-state fail-closed); gated IPC live smoke with real `supervise start` on temp DB (port 48792): genuine `companion-ready` after listen (`supervisor: server ready on 48792`), SIGTERM persisted `operator_stop` BEFORE termination then graceful drain (`server.draining`/`stopped signal`) with lock released and port closed, relaunch printed `held: operator stop` and spawned nothing, `resume` cleared stop and reset budget; same-DB tables retained. P1 consumer fault/concurrency regressions `supervisor_p1.test.ts` 7/7 (real files/processes/IPC, root-safe directory-at-path fault fixture): failed stop write holds the live child with no stop message and unreadable-state fail-closed; cross-process stop racing startup survives the mutex read-latest ready commit (plus crash-never-clears-stop unit); two processes on a stale dead-PID lock serialize to exactly one owner with no foreign kill and lock released; drain-failed keeps the live child in DRAINING with a persistent hold cleared only by explicit resume; timeout and exit-without-ack HOLD while a real `companion-drained` gates respawn; failed crash-budget write holds without spawning and the same accounting commits exactly once when durable. Live planned-restart smoke with real `supervise start` on an OWN ignored-workspace temp SQLite DB (port 48972, this worktree): ready-1 with autonomy `paused:true/default_paused`, created session `adb7cea6` history 200; CLI `restart` while running → ready-2 (affirmative-ack respawn, same DB, `plannedRestart=no`), session history still 200 (conversations retained), autonomy still `paused:true`; CLI `stop` → `held: operator stop` with no spawn; CLI `resume` → ready-3, `lastReason=operator_resume`. No pure-state echo stands in for readiness: every ready above is a genuine `companion-ready` after listen. `tsc --noEmit` (root + e2e) exit 0; `biome check` clean on all touched files. Full 1606/42 suites NOT rerun (prior green preserved).
- Limits: OS boot registration NOT activated (foreground only; `service-print` prints a never-installed sample, activation needs a host-operator grant outside this codebase); Windows manual smoke unavailable (honest open); two pre-existing orphaned `supervisor_cli.ts start` processes (PPID 1, predating this session) left untouched — ownership unverifiable from this scope, reported for the owner to reap.

## AV04 learning vertical — durable hypotheses + anchored evidence + reevaluation (2026-10-17, observed, branch feat/av-learning from feat/av-supervisor)
- Complete vertical: migration 0016 (STRICT `learning_hypotheses` / `learning_evidence` / `learning_hypothesis_events`, BUNDLED 15 -> 16; touches no existing table; ONLY writer is `packages/kernel/src/learning.ts`) + strict DTOs (`packages/contracts/src/autonomy.ts`: kind method|hypothesis, status open|supported|refuted|retired, origin human|model, staged/pending + CAS version, polarity supports|refutes|neutral, source vocabulary shadow_job|conversation_proposal|action_receipt|task_event) + kernel core + `repository.ts` facade + model tools (`packages/kernel/src/learning_tools.ts`: `learning.list` / `learning.open` read-only labeled, `learning.propose` proposal-only staged pending, strict input rejects status/source) + session HTTP routes (`GET/POST /learning/hypotheses`, `GET` open + evidence, `POST` transition/evidence/accept/reject; paged/owned/idempotent, CAS 409s, 404 ownership) + consumer UI (`apps/server/src/ui/learning_panel.ts`: explicit create, review drawer, frozen same-key retry, selection-bound unresolved-op pin,「仮説」badge + counts +「要再評価」flag; wired in `client.ts`/`page.ts`; `playwright.config.ts` gains `learning.spec.ts`).
- Guarantees (pinned by regressions): learning NEVER mutates purposes/tasks/control/grants/budget/notifications (migration has no such columns; smoke + consumer tests re-read control/purpose before/after); status ONLY via explicit human CAS transition (support/refute/retire; success evidence never flips status; refuted stays labeled refuted, never surfaced as fact); model `learning.propose` stages pending only (server-bound run+turn, ordinary `user_text` only; direct staged transition fails); rejected conversation proposal anchors ONLY `refutes` (rejected+supports and accepted+refutes fail; attaching creates no purpose/preference/permission); revocation/supersede of a parent purpose flags in-scope hypotheses `needs_reevaluation` in the SAME tx (no auto-cancel/resume, idempotent; cleared only by explicit human transition); no routine notifications; every read DTO carries the explicit hypothesis label (kind + status + evidence counts).
- Proof (this worktree, observed): kernel `learning.test.ts` 9/9 (real kernel repository + migrator + ToolBroker, in-memory DB, zero mocks) + affected `autonomy_slice` 11/11 + `autonomy_tools` 7/7 + `conversation_proposals` 12/12 + `conversation_proposal_agent_adopt` 1/1 + `conversation_proposal_review_fixes` 6/6 + `agent` 32/32 + `agent_tool_schemas` 9/9 + `migration` 21/21 (9 files / 108 tests); server `autonomy_http` 3/3 + `conversation_proposals_http` 6/6 + `conversation_proposals_paging` 2/2 + `routes` 33/33 (4 files / 44 tests); real-`startServer` temp-SQLite HTTP smoke (proper Origin, own temp removed): hypothesis created, `refutes` evidence attached from a REAL rejected conversation proposal with control+purpose byte-identical before/after, CAS support -> `supported` v2, revoke parent purpose -> `needsReevaluation:true` with status still `supported`; `node scripts/build-ui.mjs` rebuilt + Chromium `e2e/learning.spec.ts` 2/2 (explicit create/refute-stays-refuted + revoke-flags-reevaluation, reload-stable); root `tsc` exit 0; e2e `tsc` exit 0; `biome check .` exit 0 (1 pre-existing warning + 1 info, untouched files). Full old suites NOT rerun (prior green preserved). Smoke scaffold removed; no PR published for this branch.
- Review fixes (2026-10-17, same worktree, observed): (1) agent advertises `learning.list` / `learning.open` / `learning.propose` with explicit closed schemas (`agent.ts`; verified in the advertised tool definitions, never skipped); (2) hypothesis `scope` filter pushed into kernel SQL (covered by `idx_learning_hypotheses_scope`) so an older in-scope row is never hidden behind 100 newer other-scope rows, and `learning.list` reports the kernel LIMIT+1 `hasMore` truthfully; (3) evidence reads paged oldest-first via keyset `limit`/`cursor` (`nextCursor`/`hasMore`, never truncated) end-to-end (kernel -> repository strict query -> HTTP `limit`/`cursor` -> panel「古い証拠を読み込む」); (4) explicit human `reaffirm` transition (contract enum + migration `reaffirmed` event + CAS core + `POST .../reaffirm` route + panel button): keeps status, clears a pending `needs_reevaluation` notice, allowed only while the notice is set, audited; (5) scope-changing purpose correction flags the OLD scope (and the new one when different); (6) a stale loaded version 409s after a revocation flag instead of clearing it (the flag itself bumps `version` under CAS `AND version = ? AND needs_reevaluation = 0`, pinned v2 -> v3); (7) both panels merge (never clear) the newest page, direct-fetch a missing selection, and close the drawer only on server 404; (8) definitive 409/400 clears the frozen op with a retype message (an identical retry could never succeed) while network loss and 5xx keep it; (9) unknown-source evidence 404 keeps the drawer and typed inputs; (10) new `learning_http.test.ts` pins the HTTP scope/cursor/reaffirm seams. Proposal-panel parity: same merge/direct-fetch/404-close refresh, 409-clear + 400-clear (drawer + typed dates kept for correction), network/5xx keeps the frozen op. Proof (this worktree, observed, after a Biome `--write` limited to the 15 touched files): focused Vitest 21 files / 250 tests pass (kernel learning 9 + learning_review_fixes 7 + autonomy_slice 11 + autonomy_tools 7 + agent 32 + agent_tool_schemas 9 + agent_tool_name_wire 2 + agent_review_fixes 7 + conversation_proposals 12 + adopt 1 + proposal_review_fixes 6 + migration 21 + migration_create_0010 3 + tool_broker 68; server learning_http 2 + autonomy_http 3 + conversation_proposals_http 6 + paging 2 + routes 33 + proposals 6 + proposal_approval_replay 3); root `tsc` exit 0; e2e `tsc` exit 0; `biome check` on all 15 touched files exit 0 and full `biome check .` exit 0; production-bundle Chromium `e2e/learning.spec.ts` 6/6 and `e2e/conversation_proposals.spec.ts` 6/6 (via `apps/server/playwright.config.ts` webServer; a root-dir run without that config fails on `/reset` ECONNREFUSED and proves nothing). Full old suites NOT rerun. No debug scaffolds found in the touched files; untracked `node_modules` and `docs/plan/*_2026-10-10.md` are not this worker's and were left uncommitted.
## AV03 delegation-handoff vertical — human-driven pi-orch records + per-criterion verify + reevaluation (2026-10-17, observed, branch feat/av-handoff from feat/av-learning)
- Complete vertical: migration 0017 (`delegation_handoffs` / `handoff_attempts` / `handoff_events`, touches no existing table; ONLY writer is `packages/kernel/src/handoff.ts`) + strict DTOs (`packages/contracts/src/autonomy.ts`: opScope investigate|implement, environment sandbox|production, retry cause transient_infra|worker_error|criteria_unmet|environment, status prepared|dispatched|reported|verified|failed|cancelled, CAS version + needsReevaluation + activeAttempt) + kernel core (CAS mutations, version-bumping same-TX `flagHandoffReevaluationInTx` hook called from `autonomy.ts` revoke/supersede paths, deterministic `buildHandoffSpec` plain text) + `repository.ts` facade + model tools (`packages/kernel/src/handoff_tools.ts`: `handoff.list` / `handoff.open` read-only labeled; no write registration exists; foreign ids fail closed as `execution_failed`) + session HTTP routes (`GET/POST /handoffs`, `GET` open + `GET .../spec` text + events + attempts, `POST` dispatch/report/verify/fail/cancel/abnormal-exit/attempt/reaffirm; keyset `limit`/`cursor` + activeCount tracking, idempotent replay, drifted-key 409, stale-CAS 409, foreign 404) + consumer UI (`apps/server/src/ui/handoff_panel.ts`: explicit create, frozen same-key retry OUTSIDE the hidden drawer, selection-bound unresolved-op pin, merge (never clear) refresh + direct-fetch + 404-close, definitive 409/400 clears with retype message while network loss keeps the op,「引継ぎ」badge + counts +「要再評価」flag; wired in `client.ts`/`page.ts`; `playwright.config.ts` gains `handoff.spec.ts`).
- Guarantees (pinned by regressions): execution is NOT automated (panel + spec text record only what a human pastes into pi-orch manually; no process spawn, no worker run, no task auto-complete — verify never completes the task); handoff NEVER mutates purposes/tasks/conflicts/grants/controls/budgets/permissions/notifications/calendar (budget entries are human TEXT labels only, no numeric column exists so no numeric cap is invented or enforced); frozen criteria immutable (change needs a NEW superseding handoff, old row preserved, `superseded_by` links forward; verify needs a pass + evidence result for EVERY frozen criterion, all passing — any fail/missing/duplicate/out-of-range refuses); sandbox reports are UNTRUSTED verbatim claims that never set production (no production column); retries are explicit human attempt rows with a REQUIRED closed cause (no automatic retry, no timer); boundary flags grant nothing — every flag REQUIRES SEPARATE AUTHORIZATION (permission decision stays pending outside this record); parent-purpose revoke/supersede flags in-scope active handoffs `needs_reevaluation` in the SAME tx (flag bumps version under CAS so stale dispatch 409s; new dispatch refused while set; cancel always allowed; clearing only via explicit human reaffirm); handoffs created under an already non-active parent start flagged.
- Proof (this worktree, observed): kernel `handoff.test.ts` 11/11 (real kernel repository + migrator + ToolBroker, in-memory DB, zero mocks) + affected `agent` + `agent_tool_schemas` + `autonomy_slice` + `autonomy_tools` + `learning` + `migration` + `tool_broker` + server `handoff_http` 3/3 + `autonomy_http` + `learning_http` + `routes` (12 files / 209 tests); real-`startServer` temp-SQLite HTTP smoke with proper Origin (own temp removed): create from task, dispatch, sandbox report stored verbatim, per-criterion verify -> `verified` with task still `open`, revoke parent -> second handoff flagged + dispatch 409 + cancel allowed; `node scripts/build-ui.mjs` rebuilt + Chromium `e2e/handoff.spec.ts` 2/2 (explicit create/drawer-quotes-frozen-fields reload-stable + revoke-flags/dispatch-blocked/cancel-kept/reaffirm-clears); root `tsc` exit 0; e2e `tsc` exit 0; `biome check` exit 0 on the 20 touched files (repo-wide `biome check .` still reports 1 pre-existing lint error in untouched `packages/kernel/test/action_create.test.ts`, left alone). Full old suites NOT rerun (prior green preserved). Smoke scaffold removed; untracked `node_modules` and `docs/plan/*_2026-10-10.md` are not this worker's and were left uncommitted. Normal local commit on feat/av-handoff; no PR.

## AV03 delegation-handoff lifecycle fixes — supersede / terminal-task / retry(failed→prepared) / older-page no-409 (2026-10-17, observed, branch feat/av-handoff)
- Supersede semantics (`packages/kernel/src/handoff.ts`): a superseding creation must bind the SAME task as the old row and refuses an ALREADY-superseded target (409; the frozen chain stays linear, one successor max). In the SAME transaction the old row gets `superseded_by` AND a version bump (CAS-guarded `AND superseded_by IS NULL`, exactly-one-row). After supersede, the old row keeps its frozen content readable/stale but every lifecycle mutation refuses: dispatch / report / verify / attempt each throw a `HandoffStateConflictError` 409 naming the successor (`superseded_by !== null` guard), so the map's stale copy can never win a second human commit — the successor row owns the work. Cancel remains the always-available escape hatch on any non-terminal status.
- Terminal-task semantics: `createHandoff` refuses (409) creation against a completed/cancelled task — frozen records for terminal work are meaningless; `dispatchHandoff` additionally re-reads the task's CURRENT status at dispatch time, so a task that became completed/cancelled AFTER the handoff froze refuses dispatch (a frozen snapshot never re-opens terminal work). Report still carries the explicit unverified environment claim (sandbox never production), verify never completes the task.
- Retry semantics: `recordHandoffAttempt` is allowed from any non-terminal state EXCEPT an already-superseded row and a pending `needs_reevaluation` notice (reaffirm first, so a stale parent is never silently retried); a `failed` handoff RETURNS TO `prepared` on the recorded attempt (same-TX status move + `active_attempt` bump + version bump), then follows the normal dispatch→report→verify path. No automatic retry, no timer, no attempt cap; verified/cancelled stay terminal; the attempt cause is a required closed label (transient_infra|worker_error|criteria_unmet|environment). The panel's attempt button is kernel-aligned: disabled for terminal states, a pending notice, and superseded rows (enabled again on the prepared successor path after the failed→prepared move).
- Consumer-panel truthfulness (all three panels: handoff / learning / proposal): each 200 mutation response's returned view is applied to the map BEFORE the page fetch (session-owned only), and a handoff/hypothesis/proposal NOT on the fresh page is always re-read directly (map presence no longer decides) — so an older-page record's commit never uses a stale version: dispatch→report on a handoff living ONLY beyond the newest 50-item page completes WITHOUT a 409 (the second human commit always carries the version the server holds). A definitive 409 re-reads the named record directly and clears the frozen op with an honest retype message; a CREATE 404 keeps the drawer + typed inputs open for correction; a 404 for a background/older record never closes the human's current drawer; the open selection's history lists clear immediately on selection switch; a non-200 history read renders a visible failure line, never silent emptiness.
- Proof (this worktree, observed): focused Vitest 17 files / 108 tests (kernel handoff/autonomy_slice/autonomy_tools/learning/learning_review_fixes/conversation_proposals/conversation_proposal_review_fixes/conversation_proposal_agent_adopt/action_proposals/proposal_idempotency_lookup + server handoff_http/autonomy_http/learning_http/conversation_proposals_http/conversation_proposals_paging/proposals/proposal_approval_replay) all pass; Chromium `handoff.spec.ts` + `learning.spec.ts` + `conversation_proposals.spec.ts` 15/15 via `apps/server/playwright.config.ts` webServer (auto production UI build), including the NEW older-page regression: 51 fillers push the target to item 52, it dispatches→reports with no stale-version 409 (badge 版 2 then 版 3). Root `tsc --noEmit` exit 0; e2e `tsc --noEmit` exit 0; `biome check .` exit 0 on touched files (1 pre-existing warning in untouched `action_create.test.ts` remains). Full old suites NOT rerun (prior green preserved). No PR.

## Startup-contract B1–B4 decision_inputs verification + T3/T4 standalone smoke (2026-10-18, no live writes)

Verification record for the `decision_inputs` B1–B4 startup-contract review items on branch
`feat/startup-contract-b1-c10-08-d2` (worktree `.c12-calendar/startup-contract-wt`, commits
`84b0feb` shared strict-instant module + `7d70e57` adoption). No product code changed in this
step except the permanent smoke regression; all three decisions were proven with existing or
newly added tests, no flaky rewrites.

- B1, B3, B4 already satisfied on master (no new product change required):
  - B3 (injected binding `derivePort`): existing test
    `apps/server/test/rescheduleWriteStartup.test.ts` —
    describe `injected calendar binding derives the write port from the active selection`,
    test `derivePort receives the injected selection and the full approval pipeline succeeds`
    (asserts the seen array is exactly `[{connectorInstanceId, calendarId: "primary", account: "ops@example"}]`,
    `seen.length === 1`, real HTTP approve → scheduler → fixture PATCH → terminal receipt).
  - B4 (overlong write identity pre-DB preflight): existing test in the same file —
    describe `canonical write identity is validated before any DB side effect`, test
    `rejects overlong test identities even with an injected factory (no DB, no transport)`
    (129-char name / 65-char version reject with `existsSync(dbPath) === false`, factory
    call count still 0).
  - B1 (frozen-inherited env freeze): existing coverage on master per `docs/plan/active_projects_tasks.md`
    line 19 (2026-10-18 追記, `packages/connector-mcp/src/client.ts`) — unchanged, not re-proven here.
- B2 / C10-08 gap fixed on this branch via the shared predicate (commits `84b0feb` + `7d70e57`):
  `packages/connector-calendar` `isStrictCalendarInstant` adopted at every inbound path, adopted by
  the rescheduleWrite tool surface; regression tests in `packages/connector-calendar/test/` from the
  adoption commit cover the sub-ms/fractional-instant rejections. Status: C10-08「採用判定待ち（gap 修正済み）」
  — the fractional-ISO gap is fixed in code/tests, formal adoption of an external binding/pin/live
  Google remains out of scope for this branch (no OAuth, no live writes).
- D2 decision (include T3/T4 standalone actual-`startServer` smoke in acceptance, per the PR20 T5
  record's "still-pending T3/T4 standalone actual-`startServer` smoke"): added
  `apps/server/test/startup_smoke.test.ts` (real `startServer`, temp-dir SQLite/env, port 0, servers
  closed in `afterEach`):
  - T3: `T3: disabled calendar-write config listens with 0 capability reads and 0 closes` —
    disabled composition with an injected OWNED write binding present never adopts it:
    `GET /health/ready` 200, `derivePort`/`update` 0 calls, shutdown hook 0 closes even on a second
    shutdown call.
  - T4: `T4: enabled owned port derives once with the injected selection and closes exactly once` —
    enabled (optIn + writeEnabled) composition: `GET /health/ready` 200, `derivePort` exactly once
    with the injected selection (`{calendarId: "primary", account: "ops@example"}`), 0 `update`
    calls, adopted `owned: true` shutdown hook closed EXACTLY once on server shutdown.
  - Not duplicated (reuse per D2): the rescheduleWriteStartup full-pipeline B3 case and the B4
    overlong-identity case; `createWriteStartup.test.ts` `preserves read-only defaults when every
    gate is off` (disabled listens).
  - `smoke:startup` script added in `apps/server/package.json` running exactly the covering files
    (`pnpm-smoke.startup.config.mts` include: `startup_smoke`, `rescheduleWriteStartup`,
    `createWriteStartup`): run output `Test Files 3 passed (3), Tests 42 passed (42)`.

## Memory independent of autonomy pause — I03-09 decision applied (2026-10-20, branch fix/memory-independent-of-pause)
- Decision (haruka 2026-10-20, I03-09): memory writes (`event.append`, `record.remember`, feedback) AND cultivation (idle `maintain.distill`) are autonomous, no-approval work and keep running while autonomy is PAUSED; the pause gates ONLY autonomous work (tasks/shadow/proposals). Implementation (`apps/server/src/memory_service.ts`, `shadow_service.ts`, `bootstrap.ts`): the pause no longer aborts in-flight memory extraction/distill CLI children and no longer closes the shared background admission gate — the gate's `closed` flag is owned by shutdown/drain only (bootstrap persisted-paused close removed; shadow `notifyControl` keeps only the in-flight abort; memory `notifyControl` removed from the service and bootstrap wiring). Shadow admission while paused stays fenced by the kernel itself (`claimShadowJob` refuses paused-control claims; pause holds pending jobs with `control_paused`). Remaining gates unchanged: memory disabled, shutdown/drain, foreground priority/preemption, shared one-unit admission, attempt/backoff budgets. `memory.extract_skipped_closed` / `memory.distill_skipped_closed` log codes preserved for the shutdown-closed reason.

## 自動デプロイ (single Linux host, user systemd, polling)

`origin/master` の green な先端へ、単一 Linux ホスト上の detached worktree
(`~/companion_master`) を自動で進める。インバウンド公開は一切なし
(webhook なし、5分ポーリングの user timer)。

### Setup (host)

```sh
scripts/deploy/install.sh
systemctl --user daemon-reload
systemctl --user enable --now companion.service companion-deploy.timer
loginctl enable-linger $USER
```

- `install.sh` は unit を `~/.config/systemd/user/` へコピーし、
  `~/.config/companion/env` (0600) が無ければ secrets なしテンプレートを
  作成する (既存ファイルは変更しない)。`--enable` 付きでのみ自身が
  daemon-reload/enable/linger まで行う。引数なしでは何も起動しない。
- user systemd は login-shell の PATH を継承しないため、`install.sh` は
  実行時の `command -v node` / `command -v pnpm` (不在時は明示エラーで
  中止) から `PATH=<nodeのあるdir>:<pnpmのあるdir>:/usr/local/bin:/usr/bin:/bin`
  (重複除去) を組み立て、`companion.service.d/path.conf` と
  `companion-deploy.service.d/path.conf` (drop-in) に書き込む。リポジトリ内の
  unit は汎用のまま。Node の導入場所を変えたら `install.sh` を再実行する
  (drop-in を書き直し、daemon-reload)。
- `companion.service`: `WorkingDirectory=%h/companion_master`、
  `EnvironmentFile=%h/.config/companion/env`、
  `ExecStart=%h/companion_master/run-google-readonly.sh`、
  `Restart=on-failure`、`KillSignal=SIGTERM`、
  `TimeoutStopSec=30` (server drain 10s + margin)。
- `run-google-readonly.sh` は対話入力不要・TTY 前提なしで、`exec pnpm start`
  により server へシグナルが直接届く。

### How it decides (scripts/deploy/companion-deploy.sh)

1. `git fetch origin` し target=`origin/master` を取得。HEAD と同等なら
   正常終了 (exit 0)。
2. CI gate: `gh api repos/suiso11/companion_harness/commits/<sha>/check-runs`
   の全 run が completed + success (skipped 許容) のときのみ進行。
   `gh` 不在/未認証・API 失敗時はスキップして次 tick に retry (exit 0)。
3. Active-run skip: `scripts/deploy/activeRuns.mjs` が server と同じ既定
   (`COMPANION_DB_PATH` 未設定時は OS app-data の `companion.sqlite`) を
   read-only (`node:sqlite`) で開き、`runs` の queued/running/
   cancel_requested が1件でもあればスキップ (exit 0、次 tick に retry)。
   DB 不在・`runs` テーブル不在は 0 件扱い。判定失敗時も安全側でスキップ。
4. Dirty guard: tracked な変更があれば破棄せず exit 1 で拒否 (untracked は無視、`--untracked-files=no`)。
5. `git switch --detach <target>` → `pnpm install --frozen-lockfile`
   (UI build は `pnpm start` の prestart hook が行う) →
   `systemctl --user restart companion.service` →
   `http://127.0.0.1:${COMPANION_PORT:-3000}/health/live` を最大60秒 poll。
6. 単一インスタンスは flock (`$XDG_RUNTIME_DIR/companion-deploy.lock`) で
   保証。ログは stdout → journal のみ。

### Rollback

Health が60秒以内に復帰しない・restart 失敗時は、直前の sha へ
`git switch --detach` → reinstall → `restart` し、rollback をログして
exit 1。手動復旧も同じ手順 (`git switch --detach <sha>` + restart)。

### Pause / logs

```sh
systemctl --user stop companion-deploy.timer    # pause (service は継続)
journalctl --user -u companion -u companion-deploy -f   # logs
```

### Status (2026-10-19)

brownie（単一 Linux ホスト）で本構成が稼働中。Companion は systemd user units
（`companion.service` + `companion-deploy.timer`）で起動し、`tailscale serve`
が tailnet HTTPS を終端して `127.0.0.1:<port>` へ proxy する。chat model は
2026-10-19 に Gemma 4 26B-A4B（unsloth UD-Q4_K_XL）へ切替済み（Qwen 削除、
`local-chat` alias は PR #90）。2026-10-22 にメインを Huihui Ornith-1.5-35B-A3B
abliterated (i1-Q4_K_M) へ切り替えた（下記「メインチャットモデル」参照）。
remind 側の自動デプロイは PR #92
（remind-deploy.timer、下記参照）で導入済み。
## remind CLI の本番配置・自動更新・モデル配置

### 本番配置

- 本番の remind は `~/remind_master` (remind リポジトリ
  `github.com/suiso11/remind` の detached worktree)。`npm ci && npm run build`
  でビルドし、Companion は `dist/src/cli.js` を呼ぶ。
- remind 設定は `~/.config/remind/memory.config.json`
  (`dbPath`, `vaultPath`, `allowedScopes`, `vectors.modelDir`,
  `llm.modelDir` など)。
- Companion 側は `~/.config/companion/env` の `COMPANION_MEMORY_JSON`
  (`{"executable","entry","config","scope"}`) で絶対パスを固定する。
  `executable` は Node、**`entry` は必ず
  `~/remind_current/dist/src/cli.js`** (`remind_current` は現行リリースへの
  symlink。移行後は `~/remind_master/...` を直接指さない)、`config` は上記
  JSON、`scope` は `allowedScopes` のいずれか。
- Companion はメモリ操作のたびに remind CLI を子プロセスとして spawn する
  (常駐プロセスなし)。そのため remind の更新に Companion の restart は
  **不要**。リリースディレクトリは一度作ったら書き換えない (immutable) ので、
  実行中 call がビルド途中の `dist/` を読むリスクはない。

### 自動更新 (scripts/deploy/remind-deploy.sh)

`remind-deploy.timer` が 5 分ごとに実行する。Companion の
`companion-deploy.timer` と同時に走らないよう、起動時は
`OnBootSec=3min` で 1 分ずらしてある (以後も 5 分間隔)。

配布方式は out-of-tree な immutable リリース + symlink 切替
(`~/remind_master` の working tree は触らない):

1. `git fetch origin` し target=`origin/master`。state marker が
   `ok` で target が一致し、`~/remind_current` がそのリリースを指して
   いれば exit 0 (毎 tick 再検証: marker/symlink/ビルド済み CLI が揃って
   いなければ再構築)。
2. CI gate: `gh api repos/suiso11/remind/commits/<sha>/check-runs` が
   すべて completed + success (skipped 許容) のときだけ進行。
   `gh` 不在/未認証/API 失敗はスキップして次 tick (ページングは
   `--slurp` 集約、旧 gh はストリーム結合でフォールバック)。
3. `git archive <target>` を `~/remind_releases/<sha>` へ展開し、そこで
   `npm ci && npm run build` (remind は npm 管理。`dist/` は gitignore)。
4. Pre-deploy DB backup: Smoke の**直前**に live DB の online backup を
   取る。Smoke は新リリースの CLI を live config に対して実行するため、
   その初回 CLI open で schema migration が適用され得る。よってこの
   backup が唯一の migration 前復元点であり、smoke より後に取っては
   ならない。`memory.config.json` の `dbPath` (相対パスは config
   ディレクトリ基準) を解決し、
   `<dbdir>/backups/remind-pre-deploy-<UTC ts>-<sha7>.sqlite`
   (0600、ディレクトリ 0700) に保存する。`node:sqlite` の online backup
   API で読み取り専用ソースからコピーし、`PRAGMA integrity_check` が
   `ok` のときだけ rename する。`PRAGMA user_version` を journal に記録。
   保持は pre-deploy prefix に一致する newest 10 世代のみ。
   DB がまだ存在しない初回はログを出して skip。backup / integrity_check
   の失敗は smoke を実行せず、symlink も切り替えず、通常の失敗経路
   (`failed` marker + rollback + exit 1) で中止する。
5. Smoke: `record.list` を1回実行し、本番クライアント
   (`memory_cli.ts`) と同一の厳密検証で `{v:1,ok:true,code:"OK"}` を
   要求する (1行・LF 終端・完全な envelope キーセット・型チェック、
   `scripts/deploy/remindDeploy.mjs`、`timeout 30` で境界付き)。
   `executable` / `config` / `scope` は `COMPANION_MEMORY_JSON` を優先し
   (無ければ node 本体と remind config の `allowedScopes[0]`)、`entry` は
   **常に今ビルドしたリリースの** `dist/src/cli.js` を使う。
   失敗時は state を `failed` にして直前の検証済みリリースへ symlink を
   戻し (rollback) exit 1。この時点で live DB は smoke により既に
   migration 済みかもしれないため、失敗メッセージには pre-deploy backup
   のフルパスを含める。**自動 restore はしない** (必要なら運用者が手動で
   戻す)。
6. 上記 backup + smoke 成功後のみ `mv -T` で `~/remind_current` を
   `~/remind_releases/<sha>` へ原子的に付け替え、state marker
   (`~/.local/state/companion/remind-deploy.state`) を `ok` に更新。
   リリースは直近 2 世代を保持 (実行中の子プロセスは自分のディレクトリを
   参照し続けるので quiesce 不要)。

初回リリースの作り方 (移行手順):

```sh
# 1) 現行を手動リリースとして登録するか、1 回目の tick に任せる
scripts/deploy/remind-deploy.sh        # smoke 通過で ~/remind_current 作成
# 2) ~/.config/companion/env の COMPANION_MEMORY_JSON の entry を
#    ~/remind_master/dist/src/cli.js → ~/remind_current/dist/src/cli.js へ変更
# 3) Companion を 1 回だけ restart して新しい entry を読み込む
#    (以降は symlink 切替のみで restart 不要)
```

インストール:

```sh
scripts/deploy/install.sh
systemctl --user daemon-reload
systemctl --user enable --now remind-deploy.timer
loginctl enable-linger $USER
```

`install.sh` は `remind-deploy.service` / `remind-deploy.timer` も
`~/.config/systemd/user/` へコピーし、`remind-deploy.service.d/path.conf`
に node/npm/pnpm の PATH を固定する。`.service` は
`WorkingDirectory=%h/companion_master`、`EnvironmentFile=%h/.config/companion/env`、
`ExecStart=%h/companion_master/scripts/deploy/remind-deploy.sh`。

単一インスタンスは flock (`$XDG_RUNTIME_DIR/remind-deploy.lock`)。失敗は
`OnFailure=companion-alert@%n.service` で
`~/.local/state/companion/alerts.log` に記録される。Companion の restart は
行わない。

```sh
systemctl --user stop remind-deploy.timer          # pause
journalctl --user -u remind-deploy.service -f      # logs
systemctl --user start remind-deploy.service       # manual run
```

### モデル配置 (安定パス)

`~/.config/remind/memory.config.json` の `vectors.modelDir` /
`llm.modelDir` が開発チェックアウト (`/home/molmot/remind/models`) を指すと、
auto-deploy や checkout の移動で壊れる。モデルはチェックアウト外の
`~/.local/share/remind/models` に置く。

```sh
# 既存モデル一式を安定パスへコピー (rsync -a --mkpath、再実行しても差分のみ)
scripts/deploy/remind-models.sh
# コピー元/先を変える場合 (コピー元は第1引数)
scripts/deploy/remind-models.sh /path/to/remind/models
REMIND_MODELS_DIR=~/.local/share/remind/models scripts/deploy/remind-models.sh
```

スクリプトは設定を書き換えず、更新すべき行を表示する:

```json
"vectors": { "modelDir": "~/.local/share/remind/models/paraphrase-multilingual-MiniLM-L12-v2", ... }
"llm":     { "modelDir": "~/.local/share/remind/models/qwen25-15b-instruct", ... }
```

モデルファイルの正規の取得方法は remind の provisioning (ネットワーク工程)。
安定パスへ直接取得できる:

```sh
cd ~/remind_master
npm run provision:model -- --dir ~/.local/share/remind/models/paraphrase-multilingual-MiniLM-L12-v2
npm run provision:llm   -- --dir ~/.local/share/remind/models/qwen25-15b-instruct
```

`modelDir` の変更は次回の CLI 起動から効く (Companion restart 不要)。

### 保持判定 (retention classifier) のモデル設定

remind の保持判定 (retention classifier) は、ローカルで完結する埋め込み
ではなく、メインチャットと同じ LiteLLM プロキシ経由のチャットモデルで
実行する。`~/.config/remind/memory.config.json` に以下を追加する:

```json
"activation": {
  "llm": {
    "backend": "openai",
    "baseUrl": "http://127.0.0.1:4000",
    "model": "local-chat",
    "apiKeyEnv": "REMIND_LLM_API_KEY"
  }
}
```

- remind は `apiKeyEnv` に指定した**環境変数名**を `process.env[...]` から
  解決し、`:4000` の LiteLLM へ Bearer として送る。設定ファイルに
 トークンそのものは書かない。
- Companion は remind CLI を `memory_cli.ts` の `spawn()` で `env` 指定
  なしに起動するため、子は Companion の環境をそのまま継承する。
  `run-google-readonly.sh` は `.env.litellm` の `LITELLM_MASTER_KEY` が
  あるとき、`REMIND_LLM_API_KEY` が未設定の場合に限り同じ値を export
  する (既存の export を上書きしない。値は echo しない)。
- これは新しい鍵の追加ではない。同じ鍵は既に `COMPANION_MODEL_JSON` の
  `apiKey` として Companion の環境に載っており、LiteLLM 側の
  `LITELLM_MASTER_KEY` でもあるため、露出は変わらない。
- `activation.apply` は引き続き `false` (preview-only)。分類器が失敗して
  も idle 処理は degrade し、記憶の通常利用は止まらない。


## バックアップと復元 (Companion + remind, user systemd)

`companion-backup.timer` が毎日 03:30 (Persistent=true,
RandomizedDelaySec=15min) に `scripts/deploy/companion-backup.sh` を実行する。
保存先は `~/.local/share/companion-backups/{companion,remind}/` (0700)、
各世代は 0600 の SQLite。保持は各ディレクトリ newest 7 世代
(`COMPANION_BACKUP_KEEP` で変更可)。

- Companion: バックアップ CLI の契約はサーバ停止中のみ (stopped-server
  only) だが、timer は `companion.service` 起動中に発火し得る。そこで
  `scripts/deploy/companion-online-backup.mjs` がサーバと同じ規則
  (`COMPANION_DB_PATH`、なければ OS 既定) で DB パスを解決し、**読み取り
  専用で開いて** `node:sqlite` の online backup API でコピーする
  (**ダウンタイム無し**)。コピーは `.partial` → `PRAGMA integrity_check`
  → 0600 → atomic rename。旧 CLI が書いた legacy の
  `companion-manual-*.sqlite` 世代 (DB の `<data>/backups/`) も同じく
  newest N 世代に prune する。
- remind: remind に backup CLI は無いため
  `scripts/deploy/remind-backup.mjs` が
  `~/.config/remind/memory.config.json` の `dbPath` (相対パスは config
  ディレクトリ基準) を解決し、`node:sqlite` の online backup API で
  読み取り専用ソースからコピーする。コピーは `.partial` →
  `PRAGMA integrity_check` → 0600 → atomic rename。
- remind の pre-deploy backup は上記 daily backup とは別に、deploy の
  smoke 実行**直前** (新 CLI が live DB を開いて migration し得るため) に
  `<dbdir>/backups/remind-pre-deploy-<UTC>-<sha7>.sqlite` として newest 10
  世代を保持する (`remind-deploy.sh`)。smoke 失敗時はこのパスを
  失敗メッセージに出すが、自動 restore はしない。daily backup の保持対象
  には含まれない。
- prune は新世代の rename 成功後にのみ実行する。失敗時は `.partial` を
  削除し、既存の最新 good copy を残す。
- 同時実行は flock (`$XDG_RUNTIME_DIR/companion-backup.lock`) で排他。
- ログは journal (stdout)。手動実行:

```sh
systemctl --user start companion-backup.service
journalctl --user -u companion-backup.service -n 50
```

### Companion の復元 (停止必須)

1. `systemctl --user stop companion.service`
2. 現行 DB / `-wal` / `-shm` を退避コピー (削除しない)。
3. 選んだ `companion-*.sqlite` を DB 隣の一時ファイルへコピー。
4. 一時ファイルに `PRAGMA quick_check` を実行し、`ok` 以外なら中止。
5. 一時ファイルを設定 DB パスへ atomic rename。
6. 停止したまま古い `-wal` / `-shm` を削除。
7. `systemctl --user start companion.service` (起動時 migration 可)。

### remind の復元 (DB を開くプロセスを停止)

1. remind CLI / それを呼ぶ処理を停止 (cron/常駐があれば止める)。
2. 現行 DB / `-wal` / `-shm` を退避コピー。
3. `~/.local/share/companion-backups/remind/` または (migration 直前へ
   戻す場合は) `<dbdir>/backups/` の pre-deploy 世代を選び、
   `dbPath` 隣の一時ファイルへコピー。
4. `PRAGMA integrity_check` が `ok` であることを確認。
5. atomic rename で `dbPath` を置換し、古い sidecar を削除。
6. 処理を再開。

## 監視 (local only)

`companion-health.timer` が 5 分ごとに
`scripts/deploy/companion-health.sh` を実行し、以下を確認する。

- `http://127.0.0.1:${COMPANION_PORT:-3000}/health/live`
- `systemctl --user is-failed` (companion / companion-deploy / companion-backup)
- `/` と `/srv` の空き容量 (<10% で error)
- Companion / remind の最新バックアップ age (>36h で error,
  `COMPANION_BACKUP_MAX_AGE_HOURS` で変更可)
- SearXNG `127.0.0.1:8888/healthz` (searxng コンテナが存在するホストのみ)

問題時は `systemd-cat -p err -t companion-health` で journal に記録する。
`companion`, `companion-deploy`, `companion-backup` には
`OnFailure=companion-alert@%n.service` を設定し、失敗時に
`~/.local/state/companion/alerts.log` (0700/0600) へ追記 + journal err を
出す。外部送信 (push/メール等) は未承認のため対象外。

```sh
journalctl --user -p err -S today
journalctl --user -u companion-health -n 50
cat ~/.local/state/companion/alerts.log
```

## システムモニター (`/monitor`, local only, read-only)

Web UI の `/monitor` と `GET /api/monitor` は、ホストとモデル呼び出しの
概況を返す読み取り専用 surface です。表示内容:

- 状態 (idle / queued / generating) と実行中・待ち Run 数
- 出力 tok/s (出力トークン ÷ 呼び出し全体の時間。プリフィルを含むため
  デコード専用速度ではなく下限値)、直近呼び出しの推移
- GPU ごとの使用率・VRAM・温度・電力と直近 2 分の履歴 (最大 60 サンプル)
- CPU 使用率・RAM 使用量 (Linux `/proc`)
- サービス状態: モデル設定の有無 / 最終 outcome・時刻、SearXNG の
  `ok` / `down` / `disabled`
- 最新 20 件のモデル呼び出し (run id・step・model・outcome・error code・
  時間・トークン数・tok/s)
- 直近 24 時間の合計 (呼び出し数・入力/出力トークン・失敗数)

データ源と安全境界:

- GPU は `nvidia-smi` を `execFile` で実行 (shell なし、固定引数、2 秒
  timeout)。バイナリ不在・timeout・非 0 終了は空の GPU 一覧になり、
  エラー文字列は返しません。`[N/A]` 等は `0` ではなく `null` です。
- CPU/RAM は `/proc/stat` と `/proc/meminfo`。読めない環境では `null`。
- モデル呼び出しは `model_calls` のメタデータのみ (prompt / 出力本文は
  読みません)。
- SearXNG は設定済み `searxng_base_url` の `/healthz` を 10 秒 cache・
  1.5 秒 timeout・redirect 不追従で確認し、`ok`/`down`/`disabled` の
  固定値だけを返します。URL・status text・body は返しません。
- サンプラーは遅延起動: 最初の読み取りまでタイマーも子プロセスもなく、
  60 秒読み取りが無いと自動停止し履歴を破棄します (再開時は現在値から)。
  サンプルは重複実行しません。
- UI は可視中のみ 2 秒間隔で同一オリジン `GET /api/monitor` をポーリング
  します (非表示で停止、再表示で即時 1 回、unmount で停止)。失敗時は
  最後の値を保持し stale 表示のみ出します。
- `/api/monitor` は他 API と同じ Host / Origin 検査の対象で、リモート
  モード有効時はログインセッション必須です。応答はスカラー値のみで、
  上流 URL・生のエラー・レスポンス本文・プロンプト・モデル出力は
  含みません。
- 最新呼び出しの並びと 24 時間集計のため、additive migration `0029`
  で `idx_model_calls_created` (`model_calls(created_at)`) を追加します
  (既存データ・索引は変更しません)。

レイアウトは [Strata](https://github.com/Niko1221/Strata) (MIT) の
monitor に着想を得た独自実装で、コードはコピーしていません。

## 運用通知 (in-app system ops notices, local only)

運用スクリプト (deploy / backup / health) は、journal に加えてアプリ内の
システム通知フィード (notifications の `ops` scope) へ best-effort で通知を
書き込む。外部送信 (push / メール等) は行わない。書き込みは
`scripts/deploy/notify.sh` 経由で server の ops notify CLI
(`apps/server/src/ops_notify_cli.ts notify`) を 10 秒の timeout で呼ぶ。
失敗時は stderr に log を出すだけで、呼び出し元スクリプトの終了コードには
影響しない (常に exit 0)。

通知の種類と書き込みタイミング:

- `companion-deploy.sh`
  - 成功: info「デプロイ完了 <short sha> (#PR)」 (#PR は merge commit
    subject から抽出、health ok 後に書き込む — server restart 中の
    DB 書き込みを避けるため)。
  - 失敗 / ロールバック: error「デプロイ失敗（ロールバック）」。
  - スキップ継続: 同一 target が 1 時間超 skip し続けた場合 (CI not
    green / active runs) に 1 時間窓ごとに最大 1 件の info。
    状態は `~/.local/state/companion/deploy-skip` (JSON, 0600)。
- `companion-backup.sh`: 失敗時のみ error (Companion / remind それぞれ)。
- `companion-health.sh`: 問題 key ごとに初回のみ error、解消時に 1 件の
  info「回復」。key は liveness / unit:<name> / disk:<mount> /
  backup-age:<label>。状態は `~/.local/state/companion/health-notify.json`
  (0600)。重複制御は `scripts/deploy/opsNotifyState.mjs` (pure 関数を
  `apps/server/test/ops_notify_state.test.ts` で検証)。

読み方は通常の通知と同じ (アプリ内通知フィードの ops scope、`ops` kind、
urgent = error / routine = info)。journal だけを見る場合:

```sh
journalctl --user -t ops-notify -n 50
cat ~/.local/state/companion/deploy-skip
cat ~/.local/state/companion/health-notify.json
```

状態ファイルを削除すれば重複制御はリセットされる (次回の問題で再通知)。

## LLM スタック管理 (ops/llm)

`ops/llm/` はホストの `/srv/llm` を git 管理下に置いたもの。
qwen サービスと `qwen-local` alias は削除済みで、`local-chat` のみ。
イメージは digest pin。secrets は `/srv/llm/.env` (0600, 非コミット) のみ。

```sh
# 差分確認 (コピーしない)
ops/llm/apply.sh
# 差分を /srv/llm へ反映し、compose を収束
ops/llm/apply.sh --yes
```

`apply.sh` は `compose.yaml` と `litellm_config.yaml`、および
`searxng/settings.yml` (`/srv/llm/searxng/` へ) だけをコピーし、
`.env` は読まない/コピーしない (`SEARXNG_SECRET` 未登録の場合は起動用に
1 行だけ追加する。下記「SearXNG」参照)。`--dest` / `LLM_DIR` で配置先を
変更できる。

### メインチャットモデル (Huihui Ornith 1.5 35B A3B abliterated, P40)

2026-10-22 に chat model を Gemma 4 26B-A4B から切り替えた。LiteLLM の
`local-chat` は compose service `main` (container `huihui-ornith-35b`) を指す。

- 配置: P40 (`device_ids: ["0"]`)、llama.cpp image は従来と同じ digest pin。
- `-c 65536 --cache-type-k q8_0 --cache-type-v q8_0 --n-gpu-layers 99 -fa on --jinja --alias huihui-ornith-35b`。
  投機デコード (MTP) は使わない。KV cache は q8_0 に量子化して 64k context を
  P40 (24 GiB) に収める。64k は pi-orch guest の `contextWindow` (65536) 以上に
  する必要がある (guest 側の compaction より先に llama.cpp が overflow すると
  trial が落ちる。48k では実 trial の約 7 turn で `Context size has been exceeded`)。
- thinking のトークン上限は llama-server 側で `--reasoning-budget 2048` /
  `--reasoning-budget-message "\n\n考えはここまで。回答します。\n"` を設定
  (2026-10-26)。本番では上限なしだと chat の thinking が終了せず、全リクエストが
  4096 output tokens / 約 20 tok/s (2 並列の重複) に達し、300s step limit で
  打ち切られた (chat は 300.22s で時間切れ)。正常な reasoning は最大 1251 文字
  (2026-10-23 実測) なので 2048 は暴走だけを切る。上限を超えると end-of-thinking
  タグの前に message が注入され、モデルは自然に thinking を終了する。
  Companion 側の app-level 上限 (256) は #143 で削除済み。wall-clock の時間上限
  (5 分 / 10 分) は維持する。
  参考実測 (8 本の Companion 風プロンプト、2026-10-23): 無制限は 8/8 valid、
  reasoning 最大 1251 文字、completion 最大 911 トークン。budget 512 も 8/8 valid で
  completion p50 458、256 も 8/8 valid。
- リクエスト単位の指定: OpenAI 互換 body に `thinking_budget_tokens`
  (例: `{"thinking_budget_tokens": 256, "chat_template_kwargs": {"enable_thinking": true}}`)
  を渡すとその 1 回だけ上限を指定できる (サーバー既定は 2048)。LiteLLM 経由
  (`local-chat`) でもそのまま転送されることを 2026-10-23 に確認 (64 → reasoning
  104 文字、512 → 1697 文字)。
- 実測 (P40, 2026-10-26): 49152 ctx + q8_0 KV → GPU0 21.0/24.0 GiB、
  prefill 約 557 tok/s @ 20k、decode 59 tok/s (短い文脈) / 32 tok/s (@ 20k context)、
  tool call 有効。48k の切替理由: trial guest (pi-orch) は system + tools で
  約 17k トークンを要し、16k では 17,026 で拒否された。64k へ拡張した理由は
  上記の通り guest `contextWindow` 65536 に合わせるため。
- 実測 (P40, 2026-10-22): VRAM 20.8 GiB @ 16k、decode 約 61 tok/s、
  prefill 約 961 tok/s @ 6k。thinking on/off で decode は同じ。
- prefix reuse (2026-10-26): このモデルは hybrid (recurrent state) のため、
  llama.cpp は context checkpoint がないと過去の prefix を再利用できない。
  既定の `--checkpoint-min-step 8192` では約 17k の guest prompt で
  checkpoint が 1 個も作られず、trial guest の各 turn が毎回 ~18k tokens を
  prefill していた (b11541 ログ。単独 ~30 秒 / 競合時 66 秒)。現在は
  `--checkpoint-min-step 1024` (`--ctx-checkpoints` は既定 32)。
- 同時実行は `--parallel 2 --kv-unified` に制限。relay が 60 秒で諦めた
  リクエストも llama.cpp では生成が続き、LiteLLM の既定 2 retry で 3-4 slot が
  埋まって共有 65k KV pool が overflow していた (`Context size has been exceeded`)。
  `--parallel` を明示すると既定で slot ごとに `-c` を分割する (2 x 32768) ため、
  guest の 65536 contextWindow を維持するには `--kv-unified` が必須。
  LiteLLM 側は `local-chat` の `litellm_params` に `num_retries: 0` /
  `max_retries: 0` と `timeout: 300`、`router_settings` に `num_retries: 0`
  を設定し、Router と OpenAI SDK client の両方の自動再送を止める。
- thinking は `reasoning_content` で返る。tool call も実測で成立
  (Companion の agent loop で確認済み)。
- 入手元: Hugging Face `huihui-ai/Huihui-Ornith-1.5-35B-A3B-abliterated` の
  GGUF `mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-i1-GGUF`
  `i1-Q4_K_M` (21,713,463,808 bytes)。

モデル配置 (ホスト):

```sh
mkdir -p /srv/models/huggingface/huihui-ornith-35b
wget -c \
  https://huggingface.co/mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-i1-GGUF/resolve/main/Huihui-Ornith-1.5-35B-A3B-abliterated.i1-Q4_K_M.gguf \
  -O /srv/models/huggingface/huihui-ornith-35b/Huihui-Ornith-1.5-35B-A3B-abliterated.i1-Q4_K_M.gguf
```

`/srv/models/huggingface` はコンテナの `/root/.cache/huggingface` に
マウントされるため、コンテナ内の `-m` は
`/root/.cache/huggingface/huihui-ornith-35b/Huihui-Ornith-1.5-35B-A3B-abliterated.i1-Q4_K_M.gguf`。

反映:

```sh
ops/llm/apply.sh          # 差分確認のみ (本番は変更しない)
ops/llm/apply.sh --yes    # /srv/llm へ反映し、main + litellm を収束
```

`apply.sh` は litellm_config.yaml 変更時に litellm を force-recreate する。
起動後は LiteLLM の `/v1/models` で `local-chat` が
`huihui-ornith-35b` を向いていることと、`/health` を確認する。

rollback (64k ctx / q8_0 KV の変更だけを戻す): `ops/llm/compose.yaml` の
`main.command` を `-c 49152` (または切替前の `-c 16384`、`--cache-type-k/v` なし)
に戻して `ops/llm/apply.sh --yes` を実行する。

rollback (Gemma 4 26B-A4B へ戻す):

1. 切替前 commit を `git log -- ops/llm/compose.yaml` で特定する。
2. `git show <commit>:ops/llm/compose.yaml` の `gemma` サービスブロックと
   `ops/llm/litellm_config.yaml` の `local-chat` 行
   (`openai/gemma-4-26b-a4b` / `http://gemma:8080/v1`) を戻す。
3. `ops/llm/apply.sh --yes` を実行する。

Gemma の GGUF と MTP draft (`specdec/mtp-gemma-4-26B-A4B-it-Q8_0.gguf`) は
ディスクに残っているため、rollback に再ダウンロードは不要。

### Gemma MTP 投機デコード（履歴・rollback 専用）

2026-10-22 以降、メインチャットモデルは Huihui Ornith 1.5 35B A3B。
以下の Gemma/MTP 手順は rollback 用の履歴として残す。

`gemma` は MTP draft を使う投機デコードで起動する
(`--spec-type draft-mtp --spec-draft-model ... --spec-draft-ngl 99`)。
効果 (P40, temp 0, 5 prompts x2): decode 48.4 → 80.7 tok/s、
draft acceptance 72.7%、VRAM +~0.5 GiB、tool call は有効。
`n-max 6` と E2B draft は遅かったため採用していない。

- draft ファイルはコンテナ内から
  `/root/.cache/huggingface/specdec/mtp-gemma-4-26B-A4B-it-Q8_0.gguf`
  (= ホスト `/srv/models/huggingface/specdec/...`) に見える必要がある。
  無いと `gemma` は起動しない。
- 入手元: Hugging Face `unsloth/gemma-4-26B-A4B-it-GGUF` の
  `MTP/mtp-gemma-4-26B-A4B-it-Q8_0.gguf` (461,766,816 bytes、ローカルと同サイズ)。
  GGUF metadata の architecture は `gemma4-assistant`、tokenizer は
  target の Gemma 4 と同一。`specdec/` へ配置してから `apply.sh --yes` する。
- rollback: `ops/llm/compose.yaml` の `--spec-type` / `--spec-draft-model` /
  `--spec-draft-ngl` の 3 フラグを削除し、`ops/llm/apply.sh --yes` を再実行する。

### Ornith 1.5 9B メンテナンス LLM (P5000, loopback のみ)

`ornith` は remind のメンテナンス処理 (重要度判定・トピック抽出・
統合/整理) 専用のローカル LLM。Companion のチャット (`local-chat` /
main) とは別系統で、remind が loopback の
`http://127.0.0.1:18090` を直接叩く。LiteLLM には登録しない
(既存の `local-chat` ルートを変えないため)。

- イメージは main と同じ llama.cpp CUDA build を digest pin。
- GPU は Quadro P5000 (`device_ids: ["1"]`)。main が index 指定なので
  同じ方式で固定する。
- 実測: VRAM 約 6.2 GiB、約 28 tok/s (P5000)。
- `-c 8192`、`-ngl 99`、`-fa on`、`--jinja`、
  `--alias ornith-1.5-9b`。投機デコード (MTP) は使わない。
- ホスト側の公開は `127.0.0.1:18090` のみ。tailnet / LAN には出さない。

モデル配置 (ホスト):

```sh
mkdir -p ~/models/ornith
hf download ornith-ai/Ornith-1.5-9B-GGUF Ornith-1.5-9B-Q5_K_M.gguf \
  --local-dir ~/models/ornith
```

`compose.yaml` は `${ORNITH_MODEL_DIR:-${HOME}/models/ornith}` を
コンテナの `/models` に読み取り専用でマウントする。別の場所に置く場合は
`/srv/llm/.env` に `ORNITH_MODEL_DIR=/path/to/dir` を追加する
(Compose の `~` は展開されないため、シェル側で展開した絶対パスを渡す)。

反映 (compose のみの変更なので `apply.sh` の通常の `up -d` 経路で
全サービスが収束する。bind mount の force-recreate は不要):

```sh
# 評価用の一時コンテナが残っているとポート/名前が衝突するので先に消す
docker rm -f ornith-eval
ops/llm/apply.sh          # 差分確認
ops/llm/apply.sh --yes
docker ps --filter name=ornith-1.5-9b --format '{{.Status}}'
curl -s http://127.0.0.1:18090/health
```

remind 側の設定 (`~/.config/remind/memory.config.json`):

```json
"llm": { "backend": "openai", "enabled": true, "baseUrl": "http://127.0.0.1:18090", "model": "ornith-1.5-9b" }
```

この openai バックエンドは remind 側の対応 (suiso11/remind#31) が
入ってから有効になる。それまでは `enabled: false` のままにする。

rollback: `compose.yaml` から `ornith` サービスを削除して
`ops/llm/apply.sh --yes` を実行する (`--remove-orphans` でコンテナも消える)。
remind 側は `llm.enabled: false` に戻す。

### SearXNG (Web 検索バックエンド, loopback のみ)

Companion の `web.search` ツール (実装は別 PR) は、ホスト上の
self-hosted SearXNG を検索バックエンドとして使う
(設計: `docs/plan/web_search_design.md`)。

- `127.0.0.1:8888` のみにバインド。tailnet / LAN には露出しない。
- イメージ `searxng/searxng` は digest pin (litellm と同様)。更新時は
  `docker pull searxng/searxng:latest` 後に
  `docker inspect --format '{{index .RepoDigests 0}}'` で新しい digest を
  取得し、`ops/llm/compose.yaml` を更新して `apply.sh --yes` する。
- 設定は `ops/llm/searxng/settings.yml`。secret はファイルに書かず、
  イメージが `SEARXNG_SECRET` 環境変数から解決する。
- healthcheck は `/healthz` (`/health` ではない。`/health` は 200 を
  返さないため Compose が unhealthy 判定する)。

セットアップ:

```sh
# 差分確認後、反映。SEARXNG_SECRET が /srv/llm/.env に無ければ
# openssl rand -hex 32 で自動生成する (0600, 値は表示されない)。
ops/llm/apply.sh --yes
# 起動確認
docker ps --filter name=searxng --format '{{.Status}}'
```

動作確認 (loopback から JSON 検索):

```sh
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 300
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8888/healthz'
```

プライバシー注意:

- 検索クエリは SearXNG からアップストリーム検索エンジン
  (duckduckgo / startpage 等) へ送られる。認証情報や cookie は使わないが、
  「インターネット上に送信されるテキスト」である点はユーザー確認済みの
  決定 (設計 §1 Option B)。
- Companion ↔ SearXNG 間は loopback のみで双方向非公開。
- `SEARXNG_SECRET` は `/srv/llm/.env` (0600) のみに置き、コミット/表示は
  しない。`ops/llm/rotate-keys.sh` は対象に含まれない (再生成は手作業:
  .env の行を消して `apply.sh --yes`)。
- SearXNG は 外部公開前提の bot 対策 (limiter) を off にしているため、
  127.0.0.1 からしか到達不能なバインドを緩めないこと。

`companion-health.sh` は searxng コンテナが存在するホストでのみ
`127.0.0.1:8888/healthz` を監視する (未稼働 / 応答失敗で error 通知)。

## 鍵ローテーション

```sh
ops/llm/rotate-keys.sh --yes
# パスを変える場合:
ops/llm/rotate-keys.sh --yes \
  --llm-dir /srv/llm \
  --companion-env ~/companion_master/.env.litellm
```

- `openssl rand -hex 32` で `LLAMA_API_KEY` / `LITELLM_MASTER_KEY` を生成。
- `/srv/llm/.env` を `.env.bak-<UTC>` (0600) に退避し、0600 で atomic 更新。
- `~/companion_master/.env.litellm` の `LITELLM_MASTER_KEY` も更新
  (同様に backup、0600)。
- `main` + `litellm` を force-recreate し、`companion.service` を restart。
- 最後に認証付き `GET /v1/models` が 200 を返すことを確認 (鍵は表示しない)。
- 鍵は argv / 標準出力 / journal に出さない。失敗時は退避パスだけを表示する。

注意: 現行 compose の llama.cpp (`main`) は `--api-key` を渡していないため、
`LLAMA_API_KEY` は LiteLLM → main の outbound header としてのみ使われる。
llama.cpp 側でも認証を強制する場合は、`compose.yaml` の main command に
`--api-key ${LLAMA_API_KEY}` を追加してから `apply.sh --yes` を実行する。

## AGORA レビュー (browser, local only)

### 正とする状態と適用後の状態

- 正とする状態は `origin/master` に merge され CI が green な commit。production
  の `~/companion_master` はその commit を detached worktree として checkout
  した状態で、on-disk patch やローカル commit は持たない。
- production への反映は既存の「自動デプロイ」経路のみを使う:
  `companion-deploy.timer` が `scripts/deploy/companion-deploy.sh` を実行し、
  CI green / active-run なし / tracked 変更なしを確認してから
  `origin/master` の先端へ進め、restart + health check を行う。dirty guard が
  tracked 変更を検出した場合は前進せず exit 1 になる (変更は破棄しない)。
- UI は通常の `companion.service` restart 後の標準 prestart build
  (`scripts/build-ui.mjs`) に含まれる。production 側に専用 CLI は不要。

### デプロイ (operator, production 変更は明示実行のみ)

AGORA レビュー UI は他の変更と同じ経路で配布する。未コミットの patch を
production に当てる手順はサポートしない。

```sh
# 1. PR を merge し、CI が green になったことを確認する。
# 2. 通常の auto-deploy を待つか、同じ経路を手動で 1 回実行する。
scripts/deploy/companion-deploy.sh
```

- `companion-deploy.sh` は `origin/master` の green commit を
  `~/companion_master` へ進め、`pnpm install --frozen-lockfile` →
  `systemctl --user restart companion.service` → `/health/live` の順に確認する。
  失敗時は直前の sha へ自動 rollback する (詳細は「自動デプロイ」節)。
- AGORA を有効にする場合は `~/.config/companion/env` (0600) に
  `COMPANION_AGORA_JSON` を設定する。`dbPath` は private な SQLite を指し、
  operator CLI と server が同じ store を共有する。値や鍵はログに出さない。
  learning を併用する場合の `COMPANION_LEARNING_JSON` も同様に env で設定する。
- AGORA private SQLite の additive migration (`session_id` /
  approval/result columns) は backward-compatible。auto-deploy の rollback は
  commit の切り戻しのみで DB は自動 restore しない (新規に永続化された
  ユーザー状態を消さないため)。必要な場合だけ operator が事前 backup
  (`scripts/deploy/companion-backup.sh`) から手動で復元する。
- 適用後は「ブラウザでの実作業」の手順で list / approve / send を確認する。
  外部への POST は人間が Send を明示したときだけ発生する。

### E2E (repo, actual browser)

```sh
cd apps/server
COMPANION_E2E_AGORA=1 npx playwright test --config=playwright.config.ts
```

`e2e/agora` は clean な標準 `scripts/build-ui.mjs` build を要求し、AGORA へ
実送信しない local fixture で 4 シナリオ (list / approve / reject / send
denied/stale/unknown 系) を検証する。外部への POST は行わない。

## Sealed pi-orch bridge candidate (2026-10-25; NOT production-enabled)

The staged bridge is `.stage-autonomous-dispatch/scripts/pi-orch-bridge/`.
Entry point:

```sh
node scripts/pi-orch-bridge/companion-bridge.mjs --config <absolute-json>
```

It keeps the reviewed TrialRunner contract: one JSONLF request on stdin,
fd3 FIFO/socket cancellation, exactly one JSONLF result on stdout after a
reservation, and the unchanged wire request/result fields (`version`,
`executionId`, `taskHash`, `configFingerprint`, `sourceRevision`,
`workspaceAlias`, `mode`, `purpose`, `objective`, `relevantPaths`,
`acceptance`, `requiredChecks`, `constraints`, `budget`,
`externalModelConsent`). `taskHash` is recomputed from the canonical request.
`--describe` is side-effect free.

Operator config is strict v2 (`stateDir`, `storage`, `active`, `sealed`,
`profile`). `sealed` names `rootDir`, `snapshotRoot`, `manifestPath`,
`manifestDigest`, `pristineSnapshotRoot`, `sourceRootOriginal`. `profile`
contains `executionBackend` (`confined`|`offline-fixture`), the pinned
`executor`/`checks` executables with content digests, `runtime` realpaths,
`model` route/consent/UDS, conservative limits, `allowedPaths`,
`scratchPaths`, and a separate `dependencies` closure (root, manifest,
digest, read-only mounts). `active.configFingerprint` is checked against the
ACTUAL effective profile (executor/check/runtime file hashes + sealed manifest
digest + frozen fields), never trusted as a declaration. `sourceRevision` is
derived from the sealed snapshot manifest digest; the request must match it.
The original source root and `.git` are never mounted or bound.

Launch semantics: verify the sealed snapshot before launch and again after
checks; copy `snapshotRoot` to a private 0700 work dir outside the original
source; verify the dependency closure (missing/tampered => `blocked:
dependencies`, never a skipped check); run the fixed executor and then each
required fixed check. `done` + `verified: true` requires every required check
to exit with its configured code and stdout matcher. Candidate changes are
validated against `request.relevantPaths`; deletions/modifications/additions
outside scope, symlinks, and forbidden paths fail. Artifact metadata is
written to `<stateDir>/runs/<executionId>/artifact.json` and retained in the
SQLite journal (sha256/bytes); it contains only change metadata, not source
bytes. Duplicate finals replay verbatim; inflight duplicates exit 2 without
resend; an unknown final is durable.

`confined` uses `systemd-run --user --scope` + `bwrap` with a read-only
dependency closure, private `/work`, no host `$HOME`, a dummy bearer token,
and only the relay UDS. If user systemd or the relay socket is unavailable the
bridge returns an explicit `containment unavailable` error; it never falls
back to a host process. `offline-fixture` is test-only and is NOT containment.
Numeric limits in the staged profile are test/transport maxima, not activated
production policy. Model-call/output-token caps are passed to the guest and
must be enforced by the trusted host relay; they are not guest-enforced.

Provenance is pinned in `scripts/pi-orch-bridge/provenance.json` (candidate
HEAD `426f9c7`, source file digests, installed launcher `pi-orch` 0.1.0 /
OMP 18.12.1, Node 24.12.0, pnpm 11.25.0, Vitest 3.2.4, tsc 5.9.3,
better-sqlite3 13.0.3). The mutable `.c12` tree is not a runtime dependency.

Actual 2026-10-25 smoke limits: the focused bridge suite passed 12/12 and
staged `pnpm typecheck` passed. A real `bwrap` run proved the sealed snapshot
is readable at `/input`, `/input` is read-only, and the original host source
and host repository path are unreadable from the guest. Full confined launch
was NOT proven: this worker has no user systemd bus (`DBUS_SESSION_BUS_ADDRESS`
and `XDG_RUNTIME_DIR` unset), so the bridge correctly returned a containment
blocker. No local model relay was available and the installed pi-orch
entrypoint was only version-probed, not run. No source host apply, write,
restart, deploy, or public post was performed.

### Native Linux bwrap prerequisite

The required native acceptance case executes `/usr/bin/bwrap` directly. On
Ubuntu hosts with `kernel.apparmor_restrict_unprivileged_userns=1`, a scoped
AppArmor profile for `/usr/bin/bwrap` must be loaded. CI first prefers the
distro-provided profile (for example `/etc/apparmor.d/bwrap-userns-restrict`).
When that file is absent, as on Ubuntu 24.04, CI loads the reviewed ABI 4
upstream profile vendored at `.github/apparmor/bwrap-userns-restrict` on the
disposable runner only. It restricts attachment to `/usr/bin/bwrap`; child
execution stacks `unpriv_bwrap`, which audit-denies all capability use so the
sandbox cannot exercise setup capabilities; capability bits are not cleared.
Production use is a separate operator configuration requiring manual approval.
No global sysctl, service, capability waiver, shared network, or host policy
change is part of the product or test path.

## Conversation -> plan -> standing-policy auto dispatch (schema 30/31)

This slice is **default off**. Live production is unchanged and no policy
exists until an authenticated human creates one. Unset config means HTTP 404
and a hidden panel; nothing is enabled or applied by this delivery.

Runtime requirement: auto-dispatch is implemented for a **Linux** host only.
Sealing depends on POSIX mode/ownership, `O_NOFOLLOW`/`lstat` checks, Linux
`bwrap` + user systemd containment, and a Linux UDS model relay. Windows
ACLs are not treated as equivalent: sealed workspace creation/verification,
candidate validation, and materializer readiness fail closed with the stable
code `unsupported_platform` before creating any output, job root, grant, or
host execution. Do not relax the POSIX `0700`/`0600`, ownership, or symlink
guards to emulate Windows. The standalone sealed-snapshot library remains
usable on Darwin when its POSIX semantics are available; the runtime itself
is Linux-only.

- Env: `COMPANION_AUTODISPATCH_JSON` (strict JSON; unset = disabled). It
  requires `COMPANION_AUTONOMY_JSON` (trial runner) and matching alias,
  bridge paths, mandatory checks, and caps. Fields:
  `enabled`, `workspaceAlias`, `sourceRoot`, `operations`
  (`investigate`/`implement`), `readScopes`, `writeScopes`, `checks`,
  `caps` (`timeoutMs`, `maxOutputBytes`, `maxModelCalls`,
  `maxOutputTokens`, `perCallTimeoutMs`, `maxRequestBytes`,
  `maxResponseBytes`, `maxConcurrent`, `jobsPerDay`,
  `concurrentExecutions`), `dependencyRoot` (null = dispatch blocked as
  `autodispatch_dependencies_missing`), `bridgeScriptPath`,
  `bridgeConfigTemplatePath`, and optional `materialization`. Unknown keys,
  bad paths, an `implement` operation without write scopes, checks that do
  not equal the trial mandatory checks, or explicit caps above the trial
  runner caps fail config parsing (fail closed). Omitted `caps` default
  field-wise to the narrower of the policy defaults and the trial/runner
  ceiling, so a runner `perCallTimeoutMs` of 60000 loads with an effective
  default at or below 60000 instead of failing startup. Paths/checks/profile/
  bridge come only from this operator config; a request cannot override them.
  Caps are operator UPPER BOUNDS: a policy may choose smaller values and the
  materializer freezes the six relay caps (request bytes, model calls,
  output tokens, response bytes, per-call timeout, model concurrency) as the
  policy ∩ operator intersection in the hashed materialization; the guest
  profile and the host trial relay use exactly that frozen budget, and the
  host's static runner limits may only narrow it further. Per-call timeout
  may legitimately narrow to 100ms. The materialized read/write scopes are
  likewise the FROZEN policy scopes ∩ the current config scopes (the narrower
  of each contained pair, nothing for disjoint pairs); a config edit can only
  narrow what the human approved, and a disjoint scope blocks the plan before
  any snapshot/grant. `externalModelConsent` is not an
  autodispatch config field; the host derives it from the operation as
  described below.
- `materialization` (strict): `stateDir` (absolute, outside `sourceRoot`),
  `executor` (`kind` `fixed`|`pi-orch-guest`|`real-pi`, absolute executable,
  args), `checks` (one command per configured check id, no extra keys),
  `runtime` (`nodeRealpath` required; optional `ompRealpath`,
  `bwrapRealpath`, `systemdRunRealpath`, `systemctlRealpath`,
  `piOrchLauncherRealpath`, `piOrchShellRealpath`, `piOrchConfigRealpath`,
  `piOrchExtensionRealpath`, `piOrchLockRealpath`), optional
  `dependencySourceNodeModules`, `allowedTopLevelFiles` (top-level names,
  no separators), `maxDurationMs`, `modelRoute` (`local`|`synthetic-local`),
  and `executionBackend` (`confined`|`offline-fixture`; the latter is
  test-only, not containment). `materialization: null` means auto-dispatch
  can never issue a real grant (honest block). The model relay route and
  model identity are operator configuration; no model name is hardcoded in
  this feature. Auto-dispatch derives `externalModelConsent` from the
  frozen local/synthetic-local route, never from the write operation, so
  all auto grants carry false; write permission still comes from the
  approved policy/plan write scopes. A request cannot fabricate consent.
- Dependency closure: `dependencyRoot` is not a free-form directory. It
  must be the exact root produced by the bridge's real
  `prepareDependencyClosure`, with sibling `<root>.closure-manifest.json`;
  the host re-hashes the closure with the bridge's own
  `verifyDependencyClosure`, requires a native compiled `better-sqlite3`
  entry, and checks the pinned Node ABI. A missing/tampered manifest,
  escaping path, wrong native digest, or ABI mismatch blocks dispatch as
  `dependency_unavailable`; nothing is installed or downloaded. If
  `materialization.dependencySourceNodeModules` is configured, a fresh
  private depot is prepared per execution by the same
  `prepareDependencyClosure` function. pnpm root/scoped/transitive
  `node_modules` symlinks are recreated inside the copied depot (never
  dereferenced to a host path), and native metadata is resolved from the
  package's real `.pnpm/.../node_modules/<pkg>` directory rather than the
  logical link path. A plain empty directory, an escaping symlink, or a
  fabricated manifest is not accepted.
- Persistent ledger (migrations `0030_autodispatch.sql`,
  `0031_autodispatch_materialization.sql`, and
  `0032_trial_proposal_constraints.sql`):
  `autodispatch_policies` (version/status/expiry/revoke/scopes/caps/
  parent human purpose), `autodispatch_plans` (revision, exact host
  `plan_hash`, accepted turn/run anchors, status), and
  `autodispatch_executions` (UNIQUE dedup key + one-use trial grant link,
  immutable `materialization_json`/`materialization_digest`). There is no
  new scheduler, queue, engine, or learning store.
- Intake runs at the existing durable `completeRun` boundary, uses bounded
  same-session selected `user_text` only, holds the shared
  `BackgroundResourceGate`, and asks the model for strict JSON intent
  (`execute`/`discuss`/`unclear`) plus a readable plan. The host validates
  every quote against exact turn text, requires the selected completed
  latest run, refuses negation, and rejects stale turns.
- Intake admission is queued, not dropped: if the shared
  `BackgroundResourceGate` is held (for example by memory extraction) the
  completion ID and its expected latest selected completed user turn plus the
  exact active policy id/version stay pending and are drained on the gate's
  existing finite `onSettled` release. A newer user turn, revoked/expired
  policy, paused/closed gate, a pause+resume control-version change, or
  foreground activity invalidates a queued intent before any planner call.
  The expected control version is captured at notification and must be
  exactly unchanged at every pre-planner/post-async fence. Completion ids are
  deduplicated once per process when accepted (busy work stays pending and is
  drained directly), so a duplicate or invalidated old completion is never
  re-enqueued, while a fresh run id remains eligible. `stop()` unsubscribes
  the wake, clears the queue, aborts/awaits every owned task, and never
  revives queued work after a later `reopen`.
- `authorizeWithinPolicy` is host-only. It rechecks policy status/version/
  expiry, `autonomy_control` pause, operator alias/checks/operations/caps,
  quota (atomic reservation), concurrency, and freshness, then derives a
  bounded `kind=task` child of the human policy purpose and inserts a
  frozen proposal + one queued grant inside the EXISTING TrialAuthority
  (no human HTTP approve click, no CAS/one-use/fence/claim/permit bypass).
  Quota uses the narrower of the policy caps and the CURRENT operator
  `limits.caps`, so lowering `jobsPerDay`/`concurrentExecutions` also applies
  to an already-created policy. Policy expiry applies the same terminal grant
  handling as an explicit revoke in one transaction: queued grants become
  `revoked`, claimed grants get `cancel_requested`, and frozen plans/reserved
  executions are superseded.
  The existing TrialRunner poll consumes the grant. One pick pages the
  stable `(created_at, execution_id)` queue oldest-first with an exclusive
  keyset cursor and an inclusive snapshot boundary, so blocked heads are
  skipped without re-reading them and continuous new arrivals cannot extend
  that pick; clearly unclaimable rows use the existing expire path, while
  blocked/unknown materialization and unknown workers are retained, never
  revoked or launched on widened/manual caps. Results remain
  `verified` only through the existing checks/artifact path; nothing is
  host-applied, deployed, or auto-completed. Automatic authorization is
  INTERNAL to this service: there is deliberately no public
  `POST .../plans/:planId/authorize` route, because an HTTP body could
  otherwise mint an unsealed/unlaunchable grant. Manual trial staging and
  approval remain on their separate human APIs. Auto-dispatch materializes
  only a frozen local/synthetic-local model route, so its grants carry
  `possibleExternalDataConsent=false` even for write operations; write
  permission still comes from the approved policy/write scopes, never from
  consent. At claim, launch-permit, and result time the shared freshness
  check compares the plan's frozen `source_turn_id`/`source_run_id` with the
  CURRENT latest human `user_text` turn (regardless of run status) and that
  turn's current selected completed run. A newer queued/completed/cancelled
  turn or a changed retry selection invalidates the old grant even when the
  planner has not saved a newer plan; manual (non-policy) grants are not
  affected.
- Frozen plan constraints: the plan's `decisions`, `nongoals`, and `steps`
  are mapped in that order to the wire `constraints` list with fixed
  `Decision: `, `Non-goal: `, and `Step: ` prefixes, then frozen on the
  proposal (`constraints_json`) and used by `claimTrialGrant` (so the wire
  `taskHash` covers them). The guest prompt renders every constraint for
  both read-only and write runs. Mapping is bounded exactly like the wire
  field (max 16 entries, 1..1024 chars each) AFTER prefixes are added: an
  over-bound plan is denied as `plan-constraints-overflow` and marked
  `blocked` before any reservation/task/proposal/grant exists. Nothing is
  silently truncated. Manual staging keeps an empty constraint list.
- Guest answer reporting: a completed read-only run forwards the guest's
  bounded `finalText` (control characters stripped, at most 4096 chars from
  the guest, split into ≤1024-char report findings) as
  `guest answer (unattested): ...`. The complete serialized result line
  (JSON + LF, UTF-8 bytes) stays within
  `min(request.budget.maxOutputBytes, storage.maxResultBytes)`; when needed
  the unattested answer is first truncated on a UTF-8 boundary and marked
  `[truncated]`, then optional findings are dropped from the end. Checks,
  artifact, and authorization/identity fields are never trimmed. It is guest
  prose only: never a check result, authorization input, completion evidence,
  or artifact claim, and write runs may include the same labelled findings.
- Frozen guest timeout: the bridge passes
  `min(request.budget.timeoutMs, profile.limits.maxDurationMs)` as
  `COMPANION_GUEST_TIMEOUT_SECONDS` into the confined guest environment
  (floored to whole seconds, never widened). The guest validates a supplied
  value and stops two seconds earlier so it can write its observation and
  exit before the bridge's outer deadline; the unconfigured manual path
  keeps the existing 300-second default.
- HTTP (same-origin/authenticated; session-scoped):
  `GET /api/sessions/:id/autodispatch` (state/defaults),
  `GET|POST /api/sessions/:id/autodispatch/policies`,
  `GET .../policies/:policyId`,
  `POST .../policies/:policyId/revoke`,
  `POST .../stop`,
  `GET|POST .../plans`, `GET .../plans/:planId`,
  `GET .../executions`, `GET .../executions/:executionId`.
  There is no plan-authorize route; a POST to that removed path returns the
  ordinary 404 and cannot create a grant, proposal, execution, or quota use.
  No key, raw config path, or original source root is returned.
- UI (chat shell, lazy chunk): `AutodispatchPanel.svelte` on the actual
  session. It shows the fixed candidate target, actual alias/scopes/checks/
  caps/expiry, global pause plus `dependencyReady`, policies, plans and
  executions. A human can create one standing policy only from the latest
  completed `user_text` turn (after confirming the disclosed scope/caps),
  revoke one policy, or stop all active policies. There is no per-plan
  approve control and no browser execute/apply endpoint. Enable never
  resumes the separate global autonomy control; resume stays on the
  explicit 「タスク・目的」 surface. Plan/execution state refreshes on
  `ch:run-settled`, bounded active polling while the document is visible,
  and a manual refresh. Candidate trial details show required checks and
  the fixed host-check/observed outcome; the API exposes no candidate
  artifact body, so the panel says so rather than claiming an apply. Guest
  execution status is labelled guest-reported/unattested: the sealed real-pi
  guest runs directly (read/grep/glob[,write]) without required
  task/opencode delegation, so a run is only reported `done` when the guest
  observation reports `ompExitCode` 0, no error, at least one observed tool
  call, and every observed tool result `ok`; any delegated-worker entries, if
  present, must still all be `done` without `isError`. A missing observation
  or a failed/errored execution downgrades the run to unknown/error. This is
  never host evidence and never permission/adoption/trust input. A 404 config
  hides the panel.
- Stop/disable: `POST /api/sessions/:id/autodispatch/stop` revokes active
  standing policies and interrupts intake; it does not resume the separate
  global autonomy control (resume explicitly on 「タスク・目的」) and does
  not force-kill an already-running trial (the existing TrialRunner stop
  boundary applies). Unsetting `COMPANION_AUTODISPATCH_JSON` disables the
  routes/panel on restart; existing ledger rows are not auto-applied or
  replayed.
- Unknown worker slots: a claimed slot whose result is unknown is retained
  fail-closed. There is NO TTL force-clear. `recoverOnBoot` rechecks the
  exact scope unit (executionId + taskHash derived) plus PID/boot identity
  and settles only when both are gone; if either is alive or unknown the
  `recover-unsettled-worker` fence remains and no speculative kill/retry
  happens.
- Honest gaps: a real Pi guest/dependency adapter remains operator-supplied;
  this delivery does not attest guest worker status or prove end-to-end
  real-model execution. Missing `dependencyRoot`, a missing bridge, or an
  unhealthy runtime yields a blocked/denied ledger row, never a fake
  check/done. No production enablement, restart, deploy, or source apply
  was performed here. Activation requires an operator-private config with
  the real paths/digests above plus explicit deployment approval.
- Materialization retention: the sealed snapshot copies each approved
  read/write root once; descendant snapshot roots under the same approved
  ancestor are collapsed only for the copy, while the separate policy read/
  write scopes, plan `relevantPaths`, and check authority stay unchanged.
  `retention.json` keeps a terminal `artifact-expired` audit tombstone after
  the one-time expiry removes the small run artifacts. A grant durably
  revoked before it was ever claimed/launched (no boot, permit, or outcome)
  is reclaimed immediately: its own heavy snapshot/dependency copies, run/
  bridge-state, and exact digest-bound private socket dir are removed and the
  job becomes an `artifact-expired` tombstone, freeing admission capacity
  without the 7-day/20-job retained window. Missing, unreadable, foreign,
  claimed/restarted, boot/permit/outcome-bearing, or otherwise unknown
  workers are HOLD. Other terminal cleanup requires actual durable
  quiescence evidence (an authorized consumed result or a quiescent/
  observed-gone interrupted outcome), not merely a status plus summary.
  Tombstones do not consume the retained-artifact admission budget (real
  `cleaned` artifacts still count to the fixed 7-day / 20-job bound).

### Auto-dispatch verification and activation prerequisites

The permanent tests and acceptance fixture are staged in the repository;
they need no production enablement. From a staged checkout with installed
dependencies, the existing commands are:

```sh
pnpm --filter @companion/kernel test -- autodispatch.test.ts autonomous_workspace.test.ts pi_orch_bridge.test.ts
pnpm --filter @companion/server test -- autodispatch_service.test.ts autodispatch_materializer.test.ts autodispatch_http.test.ts
COMPANION_E2E_AUTODISPATCH=1 pnpm --filter @companion/server test:e2e
pnpm typecheck
```

The browser command builds the production UI through `scripts/build-ui.mjs`
and launches the real autodispatch fixture; `preflight.mjs` terminates only
a prior fixture whose argv and cwd match this exact fixture. The focused
staged evidence was 2/2 real-browser scenarios plus 41 kernel, 37 observer,
and 19 bridge tests. Those results do not attest a guest worker or authorize
deployment.

Read-only deployment preflight (no apply, env, DB, service, timer, or lock
mutation):

```sh
node scripts/deploy/check-autonomous-dispatch.mjs --check
node scripts/deploy/check-autonomous-dispatch.mjs --check --target /home/molmot/companion_master
```

Activation still requires an operator-private `COMPANION_AUTODISPATCH_JSON`
(and `COMPANION_AUTONOMY_JSON`) that names the real sealed snapshot, runtime
realpaths, dependency depot, checks, caps, bridge paths, and model consent,
plus explicit deployment approval. The patch and manifest in this repository
are candidate artifacts only; they are not applied and the feature remains
disabled.

## Chat-driven task and trial proposals (model stages, human decides)

The chat model is still read-only with respect to authority. It may stage
proposals, but it never creates a purpose/task, grants a trial, or runs a
workspace command. The normal-agent guidance is:

- `purpose.list` (then `purpose.open`) finds an active goal; explicit user
  goals are preferred. If a fitting goal exists, `task.propose` stages a
  task draft under that explicit parent with a `sourceQuote` that must be an
  exact substring appearing exactly once in the current user message.
- With no fitting goal, `purpose.propose` stages a goal draft. The user
  must explicitly adopt it in 候補 before trial authority can exist.
- When the trial profile is configured (`COMPANION_TRIAL_*` /
  `COMPANION_AUTONOMY_*`), `trial.propose` is advertised. It stages a
  DATA-only trial proposal for an open task under an explicit user goal,
  using the same kernel stager as `POST /api/sessions/:id/trials`. The
  server injects the frozen workspace alias, `readOnlyMode` (derived from
  the operation), profile caps, and mandatory checks; the model supplies
  only objective/acceptance/paths/operation and `expiryMinutes` (10..1440,
  converted to a whole-second RFC3339 instant from the server clock).
- A staged proposal is not a grant. The human must accept task/purpose
  drafts in 候補 and explicitly approve a trial in 試行の提案. The model is
  instructed to say what it staged and that human action is still required.
- Authority failures are returned to the model as fixed codes (for example
  `requires_explicit_user_goal`, `goal_not_active`, `task_not_found`) so it
  can explain the refusal without bypassing the gate.


## Frozen trial operator lifecycle

The trial (`COMPANION_AUTONOMY_JSON`) runs against a sealed snapshot of the
deployed revision, with the guest adapter and check binaries pinned by content
digest. The snapshot is rebuilt automatically on every deploy so a moved
master or a changed guest never leaves a stale digest (trials fail closed).

- Host input (no secrets): `~/.config/companion/trial-operator.json` —
  `workspaceAlias`, `sourceRepo` (the deploy checkout), `sourceRef`
  (`origin/master`), `stateRoot`, `operatorFile`, `environmentFile`,
  `mandatoryChecks`, `limits`, `runner` caps, and absolute `runtime` paths.
- Builder: `scripts/deploy/build-trial-operator.mts`. It exports the deployed
  SHA with `git archive` (never the working tree), materializes a new
  `frozen-<sha7>-<stamp>/` root, verifies the snapshot against the archive and
  the profile fingerprint with `parseOperatorConfig` +
  `computeEffectiveProfile`, and validates the autonomy JSON with the real
  `parseTrialConfig`.
- Publish is atomic: `operator.json` then
  `~/.config/companion/autonomy.env` (0600, one line
  `COMPANION_AUTONOMY_JSON='…'`). The previous frozen root is retained until
  success; afterwards pruning is BY REFERENCE: the root referenced by the
  published `operator.json`, by the pre-deploy operator, or by the deploy's
  rollback backup is never pruned, and only the newest two unreferenced roots
  are kept.
- The trial model name is derived from the deploy environment exactly like
  `run-google-readonly.sh`: an exported `COMPANION_MODEL_JSON` wins, otherwise
  a non-empty `LITELLM_MASTER_KEY` in `.env.litellm` selects `local-chat`.
  The build fails if neither determines a model (never publish a profile that
  `bootstrap.ts` would reject).
- Sealed checks: only `lint` is runnable. The dependency closure is mounted at
  `/deps/node_modules`, which TypeScript cannot use to resolve project imports
  from `/work`, so `typecheck` is dropped loudly from the selected check set;
  Biome needs no project dependencies.
- Deploy: `scripts/deploy/companion-deploy.sh` runs the builder after
  `pnpm install` and before the service restart. A builder failure fails
  CLOSED: `autonomy.env` is atomically replaced with an empty file (no
  `COMPANION_AUTONOMY_JSON` line), so the restarted server runs with trials
  disabled; the app deploy continues.
- systemd: `scripts/deploy/systemd/companion.service` loads
  `EnvironmentFile=-%h/.config/companion/autonomy.env` after the main env file
  (later files win). Hosts installed from an older unit also need the
  equivalent drop-in `~/.config/systemd/user/companion.service.d/autonomy.conf`.
- Deploy runs the checkout's PRE-SWITCH script: `companion-deploy.sh` is read
  from `~/companion_master` as it exists BEFORE the switch to the new target,
  so the first deploy that introduces new deploy/build logic applies that logic
  only from the NEXT deploy. After such a deploy, run the manual rebuild below
  once so the published profile comes from the intended revision, then
  `systemctl --user restart companion.service`: the builder only publishes
  `operator.json`/`autonomy.env`, while the running server keeps the profile
  captured at startup (a different fingerprint is rejected), so without the
  restart trials stay on the old/disabled profile.
- Run manually from the checkout root (the path must be absolute or
  `$PWD`-anchored: `exec` resolves relative paths inside `apps/server`, so a
  bare `scripts/deploy/...` argument fails with `ERR_MODULE_NOT_FOUND`):
  `pnpm --filter @companion/server exec tsx "$PWD/scripts/deploy/build-trial-operator.mts"`.
  This is the same invocation `companion-deploy.sh` uses
  (`tsx "$SCRIPT_DIR/build-trial-operator.mts"`).
- Trial results and findings live in the frozen bridge journal at
  `state/jobs/<job>/bridge-state/companion-journal.db` (under the trial
  `stateRoot`). They are NOT exposed through the trial API yet, so inspect that
  SQLite file directly for outcomes.

### 会話から採用した目的の確定（人間のみ）

会話中の提案から採用された目的は `is_explicit=0 / source_kind='self'` で保存されるため、それだけでは試行権限（明示的な利用者の目的を要求）を満たしません。利用者が目的一覧の「会話から採用（未確認）」バッジ横の「自分の目的として確定」を押すと、`POST /api/sessions/:sessionId/goals/:goalId/confirm`（Idempotency-Key + `expectedVersion` CAS）がその目的を**その場で** `is_explicit=1 / source_kind='user'` に更新し、`confirmed_from='conversation_proposal'`・`confirmed_at` に確定の出所を記録します（目的イベントとして追記、行の id・scope・依存タスクは不変）。この経路は HTTP のみで、モデルツール・自動実行経路からは呼べません。退避・完了済みの目的は 409、既に明示的な目的は 200 の no-op、`expectedVersion` 不一致は 409 です。試行の提案フォームは、選択した作業の親目的が未確認のとき、この確定ボタンへの案内を表示します。

### 検証済み試行のブランチ・下書きPR化（人間のクリックのみ）

`/trials` で検証済み（`verified: true`）かつ差分が取得できた試行には「ブランチとPRを作成（下書き）」ボタンが出ます。押すと確認ダイアログの後に `POST /api/sessions/:sessionId/trials/:proposalId/adopt` を呼び、確認した `report.artifact.sha256` を本文で固定します。サーバーは凍結済み候補の全ファイル・基準バイト・スコープを再検証し、`git worktree` 上に候補バイトを書き（モードは変更しない）、固定 author/message でコミットして `trial/<executionId 先頭8桁>` を push、`gh pr create --draft` で下書きPRを作ります。マージ・base ブランチへの push・force push は決して行いません。同じ proposal は一度だけ実行され、完了済みなら同じ branch/PR を返し、実行中なら 202 を返します。

成功時は push したコミット SHA を `trial_adoptions.commit_sha` に保存し、詳細画面には候補成果物が保持期限で消えた後もブランチ・コミット・下書きPRリンクを表示します。adoption は **Linux ホスト上でのみ**実行する前提です（`gh` と POSIX な git 環境が必要）。そのため adoption の HTTP/ユニットテストは `process.platform === "win32"` ではスキップされ、Windows CI は adoption を検証しません。

有効化はホストの `~/.config/companion/trial-operator.json` に任意の `adoption` を追加します（未設定なら adoption は無効で、API は 409 `adoption_disabled`）。

```json
{
  "adoption": {
    "repoPath": "/home/USER/companion_master",
    "remote": "origin",
    "baseRef": "origin/master",
    "branchPrefix": "trial/"
  }
}
```

`scripts/deploy/build-trial-operator.mts` がこの値を `autonomy.env` の `COMPANION_AUTONOMY_JSON` にそのまま引き渡します（厳格パース。未知キーは起動失敗）。`repoPath` は絶対パスの git checkout、`remote` はそのリポジトリの remote 名、`baseRef` は fetch 後の基準 ref、`branchPrefix` は `/` で終わる名前空間です。`gh` はサービス環境の `HOME`/`PATH`（必要なら `XDG_CONFIG_HOME`）で認証済みである必要があります。固定エラーは `adoption_disabled` / `not_verified` / `artifact_mismatch` / `base_changed` / `branch_exists` / `git_failed` / `gh_failed` で、`base_changed` の場合は試行をやり直してください（adoption テーブルは proposal 単位で失敗を記録し、再クリックで再試行できます）。

## Companion-initiated chat messages (`companion_text`, 2026-10-29)

- `pnpm --filter @companion/server message send --text "..." [--session <uuid>]`
  writes ONE `companion_text` Turn (no Run) through the kernel repository.
  Without `--session` the target is the most recently active session. The CLI
  refuses a missing DB/session and stores the text as the real visible message
  (bounded 1..32768, trimmed non-empty; no safe-text masking).
- The history projection carries `kind: "companion_text"` with
  `selectedRun: null`. Both chat shells (Svelte `/` and legacy `/legacy`)
  render it as an assistant message, never as a user bubble and never as
  「応答なし」.
- Live delivery: `GET /api/sessions/:sessionId/companion-messages/stream?after=<turnSeq>`
  serves `event: companion-message` with `id` = Turn seq through the shared
  polled SSE loop (250ms poll, 15s heartbeat, backpressure grace, synchronous
  drain gate, native `Last-Event-ID` replay). The Svelte chat opens it after
  history hydration, seeded at the highest rendered Turn seq, and appends new
  messages by Turn id; reload rebuilds from history. `/legacy` has no live
  feed (reload/hydration only).
- This kind deliberately has NO `user_text` semantics: no Run/retry, no
  autonomy source turn, no memory extraction, no external send. It is in-app
  only.
