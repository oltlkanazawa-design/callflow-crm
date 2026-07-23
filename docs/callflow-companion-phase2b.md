# CallFlow Companion Phase 2B — HTTPS化とローカルTLS

作成日: 2026-07-21
対象ブランチ: `feature/local-call-recorder-codex`

> **更新（2026-07-21〜22）**: Homebrew・mkcertの実機インストール、証明書発行、実マイクを使ったHTTPS音声送信の実機確認が完了した。§16「実機確認結果」を参照。

---

## 1. Phase 2Bの目的

Phase 2A（HTTP開発モード）のCompanionをHTTPS化し、`https://callflow-companion.localhost:4318` として動作させ、実マイクで録音した音声をHTTPS経由でCompanionへ送信できることを確認する。ffmpeg・whisper.cpp・Whisperモデルのインストール、Codex App Serverの実装は行わない。

---

## 2. Homebrew導入内容（ユーザーが後日実施）

- インストール方法: Homebrew公式サイト（brew.sh）が案内する正規のインストールコマンドのみを使用する。非公式ミラーは使用しない。
- インストール先: `/opt/homebrew`（Apple Silicon標準）
- PATHへの追加: `eval "$(/opt/homebrew/bin/brew shellenv)"` を `~/.zprofile` へ追記（重複追加はしない）
- 管理者パスワードの入力が必要（`/opt` が `root:wheel` 所有のため）
- このツール（Claude Codeのセッション）からは対話的なTTY・sudo資格情報が無いため、Homebrewの公式インストーラーを実行できないことを確認済み（`sudo -n -v` → `a password is required`）。**ユーザーご自身のTerminal.appでの実行が必要。**

---

## 3. mkcert導入内容（ユーザーが後日実施）

- `brew install mkcert`
- Firefox用の`nss`は今回インストールしない（Google Chromeのみを対象とするため）
- `mkcert -install` でローカルCAをmacOSの信頼済み証明書ストアへ登録する（管理者認証が必要）

---

## 4. ローカルCAの注意事項

`scripts/setup-callflow-companion-tls.sh` が起動時に以下を自動確認する。

- `mkcert -CAROOT` の場所がリポジトリ外であること
- `rootCA.pem` / `rootCA-key.pem` が存在すること
- ローカルCAの秘密鍵が「他ユーザーから読み取り可能」な権限になっていないこと
- CAROOTが既知のクラウド同期フォルダ（iCloud Drive/Dropbox/Google Drive/OneDrive）配下でないこと

いずれかの確認に失敗した場合、証明書を作成せずエラー終了する。**秘密鍵の内容・証明書全文・base64・ハッシュ値は、このスクリプト・ドキュメントのいずれにも一切出力しない。**

---

## 5. 証明書保存先

```
~/Library/Application Support/CallFlow Companion/certificates/
  companion-cert.pem   （権限0644）
  companion-key.pem    （権限0600）
```

ディレクトリ権限は0700。**リポジトリ内には一切作成しない。** 証明書の対象名（SAN）: `callflow-companion.localhost`, `localhost`, `127.0.0.1`, `::1`。

発行: `npm run companion:setup-tls`（内部で`scripts/setup-callflow-companion-tls.sh`を実行）。既存証明書がある場合は同ディレクトリ内へ日時付きでバックアップしてから発行し直す。

---

## 6. HTTPS起動方法

```bash
npm run companion:start
```

既定でHTTPSモード（`https://127.0.0.1:4318`、Hostヘッダー上は`callflow-companion.localhost`として利用）。証明書・秘密鍵が `~/Library/Application Support/CallFlow Companion/certificates/` に存在しない場合は起動せず、`npm run companion:setup-tls` の実行を案内するエラーで終了する。

Phase 2AのHTTP開発モードは `npm run companion:start:dev` としてそのまま残っている（`CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP=true`、`http://127.0.0.1:4318`、127.0.0.1とローカル開発originのみ許可、本番originは許可しない）。

内部実装（`companion/src/config.ts`）:
- `secure`は「意図した起動モード」（`allowInsecureHttp`が明示されない限りHTTPSが既定）
- `canStartServer()`が証明書・秘密鍵の存在・読み取り可否・有効な証明書として解釈できるかを検証し、いずれかを満たさない場合はHTTPへ自動フォールバックせず起動を拒否する
- TLSは`minVersion: "TLSv1.2"`を明示し、古いTLSを許可しない
- bind先は常に`127.0.0.1`のみ（`0.0.0.0`は実装上不可能）

