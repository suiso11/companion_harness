# Provisioned Chromium: current existing Browser E2E baseline — 2026-10-10

## Outcome

**PASS: all 12 existing configured browser cases ran and passed; 0 failed, 0 skipped, 0 flaky, 0 retries.** Installed Playwright 1.63.0 CLI, Node v24.12.0, actual launched **HeadlessChrome/153.0.8010.12**, Chromium headless shell cache revision **1243**. The one full configured run exited 0. JSON start time `2026-10-10T16:38:36.544Z`, report duration `12188.49` ms; enclosing process wall time `12.746668310001041` seconds.

User-completed `install-deps chromium` is accepted as ground truth. No apt, ldd, installation, download, package, lockfile, product/test source edit, or live-provider interaction was performed. This supersedes the prior launch-blocked baseline only for current browser availability; the prior report remains intact. It does **not** close the missing C04/C05 acceptance cases.

## Initial protection

Cwd `/home/molmot/companion_harness`; meaningful initial non-destructive command:

```sh
git status --short --branch && git rev-parse HEAD
```

Observed:

```text
## feat/m4-readonly-fork-adoption...origin/feat/m4-readonly-fork-adoption
?? docs/plan/approved_browser_baseline_2026-10-10.md
?? docs/plan/companion_execution_2026-10-10.md
?? docs/plan/execution_progress_2026-10-10.md
?? docs/plan/remind_execution_2026-10-10.md
?? docs/plan/remind_r05_execution_2026-10-10.md
773132af27be9ddb06d4d4784197fba8b322185d
```

All pre-existing files preserved. No git integration or final git re-audit. The configured webServer regenerated only its normal ignored production `apps/server/dist/assets/client.js` and stylesheet; console reported `18.2kb` JS bundle, build completed in 3ms.

## Configuration and isolation

Read `apps/server/playwright.config.ts`, root/server package scripts, existing conversation/citation scenarios, harness temp-root/shutdown/ports, and prior docs/plan evidence before execution. Config covers `conversation.spec.ts`, `citation_recovery.spec.ts`, `sse_history.spec.ts`; Chromium Desktop Chrome project, one worker, fullyParallel=false, retries=0, 60-second test timeout, 15-second assertion timeout. Existing webServer command:

```sh
node scripts/build-ui.mjs && node --import tsx e2e/server.ts
```

`CI=true` disables existing-server reuse. PATH places installed Node ahead of ambient paths; tsx resolves from installed server dependencies. No pnpm/npx invocation and no auto-install. Initial listener check showed no listeners on 4173/4174/4175:

```sh
ss -ltnp 'sport = :4173 or sport = :4174 or sport = :4175'
```

Owned isolated root created with:

```sh
mktemp -d /tmp/companion-provisioned-browser-2026-10-10.XXXXXX
```

Returned `/tmp/companion-provisioned-browser-2026-10-10.OBJbKR`. `TMPDIR` contained the deterministic fake harness SQLite DB (`companion-e2e-5cZ8tc/companion.sqlite` plus WAL/SHM), Playwright/tsx caches and browser profiles. No real-user DB, OAuth, LLM, Calendar or other live provider was used. Existing Hono/RunEngine served the production UI and real API, with deterministic fake RunStrategy and loopback control/SSE fault proxy.

## Exact single baseline command

Cwd `/home/molmot/companion_harness/apps/server`; equivalent shell spelling of the actual direct argv/environment invocation:

```sh
env PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-provisioned-browser-2026-10-10.OBJbKR PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/companion-provisioned-browser-2026-10-10.OBJbKR/baseline.json DEBUG=pw:browser,pw:protocol /home/molmot/.local/bin/node /home/molmot/companion_harness/node_modules/@playwright/test/cli.js test --config /home/molmot/companion_harness/apps/server/playwright.config.ts --output /tmp/companion-provisioned-browser-2026-10-10.OBJbKR/results --trace on --reporter list,json
```

Executed once with Python `subprocess.run(command, cwd=..., env=..., stdout=baseline-console.log, stderr=subprocess.STDOUT, timeout=1000)` to preserve complete output, rather than using shell output redirection. Trace/report/debug are evidence settings only; config/specs were not changed. No standalone browser rerun or additional test run.

Installed module resolution used Node `createRequire(realpathSync("node_modules/@playwright/test/cli.js"))`; actual CLI resolved to `.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/cli.js`, with playwright/core both 1.63.0. An initial resolution-only probe used the symlink path rather than its realpath and returned `Cannot find module 'playwright/package.json'`; corrected realpath resolution succeeded. This was not a browser or E2E attempt and changed nothing.

## Genuine runtime/browser/UI evidence

Captured within the above full run, not inferred from downloaded-browser metadata or an emulated User-Agent:

```text
pw:browser <launched> pid=76544
pw:protocol SEND ► {"id":1,"method":"Browser.getVersion"}
pw:protocol ◀ RECV {"id":1,"result":{"protocolVersion":"1.3","product":"HeadlessChrome/153.0.8010.12","revision":"@971a7443b0c9b0a9b2860529b33331b76077ec62","userAgent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36","jsVersion":"15.3.76.4"}}
```

Launched executable: `/home/molmot/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Desktop Chrome config later emulates a Windows UA; that emulated UA is not used as runtime-version proof. Chromium emitted D-Bus connection warnings, but browser execution and all assertions passed; no suppression or remediation was attempted.

Observed real harness readiness:

```text
e2e-server-ready http://127.0.0.1:4173
e2e-proxy-ready http://127.0.0.1:4175
e2e-control-ready http://127.0.0.1:4174
```

All 12 ZIP traces were inspected for actual `goto` actions and recorded expectations. Conversation/citation traces navigate `/` against baseURL `http://127.0.0.1:4173`; corrupt-cursor/history traces navigate that explicit app origin. Native reconnect and gap traces navigate `http://127.0.0.1:4175/`. Protocol confirms real document requests and 200 responses, production `/assets/client.js` and CSS loads, real API calls and `Network.eventSourceMessageReceived` run events. Thus the counts below are **executed UI scenario results**, not source inventory, health-only readiness or fixture-launch counts.

## Executed browser cases

Every case has `status: passed`, `retry: 0`, empty result errors and an archived `trace.zip` attachment. Global report errors is empty.

| Existing spec/line | Executed case | Result | Duration ms |
| --- | --- | --- | ---: |
| citation_recovery.spec.ts:62 | citation drawer shows the escaped stored snapshot and CAS-selects it (stale PUT conflicts) | PASS | 2278 |
| citation_recovery.spec.ts:123 | lost delivery replays the same frozen key and reload recovers the answer | PASS | 360 |
| citation_recovery.spec.ts:232 | reload with an unknown pending key asks for resend without recreating | PASS | 146 |
| conversation.spec.ts:37 | send answers with the deterministic echo | PASS | 214 |
| conversation.spec.ts:50 | type while active keeps submit disabled, stop cancels the run | PASS | 571 |
| conversation.spec.ts:73 | failure surfaces a retry that succeeds | PASS | 269 |
| conversation.spec.ts:92 | privacy: strict CSP, no inline script, minimal localStorage | PASS | 202 |
| sse_history.spec.ts:175 | native SSE reconnect resumes and answers once | PASS | 3580 |
| sse_history.spec.ts:230 | dropped SSE frame recovers via JSON gap catch-up | PASS | 508 |
| sse_history.spec.ts:285 | corrupt stored cursor (ahead) recovers on the live run | PASS | 241 |
| sse_history.spec.ts:285 | corrupt stored cursor (malformed) recovers on the live run | PASS | 526 |
| sse_history.spec.ts:425 | seeded older history renders oldest-first without duplicates | PASS | 190 |

Privacy case duration is sourced from JSON report; consult archived JSON for exact per-case fields. No observed failed assertion or product root-cause diagnosis is needed for this baseline.

## Preserved evidence and cleanup

Session-local archive: `local://provisioned_browser_baseline_2026-10-10_results.tar.gz`, containing original `baseline.json`, full `baseline-console.log`, `results/.last-run.json`, and all 12 result directories/trace ZIPs. These are session-local artifacts, not committed repository artifacts. JSON attachment paths retain the original temporary root; use the corresponding `results/.../trace.zip` relative archive members after extraction.

Archive command (cwd repo root):

```sh
tar -czf /tmp/companion-provisioned-browser-2026-10-10.OBJbKR/provisioned_browser_baseline_2026-10-10_results.tar.gz -C /tmp/companion-provisioned-browser-2026-10-10.OBJbKR baseline.json baseline-console.log results && cp /tmp/companion-provisioned-browser-2026-10-10.OBJbKR/provisioned_browser_baseline_2026-10-10_results.tar.gz local://provisioned_browser_baseline_2026-10-10_results.tar.gz
```

The tool resolves `local://` for coreutils `cp`; tar receives only a normal filesystem path. Archive/copy exited 0 before cleanup. Runtime log confirms browser pid76544 gracefully exited 0 and completed browser temporary-directory cleanup. Post-run `ss` with the same port expression showed no listeners; Playwright stopped the configured webServer. Isolated DB/WAL/SHM and caches remained inside the owned scratch root, which was removed with:

```sh
rm -rf /tmp/companion-provisioned-browser-2026-10-10.OBJbKR
```

Cleanup exited 0. No processes were killed outside the configured runner and no existing user/source/dependency/browser-cache files were removed. Report is saved as `local://provisioned_browser_baseline_2026-10-10.md`.

## Scope at this baseline

Browser availability and the existing 12 scenarios are proven above. This baseline did not implement or close C04/C05. Subsequent coverage and acceptance evidence are recorded separately in [browser resilience execution](browser_resilience_execution_2026-10-10.md). The original session-local archive provenance above is preserved.
