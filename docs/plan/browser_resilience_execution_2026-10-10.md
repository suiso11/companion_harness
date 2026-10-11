# Browser resilience execution — 2026-10-10

## Outcome and scope

**Corrected PASS: all 17 configured real-browser scenarios passed at 17:05:14.264Z; 0 skipped, failed, flaky, or retries.** The original 16:49 run also genuinely passed17, but its C05-03 terminal-consumer proof was incomplete: proxy byte duplication did not prove a second native dispatch before production closed EventSource. The corrected held-gap scenario proves two actual terminal callbacks on the same native instance before releasing a genuine JSON page; details below. Full Vitest **87 files /1089 tests passed** is retained earlier evidence, not rerun for this correction.

Repository `/home/molmot/companion_harness`, branch `feat/m4-readonly-fork-adoption`, supplied/protected HEAD `773132af27be9ddb06d4d4784197fba8b322185d` **plus uncommitted changes listed below**. No commit, merge, rebase, package/lock change, installation, browser download, live LLM/MCP/Calendar, or real user DB access. The user-completed OS dependencies were accepted without apt/ldd re-probing. Earlier download/launch failures remain historical evidence, not current failures. [Provisioned existing-12 baseline](provisioned_browser_baseline_2026-10-10.md) records the separately successful prerequisite run.

This does **not** claim all Phase 1, M3/§16, C06 accepted-202 active reload, Windows 11 manual smoke, or remote Windows/Linux CI for these uncommitted edits complete. The agreed plan and checklist are unchanged.

## Coverage mapped before changes

- Production `apps/server/src/ui/client.ts`: initial SSE timeout 5000ms, native EventSource (not replaced), `catchUp` uses real paginated JSON events, sequential fallback with 1000ms interval, success resets the failure streak, exactly five consecutive errors shows `状態の取得に失敗しました。再読み込みしてください` and stops. Terminal decision uses `stopVisible`, so `run.cancel_requested` remains active. Run cancellation occurs only through explicit Stop, never polling failure/disconnect.
- `applySerialized` and `catchUp` call the existing pure reducer before cursor persistence. Ignored duplicates do not persist/re-render. Serialized gaps await real JSON catch-up; native wire cursor and saved application cursor are separate observations, not an equality contract. No DOM-before-storage rule is invented.
- Reused `apps/server/test/m3_ui.test.ts`: `ignores duplicates, demands catch-up on gaps, advances on unknown`; `catch-up-applied terminal re-seen as duplicate stays answered`; `cancel_requested is non-terminal: stays active until run.cancelled`. Existing terminal-hydration unit coverage is retained. These unit contracts support C04-01/C05-01 but are not substituted for Browser acceptance.
- Existing real Browser native reconnect, dropped-frame catch-up, corrupt cursors, history ordering, cancellation, retry, citation and privacy paths were inventoried. Reconnect/gap were strengthened, not copied into duplicate rows. Production UI/reducer and unit tests were not edited; no product bug was exposed by the run. Source-contract tests were not touched or re-pinned.

## Permanent implementation and isolation

