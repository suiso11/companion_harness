# Companion Harness

**Companion Harness** は、ローカル LLM を単なるチャットモデルではなく、**会話・ツール利用・外部資料の参照・引用・実行状態を安全に管理するためのローカル AI ハーネス**です。

目標は、LLM 自体にシステム全体の責任や権限を持たせることではありません。

> **モデルは交換可能でよい。
> 何を実行し、何を見て、何を信頼し、何を記録したかは Harness 側が所有する。**

Conversation First を基本とし、ユーザーからは普通の会話として見える一方、その裏側では生成・ツール実行・参照・引用を durable な状態として管理します。

---

## 何を作ろうとしているのか

一般的なローカル LLM アプリは、概ね次のような構造になります。

```text
User
  │
  ▼
Web UI
  │
  ▼
LLM API
  │
  ▼
Answer
```

Companion Harness は、その間に **信頼できる実行基盤** を置きます。

```text
                         User
                          │
                          ▼
                ┌─────────────────┐
                │ Conversation UI │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │   Hono Server   │
                │ composition root│
                └────────┬────────┘
                         │
                         ▼
               ┌───────────────────┐
               │     RunEngine     │
               │ durable scheduler │
               │ lifecycle owner   │
               └─────────┬─────────┘
                         │ RunStrategy
                         ▼
               ┌───────────────────┐
               │       Agent       │
               │ model / tool loop │
               └──────┬─────┬──────┘
                      │     │
              ┌───────┘     └─────────┐
              ▼                       ▼
     ┌────────────────┐       ┌────────────────┐
     │   ToolBroker   │       │  ModelGateway  │
     │ policy / audit │       │ provider-neutral│
     └───────┬────────┘       └───────┬────────┘
             │                        │
     ┌───────┼─────────┐        ┌─────┴─────────┐
     ▼       ▼         ▼        ▼               ▼
 Markdown   MCP     Calendar   Ollama     OpenAI-compatible
     │
     ▼
ReferenceManager
     │
     ▼
CanonicalResource
     │
ResourceSnapshot
     │
SessionReference (r1, r2, ...)
             │
             ▼
        ┌──────────┐
        │  SQLite  │
        │   WAL    │
        └──────────┘
```

中心にいるのは Agent ではなく **RunEngine** です。

Agent は「Run をどう処理するか」を表す交換可能な `RunStrategy` の一つであり、実行状態そのものは所有しません。

---

## 基本設計

Companion Harness では、役割を明確に分離します。

```text
Conversation / UI      ユーザーとの対話
Server                 HTTP・依存関係の組み立て
RunEngine              実行ライフサイクル
Agent                  LLMを使った実行戦略
ToolBroker             ツールの権限・予算・監査
ReferenceManager       外部資料と引用の同一性
ModelGateway           LLM provider abstraction
Connector              外部世界との接続
SQLite                 永続状態
```

LLM が直接ファイル・ネットワーク・カレンダー等へアクセスする経路は作らず、モデル起因の能力呼び出しは ToolBroker を通します。

---

# RunEngine

`RunEngine` は Companion Harness の実行基盤です。

一回の生成を **Run** として扱います。

```text
queued
  │
  ▼
running
  │
  ├──────────────► completed
  │
  ├──────────────► failed
  │
  └─ cancel ─► cancel_requested ─► cancelled

abrupt shutdown
running ───────────────► abandoned
```

状態はメモリ上だけではなく SQLite に保存されます。

そのためプロセスが落ちても、

```text
queued             → 再び実行可能
running            → abandoned
cancel_requested   → cancelled
```

として復旧できます。

同一 Session では active Run を一つに制限しつつ、異なる Session の Run は並行実行できます。

状態変更には CAS（Compare-And-Swap）を使い、遅れて返ってきた結果が terminal 状態を上書きすることを防ぎます。

---

# Session / Turn / Run

会話は次の3階層で管理します。

```text
Session
│
├─ Turn 1
│    ├─ Run 1
│    └─ Run 2  ← retry
│
├─ Turn 2
│    └─ Run 1
│
└─ Turn 3
```

## Session

一つの会話。

## Turn

ユーザーから与えられた一つの入力です。

Turn は immutable です。

```text
Turn
├─ input
├─ temporal context
├─ UI context
└─ frozen context
```

Retry しても Turn 自体は変更されません。

## Run

Turn に対する **一回の生成試行** です。

```text
Turn
├─ Run 1  failed
├─ Run 2  cancelled
└─ Run 3  completed
```

Retry は「メッセージを作り直す」のではなく、同じ Turn に新しい Run を追加します。

採用された completed Run だけが、その Turn の公式な応答として履歴へ投影されます。

---

# Agent

Agent は LLM と ToolBroker を使って Run を実行します。

```text
User request
     │
     ▼
    LLM
     │
     ▼
Need a tool?
  │        │
 Yes       No
  │        │
  ▼        ▼
ToolBroker answer.submit
  │
  ▼
Tool result
  │
  └──────────► LLM
```

Agent loop には明確な budget があります。

```text
Model steps / Run      max 8
Model step timeout     120 sec
Run wall time          300 sec
Tool concurrency       max 3
Repair                 max 1
```

自由なテキスト出力をそのまま最終回答とは扱いません。

最終回答は専用 protocol、

```text
answer.submit
```

として提出する必要があります。

```text
LLM
 │
 ▼
answer.submit
 │
 ▼
Schema validation
 │
 ▼
Citation validation
 │
 ▼
RunResult candidate
 │
 ▼
RunEngine
 │
 ▼
completed
```

最終的に Run を completed にする権限は Agent ではなく RunEngine が持ちます。

---

# ToolBroker

ToolBroker は、**LLM と外部能力の境界**です。

```text
Agent
  │
  ▼
ToolBroker
  │
  ├─ Markdown
  ├─ MCP
  ├─ Calendar
  └─ future tools
```

モデルが直接 Tool を実行することはありません。

ToolBroker の処理順は固定されています。

```text
budget reservation
        │
        ▼
classification
        │
        ▼
validation
        │
        ▼
dedup
        │
        ▼
execution
        │
        ▼
normalization
        │
        ▼
audit
```

v0.1 の基本ポリシーは read-only / default-deny です。

```text
read          allow
write         deny
sensitive     deny
unknown       deny
```

代表的な budget:

| Resource                   |   Limit |
| -------------------------- | ------: |
| Tool requests / Run        |       8 |
| Concurrent tools / Run     |       3 |
| Concurrent tools / process |       8 |
| Input / call               |  32 KiB |
| Normalized output / call   | 256 KiB |
| Model-facing output / call |  64 KiB |
| Model-facing output / Run  | 128 KiB |
| Default timeout            |  15 sec |
| Maximum timeout            |  60 sec |

