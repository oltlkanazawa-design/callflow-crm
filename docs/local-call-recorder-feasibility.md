# 通話録音・ローカル文字起こし・Codex解析機能 技術調査報告

作成日: 2026-07-21
対象ブランチ: `feature/local-call-recorder-codex`（base: `origin/main`、`416c2e2`）
このドキュメントは調査結果のみを記録するものであり、この時点では機能コードの実装・依存関係の追加・インストール・本番接続は一切行っていません。

---

## 1. 結論

**技術的に実現可能。** ただし以下の条件・制約がある。

- Codex App Serverは実機にインストール済み（`codex-cli 0.144.3`）で、ChatGPTアカウントでログイン済み（`codex login status` → `Logged in using ChatGPT`）。App Serverの正式なJSON-RPCプロトコル（`turn/start`の`outputSchema`によるスキーマ制約付き構造化出力を含む）を、実際にインストールされたバイナリから型・JSON Schemaとして生成し確認した。
- 実際にAPPROVEされたテスト文章1件でCodexへ解析リクエストを送ったところ、**認証は成功したが、ChatGPTアカウントの利用上限に達しており、正常系の構造化出力そのものは今回確認できなかった**（詳細は§3参照）。これは実装の可否には影響しないが、正常系の実地確認は別途、利用上限が回復してから改めて行う必要がある。
- ffmpeg・whisper.cpp・mkcert・Homebrewはこの実機に**いずれも未インストール**。今回はインストールしていない（調査フェーズの禁止事項のため）。
- 本番Vercel画面（HTTPS）からローカルCompanion（`https://callflow-companion.localhost:4318`のようなlocalhost HTTPS）への接続は、mkcertでローカル信頼された証明書を発行すれば技術的に可能と判断する（Chromeの仕様上の一般的挙動に基づく判断。実機でのmkcert証明書発行・Chrome接続テストは、インストール禁止のため今回は実施していない。セットアップスクリプト実行後に実機確認が必要）。
- DB変更は**不要**と判断した既存2列（`transcript`, `ai_summary`）に加えて、`ai_fields`列も既に`call_logs`テーブルに存在することを確認したが、**現在の`record_call()` RPCのシグネチャには`ai_fields`を受け取る引数が無い**ため、DB変更なしで`ai_fields`へ保存することはできない（詳細は§9）。

---

## 2. 現在の環境

実機はDarwin（`arm64`, `T8132` = Apple M4系Apple Silicon、MacBook Air M4本体）。

| ツール | 状態 | バージョン |
|---|---|---|
| `codex` (Codex CLI) | ✅ インストール済み | `codex-cli 0.144.3`（`codex doctor`によると`0.144.6`への更新が利用可能、現時点では未更新） |
| `codex login status` | ✅ ログイン済み | `Logged in using ChatGPT`（APIキー課金ではなくChatGPTアカウント認証） |
| Homebrew (`brew`) | ❌ 未インストール | - |
| ffmpeg | ❌ 未インストール | - |
| mkcert | ❌ 未インストール | - |
| whisper.cpp / `whisper-cli` | ❌ 未インストール | - |
| Python | ✅ | `/usr/bin/python3`, `Python 3.9.6`（システム標準、比較的古い） |
| Node.js | ✅ | `v24.16.0` |
| npm | ✅ | `11.13.0` |
| Git | ✅ | `2.50.1` |

→ セットアップスクリプト（Phase 2以降で実装予定）は、Homebrew・ffmpeg・mkcert・whisper.cppの導入が最初から必要になる想定で設計する。

---

## 3. Codex App Serverの実際の仕様

RPC名・パラメータは推測せず、実際にインストールされている`codex-cli 0.144.3`から`codex app-server generate-ts --experimental`と`codex app-server generate-json-schema --experimental`で型定義・JSON Schemaを生成し、その内容から確認した（生成物は`/tmp`配下にのみ出力し、リポジトリへは追加していない）。

### 3-1. 起動方法

```
codex app-server [--listen stdio://|unix://PATH|ws://IP:PORT]
```

デフォルトは`stdio://`。Companionからは子プロセスとして`stdio`で起動し、標準入出力でJSON-RPC 2.0メッセージ（`JSONRPCRequest` / `JSONRPCResponse` / `JSONRPCNotification` / `JSONRPCError`、いずれも生成されたスキーマで確認済み）をやり取りする方式を採用する。

### 3-2. 初期化

- リクエストメソッド: `initialize`
- パラメータ型: `InitializeParams = { clientInfo: ClientInfo, capabilities: InitializeCapabilities | null }`
- レスポンス型: `InitializeResponse = { userAgent: string, codexHome: string, platformFamily: string, platformOs: string }`

### 3-3. スレッド作成・ターン開始

