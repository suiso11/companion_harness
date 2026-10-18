# アクティブプロジェクト詳細タスクリスト

## 利用ルール
- この文書は `active_projects_plan.md` を変更・置換せず、47親グループを独立した確認・実装・決定・調査・検証・記録単位へ分解する補助台帳。正本は remind=`remind/.tmp-t6/plan.md`・README・`docs/acceptance-manifest.md` A1–A7・`docs/retention.md`・src/tests、Companion=`companion_harness/docs/implementation_plan.md`（合意）・README・`docs/operations.md`・M4 spike末尾・readonly binding design最新evidence・関連src/tests。
- `[ ]`は未チェックであり未実装の断定ではない。既存コード/テストがある項目は再実装せず、現状確認・既存テスト再利用・不足時のみ追加。checked化には対象commit・check名・結果・必要な決定記録を残す。N/Aは理由を記録し件数に加算しない。
- 種別: `[確認] [実装] [決定] [調査] [検証] [記録]`。IDは固定・一意。親見出しはcheckboxでなく、親件数を二重計上しない。細分化数は工数/完成率ではない。
- 対象パスはrepo相対。`候補:`とあるパス/APIは実装先案であり現存・採用済みを意味しない。live/import/migrate/ユーザーデータ操作は明示承認なしに行わない。readonly forkはprotocol evidenceのみで、正式採用・live OAuth・現行テスト成功とは別。
- 元台帳状態は指定スナップショットで保持。G01/G02 V、R01–R18 `E,E,P,P,P,E,P,P,D,N,N,N,D,D,N,N,N,N`、C01–C22 `E,E,E,P,P,D,V,D,P,P,D,N,N,N,N,N,N,N,N,N,N,N`、I01–I05 `D,N,N,D,N`。

## 凡例・件数・着手順
| 親範囲 | 親数 | サブチェック数 |
|---|---:|---:|
| G01–G02 横断 | 2 | 19 |
| R01–R18 remind既存scope | 18 | 153 |
| C01–C15 Companion readonly | 15 | 131 |
| C16–C22 Companion M5 | 7 | 72 |
| I01–I05 未承認追加連携 | 5 | 46 |
| **計** | **47** | **421** |
| 既存scope合計（G+R+C01–C22） | 42 | 375 |

`[検証・条件付きlive]`は採用/明示承認等の条件を満たした場合のみ実施する。通常CIやfake検証のリリースゲートとして必須ではない。

順序: Phase 0 G01–G02 → Phase 1 R01–R08+C01–C07 → Phase 2 C08–C15+R09–R13（R13評価方針先行）→ Phase 3 R14–R18 → Phase 4 I01採用決定後I02–I05 → Phase 5 C16–C22 fake（memory Phase 4不要）。分岐は可能。live/import/migrate/userdataは禁止。M5 fake独立先行可、本番v0.2はv0.1 M4受入と書込binding確定後。