Tool の raw arguments / raw output / raw error をそのまま監査ログへ保存する設計にはしていません。

---

# Reference Model

外部資料は単なる文字列として扱いません。

Companion Harness では、

```text
CanonicalResource
       │
       ▼
ResourceSnapshot
       │
       ▼
SessionReference
```

という3つの identity を分離します。

## CanonicalResource

「外部世界に存在する同じ対象」。

例:

```text
notes/project.md
Google Calendar event X
```

## ResourceSnapshot

その Resource を **ある時点で取得した不変の証拠**。

```text
CanonicalResource
      │
      ├─ Snapshot revision 1
      │
      └─ Snapshot revision 2
```

Snapshot は作成後に書き換えません。

外部データが変化した場合は、新しい Snapshot を追加します。

## SessionReference

Session 内でユーザーやモデルが扱う参照番号です。

```text
r1
r2
r3
...
```

例えば、

```text
project.md
   │
   ├─ Snapshot 1 ── r1
   │
   └─ Snapshot 2 ── r7
```

となります。

そのため、後から元ファイルが変更されても **過去に r1 として参照した証拠は変化しません**。

---

# Evidence Grant

モデルが Citation を生成できるからといって、その Citation をそのまま信用しません。

Run ごとに、

```text
EvidenceGrant
```

を管理します。

```text
Run X
├─ r1 snippet を閲覧
├─ r3 full を閲覧
└─ r7 は未閲覧
```

最終回答で、

```text
これは〜です [r3]
```

と引用した場合、

```text
r3 exists?
     │
     ▼
Granted to this Run?
     │
     ▼
Actually exposed to model?
```

を確認します。

存在するだけの Reference を勝手に引用することはできません。

Citation verifier が保証するのは意味的な真偽ではなく、

> **この Run が本当にその Evidence を受け取ったか**

です。

---

# Markdown Connector

現在 server に接続されている Reference source がローカル Markdown です。

```text
packages/connector-markdown
```

利用可能な Agent tool:

```text
markdown.search
reference.open
reference.refresh
reference.related
```

Markdown connector は read-only です。

検索も意図的に単純です。

```text
Vector DB            ×
Embedding            ×
Semantic search      ×
FTS                  ×

Literal substring    ✓
```

NFC normalization と deterministic な case folding を使って検索します。

Markdown link も解析します。

```markdown
[Document](./document.md)

[[Document]]
```

リンク先を一意に決められない場合、推測して選択せず、

```text
ambiguous
```

として扱います。

つまり Markdown connector は一般的な「ベクトルRAG」というより、

> **ローカル文書を provenance 付きの evidence graph として扱う**

ための仕組みに近いです。

---

# Model Gateway

LLM provider は Agent から分離されています。

```text
packages/model-local
```

現在対応している adapter:

```text
ModelGateway
   │
   ├─ Ollama
   │    └─ /api/chat
   │
   └─ OpenAI-compatible
        └─ /v1/chat/completions
```

OpenAI-compatible endpoint として公開できるサーバーであれば、特定ベンダーへ Agent を依存させず接続できます。

Tool call は native tool calling のみを使います。

モデルが本文として、

```json
{
  "tool": "markdown.search"
}
```

のような文字列を生成しても Tool call として解釈しません。

また Model Gateway は local-first であり、接続先は loopback に限定されています。

```text
127.0.0.1
localhost
::1
```

redirect も拒否します。

---

# Server

```text
apps/server
```

はシステム全体の **composition root** です。

Kernel は HTTP を知りません。

Server が各 component を組み立てます。

```text
Config
  │
  ▼
SQLite
  │
  ▼
Migration / quick_check
  │
  ▼
ReferenceManager
  │
  ▼
Connectors
  │
  ▼
ToolBroker
  │
  ▼
ModelGateway
  │
  ▼
Agent Strategy
  │
  ▼
RunEngine
  │
  ▼
Hono
  │
  ▼
HTTP listener
```

DB recovery が終わる前に新しい Run を受け付けないよう、startup order も固定しています。

---

# Conversation UI

M3 では最低限のブラウザ Conversation UI を提供します。

UI stack は意図的に小さくしています。

```text
Hono JSX SSR
     +
Vanilla TypeScript
     +
esbuild
```

React / Next.js 等の UI framework は使用していません。

また、

```text
inline script      ×
inline style       ×
external CDN       ×
external origin    ×
```

として strict CSP を設定しています。

通常ユーザーに見せる状態も内部の Run status をそのまま表示しません。

```text
queued / running      → 生成中
completed             → 回答
failed / abandoned    → 生成に失敗しました
cancelled             → 停止しました
```

Turn / Run / Tool は内部概念です。

---

# Event Stream

Run の状態変化は durable RunEvent として保存されます。

例:

```text
run.queued
run.started

model.step.started

tool.requested
tool.completed

reference.presented

model.step.completed

run.completed
```

イベントは SQLite に保存され、SSE でブラウザへ配信します。

```text
SQLite
  │
  ▼
SSE
  │
  ▼
Browser
```

主な仕様:

```text
SQLite poll             250 ms
Heartbeat               15 sec
Slow-client grace        5 sec
Cursor                   per-Run sequence
```

ブラウザとの SSE 接続が切れても Run 自体は停止しません。

Run の authoritative state はブラウザではなく SQLite に存在します。

接続復旧時に event cursor の gap が存在した場合は、保存済み RunEvent から catch-up できます。

---

# SQLite

SQLite は単なるチャット履歴ではなく、Harness 全体の durable state を所有します。

概略:

```text
sessions
│
├─ turns
│   └─ runs
│       ├─ run_events
│       ├─ tool_calls
│       ├─ model_calls
│       └─ evidence_grants
│
├─ turn_selections
│
├─ session_references
│
├─ reference_sets
├─ reference_set_items
├─ session_reference_context
│
└─ api_idempotency

connector_instances
│
└─ resources
    │
    └─ resource_snapshots
         │
         └─ snapshot_links
```

DB は SQLite WAL mode で動作します。

Model call について保存するのは主に、

```text
adapter
model
outcome
duration
token usage
```

などの metadata です。

以下は保存しません。

```text
API key
prompt
raw model response
reasoning
raw tool output
```

---

# Idempotency

HTTP mutation には Idempotency-Key を使用します。

例えば同じ Message request がネットワーク都合で二重送信されても、

```text
same key
+
same request
     │
     ▼
stored response replay
```

になります。

一方、

```text
same key
+
different request
     │
     ▼
409 Conflict
```

となります。

二重送信によって Turn / Run が重複生成されることを防ぎます。

---

# MCP

```text
packages/connector-mcp
```

では MCP server を Companion Harness から安全に利用するための基盤を実装しています。