- スレッド開始: メソッド`thread/start`、パラメータ型`ThreadStartParams`（`model`, `cwd`, `approvalPolicy`, `sandbox`, `baseInstructions`, `developerInstructions`など）
- ターン開始: メソッド`turn/start`、パラメータ型`TurnStartParams`。主要フィールド：
  - `threadId: string`
  - `input: Array<UserInput>`（`{ "type": "text", text: string, text_elements: [] }`の形で文字起こしを渡す）
  - `outputSchema?: JsonValue | null` — **構造化出力の指定方法はこのフィールド**。任意のJSON Schemaを渡すと、最終応答メッセージがこのSchemaに従うよう制約される。
  - `sandboxPolicy?: SandboxPolicy | null` — スレッド全体の設定を、このターンだけ上書きできる
  - `approvalPolicy?: AskForApproval | null`

### 3-4. サンドボックス・承認・ネットワーク制限の指定方法

実際の型から確認した値：

- `SandboxMode = "read-only" | "workspace-write" | "danger-full-access"`
- `AskForApproval = "untrusted" | "on-request" | "never" | { granular: {...} }`
- `SandboxPolicy`（ターン単位で上書き可能）:
  - `{ type: "readOnly", networkAccess: boolean }`
  - `{ type: "workspaceWrite", writableRoots: [...], networkAccess: boolean, ... }`
  - `{ type: "dangerFullAccess" }`
  - `{ type: "externalSandbox", networkAccess: NetworkAccess }`

→ 本機能では`thread/start`時に`sandbox: "read-only"`・`approvalPolicy: "never"`を指定し、`turn/start`の`sandboxPolicy`でも明示的に`{ type: "readOnly", networkAccess: false }`を指定することで、ご指示の「sandbox: read-only」「approval policy: never」「network: disabled」をすべて実現できることを型定義から確認した。

### 3-5. 完了通知・エラー通知

`ServerNotification`型（169KB分のUnion型、`generate-json-schema`で全量取得済み）から、関連する通知のメソッド名をすべて列挙した。主なもの：

- `turn/started` / `turn/completed`（`TurnCompletedNotification = { threadId: string, turn: Turn }`。`Turn`は`items: ThreadItem[]`, `status: TurnStatus`, `error: TurnError | null`を持つ）
- `item/started` / `item/completed`（`ItemCompletedNotification = { item: ThreadItem, threadId, turnId, completedAtMs }`）
- `error`（`ErrorNotification = { error: TurnError, willRetry: boolean, threadId, turnId }`）

→ 構造化出力の結果は、`turn/completed`通知内の`turn.items`（最終的なアシスタントメッセージのアイテム）から取得する設計とする。

### 3-6. ChatGPTログイン状態の確認方法

- RPCメソッド: `getAuthStatus`
- レスポンス型: `GetAuthStatusResponse = { authMethod: AuthMode | null, authToken: string | null, requiresOpenaiAuth: boolean | null }`
- `AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "headers" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey"`

→ Companion起動時・解析開始前に`getAuthStatus`を呼び、`authMethod === "chatgpt"`（または`"chatgptAuthTokens"`）でない場合は「Codexへのログインが必要です」を画面へ表示し、解析を開始しない設計とする。CLIレベルでは`codex login status`が同等の情報を返すことも確認済み（実機で`Logged in using ChatGPT`を確認）。

### 3-7. 利用制限エラーの識別

実際に許可されたテスト文章1件だけを使い、`codex exec --output-schema <schema> --json`（App Server本体ではなく、同じ構造化出力の仕組みを使う非対話コマンド。手軽に実地確認するために使用。本番実装ではApp Serverの`turn/start`を使う）で実地に解析リクエストを送ったところ、次のイベントが返った（個人情報は含まれない、許可された定型テスト文章のみ使用）。

```
{"type":"thread.started","thread_id":"019f82f9-d104-7ae1-bade-35c9d9b56a7c"}
{"type":"turn.started"}
{"type":"error","message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 25th, 2026 4:20 PM."}
{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Pro ..."}}
```

**このエラーメッセージには`"usage limit"`という文字列が含まれる。** Companion側の利用制限エラー検出は、エラーメッセージ本文に`usage limit`（大文字小文字を区別しない）などの既知パターンが含まれるかで判定する設計とする（App Server側は構造化されたエラーコードを返すとは限らないため、メッセージ内容の部分一致判定をフォールバックとして併用する）。

**重要な限界**: 上記の理由により、**構造化出力（`outputSchema`で指定したJSON Schemaに従った実際の解析結果）そのものは、今回の調査では実地確認できていない。** 利用上限は「Jul 25th, 2026 4:20 PM」に回復する旨がエラーメッセージに含まれていたため、実装完了後、利用上限回復後に改めて許可されたテスト文章で正常系の実地確認を行う必要がある。

なお、この一度のテストで実際に使用したのはご指定の定型文（「採用担当の田中です。現在は新卒応募が少ないことが課題です。資料をメールで送ってください。来週火曜日にもう一度連絡してください。」）のみであり、実在する営業情報・個人情報は一切送信していない。

---

## 4. Whisperの実行方法（ドキュメント調査ベース、実機未検証）

