# 常時自己改善ループ計画（PLAN ONLY）

- 状態: **設計計画。実装・権限付与・有効化の承認ではない。**
- 日付: 2026-10-30
- 前提: master `465f07f`。migration 0005–0039、`shadow.ts` / `autonomy.ts` / `trial_authority.ts` / `memory_service.ts` を read-only で確認。
- 非目標: 重みの学習、自動 apply/deploy、モデルによる自己承認、無制限の自己対話、新しい実行エンジン/queue/学習ストア。

## 0. 目的と2層モデル

コンパニオンは「常に自己改善ループが回っている」状態を目指す。ループは2層に分ける。

| 層 | 何を変えるか | ゲート |
|---|---|---|
| **Tier 1（自動）** | 事実・経験・手順の記憶、蒸留、証拠の追記、仮説の **staging**、指標の集計 | なし（host が検証できる範囲だけ） |
| **Tier 2（承認）** | コンパニオン自身のコード・prompt・policy・予算・評価基盤・identity | **試行の承認**（+ 適用は別クリック） |

境界の決め手は**モデルの分類ではなく構造**:
- Tier 1 が書けるのは「host が観測した出来事」に anchor できるものだけ（tool error、`answer_invalid`、`citation_invalid`、`trial_worker_outcomes`、`record.correct`、人間の仮説遷移）。
- 指示・人格・自己記述・owner goal・「ユーザーは〜が好き」は Tier 1 で書かない。staged hypothesis に回す。
- 事実と手順は自動で入り、**振る舞いのルールが live 検索に載る瞬間**は計測と可逆性で守る（§10）。

## 1. 設計原則（論文 → 機構）

| 論文 | 採用する機構 | 本システムでの形 |
|---|---|---|
| 2506.05109 | 内在的メタ認知 = 知識 / 計画 / 評価。外在ループは分布シフトと能力-機構ミスマッチで破綻する。shared metacognition | 知識は既存 `learning_*`、計画は日次 1 回の `reflect_plan`、評価は host check。人間は「何を学習対象にするか」の最終権限を保持 |
| 2607.11881 | monitoring（不確実性・進捗・エラー検出）と control（計画・戦略選択・努力配分） | 監視は既存の `model_calls.error_code` / tool 妥当性 / trial 結果。制御は日次呼数予算と job 種別 |
| 2606.32032 | 自己判断の**質**を信号にする（重み学習は不可） | `predicted_p` と結果の対応で d′ を測る。自己判断は**順位付けのみ**、ラベルにはしない |
| 2604.17399 | reasoning / monitoring / control を分けた meta-trace を横断で統合 | 生成 job と監視 job を分ける。失敗タグをクラスタして `method` 仮説に |
| 2602.02605 | d′ type-2 で自己知識を測る（バイアスと分離） | クラス別 d′。CI が 0 を含むクラスは自己確信の重みを 0 に |
| 2505.24726 | 失敗 → 内省 → 再試行（報酬は再試行の成功） | 失敗 trial の内省を evidence に残し、再試行は**新しい提案**として人間承認 |
| 2602.03094 | test-time の反復（戦略・蓄積知識・自己検証） | 反復は 1 job 1 call の制約内で「蓄積知識を context に載せる」部分だけ採用 |
| 2601.18778 | teacher の報酬 = student の実測改善（grounded reward） | 提案のランキングは「そのクラスで過去に実測された改善」を使う。自己申告の学習可能性は使わない |
| 2412.02674 | generation-verification gap。verify → filter → distill | host check か人間確認だけを filter に使う。gap をクラス別に記録 |
| 2608.31100 | Self-Testing / Self-Judging / Self-Improvement。経験経路の選択と負の転移 | 要約ルールと raw episode を併用。on/off の A/B と correction rate で負の転移を検出 |

**採用しない**: RLMF / ESMA / SOAR の student training / S³ の parameter training（重みに触れない）。多段 rollout の自己対話（1 job 1 call、予算上限）。

## 2. 実測で確認した制約（設計を縛る）