MCP server が返す `tools/list` をそのまま LLM に公開する設計ではありません。

能力をモデルへ公開するには、呼び出し元の **レビュー済み host code** が
信頼済みの `McpBindingDefinition[]`（`readonly upstreamTool` /
`canonicalSchemaHash` / `category`）を constructor の **必須 2 番目の引数**
として渡す必要があります。これは production enable / registration ではなく、
host code と同じ信頼レベルで供給される **sidecar provenance** です。
definitions の default は存在せず、config JSON・`tools/list`・tool 名・
`readOnlyHint`、caller 引数の `category` / `readOnlyHint` のいずれも read
権限を付与できません。JSON の `category` やメタデータ単体は authority では
ありません。よって host code を持たない caller にとっては **breaking な
internal API 変更** です（C09 は server 有効化前であり、library は
production registration されていません）。

```text
host-reviewed McpBindingDefinition[]        (trusted class + hash)
      │
      ▼
category == read  AND  definition hash == config hash?
      │
   ┌──┴──┐
  YES    NO ──▶ deny (fixed code, no I/O)
   │
   ▼
first allowed call → wire identity gate
      │
      ▼
live tools/list canonical input-schema hash matches?
      │
   ┌──┴──┐
  YES    NO
   │      │
 enable disable
```

接続時の identity 検証は 2 段階です。まず trusted config の
`expectedServerName` / `version` を、実際の `initialize.serverInfo` の
name / version と完全一致で照合します（wire identity gate）。一致した後に
初めて `tools/list` の tool name + input schema hash を検証します。
`serverId` は論理 ID であり wire 名とは比較しません。不一致は固定
`mcp_schema_mismatch` で全 binding を fail closed とし、検証済み binding
のみを有効にします（fallback なし）。`read` 以外（write / sensitive /
unclassified）や重複・曖昧な definition は handler 実行前にローカルで
`mcp_binding_not_allowed` として拒否され、host code の category を caller
引数が上書きすることはできません。`tools/list` で発見した tool を自動で
モデルへ公開することもありません。C09 は server 有効化前であり、
readonly binding registration / upstream fork pin / OAuth は未追加です。

Transport:

```text
stdio

or

loopback Streamable HTTP
```

主な方針:

```text
explicit allowlist
schema identity verification
lazy connection
bounded reconnect backoff
per-instance concurrency control
loopback HTTP only
redirect rejection
stdio env allowlist
stdio stderr count-only cap
bounded shutdown / force-close wait
```

Transport のライフサイクル境界（C09-05 / C09-06）:

- stdio の stderr は接続ごとに **カウントのみ** を保持し 64KiB で飽和します。
  65537 バイト目で open / call / idle を中断し、固定 `mcp_unavailable`、同期
  state clear（connected / enabledBindings）、bounded cleanup に収束します。
- stdio の `shutdownWaitMs` は既存の `100..10000`（既定 `3000`）で、これは
  **GRACE** です。実際の child close event 待ちに加えて、固定の **追加
  2000ms** の force close 待ちがあります。SIGKILL の対象は `close()` が
  getter を消す前に捕捉した **実所有の正の public SDK PID** のみです。終了の
  証明は実際の close event であり、`close()` Promise の解決ではありません。
- generic / HTTP transport の待機は **HOST bounded** であり、外部プロセスの
  死亡を証明しません。数値 PID は public API ですが、永続的な OS identity や
  プロセスツリーを保証しません。
- 1 つの owned connection（half-open を含む）を singleflight で共有し、各操作は
  fresh controller を持ちます。明示 shutdown は epoch で fence し、pre-shutdown
  に queue 済みの呼び出しと shutdown 中の呼び出しは固定 fail、完了後の **新規**
  明示呼び出しのみ lazy 再接続できます。通常の failure 後の **別** の呼び出しは
  queue されても回復し、replay せず backoff も不変です。
- 各 connect attempt は epoch ごとの **fresh AbortController** を共有し、明示
  shutdown はそれを同期 abort します。fence された demand は
  pre-construction backoff を sleep out せず即時固定 `mcp_unavailable` に戻り、
  stale timer と abort listener は除去されて mutex も解放されます。failure 後の
  fresh な demand は自分自身の **full** backoff を新規に所有し、古い残り時間を
  継承しません（backoff の中断と再有効化の区別）。
- shutdown は **開始済み** の bounded cleanup をすべて join しますが、その
  bounded deadline は reset も restart もせず、元の boundary で収束します。
  overflow 由来の detached cleanup も同じ join 対象です。join は host 側の
  待機を bounded にするだけで、generic 経路では OS 死亡を証明しません
  （retired cleanup join と backoff interruption の区別）。
- HTTP は `127.0.0.1` / `localhost` のみ。**すべての 3xx** を manual で拒否し、
  拒否した response body は読み取らず安全に cancel します。

この REQUIRED な `McpBindingDefinition[]`（2 番目）と optional な factory（3 番目）
の constructor は merged PR17（`71961c9`）の API です。PR15/PR16 archive の
`new McpConnector(cfg)` / `new McpConnector(cfg, factory)` は **HISTORICAL API**
であり、互換 shim はありません。merged PR17 上で PR16 helper を新 constructor
へ適応して再実行した runtime 検証（P2 cancellable backoff / P1 default stdio
detached cleanup / late-handoff generation / observed pre-handoff）はすべて
AFTER VERIFIED（exit 0）で、local の full battery は `pnpm test` **94 files /
1143 tests passed**、`typecheck` / `typecheck:e2e` / `lint` すべて exit 0 です
（local owned-branch observation であり、future CI / head-SHA の主張ではありません）。

深い検証記録（コマンド・件数・生データ）は
[docs/operations.md](docs/operations.md) を参照してください。

---

# Calendar

```text
packages/connector-calendar
```

では Calendar を Reference source として扱うための foundation を実装しています。

想定する流れは、

```text
Google Calendar
      │
      ▼
     MCP
      │
      ▼
Calendar Connector
      │
      ▼
Normalized Event
      │
      ▼
ReferenceManager
      │
      ▼
ResourceSnapshot
```

です。

Calendar Event は必要な情報だけへ正規化します。

```text
title
description
location
start
end
status
source revision
```

一方、

```text
creator
attendees
organizer
conference data
meeting URL
HTML link
extended properties
raw payload / account id
```

等は Snapshot から除外する設計です（allowlist 外の未知フィールドもすべて除外）。

Response は `structuredContent` を own-property で優先し、それが **存在しない**
ときだけ text 全体を strict JSON として解釈します（prose / fence / 部分走査は
しません）。実際の candidate は入れ子の `start`/`end`
(`{dateTime?,date?,timeZone?}`) を返すため、consumer はその nested shape を検証し、
all-day DATE は end-exclusive のまま、explicit-offset の timed 値は UTC ISO に
正規化します。page は 1 ページのみ・opaque cursor をそのまま返し、auto-pagination
は行いません。