| File | Intended change |
| --- | --- |
| `apps/server/e2e/server.ts` | Extend the existing sole loopback proxy with initial no-header SSE holds, bounded boolean JSON failure schedules (503 transport failures only), held genuine upstream pages, exact real-frame duplication, page lifecycle counters/timings, history/cancel observations. Controls validate bounded schedules; every hold has a 15s bound, reset/shutdown release timers/sockets. Generation guards prevent old request completion counters leaking into the next test. Reset now releases fake hangers; SSE cleanup is idempotent and destroys upstream streams. |
| `apps/server/e2e/ports.ts` | Describe the transport proxy's broader fault surface; no changed ports or fixture inputs. |
| `apps/server/e2e/resilience.ts` | Shared fixture/control/canonical-read helpers, read-side cursor/request observation, and passive same-native-instance run-event observation after unchanged production listener registration. Constructor, close, fetch, event data and production handler are not replaced. |
| `apps/server/e2e/polling.spec.ts` | Four permanent actual UI fallback scenarios plus genuine CDP runtime metadata attachment and canonical server proof attachments. |
| `apps/server/e2e/sse_history.spec.ts` | Strengthen existing held-gap/reconnect test with genuine terminal duplication and consumer delivery counts; retain distinct preterminal duplication test without terminal-duplication arm/claim. Still17 configured cases. |
| `apps/server/playwright.config.ts` | Add polling spec to the full configured one-worker/retries=0 Chromium suite. |
| `README.md` | Current 17-case coverage/results and truthful remaining scope. |
| `docs/plan/browser_resilience_execution_2026-10-10.md` | This new execution/acceptance evidence. |
| `docs/plan/provisioned_browser_baseline_2026-10-10.md` | Persist prior genuine 12-case baseline with original session archive provenance, without scratch integration instructions. |
| `docs/plan/execution_progress_2026-10-10.md` | Index current evidence while preserving historical failures. |

Cancellation fixture detail: the previous fake harness grace50ms could hide `cancel_requested`. The fake engine now uses the **production 3000ms watchdog bound**; normally cooperative TEXT_HANG aborts still reject immediately. Only `/arm-cancel-hold` makes the fake strategy non-cooperative until `/release`; the actual repository cancel transaction/event and RunEngine watchdog are unchanged. The successful scenario observes the genuine nonterminal before release, then real cancelled; actual requested-to-terminal duration **1255ms**, within the production bound. No production cancellation semantics or DTO are fabricated.

Owned isolated root: `/tmp/companion-resilience-2026-10-10.YmV40n`. TMPDIR includes all test-only stores, Playwright profiles and caches; fake harness DB was `companion-e2e-T87JjL/companion.sqlite`. No real database selected. CI=true prevents reuse; one worker, retries0, all17 traces enabled. Normal configured webServer built ignored production assets (`client.js`18.2kb, 3ms) then ran the real Hono app/RunEngine/temp SQLite/deterministic strategies. No successful API response or synthetic RunEvent was injected.

## Original 16:49 check commands and outcomes (historical run)

Installed binaries invoked directly, avoiding pnpm11 automatic installation. Root cwd unless noted; environment for all commands:

```sh
PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-resilience-2026-10-10.YmV40n
```

```sh
/home/molmot/companion_harness/node_modules/.bin/biome check .
/home/molmot/companion_harness/node_modules/.bin/tsc --noEmit -p tsconfig.json
/home/molmot/companion_harness/node_modules/.bin/tsc --noEmit -p apps/server/tsconfig.e2e.json
/home/molmot/companion_harness/node_modules/.bin/vitest run
```

Browser cwd `/home/molmot/companion_harness/apps/server`:

```sh
env PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-resilience-2026-10-10.YmV40n PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/companion-resilience-2026-10-10.YmV40n/browser.json /home/molmot/.local/bin/node /home/molmot/companion_harness/node_modules/@playwright/test/cli.js test --config /home/molmot/companion_harness/apps/server/playwright.config.ts --output /tmp/companion-resilience-2026-10-10.YmV40n/results --trace on --reporter list,json
```

Executed sequentially once after implementation via subprocess with separate captured log files, no shell auto-installer. Report start `2026-10-10T16:49:16.279Z`, duration **67565.669ms**; Browser process exit0, wall68.061s.

| Check | Actual outcome |
| --- | --- |
| Initial Biome (0.268s) | exit1: manual formatting/import-order issues and now-unused TEXT_OK import. No fixes/formatter run. |
| Root noEmit (4.022s) | exit0. |
| Initial E2E noEmit (2.268s) | exit2 solely TS6133 unused TEXT_OK after gap changed to hanging strategy. |
| Full Vitest (10.073s wall) | exit0; 87/87 files, 1089/1089 tests, reported9.73s. |
| Full configured actual Browser | exit0;17/17 pass, no report errors/skips/flakes/retries. |
| Corrected Biome (0.266s) | exit0, checked184 files, no fixes. Existing `recommended` config deprecation is informational only; config unchanged. |
| Corrected E2E noEmit (2.268s) | exit0. |

