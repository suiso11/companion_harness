# Web 検索デザイン(Self-hosted SearXNG)

決定日: 2026-10-20 / 決定者: haruka / 状態: approved(docs-only・本 PR は実装を含まない)

## 1. 決定レコード

**Option B を採用** — Linux ホスト上に **self-hosted SearXNG** を Companio n の Web 検索バックエンドとして立て、クエリテキストを SearXNG 経由でアップストリーム検索エンジンへ送ることを許可する(haruka 2026-10-20 決定)。

- 却下された Option A(検索禁止)はアップデート性の高い質問に答えられないため不採用。
- 外部 SaaS API(paid search)は API key 管理と課題追跡が増えるため不採用。
- loopback 専用運用(127.0.0.1 バインド、tailnet 非公開)という条件で許可。

## 2. トポロジ(ops)

- `ops/llm/compose.yaml` に `searxng` サービスを追加(既存構成は gemma/litellm を ports バインドで公開する形が基本、`ops/llm/compose.yaml` 参照)。
- イメージ: `searxng/searxng`(digest pin 策は litellm と同様)。
- ポート: **`127.0.0.1:8888:8080`** — loopback バインドのみ。**tailnet / LAN へは露出しない**。
- 設定: `settings.yml` をボリュームマウントし、`search.formats: [html, json]` を許可(JSON API 用)。
- `limiter` は loopback 内部呼び出しのみのため **off**(bot 対策レート制限は不要・レイテリ安定優先)。
- engine 選択: duckduckgo / brave / startpage 等のデフォルトその他に任せる。API key 不要の engine を有効化。
- healthcheck: `curl -f http://localhost:8080/healthz`(SearXNG のコンテナ health probe は `/healthz`。`/health` ではなく `/healthz` を使う点に注意 — `/health` は成功しないため Compose が unhealthy 判定する)。

## 3. Companion ツール `web.search`

既存ツール契約の直交性を保つ(kernel ToolBroker 経由の通常ツールとして登録。`packages/kernel/src/agent.ts:22` の free-text 経路を使わない)。

```text
web.search(input):
  query:        string, 1..200 chars
  language:     string(<=16), optional  (例: "ja")
  time_range:   "day" | "week" | "month" | "year", optional
  top_k:        int 1..8, default 5 (output 上限)
→ output:
  results: [{ referenceId: string, title: string|null, url: string, snippet: string|null }, ...] (<= top_k)
  // referenceId: ReferenceManager が mint した presentation identity(rN)。
  // calendar hit (`CalendarSearchHitSchema`) と同型に model へ直接渡し、
  // answer での rN citation 必須化を model が満たせるようにする。
```

- クエリ長上限 **200 chars**(calendar.search が 256 なのに対し自由テキスト検索は短めに抑制: `packages/contracts/src/calendar.ts:29`)。
- 結果 URL は **scheme allowlist `http/https`** のみ(それ以外の scheme は破棄)。
- URL/slug 長上限: url ≤ 2048 chars, title ≤ 256 chars, snippet ≤ 512 chars(bytes 校査は kernel 契約と整合的に §14.6 方針で別途確定)。
- **phase 1 では `web.open`(ページ取得)を提供しない**(phase 2 で別途決定)。model は snippet のみを根拠にする。
- Router descriptor の `category` は **`read`** とする(`unclassified` descriptor は `buildAgentToolDefinitions`(`packages/kernel/src/agent.ts:1348-1360`)が広告せず broker も non-read 登録を拒否する(`packages/kernel/src/broker.ts:871-881`)ため、`unclassified` のままだと露出 gate を通らない。web.search は外部読み取り専用で副作用を持たないため `read` 分類が妥当)、`defaultTimeoutMs` **10s**・`maxTimeoutMs` 60s で登録 descriptor shape は `packages/contracts/src/tools.ts:31` の `ToolDescriptorSchema` に従う。

## 4. Untrusted evidence の枠組み

- 検索結果は **untrusted data** として扱う(tool result は決して instruction と解釈させない方針は `packages/kernel/src/agent.ts:97` に既存)。
- カレンダーもメモリ re-cast も model-facing では「untrusted で provenance 明示」(`packages/kernel/src/agent.ts:264`, `agent.ts:614`, `agent.ts:636` の既存方針踏襲)。`web.search` 結果も同様に system prompt で untrusted かつ provenance 付きで提示する。

## 5. 参照の永続化: ReferenceManager 新 connector kind `web` → rN(推奨)

