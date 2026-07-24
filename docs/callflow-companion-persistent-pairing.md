# CallFlow Companion — 信頼済み端末方式（永続ペアリング）

作成日: 2026-07-24
対象ブランチ: `feature/persistent-companion-pairing`

---

## 1. 目的

これまでCompanion（Mac上のローカル処理アプリ）は、ペアリングで発行したBearerトークンを
メモリ上だけで管理していたため、**Companionを再起動するたびに6桁のペアリングコードを
入力し直す必要があった**。本フィーチャーは、同じMac・同じChrome・同じ本番Originの組み合わせ
であれば、一度ペアリングした後はCompanion・Macの再起動をまたいでも再ペアリング不要になる
「信頼済み端末方式」へ改修する。

対応範囲は永続ペアリングのみ。既存のOrigin完全一致・HTTPS・Bearer認証・timing-safe比較
などの既存の認証機構は変更していない。

---

## 2. 保存する情報・保存しない情報

- **保存するもの**: 発行したBearerトークンのSHA-256ハッシュ（16進64文字）と発行時刻のみ。
- **絶対に保存しないもの**: 生のBearerトークン自体。ログにも一切出力しない。
- 保存先: `~/Library/Application Support/CallFlow Companion/pairing-tokens.json`
  （**リポジトリ外**。既存の証明書・一時ファイルと同じ`Application Support`配下）。
- ディレクトリ権限0700・ファイル権限0600。所有者（実行ユーザー）以外は読み書きできない。

### 保存ファイルの形式

```json
{
  "version": 1,
  "tokens": [
    { "tokenHash": "<sha256 hex>", "issuedAt": 1732400000000 }
  ]
}
```

---

## 3. 実装（`companion/src/pairing-store.ts`）

- `loadTokenStore(filePath)`: 保存済みトークンハッシュを読み込む。ファイルが存在しない・
  JSONとして壊れている・スキーマが不正・symlinkである等、**いずれの異常でも例外を投げず
  空配列を返す**。Companionの起動そのものはクラッシュせず、単に「保存済みトークンなし
  （未ペアリング状態）」として起動する。
- `saveTokenStore(filePath, tokens)`: 同一ディレクトリ内に排他作成（`'wx'`フラグ）した
  一時ファイルへ書き込んだ後、`fs.rename()`で本来のパスへ置き換える（atomic write）。
  `rename()`はdestinationのディレクトリエントリ自体を置き換えるだけでsymlinkのリンク先を
  辿らないため、保存先パスへのsymlink-swap攻撃に対しても安全。
- ディレクトリ・ファイルがsymlinkだった場合は安全のため作り直す（`ensureSecureDir`相当の
  処理）。この一連の挙動は`companion/src/pairing-store.test.ts`（11ケース）で検証済み。

`companion/src/temp-files.ts`（一時音声ファイル用）の既存パターン（0700/0600・排他作成・
lstatベースの非追従判定）をそのまま踏襲している。

---

## 4. `PairingManager`の拡張（`companion/src/pairing.ts`）

- コンストラクタが`persistedTokens`を受け取れるようになり、Companion起動時に
  `pairing-store.ts`から読み込んだハッシュ一覧を渡してハイドレートする。
- `revokeCurrentToken(authorizationHeader)`: 指定した1トークンだけを失効させる
  （既存の`verifyToken`と同じtiming-safeな比較で対象を探す）。
- `revokeAllTokens()`: 保存されているすべてのトークンを一括で失効させる。
- `listStoredTokens()`: 永続化のため、現在有効なトークンハッシュ一覧を返す
  （生トークンは一切含まれない）。

既存の6桁コード検証・timing-safeなトークン照合ロジックは変更していない。

---

## 5. サーバー側の新しいエンドポイント（`companion/src/server.ts`）

いずれも`/v1/audio`・`/v1/transcriptions`等と同じ「Origin完全一致チェック→Bearer認証
チェック」の順序・CORSヘッダー付与ルールに従う（ワイルドカードは使用しない）。

| メソッド・パス | 用途 | 認証失敗時 |
|---|---|---|
| `GET /v1/pair/status` | 保存済みトークンが今も有効かを確認（自動接続用） | 401 unauthorized |
| `POST /v1/pair/revoke` | 呼び出し元のトークンだけを失効 | 401 unauthorized |
| `POST /v1/pair/revoke-all` | すべての端末のトークンを一括失効 | 401 unauthorized |

ペアリング成功時・失効時のいずれも、`saveTokenStore()`で即座に永続化ファイルへ反映する
（永続化の書き込みに失敗しても、そのHTTPレスポンス自体は失敗させない＝ディスク書き込み
エラーで今回のセッションの利用が止まらないようにする安全側の設計）。

Companion起動時（`startServer()`）は、`loadTokenStore()`で永続化ファイルを読み込んでから
`PairingManager`を構築する。`close()`（`npm run companion:stop`等での終了処理）は
一時音声ファイル（`tmpDir`）のみ清掃し、`pairing-tokens.json`には一切触れない。

---

## 6. ブラウザ側の自動接続（`src/lib/companion-client.ts` / `src/components/call-recorder.tsx`）

