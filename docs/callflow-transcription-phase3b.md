# CallFlow Companion Phase 3B — ローカル文字起こしの統合

作成日: 2026-07-22
対象ブランチ: `feature/local-call-recorder-codex`

---

## 1. Phase 3Bの目的

Phase 3A（ffmpeg・whisper.cppのセットアップとモデル選定）を、既存のCallFlow Companion（HTTPS版、Phase 2B）へ「非同期の文字起こしジョブAPI」として統合し、CallFlow側に開始・キャンセル・再試行・コピー・破棄のUIを追加する。

明示的に対象外（Phase 3Bではやらない）:
- Codex App Serverによる文字起こし結果のAI解析
- 架電結果・温度感・ネクストアクションの自動入力
- 文字起こし結果のSupabase保存（メモリ上のみ、CallFlow側のstateも保存しない）
- クラウドAI（OpenAI等）の使用

---

## 2. 全体フロー

```
CallFlow（ブラウザ） --POST /v1/transcriptions（音声Blob）--> Companion
                     <--202 Accepted + jobId---------------
                     --GET /v1/transcriptions/:jobId（polling）-->
                     <--200 { status, text, ... }-----------
                     --DELETE /v1/transcriptions/:jobId（任意）-->
```

Companion内部では、ジョブごとに以下の順で処理する。

```
queued → converting（ffmpeg: 16kHz mono 16bit WAV化） → transcribing（whisper-cli: 日本語文字起こし） → completed / failed
```

いずれの状態でも `DELETE` でキャンセルでき、キャンセル時はプロセスグループへ`SIGTERM`→（3秒後）`SIGKILL`を送って確実に停止させる。

---

## 3. API仕様（`companion/src/transcription-routes.ts`）

既存の`/v1/audio`と同じ認証（Bearerトークン、`companion/src/pairing.ts`が発行）・CORS方式をそのまま再利用する。

### `POST /v1/transcriptions`
- 音声Blobをボディにそのまま送信（`/v1/audio`と同じ受信ロジックを再利用、`companion/src/audio-upload.ts`）
- Originなし・未許可Originは403 `forbidden_origin`
- 認証なし・無効トークンは401 `unauthorized`
- 成功時: `202 { ok: true, jobId }`（即座に返り、処理は非同期に進む）
- 待機列が埋まっている場合: `429 { error: "queue_full" }`

### `GET /v1/transcriptions/:jobId`
- `200 { ok, jobId, status, text, modelUsed, durationMs, error, message, temporaryFilesDeleted }`
- 存在しないjobId・他人のjobId（トークン不一致）は`404`（存在の有無を区別しない）

### `DELETE /v1/transcriptions/:jobId`
- 実行中・待機中のジョブをキャンセルする。`200 { ok, jobId, status: "cancelled" }`
- 完了済み・失敗済みジョブへのDELETEは冪等に現在の状態を返す（エラーにしない）

---

## 4. 設定・上限（`companion/src/transcription-config.ts`）

| 項目 | 既定値 | 備考 |
|---|---|---|
| 既定モデル | `small`（Phase 3Aのベンチマーク結果に基づく選定） | `CALLFLOW_TRANSCRIPTION_MODEL=base`で上書き可 |
| 音声長上限 | 60分 | Phase 1の録音上限と同じ。超過時は変換後に判定し拒否 |
| ffmpeg変換タイムアウト | 2分 | |
| whisper-cli実行タイムアウト | 音声長×4倍（安全係数）、最短2分・最長30分でクランプ | 実測real-time factorに基づく |
| 同時実行数 | 1 | Companionは1台のMacで動くローカルアプリのため |
| 待機キュー上限 | 2 | 超過時は`429 queue_full` |
| 完了ジョブの保持時間（TTL） | 10分 | 期限後はメモリから自動削除。ハウスキーピング用タイマーは`unref()`済みでCompanionの終了を妨げない |
| サブプロセス標準出力/エラー出力の上限 | 1MB | 超過分は破棄（ログ肥大化・メモリ圧迫防止） |

---

## 5. プロセス実行の安全性（`companion/src/transcription-process.ts`）

- `child_process.spawn`をargv配列で呼び出す（`shell: true`は使用しない、文字列結合・evalも使用しない）
- ffmpeg/whisper-cliに渡すパスは、すべてサーバー側で`crypto.randomUUID()`から生成した一時ファイル名（`temp-files.ts`）またはモデル名（`"base"|"small"`の2値のみ）であり、リクエストヘッダーやユーザー入力から直接組み立てられることはない
- 各プロセスは`detached: true`で独立したプロセスグループとして起動し、タイムアウト・キャンセル時は**プロセスグループ全体**（`-pid`、負のPID）へシグナルを送る。直接の子プロセスのPIDだけをkillすると孫プロセスが孤児化する場合があるため（Phase 3Aのベンチマークスクリプト開発中に`/usr/bin/time -l`ラップ時の孤児化を実際に発見・修正した教訓を反映）
- `SIGTERM`で反応しない場合は3秒後に`SIGKILL`を送る。この保険用タイマーは`unref()`しており、Companion自体の終了を妨げない