- 検索ヒットを ReferenceManager に **connector kind `web`** として Snapshot 化し、既存の rN 命番号を redeem する形を推奨。既存の snapshot/rN メカニズムは `packages/contracts/src/references.ts:36`(同一 revision/content は同一 rN、変化時は新 Snapshot+rN)、`packages/contracts/src/references.ts:94`(snapshot body の `body_json` 形式)に準拠。
- **各 hit を 1 つの rdf:text として Model に rN 参照で渡し、answer で rN citation を必須化**(§14 citation 規約、`agent.ts:2050` の title/provenance 規範も参照)。
- **URL の不変 metadata 化**: snapshot body(`packages/contracts/src/references.ts:94` の `body_json`)に `url`(scheme allowlist 済、≤2048 chars)を不変 field として埋め込む。canonical key は URL そのものにしない(512 char cap・`https://` の空 path segment 拒否制約、`packages/contracts/src/references.ts:59-76` と衝突するため)。実装 PR では `ReferenceDetailResponseSchema`(`packages/contracts/src/references.ts:339-344`)を web snapshot 向けに拡張し、detail API 経由で検証済み `url` を UI へ返す。これにより rN citation のみが answer に残っても UI が開くべき構造化 URL を取得できる。
- **wN(別種の connector / table)を新設しない理由**: 参照の本体は URL+スニペットの evidenceであり、ReferenceManager の「同一参照・同一 revision に対する snapshot の合一」を活かせる。メモリ mN(`agent.ts:449`)や calendar hit(`packages/contracts/src/calendar.ts:63` の `CalendarSearchHitSchema`)と同型の snapshot モデルで自然に合流するため。

## 6. 検索予算

- Default **3 件/turn(案)**: バジェット消費は `packages/contracts/src/tools.ts:44` の `TOOL_BUDGET_DEFAULTS`(`maxToolRequestsPerRun: 8` 等)を起点に、 既存 ToolBroker の budget-first pipeline(`packages/kernel/src/broker.ts:11`, `broker.ts:81`)で消費を記録する。既存の `runs.tool_requests_used`(`packages/kernel/src/broker.ts:1123-1129`)は **per-run** であり、同 turn の retry は新 run を切るため counter が reset される(`packages/kernel/src/repository.ts:1519-1536`)。そこで web.search の 3 件上限は **turn 単位で永続化**(web.search 実行回数を turn に紐付けて記録し、同一 turn の retry run でも合算課金)し、per-run の `tool_requests_used` とは別に管理する。上限は turn 単位として unit test で検証する。
- 上限内で同質 tool が複数走る既存制約(maxConcurrentPerRun: 3)を踏襲し、web.search は同時併走 1 に制限(シンプル化)。
- 続けて呼び出し上限に達した場合は既存の `budget_exceeded`(`packages/contracts/src/tools.ts:94`)を返す。

## 7. タイムアウト・ネットワーク上限

- SearXNG 呼び出しタイムアウト **10s**(案)・descriptor default 10s/最大 60s。
- SearXNG 応答 byte cap: connector-web の HTTP クライアントは **JSON parse 前に生レスポンス body を streaming で読み取り、connector level の byte cap(案: 1MiB)を超過した時点で即座に切断**する(`maxNormalizedOutputBytesPerCall` は execute/normalize 後に適用されるため生 body の buffering を止められない)。kernel `maxNormalizedOutputBytesPerCall` (256KiB, `packages/contracts/src/tools.ts:52`) は normalized 出力に、web search 特化の model-facing cap(案: 64KiB)は model-facing 出力に、それぞれ別段に維持する。
- アップストリーム engine は SearXNG コンテナ外へは *任意に* port するが、SearXNG→Companion 間は loopback のみで双方向に非公開経路。

## 8. プライバシー・ガード

1. **system prompt 規則**: model は検索クエリに citation id(`r\d+` / `m\d+`)や memory snippet テキストを含めてはならない(基礎: `agent.ts:97` の untrusted framing・637 行の untrusted recap)。kernel は **web.search を受理した時点で、model-derived テキストに `r\d+` / `m\d+` が含まれる場合は拒否**(`query_contains_citation` / `query_contains_memory_snippet`、二重防衛。ユーザー明示 free text は §8.3 の適用除外対象)。
2. memory snippet テキストは連続 20 文字以上の一致で拒否(kmp で再構成し、数値 id とも照合)。
3. ガードの適用対象は **model が生成・派生させたテキストに限定**する。現在のリクエストでユーザーが明示的に入力した free text は適用除外とする(`MacBook m1` / `AWS r5` / `R2-D2` 等の正当な語句を含む通常検索をブロックしないため)。memory snippet 連続一致拒否(§8.2)も同様に、現在のユーザー入力由来のテキストには適用しない。leakage 防止の趣旨は model-derived 追加テキストの遮断にあり、ユーザー入力を無差別に落とすことではない(ユーザーが remembered phrase を明示して検索を依頼するケースを回収不能にしない)。