The demonstrated static issues were reported and manually corrected; only Biome and dedicated E2E noEmit were rerun once to check those corrections. No Browser/Vitest/root noEmit rerun merely to reconfirm green. Post-runtime source edits are formatting, unused import removal and harness comments; assertions/fault semantics are the exercised ones. Runtime source locations below come from the retained report/traces before formatting; final line numbers can differ. No build/lint/tests/formatter ran mid-flight.

## Actual browser identity (C04-08, not User-Agent inference)

Playwright **1.63.0**, configured `chromium`/Desktop Chrome. `Browser.getVersion` was sent through a genuine CDP session on the actual test page in the long-run scenario:

```json
{"browserType":"chromium","version":{"protocolVersion":"1.3","product":"HeadlessChrome/153.0.8010.12","revision":"@971a7443b0c9b0a9b2860529b33331b76077ec62","userAgent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36","jsVersion":"15.3.76.4"}}
```

Retained `browser-runtime.json` is decoded from the genuine test attachment; no standalone browser smoke or emulated Windows User-Agent is used as version evidence.

## Original 16:49 executed scenarios (all retry0; C05-03 proof incomplete)

| Runtime spec location | Exact executed name | Result | Duration ms |
| --- | --- | --- | ---: |
| `citation_recovery.spec.ts:62` | citation drawer shows the escaped stored snapshot and CAS-selects it (stale PUT conflicts) | PASS | 844 |
| `citation_recovery.spec.ts:123` | lost delivery replays the same frozen key and reload recovers the answer | PASS | 264 |
| `citation_recovery.spec.ts:232` | reload with an unknown pending key asks for resend without recreating | PASS | 130 |
| `conversation.spec.ts:37` | send answers with the deterministic echo | PASS | 184 |
| `conversation.spec.ts:50` | type while active keeps submit disabled, stop cancels the run | PASS | 556 |
| `conversation.spec.ts:73` | failure surfaces a retry that succeeds | PASS | 516 |
| `conversation.spec.ts:92` | privacy: strict CSP, no inline script, minimal localStorage | PASS | 174 |
| `polling.spec.ts:27` | JSON fallback continues through long run and delayed pages without overlap or implicit cancel | PASS | 15889 |
| `polling.spec.ts:99` | JSON fallback recovers from transient errors and successful pages reset the failure streak | PASS | 15673 |
| `polling.spec.ts:139` | JSON fallback stops exactly after five consecutive failures with the fixed notice | PASS | 11849 |
| `polling.spec.ts:178` | JSON fallback observes real cancel_requested as active and polls until cancelled | PASS | 8665 |
| `sse_history.spec.ts:183` | native SSE reconnect resumes and answers once | PASS | 3537 |
| `sse_history.spec.ts:246` | dropped SSE frame recovers via held JSON gap catch-up across reconnect | PASS | 3535 |
| `sse_history.spec.ts:333` | actual preterminal and terminal duplicate SSE frames apply answer and history effect once | PASS | 1951 |
| `sse_history.spec.ts:393` | corrupt stored cursor (ahead) recovers on the live run | PASS | 225 |
| `sse_history.spec.ts:393` | corrupt stored cursor (malformed) recovers on the live run | PASS | 523 |
| `sse_history.spec.ts:533` | seeded older history renders oldest-first without duplicates | PASS | 176 |

## C04 acceptance matrix