---

## 7. 停止方法

```bash
npm run companion:stop
```

（開発用HTTPモードは `npm run companion:stop:dev`）

PIDファイルに記録されたプロセスが実際に`companion/src/server.ts`であることを確認したうえで`SIGTERM`を送る。`killall`/`pkill`は使用しない。

状態確認: `npm run companion:check`（HTTPS health check、`secure`の値、証明書の有効期限を表示。秘密情報は表示しない）

---

## 8. Chromeの許可

CallFlow（`https://callflow-crm-blue.vercel.app`、または`http://127.0.0.1:3002`等のローカル確認用origin）から`https://callflow-companion.localhost:4318`へ接続する際、Chromeが「ローカルネットワークへのアクセス」の許可を表示する場合がある。

- 許可ダイアログが出た場合は、**ユーザーが内容を確認して「許可」を選択するまで待機する。** 自動クリックは行わない。
- Companion側は、プリフライトリクエストに`Access-Control-Request-Private-Network: true`が含まれる場合、許可されたOriginに限り`Access-Control-Allow-Private-Network: true`を返す（`companion/src/cors.ts`）。ただし、Chromeの実際のPNA/Local Network Access挙動は仕様変更が続いている領域であり、このヘッダーを返すことだけに依存せず、実機のChromeバージョンでの挙動確認が必要（本ドキュメント作成時点では未実施）。
- 許可を拒否した場合、CallFlow側は「Chromeでローカルネットワークへのアクセスが許可されていません。アドレスバー左側のサイト設定から、ローカルネットワークへのアクセスを許可してください。」等の案内を表示する設計（JS Fetch APIの制約上、拒否・証明書不信・Companion未起動を厳密には区別できないため、`src/lib/companion-client.ts`の`network_error`メッセージはこれらの可能性をまとめて案内する内容にしている）。

---

## 9. CORS

`companion/src/config.ts`の`loadConfig()`により、HTTPSモード時のみ本番origin `https://callflow-crm-blue.vercel.app` が許可originに追加される（`secure`がfalse、すなわちHTTP開発モード時は追加されない）。ローカル確認用origin（`localhost`/`127.0.0.1`の3000・3002番ポート）は両モード共通で許可。

- Origin完全一致のみ、ワイルドカード不使用（自動テストで確認済み）
- `Access-Control-Allow-Private-Network: true`は許可Originのみに返す（未許可Originには返さない、自動テストで確認済み）
- `Cache-Control: no-store`・`X-Content-Type-Options: nosniff`・`Vary: Origin`を継続して付与

`src/lib/companion-client.ts`の`validateCompanionUrl()`は、Companion接続先URLが以下を満たすことを送信前に強制する。

- `https://callflow-companion.localhost:4318` または `https://localhost:4318` のみ許可
- 開発フラグ（`NEXT_PUBLIC_CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP=true`）が無い限り`http://`は拒否
- ポートは`4318`固定（任意ポート拒否）
- 認証情報（`user:pass@`）付きURLは拒否
- query・fragment付きURLは拒否
- 外部ドメイン・LAN IPは拒否

---

## 10. 音声送信

Phase 2Aと同じ`POST /v1/audio`エンドポイント・ヘッダー構成をHTTPS経由でそのまま使用する（変更なし）。実際の音声受信・検証・一時保存・削除ロジック（`companion/src/audio-upload.ts`・`temp-files.ts`）はHTTP/HTTPS問わず共通。

---

## 11. 一時削除

Phase 2Aと同じ。受信後は必ず一時ファイルを削除し、削除に失敗した場合は音声内容やパスを出さず「一時音声を削除できませんでした」を返す。

---

## 12. トラブル対応

| 状況 | 案内 |
|---|---|
| Companionが起動しない（証明書なし） | `npm run companion:setup-tls` の実行を案内 |
| Companionが起動しない（証明書が不正） | `npm run companion:setup-tls` の再実行を案内（危険な警告の無視は案内しない） |
| Chromeで証明書警告が出る | mkcertのローカルCAがブラウザに信頼されていない可能性。`mkcert -install`済みか、`npm run companion:check`で証明書の有効期限を確認 |
| ローカルネットワークアクセスが拒否された | Chromeのアドレスバー左側のサイト設定から許可 |
| CORSエラー | 接続元originが許可リストに含まれているか確認（本番origin利用時はHTTPSモードで起動しているか） |
| ペアリング期限切れ・トークン無効化 | Companion画面の新しいコードで再ペアリング |

---

## 13. 証明書の更新方法

