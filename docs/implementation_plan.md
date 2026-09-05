# Companion Harness 実装計画

> **文書の位置づけ（必読）**
> - 本書は正規の実装計画（`companion_harness/docs/implementation_plan.md`）である。本書は **計画のみであり（planning-only）**、実装・テスト・リリースはまだ行われていない。本書の存在はいかなる実装成果も主張しない。
> - 合意済み決定（「合意」ラベル）と未解決事項（「未解決」ラベル / §20）を明確に分離する。未解決事項を本書内で勝手に確定させない。
> - 計画上の名称は確定: プロダクト名は **Companion Harness**、リポジトリ名は **companion_harness** とする（合意）。§20 に名称の未解決事項は残さない。

---

## 目次

1. [プロダクト定義](#1-プロダクト定義)
2. [設計原則](#2-設計原則)
3. [アーキテクチャ（合意）](#3-アーキテクチャ合意)
4. [参照同一性モデル（合意）](#4-参照同一性モデル合意)
5. [UX 原則（合意）](#5-ux-原則合意)
6. [リポジトリ構成（合意）](#6-リポジトリ構成合意)
7. [技術スタック（合意）](#7-技術スタック合意)
8. [ロードマップと非目標（合意）](#8-ロードマップと非目標合意)
9. [M0 ブロッカー決定（合意）](#9-m0-ブロッカー決定合意)
10. [M0 データモデル（提案）](#10-m0-データモデル提案)
11. [状態遷移とトランザクション（合意＋提案）](#11-状態遷移とトランザクション合意提案)
12. [API 設計（合意＋提案）](#12-api-設計合意提案)
13. [M0 実施計画：マイルストーン・PR・テスト](#13-m0-実施計画マイルストーンprテスト)
14. [M1 Reference Plan（合意）](#14-m1-reference-plan合意)
15. [M2 Agent Plan（合意）](#15-m2-agent-plan合意)
16. [M3 Conversation UI + SSE Plan（合意）](#16-m3-conversation-ui--sse-plan合意)
17. [M4 MCP Client + Calendar Plan（合意）](#17-m4-mcp-client--calendar-plan合意)
18. [M5 Action Plan（合意）](#18-m5-action-plan合意)
19. [クロスカット運用・リリース計画（合意）](#19-クロスカット運用リリース計画合意)
20. [未解決事項一覧](#20-未解決事項一覧)
21. [OpenClaw との関係](#21-openclaw-との関係)

---

## 1. プロダクト定義

**合意**

- Companion Harness は **ローカル LLM 対話型リファレンスハーネス** である。ユーザーのローカル環境で動作し、外部サービス（カレンダー等）を対話的に参照しながら作業を支援する。
- **外部サービスは常に source of truth** である。ハーネスは外部データのコピーを正とみなさず、参照は常にスナップショットという「取得時点の証拠」として扱う。ハーネスが独自に外部データを「修正して同期」することはしない（v0.1 では読み取り専用）。
- **Conversation First**。すべての機能は会話を起点として設計する。ツール実行・参照・エージェント動作は会話の中に埋め込まれ、会話の文脈を壊さない。
- Companion Harness は既存システムの改修ではなく、**独立した新しいリポジトリ `companion_harness`** として作る。

**名称（合意）**

- プロダクトの計画名は **Companion Harness**、リポジトリの計画名は **companion_harness** で確定とする。以後の実装 spike（§20）は命名ではなく技術確認のみを扱う。

---

## 2. 設計原則

**合意**

1. 会話が主、機構は従。内部機構（Turn/Run/Tool）はユーザーに露出しない。
2. 参照は不変スナップショット。外の世界が変わっても、会話中の参照は取得時点の事実を保持する。
3. 生成はライフサイクルを持つ状態機械であり、再起動・キャンセル・失敗に耐える（durable）。
4. モデルが呼ぶ能力は必ずポリシーパイプラインを通る。モデルに直接ネットワーク・ファイル系 API を与えない。
5. 同一セッション内の実行は直列、異なるセッションは並行可能。
6. 副作用を伴う行為（書き込み系アクション）は明示的な承認フローを要求する（v0.2〜）。

---

## 3. アーキテクチャ（合意）

**合意**

- **RunEngine がライフサイクルを所有する。** Run の生成・状態遷移・キャンセル・リカバリ・完了処理はすべて RunEngine の責務。エージェントやツールは RunEngine から駆動される。
- **Agent は RunStrategy である。** 「どう実行するか」の戦略に過ぎず、Run の所有権を持たない。Agent 実装を差し替えても RunEngine・データモデル・API は不変。
- **モデル起因の能力呼び出しは ToolBroker のポリシーパイプラインを通る。** ToolBroker が許可・レート・監査・結果の正規化を担う。モデルが ToolBroker をバイパスする経路は存在しない。
- **ReferenceManager が参照の同一性を所有する。** CanonicalResource / ResourceSnapshot / SessionReference の解決・登録・rN 採番はここに集約する。
  - **注記: ReferenceManager は将来アーキテクチャであり、M0 では実装しない。** M0 の kernel は **RunEngine / ToolBroker / storage（SQLite 永続化）のみ** を含む。ReferenceManager の本格実装は M1 で追加する（§14）。
- **channels / triggers / tools / delivery は相互に独立した関心事として分離する。** 入力経路（channel）、実行の発火契機（trigger）、能力（tool）、結果のユーザーへの届け方（delivery）を混在させない。
- **Hono サーバーは composition root である。** 依存の組み立て・HTTP アダプタ・イベント API の公開は Hono サーバー層で行い、ドメイン層（kernel）は HTTP を知らない。

```
UI / Channel ──> Hono server (composition root)
                    │
                    ├──> RunEngine ──(RunStrategy)──> Agent
                    │        │
                    │        ├──> ToolBroker (policy pipeline) ──> tools
                    │        └──> ReferenceManager（※ M1 で追加。M0 には存在しない）
                    │
                    └──> SQLite (WAL) : durable queue / events / idempotency

※ M0 kernel = RunEngine / ToolBroker / storage のみ。ReferenceManager は M1 で kernel に追加する。
```

---

## 4. 参照同一性モデル（合意）

**合意**

参照は 3 層で同一性を表現する:

```
CanonicalResource        ResourceSnapshot (immutable)      SessionReference
「カレンダー上の予定 X」 ──> 取得時点の不変の正規化エビデンス ──> セッション内での参照番号 rN
（外部の正）                （モデルが参照するために正規化した証拠。生の外部データの完全コピーではない。
                              同じ canonical の別時点は別 snapshot）   （会話・引用は必ず rN 経由）
```

- **同一セッション + 同一スナップショットを再参照した場合は同じ rN を再利用する。** 重複した参照番号は発番しない。
- **ResourceObservation は ephemeral（一時的観測事実）である。** 外部読み取りの前に存在する一時的な観測であり、永続化されたエビデンスではない。normal freshness では既存 Snapshot を再利用しうる（常に新規作成しない）。
- **検索ヒットは Snapshot を作らないという主張はしない（false claim を除去）。** `markdown.search` の各ヒットは外部ファイルを読み、正規化した全文テキストの不変 Snapshot を materialize（存在すれば再利用）し、永続化して rN を返す。同一 revision / 同一内容の normal 再検索は最新の Snapshot と同一セッションの同一 rN を再利用し、内容変化時は新しい Snapshot + 新しい rN を作る。
- **`kernel reference.refresh` は参照済み rN の再読み取りを行う唯一の経路であり、内容不変でも常に新しい観測 Snapshot + 新しい rN を作る。** `kernel reference.open` は保存済み Snapshot のみを開く stored-only であり、外部を再読しない。
- **revision 採番は `resources.next_revision`（INTEGER のトランザクション allocator）で行う。** Snapshot は整数 `revision` と `source_revision` / `content_hash` を持つ。外部読み取りはトランザクションの外で行い、短い DB トランザクション内で revision を recheck して採番する。**`UNIQUE (resource_id, content_hash)` は作らない**（同一内容の複数 Snapshot は正当に存在する）。
- **永続化は running CAS と原子的に行う。** 外部読み取り → 短い DB トランザクションで `status='running'` の再確認 + `resources` / `snapshots` / `session refs` / `reference set` / `reference.presented` を原子的に commit する。cancel 後（`cancel_requested` / terminal 確定後）に到着した観測は破棄し永続化しない。
- ResourceSnapshot は一度作成したら決して書き換えない（immutable）。差分は「新しいスナップショットの追加」で表現する。
- ResourceSnapshot は **正規化された全文テキストの不変エビデンス** を保持する。生の外部データの完全コピーという主張はしないが、モデル参照に必要な全文正規化テキストは保持する。保存形式・境界値は §14（M1 Reference Plan）で具体化した。保持期間は §19 で合意済み（M5 まで自動 retention / GC なし・無期限保持）。

**未解決**

- なし。容量・境界値（vault あたり対象ファイル数・ファイルサイズ・クエリ長・結果件数・snippet 長）は §14.6 で合意済み。保存形式は §14 で、保持期間（無期限保持・自動 retention / GC なし）は §19 で **合意済み**。

---

## 5. UX 原則（合意）

**合意**

ユーザーに見える通常アクションは次の 5 種のみ（v0.1〜v0.2 の順に導入。5 番目は M5 で条件付き）:

| 可視アクション | 導入 |
| --- | --- |
| メッセージ送信 | v0.1 (M0〜) |
| 引用を開く（rN → スナップショット表示） | v0.1 |
| 生成の停止 | v0.1 |
| 失敗時のみの再試行（failure-only Retry。「もう一度生成」） | v0.1 |
| 書き込み系アクションの承認 / 拒否 | v0.2 (M5〜・pending かつ有効期限内の Proposal があるときのみ条件付き表示) |

- **Turn / Run / Tool は内部概念であり、UI には露出しない。** 「生成中」「停止しました」といった表現に写像され、状態機械の語彙はユーザーに見せない。
- 再試行（Retry）は UI 上は「もう一度生成」であり、内部では同一 Turn への新しい Run として扱う。

---

## 6. リポジトリ構成（合意）

**合意**

- 新規独立リポジトリ `companion_harness` を作成する。
- **pnpm workspace モノレポ** を採用する。polyrepo（リポジトリ分割）もマイクロサービス化も **採用しない**。単一プロセスのローカルアプリであり、境界はパッケージで担保する。
- **M0 で実装するのは次の 3 パッケージのみ:**

```
companion_harness/
  apps/server/          # Hono サーバー（composition root）
  packages/contracts/   # Zod スキーマ・型・API 契約
  packages/kernel/      # M0: RunEngine / ToolBroker / storage ドメイン（ReferenceManager は M1 で追加）
    migrations/         # コミット済み生成 SQL マイグレーション（§9 ブロッカー 7）
```

- UI（M3）、MCP 連携（M4）用の追加パッケージは M0 では作らない。

---

## 7. 技術スタック（合意）

**合意**

| 領域 | 選定 |
| --- | --- |
| ランタイム | Node.js 24 LTS（exact `24.x.y` を M0.0 spike で選定し `engines` + CI マトリクスに固定。§13.1・§19.6・§19.7） |
| HTTP フレームワーク | Hono |
| 言語 | TypeScript（strict） |
| スキーマ検証 | Zod |
| DB | SQLite（WAL モード） |
| ORM / クエリ | Drizzle |
| SQLite ドライバ | better-sqlite3（**M0 spike で確認**） |
| ID 採番 | UUID v4（Node.js `crypto.randomUUID()`。§9 ブロッカー 7） |
| テスト | Vitest |
| Lint / Format | Biome |
| パッケージマネージャ | pnpm（exact バージョンを M0.0 spike で選定し `packageManager` に固定。§19.6） |
| MCP クライアント依存 | **M4 で確定版を選定**（M0 では導入しない） |

- better-sqlite3 はネイティブモジュールのため、Node 24 でのビルド・プリビルドバイナリ提供を M0 冒頭の spike で確認する。失敗した場合の代替（node:sqlite 等）は spike 結果で判断する。

---

## 8. ロードマップと非目標（合意）

**合意**

- **v0.1 = M0〜M4：読み取り専用。** 参照・会話・生成はできるが、外部サービスへの書き込みは一切ない。
- **v0.2 = M5：アクション + 承認。** 書き込み系ツールが承認フロー付きで導入される。

| マイルストーン | 内容（概要） |
| --- | --- |
| M0 | 基盤: RunEngine, durable queue, Turn/Run モデル, メッセージ/履歴/停止 API |
| M1 | 参照 + Markdown（ReferenceManager 本格化） |
| M2 | モデル/エージェント接続 + 引用 |
| M3 | UI + SSE |
| M4 | MCP クライアント + Calendar 参照 |
| M5 | アクション + 承認フロー |

**非目標（explicit non-goals）**

- マルチユーザー対応・リモートアクセス・認証（v0.x ではローカル専用）。
- 外部サービスへの書き込み同期（v0.1 は読み取り専用、M5 以降も「承認付きアクション」であり双方向同期ではない）。
- ベクトル DB / RAG / 長期記憶の自動構築。
- 分散実行・マルチプロセス。単一プロセス + SQLite を前提とする。
- LLM ベンダー固有の最適化（ローカル LLM は抽象層越しに差し替え可能に保つ）。

---

## 9. M0 ブロッカー決定（合意）

以下はチャットで合意済みの 7 大ブロッカーの決定である。

### ブロッカー 1: durable queue と再起動・キャンセルの意味論

- 実行待ち・実行中は **SQLite 上の durable queue** で管理する（メモリ専用キューにしない）。
- プロセス再起動時の扱い:
  - `queued` の Run → **requeue**（再び queued に戻し実行を再開）。
  - `running` だった Run → **abandoned** に遷移（自動再実行はしない）。
  - `cancel_requested` だった Run → **cancelled** に確定。
- **active の一意性は `cancel_requested` を含む**（下書き状態も active とみなす）。
- **同一セッションの active Run は常に 1 つ。** 異なるセッション間は並行実行してよい。

### ブロッカー 2: Turn/Run データモデル（messages テーブルを作らない）

- **M0 に `messages` テーブルは存在しない。**
- **不変の Turn** がバージョン化された入力 union **`input_json`（TEXT NOT NULL CHECK json_valid。非定型の `user_input` 列は持たない）** と、その時点で凍結された UI コンテキスト（frozen UI context）を保持する。frozen UI context には **temporal context（now / timeZone）** を含める（M4 の Calendar 参照契約、§17.4）。Turn は不変であり、Retry（同一 Turn への新 Run）でも temporal context は再計算・書き換えされない。
  - **`input_json` はバージョン化された TurnInput union（合意）:** `{ kind: 'user_text', version: 1, text }` を M0 の唯一の variant とする。M5 で `action_approval` / `action_rejection` variant を追加する（§18.4）。DB の CHECK は `json_valid` のみであり、kind/ version の閉集合は **contracts の schemaVersion 別 Zod レジストリ** で強制する（DB に kind の閉集合 CHECK は作らない）。
- **バージョン化されたアシスタント結果は Run に属する。** Run が「1 回の生成試行」の結果を持つ。
- **Retry は同一 Turn に新しい Run を追加する。** Turn は書き換えない。
- **`turn_selections` が completed Run を選択する。** ユーザーが「採用」した Run がその Turn の公式応答になる。
  - **選択の正確な定義（合意）:**
    - 初回メッセージで作成される Run と Retry で作成される Run は、いずれも `select_on_success=true` をデフォルトとする。
    - 完了 commit（status='running' → completed の CAS 受理）の際、`select_on_success=true` なら **同一トランザクション内でその Run を `turn_selections` に upsert し、その Turn の唯一の選択とする**。
    - failed / cancelled / abandoned への遷移は **選択を一切変更しない**。
    - `select_on_success=false` の Run が完了しても **現在の選択はそのまま残る**。
    - **M0 は手動の Run 選択 UI / API を提供しない**（選択は select_on_success による自動 upsert のみ）。
- **履歴は「Turn + 選択された Run」のみを投影する。** 未選択・失敗・破棄された Run はデフォルトでは履歴に現れない。

### ブロッカー 3: 状態遷移とトランザクション整合性

- **すべての状態遷移は CAS（Compare-And-Swap）SQL で行う。** `UPDATE ... WHERE id = ? AND status = <期待値>` 形式で、競合下でも遷移は最大 1 回しか成功しない。
- **状態変更 + イベント追記は同一トランザクションで実行する。** 状態だけ変わりイベントが欠けることはない。
- **外部呼び出し（LLM API・ツール実行）はトランザクションの外で行う。** トランザクション内で外部 I/O を待たない。
- **キャンセルは DB コミットを先行させ、その後に AbortSignal を発火する。**（DB 側の確定が遅れて signal が先に飛ぶ順序は禁止）
- **Cancel-first が常に優先される。** 完了の commit は **status='running' の場合のみ** 受理する。`cancel_requested` 後の 3000ms 猶予（grace）内に返された結果は **破棄** され、Run は **completed ではなく cancelled** になる。
- **キャンセルの確定は「通常時の watchdog」と「graceful shutdown」で意味論を区別する（合意）:**
  - **通常時:** watchdog が `cancel_requested` を監視し、**grace は最大 3000ms で、watchdog が 3000ms 以内に `cancelled` へ確定**させる。
  - **graceful shutdown（drain）:** 通常時の Cancel とは **別の意味論**（§11.5・§19.4）。受付（Message / Retry / v0.2 からは Approve）を拒否し pickup を停止、**最大 10 秒の自然完了待機**のうえ、残余の running は **`abandoned` に**、`cancel_requested` は **`cancelled` に** Abort 前に CAS + RunEvent で確定する。**3000ms grace は通常時の Cancel 専用であり、drain では使わない。**
  - **`cancel_requested` のまま残るのは急激な終了（abrupt termination）の場合のみ**であり、その場合は **起動時 recovery が `cancelled` に確定**する。
- **grace 後の遅延出力・非協力的な出力は commit を禁止する。** 状態が terminal の Run に対する後からの完了書き込みは失敗する（CAS が保証）。
- **遅延して到着したツール結果は、`reported_outcome` と `result_disposition='discarded'` を分離した形で監査記録しうる**（実行には使われないが、監査のため痕跡は残す）。**terminal 後の監査のみの handler 完了は、RunEvent を生成せず `tool_calls` 行の事後更新のみで記録してよい**（audit-only）。terminal RunEvent の **後** に RunEvent を追記してはならない。
- **terminal イベントが最終的な真実（final）である。** terminal 以降に古い出力が状態を書き換えることはない。

### ブロッカー 4: API・冪等性・イベント配信

- **Session 初期化は `POST /api/sessions` で行う（合意）。** **検証済み `Idempotency-Key` を必須** とし、scope は `sessions:create`。API エラーは §12.3 の固定小文字コードで返す。これによりセッション生成手順が定義される。
- UI は **`POST /api/sessions/:sessionId/messages`** でメッセージを送る。
- Run 系ルートは **Session スコープ** で提供する（`/api/sessions/:sessionId/runs/...`）。
- **Message と Retry は検証済み `Idempotency-Key` を必須** とし、`api_idempotency` テーブルに scope / key / リクエストハッシュ / 保存済みレスポンスを永続化する。scope は **親リソースを区別する**: セッション作成は `sessions:create`、メッセージは `session:{sessionId}:message`、Retry は `turn:{turnId}:retry`。
  - 同一 key + **同一の正規化リクエスト** → **保存済みの HTTP ステータスとボディをそのまま再生（replay）** する（元が 202 なら 202 のまま。200 に書き換えない）。
  - 同一 key + **異なるリクエスト** → **409 Conflict** を返す。
- **冪等処理は原子的トランザクションで行う（合意）:**
  1. トランザクションの外で **検証 → リクエスト正規化 → `request_hash` 計算** を完了させる。
  2. `BEGIN IMMEDIATE` のうえ `(scope, key)` を lookup する。
  3. **同一 hash** → 保存済みの **元の HTTP ステータス・ボディをそのまま replay** する。
  4. **異なる hash** → 409 Conflict。
  5. **key が不在** → Turn / Run / run_event の作成と **レスポンスの保存を同一トランザクション内で行い** commit する。
  6. **永続化するのはドメイントランザクションで受理された成功レスポンス（accepted 2xx）のみ** である。validation 失敗・競合（409 `idempotency_key_reused` / 409 `session_busy`）・ロールバック・内部エラーのレスポンスは **永続化しない**（replay 対象にならない）。
  7. **「processing」中間状態は持たない。** Run 実行は外部（非同期）であり、レスポンス保存時点でリクエスト処理は完了しているため。
- **Retry は Turn スコープであり、その Turn が当該 Session に属し、かつその Session に active Run が存在しない限り、**過去 Run の terminal 状態（completed / failed / cancelled / abandoned）にかかわらず常に許可される**（合意）。
- **Cancel はキーレスで state-idempotent**（何度呼んでも安全。すでに terminal なら現在状態をそのまま返す）。
- **イベントカーソル契約（合意）:**
  - `runs.event_seq` は **最後に発番した seq** を保持し、**0 で初期化**する。
  - イベント追記は **`event_seq` を原子的に N へインクリメントし、その同一トランザクションで `(run_id, N)` を INSERT する**。
  - `after` は **排他的**（`seq > after` のみ返す）。
  - `nextAfter` は **返却イベントの最大 seq**。**返却イベントが 0 件の場合はリクエストの `after` をそのまま返す**（変化させない）。
  - `terminal` は **Run の status から導出**する（イベント列の有無から推測しない）。
- **M0 のイベント API はページネーション付き JSON**。`after` / `limit` は **Run 内の `seq`** を使う（グローバル ID ではない）。応答は `nextAfter`、`terminal`、`hasMore` を返す。**SSE は M3 に先送り**（SSE の契約自体は §9 ブロッカー 5 で合意済み）。

### ブロッカー 5: RunEvent / SSE 契約（合意）

- **RunEvent は型付き durable journal であり、event sourcing ではない。** 状態の真実は `runs` の行（status / result_json）であり、RunEvent は「何が起きたか」の監査可能な記録である。
- **エンベロープ（合意）:** `schemaVersion` / `runId` / `seq` / `type` / `createdAt` / `payload`。`seq` は per-run 連番で、採番源は **`runs.event_seq`**（§9 ブロッカー 4、§10）。
- **M0 のイベント型は型付き run/tool イベントのみ**: `run.queued` / `run.started` / `run.cancel_requested` / `run.completed` / `run.failed` / `run.cancelled` / `run.abandoned`、および `tool.requested` / `tool.completed`。Run 生成時に発行するのは `run.queued` である（`run.created` という型は存在しない）。**閉集合は DB CHECK ではなく schemaVersion 別 Zod レジストリで強制する（§10）。**
- **`run.completed` は正規化・検証済みの RunResult を payload に含む応答の唯一のイベントである。** `answer.committed` / `assistant.delta` は v0.1 には存在しない。
- **terminal イベントは各 Run に正確に 1 つ**（`run.completed` / `run.failed` / `run.cancelled` / `run.abandoned` のいずれか 1 つ）であり、**最終（final）** である。terminal RunEvent の後に RunEvent は追記しない（terminal 以降のイベントは禁止）。遅延して到着した監査は RunEvent にはせず、`tool_calls` 側（ブロッカー 6）に記録する。
- **M0 は JSON ページネーション契約**（`after` / `limit`、§12）。**カーソル意味論（合意）:**
  - `after` は **排他的**（`seq > after` のみ返す）。
  - `nextAfter` は **返却イベントの最大 seq**。**0 件返却時はリクエストの `after` をそのまま返す（不変）**。
  - 応答は `terminal` に加え **`hasMore`**（`seq > after` の未返却イベントが残っているか）を返す。
- **M3 の SSE は JSON API とは別ストリームで、同一 DTO と同一 seq ID を使う。** DB カーソルによる tail / replay、heartbeat、バックプレッシャー、複数クライアント接続をサポートする。**クライアント切断は Run をキャンセルしない。** SSE は **Run が terminal かつクライアントのカーソルが `runs.event_seq` に到達（>=）したときにのみ閉じる**。**v0.1 は RunEvent の retention を持たない**（全履歴は DB に残す）。
- **将来の拡張イベントは非 final としてのみ計画する:** M1 の `reference.presented`（§14.4）、M2 のモデルイベント（§15）。v0.1 のイベント契約には含めない。

### ブロッカー 6: ToolBroker / Budget / Dedup 契約（合意）

- **ToolBroker がモデル起因ツール呼び出しの唯一の境界。** `ToolDescriptor` は **contracts パッケージにシリアライズ可能な定義**として置き、**実行時の Zod スキーマとハンドラは kernel 側で登録**する。
- ツール名は **`namespace.verb` 形式**。M0 は **静的レジストリ**（動的登録なし）。
- **呼び出しコンテキストは `origin` / `caller` / `allowedTools` / `AbortSignal` を含む。**
- **ToolResult とエラーコードは型付き固定コード**（§12.3 と同様の小文字固定コード方針）。ポリシーパイプラインの **ステップ適用順序は固定**する（**予算予約 → 分類 → descriptor / 入力検証 → dedup → 実行 → 正規化/検証 → 監査**）。**ToolBroker に到達したすべての論理リクエスト（unknown / denied / invalid / dedup 対象を含む）は、descriptor 解決・ポリシー分類・入力検証・dedup 判定に先立って原子的な予算予約を試みる。予算超過は即座に拒否する。**
- **v0.1 ポリシー（合意）:** 読み取り系 tool は許可、**書き込み系 / 機微（sensitive）/ リスク未分類・未知の tool は拒否**（default-deny）。
- **デフォルト予算（合意）:**

| 予算 | 値 |
| --- | --- |
| per-run tool リクエスト | 8 |
| per-run 同時実行 | 3 |
| プロセス全体の同時実行 | 8 |
| 1 呼び出しの入力サイズ | 32KiB |
| 正規化済み出力（1 呼び出し） | 256KiB |
| モデル向け出力（1 呼び出し） | 64KiB |
| モデル向け出力（1 Run 累計） | 128KiB |
| 1 呼び出しの観測（observations） | 20 |
| 1 Run の観測累計 | 50 |
| デフォルトタイムアウト | 15 秒 |
| 最大タイムアウト | 60 秒 |

- **unknown / denied / invalid / dedup 対象・タイムアウト・キャンセルのリクエストも予算を消費する。** `runs.tool_requests_used` は **パイプラインの最初のステップとして原子的予約（CAS）** され（descriptor lookup / policy 分類 / input 検証 / dedup 判定より先に行う）、予算超過は即座に拒否される。**in-flight coalescing は作業を共有するが、論理リクエストごとに予算を消費する。** **論理 Tool の自動リトライは存在しない。** dedup の対象は **同一 Run 内のみ** で、`freshness=refresh` は常に dedup をバイパスして実行される。
- **dedup（合意）:** 同一 Run 内で **Zod defaults 適用後の canonical JSON のフィンガープリント**により重複排除。実行中の同一フィンガープリントは **in-flight coalescing**、完了済みは **結果の再利用**。`freshness=refresh` は dedup を **バイパス**する。**Run をまたぐ再利用はしない。** 書き込み系ツールの冪等性は将来の Action 冪等性（M5）に委ねる。
- **タイムアウト / キャンセル:** AbortSignal を合成し、15s/60s タイムアウトと Run キャンセルの両方で中断する。**非協力的なツール（signal を無視する処理）でも Broker は待ち続けない。** 監査には **`reported_outcome`（ツールが報告した結果）と `actual_outcome`（Broker が観測した結果）を分けて記録**し、`result_disposition` は **`accepted` / `discarded` / `none`** のいずれか。**terminal Run が後から RunEvent を受け取ることはない**（ブロッカー 3・5 と整合）。
- **出力は strict に検証し、サイズ超過は切り詰めず（silent truncation なし）拒否する。** v0.1 に **論理 Tool の自動リトライはない**。Connector（下位接続）の再接続は起こりうるが、**同一ツール呼び出しの再送はしない**。
- **Connector 境界とプロンプトインジェクション:** Connector が外部データを取り込む境界を明示し、**構造的な防御**（参照は rN / スナップショット経由、モデル向け出力のサイズ・観測上限、外部データを指示として信用しない設計）を講じる。**テキスト sanitization で解決すると主張しない。**

### ブロッカー 7: SQLite DDL・マイグレーション・冪等性 canonicalization・設定・所有権境界（合意）

> 正確な提案 DDL の本体は **§10**（ブロッカー 7 の合意を反映済み）である。DDL は **提案（proposed）** ラベルを維持する（実装時の SQLite 構文検証で機械的な調整がありうる）が、下記に列挙する不変条件（部分一意インデックス・複合 FK・状態フィールド CHECK）は **合意済み** である。本書は計画のみであり、実装・テストはまだ行われていない。

- **7.1 ID 採番（合意）:** M0 のハーネス生成 ID はすべて **UUID v4（`crypto.randomUUID()`）** とする。対象: `sessions` / `turns` / `runs` / `tool_calls` の主キー（`run_events` / `turn_selections` / `api_idempotency` は複合 PK）。ULID は採用しない。以後のマイルストーン（M1 以降）で追加されるテーブルも同一方針を踏襲する。**ユーザー可視の rN 序数（`session_references.ordinal`）は連番のまま変更しない。** `Idempotency-Key` はクライアント生成 UUID（§12.2）。
- **7.2 接続と PRAGMA（合意）:** DB 接続は **better-sqlite3 の単一接続のみ**（コネクションプールを作らない。単一プロセス前提、§8）。接続確立時に適用する PRAGMA: **`journal_mode=WAL` / `foreign_keys=ON` / `synchronous=NORMAL` / `busy_timeout`（**5000ms・合意値**）**。アプリケーションは暗黙の接続生成を行わず、起動時に 1 接続を組み立てて kernel storage に渡す。
- **7.3 STRICT テーブルと JSON 検証（合意）:** すべてのテーブルを **SQLite STRICT テーブル** として作成する（必須）。STRICT は SQLite 3.37+ を要求するため、**M0.0 spike（§13.1 の better-sqlite3 / Node 24 確認と同一 spike）で同梱 SQLite のバージョンと STRICT 対応を確認する**。JSON 格納列（`input_json` / `frozen_context` / `result_json` / `payload` / `response_body` / `items_json` 等）は TEXT 保存とし、DDL 上は **非 NULL 列は `CHECK (json_valid(<列>))`、NULL 許容列は `CHECK (<列> IS NULL OR json_valid(<列>))`** と書く（合意。M0 の NULL 許容 JSON は `runs.result_json` のみ。`frozen_context` / `payload` / `response_body` の非 NULL 列は直接形のまま）。さらに書き込み前・読み出し後に Zod で検証する（アプリケーション層での二重強制）。STRICT は **テーブル定義末尾の正式構文（`CREATE TABLE ... (...) STRICT`）** で記述し、**`WITHOUT ROWID` は使用しない**。
- **7.4 DDL の正確な内容（提案・§10 参照）:** `sessions` / `turns` / `runs` / `turn_selections` / `run_events` / `tool_calls` / `api_idempotency` の 7 テーブルの列・制約は §10 どおり。合意済みの構造的不変条件:
  - **部分一意 active-run インデックス:** `CREATE UNIQUE INDEX idx_runs_one_active_per_session ON runs(session_id) WHERE status IN ('queued','running','cancel_requested')`（セッションごとの active Run 最大 1）。
  - **複合 FK:** `runs(session_id, turn_id) → turns(session_id, id)`（Run の Turn が同一 Session に属すること。`turns` 側の `UNIQUE (session_id, id)` が親キー）および `turn_selections(turn_id, run_id) → runs(turn_id, id)`（選択 Run が同一 Turn に属すること）。
  - **状態フィールド CHECK（提案）:** `runs.status IN ('queued','running','cancel_requested','completed','failed','cancelled','abandoned')`（加えて §10 の **status 依存 CHECK** が時刻・結果・エラー列の組合せを強制する: `completed` / `failed` は `started_at NOT NULL` を要求、`queued` / `running` / `completed` / `failed` / `abandoned` は `cancel_requested_at IS NULL` を要求、`cancelled` は `cancel_requested_at NOT NULL AND finished_at NOT NULL` を要求（`started_at` は queued 直接 cancel のため NULL 許容）、`abandoned` は `started_at NOT NULL AND finished_at NOT NULL` を要求。さらに `UNIQUE (session_id, id)` を持ち、M1 以降の session 複合 FK の親キーとする）、`runs.select_on_success IN (0,1)`、`runs.event_seq >= 0`、`runs.attempt >= 1`、`turns.seq >= 1`、`turns.next_run_attempt >= 1`、`sessions.next_turn_position >= 1`、`run_events.seq >= 1` および `run_events.schema_version INTEGER CHECK >= 1`（エンベロープ `schemaVersion=1` と整合。**`run_events.type` に DB の閉集合 CHECK は作らない**。type/payload の閉集合は schemaVersion 別 Zod レジストリで強制する §10 参照）、`tool_calls.lifecycle_status IN ('requested','running','finished')`・`tool_calls.call_index >= 1` および `UNIQUE (run_id, call_index)`・`tool_calls.result_disposition IN ('accepted','discarded','none')`（`DEFAULT 'none'`）・`api_idempotency.response_status BETWEEN 200 AND 299`（成功レスポンスのみ永続化の DB レベル裏付け）。`tool_calls.reported_outcome` / `actual_outcome` は **NULL 許容の閉集合 CHECK（合意）で `IS NULL` を明示**: `reported_outcome IS NULL OR IN ('succeeded','failed','cancelled')`（ハンドラ報告）、`actual_outcome IS NULL OR IN ('succeeded','failed','denied','invalid','deduplicated','timed_out','cancelled','unknown')`（Broker 結論）。dedup の正典は **`actual_outcome='deduplicated'` + `reused_from_call_id`（自己 FK `REFERENCES tool_calls(id)`）** であり、旧 `deduped` フラグ列は持たない。`tool_calls` は生の引数・結果を持たず `args_hash` + `result_digest` のみとする。
- **7.5 Turn の不変性と mutable allocator（合意）:** Turn の `input_json`（バージョン化 TurnInput union。M0 は `user_text` のみ、M5 で `action_approval` / `action_rejection` を追加）/ `frozen_context`（temporal context now / timeZone を含む）/ `seq`（position）は **不変** であり、いかなる経路でも書き換えない（Retry でも再計算しない、§9 ブロッカー 2・§17.4）。`turns` の UPDATE は **`next_run_attempt` のみ** に限定する。`next_run_attempt` は mutable な **allocator** であり、Run 作成トランザクション内で CAS インクリメントして `runs.attempt` を採番する（`MAX(attempt)+1` 禁止）。同様に `sessions.next_turn_position` は Turn 位置の allocator である（Turn 自身の `seq` は採番後に不変）。
- **7.6 completed-only turn selection は repository SQL（合意）:** 「completed Run のみ選択可」は **FK では強制できない**（FK が担保するのは同一 Turn のみ）。completed への CAS 遷移を受理したトランザクション内で、**条件付き SELECT（遷移後の status='completed' 再確認）+ `turn_selections` upsert** を repository SQL として同一トランザクションで実行して強制し、統合テスト（§13.3）で検証する（§9 ブロッカー 2・§11.3）。
- **7.7 冪等性リクエスト canonicalization（合意・ブロッカー 4 の詳細化）:**
  - `request_hash` は **Zod 検証を通過し defaults が適用された後の** リクエストに対して計算する（生の入力文字列に対して計算しない）。
  - hash 入力は **operation id + schema version + canonical ペイロード** とし、**operation / version のドメイン分離** を行う（同一 key でも操作種別・契約バージョンが異なれば hash は一致しない。scope による親リソース区別と合わせ二重の分離）。
  - canonical JSON は **オブジェクトキーを再帰的に安定ソート** して生成する（キー順の違いは同一リクエストとして扱う）。配列の順序は意味を持つため保持する。hash は SHA-256（hex）とする。
  - **BEGIN IMMEDIATE トランザクション**（§9 ブロッカー 4 の手順どおり。lookup → 同一 hash なら replay / 異なる hash なら 409 / 不在なら作成 + 保存）のうち、**永続化するのは操作の成功レスポンス（2xx 系。元の HTTP ステータスのまま。202 も 202 として保存・replay）のみ**。**validation 失敗（400）・競合（409 `idempotency_key_reused` / 409 `session_busy`）・ロールバック・内部エラー（5xx）のレスポンスは永続化しない**（replay 対象外、ブロッカー 4 と同一）。
- **7.8 マイグレーション（合意）:** DDL は **生成済み SQL マイグレーションとして `packages/kernel/migrations` にコミットする**（Drizzle スキーマから開発時に生成し、生成物をリポジトリにコミット）。**実行時の `drizzle-kit push` は行わない**（スキーマ逸脱の暗黙適用を禁止）。**DB のマイグレーションバージョンが同梱マイグレーションより新しい場合は起動を失敗させる**（ダウングレード・暗黙上書きを禁止、fail on newer DB version）。**起動シーケンス（合意）: 設定読込 → DB 接続（PRAGMA 適用・`user_version` 等によるスキーマバージョン確認） → pre-upgrade backup + `quick_check`（§19.2） → コミット済みマイグレーション適用 → recovery（§11.3） → scheduler 開始 → listen。** recovery は listener より前に完了させ、recovery 完了まで scheduler も HTTP 受付も開始しない。
- **7.9 M0 設定（合意）:** M0 の env 設定は **最小セット**（DB パス / bind ホスト / ポート / タイムゾーン / ログレベル等）とし、**デフォルト値を持つ**。**Zod で検証し、起動時に freeze する**（以後変更不可。ホットリロードしない）。**bind ホストは loopback のみ**（127.0.0.1 / localhost 以外は検証で拒否。§12.4・§16.7）。タイムゾーンは **IANA タイムゾーン名** のみ受理（未知・非 IANA 形式は拒否）。DB パスは **既定でアプリデータディレクトリ配下** とし、**DB ファイルまたはその親ディレクトリの symlink は起動時に検出して拒否する**（fail-closed。パス解決のすり替え防止）。**ロギングは有界**: 固定コード・セッション/Run/Turn ID・サイズ・所要時間等の構造サマリのみを記録し、**会話本文・モデル/ツールの入出力内容・ファイルパス・シークレットはログ・監査・raw trace に含めない**（§12.4 の redaction 単一レイヤと整合。ドメイン保存としての Turn 入力・completed 検証済み回答・正規化 Snapshot・proposal 入力の保持とは別レイヤの話である）。
- **7.10 所有権境界（合意）:** **contracts** = Zod スキーマ・型・API 契約・`ToolDescriptor`（シリアライズ可能定義。§9 ブロッカー 6）。**kernel** = RunEngine / ToolBroker / storage / repository / マイグレーション — **DDL とトランザクションの唯一の所有者** であり HTTP を知らない。**server（apps/server）** = composition root: 設定の読み込みと freeze、依存の組み立て（単一 DB 接続の生成を含む）、Hono ルート、ドメインエラーの HTTP 写像。contracts は kernel / server に依存しない。
- **7.11 テスト（合意・§13.3 に反映済み）:** DDL テスト（STRICT 違反の拒否、状態フィールド CHECK の拒否、部分一意インデックス、複合 FK の拒否）、トランザクションテスト（冪等 replay / 409 / 非永続化レスポンス、completed-only selection、CAS 遷移）、マイグレーションテスト（新規 DB への全適用、旧バージョンからの逐次適用、新しすぎる DB での起動失敗）、設定テスト（不正ホスト・非 IANA タイムゾーン・symlink DB パスの拒否、freeze の確認）。

## 10. M0 データモデル（提案）

> ラベル: **提案（proposed）**。§9 ブロッカー 7 の合意（UUID v4 ID・単一接続 PRAGMA・STRICT テーブル・CHECK 不変条件・複合 FK・部分一意インデックス）を反映した正確な DDL である。DDL は **SQLite として有効な構文（実際の CHECK 句・全テーブル末尾の `STRICT`・`WITHOUT ROWID` 不使用・非 NULL JSON は `json_valid` 直接形・NULL 許容 JSON は `IS NULL OR json_valid` 形）で記述済み** であり、列名・表記のみ実装時の微調整を残す（構造的不変条件は合意事項に従う）。マイグレーション適用方針は §9 ブロッカー 7（`packages/kernel/migrations`、起動時適用、`drizzle-kit push` 不使用）。

```sql
-- セッション
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,        -- UUID v4（crypto.randomUUID、§9 ブロッカー 7）
  created_at         INTEGER NOT NULL,        -- Unix ms
  last_active_at     INTEGER NOT NULL,        -- Unix ms
  next_turn_position INTEGER NOT NULL         -- 次の Turn の seq。Turn 位置の mutable allocator
                                              -- （同一トランザクションで CAS インクリメント。Turn 側 seq は採番後不変）
                     CHECK (next_turn_position >= 1)
) STRICT;

-- 不変の Turn: バージョン化 TurnInput union + 凍結済み UI コンテキスト / temporal context（now / timeZone）
-- input_json / frozen_context / seq は不変。UPDATE は next_run_attempt（mutable allocator）のみ許可
-- input_json は { kind:'user_text', version:1, text }（M0 の唯一 variant。M5 で action_approval/action_rejection を追加。§18.4）
-- DB は json_valid のみを強制し、kind/version の閉集合は contracts の schemaVersion 別 Zod レジストリで強制する
CREATE TABLE turns (
  id               TEXT PRIMARY KEY,          -- UUID v4
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  seq              INTEGER NOT NULL,          -- セッション内連番（採番後不変）
                   CHECK (seq >= 1),
  input_json       TEXT NOT NULL,             -- バージョン化 TurnInput union（JSON）。非定型 user_input 列は持たない
  frozen_context   TEXT NOT NULL,             -- 生成開始時に凍結した UI コンテキスト + temporal context（JSON）。
                                              -- Turn 不変のため Retry でも書き換えない（§17.4）
  created_at       INTEGER NOT NULL,          -- Unix ms
  next_run_attempt INTEGER NOT NULL,          -- 次の Run の attempt。mutable allocator
                                              -- （同一トランザクションで CAS インクリメント）
                   CHECK (next_run_attempt >= 1),
  UNIQUE (session_id, seq),
  UNIQUE (session_id, id),                    -- runs の複合 FK が参照する親キー
  CHECK (json_valid(input_json)),
  CHECK (json_valid(frozen_context))
) STRICT;

-- Run: 1 回の生成試行（バージョン化された結果を持つ）
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,        -- UUID v4
  turn_id            TEXT NOT NULL REFERENCES turns(id),
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  attempt            INTEGER NOT NULL,        -- Turn 内での試行番号 (1..)
                     CHECK (attempt >= 1),
  status             TEXT NOT NULL            -- cancel_requested は明示的な status（時刻列のみで表現しない）
                     CHECK (status IN ('queued','running','cancel_requested','completed','failed','cancelled','abandoned')),
  strategy           TEXT NOT NULL,           -- RunStrategy 識別子
  result_json        TEXT,                    -- 完了時のアシスタント結果（JSON・バージョン化）。completed Run のみが持つ
  error_code         TEXT,                    -- 固定・redact 済みのエラーコード（生のエラー文字列を保存しない）
  event_seq          INTEGER NOT NULL,        -- run_events 用の per-run 連番カーソル。「最後に発番した seq」を保持し 0 で初期化。
                                              -- 追記時は原子的に N へ +1 し、同一トランザクションで (run_id, N) を INSERT する
                     CHECK (event_seq >= 0),
  select_on_success  INTEGER NOT NULL,        -- 完了時に自動選択するか。初回・Retry ともデフォルト true（§9 ブロッカー 2）
                     CHECK (select_on_success IN (0,1)),
  tool_requests_used INTEGER NOT NULL,        -- ツールリクエスト予算の使用数。実行前の CAS 予約（§9 ブロッカー 6）
                     CHECK (tool_requests_used >= 0),
  created_at         INTEGER NOT NULL,        -- Unix ms
  started_at         INTEGER,
  finished_at        INTEGER,
  cancel_requested_at INTEGER,                -- cancel_requested を記録した時刻（status と併用）
  UNIQUE (turn_id, attempt),
  UNIQUE (turn_id, id),                       -- turn_selections の複合 FK 用
  UNIQUE (session_id, id),                    -- M1 以降の session 複合 FK（evidence_grants 等）の親キー
  -- Run と Turn の Session 一貫性: 同一 Turn かつ同一 Session の Turn にのみ Run を紐付けられる。
  -- turns 側の親キー UNIQUE (session_id, id) を要求する。
  FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, id),
  CHECK (result_json IS NULL OR json_valid(result_json)),
  -- status 依存のライフサイクル CHECK（合意）。
  -- completed/failed は started_at を要求。queued/running/completed/failed/abandoned は cancel_requested_at NULL を要求。
  -- cancelled は cancel_requested_at NOT NULL + finished NOT NULL（started_at は queued 直接 cancel のため NULL 許容）。
  -- abandoned は started_at NOT NULL + finished NOT NULL（起動時 recovery / drain の running 残余のみが対象）。
  CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL AND result_json IS NULL AND error_code IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND result_json IS NULL AND error_code IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'cancel_requested' AND started_at IS NOT NULL AND cancel_requested_at IS NOT NULL AND finished_at IS NULL AND result_json IS NULL AND error_code IS NULL) OR
    (status = 'completed' AND started_at IS NOT NULL AND result_json IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'failed' AND started_at IS NOT NULL AND error_code IS NOT NULL AND finished_at IS NOT NULL AND result_json IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'cancelled' AND cancel_requested_at IS NOT NULL AND finished_at IS NOT NULL AND result_json IS NULL AND error_code IS NULL) OR
    (status = 'abandoned' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND result_json IS NULL AND error_code IS NULL AND cancel_requested_at IS NULL)
  )
) STRICT;

-- completed Run の選択（1 Turn につき 0..1）
-- ※ 複合 FK (turn_id, run_id) → runs(turn_id, id) が担保するのは「選択 Run が同一 Turn に属すること」のみ。
-- 「completed Run しか選べない」ことは FK では担保できない。completed への遷移は
-- repository のトランザクション内で条件付き SELECT + CAS（§11.3、§9 ブロッカー 7）によって強制し、
-- 統合テスト（§13.3）で検証する（合意）。
CREATE TABLE turn_selections (
  turn_id     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  selected_at INTEGER NOT NULL,               -- Unix ms
  PRIMARY KEY (turn_id),
  FOREIGN KEY (turn_id, run_id) REFERENCES runs(turn_id, id),
  UNIQUE (turn_id, run_id)
) STRICT;

-- Run イベント（状態変更と同一トランザクションで追記）
-- グローバル AUTOINCREMENT は使わない。seq は runs.event_seq の原子的インクリメントで採番する。
-- type に DB の閉集合 CHECK は作らない（意図的な拡張性）。type/payload の閉集合は schemaVersion 別 Zod レジストリで強制する。
-- M1/M2/M5 の migrations は contracts/events の追加のみを行い、run_events テーブルの rebuild はしない。
-- イベント所有権: reference.presented と action.proposed は起点の Agent Run に属する。model.step.* は Agent Run に属する。
-- action.approved / action.preflight_started / action.preflight_failed / action.preflight_blocked / action.execution_started / action.execution_finished は Action Run に属する。
-- action.rejected の RunEvent は存在しない（拒否は proposal 状態 + action_rejection Turn + API 応答/履歴で表現。§18）。
CREATE TABLE run_events (
  run_id         TEXT NOT NULL REFERENCES runs(id),
  seq            INTEGER NOT NULL,            -- Run 内連番（per-run seq）
                 CHECK (seq >= 1),
  schema_version INTEGER NOT NULL               -- エンベロープ schemaVersion（§9 ブロッカー 5。schemaVersion=1 と整合）
                 CHECK (schema_version >= 1),
  type           TEXT NOT NULL,               -- 閉集合は Zod レジストリで強制（DB CHECK なし）
  payload        TEXT NOT NULL,               -- JSON payload。エンベロープの runId/seq/createdAt は列で保持（§9 ブロッカー 5）
  created_at     INTEGER NOT NULL,            -- Unix ms
  PRIMARY KEY (run_id, seq),
  CHECK (json_valid(payload))
) STRICT;
-- after/limit ページングは PRIMARY KEY (run_id, seq) で Cover される

-- ツール呼び出し監査（§9 ブロッカー 6。dedup の正典は actual_outcome='deduplicated' + reused_from_call_id）
CREATE TABLE tool_calls (
  id                  TEXT PRIMARY KEY,       -- UUID v4
  run_id              TEXT NOT NULL REFERENCES runs(id),
  call_index          INTEGER NOT NULL        -- Run 内の呼び出し序数 (1..)
                      CHECK (call_index >= 1),
  lifecycle_status    TEXT NOT NULL           -- requested | running | finished
                      CHECK (lifecycle_status IN ('requested','running','finished')),
  tool                TEXT NOT NULL,          -- namespace.verb
  args_hash           TEXT NOT NULL,          -- Zod defaults 適用後 canonical JSON のフィンガープリント（dedup と共通。生 args は保存しない）
  reported_outcome    TEXT,                   -- ツール（ハンドラ）が報告した結果。NULL 許容（実行に到達しない場合等）
                      CHECK (reported_outcome IS NULL OR reported_outcome IN ('succeeded','failed','cancelled')),
  actual_outcome      TEXT,                   -- Broker が観測した結論（非協力的ツール等で reported と乖離しうる）。NULL 許容
                      CHECK (actual_outcome IS NULL OR actual_outcome IN ('succeeded','failed','denied','invalid','deduplicated','timed_out','cancelled','unknown')),
  result_disposition  TEXT NOT NULL DEFAULT 'none',  -- accepted | discarded | none（遅延・破棄結果は discarded、未実行系は none）
                      CHECK (result_disposition IN ('accepted','discarded','none')),
  reused_from_call_id TEXT REFERENCES tool_calls(id),  -- dedup で結果を再利用した元の tool_calls.id（NULL 許容の自己 FK）
  error_code          TEXT,                   -- 固定・redact 済みエラーコード
  result_digest       TEXT,                   -- 結果のダイジェストのみ（生 result は保存しない）
  requested_at        INTEGER NOT NULL,       -- Unix ms（予約・要求時刻）
  started_at          INTEGER,                -- Unix ms（実行開始。NULL 許容）
  reported_at         INTEGER,                -- Unix ms（ハンドラ報告。NULL 許容）
  actual_finished_at  INTEGER,                -- Unix ms（Broker 確定。NULL 許容）
  created_at          INTEGER NOT NULL,       -- Unix ms
  UNIQUE (run_id, call_index)
) STRICT;
-- terminal Run の後着ツール結果は RunEvent にはならず、tool_calls への監査追記のみで記録される（§9 ブロッカー 3・5・6）

-- 冪等性ストア（canonicalization の詳細は §9 ブロッカー 7）
CREATE TABLE api_idempotency (
  scope           TEXT NOT NULL,              -- 'sessions:create' | 'session:{sessionId}:message' | 'turn:{turnId}:retry'
                                              -- （親リソースを scope で区別する）
  key             TEXT NOT NULL,              -- 検証済み Idempotency-Key（クライアント生成 UUID）
  request_hash    TEXT NOT NULL,              -- 正規化リクエストのハッシュ（operation/version 分離 + 安定キー順 canonical JSON の SHA-256、§9 ブロッカー 7）
  response_status INTEGER NOT NULL,           -- 成功レスポンスのみ永続化
                  CHECK (response_status BETWEEN 200 AND 299),
  response_body   TEXT NOT NULL,              -- 保存済みレスポンス
  created_at      INTEGER NOT NULL,           -- Unix ms
  PRIMARY KEY (scope, key),
  CHECK (json_valid(response_body))
) STRICT;

-- active Run の部分一意インデックス:
-- セッションごとに active (queued | running | cancel_requested) は最大 1
-- （cancel_requested は明示的な status 列で表現される）
CREATE UNIQUE INDEX idx_runs_one_active_per_session
  ON runs(session_id)
  WHERE status IN ('queued', 'running', 'cancel_requested');
```

不変条件（合意由来）:

- `messages` テーブルは **存在しない**。バージョン化 TurnInput union（`turns.input_json`。M0 は `user_text` のみ、M5 で `action_approval` / `action_rejection` を追加）と frozen UI context（temporal context now / timeZone を含む、§17.4）は不変の `turns`、バージョン化された `result_json` は `runs` が所有する。
- セッションごとの active Run は部分一意インデックスにより **最大 1**。
- すべての時刻は **Unix ms（INTEGER）**。
- `turns` の `input_json` / `frozen_context` / `seq`（position）は不変（UPDATE しない）。`turns` の UPDATE は mutable allocator である `next_run_attempt` のみに限定される。Retry は `turns.next_run_attempt` の CAS インクリメントで新しい `runs.attempt` を採番する（`MAX(attempt)+1` は使わない）。新しい Turn の `seq` も `sessions.next_turn_position` で採番する（`MAX(seq)+1` は使わない）。
- Run イベントは **per-run `seq`**（`PRIMARY KEY (run_id, seq)`）で採番し、グローバル AUTOINCREMENT は使わない。`runs.event_seq` は **最後に発番した seq** を保持するカーソル（0 初期化）で、追記時に原子的インクリメント → `(run_id, N)` INSERT を同一トランザクションで行う。
- `runs(session_id, turn_id)` → `turns(session_id, id)` の複合 FK（**合意**、§9 ブロッカー 7）により、Run が紐付く Turn が同一 Session に属することが DB レベルで強制される。`turns` 側の `UNIQUE (session_id, id)` がこの FK の親キーとして必須。
- `turn_selections` の複合 FK が強制するのは **同一 Turn のみ** であり、「completed Run のみ選択可」は **repository トランザクション（条件付き SELECT + CAS）と統合テスト** で強制・検証する（合意）。選択の更新は完了 commit と同一トランザクションでの upsert のみで行われる（§9 ブロッカー 2）。
- すべての主キー ID は **UUID v4（`crypto.randomUUID()`）**（§9 ブロッカー 7）。rN 序数は変更しない。
- すべてのテーブルは **末尾に `STRICT` を持つテーブル**（`WITHOUT ROWID` は使用しない）とし、状態・カウンタ・真偽・outcome フィールドには上記 DDL の **実際の CHECK 制約** を持ち、JSON 列は **非 NULL 列は `CHECK (json_valid(...))`、NULL 許容列は `CHECK (... IS NULL OR json_valid(...))`** を持つ（§9 ブロッカー 7）。CHECK・複合 FK・部分一意インデックスの構造的不変条件は合意済み。
- `result_json`（最終回答）は **completed Run と `turn_selections` で選択された Run の投影（§11.6）にのみ現れる**。他の Run・他のイベントが回答本文を運ばない（§9 ブロッカー 5）。
- DB は **単一 better-sqlite3 接続**（WAL / `foreign_keys=ON` / `synchronous=NORMAL` / `busy_timeout`、§9 ブロッカー 7）でアクセスする。DDL は `packages/kernel/migrations` のコミット済み生成 SQL から起動時に適用し、実行時の `drizzle-kit push` はしない。

---

## 11. 状態遷移とトランザクション合意提案

### 11.1 状態遷移図

```
                 create
                   │
                   v
   ┌─────────── queued ───────────┐
   │               │ start        │ cancel（直接 cancelled へ）
   │               v              v
    │           running ──cancel──> cancel_requested ──(通常時 watchdog: grace 最大 3000ms)──> cancelled
    │            │                  ※ 通常 Cancel のみが cancel_requested + Abort + 3000ms watchdog を使う。
    │            │                  ※ graceful shutdown の drain では 3000ms grace を使わない（§11.5）。
    │            │                  ※ 急激な終了時のみ cancel_requested が残存し、起動時 recovery が cancelled に確定
   │            │
   │  complete  │  └──fail──> failed
   │            v
   │        completed
   │            ※ 完了 commit は status='running' のときのみ。
   │              cancel_requested 後の grace 内の結果は破棄され、Run は cancelled になる。
   │
   └──(再起動時: queued は requeue)

   running ──(再起動時)──> abandoned
   cancel_requested ──(再起動時)──> cancelled
   running ──(graceful shutdown の drain 後も残余)──> abandoned（§11.5。running → cancelled は drain では行わない）
```

### 11.2 状態遷移表

| 現在 | イベント | 次 | 備考 |
| --- | --- | --- | --- |
| （なし） | create | queued | 一意インデックスで active 1 件を強制 |
| queued | start | running | scheduler が CAS で獲得 |
| queued | cancel | cancelled | 直接確定（cancel_requested を経由しない） |
| running | complete | completed | CAS のみ。**status='running' のときだけ受理**。terminal 以降は不可 |
| running | fail | failed | CAS のみ |
| running | cancel | cancel_requested | DB コミット → AbortSignal |
| cancel_requested | complete | 変更なし | **grace 内であっても結果 commit は受理しない**。後着出力は破棄 |
| cancel_requested | （通常時 grace 最大 3000ms 経過 / watchdog） | cancelled | 通常時の Cancel のみ watchdog が強制確定する。graceful shutdown の drain では 3000ms grace を使わず §11.5（running 残余は abandoned、cancel_requested は cancelled）に従う。`cancel_requested` のまま残るのは急激な終了のみ（recovery が cancelled に確定） |
| running | 再起動 | abandoned | 自動再実行しない |
| queued | 再起動 | queued（requeue） | scheduler が再取得 |
| cancel_requested | 再起動 | cancelled | 確定（`cancel_requested` が残存するのは急激な終了時のみ。recovery が確定） |
| terminal 系 | 何らかの後着出力 | 変更なし | CAS が失敗。tool_calls に `result_disposition='discarded'` を記録しうる。**terminal RunEvent の後に RunEvent は追記しない** |

### 11.3 トランザクション（提案）

いずれも「状態 UPDATE（CAS）+ `run_events` INSERT」を **同一トランザクション** で行う。外部呼び出しは常にトランザクション外。**Session スコープの全トランザクション例は、アクセス前にパス session の所有権（Run/Turn が当該 Session に属すること）を検査する。冪等レスポンスとして永続化するのはドメイン受理された accepted 2xx のみであり、検証失敗・競合・ロールバック・内部エラーのレスポンスは永続化しない（§9 ブロッカー 4・7）。**

- **create（new run）**
  1. パス session の所有権を検査（Session 存在確認。不在は 404。所有権違反は 404）。
  2. `BEGIN IMMEDIATE`
  2. `INSERT INTO turns ...`（初回メッセージ時。frozen_context を凍結。`seq` は `sessions.next_turn_position` を同一トランザクションで CAS インクリメントして採番 — `MAX(seq)+1` 禁止）
  3. `INSERT INTO runs ...`（status='queued'、`attempt` は `turns.next_run_attempt` を同一トランザクションで CAS インクリメントして採番 — `MAX(attempt)+1` 禁止）
     - 部分一意インデックス違反 → 同一セッション active ありとして 409 系エラー
  4. `INSERT INTO run_events`（seq=1, run.queued。`runs.event_seq` を原子的に +1）
  5. `COMMIT`
- **start（scheduler が取得）**
  1. `UPDATE runs SET status='running', started_at=? WHERE id=? AND status='queued'` → 変更 0 行なら他ワーカーが獲得済み
  2. 同トランザクションで `run_events`(run.started, seq=event_seq+1) を追記し `event_seq` を +1
- **complete**
  1. `UPDATE runs SET status='completed', result_json=?, finished_at=? WHERE id=? AND status='running'`
     - **status='running' のときのみ受理**。0 行 → すでに terminal または `cancel_requested`（grace 内を含む）。後着出力は **破棄** され、Run は **completed にはならない**（必要なら tool_calls に `result_disposition='discarded'` を記録。**run_events への追記はしない**）
  2. 受理された場合のみ、同トランザクションで `run_events`(run.completed) を追記し `event_seq` を +1
  3. **`select_on_success=true` の場合（初回 Run・Retry Run ともデフォルト）、同トランザクション内で `turn_selections` にその Run を upsert し、その Turn の唯一の選択とする。** `select_on_success=false` なら現在の選択を変更しない
     - **completed へ遷移した Run のみがこの upsert の対象になる**（条件付き SELECT + CAS で強制。`turn_selections` の複合 FK が担保するのは同一 Turn のみである点に注意）
- **fail**：complete と同型（`status='failed'`, 固定・redact 済みの `error_code` を記録）。**failed への遷移は `turn_selections` を一切変更しない**
- **cancel**
  1. queued の Run: `UPDATE runs SET status='cancelled', cancel_requested_at=?, finished_at=? WHERE id=? AND status='queued'`（**直接確定**。cancel_requested を経由しない。`cancel_requested_at` と `finished_at` の双方を設定し、同一トランザクションで `run.cancelled` を追記する。§10 の `cancelled` 向け status 依存 CHECK（`cancel_requested_at NOT NULL AND finished_at NOT NULL`）を満たす）
  2. running の Run: `UPDATE runs SET status='cancel_requested', cancel_requested_at=? WHERE id=? AND status='running'` + 同一トランザクションで `run.cancel_requested` 追記
  3. `COMMIT` 後に AbortSignal を発火（DB 先行は厳守）
  4. grace 3000ms は通常時の Cancel 専用の猶予であり、grace 内の結果も **commit は受理しない**（complete の CAS が破棄）
  5. **通常時のみ watchdog が grace 最大 3000ms 経過後に** `UPDATE ... SET status='cancelled' WHERE id=? AND status='cancel_requested'` → `cancelled`。**graceful shutdown の drain ではこの watchdog 最終化を使わず §11.5 に従う**（drain 中の running → cancelled は行わない）。`cancel_requested` のまま残るのは急激な終了のみ
  6. **cancelled / abandoned への遷移は `turn_selections` を一切変更しない**
- **recovery（起動時）**
  1. `UPDATE runs SET status='abandoned', finished_at=? WHERE status='running'`（全行、CAS）
  2. `UPDATE runs SET status='cancelled', finished_at=? WHERE status='cancel_requested'`
  3. queued はそのまま（scheduler が requeue）
  4. 上記と対応する run_events を同一トランザクションで追記（seq は `event_seq` +1）

### 11.4 durable scheduler（提案）

- 単一プロセス内のスケジューラループが `queued` を取得 → start CAS → RunStrategy 実行。
- 取得は `WHERE status='queued' ORDER BY created_at LIMIT 1` と CAS UPDATE の組合せで競合安全に。
- セッション単位の直列性は「active 1 件」の部分一意インデックスと queued の取り出し順で担保される。

### 11.5 graceful shutdown（合意）

通常時の Cancel（cancel_requested + Abort + 3000ms watchdog）とは別の drain 意味論である。**drain では 3000ms grace を使わず、running → cancelled への遷移は行わない。**

1. 新規受付停止（Message / Retry 受付拒否、queued の pickup 停止。ヘルスは §19.5 に従い live 200 / ready 503 を返し、health 用に listener は最終 close まで残す）
2. **最大 10 秒の自然完了 drain。** この間の自然完了 commit（status='running' のみ受理）は受け付ける
3. 10 秒経過後の残余を Abort **前に** CAS + RunEvent で確定する:
   - 残余の **running は `abandoned` へ**（`run.abandoned` イベント + `finished_at`。§10 の status 依存 CHECK に従う）
   - 残余の **cancel_requested は `cancelled` へ**（`run.cancelled` イベント + `finished_at`）
   - **queued はそのまま残す**（次回起動時に scheduler が requeue。実行開始しない）
   - 確定後に AbortSignal を発火する
4. スケジューラ停止 → DB 接続クローズ → listener 最終 close
5. **`cancel_requested` のまま残りうるのは急激な終了（プロセス強制終了等）のみ**であり、その場合は **起動時 recovery が `cancelled` に確定**する（durable queue の意味論に一貫）。正常な graceful shutdown が `cancel_requested` のまま Run を残すことはない

### 11.6 履歴投影（合意）

履歴 API の応答は `input_json.kind` 別の投影で作る:

```
Turn（input_json.kind + frozen_context 由来の表示情報）
  × turn_selections で選ばれた Run の result（存在する場合）
```

- `user_text` Turn はユーザーメッセージとして描画し、選択された completed アシスタント結果を組み合わせる。
- `action_approval` Turn（M5）は決定論的な承認意図（approved intent）として描画し、選択/完了した ActionRun の receipt（§18.7）を組み合わせる。
- `action_rejection` Turn（M5）は決定論的な拒否意図（rejected intent）として描画する。紐づく Run を持たないが履歴には現れる（§18.4）。
- 通常 UI に技術 ID（Turn/Run/proposal/execution ID）を表示しない。
- 選択のない `user_text` Turn は「応答なし」として表示（生成中・失敗はイベント API 側で表現）。
- 未選択の Run・failed・cancelled・abandoned Run は履歴に現れない。

---

## 12. API 設計（合意＋提案）

### 12.1 エンドポイント（M0）

| メソッド | パス | 冪等性 | 備考 |
| --- | --- | --- | --- |
| POST | `/api/sessions` | **Idempotency-Key 必須**（scope: `sessions:create`） | セッション初期化（合意） |
| POST | `/api/sessions/:sessionId/messages` | **Idempotency-Key 必須**（scope: `session:{sessionId}:message`） | 新 Turn + Run 作成 |
| POST | `/api/sessions/:sessionId/turns/:turnId/retries` | **Idempotency-Key 必須**（scope: `turn:{turnId}:retry`） | **同一 Turn へ新 Run**（Retry の対象は Turn であり Run 単位のルートにしない）。**Turn が当該 Session に属し、Session に active Run がない限り、過去 Run の terminal 状態にかかわらず許可される**（合意） |
| POST | `/api/sessions/:sessionId/runs/:runId/cancel` | **キーレス / state-idempotent** | terminal なら現状態を返す |
| GET | `/api/sessions/:sessionId/history` | — | Turn + 選択 Run の投影（`beforePosition` 排他・`limit` default50/max100・時系列返却・`nextBefore`/`hasMore`、`input_json.kind` 別投影は §11.6・§16.6） |
| GET | `/api/sessions/:sessionId/runs/:runId/events?after=&limit=` | — | ページネーション JSON（SSE は M3） |
| GET | `/api/sessions/:sessionId/idempotency/:key?scope=` | — | ブラウザリロード後の再送要否 lookup（§16.7）。受理済み key の保存済み status/body を返し履歴再取得を促す。key 不在は再作成せず固定の resend-required を返す。ブラウザに本文/スナップショットを保存しない |

M0 は手動の Run 選択 UI / API を提供しない（選択は `select_on_success` の自動 upsert のみ）。

### 12.2 ペイロード例（提案）

**Session スコープの全例は、アクセス前にパス session の所有権（対象 Turn/Run が当該 Session に属すること）を検査し、不一致は 404 とする。冪等保存するのは受理された accepted 2xx のみであり、エラーは永続化しない（§9 ブロッカー 4・7、§11.3）。**

`POST /api/sessions/:sessionId/messages` リクエスト:

```json
{
  "text": "今週の予定を要約して",
  "uiContext": { "...": "任意。省略可" }
}
```

ヘッダ: `Idempotency-Key: <UUID>`

（リクエスト body の `text` は正規化後に `turns.input_json`（`user_text` variant）として保存する。生の非定型列は持たない。）

`202 Accepted`（生成は非同期。Run は queued）:

```json
{
  "sessionId": "<uuid>",
  "turnId": "<uuid>",
  "run": { "id": "<uuid>", "attempt": 1, "status": "queued" }
}
```

同一 key 再送（同一正規化リクエスト）→ **保存済みのレスポンスを元の HTTP ステータス・ボディのまま再生**（元が `202` なら `202` のまま。200 に書き換えない）。
同一 key + 異なるリクエスト → **409**:

```json
{ "error": { "code": "idempotency_key_reused", "message": "..." } }
```

`POST /api/sessions/:sessionId/runs/:runId/cancel` → `200`（**running Run に対する cancel の例**。`cancel_requested` が返る）:

```json
{ "run": { "id": "<uuid>", "status": "cancel_requested" } }
```

- **queued Run に対する cancel** は `cancel_requested` を経由せず **`cancelled` が直接返る**。
- **すでに terminal の Run**（completed / failed / cancelled / abandoned）に対する cancel は 409 を返さず、**現在の状態をそのまま返す**（state-idempotent）。

`GET /api/sessions/:sessionId/runs/:runId/events?after=2&limit=50` → `200`（`after` は **排他的**。`nextAfter` は **返却イベントの最大 seq**、**返却 0 件ならリクエストの `after` をそのまま返す**。`terminal` は **Run の status から導出**。`hasMore` は未返却イベントの有無）:

```json
{
  "events": [ { "seq": 3, "type": "run.started", "createdAt": 1790000000000 } ],
  "nextAfter": 3,
  "hasMore": false,
  "terminal": false
}
```

上の例では `after=2`（排他）に対し seq=3 が返り、`nextAfter=3`（= 返却イベントの最大 seq）。次回は `after=3` で seq=4 以降を取得する。新しいイベントがなく 0 件返却の場合は `nextAfter` はリクエストの `after` から変化しない。Run が terminal でないため `terminal=false`（terminal は Run status から導出され、イベント列からは推測しない）。イベントのエンベロープ契約は §9 ブロッカー 5。

### 12.3 エラー規約（提案）

| status | code | 意味 |
| --- | --- | --- |
| 400 | `validation_error` | Zod 検証失敗（Idempotency-Key 欠落含む） |
| 404 | `not_found` | session / run / turn 不在 |
| 409 | `idempotency_key_reused` | 同一 key + 異なるリクエスト |
| 409 | `session_busy` | 同一セッションに active Run が既存 |
| 503 | `server_shutting_down` | drain 中の新規受付拒否。`Retry-After` を付す。冪等ストアに永続化しない |

API エラーコードは **小文字の固定コード** で統一する。cancel が terminal Run を対象にした場合は 409 を返さず、200 で現状態をそのまま返す（state-idempotent）。`server_shutting_down`（503）は drain 中の Message / Retry /（v0.2 からは Approve）拒否にのみ使い、**`api_idempotency` に永続化しない**（replay 対象外）。

### 12.4 redaction / security（提案）
- redaction は **ログ・監査・raw trace から内容（content）を除外する単一レイヤ** に集約する。対象は会話本文・モデル/ツールの入出力内容・ファイルパス・シークレットであり、これらをログ・監査・raw trace に含めない。Run の失敗は生のエラーではなく **固定・redact 済みの `error_code`** として記録する。**ドメイン保存は別レイヤであり、Turn 入力・completed 検証済み回答（`runs.result_json`）・正規化 Snapshot・proposal 入力は意図的に保存する。**
- M0 はローカル専用のためバインドは localhost のみ。認証・リモートアクセスは非目標（§8）。
- ツール引数は生値ではなくハッシュ + 必要最小限のサマリを監査に残す（`args_hash` + `result_digest` のみ。生 args / 生 result は保存しない）。

### 12.5 ヘルス API（exact・合意）

- `GET /health/live` は listener 存在後に `200 { status: 'live' }` を返す。recovery 完了前の pre-ready 状態では listener 自体が存在しないため HTTP 観測可能ではなく、pre-ready の live 成功主張はしない。drain 中も最終 close まで `200 { status: 'live' }` を返す。
- `GET /health/ready` は通常時 `200 { status: 'ready' }`、drain 中は `503 { status: 'not_ready', code: 'server_shutting_down' }` を返す。
- ヘルス応答にシークレット・本文・スナップショット内容を含めない。

---

## 13. M0 実施計画：マイルストーン・PR・テスト

### 13.1 サブマイルストーン（提案）

| 区分 | 内容 |
| --- | --- |
| M0.0 | better-sqlite3 / Node 24 spike（exact `24.x.y` + exact pnpm 選定・同梱 SQLite の STRICT 対応確認を含む）、pnpm workspace 雛形、Biome/Vitest 設定 |
| M0.1 | packages/contracts: Zod スキーマと型（API・イベント・状態） |
| M0.2 | packages/kernel: DDL マイグレーション + RunEngine 骨格（CAS 遷移、recovery） |
| M0.3 | durable scheduler（queued 取得・直列実行・grace キャンセル） |
| M0.4 | ToolBroker 最小版（ToolDescriptor は contracts、Zod スキーマ/ハンドラは kernel、静的レジストリ、固定パイプライン順・監査記録）。**M0 は読み取り専用ポリシー（合意）: 読み取り系 tool は許可、書き込み系・機微（sensitive）カテゴリは拒否、リスク未分類の tool / 未知の tool は default-deny で拒否**。**予算（§9 ブロッカー 6: `runs.tool_requests_used` の CAS 予約、拒否/invalid/dedup/timeout/cancel も消費）、同一 Run 内 dedup（Zod defaults 後 canonical JSON）、タイムアウト/キャンセルの AbortSignal 合成と非協力的ツール対応、strict 出力検証（超過は切り詰めず拒否）、reported_outcome / actual_outcome / result_disposition の監査** |
| M0.5 | api_idempotency 実装（正規化ハッシュ・原子的冪等トランザクション・replay・409。§9 ブロッカー 4 参照） |
| M0.6 | apps/server: sessions / messages / retry / cancel / history / events ルート |
| M0.7 | 履歴投影 + turn_selections 仕上げ |
| M0.8 | graceful shutdown + E2E 仕上げ、受入テスト一式 |

### 13.2 PR 構成（提案）

| PR | 内容 | 依存 |
| --- | --- | --- |
| PR-01 | リポジトリ雛形: pnpm workspace, TS strict, Biome, Vitest, CI 骨格 | — |
| PR-02 | packages/contracts: Zod スキーマ一式と状態モデル | PR-01 |
| PR-03 | packages/kernel: DDL + RunEngine + CAS 遷移 + recovery | PR-02 |
| PR-04 | packages/kernel: scheduler + ToolBroker 最小版 + idempotency | PR-03 |
| PR-05 | apps/server: Hono ルート一式（sessions 含む）+ 履歴投影 + 受入テスト | PR-04 |

### 13.3 受入テスト（提案）

- **単体（Vitest）**
  - CAS 遷移: 期待状態不一致で 0 行更新となること。
  - 部分一意インデックス: 同一セッション第 2 の active Run が拒否されること。
  - 冪等ストア: 同 key 同リクエスト → 元のステータス・ボディのまま replay（元 202 は 202）、同 key 異リクエスト → 409。validation 失敗・競合・ロールバック・内部エラー時のレスポンスが `api_idempotency` に永続化されないこと。key 不在時は Turn/Run/event 作成とレスポンス保存が同一トランザクションで commit されること。
  - イベントカーソル: `event_seq` は 0 初期化で追記ごとに原子的インクリメントされること、`after` が排他的であること、`nextAfter` が返却イベントの最大 seq（0 件時は `after` のまま）であること、`terminal` が Run status から導出されること、`hasMore` が正しいこと。
  - RunEvent 契約（§9 ブロッカー 5）: エンベロープ（schemaVersion/runId/seq/type/createdAt/payload）が検証されること、M0 のイベント型が型付き run/tool イベントのみであること（`answer.committed` / `assistant.delta` 型が存在しないこと）、**`run_events.type` に DB 閉集合 CHECK が存在せず閉集合は schemaVersion 別 Zod レジストリで強制されること**、`run.completed` のみが RunResult を運ぶこと、terminal RunEvent の後の RunEvent 追記が拒否されること。
  - TurnInput 契約: `turns` に非定型 `user_input` 列が存在せず `input_json`（M0 は `user_text` variant のみ）が `json_valid` + Zod で検証されること、履歴投影が `input_json.kind` 別（§11.6）であること。
  - runs ライフサイクル CHECK: `completed` / `failed` が `started_at` を要求すること、`cancelled` が `cancel_requested_at` + finished を要求し `started_at` NULL を許すこと（queued 直接 cancel）、`abandoned` が `started_at` を要求すること、`UNIQUE (session_id, id)` が存在すること。
  - ToolBroker 読み取り専用ポリシー: 読み取り系 tool は許可されること、書き込み系・機微カテゴリは拒否されること、リスク未分類・未知の tool は default-deny で拒否されること。
  - ToolBroker 予算（§9 ブロッカー 6）: 拒否・invalid・dedup・タイムアウト・キャンセルも予算を消費すること、`runs.tool_requests_used` の CAS 予約により同時呼び出しで予算超過しないこと、per-run / per-process 同時実行上限・入出力サイズ上限・タイムアウト（15s/60s）が効くこと。
  - ToolBroker dedup: Zod defaults 適用後 canonical JSON のフィンガープリントで同一 Run 内の in-flight coalescing / 完了結果再利用が行われること、`freshness=refresh` がバイパスすること、Run をまたぐ再利用がないこと。
  - タイムアウト/キャンセル合成: AbortSignal 合成でタイムアウトと Run キャンセルの両方で中断すること、非協力的なツールで待ち続けないこと、`reported_outcome` と `actual_outcome` が乖離しうること、`result_disposition`（accepted / discarded / none）が正しく記録されること。
  - strict 出力検証: サイズ超過が silent truncation されず拒否されること、論理 Tool の自動リトライがないこと（Connector 再接続は呼び出し再送を伴わないこと）。
  - DDL / ストレージ（§9 ブロッカー 7）: すべてのテーブルが STRICT テーブルとして作成されること、状態フィールド CHECK が不正値（不正 status・範囲外 seq / attempt・200 番台外 response_status 等）を拒否すること、単一 better-sqlite3 接続で PRAGMA（WAL / foreign_keys=ON / synchronous=NORMAL / busy_timeout）が適用されること、ID が UUID v4 であること、JSON 列が書き込み前・読み出し後の Zod 検証を通ること。
  - マイグレーション（§9 ブロッカー 7）: `packages/kernel/migrations` のコミット済み生成 SQL が新規 DB に全適用されること、旧バージョン DB から番号順に逐次適用されること、**同梱マイグレーションより新しい DB バージョンで起動が失敗すること**、実行時に `drizzle-kit push` を使用しないこと。
  - 冪等性 canonicalization（§9 ブロッカー 7）: `request_hash` が Zod 検証 + defaults 適用後の canonical JSON（再帰的キー安定ソート）の SHA-256 であること、hash 入力に operation id と schema version が含まれること（operation/version ドメイン分離）、キー順のみ異なる同一意味リクエストが同一 hash になり replay されること、`BEGIN IMMEDIATE` 下で成功（2xx、元ステータスのまま）レスポンスのみが永続化され、validation 失敗・競合（409）・ロールバック・内部エラーのレスポンスが `api_idempotency` に永続化されないこと。
  - 設定（§9 ブロッカー 7）: loopback 以外の bind ホスト・非 IANA タイムゾーン・symlink を含む DB パスが検証で拒否されること、検証済み設定が起動時に freeze されること、ロギングが有界（本文・入出力内容・パス・シークレット非含有）であること。
- **統合**
  - 再起動リカバリ: running → abandoned、queued → 再実行、cancel_requested（急激な終了時のみ残存）→ cancelled。
  - キャンセル: DB コミットが AbortSignal より先行すること、queued の cancel は直接 cancelled になること、grace 内の後着結果は破棄され Run が completed にならないこと、**通常時 watchdog が grace 最大 3000ms 経過後に cancelled へ遷移すること、graceful shutdown は受付・pickup 停止 + 最大 10 秒 drain のうえ残余 running を abandoned・残余 cancel_requested を cancelled に Abort 前 CAS + RunEvent で確定し queued を残すこと（drain で running → cancelled は行わない・3000ms grace 不使用）**（監査は tool_calls の `result_disposition='discarded'`、terminal 後の RunEvent 追記なし）。
  - 履歴投影: 未選択 Run が履歴に現れないこと。**`turn_selections` の複合 FK が同一 Turn 以外の選択を拒否すること、completed への CAS 遷移と同一トランザクションの upsert のみが選択を更新すること（completed 強制は FK ではなく repository トランザクションで行われることを統合テストで検証）、failed/cancelled/abandoned 遷移や `select_on_success=false` の完了が選択を変更しないこと**。
  - `runs(session_id, turn_id)` → `turns(session_id, id)` の複合 FK（提案）が、Session をまたぐ Run/Turn の組み合わせを拒否すること。
  - Retry: Turn が Session に属し active Run がなければ、過去 Run の terminal 状態にかかわらず新 Run を作成できること。
- **API（supertest 相当）**
  - 全エンドポイントの正常系 / 400 / 404 / 409。
  - events の `after`/`limit` ページング。
  - drain 中の新規受付が `503 server_shutting_down`（`Retry-After` 付き・冪等非永続）であること。
  - ヘルス exact（§12.5）: `GET /health/live` が listener 存在後・drain 中に `200 { status: 'live' }` であること（pre-ready の HTTP 成功主張なし）、`GET /health/ready` が通常時 `200 { status: 'ready' }`・drain 中 `503 { status: 'not_ready', code: 'server_shutting_down' }` であること。
  - queued 直接 cancel が `cancel_requested_at` + `finished_at` + `status='cancelled'` + 同一トランザクションの `run.cancelled` で行われ CHECK を満たすこと。
  - idempotency lookup（§12.1・§16.7）: Session 所有権、受理時の保存済み status/body 再生、不在時の再作成なし + resend-required、本文/スナップショット非保存。
- **CI**
  - lint（Biome）、typecheck、test をすべての PR で実行。CI マトリクス・fake のみのデフォルト統合テスト・依存ポリシーは §19.7 のとおり。

> 本節は計画であり、上記テストは **まだ実装・実行されていない**。

---

## 14. M1 Reference Plan（合意）

> ラベル: **合意（agreed）**。M1（Reference + Markdown）の実装計画として合意した内容を記録する。本書は計画のみであり、M1 の実装・テストは **まだ行われていない**。DDL は §10 と同様に **提案（proposed）** として示し、列名・制約は実装時に微調整しうるが、不変条件は合意事項に従う。

### 14.1 M1 のスコープ（合意）

- M1 で追加するパッケージは **`packages/connector-markdown` のみ**。`apps/server` / `packages/contracts` / `packages/kernel` は既存のまま依存として使い、M0 の決定（§6・§9）を変更しない。
- **ReferenceManager を kernel に追加** する（§3 注記の実装。M0 の kernel には含まれない）。
- **Markdown コネクタは MCP 経由ではなく直接実装する**（M4 の MCP クライアントとは独立）。
- M1 に含まれないもの: **実 LLM 接続（M2）、CitationVerifier（M2）、SSE（M3）、UI（M3）、MCP クライアント（M4）**。

### 14.2 参照同一性モデル（M1 版・合意）

- §4 の 3 層モデルを実装対象として具体化する: **CanonicalResource / 不変の ResourceSnapshot / SessionReference（rN）**。
- **ResourceObservation は ephemeral である。** コネクタが外部リソースを 1 回観測した一時的 fact であり、永続化されたエビデンスではない。normal freshness では既存 Snapshot を再利用しうる（観測ごとに常に新規 Snapshot を作ると主張しない）。
- **ReferenceSet**: 複数の SessionReference を順序付きで束ねる集合（1 つの提示が複数参照を含みうる）。
- **セッション参照コンテキスト（session reference context）はセッションごとに永続化・バージョン化する。** UI が暗黙に選択している参照の集合であり、`session_reference_context.version` の CAS で更新する。生成開始時に Turn の `frozen_context` へ **選択された参照 ID と順序付き active set** を凍結する（§9 ブロッカー 2 と整合）。Run 開始後の UI 変更は当該 Run に無関係である。
- freshness 意味論（合意）:
  - **normal（reuse）**: 同一リソースの同一 revision / 同一内容なら当該セッションですでに参照済みの **最新の Snapshot と同じ rN を再利用** する。revision が変わっていれば（`source_revision` / `content_hash` の不一致）新しい Snapshot と新しい rN を作る。
  - **`markdown.search` の各ヒットは読み取り + materialize を行う。** 検索は観測なし・Snapshot/rN なしと主張しない。各ヒットは全文正規化テキストの不変 Snapshot を materialize（同一内容なら最新 Snapshot 再利用）し、永続化して rN を返す。
  - **明示的な refresh（`kernel reference.refresh`）は参照済み rN の再読み取りの唯一の経路であり、内容が同一でも常に新しい観測 Snapshot と新しい rN を作る。** `kernel reference.open` は保存済み Snapshot のみを開く stored-only で外部再読しない。
  - 上記のため **`UNIQUE (resource_id, content_hash)` 制約は作らない**（同一内容の複数 Snapshot は正当に存在する）。
- Snapshot は不変（immutable）で **整数 `revision` と `source_revision` / `content_hash` を持つ**。正規化済み全文テキスト JSON エビデンスである（§4）。`revision` 採番は `resources.next_revision`（INTEGER トランザクション allocator）を短い DB トランザクション内で recheck して行う（`MAX(revision)+1` 禁止）。
- 永続化手順（合意）: **外部読み取りはトランザクションの外** で行い、短い DB トランザクション内で Run が `running` であることを CAS 再確認し、`resources` / `snapshots` / `session refs` / `reference set` / `reference.presented` を原子的に commit する。running CAS と同時に実行し、キャンセル後到着分は破棄する。

### 14.3 M1 データモデル（提案）

> §10 のテーブルに追加する。`sessions` への列追加を含む。主キー ID は §9 ブロッカー 7 と同一方針の **UUID v4（`crypto.randomUUID()`）** とする（rN 序数は連番のまま）。

```sql
-- コネクタ実体（M1 は Markdown コネクタのみ）
CREATE TABLE connector_instances (
  id            TEXT PRIMARY KEY,          -- UUID v4
  kind          TEXT NOT NULL,             -- 'markdown'
  display_name  TEXT NOT NULL,
  config_json   TEXT NOT NULL,             -- ルート等の設定（絶対パスを露出する形では保持しない）
  created_at    INTEGER NOT NULL,          -- Unix ms
  UNIQUE (kind, display_name),
  CHECK (json_valid(config_json))
) STRICT;

-- CanonicalResource（正規リソース）
CREATE TABLE resources (
  id                    TEXT PRIMARY KEY,  -- UUID v4
  connector_instance_id TEXT NOT NULL REFERENCES connector_instances(id),
  canonical_key         TEXT NOT NULL,     -- ルート相対の正規キー（realpath 由来。絶対パスを含まない）
  title                 TEXT,              -- 表示用の直近タイトル（同一性には関与しない）
  next_revision         INTEGER NOT NULL   -- トランザクション allocator（次の Snapshot revision）。CAS インクリメント
                        CHECK (next_revision >= 1),
  created_at            INTEGER NOT NULL,
  UNIQUE (connector_instance_id, canonical_key),
  UNIQUE (connector_instance_id, id)             -- action_proposals の複合 FK が参照する親キー（§18.3）
) STRICT;

-- 不変スナップショット
CREATE TABLE resource_snapshots (
  id            TEXT PRIMARY KEY,          -- UUID v4
  resource_id   TEXT NOT NULL REFERENCES resources(id),
  revision      INTEGER NOT NULL,          -- resources.next_revision で採番した整数リビジョン（append-only allocator。staleness 比較には使わない。§17.5・§18.5）
                CHECK (revision >= 1),
  source_revision TEXT,                    -- 上流 revision シグナル（Markdown では content 由来。NULL 許容）
  content_hash  TEXT NOT NULL,             -- 正規化内容のハッシュ（revision 判定に使用）
  body_json     TEXT NOT NULL,             -- 正規化済み全文テキスト JSON エビデンス（immutable）
  size_bytes    INTEGER NOT NULL           -- 正規化 UTF-8 バイト数
                CHECK (size_bytes >= 0),
  observed_at   INTEGER NOT NULL,          -- Unix ms（観測時刻）
  created_at    INTEGER NOT NULL,
  UNIQUE (resource_id, revision),
  UNIQUE (resource_id, id),                -- session_references の session 複合 FK 用親キー
  CHECK (json_valid(body_json))
  -- ※ UNIQUE (resource_id, content_hash) は意図的に作らない（§14.2）
) STRICT;

-- セッション内参照 rN
CREATE TABLE session_references (
  id           TEXT PRIMARY KEY,           -- UUID v4
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  ordinal      INTEGER NOT NULL            -- rN の N。sessions.next_reference_ordinal で採番
               CHECK (ordinal >= 1),
  resource_id  TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (resource_id, snapshot_id) REFERENCES resource_snapshots(resource_id, id),
  UNIQUE (session_id, ordinal),
  UNIQUE (session_id, snapshot_id),        -- 同一セッション + 同一 Snapshot の再参照は同一 rN
  UNIQUE (session_id, id),                 -- reference_set_items / evidence_grants の session 複合 FK 用親キー
  UNIQUE (session_id, id, resource_id, snapshot_id)  -- action_proposals の複合 target FK が参照する exact 親キー（§18.3）
) STRICT;

-- 参照集合
CREATE TABLE reference_sets (
  id          TEXT PRIMARY KEY,            -- UUID v4
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, id)                  -- reference_set_items の session 複合 FK 用親キー
) STRICT;

CREATE TABLE reference_set_items (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  set_id       TEXT NOT NULL,
  ordinal      INTEGER NOT NULL             -- 集合内の順序
               CHECK (ordinal >= 1),
  reference_id TEXT NOT NULL,
  PRIMARY KEY (set_id, ordinal),
  UNIQUE (set_id, reference_id),
  FOREIGN KEY (session_id, set_id) REFERENCES reference_sets(session_id, id),
  FOREIGN KEY (session_id, reference_id) REFERENCES session_references(session_id, id)
  -- set と reference が同一 Session に属することを DB レベルで強制する
) STRICT;

-- 永続化・バージョン化されたセッション参照コンテキスト（UI の暗黙 selection）
-- items の各要素が当該 Session の session_references に属することは repository が検証する（FK では強制できない JSON のため）
CREATE TABLE session_reference_context (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  version    INTEGER NOT NULL              -- 楽観的バージョン（CAS 更新）
             CHECK (version >= 1),
  items_json TEXT NOT NULL,                -- 参照 ID の順序付きリスト(JSON)
  updated_at INTEGER NOT NULL,
  CHECK (json_valid(items_json))
) STRICT;

-- EvidenceGrant（提案 DDL・M2 で使用。M1 でテーブルを用意する）
-- 当該 Run でモデルに実際に送られた露出のみを記録する。凍結サマリ・active 所属・過去引用は grant を作らない
-- session 所有権を複合 FK で強制する（runs 側親キー UNIQUE (session_id, id)、references 側親キー UNIQUE (session_id, id)）
CREATE TABLE evidence_grants (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  run_id       TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  exposure     TEXT NOT NULL               -- 'snippet' | 'full'
               CHECK (exposure IN ('snippet','full')),
  created_at   INTEGER NOT NULL,          -- Unix ms
  PRIMARY KEY (run_id, reference_id),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (session_id, reference_id) REFERENCES session_references(session_id, id)
) STRICT;

-- sessions への列追加（CHECK 付き。underflow 拒否は §14.10 で検証）
ALTER TABLE sessions ADD COLUMN next_reference_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_reference_ordinal >= 1);
-- rN 採番は MAX(ordinal)+1 を使わず同一トランザクションで CAS インクリメント（next_turn_position と同型）
```

不変条件（合意由来）:

- すべての M1 テーブルは §9 ブロッカー 7 と同様に **末尾 `STRICT`** とし、JSON 列は `CHECK (json_valid(...))` を持つ。M0 の意味論は変更しない。
- rN の採番は `sessions.next_reference_ordinal` を同一トランザクションで CAS インクリメントして行う（`MAX(ordinal)+1` 禁止）。Snapshot の `revision` は `resources.next_revision` の CAS 採番（`MAX(revision)+1` 禁止）で、短い DB トランザクション内で recheck する。
- `UNIQUE (session_id, snapshot_id)` により「同一セッション + 同一 Snapshot の再参照は同じ rN」が DB レベルで強制される。
- **`UNIQUE (resource_id, content_hash)` は意図的に存在しない**（§14.2）。
- `session_reference_context` の更新は **楽観的バージョニング**: `UPDATE ... WHERE session_id = ? AND version = ?` の CAS で行い、不一致時は競合エラーを返す。selection は UI の暗黙コンテキストであり、Turn 生成時に選択 ID + 順序付き active set を `frozen_context` へ凍結する。
- `evidence_grants` は当該 Run でモデルに実際に送られた露出（snippet / full）のみを記録する。凍結サマリ・active 所属・過去引用だけでは grant を作らない（§15.7）。

### 14.4 Run ライフサイクルとの統合（合意）

- **外部読み取りはトランザクションの外** で行い、短い DB トランザクション内で Run が `running` であることを CAS 再確認したうえで、Resource / Snapshot / SessionReference / ReferenceSet / `reference.presented` イベントの永続化を **同一トランザクションで原子的に** コミットする（§9 ブロッカー 3・5 と整合）。`resources.next_revision` の recheck と採番もこの短いトランザクション内で行う。
- **キャンセル後（cancel_requested / cancelled 確定後）に到着した観測は破棄** され、永続化しない（post-cancel discarded）。
- **キャンセル前に提示済み（永続化済み）の参照は保持される。** rN と Snapshot は不変であり、過去の発言の引用は壊れない。
- `reference.presented` は §9 ブロッカー 5 に従う非 final 拡張イベントとして導入する。

### 14.5 M1 ツール（合意）

`markdown.search` / `kernel reference.open` / `kernel reference.refresh` / `kernel reference.related` は **ToolBroker ツールであり、直接の POST HTTP API は持たない**。実行中の Run の内部からのみ呼び出せ、Run 所有権（当該 Run が `running` であることの CAS 再確認）と予算・監査（§9 ブロッカー 6）に従う。HTTP から直接の検索・再読はできない。

| ツール | 動作 |
| --- | --- |
| `markdown.search` | 設定済みルート配下を **決定論的に** 検索する。通常検索は現在のヒットを発見・更新のために読んでよく、各ヒットは全文正規化 Snapshot を materialize（同一内容なら最新 Snapshot 再利用）し、永続化してヒット（rN / title / snippet / 正規キー）を返す。検索が Snapshot・rN を作らないことはない（§14.2）。これは「すでに参照済みの rN の明示的再読は `reference.refresh` のみ」という規則と矛盾しない（通常検索は発見のための読み取りであり、既存 rN の明示的 reread ではない） |
| `kernel reference.open` | 指定 rN の **保存済み Snapshot のみ** を読んで提示する stored-only。**外部ソースへは一切アクセスしない** |
| `kernel reference.refresh` | **参照済み rN を明示的に再読み取りする唯一の経路**。現在の外部ソースを読み直し、内容同一でも常に新しい観測 Snapshot + 新しい rN を作る（§14.2） |
| `kernel reference.related` | 指定 rN の Snapshot を基点に、保存済みリンクグラフから関連リソースを決定論的に返す（保存済みのみ。再読しない） |

すべて ToolBroker のポリシーパイプライン（§9 ブロッカー 6）を通り、読み取り系として許可される。

### 14.6 Markdown コネクタの決定論的ルール（合意）

- **検索境界値（合意・exact）:** 対象ファイルは vault あたり **最大 10000 件**、1 ファイル **最大 1MiB（UTF-8）**、クエリは **1〜256 Unicode code points**、結果は **default 10 件 / max 20 件**、snippet は **最大 512 code points**。超過ファイルは切り詰めず明示的に skipped / rejected とし（silent truncation なし、§9 ブロッカー 6 と同方針）、対象ファイル数が上限超過の検索は検索全体を失敗させる。
- **正規化と照合（合意）:** テキストは **NFC** に正規化し、**locale 非依存の case folding** で比較する。検索はクエリ全体のリテラル部分文字列照合（whole-query literal substring）のみ。トークン分割・FTS・セマンティック検索は行わない。
- **順序（合意）:** **title 完全一致 → title 部分文字列 → 本文一致** の順とし、同点は **canonical key の tie-break** による stable ソートとする。snippet は **最初の本文ヒット** を含む決定論的抜粋とする。title は先頭見出し（なければファイル名）から導出する。
- **設定済みルート（configured roots）配下のファイルのみ** を対象とする。ルート外は一切読まない。
- エンコーディングは **UTF-8 のみ**。UTF-8 として妥当でないファイルは拒否する。
- **realpath 包含検査**: 実パス（realpath）が設定ルート内に収まることを検証し、読み取り前後で再検証して symlink / TOCTOU すり替えを防ぐ。
- **ファイルシステム安全性（合意・exact）:** いかなるバイト読み取りの前に、検証済み対象を resolve + stat し、利用可能な環境では no-follow で open し、ディスクリプタを fstat して事前検証済み対象との安定したファイル同一性を比較する。一致後のみ読み取り、読み取り後に post-fstat を行う。安定した同一性を確立できないプラットフォームでは symlink traversal を拒否し、構成要素ごとに非 symlink のパスのみを許可する。安全に支援できる範囲で内部エイリアス折り畳みを維持し、ルート外のバイトを決して読まない。
- **外部 symlink の拒否**: ルートの外へ解決される symlink は拒否する。
- **内部エイリアスの折り畳み**: ルート内の同一実ファイルを指す symlink / 別表記は realpath により **同一の CanonicalResource に折り畳む**。
- **絶対パスを露出しない。** CanonicalResource のキー・API 応答・エビデンスにはルート相対の正規キーのみを使う。
- **Snapshot は正規化された全文テキスト** を `body_json` に保持する不変エビデンスとする。revision は `resources.next_revision` 採番の整数とし、`source_revision` / `content_hash` を記録する（§14.2）。
- 対応リンク: **Markdown リンク（相対パスの .md 参照）と Wiki リンク（`[[Target]]`）**。解決は決定論的に行い、**複数候補が一意に定まらない場合は曖昧（ambiguous）として扱い、解決を確定しない**（候補列挙またはエラー）。パーサライブラリの選定と記法バリエーションの厳密範囲のみ未解決（§20 の #4）。
- **展開リンクグラフ予算（合意・exact）:** `markdown.search` / `reference.refresh` の **1 回の呼び出し（search/refresh call）あたり、永続化する正規化グラフメタデータの合計は最大 256KiB（262144 UTF-8 バイト）** とする。**リンク件数の上限（no 1024 link cap）は設けない**（バイト合計に収まる限り任意件数）。課金対象は **正規化メタデータのみ（kind / status / candidates / ordinal）** とし、生 Markdown 本文・URL・wiki target・alias・fragment・title・snippet・絶対パスは課金しない。計量は **1 つのフラットな JSON 配列** の `utf8ByteLength` で行い、エントリのキー順は **`candidates` / `kind` / `ordinal` / `status`** の固定順、ordinal は **文書ごとに 1 から振り直し（per-document ordinal reset）**、candidates は提示順、**同一候補の繰り返しは出現ごとに計数** する。`[]` の素地・カンマ・JSON エスケープ・UTF-8 を exact に含め、**262144 バイトは受理・262145 バイトは拒否** とする。超過は切り詰めず **呼び出し全体を `output_too_large` で拒否し、部分的な DB 永続化は行わない**（no truncation / no partial DB changes）。対象は **Top-K で選ばれたヒットのみ** であり、`reference.open` / `reference.related` は展開せず課金しない。既存の **body 1MiB 制限は変更しない**。

### 14.7 ReferenceResolver（合意）

- 解決は **決定論的な固定優先順位（exact order）** のみで行う:
  1. セッション内いずれかに存在する **明示的 rN**（例: `r3`）
  2. **凍結された選択参照（frozen selected reference）**
  3. 凍結 active set 内の **明示的 ordinal**
  4. **canonical key の完全一致**
  5. **title 完全一致**。凍結 active set 内を先に探し、次にセッション全体の参照を探す。**一意の場合のみ** 解決する
- 一意に解決できない場合は曖昧として扱い、推測しない。
- **Run 開始後の UI 変更は当該 Run の解決に無関係** である（凍結時点が真実）。
- **M1 では意味的代名詞（「さっきのやつ」等）の解決はしない。** M2 の「これ」は選択中参照のサマリ経由でのみ扱う（§15.6）。

### 14.8 参照 API（合意）

- 参照系 HTTP API は **Session スコープの stored-only GET と reference-context のみ** で提供する（検索/open/refresh/related の直接 POST は存在しない。それらは §14.5 の ToolBroker ツールであり Run 内部専用である）:
  - `GET /api/sessions/:sessionId/references`（保存済み参照一覧）
  - `GET /api/sessions/:sessionId/references/:referenceId`（保存済み参照詳細。stored-only）
  - `GET /api/sessions/:sessionId/reference-sets/:setId`（保存済み参照集合）
  - `GET /api/sessions/:sessionId/reference-context` / `PUT /api/sessions/:sessionId/reference-context`（`{ version, items }`。CAS 更新。`items` の全要素が当該 Session の参照であることを repository が検証する）
- GET は stored-only であり、EvidenceGrant も RunEvent も作らない。
- `session_reference_context` の更新は **楽観的バージョニング（CAS）** で行う（§14.3）。バージョン不一致は競合エラー（§12.3 の小文字固定コード方針に従う）。
- **selection はユーザーに可視の独立アクションではない**（§5 の 5 種には追加しない）。UI が暗黙に保持するコンテキストであり、生成開始時に選択 ID + 順序付き active set を Turn の `frozen_context` に凍結する。

### 14.9 M1 の非目標（explicit non-goals・合意）

- 実 LLM / Agent 本実装、応答内引用（rN citation）の生成、CitationVerifier（→ M2）。
- SSE / UI（→ M3）。MCP クライアント / Calendar（→ M4）。
- Markdown ファイルへの書き込み（M1 は読み取り専用）。
- 意味的・ファジー検索、ベクトル検索。意味的参照解決（→ M2）。
- セッションをまたぐ参照の再利用・共有。
- 参照 / スナップショットのエクスポート（§19 で **非目標** と合意。保持は無期限・自動 retention / GC なし）。
- `reference.presented` 以外の新しいイベント型の導入（§9 ブロッカー 5 の非 final 拡張のみ）。

### 14.10 M1 受入テスト（計画）

- **同一性 / DB**: realpath 折り畳みにより同一 CanonicalResource に収束すること（前後再検証・TOCTOU 含む、§14.6 の exact ファイルシステム安全性: resolve+stat → no-follow open → fstat 同一性比較 → 一致後のみ読取 → post-fstat。非対応平台では symlink traversal 拒否 + 構成要素ごと非 symlink のみ）。検索ヒットが全文 Snapshot を materialize し、同一内容の normal 再検索は最新 Snapshot・同一 rN を再利用し、内容変化時は新規 Snapshot/rN となること。refresh が内容同一でも常時新規 Snapshot/rN であり、open が外部再読しないこと。`UNIQUE (resource_id, content_hash)` が存在しないこと。rN 採番が `next_reference_ordinal`、revision 採番が `resources.next_revision` の CAS であること。`sessions.next_reference_ordinal` の `CHECK (>= 1)` が underflow（0 以下）を拒否すること。外部読み取り → 短絡 DB トランザクション（running CAS + 原子 commit）の順序であること。Resource / Snapshot / Reference / ReferenceSet / イベントが同一トランザクションで永続化されること。**session 複合所有権（`resource_snapshots UNIQUE (resource_id,id)`、`session_references` 複合 FK + `UNIQUE (session_id,id)`、`reference_sets UNIQUE (session_id,id)`、`reference_set_items` の session_id + 二重複合 FK、`evidence_grants` の session_id + 二重複合 FK、context items の Session 所属 repository 検証）が強制されること。**キャンセル後の観測が破棄され、提示済み参照が保持されること。`session_reference_context` の楽観バージョン競合が検出され、Run 開始後 UI 変更が無効であること。全 M1 テーブルが STRICT + `json_valid` CHECK であること。
- **セキュリティ**: 設定ルート外・外部 symlink が前後再検証で拒否されること、非 UTF-8 が拒否されること、1MiB 超過が明示 skipped/rejected（無 truncate）であること、10000 件超過で検索失敗すること、絶対パスが露出しないこと、全文 Snapshot が正規化保持されること、リンク曖昧時が未解決扱いであること。
- **検索**: 同一入力に対して結果が決定論的であること。境界値（10000 / 1MiB / 1-256 / default10/max20 / snippet 512）、NFC + locale 非依存 folding、whole-query リテラル、title 完全→title 部分→本文＋canonical-key tie、最初本文ヒットの順序であること。トークン/FTS/セマンティックが存在しないこと。
- **related**: リンクグラフからの関連提示が決定論的であること。
- **展開リンクグラフ予算**: search/refresh の 1 呼び出しあたり正規化メタデータ合計が 262144 バイト以下で受理・262145 バイトで `output_too_large` 拒否となること（件数上限なし、キー順 `candidates`/`kind`/`ordinal`/`status`・文書ごと ordinal reset・繰り返し出現ごと計数・`[]`/カンマ/エスケープ/UTF-8 exact を含む計量）。超過時は無 truncate かつ無部分永続化であること。open/related が展開・課金しないこと。Top-K ヒットのみが対象であり body 1MiB が不変であること。
- **Resolver**: exact order（rN → frozen selected → frozen ordinal → canonical exact → title exact［frozen active 優先・一意のみ］）どおりに解決されること、曖昧 case が推測されないこと、M1 で意味的代名詞を解決しないこと。
- **API**: §14.8 の Session スコープ exact ルート（stored-only GET + reference-context GET/PUT のみ。直接 POST の search/open/refresh/related は存在しないこと）と reference-context CAS（Session 所属検証を含む）が動作すること。

> 本節は計画であり、上記テストは **まだ実装・実行されていない**。

---

## 15. M2 Agent Plan（合意）

> ラベル: **合意（agreed）**。M2（ローカルモデル接続 + AgentStrategy + Citation）の実装計画として合意した内容を記録する。本書は計画のみであり、M2 の実装・テストは **まだ行われていない**。DDL・イベント型名・エラーコード名は提案表記のまま実装時に微調整しうるが、不変条件・予算・所有権境界は合意事項に従う。

### 15.1 M2 のスコープ（合意）

- M2 で追加するパッケージは **`packages/model-local` のみ**。`apps/server` / `packages/contracts` / `packages/kernel` は既存のまま依存として使い、M0/M1 の決定（§6・§9・§14）を変更しない。
- **AgentStrategy（Agent）は kernel 内の RunStrategy として実装する**（新パッケージを作らない）。Run の所有権は RunEngine にあり、Agent は所有権を持たない（§3）。
- M2 に含まれないもの: **UI / SSE（M3）、MCP クライアント / Calendar（M4）、書き込み系アクション + 承認（M5）**。意味的参照解決・セマンティック検索も M2 では行わない。

### 15.2 ModelGateway 契約と capabilities（合意）

- `packages/model-local` が **ModelGateway** を提供する。AgentStrategy は ModelGateway のみを経由し、プロバイダ固有 SDK / HTTP を直接知らない。
- **ネイティブ tool calling をサポートするモデルのみ対応する。** モデル・アダプタは capabilities を申告し、ネイティブ tool calling 非対応モデルは登録時に拒否する。プロンプト解析によるツール呼び出しのエミュレーションは行わない。
- アダプタは **Ollama と OpenAI 互換 API の 2 種のみ**。両アダプタとも **loopback（127.0.0.1 / localhost）のみ** に接続する。**ネイティブ Tool Calling のみ** を使用する。設定は loopback ベース URL のみを表現でき、それ以外のホスト・クラウドへの接続は検証で拒否する。**HTTP リダイレクトは追跡せず拒否する**（リダイレクト・プロキシ・DNS 解決結果が loopback 外になる経路での外部流出を防止）。
- **シークレット扱い**: 認証情報が不要なローカル利用が前提。認証情報を与える場合でも、ログ・run_events・監査・エラー・ModelGateway の例外に **一切含めない**（redaction は §12.4 の単一レイヤを通る）。
- **M2 にモデル自動リトライ・フォールバック・ルータは存在しない**（§15.11）。

### 15.3 `answer.submit` 端末プロトコル（合意）

- 構造化回答の提出用に予約済みツール **`answer.submit`** を定義する。**`answer` は予約 namespace** であり、他の tool が `answer.*` を登録・呼び出すことはない。
- **`answer.submit` は ToolBroker を経由しない予約済み非 Broker 端末プロトコルであり、AgentStrategy が解釈する。** Run を完了させる唯一の正常経路である。1 回のみ有効（one-only）。
- **`answer.submit` は ToolBroker のポリシー予算の対象外**（`runs.tool_requests_used` を消費しない）。ToolBroker は通常ツールの境界のまま変更しない。
- **free text による JSON fallback は存在しない。** モデルが自由テキストで JSON を書いても回答としては解析・受理しない。

### 15.4 プロバイダ応答の正規化（合意）

ModelGateway はプロバイダ応答を正規化し、1 モデルステップの結果を次のいずれかに分類して AgentStrategy に返す:

| 分類 | 扱い |
| --- | --- |
| 通常 tool 呼び出しのみ | ToolBroker のポリシーパイプラインで実行し、結果を次ステップのモデル入力へ |
| `answer.submit` のみ | AgentStrategy が受理し、Citation 構造ゲート（§15.7）へ進む |
| 通常 tool + `answer.submit` の混合 | **不正応答として扱う**。`answer.submit` は受理せず、repair（§15.8・1 回限定）を促す |
| 同一ステップ内の複数 `answer.submit`（重複回答） | **不正応答として扱う**。いずれも受理せず repair を促す |
| free text のみ | **回答として受理しない**。構造化提出を促す repair を促す |

- **repair は Run あたり 1 回のみ（one repair max）**。repair も含むすべての generateTurn 呼び出しはモデルステップ予算（§15.5 の max 8・wall 300s）を消費する。repair は subtype の制限であり、9 回目の呼び出しにはならない（never a ninth call）。repair 後も `answer.submit` が得られなければ Run は **failed**（固定・redact 済み error code）になる。

### 15.5 Agent ループの所有権境界と予算（合意）

- Agent は RunStrategy であり、**ループの進行は Run の durable 状態（status / event_seq / 予算列）と CAS 契約（§9 ブロッカー 3）に従う**。Agent が状態を直接書き換える経路は持たない。
- 予算（合意値）:

| 予算 | 値 |
| --- | --- |
| モデルステップ | 8 / Run（repair を含むすべての generateTurn 呼び出しが消費。repair は subtype であり 9 回目にならない） |
| `answer.submit` repair | 1 / Run（§15.4。予算内の subtype 制限） |
| モデル 1 ステップ | 120 秒（step timeout） |
| Run 全体 wall time | 300 秒（すべての generateTurn 呼び出しを含む） |
| ツール予算 | §9 ブロッカー 6 の既定値をそのまま使用（`answer.submit` は対象外） |

- **並列 tool 呼び出しの物理同時実行は最大 3**（per-run 同時実行上限と一致）。モデルの Tool 呼び出しはすべて予算内で処理し、最大物理同時実行 3 にキューイングして実行し、結果は要求順に返す。**件数が 3 を超えることだけを理由に破棄しない。** 順序は保持する（モデルに返す結果の順序 = 要求順）。
- **キャンセルは AbortSignal で行う**: モデル呼び出し・ツール実行を中断し、DB コミット → AbortSignal の順序（§9 ブロッカー 3）を厳守する。**CAS により terminal 後の遅延出力の commit は拒否され破棄される。**

### 15.6 プロンプト構成（合意）

- **システム指示は最小構成の固定テキスト**（決定論的。長大な role 指示や動的生成の指示を注入しない）。システムプロンプトとデータの境界を保持する（外部データを system 指示として再構成しない）。
- 履歴は **選択済み完了 Run の結果のみ**（§9 ブロッカー 2・§11.6）。未選択 / failed / cancelled / abandoned の Run、tool イベント、生プロバイダ応答は履歴に含めない。
- 参照コンテキストは Turn の `frozen_context` に凍結された session reference context（§14.2）の **構造サマリ（title / rN 等）のみ** を与える。**スナップショット全文の自動注入はしない。** モデルは必要に応じ **`kernel reference.open`（§14.5）で rN を on demand に開く**。凍結サマリ自体は EvidenceGrant を作らない（§15.7）。
- M2 の「これ」は選択中参照の凍結サマリ経由でのみ扱い、意味的照合・推測は行わない（§14.7）。

### 15.7 EvidenceGrant と Citation 構造ゲート（合意）

- **当該 Run + 参照ごとに EvidenceGrant を永続化する（`evidence_grants`、§14.3）**: その Run でモデルに実際に送られた rN と、各 rN の **露出形態（snippet / full）** を記録する。
- **凍結 title / rN サマリ、active 所属、過去引用だけでは grant を作らない。** 検索は実際に snippet をモデルへ送ったときに限り snippet grant を作り、`kernel reference.open` は内容をモデルへ送ったときに限り full を作成・upgrade する。送られていない露出は記録しない。
- **引用には当該 Run の grant が必須**（current-run grant required）。他 Run の grant・凍結サマリのみでは引用不可。
- **露出形態の既定は snippet。** `kernel reference.open` で開き内容を送った rN は full を許可し、grant に記録する。
- Citation 検証（CitationVerifier）は **構造ゲートのみ**: StructuredAnswer の citations が **当該 Run の EvidenceGrant に存在する rN であり、露出形態と整合する**こと等の構造的整合のみを検査する。**意味的事実検証（引用がその主張を実際に支持するか）は行わない・主張しない（structural only, never semantic truth）。**

### 15.8 StructuredAnswer の制限と失敗扱い（合意）

- **StructuredAnswer の exact 境界値（合意）:** parts **1〜20**、text **1〜4000**、citations **0〜8**、全体 **16KiB**。超過は切り詰めず拒否する（silent truncation なし、§9 ブロッカー 6 と同方針）。
- citations は **当該 Run の EvidenceGrant 内の rN のみ**有効。範囲外・未知の rN は無効である。
- **不正 citation は silent drop しない。** 無効 citation を含む提出は受理せず、**repair（1 回限定、§15.4）** を促す。repair 後も無効なら Run は **failed**（固定 error code。fixed failure）。
- citations は一般会話では optional であり、引用なし回答を妨げない。

### 15.9 Tool Result の信頼境界とプロンプトインジェクション防御（合意）

- **モデル向け Tool Result は untrusted データとして扱う。** 外部データ由来のテキストを指示として信用しない。
- 防御は **構造的** に行う: 参照は rN / スナップショット経由のみ、モデル向け出力サイズ・観測上限（§9 ブロッカー 6）、システム指示とデータの分離（外部データを system 指示として再構成しない）、free text JSON fallback なし（§15.3。外部データに回答形式を捏造させない）。
- **テキスト sanitization で解決すると主張しない**（§9 ブロッカー 6 と同方針）。

### 15.10 監査・イベント・エラー（合意）

- **`model_calls` 監査テーブルを追加する（提案 DDL。metadata-only）**: `run_id` / model step 番号 / adapter / model 識別子 / outcome / error_code / 所要時間 / 利用可能なら usage サマリ / created_at。**プロンプト本文・生のモデル出力・reasoning・シークレットは保存しない。** テーブルは STRICT + `json_valid`（JSON 列がある場合）とし、M0 意味論は変更しない。
- **型付きモデルイベントを非 final 拡張として追加する**（§9 ブロッカー 5）: `model.step.started` / `model.step.completed` / `model.step.failed`。**いずれも Agent Run に属し、Action Run には属さない。** payload は構造サマリのみで、生の出力を含まない。
- エラーは **固定・redact 済みの小文字コードの家族**（例: `model_unavailable` / `model_step_timeout` / `answer_invalid` / `citation_invalid`。例示であり家族は固定）。生エラー・プロンプト・reasoning を含めない。
- **AbortSignal による中断と CAS による遅延出力破棄** で late-output を防ぐ（§9 ブロッカー 3・§15.5・§15.11）。

### 15.11 リトライ・フォールバック・キャンセル（合意）

- **M2 にモデル自動リトライ・フォールバック・ルータは存在しない。** モデル呼び出し失敗は Run を failed にするか、§15.4 の回答 repair（1 回限定）のみで扱う。
- キャンセルは既存契約どおり（§9 ブロッカー 3・11.2）: DB commit 先行 → AbortSignal、CAS により terminal 後の遅延出力は破棄。

### 15.12 M2 テスト計画（合意）

- **CI はモック ModelGateway（決定論的なスクリプト応答）のみを使用し、実モデルに依存しない。**
- **live テストは opt-in**（明示的な有効化 + loopback 上の実サーバーが必要）。CI では実行しない。
- 受入テスト（合意済み一覧）:
  - ModelGateway: ネイティブ tool calling 非対応モデルの拒否、loopback 外・リダイレクト・クラウドの拒否、シークレットがログ/監査/例外に現れないこと。
  - `answer.submit`: 単独提出の受理、ToolBroker 非経由・予算不消費、`answer` namespace の予約、one-only、free text JSON fallback が存在しないこと。
  - 応答正規化: 通常 tool のみ / `answer.submit` のみ / 混合・重複・free text の不正扱い、repair 1 回限定（予算内 subtype・9 回目なし）と repair 後失敗の failed 遷移。
  - 予算: 全 generateTurn 呼び出しが max 8 ステップ・wall 300s・step 120s を消費すること、既存ツール予算の遵守、物理同時実行 3 へのキューイング・要求順返却・件数超過のみでの破棄なし。
  - プロンプト: 最小システム指示・境界保持、選択済み完了 Run のみ投影（未選択/失敗系・tool イベント・生応答の除外）、frozen 参照サマリのみ、`reference.open` の on demand 動作、「これ」の選択サマリ扱い。
  - EvidenceGrant / Citation 構造ゲート: 当該 Run grant 外 rN の拒否、snippet（送信時のみ）/ full（送信時のみ作成・upgrade）の整合、凍結サマリ・所属・過去引用での非付与、意味検証を行わないこと。
  - StructuredAnswer: exact 境界（parts 1-20 / text 1-4000 / citations 0-8 / 全体 16KiB）、不正 citation の repair → fixed failed、silent drop なし、一般会話での citations optional。
  - untrusted Tool Result 境界と構造的注入防御の動作。
  - `model_calls` 監査: metadata-only（生データ・プロンプト・reasoning・シークレット非保存）、STRICT 準拠、型付きモデルイベント、固定 error 家族。
  - キャンセル: AbortSignal による中断、CAS による後着出力の破棄。
  - 非目標の不在確認: 自動リトライ / フォールバック / ルータなし、UI / SSE なし。
- **CI はモック HTTP の ModelGateway（決定論的なスクリプト応答）のみを使用し、実モデルに依存しない。live は opt-in。**

### 15.13 M2 の非目標（explicit non-goals・合意）

- UI / SSE（M3）、MCP クライアント / Calendar（M4）、書き込み系アクション + 承認（M5）。
- 意味的参照解決（§14.7 の先送り事項を含む）、意味的事実検証、セマンティック検索 / RAG / ベクトル DB。
- モデル自動リトライ・フォールバック・ルータ、複数モデル最適ルーティング。
- free text JSON fallback、テキスト sanitization による注入対策。

### 15.14 ロードマップ残部のサマリ（確定しない）

> ラベル: **サマリのみ。本節の内容は確定事項ではない。** ※ M3（UI + SSE）は §16、M4（MCP Client + Calendar）は §17、**M5（Actions + Approval）は §18 でいずれも合意済み** のため本節から除いた。v0.2（M5）以降の範囲は確定しておらず、着手時に詳細計画を別途合意する。

---

## 16. M3 Conversation UI + SSE Plan（合意）

> ラベル: **合意（agreed）**。M3（Conversation UI + SSE）の実装計画として合意した内容を記録する。本書は計画のみのドラフトであり、M3 の実装・テストは **まだ行われていない**。可視コントロール・データ保持・描画方針・SSE/履歴/Retry/Stop の exact 契約・リデューサ・リカバリ・セキュリティ方針は合意事項であり、実装時の調整対象ではない。調整対象は esbuild チューニング等の実装レベルのみ（§20）である。

### 16.1 M3 のスコープと技術構成（合意）

- M3 で **新規パッケージは作らない。UI は `apps/server` 内に置く。** M0〜M2 の決定（§6・§9・§14・§15）は変更しない。
- サーバー側の描画は **Hono JSX による SSR**。クライアント側は **vanilla TypeScript（DOM API のみ）** を記述し、**esbuild でバンドル** して静的配信する。
- **React / Vue / Vite / 状態管理フレームワーク等のフレームワーク・UI ライブラリは一切使わない。** UI 状態は **Run 単位に直列化された自前 reducer**（§16.4）+ 最小限の DOM 更新で管理する。reducer 以外の状態層を作らない。

### 16.2 Conversation First の可視コントロール（合意）

- ユーザーに見える通常操作は次の **5 種のみ**（§5 と整合。5 番目は M5 で条件付き追加）:
  1. **メッセージ送信（send）**
  2. **文脈的な停止（contextual stop）** — active Run（queued / running / cancel_requested）が存在するときのみ表示
  3. **引用を開く（citation drawer）** — 回答の rN citation ボタン → スナップショット表示
  4. **失敗時のみの再試行（failure-only retry）** — `failed` / `abandoned` の表示に対してのみ
  5. **（M5〜条件付き）承認 / 拒否（approve / reject）** — pending かつ有効期限内の Proposal があるときのみ表示される承認カード上のボタン（§18.9）。M3 では UI プレースホルダを作らず、契約のみ予約する。
- **技術的概念は UI に露出しない。** Turn / Run / Tool / モデル / コネクタ / セッション管理の UI は存在しない（§2 原則 1・§5）。内部イベントの人間可読写像は固定:
  - `run.queued` / `run.started` →「生成中」、内部詳細なし
  - `tool.requested` / `tool.completed` → 可視変化なし（「生成中」継続）
  - `run.completed` → 回答表示 + 引用ボタン
  - `run.failed` / `run.abandoned` → 失敗表示 + failure-only retry
  - `run.cancelled` / `cancel_requested` →「停止しました」（retry 提示なし）
  - `reference.presented` / `model.step.*` → 可視変化なし（将来の非 final 拡張も同様。未知 type は無視、§16.4）
- **セッションは自動初期化する。** ユーザーにセッション作成操作を見せず、クライアントが起動時に `POST /api/sessions`（検証済み Idempotency-Key、scope `sessions:create`、§9 ブロッカー 4）を自動発行する。
- **ブラウザ側の永続化は最小限に限定する（合意・exact）:** 保存してよいのは **sessionId・per-run Run カーソル（seq）・pending（未送信）の Idempotency-Key のみ**（localStorage）。**会話本文・参照内容・モデル/ツール関連の状態はブラウザに保存しない。**
- **楽観的送信（optimistic message send・合意）:** 送信時にユーザーメッセージを UI に即時反映し、`POST .../messages` の **同一 Idempotency-Key でのリプレイ**（§9 ブロッカー 4）により再送の安全性を担保する。応答が得られない場合も **同じ key で再送** する（key + 正規化リクエストが同一である限り replay される）。

### 16.3 1 セッション 1 active Run の挙動（合意）

- セッションに active Run がある間も **入力（タイピング）は可能だが、送信ボタンは無効** にする（type-while-active, submit-disabled）。
- **メッセージキューは存在しない。** 入力途中のテキストを自動送信する仕組みや、送信の滞留キューを作らない。ユーザーは active Run が消えたあとに改めて送信する。
- active Run の一意性は DB の部分一意インデックス（§10）で強制されており、UI はこれに依存する（競合時は 409 `session_busy` を表示に写像）。

### 16.4 SSE 配信とイベント処理（合意）

- **SSE ルート（exact・合意）:** `GET /api/sessions/:sessionId/runs/:runId/events/stream`。Session 所有権を強制し（他 Session の Run は 404）、`runId` が当該 Session に属さない場合は所有権エラーとする。
- **カーソル決定（exact・合意）:** effective カーソル = `max(クエリ ?after として検証された値, 有効な `Last-Event-ID` ヘッダ)`。無効値（非整数・0 以下）は無視する。有効な `after`/`Last-Event-ID` のみ採用し、最大値を取る。
- **SSE ワイヤ形式（exact・合意）:** SSE `id` = per-run `seq`（文字列）、`event` = `run-event` 固定、`data` = **完全な RunEvent DTO**（`schemaVersion` / `runId` / `seq` / `type` / `createdAt` / `payload` を含む JSON 1 行）。`event` に内部型名を入れない。
- **サーバーループ（exact・合意）:** SQLite の **250ms poll** により `run_events` への追記を検知して流す。**15s ごとに `:` コメント heartbeat** を送る。書き込みは backpressure を尊重し **`await` する**。**有界でないキューは持たない。** 遅いクライアントには **5s の backpressure 猶予** の後にのみ接続を閉じる（5s 以内は待つ）。複数クライアントの同一 Run 接続をサポートする。**切断は Run を決してキャンセルしない。**
- **ストリーム終了条件（exact・合意）:** Run が **terminal かつクライアントのカーソルが `runs.event_seq` に到達（`cursor >= event_seq`）** したときにのみ正常終了する。terminal 前には閉じない。
- 配信契約の基礎は §9 ブロッカー 5 どおり: M0 の JSON API と **同一 DTO・同一 seq ID**、DB カーソルによる tail / replay。
- **カーソル復元:** 接続（再接続）時にブラウザ保存の Run カーソルから再開する。カーソルがない場合は履歴 + `after` なしの初回取得から同期する。
- **クライアント reducer（exact・合意）:** **Run 単位に直列化** して適用する（同一 Run のイベントは順序どおりに 1 つずつ処理し、並行適用しない）。**重複 `seq` は無視** する。**未知のイベント type はカーソルだけ進めて無視** する（クラッシュ・エラー表示なし。将来の非 final 拡張に備える）。**`seq` の gap を検知した場合は M0 の JSON ページネーション API（`GET .../events?after=`、§12）で catch-up** を行い、gap を埋めてから SSE を継続する。**カーソルは reducer 適用後にのみ永続化** する（適用前の永続化禁止）。
- **ユーザー可視イベントの正確なマッピング（合意）:** §16.2 の固定写像表どおり。

### 16.5 安全な描画（合意）

- **StructuredAnswer は安全にレンダリングする:** ユーザー入力・回答本文・Snapshot 表示はいずれも **プレーンテキストとしてエスケープして表示** する。**Markdown の HTML 解釈・HTML の生成・`innerHTML` の使用は一切しない。**
- **citations はボタンとして表示** し、クリックで引用ドロワーを開く（rN → 保存済みスナップショットの表示）。
- **スナップショットドロワーはプレーン・エスケープ表示のみ。** 外部データ由来の文字列から HTML を構築しない。これは §9 ブロッカー 6・§15.9 の「テキスト sanitization で解決すると主張しない / 構造的防御」方針と整合する。
- **参照コンテキストの focus / version 挙動（合意）:** `session_reference_context` は UI の暗黙コンテキスト（§14.2・§14.3・§14.8）。UI は参照のフォーカス（暗黙 selection）を **楽観的バージョニング（CAS・`{ version, items }`）** で更新し、バージョン競合時は競合エラーを表示したうえで最新版を再取得する。メッセージ送信時は **選択された参照をメッセージに凍結** する（Turn の `frozen_context` へ選択 ID + 順序付き active set として凍結、§14.2）。selection は独立した可視アクションにはしない（§14.8）。
- **refresh は conversation-only（合意）:** 参照の更新（`kernel reference.refresh`、§14.5）は **会話の文脈の中でのみ** 行い、独立した参照管理 UI を作らない。refresh は常に新しいスナップショット + 新しい rN を作る（§14.2）。旧 rN・過去の引用は壊れない。

### 16.6 Retry / Stop / 履歴（合意）

- **Retry は失敗時のみ（failure-only retry・exact）:** `run.failed` / `run.abandoned` の表示に対してのみ「もう一度生成」を提示する（§5: 内部は同一 Turn への新しい Run）。API は既存契約どおり `POST /api/sessions/:sessionId/turns/:turnId/retries`（Idempotency-Key scope `turn:{turnId}:retry`、Turn が Session に属し active Run がなければ許可、§9 ブロッカー 4・§12.1）。成功・実行中・キャンセル済みの回答に対する retry ボタンは出さない。
- **Stop は文脈的（contextual stop・exact）:** active Run（queued / running / cancel_requested）があるときのみ停止を提示し、既存 cancel API（`POST /api/sessions/:sessionId/runs/:runId/cancel`、キーレス / state-idempotent、DB コミット先行 → AbortSignal、grace 3000ms、§9 ブロッカー 3・§12.1）を呼ぶ。queued への cancel が直接 `cancelled` になる挙動もそのまま写像する。**通常生成 Run の Stop 規則は変更しない。Action Run の Stop 可用性は §18.6 の取消境界に従う: 外部マーカー前（queued / preflight）のみ Stop を提示し、マーカー commit 後は Stop を非表示/disabled とする（非 terminal の Cancel API は `409 action_not_cancellable`。terminal は 200 現在状態返却）。**
- **履歴はカーソルページネーション（exact・合意）:** `GET /api/sessions/:sessionId/history?beforePosition=&limit=`。`beforePosition` は **排他的**（`position < beforePosition` のみ返す）。`limit` は **default 50 / max 100**。**直近を取得してから時系列（chronological）順に返し**、`nextBefore` / `hasMore` を返す。投影は `input_json.kind` 別（§11.6）: `user_text` はユーザーメッセージ + 選択完了結果、`action_approval` は承認意図 + ActionRun receipt、`action_rejection` は Run なしの拒否意図。通常 UI に技術 ID を出さない。選択のない Turn は「応答なし」、生成中・失敗はイベント側の状態で表現する。M5 の `action_rejection` Turn の投影は §18.4 に従う。

### 16.7 SSE リカバリとセキュリティ・テスト（合意）

- **再接続時のリカバリ（合意）:** **ネイティブ `EventSource` の自動再接続**（polyfill・ライブラリなし）では、保存済みカーソル（`Last-Event-ID` として送られる seq）から再購読し、欠番は JSON API catch-up（§16.4）で埋める。**加えて JSON status フォールバック** を持つ: SSE が確立しない場合は `GET .../runs/:runId/events` + history のポーリングで状態を復元する。**破損したカーソル（非整数・負・event_seq を大きく超過する等）を検出した場合は無限再接続を停止** し、履歴からの再同期に切り替える。サーバー再起動等で SSE が切れても **Run 自体は durable でありキャンセルされない**。abandoned への遷移（再起動時 recovery、§11.2）は失敗扱い表示 + retry として写像する。
- **ブラウザリロード後の再送リカバリ（内容保存なし・合意・exact）:** ブラウザに保存してよいのは sessionId・Run カーソル・pending の Idempotency-Key のみであり、**本文・スナップショットを保存しない**。ページが生きている間は同一のメモリ内正規化 body/key で再送する（§9 ブロッカー 4 の replay）。リロード後は `GET /api/sessions/:sessionId/idempotency/:key?scope=`（Session スコープの lookup）に問い合わせ、受理済みなら保存済み status/body を返して履歴を再取得し、key 不在なら再作成せず固定の resend-required 表示（再入力を促す）とする。受入テスト: lookup の Session 所有権、受理時の status/body 再生 + 履歴 refresh、不在時の再作成なし + resend-required、本文/スナップショットの非保存。
- **セキュリティ（合意・exact）:**
  - サーバーは **loopback バインドのみ**（§12.4 と整合）。
  - **Strict Host 検証** を行う。
  - ブラウザからの mutation（POST / PUT 等）は **same-origin の `Origin` のみ受理** する。**`Origin: null` は拒否** する。**`Content-Type: application/json` を要求** する。**CORS は無効（許可しない）**。`Origin` が欠落したリクエストは **ローカル CLI 経路のみ** 許容する。
  - **厳格な CSP を設定する**（esbuild バンドル済みの自前静的アセットのみ読み込む方針。インラインスクリプト・外部オリジンを禁止する）。
  - **XSS 防御は構造的に行う:** エスケープされた描画のみ、`innerHTML` 不使用、外部データ由来の HTML 生成なし（§16.5）。
- **Hono JSX / クライアントビルド:** サーバーは Hono JSX で SSR し、クライアント TS は esbuild でバンドルして静的配信する（§16.1）。
- **E2E は Playwright の fake E2E**（実 LLM・実 MCP・実 Calendar なし）で検証する。主要フロー: 送信（楽観反映・同一 key replay）→ 生成中（type 中 submit 無効）→ 回答表示 → 引用ドロワー → 停止 → 失敗 → failure-only retry、および SSE 切断・再接続のカーソル復元（重複 seq・gap catch-up・破損カーソル停止）。

### 16.8 M3 の非目標（explicit non-goals・合意）

- **トークン単位のストリーミング**（`assistant.delta` 等は v0.1 に存在しない。§9 ブロッカー 5。回答は `run.completed` の StructuredAnswer 単位で表示する）。
- **WebSocket**（双方向通信は使わず SSE + JSON API のみ）。
- **UI フレームワーク・状態管理ライブラリの導入**（React / Vue / Vite / 状態ライブラリ等、§16.1）。
- **リモートアクセス・認証**（§8 の非目標どおりローカル専用・loopback のみ）。
- **アバター・音声**（テキスト会話 UI のみ）。
- 技術概念の露出（Run / Tool / モデル / コネクタ / セッション管理 UI、§16.2）。
- メッセージキュー・送信の自動滞留（§16.3）。

---

## 17. M4 MCP Client + Calendar Plan（合意）

> ラベル: **合意（agreed）**。M4（MCP クライアント + Calendar 読み取り参照）の実装計画として合意した内容を記録する。本書は計画のみであり、M4 の実装・テストは **まだ行われていない**。パッケージ分割・所有権境界・許可モデル・binding  identity・`calendar.search` exact 入力・正規化 Snapshot・revision 優先順位・接続ライフサイクル・トランスポートセキュリティは合意事項であり、実装時の調整対象ではない。調整対象は公式安定 SDK の exact pin と特定上流 binding の互換性 spike のみ（§20 の #2）。

### 17.1 M4 のスコープとパッケージ分割（合意）

- M4 で追加するパッケージは **2 つ**: `packages/connector-mcp` と `packages/connector-calendar`。
- **`connector-mcp` は MCP のトランスポートと接続ライフサイクルのみを所有する。** MCP プロトコルのトランスポート（stdio / Streamable HTTP）と接続の確立・維持・再接続・シャットダウンが責務であり、Calendar の意味論・正規化は一切知らない。
- **`connector-calendar` が Calendar の意味論と正規化を所有する。** `connector-mcp` を下位のトランスポートとして使用し、Calendar ツールのバインディング・入力契約・応答の解釈・正規化・Snapshot 化を担う。
- M0〜M3 の決定（§6・§9・§14・§15・§16）は変更しない。Calendar 参照は M1 と同一の 3 層参照モデル（CanonicalResource / 不変 Snapshot / rN、§4・§14.2）に従う。
- M4 に含まれないもの: 書き込み系アクション + 承認（M5）。**M4 では書き込みを一切行わない（no writes）。**

### 17.2 依存スパイクと SDK の確定（実装時）

- **MCP クライアント SDK は M4 冒頭の spike で選定する。** 対象は **公式の安定版 SDK のみ**。spike の成果物は (1) 採用する **安定版の公式 SDK の正確なパッケージ名・バージョン（exact pin）**、(2) **特定の上流 Calendar MCP バインディングとの互換性確認（upstream binding spike のみ）** である。本書では確定値を決定しない（§20 の #2）。
- spike が公式 SDK の安定版と互換性を確認できない場合、M4 の着手を再協議する（独自 MCP 実装へ場当たり的に移行しない）。

### 17.3 MCP サーバー定義と許可モデル（合意）

- **MCP サーバー定義は config のみ**。実行時に動的に MCP サーバーを発見・追加する仕組みは持たない。
- **明示的な allowlist による binding のみ** を ToolBroker に登録する。MCP サーバーから発見されたツール（tools/list の結果）を **自動的にモデルへ露出することは禁止** する。露出は config に明記された allowlist binding に限る。
- **binding identity（合意・exact）:** 各 binding は `connectorInstanceId` / `serverId` / `kind` / `version` で識別する。`initialize` / `tools/list` 時に、**設定された正確な上流ツール名（exact configured upstream tool names）と正規入力スキーマのハッシュ（canonical input-schema hash）** を検証し、不一致なら binding を無効化する。
- **書き込み系ツールの露出は禁止**（M4 no writes。§9 ブロッカー 6 の default-deny と整合）。allowlist は読み取り系 binding のみを含む。
- allowlist 外の MCP ツールは呼び出し経路自体を持たない（未登録）。

### 17.4 Calendar バインディング / 正規化契約（合意）

- **`structuredContent` 優先（合意）:** MCP tool result は `structuredContent` を第一のデータ源とする。得られた場合はそれを正規化する。
- **strict な契約 JSON テキストのみ fallback（合意）:** `structuredContent` が得られない場合は **事前に合意した契約スキーマに対する strict 検証に通った JSON テキスト** のみを fallback として受理する。検証に失敗した応答はエラーとする。
- **ヒューリスティックな散文解析は禁止。** 応答の prose（自由テキスト）を解析してデータを復元しない。**prose ヒューリスティックは一切行わない**（§15.3 の free text JSON fallback なしと同方針）。
- **`calendar.search` の exact 入力契約（合意）:** `query`（optional）/ `start`（ISO 必須）/ `end`（ISO 必須）/ `limit`（**default 10 / max 20**）/ `cursor`（不透明、optional）。`start < end` を要求し、**range 最大 90 日**。**1 回の呼び出しで 1 ページのみ** を返し、**自動 pagination はしない**（§17.5）。ToolBroker のポリシーパイプラインを通るため監査可能である。
- **frozen Turn temporal context（合意）:** 検索・参照に使う **now / timeZone は当該 Turn 生成時に凍結された元の temporal context（frozen context の一部、§9 ブロッカー 2）から取る**。Turn は不変であり、**Retry（同一 Turn への新 Run）でも元の値を再利用し、再計算・書き換えしない**（同一 Turn のすべての Run は同一の now / timeZone を使う）。timeZone は IANA 名のみ。Turn / Retry の不変契約（§9 ブロッカー 2・3）は変更しない。
- **canonical resource identity（合意・exact）:** Calendar イベントの CanonicalResource は **`connectorInstanceId` + `calendarId` + `eventId` から決定論的に導出される正規キー** で同一性を持つ。同じイベントの別時点は同一 canonical の別 Snapshot になる（§4・§14.2）。キーには絶対パス・機微な URL を露出しない。
- **正規化 Snapshot の項目と privacy exclusions（合意・exact）:** 正規化済みイベント Snapshot は次のみを持つ: **`status`（`confirmed` / `tentative` / `cancelled` / `deleted` のいずれか）/ `title` / optional `description` / optional `location` / `start`・`end`（時刻付き timed または終日 all-day）/ `sourceUpdatedAt`**。**終日（all-day）の `end` は exclusive** とする。sensitivity は **personal 固定** とする。**除外（exclusion・合意）:** **参加者リスト・メールアドレス、主催者（organizer）、会議 / 参加 URL（conference / join URLs）、HTML リンク、生の MCP 応答** は Snapshot に含めない。

### 17.5 revision / 再利用・refresh / tombstone / ページネーション（合意）

- **revision の優先順位（revision precedence・exact・合意）:** 同一 canonical の revision 判定は、(1) **etag** → (2) **source 更新時刻（source updated）** → (3) **正規化内容ハッシュ（normalized hash）**、の **固定優先順位** で行う。上流シグナルの正確な対応は上流バインディング互換性 spike（§17.2）で確定する。
- **ローカル `resource_snapshots.revision` と source revision key の区別（合意）:** ローカルの整数 `revision`（`resources.next_revision` の append-only allocator）は常に新規採番され、**staleness 比較には決して使わない**。staleness 比較に使うのは **source revision key = `source_revision` があればそれ、なければ `content_hash`** であり、M5 の `ActionProposal.expectedRevision` はこの key を意味する（§18.3・§18.5）。preflight は権威ある観測の key と比較してから materialize し、`reference.refresh` の常時新規 Snapshot/rN（§14.2・§14.5）とは別処理であるため、通常 refresh のたびに stale と誤判定することはない。
- **再利用 / refresh は §14.2 と同一:** 同一セッションで同一 revision の再参照は同一 Snapshot・同一 rN を再利用する。明示 refresh（`kernel reference.refresh`、唯一の再読経路、内容同一でも常時新規 Snapshot/rN）は §14.5 どおり。
- **削除済みイベントの tombstone Snapshot（合意・exact）:** 参照済みイベントが上流で削除されていた場合、**削除を示す tombstone Snapshot（`status: deleted`）を新しい観測として作成する**。**tombstone を作るのは権威ある get / refresh で削除を確認したときのみ** であり、**search での omission（検索結果に現れないこと）では作らない**。canonical・旧 Snapshot・旧 rN は消さず、過去の引用は壊れない。tombstone は観測時（refresh / get 等）にのみ生成し、予測的な全件走査はしない。
- **1 ページ + 明示 cursor（合意）:** `calendar.search` は **1 回の呼び出しで 1 ページのみ** を返し、続きは **明示的な cursor** を使った後続呼び出しでのみ取得する。**自動的な全ページ走査はしない**（続きの取得は §9 ブロッカー 6 の予算・観測上限の内で明示的に行う）。

### 17.6 接続ライフサイクル（合意）

- **lazy かつ永続的な接続:** MCP 接続は **初回のツール使用時に確立（lazy）** し、以後は永続的に再利用する。対象トランスポートは **stdio と loopback Streamable HTTP**。
- **アプリ起動をブロックしない:** MCP サーバーが利用不能でも **アプリ全体の起動失敗にはしない**。該当ツールが未利用のまま起動を完了する。
- **demand-driven な再接続 + backoff（exact・合意）:** 切断時は **次にツールが要求された時点で再接続** し、連続失敗時は backoff **`1s / 2s / 5s / 10s / max 30s`** を適用する。
- **論理 Tool Call の自動再送はしない:** 接続断・再接続が起きても **同一の論理ツール呼び出しを自動再送しない**（**同一 logical への再送なし**。§9 ブロッカー 6 の「論理 Tool の自動リトライなし」と同一）。呼び出しはエラーとして扱い、再試行はモデル / ユーザーの明示的なアクションに限る（Retry は新しい Run、§5）。
- **connector instance ごとの既定同時実行数は 1（concurrency 1）。** ToolBroker のプロセス全体上限（§9 ブロッカー 6）の内で、instance 単位では直列とする。

### 17.7 トランスポートセキュリティ（合意）

- **stdio（exact・合意）:** 子プロセス起動は **shell を介さない（shell=false）**。実行コマンドは **config のみ** から取り、文字列補間・シェル解釈を行わない。環境変数は **明示的な allowlist に挙げたもののみ** を受け渡す。**stderr は 64KiB 上限付きで捕捉** し（上限超過分は切り詰めて破棄し、監査には固定コードを記録）、**シャットダウン時は子プロセスの終了を待ち、強制終了の timeout を設ける**。
- **Streamable HTTP:** **loopback（127.0.0.1 / localhost）のみ** 接続を許可し、**HTTP リダイレクトは追跡せず拒否する**（§15.2 と同一方針）。
- **シークレット:** 認証情報等はログ・run_events・監査・エラー・例外に一切含めない（redaction は §12.4 の単一レイヤを通る。内部 proposal / execution ID とサマリを除き生 ID・シークレットをイベントに含めない、§18.8 と同様）。

### 17.8 ToolBroker 統合・エラー・注入境界・診断・クロスソース（合意）

- Calendar binding のツールは **ToolBroker のポリシーパイプライン（§9 ブロッカー 6）をそのまま通る**。読み取り系として許可され、予算・dedup・タイムアウト・監査の契約は既存どおり。
- エラーは **固定・redact 済みの小文字コード（合意）:** `mcp_unavailable` / `mcp_binding_not_allowed` / `mcp_schema_mismatch` / `calendar_response_invalid` / `calendar_upstream_error` / `calendar_range_invalid`。生エラー・生 MCP 応答を含めない。
- **プロンプトインジェクション境界:** MCP / Calendar 由来のデータは untrusted であり、防御は **構造的** に行う（rN / スナップショット経由の参照のみ、サイズ・観測上限、外部データを指示として信用しない。§9 ブロッカー 6・§15.9）。**テキスト sanitization で解決すると主張しない。**
- **診断は最小限（合意）:** 接続状態・切断・拒否・スキーマ不一致を固定コードのレベルでのみ記録する。生の MCP トラフィック・応答全文・機微値は保存しない。
- **クロスソース（Calendar → Markdown）フロー:** 同一セッション内で **Calendar 参照と Markdown 参照（M1）を同一の rN / 参照モデルで混在できる**。Calendar イベントの正規化 Snapshot は安定な正規キーを持つため、**Calendar のイベントを起点に Markdown 側の関連リソースを決定論的に探索する読み取り専用フロー** を提供する。Markdown ファイルへの書き込みは行わない（M1 読み取り専用の維持）。

### 17.9 M4 テスト計画（計画）

- **CI は fake のみ:** fake MCP client / fake binding / fake calendar を用い、実 MCP サーバーに依存しない。
  - connector-mcp: lazy 接続・起動をブロックしないこと・demand-driven 再接続 + backoff（1/2/5/10/max30）・論理呼び出しの自動再送がないこと・instance 直列性（既定 1）。
  - トランスポート: shell=false・config-only コマンド・env allowlist・stderr 64KiB cap・シャットダウン待機・loopback 外とリダイレクトの拒否・シークレット非露出。
  - 許可モデル: config 定義以外のサーバーなし・allowlist 外ツールの非露出・binding identity（instance/server/kind/version + exact 上流ツール名 + canonical input-schema hash の検証）・書き込み系の禁止（M4 no writes）。
  - 正規化: structuredContent 優先・strict 契約 JSON テキストのみ fallback・検証失敗の拒否・prose ヒューリスティックなし・`calendar.search` exact 入力（query optional / start-end ISO 必須 / limit default10 max20 / cursor、start<end、range max90d、1 ページ・自動 pagination なし）・privacy exclusion（attendee/organizer/conference-join URL/HTML link/raw MCP 除外）・canonical キー（connector+calendarId+eventId）・Snapshot exact 項目（status 4 値・title・optional description/location・timed/all-day start-end・sourceUpdatedAt、all-day end exclusive、personal）・revision 優先順位（etag→source updated→normalized hash）・tombstone（権威 get/refresh のみ、search omission では作らない）・frozen 元 temporal context（now / IANA timeZone、Retry 再利用）。
  - ToolBroker 統合: 予算・dedup・タイムアウト・監査・固定エラーコード。
- **live テストは opt-in の読み取り専用**（明示的な有効化 + 実際の上流 Calendar MCP バインディングが必要）。CI では実行しない。
- **E2E:** 会話から `calendar.search` → rN 引用 → refresh / tombstone 表示までのフローを M3 の UI / SSE 契約の上で検証する。

> 本節は計画であり、上記テストは **まだ実装・実行されていない**。

### 17.10 M4 の非目標（explicit non-goals・合意）

- 書き込み系ツール・承認フロー（→ M5）。
- 発見された MCP ツールの自動露出・動的なサーバー / ツール登録。
- 自動ページ走査・バックグラウンドでの自動再取得・常駐 polling。
- ヒューリスティックな prose 解析、free text JSON fallback。
- 複数 MCP サーバーの fan-out 最適化・サーバー間ルーティング。
- loopback 外の MCP サーバーへの接続・認証基盤の新設。
- Markdown ファイルへの書き込み（クロスソースフローも読み取り専用）。

---

## 18. M5 Action Plan（合意）

> ラベル: **合意（agreed）**。M5（Actions + Approval）の実装計画として合意した内容を記録する。本書は計画のみであり、M5 の実装・テストは **まだ行われていない**。Proposal exact フィールド・ハッシュ・15 分・1 pending 制約、承認 / 拒否の exact 契約、ActionExecution ステータス・grant・preflight・実行境界・read-back 検証、書き込み binding 制限、イベント・UI・テスト・非目標は合意事項であり、実装時の調整対象ではない。調整対象は上流 write binding の冪等性 capability と UI 文言の spike のみ（§20 の #1）。M5 到達 = v0.2（§8）。M0〜M4 の決定（§9・§14〜§17）は変更しない。

### 18.1 スコープと書き込み capability（合意）

- 初期の書き込み capability は **`calendar.reschedule` のみ** で、編集可能フィールドは **イベントの start / end のみ**。**create / delete / title / description / attendee / タスク系の書き込みは存在しない。**
- **Calendar 書き込み binding は明示的な設定として宣言し、config は `writeEnabled` をデフォルト false とする。** binding 定義が編集可能フィールドとして宣言できるのは **start / end のみ**。`writeEnabled` が明示的に true に設定されていない限り、M5 の書き込み経路全体が無効である。許可される上流操作は **正確な update ツール binding のみ**（exact update tool binding only）。
- M4 の Calendar 参照モデル（canonical / Snapshot / rN、§17.4）をそのまま書き込み対象の同一性に使用する。
- **通常 Agent Run の書き込み呼び出し（合意）:** モデルが `calendar.reschedule` を呼んだ場合も **外部書き込みを行わず**、**Run メモリ上に不変（immutable）な Proposal を最大 1 件まで stage するのみ** とする（**1 Run につき最大 1**）。stage 自体は **ツール予算（`runs.tool_requests_used`）を消費** する。**決定論的 preview は connector が生成** する。**成功した `answer.submit` による最終 CAS でのみ**、pending Proposal + `action.proposed` + `run.completed` を **原子的に挿入** する。**failed / cancelled（abandoned を含む terminal 失敗系）Run は承認可能な proposal を残さない。**

### 18.2 Proposal / Approval ライフサイクル（合意）

- Agent Run が書き込みを必要とする場合、**不変（immutable）な ActionProposal を stage したうえでその Agent Run は完了する（§18.1）。** Agent Run 自身は外部書き込みを行わない。
- **承認は別個の `action_approval` Turn を作成**し、それに紐づく **決定論的な Action Run（ActionStrategy / ActionRun。モデルを経由しない）** が実行を担う（通常の Agent Run とは別種別の Run）。
- **拒否は冪等（state-idempotent）な `action_rejection` Turn を作成し（§18.4）、外部呼び出しを一切行わない。**
- **モデルは提案のみ可能であり、承認は決してできない。** 最終承認は **proposal ハッシュにバインドされた UI ボタンのみ** で行う。自然言語による同意（「はい、実行して」等）は **承認カードの再表示のみ** を行い、実行は一切引き起こさない。

### 18.3 ActionProposal（合意）

- フィールド（exact・合意）: `id` / `sessionId` / `sourceTurnId` / `sourceRunId` / `tool`（`calendar.reschedule`）/ `connectorInstanceId` / `input` / `targetRefId` / `start` / `end` / `targetResource` / `basedOnSnapshotId` / `expectedRevision` / `preview` / `hash` / `status`（`pending` / `approved` / `rejected` / `expired`）/ `createdAt` / `expiresAt`。
- **hash は提案内容の正規化 exact 内容のハッシュ** であり、UI 承認ボタンと承認トランザクションの双方がこれにバインドされる。
- **有効期限は 15 分（`expiresAt = createdAt + 15min`）。** 期限切れ Proposal は承認不能（期限切れ扱いで解決。外部呼び出しなし）。**15 分の判定は repository が行う**（DB CHECK ではなく時計比較）。
- **`expectedRevision` は source revision key（合意）:** `source_revision` があればそれ、なければ `content_hash`（§17.5）。ローカルの `resource_snapshots.revision`（append-only allocator）とは比較しない。
- **1 セッションにつき pending Proposal は最大 1 つ。** 新規提案は既存 pending が解決（approved / rejected / expired）された後でのみ可能。DB の部分一意インデックスで強制する。
- **preview は決定論的**: 同一 hash に対して常に同一のプレビューを返す（connector 生成、§18.1）。
- **TurnInput exact variants（合意）:** M0 の唯一 variant は `user_text` = `{ version: 1, kind: 'user_text', text }`。M5 で追加する 2 variant は exact に `{ version: 1, kind: 'action_approval', proposalId, proposalHash }` および `{ version: 1, kind: 'action_rejection', proposalId, proposalHash }` とする。DB の CHECK は `json_valid` のみであり、kind/version/proposalId/proposalHash の閉集合は contracts の schemaVersion 別 Zod レジストリで強制する。
- **Proposal の可変フィールド（合意）:** repository が UPDATE できるのは `status` / `resolved_at` / `decision_turn_id` のみである。`input_json` / `target_*` / `expected_revision` / `preview_json` / `hash` 等の提案内容は不変であり、いかなる経路でも書き換えない。
- **提案 DDL（提案・STRICT/json-valid）:**

```sql
CREATE TABLE action_proposals (
  id                     TEXT PRIMARY KEY,  -- UUID v4
  session_id             TEXT NOT NULL REFERENCES sessions(id),
  source_turn_id         TEXT NOT NULL,
  source_run_id          TEXT NOT NULL,
  decision_turn_id       TEXT,              -- approval/rejection の Turn。pending/expired は NULL。NULL 許容 UNIQUE
  tool                   TEXT NOT NULL CHECK (tool = 'calendar.reschedule'),
  connector_instance_id  TEXT NOT NULL REFERENCES connector_instances(id),
  input_json             TEXT NOT NULL,     -- 提案入力（JSON）
  target_ref_id          TEXT NOT NULL,
  target_resource_id     TEXT NOT NULL,
  based_on_snapshot_id   TEXT NOT NULL,
  expected_revision      TEXT NOT NULL,     -- source revision key（source_revision または content_hash）
  preview_json           TEXT NOT NULL,     -- 決定論的 preview（JSON）
  hash                   TEXT NOT NULL,     -- 正規化内容ハッシュ
  status                 TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,  -- created_at + 15min（判定は repository）
  resolved_at            INTEGER,           -- 解決時刻（NULL 許容）
  FOREIGN KEY (session_id, source_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, source_run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (source_turn_id, source_run_id) REFERENCES runs(turn_id, id),
  FOREIGN KEY (session_id, decision_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, target_ref_id, target_resource_id, based_on_snapshot_id) REFERENCES session_references(session_id, id, resource_id, snapshot_id),
  FOREIGN KEY (connector_instance_id, target_resource_id) REFERENCES resources(connector_instance_id, id),
  FOREIGN KEY (target_resource_id, based_on_snapshot_id) REFERENCES resource_snapshots(resource_id, id),
  UNIQUE (source_run_id, id),               -- execution の複合 FK 用親キー要素
  UNIQUE (session_id, id),                  -- execution/grants の session 複合 FK 用親キー
  UNIQUE (decision_turn_id),                -- decision Turn は高々 1 proposal
  CHECK (json_valid(input_json)),
  CHECK (json_valid(preview_json)),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL AND decision_turn_id IS NULL) OR
    (status = 'approved' AND resolved_at IS NOT NULL AND decision_turn_id IS NOT NULL) OR
    (status = 'rejected' AND resolved_at IS NOT NULL AND decision_turn_id IS NOT NULL) OR
    (status = 'expired' AND resolved_at IS NOT NULL AND decision_turn_id IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_proposals_one_pending_per_session ON action_proposals(session_id) WHERE status = 'pending';
-- Proposal 内容（input/target/expectedRevision/preview/hash 等）は不変であり、repository は status/resolved_at/decision_turn_id のみ更新可。
-- target 完全性（合意）: 4 列複合 FK `(session_id,target_ref_id,target_resource_id,based_on_snapshot_id) → session_references(session_id,id,resource_id,snapshot_id)` が「target ref が当該 Session に属し、resource/snapshot と一致すること」を DB レベルで強制する。`FK (connector_instance_id,target_resource_id) → resources(connector_instance_id,id)` が connector/resource の一致を、`FK (target_resource_id,based_on_snapshot_id) → resource_snapshots(resource_id,id)` が Snapshot 一貫性を強制する。旧来の弱い `FK (session_id,target_ref_id)` 単独は冗長のため持たない。repository はさらに Proposal 最終 commit（`answer.submit` 時の原子挿入）・承認（approve）・preflight の各時点でこの exact 関係（target reference/resource/snapshot/connector）を再検証し、不一致は preview/execution mismatch として拒否する（外部呼び出しなし）。

CREATE TABLE action_executions (
  id                       TEXT PRIMARY KEY,  -- UUID v4
  session_id               TEXT NOT NULL REFERENCES sessions(id),
  proposal_id              TEXT NOT NULL,
  approval_turn_id         TEXT NOT NULL,
  action_run_id            TEXT NOT NULL,
  status                   TEXT NOT NULL
                           CHECK (status IN ('queued','preflight','executing','succeeded','succeeded_unverified','blocked_stale','failed','unknown')),
  external_call_started_at INTEGER,            -- 外部呼び出し開始マーカー（NULL 許容。executing 遷移と同時 commit）
  finished_at              INTEGER,             -- execution 終端時刻（terminal のみ NOT NULL）
  error_code               TEXT,                -- 固定・redact 済みエラーコード（failed のみ NOT NULL、他は NULL）
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id) REFERENCES action_proposals(session_id, id),
  FOREIGN KEY (session_id, approval_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, action_run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (approval_turn_id, action_run_id) REFERENCES runs(turn_id, id),
  UNIQUE (proposal_id),                     -- 1 proposal につき 1 execution
  UNIQUE (action_run_id),                   -- 1 Action Run につき 1 execution
  UNIQUE (session_id, proposal_id, id),     -- grants/receipts の複合 FK 用親キー
  CHECK (updated_at >= created_at),
  -- 状態・マーカー終端 CHECK（合意）: queued/preflight は marker NULL + finished NULL + error NULL、
  -- executing は marker NOT NULL + finished NULL + error NULL、succeeded/succeeded_unverified/unknown は
  -- marker NOT NULL + finished NOT NULL + error NULL、blocked_stale は marker NULL + finished NOT NULL + error NULL、
  -- failed は finished NOT NULL + error NOT NULL（marker は either way。マーカー前 cancel とマーカー後失敗の双方を許す）
  CHECK (
    (status = 'queued' AND external_call_started_at IS NULL AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'preflight' AND external_call_started_at IS NULL AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'executing' AND external_call_started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'succeeded' AND external_call_started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'succeeded_unverified' AND external_call_started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'unknown' AND external_call_started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'blocked_stale' AND external_call_started_at IS NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
) STRICT;

CREATE TABLE action_execution_grants (
  execution_id  TEXT PRIMARY KEY REFERENCES action_executions(id),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  proposal_id   TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  tool          TEXT NOT NULL CHECK (tool = 'calendar.reschedule'),
  input_hash    TEXT NOT NULL,
  consumed_at   INTEGER,                     -- CAS で 1 回だけ設定（NULL → 時刻）。2 回目の消費は拒否
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id, execution_id) REFERENCES action_executions(session_id, proposal_id, id),
  FOREIGN KEY (session_id, proposal_id) REFERENCES action_proposals(session_id, id),
  CHECK ((consumed_at IS NULL) OR (consumed_at IS NOT NULL))
) STRICT;
-- grant は単一書き込みにのみ有効で再使用不可。消費は `consumed_at IS NULL` の CAS で行い、
-- 同一トランザクションで execution を `executing` + `external_call_started_at` 設定し `action.execution_started` を追記する（§18.5）。

CREATE TABLE action_receipts (
  execution_id         TEXT PRIMARY KEY REFERENCES action_executions(id),
  session_id           TEXT NOT NULL REFERENCES sessions(id),
  proposal_id          TEXT NOT NULL,
  proposal_hash        TEXT NOT NULL,
  outcome              TEXT NOT NULL
                       CHECK (outcome IN ('succeeded','succeeded_unverified','blocked_stale','failed','unknown')),
  preflight_revision   TEXT,                  -- preflight 時点の source revision key（NULL 許容）
  preflight_snapshot_id TEXT,                 -- preflight 観測の Snapshot（NULL 許容）
  observed_revision    TEXT,                  -- 実行後観測の source revision key（verified 時のみ。NULL 許容）
  result_snapshot_id   TEXT,                  -- 実行後 verified 観測の Snapshot（NULL 許容）
  summary_json         TEXT NOT NULL,         -- 安全な receipt サマリ（JSON）
  created_at           INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id, execution_id) REFERENCES action_executions(session_id, proposal_id, id),
  FOREIGN KEY (session_id, proposal_id) REFERENCES action_proposals(session_id, id),
  FOREIGN KEY (preflight_snapshot_id) REFERENCES resource_snapshots(id),
  FOREIGN KEY (result_snapshot_id) REFERENCES resource_snapshots(id),
  CHECK (json_valid(summary_json)),
  CHECK (
    (outcome = 'succeeded' AND observed_revision IS NOT NULL AND result_snapshot_id IS NOT NULL) OR
    (outcome = 'succeeded_unverified' AND observed_revision IS NULL AND result_snapshot_id IS NULL) OR
    (outcome = 'blocked_stale' AND preflight_revision IS NOT NULL AND preflight_snapshot_id IS NOT NULL AND observed_revision IS NULL AND result_snapshot_id IS NULL) OR
    (outcome IN ('failed','unknown') AND observed_revision IS NULL AND result_snapshot_id IS NULL)
  )
) STRICT;
```

### 18.4 Proposal API と冪等性（合意）

- Proposal 系 API は **Session スコープ** で提供する（exact）: `GET /api/sessions/:sessionId/proposals`（list）/ `POST /api/sessions/:sessionId/proposals/:proposalId/approve` / `POST /api/sessions/:sessionId/proposals/:proposalId/reject`。**いずれも Session 所有権を強制** し（proposal の session とパス session の一致を要求。不一致は 404。Turn/Run の Session 所属も検査）、所有権違反の approve / reject は拒否する。
- **approve（exact・合意）:** リクエスト body は **`{ proposalHash }` のみ**。**検証済み Idempotency-Key を必須** とし（scope `proposal:{proposalId}:approve`）、**単一の `BEGIN IMMEDIATE` トランザクションで pending・未期限（15 分）・hash 一致・active Run 不在を確認し、CAS で approved へ遷移させ（`status='approved'` + `resolved_at` + `decision_turn_id` を原子的に設定）、`action_approval` Turn（`input_json` は exact variant `{ version: 1, kind: 'action_approval', proposalId, proposalHash }`）+ queued ActionExecution（`approval_turn_id` + `action_run_id` を nonnull で設定）+ 1 回限り exact ActionExecutionGrant + queued Action Run + Run イベント + 冪等レスポンス保存を原子的に行う**（§9 ブロッカー 4 の原子的冪等トランザクションと同型。同一 key + 同一リクエストは保存済みレスポンスを **idempotent に replay**、異なるリクエストは 409）。成功応答は **`202` + body `{ proposalId, executionId, runId, status: 'queued' }`**。**二重 approve でも外部書き込みの重複は起こりえない。**
- **reject（exact・合意・キーレス）:** リクエスト body は **`{ proposalHash }`**。**Idempotency-Key は使わない。** `pending → rejected` のみ遷移させる単一トランザクションで **CAS + proposal status 更新（`status='rejected'` + `resolved_at` + `decision_turn_id`）+ 高々 1 つの `action_rejection` Turn（`input_json` は exact variant `{ version: 1, kind: 'action_rejection', proposalId, proposalHash }`）作成** を原子的に行い、**Run 作成・外部呼び出しは一切行わない**。**繰り返し reject は同一 state を返し追加 Turn を作らない**（state-idempotent）。**approved 済みは reject できない。** 履歴投影（§11.6）は rejection Turn を「拒否」として表示する（選択 Run を持たない Turn の表示規則に従う）。
- **二重承認は構造的に不可能**: approve は CAS による単一遷移でのみ受理され、2 回目は replay または現状態の返却になる。**2 回の外部書き込みは起こりえない。**

### 18.5 ActionExecution と Grant（合意）

- **ActionExecution status（exact・合意）:** `queued` / `preflight` / `executing` / `succeeded` / `succeeded_unverified` / `blocked_stale` / `failed` / `unknown`。
- 承認時に **1 回限りの exact ActionExecutionGrant** を作成・永続化する。grant の exact 内容: **`executionId` / `proposalId` / `proposalHash` / `tool` / `inputHash`**。grant は対象の単一書き込みにのみ有効で、他の書き込みや再使用には一切使えない。
- **実行主体（合意）:** 書き込みを実行するのは **決定論的な ActionStrategy / ActionRun のみ** であり、**モデルは実行経路に介在しない（never model）**。
- **消費と外部呼び出し順序（exact・合意）:** grant は **`consumed_at IS NULL` の CAS で原子的に 1 回だけ消費** し、**同一トランザクションで execution を `executing` へ遷移させ `external_call_started_at` を設定し `action.execution_started` を追記** してから **初めて外部呼び出し** を行う（§9 ブロッカー 3 の DB コミット先行原則と同一。マーカー（`external_call_started_at` + `action.execution_started` の同時 commit）前のクラッシュと後のクラッシュを区別する、§18.6）。
- **preflight（exact・合意）: 実行前に対象を refresh（権威ある再取得）し、権威ある観測の source revision key を Proposal 作成時の `expectedRevision`（source revision key。§18.3）と比較してからローカル revision materialization を行う。** 成功した preflight 観測は **新しい Snapshot + 新しい rN として materialize** する（§14.2・§17.5 と同一の参照モデル）。stale（key 不一致）または対象イベントの削除（tombstone / deleted、§17.5）を検出した場合は **実行をブロック** し、**外部書き込みゼロ** で ActionExecution を **`blocked_stale`** とし、Action Run を **failed ではなく completed** として安全な receipt / result（§18.7。receipt は `preflight_revision` + `preflight_snapshot_id` を持ち、`observed_revision` / `result_snapshot_id` は NULL）を返す。ローカル `resource_snapshots.revision` との比較は行わない。
- **Action pickup の原子性（exact・合意）:** scheduler の pickup は単一トランザクションで Action Run `queued → running`、ActionExecution `queued → preflight` を同時に遷移させ、`run.started` と `action.preflight_started` を together に追記する（`runs.event_seq` の原子インクリメントに従う）。したがって有効データでは `queued` execution + `running` Run の組合せは存在しえない（impossible pair）。
- **preflight authoritative-read 失敗（exact・合意）:** 外部マーカー（`external_call_started_at` + `action.execution_started` の同時 commit）前の権威ある読み取り失敗（`connector unavailable` / `timeout` / `schema invalid`）は、単一トランザクションで ActionExecution を **`failed`**（固定 `error_code='action_preflight_failed'` + `finished_at`）、`failed` receipt、非 terminal イベント **`action.preflight_failed`** の追記、そして terminal **`run.failed`** による Action Run 終端を **原子的に** commit する。**外部書き込みゼロ・自動リトライなし。** stale による `blocked_stale` + `completed` とは区別する（stale は比較可能な権威観測が得られた場合のみ）。`action.preflight_failed` は非 terminal であり、常に terminal `run.failed` に先行する。

### 18.6 外部呼び出し境界（合意）

- **commit executing → 外部呼び出しの順序を厳守する**（§18.5。§9 ブロッカー 3 の DB コミット先行原則と同一）。executing への遷移（+ grant 消費 CAS + `external_call_started_at` マーカー + `action.execution_started` イベント）をコミットした後にのみ外部 API を呼ぶ。
- Connector は結果を **3 値のみ** で返す（exact）: **`succeeded` / `definite_failure` / `unknown`**。**送信後のタイムアウト・切断は `unknown`** とする。**自動リトライは存在しない**（§9 ブロッカー 6・§17.6 と同一方針）。
- **crash の意味論（exact・合意）:** マーカー（`external_call_started_at` + `action.execution_started` の同時 commit）**前のクラッシュ** は `failed` / `abandoned` 系とし、再試行しない。マーカー**後** のクラッシュ、または成功後の commit 前クラッシュは **`unknown`** とし、Action Run は `abandoned` とする（自動再実行・自動成功確定はしない、§19.4）。unknown は再実行も成功確定もせず、**ユーザーに外部サービス上での状態確認を促す**（解決は手動確認のみ）。起動時 recovery は下記の exact recovery matrix に従う。
- **Action recovery matrix（exact・合意）:** 起動時 recovery・graceful shutdown の drain 後確定はいずれも同一の安全帰結に従う。Action Run status と ActionExecution status + 外部マーカーの組合せで排他的に分岐する:
  - Run `queued` + execution `queued`（マーカーなし）→ **いずれも変更せず queued のまま残す**（次回 scheduler が原子 pickup。**再試行ではなく通常 pickup**）。
  - Run `running` + execution `preflight`（マーカーなし）→ execution を **`failed`**（固定 safe コード）+ `failed` receipt、Run を **`abandoned`** とし **再試行しない**。
  - Run `running` + execution `executing`（マーカーあり）→ execution を **`unknown`** + `unknown` receipt、Run を **`abandoned`** とする（自動再実行・自動成功確定なし。解決は手動確認のみ）。
  - terminal execution（`succeeded` / `succeeded_unverified` / `blocked_stale` / `failed` / `unknown`）+ 対応する terminal Run（`completed` / `failed` / `cancelled`）→ **変更しない**。
  - 上記いずれにも該当しない組合せ（例: `queued` execution + `running` Run、`executing` だがマーカーなし、`preflight` だがマーカーあり、terminal 不整合等）は **impossible pair** として推測で修復せず、recovery/startup を **`database_state_invalid`**（固定コード）で失敗させる（fail closed）。
- **Action preflight 失敗の crash 扱い（合意）:** preflight authoritative-read 失敗は §18.5 の原子終端（execution `failed` + `failed` receipt + `action.preflight_failed` + `run.failed`）で確定済みのため、recovery では terminal 不変として扱う。commit 前クラッシュで preflight 残存（Run `running` + execution `preflight` + マーカーなし）となった場合のみ上記 matrix の preflight 行で `failed` + `abandoned` とする。
- **通常コネクタ終端写像の原子性（合意・exact）:** コネクタ復帰値ごとの終端は **単一トランザクションで execution + receipt + `action.execution_finished` + Action Run 終端を原子的に** commit し、terminal RunEvent の前にすべて確定させる。自動リトライはしない。エラーコードは固定・redact 済みの safe コードのみ（生エラー保存なし）。
  - `succeeded` 復帰 → read-back 検証のうえ execution `succeeded` または `succeeded_unverified` + 対応 receipt（§18.7 の CHECK どおり）+ `action.execution_finished` + Action Run `completed` + `run.completed`。
  - `definite_failure` 復帰 → execution `failed`（固定 safe `error_code` + `finished_at`）+ `failed` receipt + `action.execution_finished` + Action Run `failed` + `run.failed`。
  - `unknown` 復帰（送信後タイムアウト・切断を含む）→ execution `unknown` + `unknown` receipt + `action.execution_finished` + Action Run `failed` + `run.failed`（クラッシュ後の `unknown` + `abandoned` とは区別する。復帰ありは `failed` Run、復帰なしクラッシュは `abandoned` Run）。
- **Action キャンセル競合の境界（合意・exact）:** 通常 Run の Cancel 規則（§9 ブロッカー 3・§11.2）は非 Action Run については変更しない。Action Run のキャンセル可否は次の precedence で排他的に決まる: (1) **Session 所有権を最初に検査** し（不一致は 404）、(2) **terminal Run を次に検査** し、いずれの terminal Action Run（`completed` / `failed` / `cancelled` / `abandoned`。マーカーの有無を問わない）も **generic state-idempotent Cancel と exactly 同様に 200 で現在状態をそのまま返す**（状態変更なし）、(3) 非 terminal の場合のみ外部マーカーの有無で分岐する。**`409 action_not_cancellable` は Run が非 terminal かつ `external_call_started_at` が nonnull のときにのみ** 返す。pre-marker race（cancel CAS と marker/grant トランザクションの競合）は合意どおり先勝ちのみ受理とする。
  - **マーカー前は cancellable:** ActionExecution が `queued` または `preflight` で `external_call_started_at IS NULL` の間のみキャンセル可能。受理時は単一トランザクションで Action Run を `cancelled`（`run.cancelled` 終端）+ ActionExecution を `failed`（固定 `action_cancelled_before_write` + `finished_at`。marker は NULL のまま）+ `failed` receipt + 外部書き込みゼロを原子的に確定させる。マーカー/grant 消費トランザクションと cancel CAS は **Run `status='running'` かつ marker NULL を条件に競合** し、先勝ちのみが受理される。cancel CAS が先に勝てば marker/grant トランザクションは必ず失敗し書き込みは発生しない。
  - **マーカー後は not cancellable（非 terminal のみ）:** 非 terminal かつ `external_call_started_at` が commit された後は Action Run をキャンセルできない。Stop は非表示/disabled とし、Cancel API は `409 action_not_cancellable` を返して Run・Execution・receipt を一切変更しない。これはありえた外部副作用の取消しを偽って主張しないための境界である。marker が先に勝てば後続 cancel は本 409 で拒否される。**terminal 後の cancel は本 409 を返さず、上記 (2) の 200 現在状態返却に従う（terminal marked Action cancel も 200）。**
  - **クラッシュ/shutdown 後の扱い（合意）:** マーカー後の abrupt crash・graceful shutdown 残存は execution `unknown` + Action Run `abandoned` のまま（§18.6 前段。自動再実行・自動成功確定なし。解決は手動確認のみ）。drain 中は preflight/無マーカー残存を execution `failed`（safe コード）+ Action Run `abandoned` とし再試行しない。queued は queued のまま残す。

### 18.7 読み戻し検証と ActionReceipt（合意）

- succeeded 報告の後、**読み戻し検証（read-back verification）** を行う: 対象イベントを外部から再取得し、反映確認が取れた場合のみ **succeeded** とする。確認が取れない場合は **succeeded_unverified** とし、**verified を主張しない**。stale / 削除でブロックした場合は `preflight_snapshot` を receipt に記録しうる（`preflight_revision` + `preflight_snapshot_id` を持ち、`observed_revision` / `result_snapshot_id` は NULL）。
- **verified の場合のみ、実行後の観測を新しい Snapshot + 新しい rN として記録する**（§14.2・§17.5 と同一の参照モデル）。**post-write の verified read は preflight 観測とは別の result Snapshot / rN を作成** する。receipt から実行後状態を rN 経由で引用できる。
- **ActionReceipt（exact 項目・合意）**: `proposalHash` / `actionExecutionId` / 最終 status / `preflight_revision` / `preflight_snapshot_id` / `observed_revision` / `result_snapshot_id` / summary / タイムスタンプ群。CHECK は §18.3 の DDL どおり（`succeeded` は observed + result snapshot を要求、`succeeded_unverified` は observed / result が NULL、`blocked_stale` は preflight revision + snapshot を持ち observed / result が NULL、`failed` / `unknown` は observed / result が NULL）。

### 18.8 イベントと ToolBroker 書き込みポリシー（合意）

- action 系の型付きイベントは **非 final 拡張** として次の exact 一覧のみ追加する（§9 ブロッカー 5 の Zod レジストリで強制。DB closed CHECK なし）:
  - 起点の **Agent Run**（terminal 前）: `action.proposed`
  - **Action Run**（terminal 前）: `action.approved` / `action.preflight_started` / `action.preflight_failed` / `action.preflight_blocked` / `action.execution_started` / `action.execution_finished`（`action.approved` は Action Run のイベントであり、Agent Run のイベントではない）。**`action.preflight_failed` は非 terminal であり、常に terminal `run.failed` に先行する**（§18.5 の authoritative-read 失敗の原子終端。`action.preflight_failed` → `run.failed`）。
  - **`action.rejected` の RunEvent は存在しない。** 拒否は proposal 状態（`rejected` + `resolved_at` + `decision_turn_id` の CAS）+ `action_rejection` Turn + reject API 応答/履歴で表現する（§18.4）。
  - `reference.presented` は M1 で起点 Agent Run に属し（§14.4）、`model.step.*` は M2 で Agent Run に属する（§15.10）。将来の migrations は contracts/events の追加のみで run_events テーブル rebuild はしない。
- payload は構造サマリのみとし、**内部 proposal / execution ID とサマリを超える生 ID・シークレットを含めない**。
- **ToolBroker は発火元（origin）で書き込みポリシーを分ける:** 通常 Agent Run からの書き込み系 tool 呼び出しは **proposal-only**（実行ではなく §18.1 の stage のみ許可）。**Action Run のみ** が **exact ActionExecutionGrant の検証を通して**、grant が指定した単一の書き込みを許可される。**その他の発火元・grant を持たない書き込み要求は default deny**（§9 ブロッカー 6 の default-deny の延長）。

### 18.9 承認 UI カード（合意）

- 承認カードは **Proposal が pending かつ有効期限内のときのみ** 条件付きで表示する（§16.2 の 5 番目の可視操作）。
- カードには **決定論的 preview・対象イベント・変更内容（start / end）・期限** を表示し、操作は **proposal ハッシュにバインドされた承認 / 拒否ボタン** のみ。自然言語の同意は再表示のみで実行しない（§18.2）。§5 の「書き込み系アクションの承認 / 拒否」の実現である。技術概念（Proposal / Turn / Run / Grant）は UI に露出しない（§2・§5）。
- 状態表示（合意）: `queued` / `preflight` / `executing` → 進行中、`succeeded` → 成功 + 新 rN、`succeeded_unverified` → 要手動確認、`blocked_stale` → 変更検出で未実行、`failed` / `unknown` → 失敗・要手動確認。いずれもプレーンテキスト表示（§16.5）。**Action 実行の Stop は外部マーカー前のみ提示し、マーカー後は非表示/disabled とする（§18.6）。`unknown` は「停止しました」と表示せず、必ず要手動確認（失敗系）として表示する。**

### 18.10 M5 テスト計画（計画）

- **CI は fake のみで網羅的に検証** し、実 Calendar 上流に依存しない。
- **live テストは 3 重のゲート**（(1) 明示的な opt-in 有効化、(2) config の `writeEnabled=true` の明示設定、(3) **専用 Calendar 上の実際の上流 Calendar write binding の存在**）を **すべて** 通ったときのみ実行可能とする（**triple-gated dedicated-calendar live safety**）。CI では fake のみを使用する。
- 受入テスト（合意済み一覧）:
  - Proposal: 通常 Agent Run の stage-only（Run メモリ・最大 1・予算消費・外部書き込みなし）・不変性・hash（正規化 exact 内容）・15 分 expiry（repository 判定）・1 セッション 1 pending 制約（実際の部分一意 INDEX）・決定論的 preview・成功 `answer.submit` 時のみ原子挿入（失敗系 Run は残さない）。**M5 DDL（§18.3）の STRICT + json-valid + `connector_instance_id` FK + source session/turn/run 複合所有権（`source_turn_id` + `source_run_id` を含む）+ 4 列複合 target FK `(session_id,target_ref_id,target_resource_id,based_on_snapshot_id) → session_references(session_id,id,resource_id,snapshot_id)` + `FK (connector_instance_id,target_resource_id) → resources(connector_instance_id,id)` + target resource + based snapshot 複合 FK + `decision_turn_id` nullable UNIQUE・同一 session FK + status CHECK（pending は resolved/decision なし・approved/rejected は resolved+decision あり・expired は resolved あり decision なし）+ execution 複合 FK・UNIQUE（proposal/Action Run・親 `UNIQUE (session_id,proposal_id,id)`）+ grant 複合 FK + receipt 複合所有権・Snapshot FK・outcome CHECK が適用されること。TurnInput exact variants（`user_text {version:1,kind,text}` / `action_approval {version:1,kind,proposalId,proposalHash}` / `action_rejection {version:1,kind,proposalId,proposalHash}`）と proposal 可変フィールド（status/resolved_at/decision_turn_id のみ）の検証を含むこと。複合 target 不一致（ref/session・resource・snapshot・connector のいずれかの不一致）が Proposal 最終 commit・承認・preflight の各 repository 再検証で拒否されること。**
  - Approval / Reject: approve の単一 BEGIN IMMEDIATE（pending/未期限/hash/active不在確認 + CAS（status/resolved_at/decision_turn_id） + approval Turn + queued execution + exact grant + queued Action Run + イベント + 冪等保存）と replay / 409、**body `{ proposalHash }` のみ・scope `proposal:{proposalId}:approve`・202 body `{ proposalId, executionId, runId, status: 'queued' }`**、Session 所有権強制、**二重承認で外部書き込みが 2 回発生しないこと**、reject の state-idempotency（**body `{ proposalHash }`・Idempotency-Key なし・CAS（status/resolved_at/decision_turn_id）+単一 action_rejection Turn の単一トランザクション**・pending→rejected・高々 1 rejection Turn・Run/write なし・繰返し同一・approved 不可）と履歴投影、**自然言語同意がカード再表示のみで実行しないこと**、承認ボタンが proposal-hash バインドのみであること。
  - Preflight / 実行境界: stale（**source revision key 不一致。権威 read 比較後に materialize**）・tombstone/deleted による `blocked_stale`（書き込みゼロ・Action Run completed・安全 receipt。receipt は preflight revision + snapshot を持ち observed/result は NULL。stale/deleted は `preflight_snapshot` を使用可）、grant の `consumed_at IS NULL` CAS と同一トランザクションの executing + `external_call_started_at` + `action.execution_started` → 外部呼び出しの順序、3 値（succeeded / definite_failure / unknown、送信後 timeout/切断は unknown）、自動リトライなし、crash 意味論（recovery matrix exact: queued+queued は queued 維持・running+preflight/無マーカーは failed + abandoned で再試行なし・running+executing/有マーカーは unknown + abandoned・terminal 不変・impossible pair は `database_state_invalid` で fail closed。drain も同一安全帰結）、原子 pickup（queued Run + queued execution → running + preflight + `run.started` + `action.preflight_started` の単一トランザクション。queued execution + running Run は impossible）。
  - Preflight failure: マーカー前の権威 read 失敗（connector unavailable / timeout / schema invalid）が単一トランザクションで execution `failed`（`action_preflight_failed`）+ `failed` receipt + 非 terminal `action.preflight_failed` → terminal `run.failed` を原子 commit し、書込ゼロ・自動リトライなしであること（`blocked_stale` + completed とは区別）。
  - Receipt: read-back 検証と succeeded / succeeded_unverified の区別（未確認で verified 主張なし）、成功 preflight 観測は fresh Snapshot/rN・post-write verified read は別 result Snapshot/rN、receipt exact 項目（preflight_revision/preflight_snapshot_id/observed_revision/result_snapshot_id）と CHECK（succeeded は observed + result 必須・succeeded_unverified は observed/result NULL・blocked_stale は preflight 必須かつ observed/result NULL・failed/unknown は observed/result NULL）の検証を含むこと。
  - イベント: exact 一覧（Agent Run の `action.proposed`、Action Run の `action.approved` / `action.preflight_started` / `action.preflight_failed` / `action.preflight_blocked` / `action.execution_started` / `action.execution_finished`）のみが存在し、`action.rejected` RunEvent が存在しないこと（拒否は proposal CAS + Turn + 履歴で表現）。`action.preflight_failed` が非 terminal で `run.failed` に先行すること。
  - ポリシー: Agent Run の proposal-only、Action Run の exact-grant（execution/proposal/hash/tool/input-hash）準拠のみ・非モデル実行、その他の発火元の default deny、`writeEnabled` デフォルト false・exact update binding のみ、編集フィールド start / end のみ。
  - Action 終端・取消テスト: マーカー前 cancel の受理（execution `failed` + 固定 `action_cancelled_before_write` + `failed` receipt + 書込ゼロ + `run.cancelled` の原子性）、marker-vs-cancel 競合の両勝者（cancel 先勝ちで marker/grant 失敗・書込なし、marker 先勝ちで非 terminal cancel が `409 action_not_cancellable`・状態不変）、非 terminal マーカー後 cancel の 409・無変更、**cancel precedence（Session 所有権 → terminal 200 → 非 terminal のみ marker 判定）に従い terminal marked Action cancel が 200 で現在状態をそのまま返すこと**、`definite_failure`/`unknown` 復帰写像（execution + receipt + `action.execution_finished` + Run 終端の原子性、自動リトライなし、固定 safe コード、terminal イベント前に確定）、DDL マーカー CHECK の不正組合せ拒否（queued/preflight の marker 非 NULL、executing の marker NULL/finished 非 NULL、succeeded 系/unknown の marker・finished 欠落、blocked_stale の marker 非 NULL、failed の finished・error 欠落、非 failed の error 非 NULL、`updated_at < created_at`）、**impossible-state fail closed（queued execution + running Run 等の impossible pair で recovery/startup が `database_state_invalid` で失敗すること）**。

### 18.11 M5 の非目標（explicit non-goals・合意）

- `calendar.reschedule`（start / end）以外の **すべての書き込み**（create / delete / title / description / attendee / タスク系）。
- 双方向同期・バッチ書き込み・一括 reschedule（承認付き単一アクションのみ。§8 の非目標と整合）。
- モデルによる承認・自然言語による実行承認。
- 自動リトライ・unknown の自動解決・自動再実行。
- 複数 pending proposal・セッションをまたぐ proposal 承認・grant の再使用。

> 本節は計画であり、上記テストは **まだ実装・実行されていない**。

---

## 19. クロスカット運用・リリース計画（合意）

> ラベル: **合意（agreed）**。マイルストーン（M0〜M5、§9・§14〜§18）を横断するデータライフサイクル・バックアップ・シャットダウン・ヘルス・テレメトリ・CI・配布・リリースの契約である。本書は計画のみであり、**バックアップ・CI・テスト・リリースはまだ実施されていない**。M0〜M5 の既存決定（§9・§14〜§18）は変更しない。

### 19.1 データライフサイクルと保持（合意）

- **ドメイン data は決して自動削除しない。** ハーネスはいかなるドメインデータ（RunEvent・Snapshot・Reference・Receipt 等）も自動的には削除しない。**唯一の自動削除はアプリ作成の pre-migration backup ファイルの最新 3 世代へのローテーション** であり（§19.2）、ドメイン retention / GC ではない。
- **ResourceSnapshot / SessionReference（rN）/ ActionReceipt を含む引用・アクション証拠は無期限に保持する。** 不変性（§4・§14.2・§18.7）と整合し、個別 Snapshot の削除機能・API は **存在しない**。
- **DB + WAL の合計サイズが 1 GiB を超過した場合は警告のみ** を行う（起動時または運用時の警告ログ）。警告は **情報提供のみ** であり、自動削除・自動縮小・VACUUM の自動実行は行わない。
- **セッション単位の物理削除 API は存在しない。** データ削除の手段は **停止中プロセス（stopped process）でのストア全体削除**（DB ファイル・WAL・SHM・バックアップを含むアプリデータディレクトリ配下の削除）のみとし、これを **ドキュメント化された手順** として提供する。稼働中プロセスでの削除手順は提供しない。

### 19.2 バックアップとエクスポート（合意）

- **バックアップとエクスポートは別概念として区別する。**
  - **バックアップ**: 障害復旧・マイグレーション安全性のための **内部メンテナンス用** の DB 全体コピー。
  - **エクスポート**: ユーザーがデータを持ち出すための機能。**ユーザー向けエクスポートは存在しない（非目標）。**
- **メンテナンス用バックアップは `apps/server` のエントリポイント（CLI 経路）からのみ提供する。** HTTP API としてバックアップを公開しない。
- **バックアップ方式（合意・sole method）:** 唯一の方法は **better-sqlite3 の backup API** とする。代替（`VACUUM INTO`・ファイルコピー等のオンライン方式の代替主張）は採用しない。取得後に `PRAGMA quick_check` を実行して整合性を確認する（backup + quick_check はメンテナンスの一致した手順）。
- **自動 pre-migration backup（exact・合意）:** パスは `<data>/backups/companion-pre-migration-v<from>-to-v<to>-<UTC>-<uuid>.sqlite` とする。手順は `.partial` への backup 取得 → `quick_check` → atomic rename の順とする。初回インストール（DB 不存在）および同梱マイグレーションと等バージョン起動では migration backup を不要とする。backup 失敗・`quick_check` 失敗・rename 失敗・prune 失敗のいずれも **migration を abort** する。migration 失敗時は有効な backup を保持する（削除しない）。
- **ローテーション（exact・合意）:** 新しい有効な atomic backup の作成後にのみ行い、解決済み・非 symlink の backups ディレクトリ内で exact なアプリ prefix（`companion-pre-migration-`）に一致するものを対象に、新しい順に **3 世代の pre-migration backup を保持** する。これが **唯一の自動削除の例外** である（§19.1）。
- **手動バックアップ（exact・合意）:** 手動コマンドは **停止中サーバー** でのみ実行し、パスは `companion-manual-<UTC>-<uuid>.sqlite` とする。同じ partial → check → rename 手順を用い、自動ローテーションの対象にしない。
- **手動リストア（exact・合意）:** (1) サーバー停止、(2) 現行 db / wal / shm を保持、(3) 選択した検証済み backup を一時ターゲットへコピー、(4) `quick_check`、(5) 設定 DB への atomic rename、(6) 停止中の間のみ stale wal / shm を除去、(7) 起動して migrate する。
- **ストア全体削除（exact・合意）:** stopped-only の手順であり、対象は設定 db / wal / shm ファイルおよび backups とする。稼働中プロセスでの削除手順は提供しない。ドキュメント化された手順として提供する。
- **マイグレーション適用前にバックアップを必須とする**（pre-migration backup required）。マイグレーション実行経路は直近バックアップの存在を前提とし、バックアップなしでマイグレーションを適用しない。
- **リストアは手動のみ。** 自動リストア（起動時の自動復元・自動ロールバック）は **行わない**。壊れた DB からの復旧はユーザーがドキュメント化された手順で手動に行う。
- **DB とバックアップは平文で保存する**（§19.3 の権限保護に従う）。

### 19.3 保存データの機微性（合意）

- **DB とバックアップは平文で保存する**（アプリレベルの暗号化は行わない）。保護は **OS のファイル権限**（アプリデータディレクトリのパーミッション）に依存することをドキュメントに明記する。
- **認証情報・シークレットを DB に保存しない**（§12.4 の redaction 単一レイヤ・§15.2・§17.7 のシークレット非保存方針と整合）。MCP / Calendar 等の認証情報が必要な場合も DB には永続化しない。

### 19.4 シャットダウンドレインとクラッシュリカバリ（合意）

- **graceful shutdown のドレインシーケンス（合意）。** §11.5 の契約を運用レベルで具体化する。通常時の 3000ms cancel grace とは別の drain であり、**drain で running → cancelled は行わない**:
  1. **新規受付停止**（Message / Retry / v0.2 からは Approve の admission 拒否、queued の pickup 停止）。
  2. **最大 10 秒の自然完了 drain。** 完了できたものは完了 commit が受理される。
  3. 残余は Abort **前に** CAS + RunEvent で確定し、queued は残す。スケジューラ停止 → DB 接続クローズ → listener 最終 close（health 用に listener は最終 close まで残す）。
- **ドレイン時の状態別の帰結（合意）:**
  - **queued**: 実行を開始せず **queued のまま残す**（次回起動時に scheduler が requeue、§9 ブロッカー 1）。
  - **running**: 10 秒の drain 内に完了できたものは完了 commit が受理される。残余は Abort 前に CAS + RunEvent で **`abandoned` に確定** する（drain で `cancelled` にしない）。正常な graceful shutdown が `cancel_requested` のまま Run を残すことはない（§11.5）。
  - **cancel_requested**: Abort 前に CAS + RunEvent で **`cancelled` に確定** する。
  - **unknown Action 外部呼び出し**: executing のまま残存した ActionExecution は **`unknown` に確定** する（§18.6。自動再実行・自動成功確定はしない）。Action recovery の exact 帰結は §18.6 どおり（queued は queued のまま、preflight 無マーカーは failed + Run abandoned で再試行なし、executing 有マーカーは unknown + Run abandoned、terminal 不変）。drain 後確定も同一の安全帰結に従う。
- **クラッシュリカバリは scheduler 開始前・listen 前に完了させる。** 起動シーケンスは §9 ブロッカー 7 と同一の **設定読込 → DB 接続（PRAGMA 適用・スキーマバージョン確認） → pre-upgrade backup + `quick_check` → コミット済みマイグレーション適用 → recovery（running → abandoned、cancel_requested → cancelled、queued は requeue、§11.3） → scheduler 開始 → listen** の順とし、recovery が完了するまで HTTP API・Run 実行のいずれも提供しない。

### 19.5 ヘルスとテレメトリ（合意）

- **ヘルスは live / ready の 2 段階の意味論を持つ（exact API は §12.5）:**
  - **live**: プロセスが稼働していること。**実際の listener は recovery 完了後にのみ開始するため、recovery 前の live は HTTP で観測可能ではない（pre-ready の HTTP 成功主張なし）。** drain 中も最終 close まで live は `200 { status: 'live' }` を返す。
  - **ready**: 起動シーケンス（設定読込・DB/バージョン確認・pre-upgrade backup + quick_check・マイグレーション適用・recovery・設定 freeze、§9 ブロッカー 7）が完了し、HTTP 受付・Run 実行が可能であること。**ready でない間はリクエストを受け付けない。drain 中は live 200 / ready 503 を返し、health 用に listener は最終 close まで残す。** drain 中の新規 Message / Retry / Approve は `503 server_shutting_down`（`Retry-After` 付き、冪等非永続、§12.3）で拒否する。
- **外部テレメトリは存在しない。** メトリクス送信・クラッシュレポート送信・使用状況の外部送信は一切行わない（非目標）。
- **ログ出力は stdout / stderr のみ。** アプリ管理のローリングログファイル（rotation / retention 付きファイル出力）は **作らない**。ログの内容は §9 ブロッカー 7 の有界ロギング（固定コード・構造サマリのみ。内容は除外しドメイン保存とは別レイヤ、§12.4）に従う。

### 19.6 配布形態・対応プラットフォーム・engines（合意）

- **配布はソース実行（source-run）のローカル web アプリのみ。** ソースからのローカル実行配布であり、インストーラ・パッケージ（MSI / deb / AppImage / ストア配布等）は v0.x では作らない。
- **engines と packageManager は M0 初期化で exact に固定する:** `package.json` の `engines` に **M0.0 spike で選定した Node.js 24 の exact `24.x.y`** と **pnpm の exact バージョン** を記載し、`packageManager` フィールドにも同一の pnpm exact バージョンを記載して engine 強制を有効にする（実装レベル）。
- **リリースゲート（合意）:**
  - **Windows 11 x64 と Linux x64（いずれも Node 24）をサポートゲートとする。** この 2 プラットフォームでリリース判定を行う（CI マトリクス §19.7 が対応）。
  - **macOS は best effort**（ゲート対象外。壊れてもリリースをブロックしない）。
  - **ARM（Windows ARM / Linux ARM / Apple Silicon）はゲート対象としない**（動作保証の主張をしない）。

### 19.7 CI・依存ポリシー・リリースゲート・性能目標・運用非目標（合意）

- **CI マトリクス（自動）:** `windows-latest` + `ubuntu-latest` × **M0.0 spike で選定した exact Node `24.x.y`**（+ 同一 spike の exact pnpm）。lint（Biome）・typecheck・test をすべての PR で実行する（§13.3 と整合）。**`windows-latest` は自動 portability check であり、別途の手動 Windows 11 x64 smoke をサポートゲートとする（§19.6）。** E2E の Playwright は Linux で自動実行する。
- **統合テストはデフォルトで fake のみ。** CI は実 LLM・実 MCP サーバー・実 Calendar 上流に依存しない。live テストは既存の opt-in ゲート（§15.12・§17.9・§18.10）に従い、CI では実行しない。
- **依存ポリシー:** ランタイム依存は **exact バージョン pin** とし、依存追加・更新はレビュー必須とする。ネイティブモジュール（better-sqlite3、§7）はリリースゲート（§19.6）のプラットフォームでのビルド・取得確認を必須とする。脆弱性対応のバックポート方針等の詳細は実装レベルの調整事項（§20）。
- **v0.1 リリースゲート（M0〜M4）:** §8 の範囲どおり **読み取り専用**（書き込み経路ゼロ）・loopback バインドのみ・Windows 11 / Linux x64 ゲート通過・fake テスト全緑・§14〜§17 の受入テスト計画の実装が完了していること。
- **v0.2 リリースゲート（M5）:** v0.1 ゲートに加え、§18 の承認フロー契約（proposal_hash バインド・単回 grant・`writeEnabled` デフォルト false）の実装と受入テスト（§18.10）が完了していること。
- **性能目標は非束縛（non-binding）:** ローカルでの起動時間・メッセージ送信から応答表示までのレイテンシ等の参考値を置いてもよいが、**リリースゲートには含めない**（CI で性能アサーションを必須にしない）。
- **バックアップ / リカバリ / ヘルス テスト（合意）:** better-sqlite3 backup API のみを用いる exact 経路（auto path `<data>/backups/companion-pre-migration-v<from>-to-v<to>-<UTC>-<uuid>.sqlite` の partial → quick_check → atomic rename、初回/等バージョンの backup 不要、失敗時の migration abort と有効 backup 保持）、新有効 backup 後のみ・exact prefix・解決済み非 symlink・新 3 世代保持のローテーション、手動 backup（停止中・`companion-manual-<UTC>-<uuid>.sqlite`・非ローテーション）、手動 restore（停止・現行保持・一時コピー・quick_check・rename・停止中のみ wal/shm 除去・起動 migrate）、停止中全体削除、平文権限、Action recovery exact（queued 維持・preflight 無マーカー failed/abandoned・executing 有マーカー unknown/abandoned・terminal 不変）、ヘルス exact（§12.5）を CI / 統合テストで検証すること。
- **運用の明示的非目標（explicit operational non-goals・合意）:** ドメイン retention / GC（唯一の例外はアプリ作成 backup の最新 3 世代ローテーション、§19.2）、ユーザー向けエクスポート、セッション単位の物理削除 API、稼働中プロセスでの削除手順、自動リストア、DB / バックアップの暗号化、外部テレメトリ、アプリ管理のローリングログファイル、インストーラ / パッケージ配布、macOS・ARM のリリースゲート、リモートアクセス・認証（§8 と整合）。これらは **将来の実装候補ではなく、v0.x の範囲では明示的に作らない** ものである。

---

## 20. 未解決事項一覧

> 計画名（Companion Harness / companion_harness）は確定済みであり、本一覧は実装 spike のみを含む。

| # | 未解決事項 | 影響 |
| --- | --- | --- |
| 1 | M5 実装レベルの spike 詳細のみ: **上流 Calendar write binding の正確な書き込み API と冪等性 capability**（上流が更新トークン・etag 等の冪等性シグナルを提供するかの確認）、および **UI 承認カードの実装レベル文言（implementation-level phrasing）の確定**。※M5 の意味論（Proposal exact フィールド・hash・15 分・1 pending、承認/拒否 exact 契約、grant・preflight・実行境界・read-back、イベント・UI 状態、§18）は **合意済み** であり未解決ではない | M5 の PR 計画（spike） |
| 2 | M4 実装時 spike の成果物のみ: 採用する **安定版公式 MCP SDK の正確なパッケージ・バージョン（exact pin）** と、**特定の上流 Calendar MCP バインディングとの互換性確認（exact 上流ツール名・canonical input-schema hash の確認を含む）**。※M4 の意味論（パッケージ分割・許可モデル・binding identity・search exact 入力・Snapshot・revision 優先順位・tombstone・接続・セキュリティ、§17）は **合意済み** であり未解決ではない | M4 の PR 計画（spike） |
| 3 | M3 の実装レベルのビルドチューニングのみ: esbuild バンドルのチューニング（チャンク分割・キャッシュ戦略等）。※M3 の契約（SSE exact ルート・カーソル・ワイヤ形式・poll 250ms・heartbeat 15s・5s backpressure・終了条件・reducer・履歴 exact・Retry/Stop exact・保持・描画・Origin/CSP、§16）は **合意済み** であり、heartbeat/poll 等の値は合意値のため未解決ではない | M3 の PR 計画 |
| 4 | M1 の実装レベル詳細: Markdown パーサライブラリの選定と対応記法の厳密な範囲のみ。※検索境界値・正規化・順序・snippet 規則・Snapshot 全文保持・STRICT/DDL・EvidenceGrant・Resolver exact order・参照 API は **§14 で合意済み** のため未解決から除いた | M1 の PR 計画 |
| 5 | M2 の実装レベル詳細: Ollama / OpenAI 互換アダプタのワイヤレベル詳細（正確なエンドポイント・パラメータ命名・ストリーミングの有無）、モデル固有の互換性（native tool calling の挙動差異・usage 表現・capabilities の申告形式）のみ。※予算（repair 含む max 8・wall 300s・step 120s・同時実行 3 キューイング）・`answer.submit` 非 Broker 端末・StructuredAnswer exact 境界・EvidenceGrant 付与規則・`model_calls` metadata-only・固定 error 家族・テスト方針・非目標は **§15 で合意済み** のため未解決から除いた。`model_calls` DDL・モデルイベント型名・エラーコード名の提案表記は計画内の提案として保持し未解決とはしない | M2 の PR 計画 |

※ 旧一覧にあった「RunEvent の payload 形状・SSE イベント契約」「ToolBroker の予算・dedup 契約」は **§9 ブロッカー 5・6 として合意済み** のため未解決から削除した。※ 旧 #1 の「M3（UI / SSE）の詳細設計」は **§16 として合意済み** のため未解決から除き、実装レベルのチューニングのみ #3 に残した。※ 旧 #1 の「M4（MCP / Calendar）の詳細設計」は **§17 として合意済み** のため未解決から除き、SDK の exact pin と上流 Calendar MCP バインディング互換性のみ #2 に spike 成果物として残した。※ 旧 #1 の「M5（Actions / Approval）の詳細設計」は **§18 として合意済み** のため未解決から除き、上流 write binding / 冪等性 capability と UI 文言のみ #1 に spike 詳細として残した。※ 旧 #5 の「M0 DDL 詳細（§10 の列型・インデックス確定）と冪等性リクエストの正規化・canonicalization の詳細ルール」は **§9 ブロッカー 7 として合意済み** のため未解決から削除した（DDL 自体は提案ラベルのまま、実装時の SQLite 構文検証で機械的調整の可能性を保持）。※ 旧 #4 の「保持期間（retention）・エクスポート・認証・リモートアクセス」と旧 #5 の「スナップショットの保持期間」は **§19（クロスカット運用・リリース計画）として合意済み**（ドメイン自動削除なし・唯一の自動削除は backup 最新 3 世代ローテーション・ユーザー向けエクスポートなし・認証 / リモートアクセスは §8 の非目標）のため未解決から削除し、**以後の番号を繰り上げた**。計画名は確定済みのため名称項目は一覧に含めない。

---

## 21. OpenClaw との関係

**合意**

- **OpenClaw は影響源（influence）としてのみ言及する。** 依存関係やコードの流用関係ではない。
- 借用した考え方:
  - **Run の所有権モデル**（実行をエージェントではなくオーケストレータが所有する設計）。
  - **層状のツールポリシー**（能力へのアクセスを一元パイプラインで統制する発想）。
- Companion Harness 固有の部分（OpenClaw にはない独自設計）:
  - **Reference / ResourceSnapshot / Citation の 3 層同一性モデル**（§4）。不変スナップショットと rN による参照は本プロダクトの独自要素である。