| Criterion | Reused/added evidence | Actual runtime proof |
| --- | --- | --- |
| C04-01 existing implementation/unit coverage | Reused client/reducer/unit paths described above; unchanged full Vitest | 1089 pass; dynamic scheduling is proven by the following Browser cases, not source-string assertions. |
| C04-02 initial SSE never establishes; continued JSON through terminal beyond intervals | Added long-run/delayed-pages test | blockedSse1, established SSE0; eight finished pages before hold,11 total pages. Real queued→started→completed, exactly one visible echo:hang, composer enabled at actual terminal. |
| C04-03 transient errors recover, successful catch-up resets streak | Added transient test | Four503s→two genuine200 pages completing one catchUp→four503s→success→terminal; eight failures total,13 pages. A cumulative/consecutive-reset regression would stop before completion. One visible answer; canonical completed seq3. |
| C04-04 exactly five consecutive failures fixed notice + stop | Added five-failures test | failedPages=eventsPageRequests=pagesFinished=5. Notice visible in actual composer live-region. Counts remain5 across2200ms (two poll intervals) and durable execution later completes after release; no fabricated terminal UI. |
| C04-05 delayed sequential polling/no overlap | Added long-run; `sequential-poll-proof.json` + trace network | One genuine page held2312ms proxy/2316ms browser; count unchanged over2200ms hold, maxPagesInFlight1, final inFlight0. Browser requestfinished/requestfailed timestamps assert every next request starts after prior finishes. |
| C04-06 ordinary UI/transport loss does not cancel durable Run | Added long-run/five-failures + reused native reconnect | Input fill/cursor operation while polling keeps submit disabled; proxy cancelRequests0, canonical still running with only queued/started. Lost initial SSE and exhausted polling failures do not cancel; released strategy completes. Existing stream destruction also leaves durable run nonterminal. |
| C04-07 cancel_requested nonterminal until cancelled | Added cancellation test, reused reducer contract | Explicit visible Stop posts once; genuine run.cancel_requested seq3/status observed, stopped notice while Stop remains visible and submit disabled. Another real page completes while still active, then release yields cancelled seq4 and UI release; seven pages, one cancel request,1255ms requested-to-terminal. |
| C04-08 browser/spec/result evidence | Runtime metadata/table/archive | Actual Chromium HeadlessChrome153.0.8010.12 CDP; all four named Browser cases pass, traces retained. |

Trace request-timing corroboration for C04-05 (browser proxy-origin requests only; trace also records separate Node-side canonical reads to app4173): held browser GET started **16:49:33.710Z**, network lifetime **2314.512ms**; next browser GET starts **16:49:37.026Z**, then the immediate final catch-up pagination at **16:49:37.037Z**. No browser request begins during the held GET. The JSON attachment additionally asserts all11 browser request lifetimes; it does not count fixture reads as polling.

## C05 acceptance matrix

