# CallFlow Companion Phase 2A — 最小構成と音声送信テスト

作成日: 2026-07-21
対象ブランチ: `feature/local-call-recorder-codex`

---

## 1. Phase 2Aの目的

ブラウザ（CallFlow）で録音した音声Blobを、Mac上でローカル動作する「CallFlow Companion」へ送信し、

1. Companionが音声を受信する
2. 一時ディレクトリへ安全に保存する
3. 形式・サイズを検証する
4. 一時音声を必ず削除する
5. 受信結果をCallFlow画面へ返す

ところまでを実装する。文字起こし（whisper.cpp）・Codex解析・Supabase保存・音声の永続保存は今回のスコープに含まれない。

---

## 2. 実装構成

```
companion/
  src/
    server.ts          # http(s)サーバー本体・ルーティング（GET /v1/health, POST /v1/pair, POST /v1/audio）
    config.ts           # 環境変数からの設定読み込み・起動可否判定
    pairing.ts          # ペアリングコード発行・検証、Bearerトークン発行・検証
    auth.ts             # Authorizationヘッダー検証
    cors.ts             # Origin完全一致によるCORS制御
    audio-upload.ts     # 音声受信・MIME検証・ストリーミング受信バイト数制限
    temp-files.ts       # 一時ファイルの安全な作成・削除・清掃
    responses.ts        # 秘密情報・絶対パスを含まないJSONレスポンス送出
    types.ts            # 共有型定義
    *.test.ts           # node:testによる自動テスト
  tsconfig.json

src/lib/
  companion-client.ts        # ブラウザ側クライアント（health/pair/upload、トークン管理、エラーの日本語化）
  companion-client.test.ts

scripts/
  start-callflow-companion-dev.sh
  stop-callflow-companion-dev.sh
  check-callflow-companion-dev.sh
```

`src/components/call-recorder.tsx` にCompanion接続・ペアリング・送信UIを統合した（後述）。

---

## 3. HTTP開発モードと最終HTTPSモードの違い

- **最終構成**: `https://callflow-companion.localhost:4318`。mkcertで発行したローカル信頼済み証明書を使用する（Phase 2ではまだ未導入）。
- **Phase 2Aの開発用HTTPモード**: `http://127.0.0.1:4318`。`CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP=true` を明示的に設定した場合のみ有効になる。この環境変数が無い場合、`config.ts`の`canStartServer()`はTLS証明書・秘密鍵のパスが無いことを検知し、**起動を拒否する**（安全側のデフォルト）。
- HTTPモードでは以下を厳守している（`config.ts`・`cors.ts`で実装）:
  - bind先は`127.0.0.1`のみ（`0.0.0.0`・LAN IPへは決してbindしない）
  - 本番origin（`https://callflow-crm-blue.vercel.app`）はHTTPモードの許可originリストに含まれない（`config.ts`の`loadConfig()`参照：`secure`がfalseの間は`PRODUCTION_ORIGIN`を許可リストに追加しない）
  - ローカル開発origin（`localhost`/`127.0.0.1`の3000・3002番ポート）のみ許可
  - 起動時ログとCompanion起動画面に「HTTP（開発用・安全でない接続）」と明示

---

## 4. 起動方法

```bash
npm run companion:start:dev
```

内部で `scripts/start-callflow-companion-dev.sh` が実行され、以下を行う。

- macOSであることを確認（他OSではエラー終了。git状態は一切変更しない）
- 二重起動を検知した場合は何もせず終了
- `CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP=true` かつ `127.0.0.1:4318` のみで `companion/src/server.ts` を起動
- PIDを `~/Library/Application Support/CallFlow Companion/companion-dev.pid` に保存
- 起動ログ（許可origin・モード・ペアリングコードと有効期限）を画面に表示。秘密情報は一切表示しない

---

## 5. 停止方法

```bash
npm run companion:stop
```

`scripts/stop-callflow-companion-dev.sh` が、PIDファイルに記録されたプロセスが実際にCallFlow Companion（`companion/src/server.ts`）であることを確認したうえで`SIGTERM`を送り、グレースフルシャットダウン（一時ファイル清掃を含む）を待つ。`killall`/`pkill`は使用しない。停止後、念のため一時ディレクトリ内の残存ファイルも清掃し、PIDファイルを削除する。

状態確認: `npm run companion:check`（PID・health・ポート・HTTPモードを表示。秘密情報は表示しない）

---

## 6. ペアリング方法

