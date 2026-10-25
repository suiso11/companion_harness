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

公開 audit (`tool_calls` / `run_events` / SSE / log) は metadata-only で、
Tool の raw arguments / raw output / raw error をそのまま保存する設計には
していません。明示的に opt-in した private execution records
(`COMPANION_EXECUTION_RECORDS_JSON`) だけが、別ディレクトリに raw な
tool input / handler output / error を保存します (下記参照)。

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

以下は public DB / audit / log には保存しません。

```text
API key
prompt
raw model response
reasoning
raw tool output
```

唯一の例外は明示的に opt-in した private execution records
(`COMPANION_EXECUTION_RECORDS_JSON`) で、debug 用に prompt / raw response /
raw tool I/O を SQLite とは別の private store に保存します。

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
| M6        | Calendar create extension (agreed)     | Implemented (opt-in, `calendar.create` TIMED title/start/end only; fork `google-calendar-create@1.0.0-create.1` pinned CURRENT `7b40eaf` (historical `5f07029`); shared `M5_RESCHEDULE_*` grant, no new credential namespace) |

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

公開 log / audit / SSE / memory は metadata-only で、message text、prompt、
raw tool output、file path、API key 等を保存しない方針です。唯一の例外は
明示的に opt-in した private execution records で、debug 用に raw な
request / response / tool I/O を別ストアへ保存します (default off、下記参照)。

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
Node.js 26.12.0
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
  "model": "local-model",
  "reasoningBudgetTokens": 256
}'
```

`reasoningBudgetTokens` (optional, integer `0..2147483647`) caps
provider-side thinking on main-agent steps only; auxiliary
memory/voice/learning calls stay reasoning-off. It is openai-compatible
only (Ollama rejects it fail-closed). The production launcher already
builds its default main config with `256`; an explicit
`COMPANION_MODEL_JSON` wins, so add the field there too. Timeouts, answer
limits, retries, and model choice are unchanged, and the failure-rate
effect has not been measured yet. `model.step.failed` keeps the public M2
code but may add fixed safe fields `gatewayErrorCode`,
`invalidResponseCause` (`response_too_large` / `malformed_json`), and
numeric `httpStatus`; prompts, bodies, headers, raw errors, and secrets
are never logged.

Model config が存在しない場合、偽の回答を生成する fallback は行わず、Run は fail-closed します。

---

Not covered (remaining §16 acceptance gaps, not full closure):
dedicated JSON status fallback and duplicate-seq E2E remain outside
the current 12-test green; the historical green above does not close
§16 acceptance.
## Conversation memory (strict opt-in remind CLI)

Unset `COMPANION_MEMORY_JSON` (default) means fully memoryless. When
set, it must be a strict JSON object with only `{ executable, entry,
config, scope, timeoutMs?, maxResponseBytes?, recallLimit?, idleMs? }`
(all paths absolute; `scope` 1-256 chars, no controls;
`timeoutMs` 500-30000 default 5000; `maxResponseBytes` 4096-1048576
default 65536; `recallLimit` 1-8 default 5; `idleMs` 5000-300000
default 30000). The remind CLI child is the only remind interface
(`shell: false`, exact `[entry, --config, config]`); Companion never
opens the remind DB. Durable state lives in Companion-owned
`memory_outbox`/`memory_exposures`/`memory_grants` with stable
idempotency keys. Recall is fail-open; extraction reuses the existing
local model gateway only (unset model means no extraction);
feedback is granted only for structural `mN` citations in the accepted
answer. Memory perception/reactivation/retirement, export, and
deletion APIs are not implemented. Full contract: `docs/operations.md`.

C04/C05 local dynamic acceptance is proven by the 2026-10-10 run and C06
by the 2026-10-11 run above; this does **not** complete M3, all plan
§16/Phase 1, Windows 11 manual smoke, or current Windows/Linux CI for
uncommitted edits.

M3 §16 wording alignment, 2026-10-14 (local, uncommitted): failure-only
retry button now renders the agreed plan text `もう一度生成`
(`apps/server/src/ui/client.ts`; `conversation.spec.ts` updated to the
same text) and a reference-context 409 now surfaces
`参照の更新で競合しました。最新の状態を取得しています` in
`#composer-notice` before the existing CAS re-read/retry (drawer still
opens; no new storage). Verified once after edits with temp stores only:
root `tsc --noEmit` exit 0, e2e `tsc -p apps/server/tsconfig.e2e.json`
 exit 0, `biome check` on the two changed files exit 0, full Vitest
 **88 files / 1086 tests passed**, real-browser `conversation.spec.ts`
 **4/4 passed** (production UI build, temp SQLite/RunEngine, loopback;
 C04/C05/C06 suites not re-run). The changed 409 branch itself was not
 exercised in a browser at that point (stale-PUT-409 API evidence only);
 the 2026-10-14 conflict-acceptance run below supersedes that limit.
 M3 remains incomplete; Windows manual
 smoke and current remote CI for these edits are still open.