Model-facing tool は最小限にし、

```text
calendar.search
```

だけを公開する方向で設計しています。

現時点では Calendar MCP の upstream binding は正式採用前（**HOLD / NOT
ADOPTED**）であり、M4 は foundation / design 段階です。C09 の wire identity guard と
C10 consumer の normalization は実装済みですが、**C10-08 production mapping gate**
（採用済み binding / pin / profile / OAuth / live Google 接続なし）は未解決であり、
candidate の whole-second datetime regex と合意済み fractional ISO 入力の差も
明示的な compatibility gap です。consumer が動くことは profile 接続・採用を
意味しません。

C11 の deletion boundary は consumer 側で明示的に固定しています（genuine な
low-level SDK `Server` + `InMemoryTransport` fixture で `McpConnector` 経由の実際の
wire を通した回帰テスト）。cancelled は status のまま（tombstone にしない）、
`isError` は `calendar_upstream_error`、throw された RPC error は別経路の
`mcp_unavailable`、1 ページの search omission は opaque cursor を返すだけで削除に
しない、raw の `deleted` status は `calendar_response_invalid` で拒否、未知の
`deleted` / `tombstone` hint flag は strip、のいずれも tombstone を生成しません。
未検証の `classifyDeletion` / `DeletionVerdict` stub（proposed label のみ、producer
なし）は削除し、always-unknown の代替 API は追加していません。positive な
authoritative get-tombstone contract は未証明のため **C11-01 は BLOCKED**、実際の
HTTP status は consumer から観測不能で **UNKNOWN**、正式 C08 adoption / C10-08
production mapping gate は依然 HOLD / UNRESOLVED です。詳しい gate table は
docs/m4_dependency_spike.md と docs/operations.md を参照してください。

C10 の最終検証（cleanup + full source patch 後に各チェックを 1 回だけ実行）の**初回**実測は
root typecheck と root lint が FAIL でした（e2e typecheck は PASS exit 0、full vitest は
PASS exit 0、94 test files / 1164 tests、failed / skipped 0）。失敗内訳: root typecheck
（`tsc --noEmit -p tsconfig.json`）FAIL（exit 2、`src/time.ts` 96–98 行の
`'zone' is possibly 'undefined'` ×3）; root lint（`biome check .`）FAIL（191 files、
error 1 = `assist/source/organizeImports`（`src/index.ts:1`）、warning 1 =
`lint/suspicious/noPrototypeBuiltins`（`normalize.ts:344`）、info 2 =
`lint/complexity/noUselessUndefinedInitialization`（`normalize.ts:402`）と既存
`biome.json` の deprecated `recommended` 設定注記）。

その後 bounded な type/lint fix（`time.ts` の mandatory zone capture に対する type-only
assertion で TS18048 を解消、`normalize.ts:344` を own-property presence のまま
`Object.hasOwn` に、`normalize.ts:402` の不要な `= undefined` 初期化を削除、`index.ts` を
organizeImports 順に並べ替え）を適用し、同一の 2 チェックを 1 回ずつ再実行したところ root
typecheck は PASS（exit 0、出力なし）、root lint も PASS（exit 0、191 files、error 0 /
warning 0 / info 1 = 既存 `biome.json` deprecated `recommended` のみ）になりました。失敗
2 件は解消済みです。e2e typecheck（exit 0）と full vitest（94 files / 1164 tests）は
再実行しておらず、変更前の green をそのまま保持しています（新しい full-test run は主張
しません）。

presence 分岐の実測: own `structuredContent` 優先（null / undefined でも text で救済
しない）、ABSENT のときのみ strict text JSON、inherited / shadow `hasOwnProperty` は
無関係、を retained C08 body に対する throwaway smoke（11/11 pass、Node 24.12.0 /
esbuild 0.25.12、worktree の `.review-proof` は削除済み、結果は out-of-repo
`c10-calendar-verify/failed-check-fix/`）で確認しました。

time.ts の native-review fix の before/after 実測
（Node 24.12.0、esbuild 0.25.12）は out-of-repo
`c10-calendar-verify/time-review/`（14 files、byte-hash verified、worktree の
`.review-proof` は削除済み）に保存済みです。`0000-02-29` の `0000-03-01` rollover と
long-fraction の次秒繰り上がりが BEFORE で再現し AFTER で解消、normal path は
byte-identical です。

C11 の検証（source patch complete 後に format を 1 回、続いて各チェックを 1 回）
の実測: disposable な real-SDK runtime smoke（`.review-proof/c11-runtime.ts`、
archive 後に削除、Node 24.12.0 / SDK 1.30.0 / esbuild 0.25.12）で genuine な
low-level SDK `Server` + `InMemoryTransport` 経由の 6 negative invariant を実
public API で確認し、6 distinct cases / 27 checks すべて pass。tombstone は一切
生成されず、private 404/410 sentinel は出力に現れず、request count は case1
get=2、case2/3/5/6 get=1、case4 get=1+search=1（implicit next page なし）。新規
`test/deletion-boundary.test.ts` は full suite で 6/6 pass（95 files / 1168 tests、
failed/skipped 0）。root typecheck は exit 0、e2e typecheck は exit 0。初回の
`biome check .` は exit 1 で 1 error（`assist/source/organizeImports` =
deletion-boundary.test.ts の import 名順、FIXABLE）+ 既存 `biome.json` の
`recommended` info 1 件でした。その後、表示された safe fix どおりに named import を
手動で並べ替え、root の
`node node_modules/@biomejs/biome/bin/biome check .` を 1 回だけ再実行して
**exit 0**（192 files、0 errors / 0 warnings、既存 `biome.json` の `recommended`
info 1 のみ）を実測しました。new error / warning は 0 件です（import 名順の
behaviour-neutral な並べ替えのみで runtime semantics は不変）。実際の upstream HTTP status は依然 UNKNOWN（synthetic な 404/410
marker は provider HTTP evidence ではない）。C11-01 は BLOCKED、C11-05 の snapshot
retention は C12 未配線、formal C08 HOLD / C10-08 production mapping は UNRESOLVED
のままです。test-only の `packages/connector-calendar/node_modules/@modelcontextprotocol/sdk`
symlink（raw target
`../../../../node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.5.4/node_modules/@modelcontextprotocol/sdk`、
connector-mcp と同一形式、read-only borrow）を SDK 解決のために追加し、install /
relink は実行していません。

---

# Repository Structure