whisper.cppは実機に未インストールのため、実際のベンチマーク比較（base/small/medium）は実施できていない。以下はwhisper.cppの一般的な既知の仕様に基づく整理であり、**実装フェーズでの実機検証が必須**。

- **推奨ビルド方法**: whisper.cppをソースから`make`、またはHomebrewの`whisper-cpp`パッケージ経由。Apple Siliconでは`GGML_METAL`（Metalバックエンド）が既定で有効化され、GPU支援により大幅に高速化される。
- **日本語対応モデル**: 多言語モデル（`ggml-base.bin`, `ggml-small.bin`, `ggml-medium.bin`, `ggml-large-v3-turbo.bin`等）はいずれも日本語を含む多言語対応。`.en`サフィックス付き（英語専用）モデルは対象外。
- **想定精度と処理速度のバランス**（一般に知られている傾向、実測ではない）:
  - `base`: 最速だが日本語の固有名詞・数字の誤認識が相対的に多い
  - `small`: 速度と精度のバランスが良く、日本語ビジネス会話であれば実用的とされることが多い
  - `medium`/`large-v3-turbo`: 精度は高いが処理時間が長くなる。M4のMetal支援下でどこまで実用的な速度が出るかは実機検証が必要
  - → 初期既定候補は`small`とし、実装フェーズでMacBook Air M4上で実際に1分程度の日本語サンプル音声を使い、base/small/medium(またはlarge-v3-turbo)を比較したうえで既定値を確定する。
- **モデル保存先**: 一般的にはユーザー領域（例: `~/Library/Application Support/CallFlowCompanion/whisper-models/`のようなアプリ専用ディレクトリ）に保存し、`CALLFLOW_WHISPER_MODEL_PATH`で上書き可能にする。
- **CLI入力形式**: whisper.cppの`whisper-cli`（旧`main`）は16kHzモノラルWAVを入力として想定。
- **JSON/テキスト出力**: `--output-json`（`-oj`）でJSON出力、`--output-txt`（`-otxt`）でテキスト出力に対応（バージョンによりオプション名が異なる可能性があるため、実装時に実際にインストールしたバージョンの`--help`で確認する）。
- **タイムスタンプ出力**: 対応（セグメント単位のタイムスタンプがJSON/テキスト双方に含まれる）。本機能では文字起こし全文のみ使用し、タイムスタンプ自体はUI表示には使わない想定。
- **60分録音の処理時の注意点**: 長時間音声は一括処理だとメモリ・処理時間が大きくなるため、モデルとチャンク分割方針の検討が必要になる可能性がある。実装フェーズで60分近い音声を使った実測が必要。

---

## 5. ブラウザ録音方法

現在のリポジトリには`getUserMedia`・`MediaRecorder`を使用している箇所は存在しない（新規実装）。

- **MediaRecorderの対応MIME Type**: Chrome on macOSでは`audio/webm;codecs=opus`が標準的に対応。`audio/mp4`はSafari寄りで、Chromeでの対応は限定的なため、優先順位はご指示どおり「1. `audio/webm;codecs=opus` 2. `audio/mp4` 3. ブラウザ対応形式」とし、`MediaRecorder.isTypeSupported()`で実行時判定する設計とする。
- **音量メーター**: `AudioContext` + `AnalyserNode`でリアルタイムの音量（RMSまたはピーク値）を取得し、`requestAnimationFrame`で描画する一般的な実装方針。
- **マイク選択**: `navigator.mediaDevices.enumerateDevices()`で`audioinput`一覧を取得し、選択したマイクの`deviceId`を`getUserMedia`の`constraints.audio.deviceId`に渡す。
- **5秒マイクテスト**: `getUserMedia`取得後、5秒間だけ音量メーターを表示し、平均音量が閾値未満なら警告を表示する設計。
- **60分録音時のメモリ**: `MediaRecorder`の`ondataavailable`をチャンク単位（例: 1秒ごと）で受け取り、Blobの配列として保持し、停止時に`new Blob(chunks)`で結合する方式にする（一括保持でも問題になりにくいが、チャンク保持のほうが途中経過の保存・キャンセル時の扱いが容易）。
- **録音中のページ離脱防止**: `beforeunload`イベントでの警告表示、および企業を切り替える「次の企業」操作を録音中は無効化する（ご指示どおり）。

---

## 6. Companion接続方法

**実機でのmkcert証明書発行・Chrome接続テストは、ソフトウェアインストール禁止のため今回は未実施。** 以下はChrome/Web標準仕様に基づく判断であり、実装フェーズのセットアップスクリプト実行後に実機確認が必要。