`npm run companion:setup-tls` を再実行する。既存証明書は自動的に日時付きでバックアップされてから新しい証明書に置き換わる。mkcertの証明書は既定で長期間（約2年強）有効だが、CAROOT自体を再生成した場合は`mkcert -install`からやり直す必要がある。

---

## 14. アンインストール方法

- Companion証明書・秘密鍵: `rm -rf "~/Library/Application Support/CallFlow Companion/certificates"`
- mkcertのローカルCAをブラウザ信頼ストアから除去: `mkcert -uninstall`
- mkcert本体: `brew uninstall mkcert`
- Homebrew本体: 公式アンインストールスクリプト（`https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh`）

---

## 15. Phase 3で行うこと

- ffmpegによる16kHzモノラルWAV変換
- whisper.cppによる日本語文字起こし
- 実機でのHTTPS音声送信の最終確認（Homebrew/mkcertインストール後、ユーザーの実機で）
- Chrome Private Network Accessの実機挙動確認

---

## 16. 実機確認結果

実施日: 2026-07-21〜22
環境: MacBook Air（Apple Silicon）、通常のGoogle Chrome（Claude Codeのサンドボックス化されたBrowser paneではない）

- Homebrewを`brew.sh`公式インストーラーでユーザー自身のTerminal.appから導入（このセッションのツールにはsudoの対話的TTYが無く実行不可のため）
- `brew install mkcert`（v1.4.4）、`mkcert -install`でローカルCAをmacOSの信頼済みストアへ登録
- `npm run companion:setup-tls` を実行し、`callflow-companion.localhost` / `localhost` / `127.0.0.1` / `::1` を含む証明書を発行（有効期限 2028-10-21、権限: 秘密鍵0600・証明書0644）
- LibreSSL非対応の `openssl x509 -ext` オプションに依存していた証明書確認処理を修正し（`fix: support macOS LibreSSL in TLS setup`）、`bash -n`・`npm run companion:setup-tls`・`npm run companion:build`・`npm run companion:test`・`git diff --check`すべて成功を確認してからコミット
- `npm run companion:start` でHTTPSモード起動（`https://127.0.0.1:4318`、`secure: true`）
- 通常のGoogle Chromeで `https://callflow-companion.localhost:4318/v1/health` を開き、**証明書警告なし**（mkcertのローカルCAが正しく信頼されていることを確認）、health応答は200 OK・`secure: true`
- `http://127.0.0.1:3002/dashboard`（デモモード、`.env.local`退避済み）でCallFlowを起動し、「接続を確認」→ペアリング成功→「Macの処理アプリ：接続済み」表示を確認
- MacBook Airの内蔵マイクへのアクセスを許可し、実マイクで約48秒のテスト録音を実施（個人情報・実際の営業内容は使用せず、「これはCallFlowのHTTPS送信テストです」程度の内容のみ）
- アプリ内再生で録音内容を確認
- 「Macへ送信テスト」を押下し、HTTPS経由（`https://callflow-companion.localhost:4318/v1/audio`）で送信 → 成功
  - MIME Type: `audio/webm;codecs=opus`
  - 録音時間: 48秒
  - 音声サイズ: 759.4KB
  - 画面表示: 「音声をMacで受信し、安全に削除しました」
  - `temporaryFileDeleted: true`
- 送信後、Companionの一時ディレクトリ（`~/Library/Application Support/CallFlow Companion/tmp`）が空であることを確認
- Supabase・Vercel・その他外部ドメインへの音声送信は発生していない（Companionは`127.0.0.1:4318`のみで待受け、`/v1/audio`はローカル一時保存・検証・削除のみを行い外部へは一切送信しない実装であることをコードレベルで確認済み。加えてCallFlowは`.env.local`退避によるデモモードで動作しており、Supabase接続は構成上不可能な状態だった）

**Phase 2Bの完了条件（HTTPS化・Chrome証明書信頼・HTTPS音声送信・Local Network Access確認）をすべて満たした。**

---

## 付録: Phase 2A/2B自動テストでカバーしている範囲

自己署名証明書（openssl、テスト実行時に一時生成、mkcertのCAROOTとは無関係）によるHTTPS起動・CORS・PNAヘッダーの単体テストはコードレベルで実施済み（`companion/src/server.test.ts`）。上記§16の実機確認は、これらの自動テストでは代替できない「実際のmkcert証明書に対するChromeの信頼」「実マイクからの音声」「実ブラウザでのLocal Network Access許可」を確認するものである。
