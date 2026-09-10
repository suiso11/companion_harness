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

事前に、

```text
upstream tool name
+
input schema hash
```

を登録します。

```text
MCP tools/list
      │
      ▼
Name matches?
      │
      ▼
Schema hash matches?
      │
   ┌──┴──┐
  YES    NO
   │      │
 enable disable
```

MCP server が更新されて Tool schema が変化した場合も、自動で新しい能力をモデルへ公開しません。

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
```

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
attendees
organizer
conference data
meeting URL
HTML link
raw payload
```

等は Snapshot から除外する設計です。

Model-facing tool は最小限にし、

```text
calendar.search
```

だけを公開する方向で設計しています。

現時点では Calendar MCP の upstream binding は正式採用前であり、M4 は foundation / design 段階です。

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