- **Chromeから`https://callflow-companion.localhost:4318`への接続**: mkcertでローカルCA配下の証明書を発行し、macOSのKeychain（システムトラストストア）にmkcertのルート証明書がインストールされていれば、Chromeはこれを信頼する（Chromeは基本的にOSの証明書ストアを利用する）。`.localhost`ドメインは仕様上常にループバックへ解決されるため、DNS設定は不要。
- **CORS**: Companion側で`Access-Control-Allow-Origin`を本番origin（`https://callflow-crm-blue.vercel.app`）とローカル開発origin（`http://localhost:3000`, `http://127.0.0.1:3000`）に限定したホワイトリスト方式で明示的に設定する。ワイルドカード（`*`）は使用しない。
- **OPTIONSプリフライト**: `POST`かつ独自ヘッダー（ペアリングトークン等）を使うため、ブラウザは自動的にプリフライトリクエストを送る。Companion側で`OPTIONS`メソッドへの明示的な応答実装が必要。
- **Private Network Access (PNA) / Local Network Access**: Chromeは、パブリックHTTPSサイトからプライベート/ループバックアドレスへのフェッチに対し、順次PNA関連の制限を強化する方向にある。`https://callflow-crm-blue.vercel.app`（パブリック）から`https://callflow-companion.localhost:4318`（ループバック）への接続はこの制限の対象になり得るため、**Chromeバージョンによっては初回接続時にブラウザの許可ダイアログが表示される可能性がある**。この点はドキュメント調査に基づく判断であり、実装フェーズで実際のChromeバージョンでの挙動を確認し、必要な追加ヘッダー（`Access-Control-Request-Private-Network`等）への対応可否を検証する。
- **fetchでの音声Blob送信**: `fetch`の`body`に`FormData`（`multipart/form-data`）でBlobを追加して送信可能。100MB程度のサイズであれば、ローカルホスト間の通信としては現実的（実装フェーズでの実測が必要）。
- **進捗の返し方**: Server-Sent Events（SSE）、ポーリング、通常POSTの3択のうち、Companionが長時間（文字起こし＋Codex解析で数十秒〜数分かかりうる）処理する性質上、**Server-Sent Events**を第一候補とする（実装がシンプルで、単方向の進捗通知に適している）。技術的な問題が判明した場合はポーリングへの切り替えを検討する。
- **タイムアウト**: Companion側で解析全体に対して上限時間を設定し、超過時はエラーとして返す。
- **localhost以外へ通信しないことの保証**: Companion自体が`127.0.0.1`のみにbindし、外部ネットワークへの送信はCodex App Server（OpenAIバックエンドとの通信のみ、ローカル処理された文字起こしテキストのみを送信）に限定する設計とする。ffmpeg・whisper.cppの処理はすべてローカルプロセスで完結し、ネットワークアクセスを行わない。

**代替案の比較（不採用理由を含む）**:

| 案 | 評価 |
|---|---|
| localhost HTTPS（mkcert） | 採用候補。ブラウザの標準機能のみで完結し、追加インストール（拡張機能等）が不要。PNAの挙動確認が必要な点のみ実装フェーズでのリスク。 |
| Chrome拡張機能 | 不採用。拡張機能のインストール・権限管理が別途必要になり、「技術に詳しくない利用者でも」という要件に対してセットアップの複雑さが増す。 |
| Electron/Tauriラッパー | 不採用（今回のスコープ外）。CallFlow自体をネイティブアプリ化する大規模な構成変更になり、既存のVercel本番運用と乖離する。 |
| CallFlow自体をMac上でも起動 | 不採用。本番はVercelホスティングを維持する前提のため、二重運用は複雑さを増す。 |
| ローカル専用ページをCompanionから配信 | 不採用（今回は）。本番画面から直接操作したいという要件（「架電する」画面内に配置）に合わず、別ページへの遷移が必要になる。 |

→ 現時点ではlocalhost HTTPS（mkcert）を推奨構成とするが、PNAの実機挙動次第では追加のハンドシェイク処理が必要になる可能性があることを明記する。

---

## 7. セキュリティ

ご指示のセキュリティ要件（127.0.0.1/localhostのみbind、HTTPS、CORS限定、ペアリングコード→トークン発行、最大録音時間・サイズ制限、同時解析1件、一時ファイル確実削除、ログへの秘密情報・文字起こし全文非出力等）は、いずれも実装可能と判断する。具体的な実装方針は実装フェーズで確定する。

---

## 8. 想定ファイル構成

```
companion/
  src/
    server.ts          # HTTPSサーバー本体、ルーティング
    transcription.ts    # ffmpeg変換 + whisper.cpp実行
    codex-client.ts      # Codex App Serverの起動・JSON-RPC通信
    pairing.ts           # ペアリングコード生成・トークン発行・検証
    cleanup.ts            # 一時ファイルの確実な削除
    types.ts               # 共有型定義
  tests/
    *.test.ts             # fake command/mock processを使った自動テスト

scripts/
  setup-callflow-companion-macos.sh
  start-callflow-companion.sh
  stop-callflow-companion.sh
  check-callflow-companion.sh

docs/
  local-call-recorder-feasibility.md（本ファイル）
  local-call-recorder-design.md（実装フェーズで作成）
  local-call-recorder-setup.md
  local-call-recorder-troubleshooting.md
  local-call-recorder-security.md

src/
  components/callflow-app.tsx（CallScreenへの録音UI追加、TranscriptModal・ヘッダーボタンの置き換え）
  lib/
    types.ts（TranscriptAnalysis型は既存を再利用、Companion関連の型を追加）
    companion-client.ts（新規、ブラウザ側からCompanionを呼ぶクライアント）
```

