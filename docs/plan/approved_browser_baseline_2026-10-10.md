# Approved Chromium download and existing E2E baseline — 2026-10-10

## Scope and outcome

User approved the browser download only. Installed Node 24.12.0 and installed Playwright 1.63.0 were invoked directly: no npx/pnpm auto-fetch, workspace dependency installation, apt update/install, `--with-deps`, live OAuth/LLM/Calendar, real-user database, git integration, or product/test source edits.

**Matching browser download succeeded. Real-browser baseline remains blocked by missing OS shared libraries, not a demonstrated product defect.** The full existing configuration was run once (12 cases, one worker, zero retries); all 12 failed during browser fixture launch before any browser page existed. Production UI built and the real Hono/RunEngine harness with deterministic fake strategy, control server, SSE proxy, and an isolated temporary SQLite root booted successfully. Browser acceptance for C04/C05 was not exercised.

This repository report is the durable evidence summary linked from the [execution progress index](execution_progress_2026-10-10.md#2026-10-10-追記承認済み-browser-download-後の現状). Raw `baseline.json`, all 12 launch-only traces/error contexts (`results/`), baseline console output, and apt minimal-provider simulation output are retained **only in the original session archive**, not committed repository evidence: archive `approved_browser_baseline_2026-10-10_results.tar.gz` under the session-local directory shown in the archive command below; original session output IDs 35 and 44. These identifiers are archival provenance, not repository links or a guarantee of availability outside that session. Scratch root and its databases/results/caches were removed after archiving. Downloaded browser cache is intentionally retained.

## Start-of-turn protection

One non-destructive repository-state inspection was performed at meaningful start, cwd `/home/molmot/companion_harness`:

```sh
git status --short
```

Observed pre-existing untracked files, all preserved:

```text
?? docs/plan/companion_execution_2026-10-10.md
?? docs/plan/execution_progress_2026-10-10.md
?? docs/plan/remind_execution_2026-10-10.md
?? docs/plan/remind_r05_execution_2026-10-10.md
```

No source/test/package/lockfile writes were performed. The permitted baseline webServer command regenerated normal ignored UI output `apps/server/dist/assets/client.js` (18.2kb). No final git re-audit was performed during this baseline attempt.

## Installed CLI, expected browser, and exact download commands

Cwd `/home/molmot/companion_harness`:

```sh
command -v node && node --version && command -v pnpm && readlink -f node_modules/@playwright/test/cli.js
/home/molmot/.local/bin/node node_modules/@playwright/test/cli.js --version && /home/molmot/.local/bin/node node_modules/@playwright/test/cli.js install --dry-run chromium
/home/molmot/.local/bin/node node_modules/@playwright/test/cli.js install chromium
```

Runtime observations: `/home/molmot/.local/bin/node` returned `v24.12.0`; pnpm path existed but was not executed; CLI resolved to `node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/cli.js`; CLI returned `Version 1.63.0`.

The dry-run and download outputs agreed on:

- Chrome for Testing **153.0.8010.12**, Playwright Chromium revision **1243**, `/home/molmot/.cache/ms-playwright/chromium-1243`, URL `https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip` (186.8 MiB).
- Chrome Headless Shell **153.0.8010.12**, revision **1243**, `/home/molmot/.cache/ms-playwright/chromium_headless_shell-1243`, URL `https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip` (114.3 MiB).
- Playwright's matching FFmpeg companion revision **1011**, `/home/molmot/.cache/ms-playwright/ffmpeg-1011`, URL `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux.zip` (2.3 MiB). Downloaded by the standard `install chromium` command; no OS/package dependency installation.

Installed `playwright-core/browsers.json` independently declares both Chromium entries as revision `1243`, browserVersion `153.0.8010.12`. This is download/package metadata, **not a successful running browser version observation**.

Version checking was attempted, not silently represented as successful:

```sh
/home/molmot/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell --version
```

This initial path assumption returned command-not-found (127); cache directory inspection found the actual executable below. Corrected version check:

```sh
/home/molmot/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome --version && /home/molmot/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell --version
```

Chrome exited 127: `error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory`. Because of `&&`, the headless `--version` command was not executed. No launch/test was rerun to confirm a known failure.

## Full existing baseline invocation and exercised paths

[`apps/server/playwright.config.ts`](../../apps/server/playwright.config.ts) matches the existing [`conversation.spec.ts`](../../apps/server/e2e/conversation.spec.ts), [`citation_recovery.spec.ts`](../../apps/server/e2e/citation_recovery.spec.ts), and [`sse_history.spec.ts`](../../apps/server/e2e/sse_history.spec.ts); it uses Desktop Chrome, one worker, retries 0. Existing webServer command is `node scripts/build-ui.mjs && node --import tsx e2e/server.ts`. `CI=1` prevents reuse of an unrelated server. Production UI is served through the real Hono app, not a fake page. Harness strategy is deterministic fake; no model/network provider or real-user DB is used.

Temp root creation (cwd repository root):

```sh
mktemp -d /tmp/companion-approved-browser-2026-10-10.XXXXXX
```

Returned `/tmp/companion-approved-browser-2026-10-10.rwRdeb`.

The **one** full E2E invocation, cwd `/home/molmot/companion_harness/apps/server`:

```sh
env PATH="/home/molmot/.local/bin:$PATH" CI=1 TMPDIR=/tmp/companion-approved-browser-2026-10-10.rwRdeb PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/companion-approved-browser-2026-10-10.rwRdeb/baseline.json /home/molmot/.local/bin/node /home/molmot/companion_harness/node_modules/@playwright/test/cli.js test --config /home/molmot/companion_harness/apps/server/playwright.config.ts --output /tmp/companion-approved-browser-2026-10-10.rwRdeb/results --trace on --reporter list,json
```

Exit code **1**, wall time 7.34s. JSON report start `2026-10-10T16:28:19.484Z`, duration `6756.870999999999` ms, expected/pass 0, unexpected/failed 12, skipped 0, flaky 0; every result `retry: 0`.

Observed readiness:

```text
e2e-server-ready http://127.0.0.1:4173
e2e-proxy-ready http://127.0.0.1:4175
e2e-control-ready http://127.0.0.1:4174
```

**Actual browser page path exercised: none.** Browser fixture initialization failed before page creation/`page.goto`; neither `http://127.0.0.1:4173/` nor `http://127.0.0.1:4175/` was navigated. Those are the spec-intended real UI paths, not executed UI proof. WebServer readiness checked `/health/live`; the archived conversation trace also records Node-side `POST http://127.0.0.1:4174/release` returning 200 during teardown. Its trace `browserName` is empty; no page navigation appears. Control API and health readiness do not establish UI execution.

### Reported cases (all launch-blocked, failed)

| Spec line | Case |
| --- | --- |
| citation_recovery.spec.ts:62 | citation drawer shows the escaped stored snapshot and CAS-selects it (stale PUT conflicts) |
| citation_recovery.spec.ts:123 | lost delivery replays the same frozen key and reload recovers the answer |
| citation_recovery.spec.ts:232 | reload with an unknown pending key asks for resend without recreating |
| conversation.spec.ts:37 | send answers with the deterministic echo |
| conversation.spec.ts:50 | type while active keeps submit disabled, stop cancels the run |
| conversation.spec.ts:73 | failure surfaces a retry that succeeds |
| conversation.spec.ts:92 | privacy: strict CSP, no inline script, minimal localStorage |
| sse_history.spec.ts:175 | native SSE reconnect resumes and answers once |
| sse_history.spec.ts:230 | dropped SSE frame recovers via JSON gap catch-up |
| sse_history.spec.ts:285 | corrupt stored cursor (ahead) recovers on the live run |
| sse_history.spec.ts:285 | corrupt stored cursor (malformed) recovers on the live run |
| sse_history.spec.ts:425 | seeded older history renders oldest-first without duplicates |

All errors begin `browserType.launch: Target page, context or browser has been closed`, but the decisive child-process log is:

```text
/home/molmot/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory
<process did exit: exitCode=127, signal=null>
```

This is an OS runtime prerequisite failure, not a product/test assertion failure.

## Reachable read-only OS prerequisite diagnosis

`/etc/os-release`: Ubuntu **26.04.1 LTS (Resolute Raccoon)**, `VERSION_ID=26.04`, x64. Playwright 1.63.0 includes an explicit `ubuntu26.04-x64` dependency map; no unsupported-distro fallback is required.

Exact commands (cwd repository root):

```sh
ldd /home/molmot/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell && ldd /home/molmot/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
id && command -v sudo && command -v apt-get
sudo -n -l
/home/molmot/.local/bin/node node_modules/@playwright/test/cli.js install-deps --help
apt-get install -s --no-install-recommends libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libasound2t64 libcups2t64 libcairo2 libpango-1.0-0
/home/molmot/.local/bin/node node_modules/@playwright/test/cli.js install-deps --dry-run chromium
```

`ldd` identifies **all unresolved SONAMEs visible in these executable dependency graphs**:

| Missing SONAME | Ubuntu 26.04 provider | Headless shell | Full Chrome |
| --- | --- | --- | --- |
| libatk-1.0.so.0 | libatk1.0-0t64 | missing | missing |
| libatk-bridge-2.0.so.0 | libatk-bridge2.0-0t64 | missing | missing |
| libatspi.so.0 | libatspi2.0-0t64 | missing | missing |
| libXcomposite.so.1 | libxcomposite1 | missing | missing |
| libXdamage.so.1 | libxdamage1 | missing | missing |
| libXfixes.so.3 | libxfixes3 | missing | missing |
| libasound.so.2 | libasound2t64 | missing | missing |
| libcups.so.2 | libcups2t64 | not missing in headless graph | missing |
| libcairo.so.2 | libcairo2 | not missing in headless graph | missing |
| libpango-1.0.so.0 | libpango-1.0-0 | not missing in headless graph | missing |

The current configured headless runner needs the first seven provider packages (some are installed transitively by others). The ten-provider union also addresses full Chrome's unresolved libraries. Mapping is grounded in installed Playwright's Ubuntu 26.04 `lib2package`/Chromium lists and successful apt simulation, not obsolete non-t64 Debian names from the downloaded binary's generic `deb.deps`. Missing providers could conceal further transitive library requirements; apt simulation resolves package dependencies, but a running browser has not been revalidated.

Minimal ten-provider-union apt simulation exited 0: **0 upgraded, 28 newly installed, 0 removed, 2 not upgraded**. The additional 18 packages were `at-spi2-common`, `fontconfig`, `fontconfig-config`, `fonts-dejavu-core`, `fonts-dejavu-mono`, `libasound2-data`, `libavahi-client3`, `libavahi-common-data`, `libavahi-common3`, `libdatrie1`, `libfontconfig1`, `libgraphite2-3`, `libharfbuzz0b`, `libthai-data`, `libthai0`, `libxcb-render0`, `libxi6`, `libxres1`. Simulation did not install anything; apt's incidental autoremove suggestion was not acted upon.

Official Playwright `install-deps --dry-run chromium` exited 1 and reported **36 missing installation packages** (includes font/Xvfb tooling and transitives, broader than the executable SONAME providers):

```text
at-spi2-common fontconfig fontconfig-config fonts-freefont-ttf fonts-ipafont-gothic fonts-liberation fonts-noto-color-emoji fonts-tlwg-loma-otf fonts-unifont fonts-wqy-zenhei libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libavahi-client3 libavahi-common-data libavahi-common3 libcairo2 libcups2t64 libdatrie1 libfontconfig1 libgraphite2-3 libharfbuzz0b libpango-1.0-0 libthai-data libthai0 libxcb-render0 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxres1 xfonts-cyrillic xfonts-scalable xvfb
```

Installed CLI code confirms Linux `--dry-run` runs only `apt-get install -s --no-install-recommends ...`; it does **not** run apt update, ask sudo, or install packages. The normal official command (documented here, **not executed**) is:

```sh
# cwd /home/molmot/companion_harness; requires explicit new OS-package permission
/home/molmot/.local/bin/node node_modules/@playwright/test/cli.js install-deps chromium
```

Normal command escalates through `sudo -- sh -c 'apt-get update && apt-get install -y --no-install-recommends ...'` and includes the Chromium runtime packages plus Xvfb/font tooling. It changes system apt index/cache, downloads/configures OS packages and their dependencies, writes system libraries/fonts/tooling, and runs package configuration/triggers; the exact package plan can change after apt update. It does not need workspace npm/pnpm changes. A narrower OS-package option would be `sudo apt-get install --no-install-recommends` with the seven headless-provider packages (or ten-provider union above); this also needs separate permission and may require apt-index refresh. Neither option is authorized by browser-only approval.

Privilege observations: current uid/gid 1000 (`molmot`), not root; group membership includes `sudo`. `/usr/bin/sudo` and `/usr/bin/apt-get` exist. `sudo -n -l` exited 1: `sudo: interactive authentication is required`. Thus sudo is installed but unattended escalation was not available; no password prompt or actual elevated command/install was attempted. A privileged user action or credentials are required if choosing a local install rather than an already-provisioned environment.

## Cleanup and preserved boundaries

Owned server pid 70748 no longer existed after Playwright exit; `ss -ltnp 'sport = :4173 or sport = :4174 or sport = :4175'` showed no listeners. Playwright removed browser profiles but left its isolated harness DB/cache; these were removed with the owned temporary root only. Existing user files/evidence, dependencies, browser cache, and generated production assets were left alone.

Archive and cleanup commands:

```sh
tar -czf /home/molmot/.omp/agent/sessions/-/2026-10-10T15-48-06-437Z_01a12680-04a5-77a8-b2b8-69a691724b8e/local/approved_browser_baseline_2026-10-10_results.tar.gz -C /tmp/companion-approved-browser-2026-10-10.rwRdeb baseline.json results && rm -rf /tmp/companion-approved-browser-2026-10-10.rwRdeb
```

An initial archive command using `local://...` directly as tar's output path failed because tar interpreted it as a remote host; no archive/source data was removed on that failure. The tool URI mismatch was reported and the resolved scratch filesystem path was used successfully.

## Concrete prerequisites and acceptance handoff for C04/C05

1. **Environment prerequisite:** separate explicit permission + privileged OS-library installation (noninteractive sudo currently unavailable), or use an already-provisioned compatible environment. Matching browser cache alone is insufficient. No repeat test/launch is justified until that prerequisite changes.
2. **Real-browser prerequisite:** after OS prerequisite remediation, the executing maintainer should perform a new, clearly dated one-time existing baseline with this installed CLI/config/isolated-root pattern, proving actual navigation to `/` and recording runtime browser version. The current 12 failed fixtures do not count as 12 UI assertions executed.
3. **Coverage prerequisite:** reuse current sequential polling/reducer code and existing fake harness; do not add scaffolding while unable to exercise a browser. Existing reconnect/gap/corrupt-cursor/history tests are source inventory only for this run. C04 needs forced SSE unavailability, terminal JSON fallback, transient-error recovery, five-failure stop+notice, no-overlap requests, no unintended Run cancel, and nonterminal `cancel_requested` handling. C05 needs real stream duplicates before/after terminal, one answer/effect, apply-before-persist cursor proof, and gap ordering; avoid duplicating existing gap/reconnect tests after a real successful baseline.
4. No C04/C05 product/test edits were made, and no acceptance box should be closed from this environment-blocked attempt.