## 9. 設定

- 環境変数 **`COMPANION_WEB_SEARCH_JSON`**(default **off**)で opt-in。既存 `COMPANION_CALENDAR_JSON` と同型の provider selection + connector hint(`apps/server/e2e/calendar/server.ts:157` をパターンとして参照)。
- 中身(草案)： `{searxng_base_url: "http://127.0.0.1:8888", max_results: 8, timeout_ms: 10000}`
- **`searxng_base_url` は fail-closed に検証**する: `packages/model-local/src/base_url.ts:41-88` の loopback 正規化と同様に、scheme が `http`/`https` かつ host が loopback(127.0.0.0/8・`::1`・`localhost`)以外、または credential/query/fragment を含む設定は起動時に拒否する。さらに connector は **各 fetch 前に実接続先 URL を再検証**し、DNS 解決結果が loopback 以外に変わった場合もリクエストを送らない(設定ミス・typo による外部送信を阻止する privacy boundary の実装条件)。
- `COMPANION_WEB_SEARCH_JSON` が無い場合、`web.search` descriptor は registry から露出されない(MCP `enabledBindings` の「無効なら露出しない」方針と同調、`packages/connector-mcp/src/client.ts:859`)。

## 10. UI

- calendar の result citation と同一の UX(`docs/plan/frontend_ui_requirements.md` Q11 規約)で **rN citation** を chat に表示。
- web.search 中の run status・progressive 表示は既存 run status / provisional draft のプラクティスを踏襲。
- url をクリックしたらブラウザ外部で開く(app 内では fetch しない、phase 1)。

## 11. 実装 PR 分割

1. **[ops] SearXNG 追加**: `ops/llm/compose.yaml` + `ops/llm/searxng/settings.yml`。実装 PR では **`ops/llm/apply.sh` 自体を拡張**し、`compose.yaml` / `litellm_config.yaml` と同様に `ops/llm/searxng/settings.yml` を検証の上 `/srv/llm/searxng/settings.yml` へ原子的にコピー・反映する(apply.sh 現行の対象は `compose.yaml` と `litellm_config.yaml` のみ、`ops/llm/apply.sh:48-55,68,105`。settings.yml の deploy を追加しないと新規ホストで SearXNG が起動しない)。
2. **[connector+tool] `web.search`**: `packages/connector-web`(季刊型: SearXNG HTTP クライアント)、`packages/contracts/src/web.ts`、kernel descriptor/toolbroker 連携、kernel 富 guard、e2e server stub。
3. **[UI] citation 表示**: frontend への rN citation(web) 描画・click 外部起動。

## 12. テスト計画

- contracts: schema 境界(query 200/limit/URL scheme/拒否 ID) を unit test。
- kernel: budget 消費(turn 単位で永続化された web.search 3 件上限・retry 時の合算課金を含む)/timeout/byte cap/rN mint を unit test(memory snippet / citation id 拒否も含む。ユーザー明示 free text の適用除外テストも追加)。
- connector-web: SearXNG JSON レスポンスの正常系・empty・限界・network error e2e stub(本物の SearXNG へ接続しない)。加えて streaming byte cap 超過(巨大応答の切断)・loopback 以外 base_url の fail-closed 拒否を unit test。
- ops: `ops/llm/apply.sh`取得→ `docker compose up -d searxng` → `/healthz` + `/search?...&format=json` 手動スモーク。

## 13. 受け入れ基準

- `ops/llm/apply.sh` で searxng が **127.0.0.1:8888 限定**で起動し外部 port が無い(→ `docker port searxng` 等で確認)。
- `COMPANION_WEB_SEARCH_JSON` 不在時、`web.search` descriptor が露出しない。
- 存在時、検索→rN mint→回答内 rN citation→UI 表示の E2E が通る。
- model-derived テキストに citation id / memory snippet を含むクエリが拒否される(ユーザー明示 free text に含まれる場合は拒否されない)。

## 14. オープン項目

- final `top_k`、snippet 長、query 上限は実装 PR で実数確定。
- ReferenceManager への `web` chip が memory/calendar snapshot 合流時にどう測るか(badge に provenance kind 表示推奨)。
- phase 2 `web.open`(ページ取得・markdown snapshot 化)は別の決定(haruka)を待つ。
- SearXNG が利用できない状況(model fallback / engine rate-limit)の扱い。