---

## 9. 実装フェーズ分割

ご指示のPhase 1〜6をそのまま採用する。各Phaseの完了条件を以下に定義する。

- **Phase 1（ブラウザ録音UIのみ）**: 完了条件 = マイク権限取得、5秒テスト、録音開始/停止、音量メーター表示、録音の再生・破棄がChromeで動作し、Companion・Whisper・Codexへの依存が一切ない状態でUIが完結すること。feature flag `false`でも既存機能に影響しないこと。
- **Phase 2（Companion最小構成）**: 完了条件 = `./scripts/start-callflow-companion.sh`でHTTPSサーバーが起動し、`/health`が200を返し、ペアリングコード発行→CallFlow側での入力→トークン発行が一通り動作し、音声ファイルを受信して一時ディレクトリに保存後、確実に削除されること。
- **Phase 3（ffmpeg+whisper.cpp）**: 完了条件 = 受信した音声をffmpegで16kHz/モノラル/WAVへ変換し、whisper.cppで日本語文字起こしができ、結果がCallFlow画面へ表示され、利用者が修正できること。
- **Phase 4（Codex App Server）**: 完了条件 = App Serverが子プロセスとして起動し、`getAuthStatus`でログイン確認ができ、`outputSchema`付きの`turn/start`で構造化解析ができ（利用上限回復後に実地確認）、不正なJSON・エラー・タイムアウトが適切にハンドリングされること。
- **Phase 5（CallFlow連携）**: 完了条件 = 解析結果が架電フォームへ反映され、「架電記録へ反映」を押すまでSupabaseへ保存されず、既存の`saveCallLog`/`record_call`経由で正しく保存され、既存の架電履歴に反映されること。
- **Phase 6（実機テスト）**: 完了条件 = MacBook Air M4 + iPhoneスピーカー通話の実環境で、双方の声が拾えるマイク設定を確認し、長時間録音・各種エラーからの復旧が確認できること。

---

## 9-1. Phase 1 実機確認結果

実施日: 2026-07-21

MacBook Air（内蔵マイク）+ Google Chrome（一時プロファイル、既存プロファイルへの影響なし）で、feature flag `NEXT_PUBLIC_CALL_RECORDING_ENABLED=true`のローカル開発サーバー（デモモード、Supabase接続なし）を用いて実機確認を行った。

- iPhoneをスピーカー再生状態にし、iPhoneスピーカーからの音声とMacへ向かって話した利用者本人の声の**双方を同時に録音**できることを確認した。
- 音量メーターは録音中、実際の発話に反応して正常に動作した。
- 録音の開始・停止操作は正常に動作した。
- 生成された録音ファイルは78.5KBで、CallFlowアプリ内の再生機能で正常に再生できた。
- 初回のアプリ内再生時は音が聞こえないように感じたが、その後の再生では正常に音声を確認できた（初回のみの現象であり、原因は今回のPhase 1確認の範囲では特定していない。Phase 2以降、または再現性の確認が必要な場合に改めて調査する）。
- 上記により、ブラウザのみで完結する録音UI（マイク権限取得・音量メーター・録音開始/停止・アプリ内再生）が実機で問題なく動作することを確認した。**Phase 1の完了条件を満たし、Phase 2へ進める状態である。**

---

## 9-2. Phase 2A（Companion最小構成・音声送信テスト）実装結果

実施日: 2026-07-21

Node標準機能（`node:http`/`node:https`/`node:crypto`/`node:fs`/`node:stream`等）のみでCallFlow Companionの最小構成（`GET /v1/health`, `POST /v1/pair`, `POST /v1/audio`）を実装した。新規npm依存関係は追加していない。Homebrew・mkcert・ffmpeg・whisper.cppは今回もインストールしていない（開発用HTTPモードのみで確認）。

- Companionは`127.0.0.1:4318`のみにバインドし、`CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP=true`を明示的に設定しない限り起動しない設計とした（TLS証明書が無い場合は起動を拒否する）。
- ペアリング（6桁コード・10分失効・1回使用・失敗回数上限）、Bearerトークン発行（ハッシュ化保存、生トークンは非ログ出力）、Origin完全一致のCORS、音声のストリーミング受信・MIME検証・100MBサイズ制限（Content-Length偽装対策込み）、一時ファイルの安全な作成・削除（0700/0600権限、UUIDファイル名、パストラバーサル対策、起動時・終了時清掃）を実装し、companion側46件・ブラウザクライアント側14件の自動テストで検証した。
- 実機（MacBook Air、Google Chrome、デモモード）で、Companion起動→CallFlowからのhealth check→ペアリング→トークンのlocalStorage保存・再読み込み後の復元→ペアリング解除まで一通り確認した。実マイクがこの検証環境では使用できないため、「Macへ送信テスト」ボタンの実クリックまでは到達できなかったが、CallFlowの実origin（`http://127.0.0.1:3002`）・実トークンを使って`POST /v1/audio`を直接実行し、200 OK・一時ファイル削除済みを確認した。この間、Supabase・Vercel・その他外部ドメインへの通信は0件だった。
- 詳細は [docs/callflow-companion-phase2a.md](./callflow-companion-phase2a.md) を参照。**Phase 2Aの完了条件を満たし、Phase 2B（ffmpeg+whisper.cpp）へ進める状態である。**