---

## 6. ジョブ状態管理と競合の扱い（`companion/src/transcription-jobs.ts`）

- ジョブはメモリ上の`Map`のみで管理し、Companion再起動で全て失効する（ディスクへの永続化なし）
- ジョブの所有者確認は、発行元トークンをSHA-256でハッシュ化した値を`crypto.timingSafeEqual`で比較する方式（`pairing.ts`と同じアルゴリズムを、`pairing.ts`自体は変更せずこのモジュール内で独自に算出）
- `process()`（ffmpeg/whisper実行の本体）の自然完了と、`cancelJob()`/`shutdown()`による明示キャンセルが競合しうるため、`job.finished`フラグで「最初の1回だけを有効化」する形にしている。これにより:
  - 一時ファイルの二重削除・二重のTTLタイマー登録を防ぐ
  - `cancelJob()`はHTTPハンドラから`await`されず同期的に返答が必要なため、ジョブの`status`/`errorCode`はここで即座に確定させ、一時ファイル削除・TTL登録は非同期（`finishJob`）で後追いする
- `process()`全体を`try/catch`で包み、fs操作等で想定外の例外が発生してもそのジョブを`internal_error`扱いにするだけで完結させる（Companionプロセス全体をクラッシュさせて他の進行中の`/v1/audio`アップロードまで巻き込むことを防ぐ）

---

## 7. 一時ファイルのライフサイクル

音声（受信時）→ WAV（ffmpeg変換）→ JSON（whisper-cli出力）の3種類は、成功・失敗・タイムアウト・キャンセル・Companion終了のいずれの経路でも必ず削除を試みる。削除に失敗した場合も「成功扱い」にはせず、`temporaryFilesDeleted: false`として応答に反映する（処理中は`false`、削除完了後に`true`）。

---

## 8. CallFlow側UI（`src/components/call-recorder.tsx`, `src/lib/companion-client.ts`）

- 録音済み音声に対して「文字起こしを開始」ボタンを表示（Companion連携が有効な場合のみ）
- 進行中は状態に応じたメッセージ（変換中/文字起こし中）とキャンセルボタンを表示
- 完了後は編集可能なテキストエリアに文字起こし結果を表示（**メモリ上のみ、Supabaseには保存しない**）。コピー・破棄・再試行が可能
- エラー時は`CompanionErrorCode`に応じた日本語メッセージを表示（`queue_full`/`audio_too_long`/`conversion_failed`/`conversion_timeout`/`transcription_failed`/`transcription_timeout`を新規追加）
- 案内文を「AI解析・架電結果の自動入力は次のPhaseで追加します」に更新し、Phase 3Bの対象外範囲を明示

---

## 9. テスト

`companion/src/transcription-jobs.test.ts`・`companion/src/transcription-routes.test.ts`（`npm run companion:test`で実行、既存の`server.test.ts`等と合わせて計80件）。

実際のffmpeg/whisper-cliバイナリ・実音声は一切使用せず、`companion/src/transcription-test-support.ts`が生成する偽実行ファイル（bashスクリプト、成功/失敗/タイムアウト/ハングを環境変数経由の制御ファイルで切り替え）を使う。カバーしている範囲:

- 認証なし・不正トークン・未許可Originの拒否
- 正常系のジョブ作成→変換→文字起こし→完了、および一時ファイルの完全削除
- MIME Type不正・空音声・サイズ上限超過の拒否（ジョブを作らない）
- 同時実行数・待機キュー上限の強制（`queue_full`）
- ffmpeg失敗・タイムアウト、whisper-cli失敗・タイムアウト
- 実行中(converting)・待機中(queued)ジョブそれぞれのキャンセル
- 他トークンからのジョブ参照・キャンセル拒否（404、存在漏洩なし）
- 完了ジョブのTTL失効
- Companion終了(`shutdown()`)時の全ジョブキャンセルと一時ファイル削除（冪等性含む）
- レスポンスに絶対パス・トークンが含まれないこと
- HTTPレベル: DELETEのCORSプリフライト、URLエンコードされたスラッシュを含むjobIdの安全な扱い

実バイナリ・実音声・実HTTPSを用いた統合確認は、この節とは別に手動E2E（ブラウザ→HTTPS Companion→whisper-cli実行）で実施済み（詳細は本ドキュメントの完了条件・レビュー記録を参照）。

---

## 10. Phase 4で行うこと（対象外・未着手）

- Codex App Serverによる文字起こし結果の解析（架電結果・温度感・ネクストアクションの提案）
- 提案内容をユーザーが確認・編集してから登録する導線