- 新しいクライアント関数: `checkPairingStatus`, `revokePairing`, `revokeAllPairings`
  （いずれも既存の`fetchWithTimeout`/`assertValidCompanionUrl`/`parseErrorResponse`の
  仕組みにそのまま乗る）。
- 画面表示時（マウント時）、保存済みトークンがあれば裏側で`checkPairingStatus`を呼び、
  画面自体は最初から「Macの処理アプリ：接続済み」と楽観的に表示する（チラつきを避けるため）。
  - 実際に**401（unauthorized）**が返った場合のみ、トークンを破棄して未ペアリング状態
    （ペアリングコード入力UI）へ戻す。
  - それ以外の失敗（Companion未起動・タイムアウト・forbidden_originなど）では、
    トークンは維持したまま「Companionが起動していません」という別の表示に切り替える。
    再ペアリングは一切促さない。手動の「再確認」ボタンで、新しいコード無しに再接続できる。
- 「ペアリングを解除」は非同期になり、`POST /v1/pair/revoke`をベストエフォートで呼んでから
  （失敗しても）必ずブラウザ側のトークンを消す。新たに「すべての端末を解除」（revoke-all）
  も追加した。

---

## 7. macOS LaunchAgent（ログイン時自動起動）

既存の`npm run companion:start`/`stop`/`check`（HTTPS・手動起動）は**一切変更していない**。
LaunchAgentはこれに追加される、もう一つの起動経路。

- `scripts/callflow-companion-launchagent-run.sh`: launchd専用の起動スクリプト。
  `nohup ... &`のような自己バックグラウンド化はせず、`exec node companion/src/server.ts`で
  シェルプロセス自身をCompanionプロセスに置き換える（launchdがフォアグラウンド子プロセスを
  直接superviseできるようにするため）。証明書パス・ポート(4318)・tmpDirの環境変数は
  既存の`start-callflow-companion.sh`と同じ値を使う。
- `scripts/install-callflow-companion-launchagent.sh`: `~/Library/LaunchAgents/com.callflow.companion.plist`
  を生成し、`launchctl bootstrap gui/$(id -u)`で読み込む。**sudoは不要**（per-user
  LaunchAgentであり、system-wideのLaunchDaemonではない）。nodeの絶対パスをplistの
  `EnvironmentVariables`へ埋め込む（launchdの最小限PATHでも`node`コマンドを解決できるように
  するため）。証明書未セットアップ・ポート競合（`npm run companion:start`で既に起動中）を
  検出した場合は警告を表示する（インストール自体は止めない）。
- `scripts/check-callflow-companion-launchagent.sh` / `uninstall-callflow-companion-launchagent.sh`:
  登録状態の確認、および`launchctl bootout`＋plist削除による取り消し。証明書・永続化された
  ペアリング情報・一時ファイルには一切触れない。
- `KeepAlive.SuccessfulExit=false`（異常終了時のみ自動再起動、意図的な終了では再起動しない）・
  `ThrottleInterval=10`（再起動の暴走を防止）を設定。bind先は既存実装同様127.0.0.1:4318のみ
  （実装上0.0.0.0へのbindは不可能）。LaunchAgentのインストール・起動自体はローカルの
  127.0.0.1での待受を開始するだけで、それ以外の外部通信は一切発生しない。
- npm scripts: `companion:launchagent:install` / `:uninstall` / `:check`。

**運用上の注意**: `npm run companion:start`（手動）とLaunchAgentは同時に同じポート4318を
奪い合う。どちらか一方だけを使うこと。

---

## 8. 再ペアリングが必要になる条件（意図した挙動）

以下の場合のみ再ペアリングが必要になる。それ以外（単なるCompanion・Macの再起動）では
不要。

- ユーザーが明示的に「ペアリングを解除」した
- ユーザーがChromeのサイトデータを消去した
- 別のブラウザ・別のChromeプロファイルを使った
- 別のMacを使った
- Mac側の永続化ファイル（`pairing-tokens.json`）が削除された
- 「すべての端末とのペアリングを解除」等、明示的な失効操作が行われた

---

## 9. テスト

- `companion/src/pairing-store.test.ts`（新規、11件）: 永続化・破損時のフォールバック・
  symlink攻撃への耐性・パーミッションなど。
- `companion/src/pairing.test.ts`（拡張）: 永続化トークンからのハイドレーション（＝
  Companion再起動相当の試験）、`revokeCurrentToken`/`revokeAllTokens`。
- `companion/src/server.test.ts`（拡張）: `/v1/pair/status`・`/v1/pair/revoke`・
  `/v1/pair/revoke-all`のHTTPレベル試験、実際に2つの`startServer`インスタンスを同じ
  `tokenStorePath`で起動して「再起動後も既存トークンで認証が通る」ことを確認する試験、
  `close()`が永続化ファイルを削除しないことの確認、破損した永続化ファイルでも起動が
  クラッシュしないことの確認。
- `src/lib/companion-client.test.ts`（拡張）: 新しいクライアント関数、および
  unauthorized（401）とnetwork_errorが明確に区別されることの確認。

npm test（150件）・npm run companion:test（172件）とも全件成功。