## 目次
- [G 横断](#g-横断ゲート)
- [R Remind](#r-remind)
- [C Companion](#c-companion-harness)
- [I 追加連携](#i-remindcompanion追加連携未承認)
- [最初の実装候補・決定待ち](#最初の実装候補と決定待ち)

## G 横断ゲート

### G01 — 正本・branch・作業ツリー・変更保護
元台帳状態: V。対象: 両repo `.git`/linked worktree/refs、`active_projects_plan.md` §0。依存: Phase 0最初。完了条件: 現在値と証拠を記録し、意図しない変更・統合をしない。
- [ ] `G01-01` [確認] remind rootと`.tmp-t6`それぞれのrepo root、gitdir、worktree対応を実測し、旧T4 worktreeと混同せず記録する。
- [ ] `G01-02` [確認] Companion/remind全関連worktreeの現在branch・HEADを取得し、計画記載の過去snapshotを現在値と取り違えない。
- [ ] `G01-03` [確認] 各worktreeでstaged/unstaged/untrackedを別々に採取し、確認時刻と対象pathを記録する。
- [ ] `G01-04` [確認] 既存変更の所有者/意図を確認し、未確認のdirty変更を上書き・clean・stashしない。
- [ ] `G01-05` [決定] remind正本を`.tmp-t6/plan.md`とし、旧root T1–T6/A1–A13を新実績へ流用しない選択を記録する。
- [ ] `G01-06` [確認] refs/merge-base/ancestryでbranch統合状態を調べ、ref存在だけからmerge済みと推論しない。
- [ ] `G01-07` [記録] 調査対象commit SHA、branch、dirty状態のsnapshotを保存し、過去記録と現在実測を明確に分ける。
- [ ] `G01-08` [確認] 計画/成果物の差分を対象外ファイルと照合し、勝手なroot merge/cherry-pick/pushを行わないと確認する。

### G02 — 環境・baseline gate
元台帳状態: V。対象: `remind/.tmp-t6/package.json`, `tests/`, `companion_harness/package.json`, workspace scripts。依存: G01。完了条件: 実行可否・許可・各check結果または未実行理由が別々に記録される。
- [ ] `G02-01` [確認] shell起動とcwdで最小の読み取りコマンドが動くことを確認し、WSL/bash起動失敗はtest failureでなく未実行と記録する。
- [ ] `G02-02` [確認] Node `24.12.0`/npm `11.6.2`/pnpm `11.25.0`の実測versionを各repo要件と照合する。
- [ ] `G02-03` [確認] 既存dependenciesとlock一致を確認する。install・lock更新・browser downloadは別承認なしにしない。
- [ ] `G02-04` [確認] remind `src`対`dist`鮮度を比較し、build生成物の書込許可と対象を先に確認する。
- [ ] `G02-05` [検証] 許可後のみtemp/fake DBでremind noEmit・unit testsを個別実行し、DB隔離と終了後片付けを記録する。
- [ ] `G02-06` [検証] 許可後のみremind acceptance A1–A7を実行し、旧A体系でなく現行manifestの結果を記録する。
- [ ] `G02-07` [検証] Companion lint/typecheck/typecheck:e2eを個別に実行し、各check名・commit・結果を記録する。
- [ ] `G02-08` [検証] Companion unit/browser/E2Eをそれぞれ区別し、実Browser実行の有無・実行件数をsource countと分けて記録する。
- [ ] `G02-09` [検証] 現在のWindows/Linux CI証拠のcommit/platform/check結果を確認し、manual smokeで代替しない。
- [ ] `G02-10` [記録] 未実行checkはshell/権限/browser等の理由を記録し、過去CIを現在passとして扱わない。
- [ ] `G02-11` [検証] Windows 11 x64 manual smokeを専用temp storeで実施し証拠を記録する（Windows/Linux CIとは別のsupport gate。CIだけで代用不可）。

## R Remind

### R01 — strict startup/config/vault/旧DB保護
元台帳状態: E。対象: `remind/.tmp-t6/src/`, `tests/`, README設定節。依存: G02。完了条件: 既存挙動確認、不足のみ補完。
- [ ] `R01-01` [確認] config未知キー・欠損必須項目・型違反起動拒否を現テストで確認し、拒否時DB不変を確認する。
- [ ] `R01-02` [確認] config相対dbPathの解決と起動時固定、上書き不可を確認する。
- [ ] `R01-03` [確認] vaultPath欠落/不正時起動失敗、適正path時投影初期化を確認する。
- [ ] `R01-04` [確認] 許可scope・limit/timeouts/dbMaxBytes境界が起動configに限定されることを確認する。
- [ ] `R01-05` [確認] 8 op allowlistを確認し、旧candidate/approve/review/vector-search/distill未実装opをBAD_REQUESTとする。
- [ ] `R01-06` [検証] 旧承認schema DB起動で固定stderr・非zeroとなり、bytes/hash/mtime/schemaが変わらないことをtemp copyで確認する。
- [ ] `R01-07` [検証] 新規DBを別pathで起動し旧DBを選択・改変・移行しないことを確認する。
- [ ] `R01-08` [記録] A1/A2/A5/A7に対応する現行テスト名と実行証拠を対応づけ、不足分のみ追加候補化する。

### R02 — 二パスwriteとread API
元台帳状態: E。対象: `remind/.tmp-t6/src/`, `tests/`, `docs/acceptance-manifest.md` A3。依存: R01。
- [ ] `R02-01` [確認] event.appendがraw本文・scope・source/provenanceを一回だけ追記し、同一eventId/key replayを確認する。
- [ ] `R02-02` [確認] append成功とrememberが別transactionであり、片方失敗がもう片方を偽装しないことを確認する。
- [ ] `R02-03` [確認] 有効sourceRefs付きremember直後のgetで同一scope record本文を取得できることを確認する。
- [ ] `R02-04` [確認] remember直後のlistで既定activeのみ・createdAt DESC/id ASC順を確認する。
- [ ] `R02-05` [検証] raw hitからsourceRefsを経由してrecallし、応答はrecord snippetのみでraw本文が出ないことを確認する。
- [ ] `R02-06` [確認] since inclusive/until exclusive、status filterとscope隔離を既存APIで確認する。
- [ ] `R02-07` [確認] limit default/max、snippet codepoint切出し/truncatedと応答byte budgetの超過拒否を確認する。
- [ ] `R02-08` [記録] A3とm1-core/recallのcoverageを棚卸し、重複testを作らず不足境界のみ記載する。

### R03 — sourceRefs・write key placement・監査原子性
元台帳状態: P。対象: `remind/.tmp-t6/src/`, `tests/m1-*.test.ts`, acceptance。依存: R01–R02。
- [ ] `R03-01` [確認] 全write opごとの必須idempotencyKey配置を表にし、read opには誤要求しないことを確認する。
- [ ] `R03-02` [検証] key欠落writeがBAD_REQUESTで永続化・副作用なしとなることを各write境界で確認する。
- [ ] `R03-03` [検証] 同一key+同一params replayがdeduplicated応答となり二重write/heatを起こさないことを確認する。
- [ ] `R03-04` [検証] 同一key+変更paramsがCONFLICTで既存結果を変えないことを確認する。
- [ ] `R03-05` [検証] request hash正規化のfield順等が合意仕様どおりで、同値JSONを誤衝突させないことを確認する。
- [ ] `R03-06` [検証] sourceRef正常・missing NOT_FOUND・他scope FORBIDDEN_SCOPEを別個に検証し失敗時record不在を確認する。
- [ ] `R03-07` [検証] 空sourceRefsはmodel_inference/summaryかつderived provenance明示時のみ通り、他kind/欠落表示は拒否されることを確認する。
- [ ] `R03-08` [検証] audit/operations失敗がwriteをrollbackし、監査なしの成功を作らないことを確認する。
- [ ] `R03-09` [検証] audit/errorsに本文/query/snippetを含まず、許可されたmetadataだけであることを確認する。
- [ ] `R03-10` [記録] acceptance A5/A6と既存hardening coverageを一覧化し、不足時のみtest追加する。

### R04 — bounded hybrid recall・縮退
元台帳状態: P。対象: `remind/.tmp-t6/src/store.ts`, `src/` recall実装, tests。依存: R02–R03。
- [ ] `R04-01` [検証] body/query/tagにNFKC→trim→空白畳み込み→ASCII英字のみfoldを適用し、非ASCII caseを壊さないことを確認する。
- [ ] `R04-02` [検証] 不正surrogate、codepoint上限、UTF-8 byte上限、raw 32KB境界が混同なく拒否されることを確認する。
- [ ] `R04-03` [検証] FTS5/bigramで日本語部分一致、ASCII folding、index rebuild後同一順位を確認する。
- [ ] `R04-04` [検証] tag/link exact種、raw hit→active同scope record mapping、raw本文非露出を確認する。
- [ ] `R04-05` [検証] archived/superseded・scope外・dangling graph辺を除外し、active same-scopeのみ辿ることを確認する。
- [ ] `R04-06` [検証] 深さ2・展開40・raw下降3・候補60の各上限と境界直上拒否/制限結果を個別確認する。
- [ ] `R04-07` [検証] vocabulary/tag/link/graph/heat fusionの安定tie-breakがcreatedAt DESC,id ASCであることを確認する。
- [ ] `R04-08` [検証] result limit/snippet/応答byte超過は切詰めずLIMIT_EXCEEDED、audit部分成功なしを確認する。
- [ ] `R04-09` [検証] FTS/bigram/backlink index欠落・再構築失敗時も正本を変えず規定の縮退/安全失敗となることを確認する。
- [ ] `R04-10` [記録] A3/A6/A7とrecall testsをcoverage棚卸しし、実装済み経路の重複提案を除く。

### R05 — correction/archive・実共有DB並行勝者
元台帳状態: P。対象: `remind/.tmp-t6/src/`, tests。依存: R01,G02。完了条件: 実shared file DB raceで勝者1・敗者CONFLICT・余分な行なし。
- [ ] `R05-01` [確認] correctionが新revisionを作り旧activeをsupersededにする単一transactionを確認する。
- [ ] `R05-02` [検証] correction失敗時、新revisionもstatus変更も残らないrollbackを確認する。
- [ ] `R05-03` [検証] supersedes連鎖から旧revisionを辿れ、recall/list active結果から旧版が除外されることを確認する。
- [ ] `R05-04` [検証] archive active→archivedが終端で、再archive/復帰/未知reasonCodeの挙動を確認する。
- [ ] `R05-05` [検証] archive後getで行保持、list/recallから除外、物理DELETEなしを確認する。
- [ ] `R05-06` [検証] 別connection/process相当の同一実file DB並行correctionを開始し勝者が正確に1件となることを確認する。
- [ ] `R05-07` [検証] race loserがCONFLICTでrollbackし、orphan revision/ref/linkが0件であることを確認する。
- [ ] `R05-08` [確認] race testが新M1計画と本物shared DBを使い、旧T4 proof/serialized fakeを流用していないことを確認する。
- [ ] `R05-09` [記録] test fixtureがtemp DBのみを使い、開始時・終了時のDB隔離を確認して証拠を記録する。

### R06 — exposure feedback/heat/retention
元台帳状態: E。対象: `remind/.tmp-t6/src/`, tests, `docs/retention.md`。依存: R02。
- [ ] `R06-01` [確認] recallによるexposure記録のみでnote_heatが増えないことを確認する。
- [ ] `R06-02` [検証] feedbackは同一recallId/scopeで露出したIDだけを受け付けheatを一度加算する。
- [ ] `R06-03` [検証] exposure外ID・別scope・混在IDはall-or-nothing拒否となりusage/heat全不変を確認する。
- [ ] `R06-04` [検証] 同じexposureに異なる新keyで再feedbackしても二重heatにならないことを確認する。
- [ ] `R06-05` [検証] same key replayは二重usage/heatなし、改変payloadはCONFLICTとなることを確認する。
- [ ] `R06-06` [確認] exposures上限1000の古い順evictionのみをretention契約として照合し、eviction後のrecallId挙動も実装/docsで確認する（TTLは未合意）。
- [ ] `R06-07` [確認] exposures eviction後のrecallId挙動を確認し、Companionの無期限domain retention契約と区別する。
- [ ] `R06-08` [記録] A4/retentionとm1-recall/hardening既存testを対応づけ不足だけを追加する。

### R07 — 投影・backlink・retry/rebuild
元台帳状態: P。対象: `remind/.tmp-t6/src/projection.ts`, `remind/.tmp-t6/src/store.ts`, `remind/.tmp-t6/src/db.ts`, tests, README。依存: R01–R04。
- [ ] `R07-01` [確認] outbound正本linksからbacklinkが派生し、独立書込されないことを確認する。
- [ ] `R07-02` [検証] target link archive/correction後Markdown backlink/link表示が正本に従い更新されることを確認する。
- [ ] `R07-03` [検証] projection queue失敗行を保持し、成功時のみ除去することを確認する。
- [ ] `R07-04` [検証] retry回数/間隔がcapped backoffで上限を超えないことを確認する。
- [ ] `R07-05` [検証] 再起動後queue再開し、partial fileのatomic rename失敗で壊れた最終文書を晒さないことを確認する。
- [ ] `R07-06` [検証] projection/index rebuild前後でSQLite正本の行・hashが不変であることを確認する。
- [ ] `R07-07` [決定] 公的rebuild CLIが必要か調査し、必要性がなければ新CLI/APIを追加しない判断を記録する。
- [ ] `R07-08` [記録] `vaultPath`はconfigで要求される既存契約とし、新しい投影先設定を作らない。

### R08 — CLI framing/deadline/worker/busy/unknown commit
元台帳状態: P。対象: `remind/.tmp-t6/src/cli.ts`, src worker/store, tests。依存: G02,R01。
- [ ] `R08-01` [検証] 最初のLFでEOFを待たず応答し、EOF時のLFなし行も終端として扱い、held-open pipeはdeadlineで終了し、buffer済み追加nonwhitespaceを拒否する現行境界を照合する。
- [ ] `R08-02` [検証] raw request 32KB境界で超過を拒否し、途中切捨てをしないことを確認する。
- [ ] `R08-03` [検証] fatal UTF-8 decode不正入力が固定エラー/終了動作になり、replacement文字を通さない。
- [ ] `R08-04` [検証] cli全体timeout時workerをterminateし、終了後に副作用workerが残らないことを確認する。
- [ ] `R08-05` [検証] busy timeout clampは要求値にかかわらず上限内で、busy errorを規定応答に写像する。
- [ ] `R08-06` [検証] commit成否不明timeoutは同一key同一要求再送で保存結果を解決し、別writeを作らない。
- [ ] `R08-07` [検証] replay、worker終端、期限切れread/writeで応答上限とstdout単一JSON行を守る。
- [ ] `R08-08` [検証] 過容量readは継続しwriteはDB max bytes超過時rollback/STORE_UNAVAILABLEとなる。
- [ ] `R08-09` [記録] 実CLI end-to-end coverageと単体testを分け、既存test再利用/不足だけ追加する。

### R09 — ローカルembedding候補選定
元台帳状態: D。対象: `remind/.tmp-t6/plan.md` §10–12, README, 候補調査記録。依存: R13の評価方針準備（最終評価待ちは不要）。
- [ ] `R09-01` [調査] offline/local embedding候補のlicense・配布元・再配布/利用条件を根拠付きで比較する。
- [ ] `R09-02` [調査] candidate exact version/hash pin・runtime compatibility・platform availabilityを調べる。
- [ ] `R09-03` [調査] dimension・tokenization/chunking・最大入力/出力と日本語seed適合を記録する。
- [ ] `R09-04` [決定] model namespace/version migration/rebuildの識別方法を決定し、既存語彙indexとの分離を明記する。
- [ ] `R09-05` [決定] model/cache/index容量上限とlocal-only保証を決め、外部送信がないことを根拠化する。
- [ ] `R09-06` [決定] 候補の採用/棄却と理由を合意記録し、Ollama等を未決候補のまま勝手に固定しない。
- [ ] `R09-07` [決定] std Node+SQLite優先を維持し、新vector DB/dependency追加は承認判断なしに採用しない。
- [ ] `R09-08` [記録] 採用前の調査はprotocol/bench evidenceであり実装・適合・現在性能証明と区別する。

### R10 — 派生embedding index lifecycle
元台帳状態: N。対象: `remind/.tmp-t6/src/` (候補: 新規vector index module/schema), tests。依存: R09採用決定。
- [ ] `R10-01` [決定] 派生indexのschema/generation/model namespaceと正本外の位置を仕様化する。
- [ ] `R10-02` [実装] finite dimension/vector validationとinvalid/missing vector isolationを加える。
- [ ] `R10-03` [実装] active same-scope recordsからbounded embedding generationを実装しraw本文を漏らさない。
- [ ] `R10-04` [検証] 新規record updateが対応generationに反映されることを確認する。
- [ ] `R10-05` [検証] index再構築・中断・再開で世代が一貫しSQLite正本は変わらない。
- [ ] `R10-06` [検証] model version変更はnamespaceを分離し、異次元vectorsを比較しない。
- [ ] `R10-07` [検証] scope/status filterがindex候補取得前後で漏洩なく適用される。
- [ ] `R10-08` [記録] 生成/更新失敗はderived状態として記録しwrite成功の偽装やraw再取込をしない。

### R11 — vector retrieval/fusion
元台帳状態: N。対象: `remind/.tmp-t6/src/` (候補: recall/index module), tests。依存: R09–R10。
- [ ] `R11-01` [決定] cosine等の距離方式・finite normalization・zero-vector処理をbenchmark前に明記する。
- [ ] `R11-02` [実装] bounded vector top-M queryを同scope・activeに限定する。
- [ ] `R11-03` [検証] similarity順位のtie-breakをcreatedAt DESC,id ASCで決定論的にする。
- [ ] `R11-04` [実装] vector候補を既存 lexical/raw/tag/link/graph/heat信号へ融合し重複recordを1件にする。
- [ ] `R11-05` [検証] top-M・候補60・graph/raw等budgetの相互作用で予算超過/上限漏れがない。
- [ ] `R11-06` [検証] raw本文は応答せずsourceRefsからactive同scope recordへ写像される。
- [ ] `R11-07` [検証] 同一DB/index/model stateとqueryで同じ順位を返す。
- [ ] `R11-08` [記録] scan等の選択を測定し、採用しないvector DB/dependencyを勝手に導入しない。

### R12 — vector failure/budget/degradation
元台帳状態: N。対象: `remind/.tmp-t6/src/` recall/index, tests。依存: R10–R11。
- [ ] `R12-01` [検証] index missing時は語彙+graph経路へ縮退しrecallを継続する。
- [ ] `R12-02` [検証] malformed/nonfinite/wrong-dimension vectorは除外しクラッシュ・NaN順位を起こさない。
- [ ] `R12-03` [検証] embedding query timeoutはbounded時間内で終了し語彙+graph結果へfallbackする。
- [ ] `R12-04` [検証] model runtime未設定/停止時に起動やrecallをblockせず意味検索をdisableする。
- [ ] `R12-05` [検証] partial indexは不完全性を明示し、部分結果を全件評価済みと偽らない。
- [ ] `R12-06` [検証] response/snippet/candidate budget違反は既存契約どおり拒否しrawを切り詰めて返さない。
- [ ] `R12-07` [検証] vector failureによりaudit成功だけ残る/正本write rollback漏れがない。
- [ ] `R12-08` [記録] fallback状態・原因は本文/query/model secretなしのmetadataで記録する。
- [ ] `R12-09` [検証/記録] M2完成後、現record.recallの語彙+vector実能力をseed/fakeで受入検証し、M1 A7/manifest/READMEの「M2未実装」記述を段階に合わせ更新する。未採用vector-search等の公開opを追加しない。

### R13 — seeded semantic evaluation方針と最終比較
元台帳状態: D。対象: `remind/.tmp-t6/plan.md` §10–12 (候補: evaluation docs/tests)。依存: 方針・seed/dataset/閾値はR09選定前に準備、最終実行はR11–R12後。
- [ ] `R13-01` [決定] synthetic seeded corpus/query と relevance labelを定義し実ユーザデータ不使用を保証する。
- [ ] `R13-02` [決定] baseline lexical+graphとablation(vector/融合)の比較手順をR09前に合意する。
- [ ] `R13-03` [決定] 適合指標・縮退率・latency計測環境/反復数を事前定義する。
- [ ] `R13-04` [決定] 合意値と提案閾値を別表記し、適合/縮退/latency acceptance境界を固定する。
- [ ] `R13-05` [検証] R11/R12完成後、同じseedとbaselineでablation結果を再現可能に測る。
- [ ] `R13-06` [検証] index欠落/timeout fallbackも同corpusで評価し結果を分類する。
- [ ] `R13-07` [記録] corpus seed・commit・candidate pin・check名・環境・数値を保存する。
- [ ] `R13-08` [決定] 閾値未達時の継続/再選定/未達記録を決め、後出し閾値変更をしない。

### R14 — distill方針・old record取扱い
元台帳状態: D。対象: `remind/.tmp-t6/plan.md` §7,§10–12。依存: なし。完了条件: 対象/trigger/old record処理を決定。
- [ ] `R14-01` [決定] distill対象となるactive記憶の選定規則とscope境界を決める。
- [ ] `R14-02` [決定] summary/correction手法とfact/inference kind分離を決め、根拠refsなしの事実化を防ぐ。
- [ ] `R14-03` [決定] superseded/archive/old recordsの保持・参照・除外方針を記録し自動削除しない。
- [ ] `R14-04` [決定] 起動契機をexplicit bounded batch等から選び常駐/無制限daemonを必須化しない。
- [ ] `R14-05` [決定] batch上限/cursor/取消要求とcommit境界を提案値/合意値に分けて決める。
- [ ] `R14-06` [決定] provenance/sourceRefs/targetsとidempotency/audit契約を確定する。
- [ ] `R14-07` [決定] 同時実行1、retry上限、失敗隔離・rollback粒度を定める。
- [ ] `R14-08` [記録] 通常記憶writeへ人手承認/TTYを復活させないこと、旧T1–T6記録を実績にしないことを明記する。

### R15 — bounded maintenance candidate/cursor
元台帳状態: N。対象: `remind/.tmp-t6/src/` (候補: maintenance query/module), tests。依存: R14。
- [ ] `R15-01` [実装] 明示scopeとlimitに限定した候補取得を追加する。
- [ ] `R15-02` [実装] 安定cursor順序と次cursorを定義し、再開時skip/duplicateを防ぐ。
- [ ] `R15-03` [検証] limit境界・空集合・cursor不正/過去cursorを検証する。
- [ ] `R15-04` [実装] 各候補のraw sourceRefsと同scope target refsを取得する。
- [ ] `R15-05` [検証] archived/superseded/out-of-scope targetsを誤ってactive候補として使わない。
- [ ] `R15-06` [検証] 明示batchの総CPU/records/time budgetで超過せずcancel可能である。
- [ ] `R15-07` [検証] read-only候補取得は過去記憶を更新/削除せず、partial failureを区別する。
- [ ] `R15-08` [記録] candidate outcome/cursorを本文なしmetadataで再開可能にする。

### R16 — distill direct transaction/write
元台帳状態: N。対象: `remind/.tmp-t6/src/` (候補: maintenance/store op), tests。依存: R14–R15。
- [ ] `R16-01` [決定] generated summary/correction input schemaを既存record validationに適合させる。
- [ ] `R16-02` [実装] 新summary/correction・tags/links/sourceRefsを既存store validation経由で直接記録する。
- [ ] `R16-03` [検証] sourceRef scope/exists/kind rulesを通常remember/correctと同じに適用する。
- [ ] `R16-04` [実装] 記録・supersede・operations・auditを単一SQLite transactionに束ねる。
- [ ] `R16-05` [検証] audit/constraint/commit失敗時に新recordも旧status変更も全rollbackする。
- [ ] `R16-06` [検証] 同一key同一batch replay idempotent、変更batch key conflictとなる。
- [ ] `R16-07` [検証] provenanceがモデル生成/元refsを示し、raw全文をrecord本文へ複写しない。
- [ ] `R16-08` [記録] 通常CLIのAI自律記憶writeとdistill writeを同じ安全境界で扱う。
- [ ] `R16-09` [実装] `maintain.distill`を既存protocol/CLI/worker dispatchへ登録し、strict params/idempotency/time-budget/errorを通す（人手承認/TTYなし、M3合意op）。
- [ ] `R16-10` [検証/記録] M3有効時の直接distill成功/取消/rollback受入を追加し、旧A7の未実装assertとmanifest/READMEの現行op表を段階に応じ更新する。未採用旧candidate/approve等unknown拒否は維持する。


### R17 — queue/serialize/cancel/retry
元台帳状態: N。対象: `remind/.tmp-t6/src/` (候補: maintenance queue), tests。依存: R15–R16。
- [ ] `R17-01` [実装] maintenance同時実行数を1に制限し、並行要求の応答を定義する。
- [ ] `R17-02` [検証] cancel-before-commitはbatch全体をrollbackしrecordを残さない。
- [ ] `R17-03` [検証] commit後cancelは確定済み成果を取り消さず境界を報告する。
- [ ] `R17-04` [実装] retryをbounded queue/backoffにし上限到達jobを隔離する。
- [ ] `R17-05` [検証] retryはidempotencyで重複記録せず、恒久失敗を無限再試行しない。
- [ ] `R17-06` [検証] batch部分失敗時成功済みrecordsを壊さず、各transaction境界を確認する。
- [ ] `R17-07` [検証] process restart後queue stateを回復し、曖昧commitを盲目的再実行しない。
- [ ] `R17-08` [記録] 新常駐daemon/schedulerを設けず有界起動契機を文書化する。

### R18 — justified links・育成比較
元台帳状態: N。対象: `remind/.tmp-t6/src/` (候補: maintenance linker), tests/seed eval。依存: R14,R17,R04,R06。M2は必須でない。
- [ ] `R18-01` [実装] 有界seed/contextで正当化できる既存同scope関連だけをlink候補にする。
- [ ] `R18-02` [検証] 関連根拠がない場合links 0件を許しfillerを生成しない。
- [ ] `R18-03` [実装] 未解決の正当なdangling/orphan候補だけを補完しtarget存在時に解決する。
- [ ] `R18-04` [検証] wrong-scope/archived/無関係targetをlink・graph traverseしない。
- [ ] `R18-05` [検証] outboundが正本でbacklink派生、再build後も一致する。
- [ ] `R18-06` [決定] 最小育成seed corpus・before/after指標を固定し閾値提案と合意を区別する。
- [ ] `R18-07` [検証] R04/R06 baselineに対しseeded links/feedback後の有用性を比較する。
- [ ] `R18-08` [記録] R14/R17・既存R04/R06依存を記録しM2 embeddingを必須化しない。

## C Companion Harness

### C01 — M0 queue/CAS/cancel/recovery/operations
元台帳状態: E。対象: `companion_harness/docs/implementation_plan.md` §9–13,§19; `packages/kernel/`, `apps/server/`, tests。依存: G02。
- [ ] `C01-01` [確認] 現行test coverageでqueue/status transition CASとsession active uniquenessを特定する。
- [ ] `C01-02` [確認] Cancel commit→AbortSignal順、3000ms watchdog grace、遅延結果discardをテスト根拠で確認する。
- [ ] `C01-03` [確認] drain受付停止・最大10秒待機・abandoned/cancelled recoveryを通常cancelと別に確認する。
- [ ] `C01-04` [確認] 起動前 recoveryがlisten前に完了しqueued/running/cancel_requested各状態を契約通り扱う。
- [ ] `C01-05` [確認] SQLite constraints/FK/idempotency/events budget・security境界のcoverageを列挙する。
- [ ] `C01-06` [確認] backup API only・partial/quick_check/rename/3 generation・stopped manual restoreの証拠を確認する。
- [ ] `C01-07` [確認] plaintext OS permissions、secret非DB、1GiB warning-only、source-run/no export/delete API/GCなしを確認する。
- [ ] `C01-08` [記録] 正本§9–13/§19と各testを対応付け、不足のみ追加しcovered実装を再作成しない。

### C02 — M1 snapshot/reference/rN/CAS
元台帳状態: E。対象: `companion_harness/packages/kernel/`, tests, plan §14。依存: C01。
- [ ] `C02-01` [確認] canonical snapshot revision allocatorとcontent reuse/normal refresh always-new snapshotを別々に確認する。
- [ ] `C02-02` [確認] resolver、Markdown file bounds、snapshot link mappingを現行実装/testsで確認する。
- [ ] `C02-03` [確認] search hitがsnapshot materialize/reuseしcontent change時新rNとなることを確認する。
- [ ] `C02-04` [確認] openはstored-only、refreshだけexternal rereadを行うことを確認する。
- [ ] `C02-05` [確認] frozen context/citationがimmutable snapshot/rNを指しold citation保持を確認する。
- [ ] `C02-06` [確認] Run status CAS時reference persistenceがatomicでcancel後のlate observationを捨てる。
- [ ] `C02-07` [確認] Markdown file count/size/query/result/snippet boundsのoperations契約とtestsを対応する。
- [ ] `C02-08` [記録] §14既存契約の再確認結果と不足coverageのみ記録する。

### C03 — M2 local model/tool loop/citation
元台帳状態: E。対象: `companion_harness/packages/kernel/`, `apps/server/`, tests; plan §15。依存: C01–C02。
- [ ] `C03-01` [確認] local gateway opt-in configとtool submit一件のみ/max 8 repair/wall 300s/step 120sを確認する。
- [ ] `C03-02` [確認] concurrency 3・metadata-only audit・current-run evidence semanticsを確認する。
- [ ] `C03-03` [確認] citation current-run Grant gate・full-or-snippet policy・cross-source handlingを確認する。
- [ ] `C03-04` [確認] structural answer bounds/schema validation・cancel/no-prose/no automatic retryを確認する。
- [ ] `C03-05` [確認] prompt/context privacyとmodel I/O/secrets non-persistenceをtest/evidenceで確認する。
- [ ] `C03-06` [確認] fake model fixturesだけでM2 acceptanceを再現できることを確認しreal LLM不要とする。
- [ ] `C03-07` [確認] error/timeout/cancel後partial tool resultやcitationをcurrent answerへ誤採用しない。
- [ ] `C03-08` [記録] §15の既存test名と不足項目を整理し既存機能を重複実装しない。

### C04 — JSON status fallback dynamic E2E
元台帳状態: P。対象: `companion_harness/apps/server/e2e/` (existing harness), UI client source/tests。依存: G02,C01–C03。完了条件: real browser sequential JSON polling証拠。
- [ ] `C04-01` [確認] 現行clientのSSE failure→逐次JSON fallback実装と既存unit coverageを確認する。
- [ ] `C04-02` [検証] real BrowserでSSEを不成立にしterminal状態までJSON pollを継続する。
- [ ] `C04-03` [検証] transient poll error後回復し、terminal event/statusを最終反映する。
- [ ] `C04-04` [検証] 5 consecutive failureでnotice表示しpoll停止する。
- [ ] `C04-05` [検証] poll requestsが重複せずno overlapであることをbrowser traceで確認する。
- [ ] `C04-06` [検証] status polling中のUI操作がRun自体をcancelしないことを確認する。
- [ ] `C04-07` [検証] cancel_requestedはterminalでない間pollが早期終了せずcancelled等の終端を待つ。
- [ ] `C04-08` [記録] 実browser名/version・spec・実行結果をsource countと分離記録する。

### C05 — duplicate seq/gap/cursor E2E
元台帳状態: P。対象: `companion_harness/apps/server/e2e/`, reducer/client tests。依存: G02,C01–C03。
- [ ] `C05-01` [確認] reducerのduplicate seq処理とexisting unit coverageを特定し再利用する。
- [ ] `C05-02` [検証] real Browser streamへterminal前duplicate eventを注入し画面上の二重描画がない。
- [ ] `C05-03` [検証] terminal後duplicate eventでもanswer/effectが二重適用されない。
- [ ] `C05-04` [検証] sequence gap時JSON catch-upが欠番を適用し順序を復元する。
- [ ] `C05-05` [検証] event cursorはevent適用後にpersistし、再接続で未適用eventを飛ばさない。
- [ ] `C05-06` [検証] one answer/one effectをUI observableとserver eventで照合する。
- [ ] `C05-07` [記録] Browser実行trace/spec/commitを保存し単体testをE2E証拠と混同しない。
- [ ] `C05-08` [確認] 既存SSE/reconnect testsを棚卸ししcoverage済み部分を重複追加しない。

### C06 — accepted 202後のactive reload調査
元台帳状態: D。対象: `companion_harness/apps/server/e2e/`, client/history code, plan §16。依存: G02,C01–C03。
- [ ] `C06-01` [調査] 正常202を受領済みの別ケースを作り、active run中reloadの再現有無を記録する。
- [ ] `C06-02` [確認] 再現条件でserver側Runが継続しterminal state/eventが存在するか照合する。
- [ ] `C06-03` [確認] 現行history/hydration APIでactive run再発見可能か、pending key喪失問題と分離して調べる。
- [ ] `C06-04` [検証] reload後のstatus/event/resultが最終的に回復するかreal Browserで観測する。
- [ ] `C06-05` [決定] 現行契約で解決する場合は変更なし、解決不能なら最小API契約案を合意前提で記録する。
- [ ] `C06-06` [確認] activeRun/bodyの無断localStorage保存や新保存項目/APIを追加しない。
- [ ] `C06-07` [記録] pending-key-lost delivery reload既存coverageを別ケースとして参照する。
- [ ] `C06-08` [記録] 再現失敗/未実行をsource bug確定扱いせず、環境/理由を明記する。

### C07 — current E2E集約gate
元台帳状態: V。対象: `companion_harness/README.md`, `apps/server/e2e/`, CI workflows。依存: G02,C04,C05。C07をC04/C05の前提にせず集約。
- [ ] `C07-01` [確認] config/specから現在のE2E source test数を数え、既存12は歴史snapshotと分ける。
- [ ] `C07-02` [検証] current E2E runで実際に実行されたtest countと結果をreportから採取する。
- [ ] `C07-03` [検証] root lintを現在commitで実行し結果を記録する。
- [ ] `C07-04` [検証] root/server typecheckと専用typecheck:e2eを別checkとして実行する。
- [ ] `C07-05` [検証] Browser E2Eを実行し、source countやtypecheck結果を実行証明に代用しない。
- [ ] `C07-06` [検証] Windows/Linux CIの現在commit/check名/statusを確認しhistorical greenを流用しない。
- [ ] `C07-07` [記録] browser未実行時はshell/browser/download/permission等の実際の理由を記録する。
- [ ] `C07-08` [記録] READMEの件数/statusを実測後のみ更新し、未確認の実行済み主張をしない。

### C08 — M4 exact MCP binding identity/adoption
元台帳状態: D。対象: `companion_harness/docs/implementation_plan.md` §17–20, `docs/m4_dependency_spike.md`末尾, `docs/google_calendar_readonly_binding_design.md`。依存: Phase 2の決定gate。
- [ ] `C08-01` [確認] SDK 1.30.0 registry metadataとfork 97a3dc3/private 3.0.0-readonly.1をprotocol evidenceとして区別する。
- [ ] `C08-02` [調査] exact full immutable commit・server identity・runtime versionを一次evidenceで確定できるか調べる。
- [ ] `C08-03` [調査] initialize/tools/listの実protocol responseとexact tool namesを採取する。過去のHTTP metadataをprotocol proofにしない。
- [ ] `C08-04` [調査] canonical input-schema hashを算出し、名前/版/schemaをbinding identityに結びつける。
- [ ] `C08-05` [調査] structuredContent/response mappingを実body evidenceで確かめ、design内unverified imports claimを確認済み扱いしない。
- [ ] `C08-06` [決定] exact pin形態（package release/fixed commit等）を選び、正式採用判断を記録する。
- [ ] `C08-07` [決定] server/version/tool/schema identity不一致時binding disableとなる決定を確認する。
- [ ] `C08-08` [記録] protocol evidence・formal adoption・live OAuth・live readinessを別欄にし、未実施を明記する。

### C09 — MCP lifecycle/transport/security
元台帳状態: P。対象: `companion_harness/packages/` (候補: 新connector modules; 新規候補で未採用), tests, plan §17.6–8。依存: C08採用判断。
- [ ] `C09-01` [実装] 明示allowlistのみ登録しtools/list全自動exposure/write tool露出を拒否する。
- [ ] `C09-02` [検証] reconnect delay 1,2,5,10,max30sとlazy connect動作をfake clockで確認する。
- [ ] `C09-03` [検証] reconnect後にlogical callを自動再送せず、instance concurrency 1を確認する。
- [ ] `C09-04` [実装] stdio command/env config-only・shell=falseをenforceする。
- [ ] `C09-05` [検証] stderr 64KiB capを超えた際にbounded termination/safe errorとなる。
- [ ] `C09-06` [実装] shutdown wait/kill timeoutとloopback-only redirect refusalを確認する。
- [ ] `C09-07` [検証] server/schema drift fail-closedとなりraw error/secret/pathをredactする。
- [ ] `C09-08` [記録] dependency pinは採用gate後のみ変更し、fake testsと外部実行証拠を分ける。

### C10 — Calendar input/normalization/privacy
元台帳状態: P。対象: `companion_harness/packages/` (候補: connector-calendar, 未実装案), tests, plan §17.4–5。依存: C08。
- [ ] `C10-01` [決定] structuredContent-firstとstrict contract JSON fallback schemaをexactly defineしprose heuristicを禁止する。
- [ ] `C10-02` [検証] invalid structured response/fallback JSONはcalendar_response_invalid固定errorとなる。
- [ ] `C10-03` [実装] privacy allowlist normalizationで7 excluded sensitive fieldsをsnapshotから除く。
- [ ] `C10-04` [実装] revision precedence etag > source-updated > normalized hashを定義通り適用する。
- [ ] `C10-05` [検証] all-day exclusive endとtimezone/date normalizationを境界値で確認する。
- [ ] `C10-06` [検証] start<end、max 90 days、limit<=20、one page/opaque cursor validationを確認する。
- [ ] `C10-07` [検証] cursorをparse/合成/auto-paginationせずupstream opaque valueのまま渡す。
- [ ] `C10-08` [記録] mappingは採用binding実responseに基づけproposal/helperを接続済みと誤認しない。

### C11 — authoritative deletion evidence
元台帳状態: D。対象: implementation_plan §17.5, M4 spike/design, candidate connector tests。依存: C08–C10。
- [ ] `C11-01` [決定] upstream get/delete-operation-specific evidenceがtombstoneを証明する条件を定義する。
- [ ] `C11-02` [検証] cancelled statusを削除と同義にせずsnapshotを保持する。
- [ ] `C11-03` [検証] 404単独と410単独がdeletion proofにならないことを確認する。
- [ ] `C11-04` [検証] search omission/pagination gapをtombstoneにしないことを確認する。
- [ ] `C11-05` [検証] 不確実結果はcalendar_upstream_error/unknownにし、既存snapshotを誤消去しない。
- [ ] `C11-06` [決定] evidence不足時のretry/refresh可否とuser-facing unavailable semanticsを合意する。
- [ ] `C11-07` [記録] evidence type・request・response statusをsecret/個人情報なしで記録する。
- [ ] `C11-08` [確認] spikeのcancelled/404 limitationsをformal implementation evidenceと取り違えない。

### C12 — Calendar connector→canonical snapshot pipeline
元台帳状態: N。対象: `companion_harness/packages/kernel/` existing ReferenceManager; connector path is候補。依存: C08–C11。
- [ ] `C12-01` [実装] 選定bindingからcalendar.search/getを既存connector interfaceへ接続する。
- [ ] `C12-02` [実装] normalized Calendar resourceをCanonicalResource/Snapshot/rN経路で永続化する。
- [ ] `C12-03` [検証] search結果はsnapshotをmaterialize/reuseし、単なるhitをevidence無しで返さない。
- [ ] `C12-04` [検証] refreshはnew observation snapshot/rN、openはstored-onlyである。
- [ ] `C12-05` [検証] same revision normal searchでreuseし内容/revision change時new snapshotを作る。
- [ ] `C12-06` [検証] refresh cancel/status CASとのatomicityとlate observation discardを確認する。
- [ ] `C12-07` [実装] citation provenanceにbinding identity・source revision・rNを結びつける。
- [ ] `C12-08` [記録] existing ReferenceManager再利用箇所を特定し並行する新identity層を作らない。

### C13 — calendar.search Broker/frozen context
元台帳状態: N。対象: `companion_harness/packages/kernel/` ToolBroker/turn context; tests。依存: C12。
- [ ] `C13-01` [実装] model-visible単一calendar.search descriptorを登録しupstream個別toolsは露出しない。
- [ ] `C13-02` [検証] per-turn budget reservation precedes classify/validate/dedup/execute and overbudget blocks call.
- [ ] `C13-03` [実装] canonical query dedup・timeout・fixed audit/errorを既存Broker policy pipelineへ接続する。
- [ ] `C13-04` [検証] frozen now/timeZoneをretryでも再計算せず同一Turnで使う。
- [ ] `C13-05` [検証] retry policyが§17合意のbudget内でのみ実施しlogical call自動resendをしない。
- [ ] `C13-06` [実装] Cross-source Markdown read-only citation/open flowを既存ReferenceManagerへ接続する。
- [ ] `C13-07` [検証] calendar call failure/cancel時にstale/uncited evidenceを回答へ混ぜない。
- [ ] `C13-08` [記録] no-write/default-denyとmodel result boundsをtest evidenceへ結びつける。

### C14 — opt-in config/bootstrap/lifecycle
元台帳状態: N。対象: `companion_harness/apps/server/` bootstrap/config (existing), connector candidates new proposals。依存: C12–C13。
- [ ] `C14-01` [実装] frozen startup configの明示opt-inでのみbindingを構築する。
- [ ] `C14-02` [検証] 未設定時server起動非block、Markdown/Calendar absent behaviorを契約通り確認する。
- [ ] `C14-03` [検証] Calendar-only構成でMarkdown未設定でも起動/利用可能か確認する。
- [ ] `C14-04` [実装] lazy connectionをserver startup/listen pathから切り離す。
- [ ] `C14-05` [検証] unavailable/identity mismatchでbinding disable、他server機能は継続する。
- [ ] `C14-06` [検証] shutdown時connector/session/child processを boundedに終了する。
- [ ] `C14-07` [検証] configにsecret/path/credential値がlog/DBへ出ないことを確認する。
- [ ] `C14-08` [記録] config variables/docsは採用仕様合意後にのみ追加する。

### C15 — M4 fake integration E2E/live gate
元台帳状態: N。対象: `companion_harness/apps/server/e2e/` existing harness, CI。依存: C12–C14。
- [ ] `C15-01` [実装] fake MCP server + fake model + real UI E2E fixtureを既存Playwright harnessに加える。
- [ ] `C15-02` [検証] conversation→calendar.search→normalized snapshot/rN→citation pathを実Browserで通す。
- [ ] `C15-03` [検証] refresh same/changed revision・authoritative tombstone/unknownの各分岐をE2Eで確認する。
- [ ] `C15-04` [検証] malformed schema, timeout, reconnect, shutdown時fail-closedとserver継続を確認する。
- [ ] `C15-05` [検証] fake-only CIでOAuth/network不要かつexisting no-write policyを検証する。
- [ ] `C15-06` [確認] live 7-item checklistをfake proofから分離し、readonly consent/専用scope/explicit approvalなしに実施しない。
- [ ] `C15-07` [記録] current check名・commit・実行数・結果と未実行理由を保存する。
- [ ] `C15-08` [記録] v0.1 acceptance C01–C15が閉じたと主張する証拠を個々に対応づける。

### C16 — M5 schema/contracts/proposal foundations
元台帳状態: N。対象: `companion_harness/packages/contracts/`, `packages/kernel/` (候補実装先); plan §18。依存: fake契約はC01–C03後に先行可。本番v0.2はM4/v0.1受入+write binding。memory I不要。
- [ ] `C16-01` [決定] M5 request/response/event schemasをstrict JSON・unknown fields拒否で定義する。
- [ ] `C16-02` [実装] migrationsにFK/composite ownership/session constraintsを追加し不正参照をDBで拒否する。
- [ ] `C16-03` [検証] Proposal immutable body/hashを作成時に固定し更新不能にする。
- [ ] `C16-04` [検証] expiryは合意15分境界を適用し期限直前/期限切れを検査する。
- [ ] `C16-05` [検証] sessionあたりpending proposal unique制約を競合下でも守る。
- [ ] `C16-06` [検証] Turn input variants/answer.submit state transition combinationsを表形式で漏れなく検証する。
- [ ] `C16-07` [実装] Grant/receipt/outcome state vocabularyをstrict contractとして追加する。
- [ ] `C16-08` [検証] migration/reopen/recovery後もproposal hash/ownership/immutable constraintsを保つ。
- [ ] `C16-09` [記録] fake schema acceptanceとproduction binding adoption gateを別記録にする。
- [ ] `C16-10` [記録] M5 requirementごとのtest case matrixを作り未実装を実績扱いしない。

### C17 — M5 stage-only Agent
元台帳状態: N。対象: `companion_harness/packages/kernel/` (候補: Action Agent); tests。依存: C16。
- [ ] `C17-01` [実装] Agentはproposal stageのみ行い外部write toolを呼べない境界を作る。
- [ ] `C17-02` [検証] 1 Turn最大1 proposal、超過tool callは拒否する。
- [ ] `C17-03` [検証] tool budget予約がstage前に行われ、超過時proposalなし。
- [ ] `C17-04` [実装] proposal previewにimmutable body/hash/target/source revisionを表示する。
- [ ] `C17-05` [検証] source-target matching不一致ではstage拒否しgrantを作らない。
- [ ] `C17-06` [検証] answer.submit成功CASだけpending proposalを原子的に作る。
- [ ] `C17-07` [検証] failed/cancelled/abandoned/submit raceではproposal absentを確認する。
- [ ] `C17-08` [検証] model prose/confirmation textはapproval eventにならない。
- [ ] `C17-09` [記録] fixture/tool traceでstage-onlyを証明しlive bindingと切り離す。
- [ ] `C17-10` [確認] existing M2 loop/tool count制約を再利用し別Action agent frameworkを増やさない。

### C18 — session-owned approve/reject atomicity
元台帳状態: N。対象: contracts/kernel/server APIs (候補), tests。依存: C16–C17。
- [ ] `C18-01` [実装] list proposalsをsession ownershipでfilterし他session IDを返さない。
- [ ] `C18-02` [検証] approve requestはproposal bodyHashとsession scopeを必須照合する。
- [ ] `C18-03` [検証] approve acceptedは202応答を返し、RunはactiveにならずAPI処理で実行しない。
- [ ] `C18-04` [検証] current-run/active-run absent条件とexpiry/hash CASを原子的に検査する。
- [ ] `C18-05` [実装] TurnExecutionGrant・Run・RunEventsを同一transactionで作成する。
- [ ] `C18-06` [検証] duplicate approve same key replayで一つのRun/Grantのみ作る。
- [ ] `C18-07` [検証] double approve different key時に二重write/runを起こさず競合を返す。
- [ ] `C18-08` [検証] rejectはkeyless state-idempotent、同一Turn rejection一回・Runなし。
- [ ] `C18-09` [検証] ownership/hash/expiry不一致応答は固定safe codeで情報漏洩しない。
- [ ] `C18-10` [記録] Turn approval inputは明示UI操作のみで自然言語を承認と誤認しない。

### C19 — ActionRun preflight/CAS/no-side-effect
元台帳状態: N。対象: kernel ActionRun executor (候補), Calendar connector reference pipeline; tests。依存: C18。production preflightはC08/C11/C12+write binding決定。
- [ ] `C19-01` [実装] pickup時Run queued→runningをCASしGrant single-use stateを確認する。
- [ ] `C19-02` [検証] action前にauthoritative source refreshを必ず実行する。
- [ ] `C19-03` [検証] current sourceRevisionとProposal sourceRevision一致時のみmaterializeを許す。
- [ ] `C19-04` [検証] stale revision/deleted/unknown sourceでexternal write回数0を確認する。
- [ ] `C19-05` [検証] stale/deleted rejectionがcompleted receipt付きの誤成功にならない。
- [ ] `C19-06` [検証] failed preflightでRun failed、Grant消費/再実行の仕様を明確にする。
- [ ] `C19-07` [実装] authoritative refresh後の新snapshot/rNとprovenanceを関連付ける。
- [ ] `C19-08` [検証] preflight failure/timeoutは安全なunknown/error分類でwrite前に終了する。
- [ ] `C19-09` [確認] candidate fake testsとreal provider readinessを混同しない。
- [ ] `C19-10` [記録] preflight outcomeごとのcall count/DB stateをmatrix化する。

### C20 — grant marker/outcome/readback/receipt
元台帳状態: N。対象: kernel ActionRun executor/receipt (候補), tests。依存: C19。
- [ ] `C20-01` [検証] Grant consume+executing marker+eventをexternal call前にatomic commitする。
- [ ] `C20-02` [検証] marker未commitならexternal callが実行されないことをcrash injectionで確認する。
- [ ] `C20-03` [検証] marker後process crashはoutcome unknown/abandonedとなり自動retryしない。
- [ ] `C20-04` [検証] external call結果をsucceeded/failed/unknownの三分類で保持する。
- [ ] `C20-05` [検証] succeeded後 authoritative readbackで新snapshot/rNを確認する。
- [ ] `C20-06` [検証] readback一致時のみverified receipt、未一致/不可時unverifiedまたはunknownにする。
- [ ] `C20-07` [検証] strict receipt schemaはnull/unknownを勝手にsuccessへ変換しない。
- [ ] `C20-08` [検証] Run terminal state/event/receipt更新をatomicにし部分terminalを作らない。
- [ ] `C20-09` [検証] error/unknown receiptにsecret/provider prose/raw payloadを含めない。
- [ ] `C20-10` [記録] call marker・readback証拠・receipt resultを独立観測として記録する。

### C21 — cancel/crash/recovery/drain matrix
元台帳状態: N。対象: kernel recovery/drain; tests; plan §18–19。依存: C19–C20。
- [ ] `C21-01` [実装] cancel endpointで最初にsession ownershipを照合する。
- [ ] `C21-02` [検証] cancel前terminalは200/current stateを返し副作用を再実行しない。
- [ ] `C21-03` [検証] executing marker前cancelはcancel winner・external writeなしにする。
- [ ] `C21-04` [検証] marker後cancelは409/unknown semanticsでありexternal operationを再送しない。
- [ ] `C21-05` [検証] race testでcancelとmarkerの両winner順序を別fixtureで再現する。
- [ ] `C21-06` [検証] recovery queued stateはqueuedのまま再起動後pickup可能とする。
- [ ] `C21-07` [検証] preflight/no marker crash recoveryはfailed/abandoned契約を適用する。
- [ ] `C21-08` [検証] executing marker crashをunknown/abandonedにし、operationを再実行しない。
- [ ] `C21-09` [検証] terminal stateはrecoveryで不変、impossible state pairはdatabase_state_invalid fail-closed。
- [ ] `C21-10` [検証] drain中 admissionは503、markerとevent stateをatomicにしshutdown budgetを守る。
- [ ] `C21-11` [記録] crash point×cancel state×recovery result matrixをtest evidence付きで保持する。
- [ ] `C21-12` [確認] fake model/providerで全matrixを通しlive OAuth/writeは行わない。

### C22 — approval UI/accessibility/safety acceptance
元台帳状態: N。対象: `companion_harness/apps/` UI/e2e (候補), tests; plan §18。依存: C16–C21。
- [ ] `C22-01` [実装] pendingかつvalid unexpired Proposalがある時だけapproval cardを表示する。
- [ ] `C22-02` [検証] proposal hash/body変更・expiry後にapprove buttonが無効化される。
- [ ] `C22-03` [検証] approve/reject操作は明示buttonのみで自然言語会話をapprovalにしない。
- [ ] `C22-04` [実装] source/target・予定action・expiry・hashを利用者が確認可能な形で表示する。
- [ ] `C22-05` [検証] Stop操作はpre-marker cancelとpost-marker unknownを正確に区別する。
- [ ] `C22-06` [実装] receiptはverified/unverified/failed/unknownの状態と手動確認noticeを表示する。
- [ ] `C22-07` [検証] UI keyboard/focus/label/status announcement等accessibility basicsを確認する。
- [ ] `C22-08` [検証] fake E2Eでexpiry/hash/duplicate/reject/cancel/unknown receipt matrixを確認する。
- [ ] `C22-09` [確認] live実行はopt-in + `writeEnabled=true` + dedicated write bindingの三重gateを要求する。
- [ ] `C22-10` [記録] readonly forkはwrite bindingではないこと、live approval証拠未取得を明記する。

## I Remind/Companion追加連携（未承認）

### I01 — integration contract decision gate
元台帳状態: D。対象: remind `plan.md` §12 U1 / Companion contracts (候補のみ)。依存: 連携実装前提。完了条件: scope追加採用/棄却の明示決定。
- [ ] `I01-01` [決定] integration version/protocol envelopeとcompatibility evolutionを決める。
- [ ] `I01-02` [決定] permitted scope mapping/trusted configとcaller identity境界を定義する。
- [ ] `I01-03` [決定] committed conversation event種別・eventId/turnId/runId sourcingを決める。
- [ ] `I01-04` [決定] AI judgment policyとuser_fact/model_inferenceの出所区別を合意する。
- [ ] `I01-05` [決定] write policy・idempotency stable key generation・privacy metadataを決める。
- [ ] `I01-06` [決定] per-call/turn budgets・timeout・disabled/degraded response contractを決める。
- [ ] `I01-07` [決定] opt-in/default-offとdowngrade/version mismatch behaviorを決める。
- [ ] `I01-08` [決定] 追加scopeを採用するか棄却するかdecision recordに明記する。

### I02 — async local CLI adapter
元台帳状態: N。対象: `companion_harness/apps/server/` (候補 adapter), `remind/.tmp-t6/src/cli.ts` (既存CLI)。依存: I01採用。
- [ ] `I02-01` [実装] local child processはasync spawn(shell=false)で起動しserver event loopをblockしない。
- [ ] `I02-02` [検証] strict UTF-8 JSON input/output・exact one LF-delimited responseをvalidateする。
- [ ] `I02-03` [検証] request/response bytes・stdout/stderr・durationを合意boundsで制限する。
- [ ] `I02-04` [実装] stderr/stdout separationを保ちstderrをprotocol dataとして採用しない。
- [ ] `I02-05` [検証] timeout child kill/termination wait後にchildを残さない。
- [ ] `I02-06` [検証] commit-unknown retryは同一opaque idempotency keyだけを使い二重writeしない。
- [ ] `I02-07` [検証] Companionとremind間にshared DB/direct importを持たない。
- [ ] `I02-08` [検証] remind child遅延時にもreal server health/status requestが応答する。
- [ ] `I02-09` [検証] disabled/missing CLI時memoryless応答で通常conversationを失敗させない。
- [ ] `I02-10` [記録] command/pathはtrusted configのみ、shell argument injectionがないことを記録する。

### I03 — committed conversation二pass memory write
元台帳状態: N。対象: Companion event lifecycle (候補), remind CLI (既存ops), integration tests。依存: I01–I02。
- [ ] `I03-01` [確認] conversationが確定済みと判断するsource event lifecycle境界を特定する。
- [ ] `I03-02` [実装] committed conversation rawをevent.appendで追記し未確定/failed Runを除外する。
- [ ] `I03-03` [実装] AI judgment後にrecord.rememberを別operation/transactionで呼ぶ。
- [ ] `I03-04` [検証] stable eventId/idempotency keysがretry/restart間で変わらず重複を防ぐ。
- [ ] `I03-05` [検証] sourceRefsの存在・同scope検査失敗時recordを作らない。
- [ ] `I03-06` [検証] user_factとmodel_inference/summaryをkind・provenanceで分離する。
- [ ] `I03-07` [検証] child failure/second pass failureでraw appendを記憶済みと偽装しない。
- [ ] `I03-08` [検証] run/session/source refs metadataはopaque IDsのみで本文をlogsへ出さない。
- [ ] `I03-09` [確認] memory writeは自律・承認なし、Calendarのhuman hash approvalとは別境界にする。
- [ ] `I03-10` [記録] first/second pass outcome、replay、failure recovery証拠を分けて残す。

### I04 — memory evidence/citation/exposure contract
元台帳状態: D。対象: Companion EvidenceGrant/Citation contract (existing)・remind scope/source (existing); integration contract is未決。依存: I01後I02–I03と並行可。
- [ ] `I04-01` [決定] memory snippetをuntrusted evidenceとして扱い命令実行/真実保証しない契約を決める。
- [ ] `I04-02` [決定] EvidenceGrant/Citationとmemory source_kind/rN対応の要否を既存APIとの整合で判断する。
- [ ] `I04-03` [決定] sourceRefとcitation provenanceの安定identity/refresh semanticsを定める。
- [ ] `I04-04` [決定] exposed IDs/recallId/scope mappingを限定し無制限memory injectionを禁止する。
- [ ] `I04-05` [決定] used-only feedback条件を定め、mere recallでheatを上げない。
- [ ] `I04-06` [決定] correction後も既存citation immutable snapshotとして保つか明記する。
- [ ] `I04-07` [決定] contract変更要否を既存 ReferenceManager APIs/testsの根拠で判断する。
- [ ] `I04-08` [記録] I02–I03完成を不要な依存にせず契約決定を先行記録する。

### I05 — fake cross-repo E2E/failure isolation
元台帳状態: N。対象: Companion E2E/adapter (候補), remind CLI/temporary DB; tests。依存: I02–I04。
- [ ] `I05-01` [実装] fake cross-repo harnessでCompanion real server/UIとremind temporary DBを隔離接続する。
- [ ] `I05-02` [検証] adapter disabled/missing CLIではmemoryless normal responseとなる。
- [ ] `I05-03` [検証] DB corrupt/permission failureではfixed safe errorと通常応答縮退になる。
- [ ] `I05-04` [検証] child timeout/kill/restartでserver nonblockingかつorphan processなし。
- [ ] `I05-05` [検証] invalid UTF8/JSON/extra stdout lines/oversize responseは拒否しmemory evidenceを採用しない。
- [ ] `I05-06` [検証] scope injection/cross-scope sourceRef/prompt injectionを防ぐ。
- [ ] `I05-07` [検証] 二pass event.append→rememberのpartial failure/replayを確認しfailed Run outputをfactにしない。
- [ ] `I05-08` [検証] feedbackは実際にexposed/used IDsのみでheat変更する。
- [ ] `I05-09` [検証] process/DB/API間でshared DB/importがなく、user dataを書き込まない。
- [ ] `I05-10` [記録] fake E2E結果をlive Companion↔memory deployment evidenceと区別する。

## 最初の実装候補と決定待ち
- 最初の不足coverage候補: `R05` 新M1計画のshared-file-DB correction race（勝者1/敗者CONFLICT/orphanなし）を実証。旧T4 race proofは使わない。
- 次に `C04` JSON fallbackからterminalまでの実Browser E2E、`C05` duplicate-seq/gap E2Eを既存harnessで確認する。coverage棚卸し後、不足だけ追加する。
- `C06`は正常202受領後active-run reloadの再現調査から始める。pending-key-lost delivery reloadとは分離し、無断localStorage/API拡張なし。
- 決定待ち: R09 embedding model/license/pin、R13評価threshold、R14 distill/old record扱い、C08 M4 exact upstream binding/formal adoption、C11 deletion evidence、C15 readonly live consent、I01 integration追加scope・I04 evidence contract、C22/M5 dedicated write binding。いずれも候補を合意仕様に昇格させない。

## 作成時点の検証記録
- 参照したのは上記正本と計画/operations/spike/designの必要箇所、および `active_projects_plan.md`。rootにREADME/docsはなく、remind正本はnested `.tmp-t6`。
- 全体readでG/R/C/Iの47見出しとID連番を照合し、各親の連番個数を集計した: G18、R150、C01–C15 120、C16–C22 72、I46、計406（既存scope 360、追加I scope 46）。checkbox ID重複・番号欠けなし。shellからの機械集計はWSL `/bin/bash` 起動失敗で未実施。テスト/CI/OAuth/network/installも未実行。shell失敗はtest未実行でありソース不具合ではない。
- Branch/commit/status/dirty/integration/runtime/current CI/test successは実測していない。計画にある参照SHA/過去CIは現在の事実として主張しない。

## 現況追記（2026-10-15、履歴保持・checkbox/ID/件数不変）
- Companion explicit memory management（I02/I03 管理面＋I04 確認契約の範囲）: search（retired 含む・no-heat）・current-vs-snapshot confirm・source event→real correct chain・retire/reactivate（削除/非表示ではない）を実装。UI 同期 invalidation/generation guard・pending reset＋poll identity・stale ack 非再利用、7 integrity 回帰を含む。full Vitest 113 files/1370・browser GREEN・live GREEN・typecheck＋lint GREEN（synthetic gateway の限定付き）。perception/export/deletion 未実装維持。I01/I04 正式採用判断・Windows manual・現行 CI は未完維持。

## 現況追記（2026-10-16、AV autonomy foundationのみ・履歴保持・checkbox/ID/件数不変）
- AV01/AV03/persist+stop foundationのみ（全AV完成は主張しない）: purposes（scope/kind/provenance/interpretation/window、訂正は新record+原文superseded保持、revoke/achieve、explicit pair conflictのみ）＋ tasks（standalone/attached、start/hold/resume+evidence・explicit replacement parentのみ・blind 409、parent遷移は依存held化、null deadline既定、permissionはclaimのみ）＋ global stop（CAS、default paused、restart fence version+1 re-pause）。永久browser `autonomy.spec.ts` 4/4（metadata/scope/time保持・explicit新parent resume・late A/B draft破棄・version refresh無効化）＋ full default e2e 28 passed（GREEN再実行なし）＋ `autonomy_http` 3/3・`autonomy_slice` 11/11、Biome clean、root tscは既存better-sqlite3 TS7016のみ。no-runtime-permission。残件: AV02 shadow、AV04 learning、AV05 notify、AV06 priority、AV07 supervisor、AV08 maintenance/handoff。

## 現況追記（2026-10-17、AV02 shadow-deliberation完成・履歴保持・checkbox/ID/件数不変）
- AV02 full vertical（kernel＋service＋HTTP＋UI）: missing_grant は決して実行しない（claim≠grant、zero executions）。scope読取は repository getter のみ（Markdown/memory connectorなし）、memoryはUNTRUSTED・1 bounded call（`autonomy_deliberation.submit` ONE dot）。persistent queue＋input-complete fence＋foreground/STOP/restart保全（catchupなし）。UI latest-intent・stable retry・textContent・composer保全。full Vitest 136/1557（8 skipped、real CLI）＋ browser 32（28＋shadow 4）＋既往 smoke 17/17（synthetic）＋ root/e2e tsc 0＋Biome 0。残件: AV05 notifications、AV06 shared resources、AV07 external supervisor/recovery、AV04 methods learning、AV03 conversation task-proposals＋actual pi-orch handoff、AV08 maintenance、未解決 device/standing/external rollout。

## 現況追記（2026-10-17、autonomy trial E2E・履歴保持・checkbox/ID/件数不変）
- 自律 trial 実行系の実装＋合成モデル E2E（A 承認→完了、B STOP→revoke）を検証済み。証拠: `AV-E2E-RESULTS.json` run7（A consumed/authorized・B revoked/unauthorized・unit 消滅・Task/Goal 非完了維持）、`AV-SERVER-TRIAL-RESULTS.json`・`AV-RUNNER-RESULTS.json`・`AV-RELAY-RESULTS.json`・`AV-AUTHORITY-RESULTS.json`。throwaway driver 削除済み、運用 docs 追記済み。残: real model/hardware/resource caps 未選定、real model run 未実施、Own-pi 変更 uncommitted、Remind ops/graph done・commits pending。
