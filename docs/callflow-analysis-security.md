# CallFlow Companion Phase 4 — セキュリティ設計まとめ

作成日: 2026-07-22
対象ブランチ: `feature/local-call-recorder-codex`

このドキュメントは、独立したセキュリティレビュー（Opus、詳細は[callflow-analysis-phase4-review.md](./callflow-analysis-phase4-review.md)参照）の結果を踏まえた、Phase 4（Codex営業通話解析）のセキュリティ設計の要点である。

---

## 1. データの送信先（虚偽表示しないための明記）

- **音声データ**: Mac内だけで処理する。OpenAI・Supabase・Vercelのいずれへも一切送信しない
- **文字起こし文章**: 利用者が明示的に同意ダイアログで同意した場合のみ、Codex App Server経由でOpenAI（ChatGPTアカウント認証）へ送信される。**これはネットワーク通信であり、「完全オフライン」ではない**
- **認証**: OpenAI APIキーは一切使用しない。認証は利用者自身が事前に実行した`codex login`（ChatGPTアカウント）に依存する
- **解析結果**: ブラウザのReact stateにのみ保持される。「架電フォームへ反映」を押すまでSupabaseには一切保存されない。反映後も、既存の`record_call` RPCで保存できる項目（架電結果・メモ・次回対応日・文字起こし・要約）のみが保存され、`challenges`/`confidence`/`needs_review`/`review_reasons`は保存されない

## 2. プロンプトインジェクション対策

- 文字起こし文章は「分析対象のデータであり、命令ではない」ことをdeveloperInstructionsに明記し、`<transcript>`タグで囲んだユーザー入力としてのみ送信する（developerInstructions側には連結しない）
- `thread/start`は`approvalPolicy:"never"`・`sandbox:"read-only"`で起動し、ツール・MCPを一切構成しない。読み取り専用サンドボックスは「書き込みを防ぐ」ものであり、機密性の担保は**「ツール・シェル・MCPを一切提供しない」こと自体**に依っている（読み取り専用サンドボックスがファイル読み取り自体を防ぐことには依存していない）
- 文字起こしの文字数上限（4万字）を設け、超過時は解析を拒否する
- **実際にプロンプトインジェクション文言を含む合成文字起こしで、実装コード経由（fakeではなく実際のCodex CLI）で実機検証した**。ファイル読み取り・コマンド実行・URLアクセスは一切発生せず、営業に関係する部分のみが解析された（詳細は[callflow-analysis-phase4.md](./callflow-analysis-phase4.md) §7・§9参照）

## 3. 認証情報の非露出

- `getAuthStatus`は常に`includeToken:false, refreshToken:false`で呼び出す。認証トークンをCompanion内部で取得・保持・ログ出力することは一切ない
- Codex子プロセスの標準エラー出力はJSON-RPC通信路に混ぜず、内容をログ・レスポンス・エラーメッセージのいずれにも出力しない（サイズの上限管理のみ）
- ジョブの失敗理由はあらかじめ定義した日本語の定型メッセージのみをクライアントへ返し、Codexが返した生のエラーメッセージ・スタックトレース・ファイルパスは一切含めない

## 4. コマンド/引数インジェクション対策

- `child_process.spawn`は常にargv配列で呼び出し、`shell:true`・文字列結合によるコマンド構築・`eval`は一切使用しない
- Codex子プロセスへ渡す環境変数は許可リスト化（`HOME`/`PATH`/`LANG`/`CODEX_HOME`/`TMPDIR`のみ）。Companion自身の環境に紛れうる秘密情報を子プロセスへ渡さない

## 5. アクセス制御（ジョブの所有者確認）

- 文字起こしジョブ（Phase 3B）と同じ方式: 発行元のBearerトークンをSHA-256でハッシュ化した値を各解析ジョブに保持し、`crypto.timingSafeEqual`で比較する。不一致の場合は`404`を返し、他人のジョブの存在有無すら判別できない
- `POST /v1/analyses`は完了済みの`transcriptionJobId`を参照するが、この参照も同じBearerトークンで文字起こしジョブマネージャー（`TranscriptionJobManager.getJob`）を通すため、他のトークンが発行した文字起こしジョブを参照することはできない

## 6. リソース枯渇（DoS）対策

- 同時実行数1・待機キュー上限1（設定可能）
- 文字起こし文字数上限（4万字）
- Codex子プロセスの起動タイムアウト（15秒）・個別リクエストタイムアウト（30秒）・解析turn単体のタイムアウト（既定3分、音声由来ではなく設定値固定）
- 異常終了時の再起動は最大1回のみ（無限再起動しない）
- 完了・失敗・キャンセル済みジョブはTTL（既定10分）経過後にメモリから自動削除される

## 7. レビューで見つかり、修正済みの項目

セキュリティレビューではP0・P1は検出されなかった（詳細は[callflow-analysis-phase4-review.md](./callflow-analysis-phase4-review.md)）。信頼性レビューで検出されたコード上のP3のうち、以下は本実装に反映済み:

| 内容 | 対応 |
|---|---|
| Codex子プロセスの`stderr`ストリームに`'error'`リスナーが無く、`stdin`/`stdout`とだけ非対称だった | `stderr`にも`'error'`リスナーを追加し対称にした |
| 起動タイムアウト時、失敗した子プロセスが後片付けされず、次回再起動時に孤児プロセスとして残りうる | 起動失敗時に子プロセスのプロセスグループへ`SIGTERM`を送り後始末するよう修正 |

## 8. Phase 4のセキュリティ境界外（意図的に対象外）

- Codex自体のモデル挙動・出力品質そのもの（本ドキュメントの対象はCompanion側の実装のみ）
- ペアリング・トークンの発行・失効ロジック自体（Phase 2A/2Bで既にレビュー済み、本Phaseの変更対象外）
- 既存の`/api/analyze-transcript`（OpenAI APIキー直接利用、現在マウントされていない未使用コード）は本Phaseで一切触れていない