| Criterion | Reused/added evidence | Actual runtime proof |
| --- | --- | --- |
| C05-01 existing duplicate reducer coverage | Reused `ignores duplicates...` and catch-up terminal duplicate unit tests | Unchanged full unit87/1089 pass; pure reducer coverage remains distinct from Browser runtime. |
| C05-02 preterminal duplicates, no double rendering | Distinct preterminal duplicate test | Actual queued seq1 and started seq2 each forwarded twice; duplicatedFrames2 before release. Cursor writes exactly[1,2], one user bubble and one generating state. Terminal duplication is no longer armed or claimed in this case. |
| C05-03 terminal duplicate no second answer/effect | Corrected existing held-gap test, not a new same-path row | Two seq3 run.completed dispatch observations on sourceId1, native currentTarget=true, readyState OPEN1, lastEventId3 twice, while genuine page held and saved cursor1/writes[1]. After release one answer, history1→2 stable1200ms, writes[1,2,3] only. Original combined case established wire duplication only and did not satisfy this criterion. |
| C05-04 missing event catch-up ordered convergence | Held gap strengthened in place | Drop real started seq2, duplicate terminal3, hold genuine `/events?after=1` response. Saved cursor stays1/writes[1]; after release canonical queued/started/completed applied in order, writes[1,2,3], one answer. |
| C05-05 apply-before-persist; reconnect cannot lose unapplied events | Corrected held gap plus native reconnect | While catch-up unresolved before/after native reconnect, saved cursor1 and only write1, UI active/no answer. Wire resume Last-Event-ID3 is NOT asserted equal to application cursor1. Genuine JSON catches seq2/3; final cursor3 equals canonical. |
| C05-06 one answer/one observable effect correlated to canonical event | Corrected held-gap JSON attachment + UI assertions | Canonical seq1 queued,2 started,3 completed, exactly one terminal event. Two native terminal deliveries, one visible answer, one history refresh, no extra cursor writes. |
| C05-07 spec/trace/commit provenance | Corrected report/table/archive + protected HEAD/uncommitted files | All17 traces from corrected single run, seven decoded JSON attachments including same-native-instance delivery evidence. Original17-pass archive retained separately; no source/unit count substituted for Browser acceptance. |
| C05-08 existing paths inventoried/reused | Initial coverage mapping | Existing native reconnect and gap strengthened, corrupt cursor variants/history retained; no duplicate reconnect/gap rows or production polling/reducer reimplementation. |

## Archive, trace provenance, cleanup

Session-local retained archive: **`local://browser_resilience_2026-10-10_results.tar.gz`**. SHA-256 **`c6d2d4d88a7b50e785fc579a453ab79ff52cedb3aafaaa8acf85472383af1eda`**. Contains original `browser.json`, Browser console, all17 `results/.../trace.zip`, `.last-run.json`, all initial/corrected check logs, `checks.json`, `trace-summary.json`, CDP metadata and decoded six behavioral proof attachments. It contains no SQLite DB/WAL/SHM or real-user data. Browser JSON attachment paths preserve the original scratch root; archive members use corresponding `results/.../trace.zip` paths after extraction.

Key traces (same run, not new executions):

- `results/polling-JSON-fallback-cont-9c040--overlap-or-implicit-cancel-chromium/trace.zip`
- `results/polling-JSON-fallback-reco-9e9af-es-reset-the-failure-streak-chromium/trace.zip`
- `results/polling-JSON-fallback-stop-f107d-lures-with-the-fixed-notice-chromium/trace.zip`
- `results/polling-JSON-fallback-obse-7e4fc-e-and-polls-until-cancelled-chromium/trace.zip`
- `results/sse_history-dropped-SSE-fr-da7c0-p-catch-up-across-reconnect-chromium/trace.zip`
- `results/sse_history-actual-preterm-6409d-wer-and-history-effect-once-chromium/trace.zip`

All17 ZIPs were inspected programmatically for genuine navigation and recorded expectation actions; the long-run trace contains85 expectation actions and genuine browser network lifetimes. Navigation uses production app4173 or real fault proxy4175 with production UI assets, never a substituted UI. `trace-summary.json` preserves names/locations/network records; fixture-only canonical requests are separate from browser polling observations.

Archive created with installed tar (cwd owned scratch) from explicitly named reports/logs/proofs and `results`, copied via coreutils to the above local URI, checksum recorded, exit0. After runner exit, `ss -ltnp 'sport = :4173 or sport = :4174 or sport = :4175'` showed **no listeners**. Owned root removed with `rm -rf /tmp/companion-resilience-2026-10-10.YmV40n`, exit0, after archive preservation. No unrelated process or user directory was removed; browser cache/dependencies are untouched. Historical baseline archive remains `local://provisioned_browser_baseline_2026-10-10_results.tar.gz` with provenance in its separate document.

## Corrected terminal consumer-delivery run — 17:05