Live HTTP smoke, 2026-10-15 (local, temp stores only, uncommitted):
real server + synthetic loopback gateway (scripted `answer.submit` +
extraction JSON; no real model) + REAL remind CLI temp DB
(`allowedScopes ["personal","default"]`, LLM/vectors disabled).
Turn 1 completed with `event.append` + `record.remember` acked
(attempts 0) and CLI `record.recall` returning 1 snippet; turn 2
recalled and answered with structural `citations: ["m1"]`, and
`record.feedback` acked with a same-run `m1` grant; idle
`maintain.distill` auto-enqueued and acked (degraded, LLM disabled:
scheduling proof only). Preemption/start/stop edges are covered by
existing unit regressions. This is not a real-model result and does
not complete Windows manual smoke or current remote CI.

# Private execution records (opt-in, local only)

Unset `COMPANION_EXECUTION_RECORDS_JSON` (default) means no private
records. When set, it must be a strict JSON object with only
`{ directory, retentionDays? }`: `directory` is an absolute host path
(no symlinks anywhere in the path), `retentionDays` is an integer
`0..3650` default `30` (`0` means prune everything older than startup
time). No HTTP route returns records; they live in a separate store, not
in the DB or public audit.

Recorded (when enabled): model request (provider/base/chat URL, model,
messages, tool definitions, step settings, system prompt, prompt variant,
harness fingerprint), raw response body (including exact streaming SSE
bytes and malformed bodies; status only, never headers), normalized
response, model outcome, tool input, raw handler output/error (including
late/discarded settlements), and normalized tool result/error. Public
`run_events` / `model_calls` / `tool_calls` / SSE / logs / memory remain
metadata-only and unchanged. `web.search` calls are recorded like any
other tool. Credential-shaped object keys (and credential keys inside
encoded JSON bodies/arguments) are removed; arbitrary free text such as
message content is preserved verbatim and may still contain secrets.
There is no encryption at rest.

Permissions are directories `0700` / files `0600` on POSIX (created
directories only; pre-existing ancestors are not re-permissioned).
Writes are atomic; a crash may leave an incomplete `.tmp-*` entry that
`list` reports instead of pretending it was captured. A record larger
than the per-record ceiling is reported with explicit `omitted`
metadata. A recording write failure fails that invocation/Run (never a
silent partial record). Startup prunes records older than
`retentionDays`.

Operate it with the local-only CLI (no record contents in logs):

```bash
pnpm records list
pnpm records show <recordId>
pnpm records export <runId>   # JSON on stdout
pnpm records delete <recordId>
pnpm records prune [days]     # default = configured retentionDays
```

The CLI fails closed when the variable is unset. It uses fixed safe
stderr messages and prints no paths or payloads on failure.

# Voice layer (opt-in, local only)

Unset `COMPANION_VOICE_JSON` (default) keeps answers canonical; results have
no `voice` key. When set together with `COMPANION_MODEL_JSON`, the value must
be a strict object with only `{ profile, timeoutMs? }`; only bundled profiles
are accepted (currently `shunkin`), and `timeoutMs` is `1000..120000`
(default `30000`). Unknown keys or profile ids fail startup closed.

```bash
COMPANION_VOICE_JSON='{"profile":"shunkin","timeoutMs":30000}'
```

Flow: the canonical answer is validated first, then after step finalization
one auxiliary model call (reasoning off, output cap derived from the canonical
length) asks the profile to voice the same parts. Any response that parses as
the expected JSON with one part per canonical part is accepted and shown; the
prompt asks the model to preserve facts, numbers, URLs, citation markers, and
code, but no structural fidelity gate runs. Only a timeout, provider error,
malformed/empty output, wrong part count, or oversized canonical answer falls
back to the canonical text.
The auxiliary call is not a step, is not recorded in `model_calls`, and does
not consume the 8-step or tool budgets; it is bounded by the remaining run
wall budget and `timeoutMs`. On the current main model, expect roughly 1-4s.

Canonical text remains authoritative for history projection, memory intake,
citations, and comparison output. The voiced text is stored only as an
optional `RunResult.voice` projection; the UI shows it by default with an
「原文」/「話し方」 per-answer toggle. Voiced text is not streamed: the draft
answer streams canonical, and the voiced version appears when the run
completes.

The profile is based on 谷崎潤一郎『春琴抄』 (青空文庫, public domain) plus
船場言葉 features (Wikipedia 大阪弁#船場言葉). Limits: without the gate, a
voiced rendering can change negation or ASCII wording if the model drifts;
prompt-based style may drift; LoRA is future work (a
per-request LoRA would apply to the voice call only). The optional `voice`
field extends the strict RunResult schema, so rolling back to a pre-voice
build cannot read rows containing it.

# Fixed-task comparison CLI (experimental)

`pnpm compare -- /abs/input.json` runs the REAL agent path twice on one
fixed task: baseline = the immutable base system prompt only; variant =
the same base prompt with the operator's guidance appended (never
replacing the base). The model comes from `COMPANION_MODEL_JSON` and
must satisfy the same strict loopback-only parser as the server.