---

## 9-3. Phase 2B（Companion HTTPS化）実装結果

実施日: 2026-07-21

CompanionをHTTPS化し、既定モードをHTTP開発モードからHTTPSへ切り替えた。**この時点でHomebrew・mkcertは実機に未インストール**（ユーザーの判断により実インストールと実機HTTPS確認は後日実施されるため）。そのため、以下は「実機のHomebrew/mkcertインストールに依存しない範囲」での実装・自動テストの結果である。

- `companion/src/config.ts`: `allowInsecureHttp`が明示されない限りHTTPSを既定とし、証明書・秘密鍵の存在・読み取り可否・有効な証明書として解釈できるかを`canStartServer()`で検証。いずれか欠けていてもHTTPへ自動フォールバックせず起動を拒否する。
- `companion/src/server.ts`: `minVersion: "TLSv1.2"`を明示。証明書・秘密鍵の組み合わせが不正な場合も明確なエラーで起動を拒否する。
- `companion/src/cors.ts`: Chrome Private Network Access向けに、許可Originかつ`Access-Control-Request-Private-Network: true`の場合のみ`Access-Control-Allow-Private-Network: true`を返す実装を追加。
- `src/lib/companion-client.ts`: `validateCompanionUrl()`を追加し、Companion接続先が`https://callflow-companion.localhost:4318`等のlocalhost系・ポート4318固定であることを送信前に強制検証する（外部ドメイン・LAN IP・任意ポート・認証情報付きURL・query/fragment付きURLを拒否）。
- テストはこのセッションの実行時にopensslで自己署名した**テスト専用**の証明書・秘密鍵を使用し、実際のmkcert CAROOT・秘密鍵は一切使用していない。companion側54件（Phase 2Aの46件＋HTTPS/PNA関連8件）・ブラウザクライアント側38件（Phase 2Aの14件＋URL検証関連12件）が全て成功した。
- Homebrew公式インストーラーをこのセッションのツールから実行しようとしたが、対話的なTTY・sudo資格情報が無いため失敗することを確認した（`sudo -n -v` → `a password is required`）。そのため、Homebrew・mkcertはユーザー自身のTerminal.appで導入していただいた。

**追記（2026-07-21〜22、実機確認完了）**: ユーザーがHomebrew・mkcertを導入し、`mkcert -install`でローカルCAを登録。`npm run companion:setup-tls`で証明書発行後、macOS標準LibreSSLが`openssl x509 -ext`オプションに未対応で発行スクリプトがエラー終了する問題を発見し修正（`fix: support macOS LibreSSL in TLS setup`）。修正後、通常のGoogle Chrome（サンドボックス外）で以下を確認した。

- `https://callflow-companion.localhost:4318/v1/health`で証明書警告が出ないこと（`secure: true`）
- CallFlow（デモモード、`http://127.0.0.1:3002/dashboard`）からの接続確認・ペアリング成功
- MacBook Air内蔵マイクでの実録音（約48秒、`audio/webm;codecs=opus`、759.4KB）とアプリ内再生
- 「Macへ送信テスト」によるHTTPS経由の実送信成功、`temporaryFileDeleted: true`、Companion一時ディレクトリが空
- Supabase・Vercel・外部ドメインへの通信は発生していない

詳細は [docs/callflow-companion-phase2b.md](./callflow-companion-phase2b.md) §16を参照。**Phase 2Bは実機確認まで含めて完了し、Phase 3（ffmpeg+whisper.cpp）へ進める状態である。**

---

## 9-4. Phase 3A（ffmpeg・whisper.cppセットアップ・モデル選定）実装結果

実施日: 2026-07-22

Homebrewでffmpeg・whisper-cpp（whisper.cpp、`whisper-cli`コマンド）を導入し、公式配布元（HuggingFace `ggerganov/whisper.cpp`）からSHA-256検証付きで`ggml-base.bin`・`ggml-small.bin`（いずれも多言語モデル、`.en`限定版・medium/large版は対象外）を取得した。macOS標準`say`コマンドで生成した日本語音声を使い、base/smallモデルを実機ベンチマークし、精度・速度の両面から`small`をデフォルトモデルに選定した（詳細・実測値は[docs/callflow-transcription-phase3a.md](./callflow-transcription-phase3a.md)参照）。

**whisper.cppの精度・速度は実機で検証済み**（上記「技術的リスク」の1項目目が解消）。独立したセキュリティ・信頼性レビュー（Opus）を経て、指摘事項（Pythonへのコード注入パターン、モデルダウンロードのタイムアウト欠如、`/usr/bin/time`ラップ時のプロセス孤児化バグ等）を修正し、`chore: prepare local whisper transcription`としてコミット済み。