| 事実 | 出所 |
|---|---|
| `shadow_jobs.kind` は `policy_change` / `explicit_request` の closed CHECK。`shadow_inbox` も同じ | migration 0014 |
| `ux_shadow_jobs_single_claimed` が **claimed を全体で1件**に制限 | 0015 |
| `ux_shadow_jobs_explicit_key` は `(session_id, request_key) WHERE kind='explicit_request'` のみ | 0015 |
| `trial_proposals.status` は `staged|granted|expired|invalidated`。`task_id` は NOT NULL（`autonomy_tasks` FK） | 0012 |
| `learning_hypotheses.status` は `open|supported|refuted|retired`。`origin` は `human|model`、model は `staged=1` | 0018 |
| `learning_evidence.source_kind` は closed CHECK（`shadow_job|conversation_proposal|action_receipt|task_event`）で append-only | 0018 |
| `autonomy_control` は `paused` と `version` のみ | 0011 系 |
| memory の書き込みと idle distill は **STOP 中も動く**（I03-09 の設計） | `memory_service.ts` |
| `memory_outbox.idempotency_key` は UNIQUE | 0010 系 |
| `memory_exposures.kind` は `user_fact|model_inference|summary|correction` | memory |
| `purpose.propose` / `task.propose` は chat run の `user_text` turn を要求し、background からは呼べない | `autonomy.ts` / `conversation_proposal_tools.ts` |

この制約から、v1 の設計は次のように修正された（§A 相当）:
- 予算は `model_calls` ではなく `shadow_job_events(event='claimed')` で数える（shadow job は `model_calls` を書かない）。
- ループの trial は **人間が作った standing task** にしか付けられない（`task_id` NOT NULL）。
- 仮説の状態遷移は人間のみ。ループは `staged` まで。
- 再起動は既存の `hold_reason='restart_interrupted'` を再利用（held は再実行しない）。

## 3. ループの状態機械

各状態は既存の行で表す。新しい状態ストアは作らない。

```
OBSERVED      host-observed な evidence 行（learning_evidence / model_calls / trial_worker_outcomes）
  ↓ ≥3 件・≥2 セッション・distinct run
CANDIDATE     learning_hypotheses（staged=1, origin=model）
  ↓ 日次 reflect_plan が上位 K を選ぶ
PLANNED       shadow_jobs(reflect_plan) の結果
  ↓
PROPOSED      trial_proposals(status=staged, 既存 standing task 配下)
  ↓ 人間が /trials で承認（1回限り grant）
RUNNING       既存 TrialRunner
  ↓
VERIFIED / FAILED   host check + held-out 比較
  ↓
CONSOLIDATED  証拠追記、ルールは probation、通知
  ↓ 人間が adopt / support / refute
```

失敗時は内省を 1 回だけ生成し、同じ仮説に対して**再試行提案は最大 1 回**（人間承認が必要）。再試行の context に内省を載せる（2505.24726）。報酬は訓練ではなく、内省 evidence の成功カウンタ。

## 4. トリガとジョブ種別

すべて enqueue のみ。inline では走らない。

| トリガ | job kind | 間引き |
|---|---|---|
| 失敗シグナル付き run の確定（tool error / `answer_invalid` / `citation_invalid` / `record.correct` / failed trial） | `reflect_monitor` | run ごとに 1、日次上限 |
| 成功 run の確定 | `reflect_monitor` | 1/N サンプル（d′ のため） |
| idle（30 分発話なし、`maintain.distill` 完了後） | `reflect_consolidate` | クラスタごとに 1 |
| trial 結果の確定 | `reflect_consolidate`（verify 分岐） | 1 結果ごと |
| 日次 | `reflect_plan` | 1 日 1 回。**唯一の時計トリガ** |

- **chain depth 0**: ループ由来の出力（shadow job、`source_kind='shadow_job'` evidence、`origin∈(loop, loop_canary)` 提案）は何も enqueue しない。自己フィードバックを構造的に断つ。
- **coalescing**: `request_key = reflect:<kind>:<class>:<utc-day>[:cluster]`。同一キーは no-op。クラスごとに最低 30 分間隔。
- **STOP**: paused の間は claim しない（既存の shadow fence）。enqueue もしない（catch-up なし）。

## 5. データ（既存への写像と追加）

新しいストアは作らない。STRICT テーブルの CHECK 拡張は rebuild migration（0009/0022/0025 と同じ）。