```text
companion_harness/
│
├─ apps/
│  └─ server/
│     ├─ src/
│     │  ├─ app.ts
│     │  ├─ bootstrap.ts
│     │  ├─ config.ts
│     │  ├─ logger.ts
│     │  ├─ maintenance.ts
│     │  ├─ sse.ts
│     │  │
│     │  └─ ui/
│     │     ├─ client.ts
│     │     ├─ page.ts
│     │     └─ reducer.ts
│     │
│     ├─ e2e/
│     └─ test/
│
├─ packages/
│  │
│  ├─ contracts/
│  │  └─ shared schemas / types / protocol contracts
│  │
│  ├─ kernel/
│  │  ├─ engine.ts
│  │  ├─ strategy.ts
│  │  ├─ agent.ts
│  │  ├─ broker.ts
│  │  ├─ repository.ts
│  │  ├─ schema.ts
│  │  ├─ reference_manager.ts
│  │  ├─ reference_resolver.ts
│  │  ├─ markdown_tools.ts
│  │  └─ migrations/
│  │
│  ├─ model-local/
│  │  ├─ gateway.ts
│  │  ├─ ollama.ts
│  │  └─ openai_compatible.ts
│  │
│  ├─ connector-markdown/
│  │
│  ├─ connector-mcp/
│  │
│  └─ connector-calendar/
│
├─ docs/
│  ├─ implementation_plan.md
│  ├─ operations.md
│  ├─ m4_dependency_spike.md
│  └─ google_calendar_readonly_binding_design.md
│
├─ package.json
├─ pnpm-workspace.yaml
└─ pnpm-lock.yaml
```

---

# Technology Stack

| Area            | Technology                    |
| --------------- | ----------------------------- |
| Language        | TypeScript                    |
| Runtime         | Node.js 24                    |
| Package Manager | pnpm workspace                |
| HTTP            | Hono                          |
| Validation      | Zod                           |
| Database        | SQLite                        |
| SQLite Driver   | better-sqlite3                |
| ORM / Schema    | Drizzle                       |
| Local LLM       | Ollama                        |
| LLM API         | OpenAI-compatible             |
| MCP             | Model Context Protocol SDK    |
| UI              | Hono JSX + Vanilla TypeScript |
| UI Build        | esbuild                       |
| Unit Test       | Vitest                        |
| E2E             | Playwright                    |
| Lint / Format   | Biome                         |
| CI              | GitHub Actions                |

---

# Current Roadmap

Companion Harness は milestone 単位で構築しています。

| Milestone | Scope                                  | Status                  |
| --------- | -------------------------------------- | ----------------------- |
| M0        | RunEngine / SQLite / HTTP / ToolBroker | Implemented             |
| M1        | ReferenceManager / Markdown            | Implemented             |
| M2        | Local Model / Agent / Citation         | Implemented             |
| M3        | Conversation UI / SSE                  | Implemented / hardening |
| M4        | MCP / Calendar                         | Foundation / design     |
| M5        | Write Actions / Approval               | Planned                 |

v0.1 は M0〜M4 を対象とし、基本的に **read-only** です。

外部世界へ変更を加える write action は M5 以降で、明示的な approval flow を通す設計です。

---

# Security Model

Companion Harness は現時点では **single-user / local-only** を前提としています。

基本原則:

```text
Remote access                  ×
Model direct filesystem access ×
Model direct network access    ×
Dynamic tool exposure          ×
Automatic write action         ×

Loopback-only server           ✓
Default-deny tools             ✓
Explicit schemas               ✓
Bounded execution              ✓
Durable audit metadata         ✓
Immutable references           ✓
Citation grants                ✓
```

Server / Model / MCP のネットワーク接続は原則 loopback に限定します。

ログにも message text、prompt、tool output、file path、API key 等を保存しない方針です。

---

# Non-goals

現時点で以下は Companion Harness の目的ではありません。

```text
Multi-user SaaS
Remote authentication
Distributed execution
Vector database
Semantic RAG
Automatic long-term memory
Cloud-first architecture
Automatic external writes
LLM-provider-specific optimization
```

まずは、

> **一台のマシン上で、会話・生成・参照・ツール実行を壊れにくく管理する**

ことを優先します。

---

# Quick Start

Requirements:

```text
Node.js 24.12.0
pnpm 11.25.0
```

Install:

```bash
pnpm install
```

Test:

```bash
pnpm test
pnpm typecheck
```

Start:

```bash
pnpm start
```

Default:

```text
http://127.0.0.1:3000
```

---

# Local Model

モデルは明示的に設定した場合のみ有効になります。

Example with Ollama:

```bash
COMPANION_MODEL_JSON='{
  "adapter": "ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "llama3.1"
}'
```

OpenAI-compatible:

```bash
COMPANION_MODEL_JSON='{
  "adapter": "openai-compatible",
  "baseUrl": "http://127.0.0.1:8000",
  "model": "local-model"
}'
```

Model config が存在しない場合、偽の回答を生成する fallback は行わず、Run は fail-closed します。

---

# Markdown References

Markdown vault を利用する場合:

```bash
COMPANION_MARKDOWN_ROOTS_JSON='[
  {
    "path": "/path/to/notes",
    "alias": "notes"
  }
]'
```

複数 root を指定できます。

Markdown は読み取り専用です。

---

# Calendar (opt-in, C14)

Calendar は **明示的な opt-in 設定 + 信頼済みホスト側 binding 定義の注入** が揃った
場合のみ有効になります。設定が存在しなければ何も登録されません（default disabled）。
発見ベース / モデル定義ベースの登録は存在しません。

設定は「config ヒント」に限定されます。書けるのは厳密な単一カレンダー選択
(`calendarId` / `account`) と MCP 接続の identity / transport / binding 名と
schema-hash だけで、**信頼済み read-only binding 定義 (`category`) をこの設定で
与えることはできません**。定義 (category 含む) は必ず信頼されたホストコードから
`startServer` に注入する必要があります。設定だけで有効化を要求した場合は
起動に失敗します (fail-closed)。

```bash
# FAKE shape-only example (NOT a provider claim, NOT runnable as-is:
# placeholder hashes, fake wire identity). Real complete runnable example:
# docs/operations.md, C14 pinned google-readonly profile (copy-pastable
# POSIX setup + node JSON generator with the full pinned live-wire hashes).
COMPANION_CALENDAR_JSON='{
  "selection": {
    "calendarId": "primary",
    "account": "me@example.com"
  },
  "connector": {
    "serverId": "calendar-fake",
    "kind": "mcp",
    "expectedServerName": "fake-calendar",
    "version": "0.0.0-test",
    "transport": {
      "kind": "stdio",
      "command": "/path/to/calendar-mcp",
      "envAllowlist": ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]
    },
    "bindings": [
      { "upstreamTool": "list-events",   "canonicalSchemaHash": "...64hex..." },
      { "upstreamTool": "search-events", "canonicalSchemaHash": "...64hex..." },
      { "upstreamTool": "get-event",     "canonicalSchemaHash": "...64hex..." }
    ]
  }
}'
```