## 9-5. Phase 3B（Companion統合・CallFlow UI）実装結果

実施日: 2026-07-22

Phase 3Aのffmpeg・whisper.cppを、既存のHTTPS版Companion（Phase 2B）へ非同期ジョブAPI（`POST/GET/DELETE /v1/transcriptions`）として統合し、CallFlow側に開始・キャンセル・再試行・コピー・破棄のUIを追加した。文字起こし結果はメモリ上のみで保持し、Supabaseへの保存・Codexによる解析は行わない（Phase 4で対応予定）。

- 実バイナリ・実HTTPS・procedurally生成した合成音声を使った手動E2E（ブラウザ→HTTPS Companion→whisper-cli実行）で、ジョブ作成・完了・一時ファイル完全削除・外部通信ゼロを確認済み
- 独立したセキュリティレビュー（Opus）: SHIP判定（P0・P1なし）。同時アップロードによる待機上限の実質的な回避（P2）等、軽微な指摘を修正
- 独立した信頼性レビュー（Opus）: 当初BLOCK判定。ジョブキャンセルとプロセス自然完了が競合した際にタイマーリークでCompanionプロセスが終了できなくなる不具合（P1）、fs操作の例外がCompanionプロセス全体をクラッシュさせうる不具合（P1）を検出。両方修正し、再検証で解消を確認（テストスイートの実行時間が約10分のハングから約3秒へ改善）
- 詳細は[docs/callflow-transcription-phase3b.md](./callflow-transcription-phase3b.md)、[docs/callflow-transcription-security.md](./callflow-transcription-security.md)、[docs/callflow-transcription-phase3-review.md](./callflow-transcription-phase3-review.md)を参照

**Phase 3（3A・3B）は完了し、Phase 4（Codex App Serverによる解析）へ進める状態である。**

---

## 9-6. Phase 4（Codex App Serverによる営業通話解析）実装結果

実施日: 2026-07-22

文字起こし文章をCodex（`codex app-server`、Companionの子プロセス、ChatGPTアカウント認証・OpenAI APIキー不使用）へ送信して営業内容を解析し、構造化された架電結果・温度感・要約・担当者名・課題・次回対応・次回対応日・信頼度・要確認フラグを提案させる非同期ジョブAPI（`POST/GET/DELETE /v1/analyses`）を実装し、CallFlow側に確認・編集・「架電フォームへ反映」のUIを追加した。解析結果は利用者が明示的に反映を押すまで一切保存されない。

- 実装前に、現在インストール済みのCodex CLI（`codex-cli 0.144.3`）から実際のJSON-RPCプロトコルを再確認（`codex app-server generate-ts`での型生成＋実プロセス起動による生通信確認）。事前資料を鵜呑みにせず、`turn/completed`通知には応答本文が含まれず別途`thread/read`が必要である等の実挙動を実地で発見した
- プロンプトインジェクション対策（`<transcript>`タグでの分離、`approvalPolicy:"never"`・`sandbox:"read-only"`・ツール/MCP未構成）を、合成のプロンプトインジェクション文言を含む文字起こしを使い、実装コード経由（fakeではなく実際のCodex CLI）で実機検証済み。ファイル読み取り・コマンド実行は一切発生しなかった
- 独立した設計レビュー（Opus）: REVISE（狭い範囲）。turnタイムアウト未定義（P1）等を実装前に反映
- 独立したセキュリティレビュー（Opus）: SHIP判定（P0・P1なし）
- 独立した信頼性レビュー（Opus）: SHIP判定（P0・P1なし）。Codex子プロセスの`stderr`に`'error'`リスナーが無い非対称性、起動タイムアウト時の子プロセス後始末漏れ（いずれもP3）を検出・修正
- 独立した最終ゲートレビュー（Opus、新規インスタンス）: SHIP判定（P0・P1なし）
- 詳細は[docs/callflow-analysis-phase4.md](./callflow-analysis-phase4.md)、[docs/callflow-analysis-security.md](./callflow-analysis-security.md)、[docs/callflow-analysis-phase4-review.md](./callflow-analysis-phase4-review.md)を参照

**Phase 4は完了し、実機確認（実際のCodexログイン状態・実際のChatGPTアカウント利用上限状況下での動作確認）へ進める状態である。**

**追記（2026-07-23）**: 実機確認で見つかった「次回対応日が日付のみ（時刻の言及が無い）場合に反映されない」不具合を修正した。次回対応日は日付のみ・日付＋時刻のいずれも安全に扱えるようになり、発言に無い時刻を補完することはない。独立したOpusレビュー（2回、SHIP判定）・実機での表示確認を経てローカルコミット済み。詳細は[docs/callflow-analysis-phase4.md](./callflow-analysis-phase4.md) §10、[docs/callflow-analysis-phase4-review.md](./callflow-analysis-phase4-review.md) §7を参照。

---

## 10. 技術的リスク