1. Companion起動時にコンソールへ6桁のペアリングコードと有効期限（10分）が表示される。
2. CallFlow画面（架電するタブの録音パネル）で「ペアリングコードを入力」を開き、6桁を入力して「ペアリングする」を押す。
3. `POST /v1/pair` にコードを送信し、成功するとBearerトークンが**一度だけ**レスポンスで返る。Companion側はトークンをハッシュ化してのみメモリ上に保持し、生トークンは保持・ログ出力しない。
4. 発行されたトークンはブラウザの`localStorage`（キー: `callflow_companion_token_v1`）に保存され、ページを再読み込みしても再接続状態が保たれる（実機ブラウザで確認済み、後述）。
5. コードは1回使用すると失効し、連続失敗回数の上限（既定5回）を超えるとロックされる。トークンはCompanion再起動で必ず失効する（メモリ上のみで管理しているため）。
6. 「ペアリングを解除」ボタンで`localStorage`のトークンを削除できる（実機ブラウザで確認済み）。

---

## 7. 音声送信方法

1. 録音停止後（「recorded」状態）、Companionとペアリング済みの場合のみ「Macへ送信テスト」ボタンが表示される。
2. ボタンを押すと、まず以下の安全チェックを行う。
   - 録音開始時の企業IDと現在表示中の企業IDが一致するか（`isSameCompany`、不一致なら送信を中止）
   - 同じ録音を送信済みの場合は再送の確認ダイアログを表示
3. 送信前に必ず同意ダイアログ（`window.confirm`）を表示し、「録音音声を、このMac上で動いているCallFlow Companionへ送信します。音声はMac内で一時保存され、受信確認後に削除されます。SupabaseやVercelには送信されません。」と明示する。同意しない限り送信しない（自動送信は行わない）。
4. `POST /v1/audio` に、録音のBlobをそのままリクエストボディとして送信する（multipart/form-dataは使用しない）。メタデータは`X-CallFlow-Recording-Id`・`X-CallFlow-Company-Id`・`X-CallFlow-Duration-Ms`ヘッダーで送る（企業名・電話番号・文字起こし内容は一切送らない）。
5. 成功すると「Macで音声を受信し、一時ファイルを削除しました」等のメッセージと、形式・サイズ・録音時間・一時削除済みの表示を行う。文字起こし・AI解析・Codex・次回対応・架電結果の自動入力は一切表示しない。

---

## 8. 一時ファイルの保存・削除

- 保存先: `~/Library/Application Support/CallFlow Companion/tmp`（ディレクトリ権限0700・ファイル権限0600）。テストでは注入可能な一時ディレクトリを使用する。
- ファイル名は`crypto.randomUUID()`で生成し、企業名・電話番号・リクエストヘッダーの値は一切使用しない。拡張子は検証済みMIME Typeから決定する。
- パストラバーサル防止のため、生成・削除の両方で常にtmpDir配下であることを検証する（`isWithinTmpDir`）。
- 受信成功後は即座に削除する。MIME不正・空ファイル・サイズ超過・クライアント切断などのエラー時も一時ファイルを残さない（自動テストで確認済み、後述）。
- Companion起動時・終了時にtmpDir内の残存ファイルをすべて清掃する。

---

## 9. セキュリティ

- bind先は常に`127.0.0.1`のみ。`0.0.0.0`やLAN IPへのbindは実装上不可能（`config.ts`で`host`を`"127.0.0.1"`に固定）。
- CORSはOrigin完全一致のみで許可し、ワイルドカード（`*`）は一切使用しない（自動テストで確認済み）。
- `POST /v1/audio`はOriginが無い・許可されていない場合は明示的に拒否する。
- Bearerトークンはハッシュ化して保持し、タイミングセーフ比較（`crypto.timingSafeEqual`）で検証する。生トークンはログに一切出力しない。
- ペアリングコードは10分で失効・1回使用で失効・失敗回数上限でロックする（総当たり対策）。
- レスポンスには絶対パス・ユーザー名・ホームディレクトリ・音声内容・音声データ・トークン・Codex認証情報を一切含めない（自動テストで確認済み）。
- `Cache-Control: no-store`・`X-Content-Type-Options: nosniff` を全レスポンスに付与する。

---

## 10. エラー対応

| 状況 | Companionの応答 | ブラウザ側の表示 |
|---|---|---|
| Companionに接続できない | - | 「Macの処理アプリ（CallFlow Companion）に接続できませんでした。起動しているか確認してください。」 |
| タイムアウト | - | 「Macの処理アプリへの接続がタイムアウトしました。」 |
| ペアリングコード誤り | 401 `invalid_code` | 「ペアリングコードが正しくありません。」 |
| ペアリングコード期限切れ | 401 `expired_code` | 「ペアリングコードの有効期限が切れました。」 |
| ペアリングコード使用済み | 401 `code_already_used` | 「このペアリングコードは既に使用されています。」 |
| 失敗回数上限超過 | 429 `too_many_attempts` | 「失敗回数が上限を超えました。Companionを再起動してください。」 |
| トークン無効・期限切れ | 401 `unauthorized` | 「認証が切れています。『ペアリングを解除』してから、もう一度ペアリングしてください。」（自動的にトークンを破棄） |
| Origin不許可 | 403 `forbidden_origin` | 「この画面からの接続が許可されていません。」 |
| 音声形式不正 | 415 `unsupported_media_type` | 「対応していない録音形式です。」 |
| サイズ超過 | 413 `payload_too_large` | 「録音ファイルのサイズが上限を超えています。」 |
| 空の音声 | 400 `empty_audio` | 「録音データが空です。もう一度録音してください。」 |