| 変更 | 内容 |
|---|---|
| `shadow_jobs.kind` / `shadow_inbox.kind` | `reflect_monitor` / `reflect_consolidate` / `reflect_plan` を追加（rebuild）。`ux_shadow_jobs_explicit_key` を新 kind にも拡張 |
| `shadow_jobs.hold_reason` | `budget` / `learning_frozen` を追加 |
| `autonomy_control` | `learning_frozen INTEGER NOT NULL DEFAULT 0` を ADD COLUMN |
| `learning_evidence` | `source_kind` に `run` / `trial_outcome` を追加（rebuild）。`UNIQUE(hypothesis_id, source_kind, source_id)` を追加 |
| `learning_hypotheses` | `task_class`（≤8 種の決定キー）と `applies_when` を追加。`scope` は既存のセッション scope のまま**再利用しない** |
| `trial_proposals` | `hypothesis_id` と `predicted_p`（実行前に記録する自己申告確率）を追加。`checks_json` は既存を利用 |
| `loop_daily` | 派生ロールアップ（権限なし、再構築可能）: day, task_class, n, hr2, far2, dprime, gv_gap, heldout_delta, claimed_calls, dropped |

## 6. 測定（ここが本体）

自己採点を避けるため、**ラベルは host が観測したものだけ**にする。

**ラベル集合 L**: `model_calls.error_code`（`answer_invalid` / `citation_invalid`）、tool call の schema 妥当性、`trial_worker_outcomes.succeeded`、`record.correct` / `record.retire` の outbox、人間の仮説遷移。モデルの自己判断（`reflect_monitor` の出力、`predicted_p`）は**順位付けにのみ**使い、ラベルにしない。

**quarantine**: `hash(run_id) % 10 == 0` の 10% を reflect / distill の入力から除外し、評価にだけ使う（context builder で除外、テストで固定）。

**replay suite**: quarantined run の `suite_manifest`（sha256）で固定。frozen prompt を「ルールあり / なし」で再発行し、tool 妥当性と citation/answer 妥当性（決定的）だけを採点する。correction 系は再現できないので usage ledger（§10）に回す。

**null arm**: 毎回「空ルール」の腕を同時に走らせ、ペア差からノイズ床 SE₀ を出す。採用候補は `delta > 2·SE₀` かつペア CI が 0 を除外した場合のみ。週次の synthetic no-op が CI ∋ 0 を返さなければ kill criterion（§11）。LiteLLM の seed 保証は未検証なので、seed が効かない場合は k=3 反復で代替する。

**d′ type-2**: クラス別に (実行前の確信, L の結果) をペアにし、固定閾値 0.7 で二値化。`d′ = z(HR₂) − z(FAR₂)`（+0.5 補正）、bootstrap CI。**n ≥ 50 かつ各セル ≥10** を満たすまで「データ不足」と表示し、順位付けに使わない。CI が 2 窓連続で 0 を含むクラスは自己確信の重み 0、提案は `low_reliability` として週 1 回に制限。

**generation-verification gap**: クラス別に `host 検証で filter した場合の合格率 − 未 filter の合格率`。filter は host check / 人間確認のみ。ギャップが正でないクラスの distill は自己検証を使わない。

## 7. Tier 境界（何が自動で、何が承認か）

**Tier 1 が書けるもの（列挙）**
1. `shadow_jobs` / `shadow_job_events`
2. `learning_evidence`（状態遷移なし）
3. staged `learning_hypotheses`
4. `loop_daily`
5. `memory_outbox` の `record.remember`（kind `summary`/`model_inference`、host-observed source と逐語 span の string 一致が必要）と `record.retire`（可逆）

**Tier 2（承認が必要）**
- prompt / tool policy / config / コード / migration
- autodispatch policy
- 予算・閾値・**ループ自身のパラメータ**
- identity・persona・owner goal に触れる記憶

**ゲートの実体**
1. `trial.propose` は `staged` のみ。
2. 人間が `/trials` で承認 → `hash(proposal, snapshot, checks, budget)` に束縛された 1 回限り grant。
3. 適用は別クリック（draft PR またはローカルブランチ）。deploy は別。
4. ループのモジュールは grant / adoption 関数を import しない（テストで import graph を検査）。

**STOP との関係**
- `paused=1` は shadow を止める。memory 書き込みと idle distill は従来どおり動く（I03-09）。
- `learning_frozen=1` を追加し、**ループ由来の** memory 書き込み・distill トリガ・probation 昇格・新規 staging を止める。`record.retire` は許可（振る舞いを狭めるだけ）。
- `learning_frozen` は kill criteria が立て、解除は人間のみ。STOP の resume では解除しない。

## 8. レビュー容量