Reviewer finding was valid: original `sse_history.spec.ts:360–365` waited until cursor writes[1,2] before releasing a contiguous terminal3. Production's serialized Promise microtask could close native EventSource before its second dispatch task; `duplicatedFrames3` was wire-only evidence. The earlier17 pass/report/archive remain genuine historical evidence, but the earlier C05-03 consumer-acceptance claim is withdrawn.

The existing gap test now drops genuine seq2, duplicates genuine terminal3, and holds the genuine JSON response. A registration-observation helper calls the original native `addEventListener` with the unchanged production callback/options, then adds one passive observer to that SAME native instance. It never replaces constructor/close/fetch, mutates event data, delays production execution, or injects events/storage. The first production terminal callback naturally awaits missing predecessor catch-up; both native dispatches occur before release.

Actual held proof: exactly **2** completed callbacks, sourceId **1** both, lastEventId **3** both, readyState **1 (OPEN)** both, native currentTarget identity **true** both, identical genuine terminal data. Proxy heldPages1/pagesInFlight1/pagesFinished0, droppedFrames1/duplicatedFrames1; saved cursor1 and actual cursor writes **[1]**, no answer, composer disabled. After native reconnect (wire resume3), genuine page release yields writes **[1,2,3]**, canonical completed3 with only queued/started/completed, exactly one answer and historyRequests **1→2**, stable over1200ms with no additional persistence.

Corrected runtime used owned `/tmp/companion-terminal-proof-2026-10-10.kuoipzqj`, CI=true, one worker/retries0, all17 traces. Test-only SQLite/profile/cache stayed under TMPDIR; normal webServer builds production assets. Production source/API/storage/unit tests were unchanged.

Exact commands (root cwd except Browser cwd `apps/server`):

```sh
env PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-terminal-proof-2026-10-10.kuoipzqj /home/molmot/companion_harness/node_modules/.bin/biome check .
env PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-terminal-proof-2026-10-10.kuoipzqj /home/molmot/companion_harness/node_modules/.bin/tsc --noEmit -p tsconfig.json
env PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-terminal-proof-2026-10-10.kuoipzqj /home/molmot/companion_harness/node_modules/.bin/tsc --noEmit -p apps/server/tsconfig.e2e.json
env PATH="/home/molmot/.local/bin:$PATH" CI=true TMPDIR=/tmp/companion-terminal-proof-2026-10-10.kuoipzqj PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/companion-terminal-proof-2026-10-10.kuoipzqj/browser.json /home/molmot/.local/bin/node /home/molmot/companion_harness/node_modules/@playwright/test/cli.js test --config /home/molmot/companion_harness/apps/server/playwright.config.ts --output /tmp/companion-terminal-proof-2026-10-10.kuoipzqj/results --trace on --reporter list,json
```

Executed once after edits: root noEmit exit0 (4.054s), Browser exit0 (69.235s wall/report68753.353ms), **17/17 passed**, no errors/skips/flakes/retries. Initial Biome exit1 (0.250s) reported three formatting hunks; initial E2E noEmit exit2 (2.245s) reported observer overload typing/null mismatch. Manual formatting and type-only signature/cast correction preserve exercised runtime behavior; only those failing static checks are rerun, not Browser/root/unit. Existing Biome recommended-field deprecation is informational, unchanged.

Corrected case results and durations are retained in `case-summary.json`. Held-gap scenario (runtime line247) passed **4770ms**; distinct preterminal-only scenario (line377) passed **1779ms**. All other15 configured scenarios passed. Genuine same-page CDP metadata again records Playwright1.63.0 / HeadlessChrome153.0.8010.12, revision `@971a7443b0c9b0a9b2860529b33331b76077ec62`; not User-Agent inference.

Corrected read-only review outcome is **not yet supplied**; no approval/no-findings is preclaimed. This report proves local C04/C05 runtime criteria only, never blanket Phase1/M3 completion.