いずれのエラーでも、既存のキーワード解析（`localAnalysis`相当）へ黙ってフォールバックすることはない。

---

## 11. 手動テスト結果

実機（MacBook Air、Google Chrome、デモモードのCallFlow）で以下を確認した。`.env.local`（本番Supabase認証情報）は検証前にランダム名で退避し、検証後に復元した（内容は一切表示していない）。

- ✅ `npm run companion:start:dev` でCompanionが`http://127.0.0.1:4318`のみにバインドされ起動し、ペアリングコードが画面に表示された
- ✅ 二重起動防止（既に起動中の場合は何もせず終了）
- ✅ `npm run companion:check` でPID・health・HTTPモードが正しく表示された
- ✅ CallFlowを`NEXT_PUBLIC_CALL_RECORDING_ENABLED=true`・`NEXT_PUBLIC_CALL_COMPANION_ENABLED=true`・`NEXT_PUBLIC_CALLFLOW_COMPANION_URL=http://127.0.0.1:4318`で起動し、デモモード（Supabase通信0件）で表示された
- ✅ 「架電する」画面でCompanion接続パネル（「未接続」表示、「接続を確認」「ペアリングコードを入力」ボタン）が表示された
- ✅ 「接続を確認」ボタンでブラウザから実際に`GET http://127.0.0.1:4318/v1/health`が200 OKで成功した
- ✅ 6桁のペアリングコードを入力して「ペアリングする」を押すと、`OPTIONS /v1/pair`（204）→`POST /v1/pair`（200）が成功し、「接続済み」表示に変わった
- ✅ 発行されたトークンが`localStorage`（`callflow_companion_token_v1`）に保存されていることを確認した
- ✅ ページを再読み込みしても「接続済み」状態が復元されることを確認した
- ✅ ブラウザのJavaScriptコンテキストから、保存済みトークンを使って実際に`POST http://127.0.0.1:4318/v1/audio`（合成音声データ、実際の通話・個人情報は使用せず）を送信し、`200 OK`・`temporaryFileDeleted: true`を確認した（CallFlowの実origin `http://127.0.0.1:3002` からのCORS込みの実通信）
- ✅ 送信後、Companionの一時ディレクトリ（`~/Library/Application Support/CallFlow Companion/tmp`）が空であることを確認した
- ✅ 一連の操作中、Supabase・Vercel・その他外部ドメインへの通信が0件であることを`read_network_requests`で確認した（すべて`127.0.0.1:3002`と`127.0.0.1:4318`宛のみ）
- ✅ 「ペアリングを解除」ボタンで`localStorage`のトークンが削除され、UIが「未接続」表示に戻ることを確認した
- ✅ `npm run companion:stop` でCompanionが安全に停止し、PIDファイルが削除され、一時ディレクトリが空であることを確認した

**実機で確認できなかった項目**（この検証環境のブラウザ自動化ツールが実マイクへのアクセスを構造的にブロックするため、Phase 1と同様の制約）:

- 実マイクによる5秒程度の録音・停止・アプリ内再生
- 「Macへ送信テスト」ボタンの実クリックによる送信（ただし、その内部で呼ばれるのと全く同じHTTPリクエスト経路を、実ブラウザ・実origin・実トークンを使って直接検証済みであり、機能的には同等の検証ができている）
- 実際の「録音時間・ファイルサイズ・形式」を伴った送信後の成功パネル表示（コードレビュー・型チェック・単体テストで実装の正しさは確認済み）

これらはユーザーの実機（MacBook Air M4 + Chrome + iPhoneスピーカー通話）で改めて確認する必要がある。

---

## 12. Phase 2Bで行うこと

- ffmpegによる16kHzモノラルWAV変換
- whisper.cppによる日本語文字起こし
- HTTPS化（mkcertでのローカル証明書発行、`https://callflow-companion.localhost:4318`への切り替え）
- Chrome Private Network Access挙動の実機確認

---

## 13. 現在は文字起こしを行わないこと

Phase 2Aでは、Companionは受信した音声を検証・一時保存・削除するのみで、**文字起こしは一切行わない**。`companion/src/`にはffmpeg・whisper.cpp関連のコードは含まれていない。

## 14. 現在はCodex解析を行わないこと

Phase 2Aでは、Codex App Serverへの接続・解析は一切行わない。`companion/src/`にはCodex関連のコードは含まれておらず、既存の`/api/analyze-transcript`（OpenAI API使用）も変更していない。