- ~~whisper.cppの精度・速度が実用に耐えるか未検証~~ → **解消（2026-07-22）**。Phase 3Aで実機ベンチマーク済み、詳細は[docs/callflow-transcription-phase3a.md](./callflow-transcription-phase3a.md)参照。
- ~~Chrome Private Network Accessの実際の挙動が未検証~~ → **解消（2026-07-21〜22）**。Phase 2B実機確認で確認済み。
- ~~Codex利用上限により、構造化出力の正常系動作が未確認~~ → **解消（2026-07-22）**。Phase 4で実際のCodex CLI・ChatGPTアカウントを使い、正常系・プロンプトインジェクション耐性の両方を実機検証済み（詳細は[docs/callflow-analysis-phase4.md](./callflow-analysis-phase4.md) §9参照）。
- **ai_fields列をrecord_call経由で保存するにはDB変更（RPC引数追加）が必要**（§9参照）。Phase 4までのスコープでは対応しない（DB変更禁止のため）。Phase 5以降で要検討。
- **60分の長時間録音でのメモリ・処理時間**が実機未検証（Phase 3Bでは60分の上限設定と動的タイムアウトのみ実装、実際の60分音声での実測は未実施）。
- **Codexの利用上限（レート制限）に達した場合の実際のユーザー体験**は、今回の開発セッションでは利用上限に到達しなかったため未確認（`usage_limit_exceeded`のエラーハンドリング自体は実装・自動テスト済み）。

---

## 11. ユーザーが手動で行う必要がある設定

- `./scripts/setup-callflow-companion-macos.sh`の実行（Homebrew・ffmpeg・mkcert・whisper.cppのインストール、モデルダウンロード、証明書発行）
- Codexへのログイン（`codex login`、ChatGPTアカウント）
- マイクへのアクセス許可（Chrome/macOS）
- 初回接続時、Chromeがローカルネットワークアクセスの許可を求める場合はこれを許可する
- 録音前の5秒マイクテストの実施
- 解析結果を保存前に必ず内容を確認すること

**本番反映に関する前提（重要）**: `NEXT_PUBLIC_CALL_RECORDING_ENABLED`・`NEXT_PUBLIC_CALL_COMPANION_ENABLED`・`NEXT_PUBLIC_CALL_TRANSCRIPTION_ENABLED`・`NEXT_PUBLIC_CALL_ANALYSIS_ENABLED`はいずれもコード上`=== "true"`の厳密一致でのみ有効化されるため、**環境変数を明示的に設定しない限り既定値はfalse（無効）**である。本番Vercelにはこれらの環境変数を**まだ一切設定していない**ため、本番反映後もこの機能群は既定で非表示・非動作のままであり、既存の架電・企業管理等の機能には影響しない。

**本ブランチのスコープについて**: 本ブランチはこの通話録音・文字起こし・Codex解析機能のみを対象とし、DBマイグレーション・SQL変更は一切含まない。既にorigin/mainへマージ済みの企業安全管理機能（company-safety）のうち、`supabase/harden-company-writes-stage-b.sql`（Stage B、書き込み経路の追加的な強化）は本ブランチとは無関係に、従来どおり**未適用のまま**である。本ブランチ自体もこの時点では**本番（Vercel本番環境・本番Supabase）へは一切反映していない**。

---

## 12. 推奨する最終構成

CallFlow本番画面（ブラウザ録音）→ Mac上のCallFlow Companion（HTTPS, `https://callflow-companion.localhost:4318`）→ ffmpeg（WAV変換）→ whisper.cpp（日本語文字起こし）→ Codex App Server（`turn/start` + `outputSchema`による構造化解析、`sandbox: read-only` / `approvalPolicy: never` / `networkAccess: false`）→ CallFlow画面（利用者確認）→ 既存の`saveCallLog`/`record_call` RPC経由でSupabase保存。

ご指示の構成をそのまま採用する。代替案（Chrome拡張・Electron等）は§6の理由により不採用とする。

---

## 13. 不採用にする構成と理由

§6の代替案比較を参照。加えて：

- **OpenAI APIキーによる従量課金analyze-transcript経路の存置**: 既存の`/api/analyze-transcript`（OpenAI APIキー使用）はそのまま残すが、新機能はこれを使用しない別経路とする。ご指示の「OpenAI APIの従量課金は使わない」を満たすため。
- **既存の単純なキーワード解析（`localAnalysis`）への自動フォールバック**: 採用しない。Codex解析が失敗した場合は明示的にエラー表示し、黙って`localAnalysis`相当の処理へ切り替えない（ご指示どおり）。

---

## 付録: 生成物の保存場所（リポジトリ外）

- `/tmp/codex-app-server-investigation/ts/` — `codex app-server generate-ts --experimental`の生成物
- `/tmp/codex-app-server-investigation/schema/` — `codex app-server generate-json-schema --experimental`の生成物
- `/tmp/codex-app-server-investigation/exec-events.jsonl` — テスト文章のみを使った`codex exec`実行結果（利用上限エラー）

いずれもリポジトリへは追加していない。