- **上限**: ループ由来の pending は合計 4 件（staged hypothesis + staged trial proposal）。人間由来の枠を潰さない。
- **オーバーフロー**: キューに積まない。同クラスなら既存項目の evidence に追記、それ以外は drop（`loop_daily.dropped`）。
- **期限**: trial proposal は既存 `expiry`（7 日）で `expired`。仮説は人間が触るまで枠を占有（ループは遷移できない）。沈黙は承認ではない。
- **digest**: 1 日 1 通知（`kind='proposal'`、≤500 字）。項目ごとに「主張 / 根拠 episode ≤3 / 反証の探索結果 / 事前登録した指標と baseline vs candidate ± CI / null arm SE₀ / リスク分類 / `checks_changed` / コスト」を 1 画面に。
- **canary**: 試行提案の約 1/20 は host 側の known-bad（denylist path を触る diff など）。UI では区別しない。grant は発行されない。canary が承認された、または承認率 ≥95% かつ中央値 15 秒未満が 20 件続いたら Tier 2 提案を停止（人間が解除）。

## 9. 改ざん防止

- **既存**: `taskHash` が `requiredChecks` / `acceptance` / `constraints` / `relevantPaths` / `sourceRevision` / `configFingerprint` を grant に固定する。
- **予防**: operator config に `oversightPaths`（check 定義、評価 fixture、`suite_manifest`、shadow/reflect prompt、予算 config、migration ディレクトリ）を列挙。stage 時に `relevantPaths` / `allowedPaths` との交差を拒否。
- **検知**: adoption 時に `base_sha` と artifact から `git diff` を取り、`oversightPaths` と削除/変更された test を検査。非空なら `checks_changed=1` を digest に立て、**別レーン（バッチ不可）**に回す。trial の評価は候補の copy ではなく baseline `sourceRevision` の checks で走らせる。
- **テスト**: アサーションを弱める red-team 試行が `checks_changed=1` になること。

## 10. 統合と負の転移

- **経路選択（2608.31100）**: 圧縮可能な失敗は summary rule、状態依存の失敗は raw episode へのリンクのみ。
- **probation**: 新しいルールはまず replay のみ。§6 を通過したら 50% 腕（`hash(run_id)%2`）で 14 日。ledger が clean なら 100%。
- **usage ledger**: 新テーブルなし。`memory_exposures(record_id, run_id, kind, revision)` を L と join した view。record ごとに露出数と correction/invalid 率を 14 日窓で比較。
- **retire**: n ≥ 10 かつ率が baseline の 1.5 倍超（片側 α=0.1）で `record.retire` を enqueue（`record.reactivate` で可逆）。バッチ単位の tripwire（replay のペア差 > 1 SE）でも retire。削除はしない。
- **学習対象は観測された失敗から**: correction、failed trial、tool error。自己知覚の「足りない気がする」からは作らない。

## 11. 停止と kill criteria

ループは自分で止まる。再開は人間のみ。

1. **hard pause（全層）**: STOP-compliance canary が 1 回失敗 / idempotency key 衝突で別行が生まれた。
2. **budget**: 日次 claimed が上限超過、または enqueue 率が閾値超。80% 超が 3 日続いたら警告。
3. **review health**: pending 上限が 7 日超過 / rubber-stamp 兆候 / canary 承認 → Tier 2 提案停止。
4. **negative transfer**: replay のペア差が 1 SE 超の下落 → そのバッチを retire し `learning_frozen`。derived memory を使った turn の correction 率が 14 日 baseline の 1.5 倍超でも同様。
5. **calibration**: クラス別 d′ の CI が 2 窓連続で 0 を含む → そのクラスの自己判断入力を無効化。
6. **config change**: model / route hash の変化で Tier 2 を凍結し baseline を再測定。

## 12. 段階と受入

critic の NO-GO を反映し、**計測より先に振る舞いを変えない**順序にする。

