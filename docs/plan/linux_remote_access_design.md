# Linux 集約・リモートアクセス設計

- 状態: 決定済み方針（N1–N7・NODE26、決定者 haruka、日付 2026-10-18、出典 `docs/plan/decision_inputs_2026-10-18.md` §G）＋設計案
- 前提ブランチ: 本書は `origin/docs/ledger-sync-2026-10-18` を基盤とする `docs/linux-remote-access-design` ブランチで作成（`decision_inputs_2026-10-18.md` が `origin/master` に未存在のため。master 直載せではない）
- 目的: Companion server＋data＋remind を Linux に集約し、Windows PC・スマホはブラウザのみで利用する。tailnet 外への公開はしない

## 1. 現状コード所見（根拠 file:line）

- listen/bind: `apps/server/src/config.ts:33`（`DEFAULT_HOST = "127.0.0.1"`）、`apps/server/src/config.ts:39`（`HostSchema` は `127.0.0.1`/`localhost` のみ）、`apps/server/src/bootstrap.ts:2702`（`serve({ fetch: app.fetch, port: config.port, hostname: config.host })`）。サーバーは loopback にのみ bind する構成であり、N2（0.0.0.0 bind 禁止）と整合する
- Host 検査: `apps/server/src/app.ts:360`（`checkHost`: loopback ホスト名のみ許可、health 含む全 route に適用 `apps/server/src/app.ts:868`）。`apps/server/src/app.ts:322-327`（`isLoopbackHostName`、`hostNameOfHeader` は header 文字列処理のみで proxy 対応なし）
- mutation 検査: `apps/server/src/app.ts:411-437`（`checkMutationSecurity`: `origin === http://${host}` の同一オリジンのみ許可、`Origin: null` 拒否、Origin 欠落は Sec-Fetch なし CLI 的リクエストのみ許容）。https・tailnet オリジン・Host allowlist の概念は存在しない
- auth/cookie なし: `apps/server/src/app.ts` にログイン・パスワード・セッション Cookie 機構は存在しない（`session` は会話 session の意味でのみ使用）。`/health/live`・`/health/ready` は無認証（`apps/server/src/app.ts:1058-1066`）
- `remoteAddress` 参照なし: loopback 判定は Host ヘッダ文字列のみで行われており、接続元 IP による認証は存在しない（＝導入してはならないことの裏付け）
- UI: `apps/server/src/ui/page.ts:41`（viewport `width=device-width, initial-scale=1` 済み）、`apps/server/src/ui/client.css`（全 49 行、media query・responsive 対応なし）、fetch は `credentials: "same-origin"`（`apps/server/src/ui/client.ts:286`）で Cookie 送付と両立可能。SSE は `EventSource` 使用（`apps/server/src/ui/client.ts:415` 付近）
- Node pin: `.github/workflows/ci.yml:51,93`（`node-version: 24.12.0`）、`package.json:8`（`"node": "24.12.0"`）

## 2. トポロジ（推奨）

```text
[Windows ブラウザ / スマホブラウザ]
  --https--> [tailscale serve (tailnet: https://<host>.<tailnet>.ts.net, Tailscale 発行証明書)]
  --http---> [127.0.0.1:<port> Companion server (bind 変更なし)]
```

- 推奨: **サーバーは loopback bind のまま（N2 充足・コード変更不要）、`tailscale serve` が tailnet 側 HTTPS 終端＋127.0.0.1 への proxy を担う**。TLS・証明書更新の運用が Tailscale 側に寄り、アプリは秘密鍵を持たない
- 対案（tailscale IP への直接 bind）の評価: `HostSchema`（`apps/server/src/config.ts:39`）拡張＋`checkHost`/`checkMutationSecurity`（`apps/server/src/app.ts:360,411`）の書換えが必須となり、誤って 0.0.0.0 へ広げる事故面が増える。コード所見上、対案を正当化する事情（例: proxy 経由で失われる情報の必要性）はないため**対案は不採用**。将来、tailnet IP 直受けが必要になった場合のみ再評価する
- 帰結: **proxy 経由の全リクエストは接続元が 127.0.0.1 に見える**。したがって `remoteAddress`/loopback 到達性をもって認証扱いしてはならない（現行コードも IP 認証はしていない）。認証は §3 のセッション Cookie のみを根拠とする。`X-Forwarded-*` は §6 の扱いに限定する