Input is strict version-1 JSON: `version` (`1`), `prompt` (1..20000
chars), `docs` (1..6 entries `{ key, path, title? }`; absolute,
non-symlink regular UTF-8 files ≤32 KiB, unique keys
`^[a-z][a-z0-9_-]{0,63}$`), `storageDirectory` (absolute),
`variant` (`{ label, systemPrompt }`, label
`^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$`, guidance 1..8000 chars),
`timeoutMs?` (1..900000, default 180000), `maxSteps?` (1..8). Unknown
keys are rejected.

Each invocation gets a fresh private `comparison-*` directory (mode
`0700`) under `storageDirectory`, shared by both runs, with its own
SQLite DB and private execution records. Only the fixed document tool
(`experiment.read`) plus the terminal `answer.submit` are available; no
production MCP/Calendar/Web tools are registered. Output contains the
actual answers/citations/tool calls/token counts/durations for baseline
and variant (plus task/document hashes and the storage path). It
computes no score and never auto-adopts a variant; the operator compares
the evidence.

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
ヒントが採用 candidate (`suiso11/google-calendar-mcp `cefb63c…`,
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
  (通常起動のホスト所有 write profile
  (`M5_RESCHEDULE_WRITE_PROFILE=google-reschedule` +
  `M5_RESCHEDULE_CONNECTOR_JSON` stdio ヒント) を除き、本コードベースに
  その他の production 実書き込み binding は存在しません; profile 未設定の
  既定は無効のまま)。profile 選択時は注入 binding と相互排他であり、
  `M5_RESCHEDULE_TEST_*` の allowlist 指定は fail-closed です
  (fixture endpoint は options 注入の子プロセス env のみ)。
  受け入れ証跡: `apps/server/test/rescheduleWriteStartup.test.ts`
  (実 stdio E2E の HTTP approve 1 PATCH + readback receipt を含む; PR31
  レビュー3件対応済み: production factory の implicit-env 事前検証、
  `actionWriteBinding: null` の absent 扱い、Windows 絶対パス受容 +
  space 含み実バイナリの production spawn)。
  PR33 レビュー5件対応済み (ソース `753046f`): 凍結 SDK 継承 env の欠落は
  spawn 前に fail-closed (live-env fallback なし; win32 は canonical key へ
  case-insensitive 解決)、write TestIdentity は canonical 128/64 を DB 副作用
  前に検証 (任意 factory)、`derivePort` は設定済み・注入済み calendar 構成の
  双方で動作、write 提案/port はミリ秒表現可能な instant のみ
  (末尾ゼロ `.123000` 可、真の `.1234` は stage/write 前に拒否) で readback は
  同一 instant (等価 offset 可) を比較、write 応答は `structuredContent` が
  own-property 存在時に authoritative (text は absent 時のみ strict JSON fallback)。
  Persisted-grant 統合 (fork `cefb63c`, PR #4): write 子は永続 grant
  ファイルから認証し、env secret の手動コピーは不要。推奨は file-only —
  allowlist は SDK 継承名 + `GOOGLE_OAUTH_CREDENTIALS` (Desktop クライ
  アントファイルパス) + `M5_RESCHEDULE_WRITE_TOKEN_PATH` (grant ファイル
  パス) + `M5_RESCHEDULE_ACCOUNT` (正確な account 選択子) +
  `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH` (衝突 guard 可視性; custom
  readonly 設定時は必須) のみ
  (`M5_RESCHEDULE_CLIENT_*` / `REFRESH_TOKEN` / `GRANTED_SCOPE` /
  `ACCESS_TOKEN` の値は不要; 部分 env credential はファイル fallback なし
  に拒否)。設定 account は selection `account` と完全一致が必須
  (不一致は DB 副作用前に起動拒否)。分離 consent (out-of-band, exact
  scope のみ): fork checkout 側で `npm --prefix "$WRITE_FORK" run
  auth:write -- --account "$WRITE_ACCT" --port 3500
  --ttl-minutes 12 --no-browser (root には同 script なし; `$WRITE_ACCT` は
  `^[a-z0-9_-]{1,64}$`; 出力
  `~/.config/google-calendar-mcp-write/tokens.json`,
  0600, readonly とは別ファイル)。build/consent 前に fork の exact pin
  検証が必須 (commit/tree/package/lock digest + clean 状態)。証跡:
  `packages/connector-calendar/test/reschedulePersistedGrant.test.ts` 7/7
  (実出荷 CLI の `tools/list` + 6 拒否境界、Google 0 件) + file-only 通常
  起動 8/8 (production frozen-env factory + 追跡 fixture の file-auth 契約
  ミラー: 1 正常 1 PATCH verified、3 省略拒否、frozen 証明、account 不一致
  起動拒否、readonly 隠蔽の起動拒否、衝突拒否 0 PATCH)。
  詳細な手順・検証数は docs/operations.md (M5 persisted write-grant auth)
  を参照。
- 設定が有効で binding が active instance と一致しない場合は listen 前に
  fail-closed します。設定が無効な場合、注入された port は一切使われません。
- 無効時は staging できず、approve は repository 呼び出し前に固定
  `409 action_execution_disabled` を返します (queue される孤立 Run を作りません)。
  一覧 (decision read) は従来どおり状態を返します。
- port の lifecycle は `owned: true` を明示した場合のみサーバーが close します
  (caller 所有の port は閉じません)。
- 証跡ナビゲーション (stored-only, 上流 I/O なし):
  承認カードと履歴は所有プロポーザルの不変 target 由来の BEFORE (`rN`)
  ボタンを持ち、検証済み AFTER は receipt `succeeded` かつ権威ある
  `run.result` の実引用がある場合のみ履歴に表示します
  (`succeeded_unverified` の preflight 引用は AFTER 化しません)。
  どちらのボタンも既存の引用ドロワーの保存済みスナップショット本文のみを開き、
   開封で外部 GET/PATCH は発生しません。リロード後も両リンクは保持されます。

---

# Web search (opt-in, default off)

`web.search` は 1 つの自己ホスト SearXNG endpoint に境界付き query を投げ、
結果を session reference (`r1..rN`) として具体化する読み取り専用ツールです。
既定 (unset) では何も登録されず、モデル向けツール一覧に `web.search` は
現れません。不正 JSON / 非 loopback URL は黙って無効化されず、起動失敗します
(fail closed)。

```bash
# 前提: slice-1 のローカル SearXNG が loopback で起動済みであること
COMPANION_WEB_SEARCH_JSON='{"enabled":true,"searxng_base_url":"http://127.0.0.1:8888"}'
```

- 厳格な任意フィールド (既定値): `max_results: 5` (1..8)、
  `timeout_ms: 10000` (1000..60000)、`per_turn_budget: 3` (1..8)、
  `max_response_bytes: 1048576` (1024..8388608)。
- 有効時のみ (登録時だけ) モデルの一覧に現れます。詳細は
  docs/operations.md「Web search (SearXNG, default off)」参照。

---

# モニター (`/monitor`)

ホストとモデル呼び出しの概況を 1 ページで確認できる読み取り専用ビューです。

```text
状態 / 実行中・待ち Run
出力速度 (tok/s、プリフィル込みの概算)
GPU ごとの使用率・VRAM・温度・電力 (直近 2 分)
CPU / RAM
サービス (モデル設定・SearXNG の ok/down/disabled)
最新 20 件のモデル呼び出し
24 時間の合計 (呼び出し数・入出力トークン・失敗数)
```

- データ源: GPU は `nvidia-smi` (`execFile`、shell なし、固定引数、
  2 秒 timeout)、CPU/RAM は `/proc`、モデル呼び出しは `model_calls` の
  メタデータのみ、SearXNG は `/healthz`。取得不能値は `0` ではなく
  `null` (UI は `—`) になります。
- サンプラーは遅延起動です。最初の読み取りまでタイマーも子プロセスも
  なく、60 秒読み取りが無いと自動停止して履歴リングを破棄します。
- 画面表示中のみ 2 秒間隔で同一オリジンの `GET /api/monitor` を
  ポーリングします (タブ非表示で停止、再表示で即時 1 回)。
- リモートモード有効時は他の API と同様にセッション必須です。応答は
  スカラー値のみで、上流 URL・生のエラー・プロンプト・モデル出力は
  含みません。
- `model_calls(created_at)` の索引を additive migration `0029` で追加。
- レイアウトは [Strata](https://github.com/Niko1221/Strata) (MIT) の
  monitor に着想を得ています。コードはコピーしていません。

---

# リモートアクセス (default-off)

tailnet 経由のリモート利用に向けた、明示的 Origin/Host allowlist +
単一ユーザーパスワード認証です (slice (a): allowlist、slice (b): ログイン
セッション、既定で無効)。サーバーは常に loopback のみ bind します
(`COMPANION_HOST` は `127.0.0.1` / `localhost` のまま; `0.0.0.0` は
引き続き起動拒否)。tailnet 側の到達性 (例: `tailscale serve` による
HTTPS 終端 + `127.0.0.1:<port>` への proxy) はアプリの外で用意し、
アプリは TLS 鍵を持ちません。

```bash
COMPANION_REMOTE_JSON='{"enabled":false,"allowedOrigins":["https://<host>.<tailnet>.ts.net"]}'
```

- `enabled` (既定 `false`)、`allowedOrigins` (既定 `[]`、最大 16 件・各
  256 文字まで)。各要素は正確な `https://<host>` 形式の origin のみ:
  https scheme、認証情報・明示ポート・path/query/fragment・末尾スラッシュ
  不可 (自身の `URL.origin` と完全一致すること)。未知キー・重複・不正
  JSON は固定メッセージで起動失敗します (値のログ出力なし)。
  未設定は無効と同等です。不正 JSON は無効化ではなく起動失敗します
  (fail closed)。
- 無効時 (既定): Host/mutation 検査は従来どおり (loopback Host のみ、
  loopback 同一オリジンの mutation のみ、読み取り検査なし)。ログイン
  surface は存在しません (`/api/remote/login` は 404)。
- 有効時: Host ヘッダは allowlist 由来ホストまたは loopback のみ許可
  (health 含む全 route)。mutation は allowlist + 現在の loopback
  同一オリジンとの正確な Origin 一致を要求。GET API・SSE も Origin 提示
  時は一致を要求 (同一オリジン GET の Origin 省略は通常どおり許可、
  `Sec-Fetch-Site: cross-site` は拒否)。`Origin: null` は常に拒否。
  判定は Host/Origin/Sec-Fetch-Site ヘッダのみで行い、`remoteAddress`
  や `X-Forwarded-*` は使用しません (認証・認可・allowlist 判定に
  proxy ヘッダは使いません)。CORS ヘッダは発行しません。
- fail-closed: 空 allowlist のまま有効化は起動失敗します。
  `enabled` を `false` に戻すだけで loopback 運用に復帰できます。

## リモート認証 (slice (b))

- 方式: 単一ユーザーパスワード + サーバー発行セッション Cookie
  (`companion_remote`: 不透明 256bit ランダム、`HttpOnly`・`Secure`・
  `SameSite=Strict`・`Path=/`)。tailnet ACL が第一層、アプリ層が第二層です。
- パスワード保管: scrypt ハッシュ (Node 標準 `crypto.scrypt`、追加の
  native 依存なし) を **SQLite 外**のファイルに保存します
  (secret-not-in-DB)。セッション側はトークンの SHA-256 ハッシュのみを
  SQLite (`remote_sessions`、additive migration `0023`) に保持します
  (トークン平文は DB・ログに残りません)。ログイン失敗カウンターと
  ロックアウトも SQLite (`remote_login_lockout`、additive migration
  `0024`) に永続化し、再起動 (auto-deploy を含む) で解除されません。
- 設定キー (`COMPANION_REMOTE_JSON` に追加、以下はすべて任意・既定あり):
  `passwordFile` (有効時は必須、絶対パス。0600 推奨・POSIX では
  group/other 読み取り可で起動拒否)、`absoluteTimeoutMs` (既定
  2592000000 = 30 日、案)、`idleTimeoutMs` (既定 604800000 = 7 日、案)、
  `maxFailures` (既定 5、案)、`lockoutMs` (既定 900000 = 15 分、案)。
  いずれも範囲外・型違いは固定メッセージで起動失敗します。
- 設定手順 (Linux):
  1. `COMPANION_REMOTE_JSON` に `enabled:true`・`allowedOrigins`・
     `passwordFile` (例: データ dir 配下の絶対パス) を設定
  2. `pnpm --filter server set-password` でパスワードを設定
     (TTY/stdin からエコーなしで二度読み、env/argv 経由は不可)
  3. `tailscale serve` で HTTPS 終端 + `127.0.0.1:<port>` へ proxy
  4. 起動・ログイン・会話一往復・SSE 受信・logout 後の再拒否を確認
- 適用範囲: **全 API + SSE はセッション必須** (401 JSON。SSE の
  ハンドシェイクも同様)。`/health/live` は無認証のままです。
  `/health/ready` は要セッションです (案 U3 の暫定確定。監視用途の
  例外が必要なら専用トークン方式で別途設計)。未認証の `/` は
  アセットなしの最小ログイン form (外部アセット・script なしの素の
  HTML form) を返します。
- ログイン失敗は一律 `invalid credentials` (user 枚举なし)。
  rate limiting は **IP 単位ではなく全体カウンタ** です
  (proxy 経由は全て 127.0.0.1 に見えるため。既定 5 回失敗で 15 分
  lock、案)。カウンタはメモリ保持のため **再起動でリセット**
  されます (SQLite 永続化は見送り: 単一運用者の box では再起動解除が
  安全側のため)。

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
profile (`suiso11/google-calendar-mcp` @ `cefb63c…`,
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

# PR29 Windows Stall Fix (2026-10-14)

PR-event CI run `38608822921` (head `b04970b`) failed ONLY Windows
`check` with 4 unit-test 5s timeouts (action composition ×1, action
history receipt ×1, action scheduler pickup ×2; zero assertion failures)
while Ubuntu/e2e and the same-head push run passed. Bounded fix, no
timeout change, no behavior change: the scheduler tests' engine-idle poll
now yields via `setImmediate` instead of wall-clock `setTimeout` sleeps,
and `vitest.config.ts` caps `maxWorkers: 2` on CI only. Detail:
`docs/operations.md` ("PR29 Windows stall fix").

Conflict-notice browser acceptance, 2026-10-14 (local, uncommitted):
 new permanent `citation_recovery.spec.ts` case drives a genuine stale PUT
 during the citation drawer action — the browser's first conditional PUT is
 held, a concurrent real same-citation selection commits version 1 → 2 via
 the Node-side API, and the held PUT is forwarded unchanged so the real
 server answers 409 `reference_version_conflict` (observed exactly once).
 The fixed notice becomes visible in `#composer-notice`, the client
 re-reads and recovers (exactly one PUT ever reaches the server; the
 re-read finds the citation already selected so no duplicate PUT follows),
 the saved citation still opens as escaped plain text, the latest context
 is exactly `[ref]` at version ≥ 2, `r1` renders once, and browser storage
  keeps only `ch.sessionId/ch.pendingKey/ch.cursor.*` with no snapshot text.
  No product source change was needed: the prior fix already shows the
  notice before the existing re-read/retry (no silent retry), confirmed by
  this behavior. Fixture fix in `e2e/server.ts`: `seed-citation` now mints
  one fresh resource per call (the shared-key form could seed only once per
  server lifetime via `UNIQUE(resource_id, revision)`, which blocked a
  second citation test in the same run). Verified once after edits with
  temp stores only: e2e `tsc -p apps/server/tsconfig.e2e.json` exit 0,
  real-browser `citation_recovery.spec.ts` **8/8 passed** (production UI
  build, temp SQLite/RunEngine, loopback; other suites not re-run). M3
  remains incomplete; Windows manual smoke and current remote CI for these
  edits are still open.

M3 §16 final matrix, 2026-10-14 (implementation-complete evidence, not a
release claim): every §16.1–16.8 clause has an exact source implementation
and **no implementation gap remains** (the two 10-14 wording fixes are
browser-proven; no new product fix was needed). Five deterministic unit
regressions were added to `apps/server/test/m3_ui.test.ts` only for
previously uncovered consumer edges (abandoned→failure+retry mapping,
heartbeat emission lifecycle, same-run multi-client identical bytes,
backpressure grace hold-then-close plus in-grace drain delivery; controlled
timers, no wallclock sleeps). CAS exhaustion and reference-context freezing
reuse existing kernel coverage. Verified once after final edits with temp
stores only: full Vitest **88 files / 1091 tests passed**, root + server +
e2e `tsc --noEmit` exit 0, owned-file Biome exit 0 (full-repo `pnpm lint`
is red solely on the preexisting untracked Playwright artifact
`apps/server/test-results/.last-run.json`, left untouched), and the FULL
configured real-browser suite (`apps/server/playwright.config.ts`)
**22/22 passed** (conversation 4, citation 8, sse_history 6, polling 4; zero
retries). Minor automated gaps remain: session_busy client-notice branch,
persistent CAS-race exhaustion, real-restart abandoned E2E, heartbeat
wallclock cadence. Still open as separate gates: current remote CI for these
uncommitted edits and Windows 11 manual smoke. M4/M5 clauses are excluded;
this is not an all-Companion-complete claim. Full clause matrix:
`docs/plan/execution_progress_2026-10-10.md`.

# PR31 Citation CI Race Fix (2026-10-15)

Push CI run `38716307351` (head `a77cd1e`) failed ONLY `e2e` with the
same 2 `citation_recovery.spec.ts` failures at `sessionIdOf (:42)`:
`typeof null === "object"` — `ch.sessionId` not yet written because
`beforeEach`'s composer-visible/enabled gate is already true in the
static HTML before async `ensureSession()` posts `/api/sessions`.
Same-head PR run `38716314333` passed (warm timing won the race).
Test-only sync fix, no product change: `sessionIdOf` waits for the
real session signal (`ch.sessionId` non-empty) before asserting.
Local proof: 2/2 affected browser cases pass; `biome check` clean.
Detail: `docs/operations.md` ("PR31 citation CI race fix").

Memory management (explicit search/correct/retire/reactivate),
2026-10-15 (local, temp stores only): native `memory.search` returns
opaque session `mN` handles for active AND retired records and never
heats/reactivates/grants; the confirm UI shows the live current record
against the immutable citation snapshot before staging; `correct`
stages a REAL source `event.append` + `record.correct` durable chain
(stable idempotency key, same key+body replays the stored operation,
key+drifted body is 409); `retire`/`reactivate` are reversible, never
deletion/hiding (retired stays searchable, excluded only from CLI
recall). UI races closed synchronously (search/target invalidation +
generation guards, new-operation pending reset + poll identity, no
stale ack reuse). Runnable: `pnpm exec vitest run
apps/server/test/memory_manage.test.ts`, `pnpm --filter
@companion/server exec vitest run test/memory_manage_live.test.ts`
(real HTTP + synthetic gateway, NOT a real model, + REAL remind CLI
temp DB), `COMPANION_E2E_MEMORY=1 pnpm --filter @companion/server exec
playwright test --config playwright.config.ts` (real browser memory
panel vs REAL app/CLI temp DB). Verified: full Vitest **113 files /
1370 tests passed**, browser GREEN, live GREEN, root + e2e `tsc`
exit 0, lint GREEN. Limits: synthetic gateway only; Windows manual
smoke and current remote CI remain open. Full contract:
`docs/operations.md` ("Conversation memory").

PR34 review fixes (10 inline threads on `215f852`, local, temp stores
only): atomic ack+operation mirror, run-specific recall citation
endpoint + run-bound `mN` drawer, immutable-hash draining replay 409,
pending-remaining bounded poll (never false-failed), terminal failure
requires a fresh action/key (no same-key retry), correction draft bound
to the exact `(searchId, handle)` and cleared on target change,
search-header owner identity collision refusal, per-tool input schemas
(`correct` requires body, others forbid it), code-point bounds on
requests/responses, and 503-retryable/404-disabled memory errors.
Verified after edits: affected unit `memory_manage.test.ts` **23/23
passed**, real-browser `memory_manage.spec.ts` **2/2 passed**
(production UI build, temp SQLite/RunEngine, loopback), root + server +
e2e `tsc --noEmit` exit 0, Biome on changed files clean. Full unit
(113 files/1370) + live HTTP/REAL CLI already green per oc-19 and not
re-run (no production change since). Remote CI for the fix commit is
pending at push time — see PR body.

AV autonomy foundation (AV01/AV03/local+global stop, 2026-10-16):
session-owned purposes (create/correct preserving kind/scope/
interpretation/window with the original kept superseded, revoke/achieve,
explicit pair conflicts only) + explicit tasks (standalone/attached,
start/hold/resume-with-evidence + explicit replacement parent only,
complete/cancel, parent transitions hold dependents, blind resume 409s,
permission purposes are claims granting nothing) + durable global stop
control (CAS, defaults paused, restart fence re-pauses with version+1).
Verified: permanent real-browser `autonomy.spec.ts` **4/4 passed**
(fresh bundle, real HTTP), full default e2e **28 passed**,
`autonomy_http` 3/3 + `autonomy_slice` 11/11, Biome clean, root `tsc`
0 non-environment errors. Remaining NOT claimed: AV02 shadow, AV04
learning, AV05 notification, AV06 priority, AV07 supervisor/reconcile,
AV08 maintenance/handoff. Full contract: `docs/operations.md`
("AV autonomy foundation").

AV02 shadow-deliberation full vertical (2026-10-17): durable shadow
queue (persistent requests, input-complete fences, foreground/STOP/
restart preservation with no catchup/replay) + model-gated deliberation
(one bounded `autonomy_deliberation.submit` call over FROZEN context;
memory is untrusted evidence; CODE `missing_grant` never executes,
claim != grant) + read-only HTTP (purpose/task list/open without
Markdown/memory connectors) + `ShadowPanel` UI (latest-intent list/
detail, stable retry, inert `textContent`, composer preserved).
Verified: full unit **136 files / 1557 passed** (8 skipped, real remind
CLI, LLM/vectors disabled), full default browser **32 passed** (28 +
new shadow 4), prior production smoke 17/17 real HTTP loopback with a
configured synthetic provider (NOT a real model), root + e2e `tsc`
exit 0, root Biome exit 0. Remaining NOT claimed: AV05 notifications,
AV06 shared resources, AV07 external supervisor/recovery, AV04 methods
learning, AV03 conversation task-proposals + actual pi-orch handoff,
AV08 maintenance, unresolved device/standing/external rollout. No real
model, GPU performance, Google writes, OAuth, user DB, or grants
claimed. Full contract: `docs/operations.md` ("AV02 FULL VERTICAL").

---

# Citation drawer last-intent guard (2026-10-16)

Shared rN (stored-only) + mN (originating-run-bound) drawer raced: an
older delayed response overwrote the newer body, reopened the drawer
after close, or latched a stale memory error/disabled flag. Fix: ONE
shared monotonic intent token (`citationDrawerSeq`) bumped
synchronously on every open/close with the session frozen per open;
every await guarded before UI state, errors, `memoryDisabled`, further
requests, and CAS retries. No new APIs/DB columns/deps/retries; rN
stays stored-only, mN stays run-bound, committed context PUTs are never
rolled back.

- **Changed**: `apps/server/src/ui/client.ts` (guard),
  `apps/server/e2e/citation_recovery.spec.ts` (3 deterministic race
  regressions), `apps/server/e2e/server.ts` + `ports.ts` (fixtures).
- **Failing-before** (pre-fix client, same tests/fixtures): **3/3 fail**.
- **Passing-after** (real Chromium, temp stores): full
  `citation_recovery.spec.ts` **13/13 passed**; units **120 files /
  1458 passed** (2 known missing-remind live files excluded, not
  re-run); root + e2e typecheck exit 0; `pnpm lint` exit 0 (2
  pre-existing infos with clean-HEAD evidence).
- Cross-source note: the mN race uses the genuine 404 of the real
  recall route (fixture harness has no memory backend) — async ordering
  proof only, no real remind CLI dataset claimed. Full contract:
  `docs/operations.md` ("Citation drawer last-intent guard").

---

# AV Autonomy Base (base-only, 2026-10-16, branch `feat/av-autonomy-continuation`)

Session-owned durable purposes + explicit local tasks + a durable global
stop control (schema 11). Recorded `permission` rows are claims only: no
route creates a grant, capability write, or external action. Tasks are
local entities only (never calendar events, never external execution).
Normal chat stays accepted while paused; the restart fence re-pauses an
unpaused control on every start (version advance + `restart_fence` /
`interrupted_note` rows). Purpose corrections append a NEW record and
CAS-supersede exactly the referenced old record (original text preserved);
conflicts are explicit owner-recorded pairs only (never prose similarity).
Revoked/achieved/superseded parents atomically hold dependent
non-terminal tasks; resume needs explicit state-change evidence (closed
kind enum, no timer member) plus a NEW active same-scope parent when the
recorded parent is non-active. Histories are immutable append-only rows,
paged losslessly (`afterSeq` cursor, `limit` default 50 / max 200,
`nextAfterSeq: number | null`); correction idempotency distinguishes
omitted (preserve) from explicit-null (clear) bounds per field via
presence flags (same key + changed command is a key-reuse conflict;
exact terminal replay stays verbatim after later state changes).
Use: autonomy panel in the web UI (plain DOM, no model) + the
`/api/sessions/:id/purposes|tasks|purpose-conflicts` and
`/api/autonomy/control|activity` routes (strict bodies, UUID ids,
`Idempotency-Key` on mutations, ownership-first 404s, CAS 409s).
Verified (temp stores only, throwaways removed): contracts/kernel/server/
root/e2e `tsc --noEmit` exit 0 (frozen offline relink restored the exact
`@types/better-sqlite3` links; no suppressions); focused Vitest **21/21**
(slice 15 incl. omission-vs-null both directions/bounds + terminal replay
+ 201-event lossless paging, migration-10 3, HTTP 3 incl. 201-event paging
+ invalid-query 400s); temp app-request smoke
(`sessionCreate:201, purposeCreate:[201,custom-scope], correction:[201,
old:(created,superseded),cursor:null,tail:(superseded)],
hold:[200,reason,trigger], resumeGate:[409-blind,200-new-parent],
controlChat:[paused:true,chat:202,reopen:false,restop:true],
zeroWrites:[proposals:0]`); real-Chromium `e2e/autonomy.spec.ts` **2/2**
(base lifecycle + 201-event Load more, production UI build, temp DB).
Limits (base-only): NO v12 executions / pi bridge; histories cap at 200
rows per page (cursor needed past that); purposes/tasks list caps stay
100; stop control gates only NEW autonomous background work (normal chat
and dispatched M5 writes never gated). Prior pin7b40/M6 fixes and the
historical47/421 records above are untouched.

---

# AGORA レビュー UI (browser, session-owned proposals)

チャット画面下部の「AGORA レビュー」パネルは、現在のセッションの提案だけを
`GET /api/sessions/:sessionId/agora/proposals` から表示します。AGORA 未設定
(404) ではパネルを非表示にします。パネルの JS はセッションが存在するときだけ
遅延読み込みし、読み込み失敗時は再読み込みを促すメッセージを表示します。
run 完了時に自動更新し、明示的な「更新」でも再取得します。

1. 宛先・タイトル / 本文 / スレッド ID・`payloadHash`・状態・期限・結果を確認する。
2. 「承認」または「却下」を明示的にクリックする (`{ "payloadHash": "..." }`)。
   承認だけでは送信されません。**承認と送信は別操作**です。
3. 承認済みで期限内の提案だけ「送信」をクリックする
   (`{ "payloadHash": "..." }`)。browser からの承認は人間の Send だけを
   許可し、モデルはその承認を先取りして送信できません。送信は自動化されません。
4. 429 は再送までの秒数を表示し、手動でのみ再送します。409 は一覧を再取得し、
   最新の内容であらためて操作します。通信失敗時も状態を再取得し、自動再送は
   しません。`unknown` は自動 retry しません。
5. 提案本文は untrusted のためテキストとしてのみ描画し、結果リンクは
   バックエンド検証済みの同一 origin `/t/<id>` だけを開きます。
   browser から AGORA へ直接書き込みません。

デプロイは operator が repo checkout から
`scripts/deploy/install-agora-review.sh --check` →
`scripts/deploy/install-agora-review.sh --apply` を実行します。UI profile は
reasoning 用 env を変更せず、AGORA の既存 private store だけを確認します。
patch は package manifest を変更しないため再 install は不要です。適用後は
通常の `companion.service` restart だけで、専用 CLI は不要です。source rollback
は code/docs のみで、AGORA DB は自動 restore しません。詳細は
`docs/operations.md` の「AGORA レビュー (browser, local only)」を参照。