挙動:

- `connectorInstanceId` は設定には現れません。サーバー自身が登録した
  connector instance の id を bootstrap で正確に結び付けます。
- 接続は lazy です。起動は upstream が利用不可能でもブロックされません
  (失敗は呼び出しごとの固定 `mcp_unavailable`)。
- Markdown root が 0 でも Calendar は単独で利用できます
  (`calendar.search` + stored reference tools のみの broker)。
- drain 時には engine drain の後に owned connector の停止待ちが
  上限付き (10 秒 backstop) で走ります。
- upstream binding は今も **HOLD / NOT ADOPTED** です。上記の例は
  構成ファイル形状の説明であり、provider 採用の主張ではありません。

### Pinned google-readonly profile (CURRENT, opt-in)

通常起動 (`pnpm start`) から採用済み candidate を選択できます。厳密な opt-in
(`COMPANION_CALENDAR_PROFILE=google-readonly`) + 既存 `COMPANION_CALENDAR_JSON`
ヒントが採用 candidate (`suiso11/google-calendar-mcp `6939311…`,
`3.0.0-readonly.2`, `list-events`/`search-events`/`get-event` の live-wire hash)
と完全一致した場合のみ、ホスト所有の信頼済み定義が注入されます。profile 未設定
の既定動作は不変 (無効のまま)、未知 profile・不一致・任意 binding/hash は
fail-closed です。`selection.account` を付ける場合は pinned fork 文法
`^[a-z0-9_-]{1,64}$` (小文字 ASCII のみ; メール/大文字/超過/不正文字は
`calendar profile account mismatch` で失敗、省略は有効) に従ってください。
非 profile の汎用 account 契約は不変です。profile の解決
(selector 凍結・完全性・注入競合・適合性) はすべて DB 副作用
(`ensureDbDir`/open/migration) より前の同期 preflight で行われるため、失敗時は
DB ファイルも親ディレクトリも作られず、既存の旧 DB はバイト同一のままです。
profile は専用の永続 display 名 `calendar-mcp-google-readonly`
(汎用 `calendar-mcp` とは別) で登録されるため、同一 selection の旧汎用行が
再利用されることはなく、旧 target の refresh は新 provider に届きません
(`reference_not_found`)。profile 採用は認証済み live 読みで受け入れ済み
(ユーザ OAuth 完了、認証済み live 読み OBSERVED): 未了は新規 consent
画面の scope 表示・live 本番検証 (C11 positive BLOCKED、manual Win11
未了) のみであり、同意の欠落主張や強制 reconsent ではない。完全な
copy-pastable 準備・認証・起動手順 (Desktop-app クライアント、前提検証、
JSON 生成スクリプト) と credential-free 実行証跡は docs/operations.md
(C14 profile) を参照してください。実行証跡が示すのは runtime 側
(wire identity + 3 live-wire hash + 挙動) のみであり、source SHA の再検証では
ありません: `npm ci` 前の full commit/tree/package/lock 検証が前提条件です。

---

# Actions (opt-in, triple-gated, C21)

M5 の Action 実行 (`m5-action` / `calendar.reschedule`) は **3 つの条件を
すべて満たした場合のみ** 登録されます。1 つでも欠ければ何も登録されません。

1. `COMPANION_ACTIONS_JSON` の `optIn` (既定 `false`)
2. 同設定の `writeEnabled` (既定 `false`)
3. 信頼済みホストコードが注入した専用 `CalendarActionWritePort` が、
   実際に有効な Calendar 接続 instance と**同一の instance** に束縛されている

```bash
COMPANION_ACTIONS_JSON='{ "optIn": true, "writeEnabled": true }'
```

- 設定はヒントに過ぎません。capability / category / connector instance id を
  env から与えることはできず、書き込み port は必ず `startServer({
  actionWriteBinding: { port, shutdown?, owned? } })` で注入します
  (本コードベースには production の実書き込み binding は存在しません)。
- 設定が有効で binding が active instance と一致しない場合は listen 前に
  fail-closed します。設定が無効な場合、注入された port は一切使われません。
- 無効時は staging できず、approve は repository 呼び出し前に固定
  `409 action_execution_disabled` を返します (queue される孤立 Run を作りません)。
  一覧 (decision read) は従来どおり状態を返します。
- port の lifecycle は `owned: true` を明示した場合のみサーバーが close します
  (caller 所有の port は閉じません)。

---

# Design Philosophy

Companion Harness では、LLM をシステムそのものとは考えません。

```text
                  ┌─────────────┐
                  │    Model    │
                  └──────┬──────┘
                         │
                    replaceable
                         │
                         ▼
                  ┌─────────────┐
                  │    Agent    │
                  └──────┬──────┘
                         │
                  RunStrategy
                         │
                         ▼
              ╔════════════════════╗
              ║ Companion Harness  ║
              ║                    ║
              ║ RunEngine          ║
              ║ ToolBroker         ║
              ║ ReferenceManager   ║
              ║ Repository         ║
              ║ Contracts          ║
              ╚══════════╤═════════╝
                         │
                      SQLite
```

モデルが変わっても、

```text
何を実行しているのか
何を見たのか
何を引用できるのか
どの能力を使えるのか
キャンセルされたのか
どの回答が正式なのか
```

は Harness 側に残ります。

**Companion Harness は AI そのものではなく、AI が安全に会話し、調べ、行動するための土台です。**

---

# Current C04/C05/C06 Browser Resilience Acceptance (2026-10-11)

This section records the current local acceptance for the active-run bootstrap/hydration contract and the C06 accepted-202 reload fix. It is evidence for the current local worktree only and does not assert completion of all Phase 1 / M3 work or Windows 11 x64 manual smoke. (Remote Windows/Linux CI for this review code is now confirmed and recorded in the C07 section below.)

- **Active-run API contract**: `GET /api/sessions/:sessionId/active-run` returns `{ run: { id, turnId, status, eventSeq } }` for the single queued/running/cancel_requested run, or `{ run: null }` when there is genuinely no active run (session existence is checked first and returns 404).
- **Product behaviour**: boot discovery re-subscribes to an existing active run and reuses history rendering; durable terminal delivery is deduplicated; the in-memory reducer cursor is reconstructed on reload (JSON fallback replay restarts from `0`) and is distinct from the saved resume hint `ch.cursor.<runId>`.
- **Browser acceptance**: **23/23** real Chromium browser cases pass (0 skipped, 0 flaky, 0 retries, duration ≈79.0s), including the 4 C06 reload cases plus 2 review regressions (held-history send guard; cancel_requested saved-cursor-3 reload snapshot then a real cancelled-4 terminal). The prior 21/21 run remains historical evidence: the first rebind run showed 4 failures because the spec compared the whole status projection with `toEqual`; the helper was minimally corrected to the declared projection, after which the authoritative run passed 21/21.
- **Unit / static**: **88 files / 1086 tests** pass; root `tsc --noEmit` exit 0; E2E `tsc --noEmit` exit 0; Biome `check .` exit 0; an independent read-only review reported no remaining C06 defect.

Evidence:

- [C04/C05 real-browser resilience execution](docs/plan/browser_resilience_execution_2026-10-10.md)
- [Provisioned Chromium existing-browser baseline](docs/plan/provisioned_browser_baseline_2026-10-10.md)
- [Execution progress / C06 reload acceptance](docs/plan/execution_progress_2026-10-10.md)

Remaining gates not closed by this local evidence: Phase 1/M3 as a whole, Windows 11 x64 manual smoke, M4/Phase 4 live adoption, and remote Windows/Linux CI for any later HEAD. The remote Windows/Linux CI for the PR #11 review code (`56b7952a…`) is now confirmed green — see the current C07 aggregate CI evidence below; that confirmation does not extend to future HEADs.

---

# Current C07 Aggregate CI Evidence (2026-10-11)

This is a **remote CI aggregate** for the C04/C05/C06 browser-resilience work, pinned to the exact tested revision. It does not reuse a historical CI green and does not assert CI for any later HEAD.

- **Tested revision**: `56b7952a7e8adc2e0dcc4b5a4658feb589723cd1` (the PR #11 review head; merged as `e6b53536fa4cf8790a6dfa8a136d92cc01a47c76`).
- **CI runs** (completed / success, same SHA):
  - `pull_request` — [run 38106715359](https://github.com/suiso11/companion_harness/actions/runs/38106715359)
  - `push` — [run 38106713796](https://github.com/suiso11/companion_harness/actions/runs/38106713796)
- **Jobs**: `check (ubuntu-latest)`, `check (windows-latest)`, and `e2e` (one `e2e` job per run, i.e. two green `e2e` jobs).
- **Unit tests**: Ubuntu **88 files / 1086 passed / 0 skipped**; Windows **88 files / 1084 passed / 2 skipped (1086 total)**. The 2 Windows skips are the two unconditional `win32` cases in `packages/connector-markdown/test/safe_read.test.ts`: `reads a POSIX colon filename (notes:2026.md)` (Windows cannot create colon filename segments) and `rejects a composed-key retarget to a decomposed internal target on POSIX` (this POSIX retarget case is explicitly skipped on win32; underlying filesystem rationale not established by this evidence). There is no blanket `1086 passed` on Windows.
- **Browser E2E**: **23/23 passed** in each `e2e` job (real Chromium, 1 worker, ≈1.3 min). The current source defines **23 cases** across 4 spec files (22 static `test()` call sites; `sse_history.spec.ts:447` parameterizes one call site into 2 cases), and the executed count is taken from the run report, not inferred from the source count.
- **Static checks** (root): Biome `check .` checked **185 files, no errors, 1 pre-existing info** (deprecated `recommended` field in `biome.json`); root `pnpm typecheck` (`tsc --noEmit -p tsconfig.json`, which covers `apps/server` src and test) exit 0. The dedicated `pnpm typecheck:e2e` (`tsc --noEmit -p apps/server/tsconfig.e2e.json`) runs as a separate `E2E typecheck (harness + spec + config)` step and is green; there is no separate server-only CI typecheck.
- **Historical context preserved**: the local 21/21 then 23/23 browser runs and the earlier 12/17 figures remain historical local evidence — this section does not replace them and does not restate them as remote CI.

Status matrix and per-item evidence: see [execution progress / current C07 CI evidence](docs/plan/execution_progress_2026-10-10.md).

Remaining gates after this C07 aggregate: Phase 1/M3 as a whole, Windows 11 x64 manual smoke, M4/Phase 4 live adoption, and CI for HEADs later than the pinned SHA (this docs commit's own CI is pending until observed).

---

# Current PR20 Integrated Verification (2026-10-13)

This section records the FINAL integrated acceptance for PR #20 at HEAD `61b3573` (review threads fixed plus independent-review follow-ups). It does not rewrite the C04–C07 evidence above and does not close any formal release gate.

- **Full suite (run once)**: `pnpm test` exit 0 — **106 files / 1270 tests passed, 0 failed / 0 skipped**; root `pnpm typecheck` exit 0; `pnpm typecheck:e2e` exit 0 (Linux, Node 24.12.0).
- **Lint (post-cleanup recheck, run once)**: `pnpm lint` exit 0 — **219 files checked, 0 errors, 1 pre-existing info** (deprecated `recommended` field in `biome.json`); the earlier exit-1 ground truth was exactly 2 format diagnostics on own temporary `.review-plan-work/reviews-*.json` only, parsed then removed with the directory. All product/source files clean.
- **Browser**: `e2e/calendar/action.spec.ts` **13/13 passed at `61b3573`** confirmed by record, not rerun.
- **§19 source-run (actual, first on this branch)**: real `pnpm start` cold start (`migrated 7`, `recovered 0`, listening on loopback `127.0.0.1:44831` with a credential-stripped explicit env, no Calendar/model config, no Google/OAuth) → `GET /health/live` 200 + `GET /health/ready` 200 → stopped-server `pnpm --filter @companion/server backup` exit 0 (basename-only `companion-manual-<UTC>-<uuid>.sqlite`, file `0600`, dirs `0700`, `quick_check` ok) → stopped-only manual restore after simulated loss (temp copy + `quick_check` + atomic rename, 7/7 documented steps) → second cold start `ready` 200 with the pre-backup session resolving 200 (data survived) and an unknown id 404ing. Own smoke files removed afterwards.
- **Residual gates (explicit, not closed)**: C08 HOLD, C10 production mapping UNRESOLVED, C11 authoritative positive BLOCKED (cancelled/404/410/omission never positive), Windows 11 manual smoke NOT executed, fresh OAuth a separate untouched decision, dedicated write binding / adoption + triple-gate live use NOT authorized, Remind I01–I05 unapproved (other repo, no C23/C24 invented), candidate PR21/22 stacked review-only (PR20 baseline pin gaps claim nothing newest).

Deep verification record (commands, counters, residual map, §20 write-binding source facts): [docs/operations.md](docs/operations.md) ("PR20 integrated plan verification").

---

# Delivery M3 on Master (2026-10-14)

This section records the recovery completion of the interrupted `deliver-m3-on-master` run: branch `delivery/m3-on-master` from `origin/master` (`2474572`), migrating only the 5 files of M3 behaviors/tests missing on master. It does not rewrite the C04–C07 or PR20 evidence above.

- **Migrated files**: `apps/server/e2e/citation_recovery.spec.ts` (genuine concurrent-409 CAS recovery test), `apps/server/e2e/server.ts` (per-seed unique citation resource; fixes second-seed UNIQUE collision in one webServer run), `apps/server/src/ui/client.ts` (retry label `もう一度生成`, §16.5 conflict notice), `apps/server/e2e/conversation.spec.ts` (retry label alignment), `apps/server/test/m3_ui.test.ts` (M3 UI unit coverage).
- **Prior-run recovered evidence**: unit **106 files / 1275 passed**, both typechecks green, citation full suite green after UNIQUE-collision fix and temp-debug removal (no temp debug remains on the branch).
- **Current-run browser (actual production Chromium, owned temp stores, latest migrated code)**: default suite **24/24 passed** (≈1.3 min, 1 worker); Calendar/Action suite (`COMPANION_E2E_CALENDAR=1`) **18/18 passed** (≈45.8s). Total **42/42**, 0 skipped/flaky/retries.
- **Lint**: `biome check` on the 5 migrated files — clean, no fixes.
- **Cleanup**: owned `apps/server/test-results/` artifact removed; no owned child services left running; root dirty checkout and other worktrees untouched.

Remaining gates not closed here: Windows 11 x64 manual smoke, remote CI for this branch/PR, M4 readonly adoption, M5 write actions.

---

# Live Readonly Acceptance Ledger (2026-10-14, current profile)

Current accepted activation is the host-owned pinned `google-readonly`
profile (`suiso11/google-calendar-mcp` @ `6939311…`,
`3.0.0-readonly.2`, `calendar.events.readonly` only, 3 live-wire hashes;
`list-calendars` deliberately absent — never restored to satisfy the
proposal-era checklist). Observed live evidence (sanitized
counts/codes/tool/reference transitions only; no events, tokens, or raw
prompts): a live read-only conversation completed end to end
(`run.completed`, one `calendar.search` succeeded/accepted, one
`reference.presented` with snippet grant `[r1]` cited, turn selected),
plus a live readonly refresh proof (2026-10-14, throwaway owned temp
SQLite, real pinned google-readonly pipeline, fixed counting wrapper
preserving the full call interface, no production change): list 10 hits
(`list-events` x1, opaque cursor present), query mapping
(`search-events` x1), stored-only open 0 new wire calls with non-empty
body, explicit `reference.refresh` via `get-event` x1 only creating a new
snapshot (10->11) and new rN (refs +1) with revision unchanged, prior rN
re-openable with 0 new wire calls (`deduplicated`), fresh snapshot body
keys `[text, version]` with 0 excluded privacy keys, 3 distinct upstream
tools / 3 total wire calls, second page `succeeded` (1 hit),
`proof=live_refresh_observed`, and loopback `:3000` returned `GET
/health/live` 200 +
`GET /health/ready` 200 with the server left running (UI freshness
re-verified 2026-10-14 ~17:41 UTC: one safe `run-google-readonly.sh`
restart after the served bundle was found predating current `client.ts`;
served `/assets/client.js` now hash-matches the rebuilt dist and carries
the PR28 fixes; health 200/200 re-probed; read-only/actions-disabled
preserved). User OAuth is
COMPLETED with authenticated live reads OBSERVED (only consent-screen
scope display unobserved; never force reconsent). Reused automation is
the oc10 PRE-PR28-CODE-CHANGE baseline only (not rerun, not a current
full-suite claim): lint 229 files 0 errors + 1 pre-existing info, both
typechecks exit 0, units 107 files / 1307 tests, real default Chromium
24/24, fake Calendar 26/26 (action 21 / calendar 4 / tombstone 1).
CURRENT browser actuals after the 4 PR28 race fixes (oc21 final
observed; reviewer oc22 confirmed strengthened PR28-2/4 non-vacuous):
default 24/24 prior value unchanged (not rerun — test-only change in
`calendar/action.spec.ts`); calendar 30/30 (action 25 + calendar 4 +
tombstone 1); final units 107 files / 1307 tests pass; both typechecks
exit 0; `biome check .` exit 0 (229 files, 0 errors, 1 pre-existing
info). Repository throwaway scaffolds removed; one private temp
artifact `/tmp/live-refresh-proof-LMZ0zi` (owned 3 SQLite files) remains
permission-blocked with no active process.
Historical snapshots above (C04–C07, PR20, M3) are preserved and not
restated as this run.

Remaining genuine blockers: Windows 11 x64 manual smoke, positive
deletion evidence (C11-01 BLOCKED — 404/410/`cancelled`/omission stay
errors/unknown), M5 live/write gates (no production write binding;
existing readonly cannot write and the dormant broad update path lacks
`If-Match`), fresh OAuth consent-screen scope display as a separate
decision (OAuth COMPLETED, live `reference.refresh` OBSERVED above, not
pending). PR housekeeping (parent-verified): original-stack PR23/PR24
merged, carried into main by merged DELIVERY successors PR27/PR28
(reconciled, not erased); PR21/PR22 closed as superseded (comment +
close only, no merge/deletion, branches retained, evidence verified
preserved on `origin/master`); fork PR2 left draft-open untouched. Full ledger: `docs/operations.md` ("Live readonly
acceptance ledger", "PR21/PR22 superseded close"); spike conclusion:
`docs/m4_dependency_spike.md`; row mapping:
`docs/google_calendar_readonly_binding_design.md`.

---

# PR28 UI Race Fixes (2026-10-14)

Four approval-client races fixed in `apps/server/src/ui/client.ts`, each
with one permanent real-browser regression (`apps/server/e2e/calendar/
 action.spec.ts`, real UI + real fake seams): lost-reject recovery during an
in-flight sync (new authoritative `reconcileLostReject`), stale pending
lists no longer downgrading runId-less approved cards, one batched history
hydration per sync over N historic rejections, and no duplicate watch read
plus no late-live overwrite of a terminal receipt. The PR28-2/PR28-4
regressions were strengthened 2026-10-14 (held older list / held live read
released only after the authoritative state, exact route hits asserted —
no vacuous replays). Measured: Calendar action 25/25,
calendar+tombstone 5/5 (real Chromium, exit 0); full units 107 files /
1307 tests pass; e2e + root typechecks exit 0; `biome check .` exit 0 (229
files, 1 pre-existing info); default 24/24 is the prior observed value
(not rerun — test-only change in `calendar/action.spec.ts`). Detail:
`docs/operations.md` ("PR28 UI race fixes + permanent browser regressions").