## 3. 認証設計（N4）

- 方式: 単一ユーザーパスワード＋サーバー発行セッション Cookie（defense in depth。tailnet ACL が第一層、アプリ層が第二層）
- パスワード保管: ハッシュを **SQLite 外**に保存する（secret-not-in-DB ルール）。argon2id 等の memory-hard ハッシュ。**初期設定・変更は CLI/setup コマンド経由のみ**（`COMPANION_*` env での平文受渡し不可）
- セッション Cookie: `HttpOnly`・`Secure`・`SameSite=Strict`、値は不透明ランダムトークン（128bit 以上）、サーバー側はトークンのハッシュのみ保持（漏洩時の再利用防止）
- 有効期限: 案として絶対有効期限 30 日・アイドル timeout 7 日を提案する（**未決**: 実測・haruka 確認で確定する）。logout（明示無効化）・rate limiting（ログイン試行: IP＋アカウント単位の exponential backoff、案: 5 回失敗で 15 分 lock。**未決**）を必須とする
- 適用範囲: **全 API＋SSE はセッション必須**。`/health/live` はプロセス死活のみ返すため無認証のまま許容する（案）。`/health/ready` は内部状態を含むため要セッションとする（案。**未決**: 監視用途で無認証 ready が要る場合は allowlist IP ではなく専用トークン方式で別途設計）
- ログイン失敗時の応答は user 枚举を避け一律メッセージとする

## 4. Origin allowlist・Host・CSRF（N5）

- 方針: loopback 暗黙許可をやめ、**明示的 Origin allowlist** に置換する（N5）。現行 `checkMutationSecurity`（`apps/server/src/app.ts:411`）の `http://${host}` 単一比較は tailnet HTTPS オリジンに対応できないため置換対象
- allowlist 例（設定値。具体値は導入時に確定）: `https://<host>.<tailnet>.ts.net`、およびローカル開発用 `http://127.0.0.1:<port>`・`http://localhost:<port>`
- Host ヘッダ検査: allowlist 由来ホストのみ許可（現行 `checkHost` の loopback 固定を拡張。未知 Host は 403/400 で拒否）。`Host` と `Origin` の両検査を行い、どちらか一方のみの一致で通過させない
- state-changing リクエスト（POST/PUT/PATCH/DELETE）: Origin 検査＋`Content-Type: application/json` 必須（現行維持）を継続し、CSRF 対策とする。CORS ヘッダは発行しない（現行どおり。tailnet 内利用は同一オリジン提供のため不要）
- GET API・SSE も Origin/Host 検査の対象とする（現行は mutation のみ検査）。`EventSource` は Cookie を自動送付するため、SSE ハンドシェイク時にセッション＋Origin を検査する

## 5. trusted proxy 扱い・SSE（N2/N3 補足）

- `tailscale serve` のみを trusted proxy とする。`X-Forwarded-For`/`X-Forwarded-Proto` は**ログ表示用途に限定**し、認証・認可・allowlist 判定には使用しない（ヘッダ偽造で迂回されるため）
- `X-Forwarded-Proto` をもって http/https を切替える処理は入れない（アプリは終始 http 前提。Secure Cookie は `tailscale serve` 終端の https によりブラウザ側で有効）
- SSE over proxy: `tailscale serve` の buffering が SSE を遅延させないことを ops 手順（§9(d)）の smoke で確認する。異常時は proxy の buffering 無効化手順を docs に残す

## 6. スマホ UI 最低限（N6、scope 限定）