| Phase | 内容 | 受入（次へ進む条件） |
|---|---|---|
| **P0 観測・ゲート** | `remind` 側の heat / distill の実挙動を確認。outcome join（run ごとの L）を実装。quarantine、`learning_frozen`、derivation depth 1、pending 上限、model/route hash baseline を先に入れる。**書き込みなし** | remind の (a) 非ユーザー retrieval が heat を上げない (b) distill が `summary` を入力から除外できる (c) `record.correct` が `run_id` を持つ、を実測。ラベル被覆率のレポート。replicate のノイズ床 |
| **P1 計測** | `loop_daily`、d′、gap、被覆率。振る舞いは変えない | 合成混同行列で d′ が既知値に一致。実履歴でレポートが動く。null arm が CI ∋ 0 |
| **P2 monitor（観測のみ）** | `reflect_monitor` の kind / トリガ / 予算 / STOP / fence。evidence 行だけ書く | 失敗 run で job がちょうど 1 件。`kill -9` で held、重複なし。paused で 0 件。予算超過で held。**claim 枠を塞がない** |
| **P3 consolidation（提案のみ）** | staged hypothesis、replay-only ルール、probation | 注入した悪いルールが replay で棄却。`origin=loop` の evidence が閾値に数えられない。人間が昇格させるまで live に載らない |
| **P4 Tier 2 提案** | standing task 配下の trial 提案、checks 固定、canary、oversightPaths | 提案が `staged` のまま grant 0。承認後に trial が走る。held-out 差分が保存される。red-team が `checks_changed=1`。canary が grant を得ない |
| **P5 ループを閉じる** | adoption 結果を `realized_gain_prior` と d′ の重みに戻す | 4 週間の A/B で held-out 差分と gap の傾向。negative-transfer drill で tripwire の取りこぼし 0。d′ > 0 が 1 クラス以上 |

## 13. 未解決の決定（人間）

1. **standing task**: ループの trial は既存 task にしか付けられない。クラスごとに人間が 1 つ作る（例: `maintenance_trial`「companion self-improvement」）。作るか、作らずに P3 で止めるか。
2. **Tier 1 の自動昇格**: 事実・手順ルールの live 昇格を自動にしてよいか。それとも 50% 腕の後も人間承認を挟むか（推奨: host-anchored な事実のみ自動、identity/persona は承認）。
3. **予算**: monitor 20 / consolidate 4 / plan 1 / 提案 1（日次）は未較正の初期値。パイロットで測ってから固定する。
4. **`oversightPaths` と canary ライブラリ**: operator が整備する必要がある。
5. **`remind` 側の実装**: heat / distill / `record.correct` の `run_id`。別リポジトリなので、P0 の実測が通らなければ Tier 1 の memory 書き込みは無効のまま（observer + staged hypothesis のみ）。

## 14. 受入マトリクス（恒久）

| # | シナリオ | 期待 |
|---|---|---|
| 1 | 失敗 run | `reflect_monitor` が 1 件だけ。evidence は host-observed のみ |
| 2 | ループ由来の出力 | 何も enqueue しない（chain depth 0） |
| 3 | STOP 中 | claim 0、enqueue 0、ループ由来 memory 書き込み 0。retire のみ許可 |
| 4 | `learning_frozen` | ループ由来の書き込み・昇格・staging が止まる。解除は人間のみ |
| 5 | 再起動 | `restart_interrupted` で held、再実行なし。重複行なし |
| 6 | 予算超過 | `budget` で held、翌日まで再試行なし |
| 7 | 自己採点 | モデルの判断がラベルに使われない（コードで固定） |
| 8 | quarantine | 10% の run が distill/reflect の入力に出ない |
| 9 | null arm | no-op のペア CI が 0 を含む |
| 10 | 悪いルール | replay で棄却、live に載らない |
| 11 | 負の転移 | retire（可逆）と `learning_frozen`、削除なし |
| 12 | 改ざん | `checks_changed=1` と別レーン |
| 13 | canary | grant 0、承認されたら Tier 2 停止 |
| 14 | レビュー過負荷 | pending 上限で drop、キューに積まない |
| 15 | ループの自己改変 | 予算・閾値・policy は Tier 2 のみ。ループからは書けない |
| 16 | purpose/task の生成 | ループからは不可能（`user_text` turn 必須） |
| 17 | モデル/route 変更 | Tier 2 凍結、baseline 再測定まで提案なし |

## 15. 却下した設計（記録）

- **`model_calls` で予算を数える**: shadow job は `model_calls` を書かない。
- **仮説の状態をループが遷移させる**: 状態は人間のみ（0018）。
- **新しい learning/queue ストア**: 既存への写像で足りる。
- **自己判断をラベルにする**: 生成と検証が同一モデルになり、gap が閉じる。
- **30 件/週の人手監査**: レビュー容量を超える。canary と digest に置換。
- **自動 apply / 自動 deploy**: 非目標。