Final corrected **Biome exit0 (0.247s)**, checked184 files/no fixes, and dedicated **E2E noEmit exit0 (2.214s)**. Root noEmit's original correction-run exit0 stands; Browser ran once and units were not rerun. Post-runtime code corrections were formatting and TypeScript-only listener signature/cast, not behavioral changes.

| Corrected runtime location | Executed scenario | Result / ms |
| --- | --- | --- |
| `citation_recovery.spec.ts:62` | citation drawer shows the escaped stored snapshot and CAS-selects it (stale PUT conflicts) | PASS /862 |
| `citation_recovery.spec.ts:123` | lost delivery replays the same frozen key and reload recovers the answer | PASS /255 |
| `citation_recovery.spec.ts:232` | reload with an unknown pending key asks for resend without recreating | PASS /129 |
| `conversation.spec.ts:37` | send answers with the deterministic echo | PASS /173 |
| `conversation.spec.ts:50` | type while active keeps submit disabled, stop cancels the run | PASS /558 |
| `conversation.spec.ts:73` | failure surfaces a retry that succeeds | PASS /516 |
| `conversation.spec.ts:92` | privacy: strict CSP, no inline script, minimal localStorage | PASS /448 |
| `polling.spec.ts:27` | JSON fallback continues through long run and delayed pages without overlap or implicit cancel | PASS /15924 |
| `polling.spec.ts:104` | JSON fallback recovers from transient errors and successful pages reset the failure streak | PASS /15621 |
| `polling.spec.ts:163` | JSON fallback stops exactly after five consecutive failures with the fixed notice | PASS /11824 |
| `polling.spec.ts:204` | JSON fallback observes real cancel_requested as active and polls until cancelled | PASS /8604 |
| `sse_history.spec.ts:184` | native SSE reconnect resumes and answers once | PASS /3547 |
| `sse_history.spec.ts:247` | dropped SSE frame holds JSON catch-up while duplicate terminal callbacks arrive across reconnect | PASS /4770 |
| `sse_history.spec.ts:377` | actual preterminal duplicate SSE frames apply answer and history effect once | PASS /1779 |
| `sse_history.spec.ts:445` | corrupt stored cursor (ahead) recovers on the live run | PASS /223 |
| `sse_history.spec.ts:445` | corrupt stored cursor (malformed) recovers on the live run | PASS /496 |
| `sse_history.spec.ts:585` | seeded older history renders oldest-first without duplicates | PASS /181 |

Corrected archive **`local://terminal_duplicate_proof_2026-10-10_results.tar.gz`**, SHA-256 **`d241d4a024c858538a17f4d6b50f4066b90fa89938bc044f016f1e1bc9d13b2f`**, contains original corrected-run `browser.json`/console, all17 trace ZIPs, `.last-run.json`, initial and corrected static logs/`checks.json`, `case-summary.json`, `trace-summary.json`, genuine CDP and all seven decoded JSON attachments. No SQLite/profile or real-user data retained. JSON trace paths refer to original scratch root; archive paths correspond to `results/.../trace.zip`.

Key corrected traces:

- `results/sse_history-dropped-SSE-fr-3eaa9-cks-arrive-across-reconnect-chromium/trace.zip`
- `results/sse_history-actual-preterm-51cbb-wer-and-history-effect-once-chromium/trace.zip`

Archive was created using installed `tar -czf` with resolved session-local destination and explicit logs/reports/proof filenames plus `results`, cwd owned scratch; exit0. An earlier archive attempt failed because GNU tar interpreted `local://` as a remote host and two guessed attachment names were absent; no evidence was lost, corrected names came from actual report attachments. SHA-256 was computed on the retained successful archive. All17 ZIPs were decoded programmatically. After runner shutdown, `ss -ltnp 'sport = :4173 or sport = :4174 or sport = :4175'` exit0 showed no listeners. Only after retention, owned scratch was removed using `shutil.rmtree`; root absence observed true. No installs/lock/git/live/realDB changes, no unrelated cleanup.