- viewport は設定済み（`apps/server/src/ui/page.ts:41`）。追加 scope は以下に限定する
  1. 狭幅レイアウト崩れの修正（`client.css` に media query 追加。横スクロールなしで読書・composer 操作が可能であること）
  2. タッチ target 最低 44px（主要ボタン・composer 送信）
  3. ズーム・文字サイズ 200% での操作可能性（受入は目視＋実機ブラウザ smoke）
- 対象外: ネイティブアプリ化、push 通知、オフライン対応、全面リデザイン

## 7. config キー（default-off 原則）

- 既定では現行 loopback 動作を完全維持する（remote 無効時は `checkHost`・`checkMutationSecurity` の現行挙動そのまま）。新設キー例（案。名称は実装 PR(a) で確定）:
  - `COMPANION_REMOTE_JSON` または `COMPANION_REMOTE_ENABLED`（既定 false。true のみ §4 の allowlist 検査が有効化）
  - allowlist 本体（既定空。空のまま remote 有効化は起動失敗＝fail closed）
  - セッション有効期限・アイドル timeout・rate limit 値（既定は §3 の案。**未決**）
- env 命名は既存 `COMPANION_*` 則（`apps/server/src/config.ts:1208-1242`）に従い、strict JSON / zod 検証・fail closed とする

## 8. 移行・互換

- remote 無効時: 挙動・設定・テストは現状と同一（互換性影響なし）
- remote 有効化手順（Linux): 1) CLI でパスワード設定 2) config に allowlist 設定 3) `tailscale serve` 公開 4) §10 の smoke 実行。手順書は PR(d) で整備する
- ロールバック: remote フラグを false に戻すだけで loopback 運用に復帰できる

## 9. テスト計画

- unit: 未認証 API/SSE が 401/403 になること、不正 Origin が拒否されること、未知 Host が拒否されること、Cookie フラグ（HttpOnly/Secure/SameSite=Strict）の付与、トークンハッシュ保存（平文なし）、rate limiting、logout 無効化、有効期限切れ
- e2e（loopback＋仮想 proxy 経由）: 正常ログイン→操作→logout の一連、proxy 経由リクエストが 127.0.0.1 に見えてもセッションなしでは拒否されること（§2 帰結の回帰防止）、SSE 認証
- 既存 suite の remote 無効時 green 維持（互換回帰）

## 10. 受入 smoke（N7 代替）

- D1（Windows server-run 手動 smoke）は保留（`decision_inputs_2026-10-18.md` D1 追記参照）
- 代替受入: **Windows ブラウザ・スマホブラウザ → Tailscale 経由 → Linux サーバー** の smoke。項目: https 到達、ログイン、会話一往復、SSE 受信、logout 後の再拒否、不正 Origin 拒否の目視。手順書は PR(d) で整備する

## 11. 対象外

- インターネット公開・ポート開放・0.0.0.0 bind
- マルチユーザー・権限ロール・OAuth/SSO
- 自前証明書運用・他リバプロ（Caddy/nginx 等）への置換
- ネイティブアプリ・push・オフライン

## 12. 実装 PR 分割

- (a) config＋Origin/Host allowlist: 新設 config キー（default-off）、allowlist/Host 検査、既存検査の置換、unit＋互換回帰
- (b) auth/session: パスワード設定 CLI、ログイン/logout、セッション Cookie、rate limiting、全 API＋SSE の保護、health 方針確定、unit＋e2e
- (c) mobile UI: §6 の 3 項目のみ、実機 smoke
- (d) docs/ops: `tailscale serve` 公開手順・§10 smoke 手順・ロールバック手順

## 未決事項

- U1: セッション絶対期限・アイドル timeout の最終値（案: 30 日・7 日）
- U2: ログイン rate limiting の閾値（案: 5 回失敗で 15 分 lock）
- U3: `/health/ready` の扱い（案: 要セッション。監視用途の例外要否）
- U4: allowlist・config キーの最終名称と値（実装 PR(a) で確定）
- U5: `tailscale serve` の SSE buffering 実測結果（ops 手順で確認）
