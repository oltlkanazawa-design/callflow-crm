# CallFlow CRM — 本番版

4〜10人のテレアポ営業チーム向けCRMです。標準では外部APIキーなしで、Codex appserver / Next.js 上のローカル保存とルール解析で動きます。必要になった場合だけ、Supabase Auth/Postgres や OpenAI を任意接続できます。

## 実装済み

- Codex appserverで動くローカルファースト運用
- 企業リストの登録、検索、温度感管理
- CSV・表・Webページコピーからの営業先リスト自動取り込み
- 会社URL、取得元URL、会社名検索リンクの管理
- 架電前に公式URL・取得元・検索導線を確認できる画面
- 架電画面、架電結果、会話メモ、次回対応日の記録
- 架電履歴と担当者別実績
- 文字起こしから結果、温度感、要約、課題、担当者、次回対応をappserver側で構造化抽出
- スマートフォン・タブレット対応
- 任意：メール・パスワード認証、保護ルート、ログアウト
- 任意：組織単位のデータ分離とRow Level Security
- 任意：OpenAI接続時の高精度な文字起こし解析

## ローカル起動

```bash
npm install
cp .env.example .env.local
npm run dev
```

`http://localhost:3000/login` を開きます。Supabase未設定なら「デモ版を開く」で、そのままCodex appserver運用を試せます。

## Codex appserver運用

外部APIキーなしで動かす場合は、`.env.local` のSupabase/OpenAI項目を空のままにします。

```bash
npm run dev
```

Codex appserverから開く場合は、ホストを明示する専用スクリプトも使えます。

```bash
npm run appserver
```

営業先リストは「企業リスト」→「リスト自動取り込み」から登録できます。CSV、スプレッドシート、Webページの検索結果などからコピーしたテキストを貼り付けると、会社名・電話番号・URLを抽出します。

```text
株式会社サンプル商事,076-000-0000,https://example.com
石川採用テック 076-111-2222 www.example.jp
```

架電前は「架電する」画面で公式URL、会社名検索、取得元URLをすぐ開けます。

## Supabase接続

1. Supabaseでプロジェクトを作成します。
2. SQL Editorで `supabase/schema.sql` を実行します。
3. Authenticationで最初の管理者ユーザーを作成します。
4. SQL末尾の例に従い、組織と管理者プロフィールを登録します。
5. `.env.local` に以下を設定します。

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxx
```

メンバー追加時はAuthenticationでユーザーを作り、同じ `organization_id` の `profiles` レコードを追加します。管理者は `role='admin'`、営業担当は `role='member'` を指定します。

## 文字起こし解析

標準ではappserver内のルール解析が動作します。外部AI APIは不要です。

OpenAIを使いたい場合のみ、サーバーの環境変数へ設定します。キーは `NEXT_PUBLIC_` を付けず、ブラウザへ公開しません。

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6-luna
```

未設定時はappserver内のルール解析が動作します。OpenAI接続時はResponses APIのStructured Outputsで形式を固定します。

## Vercel公開

無料本番運用の具体手順は `FREE_PRODUCTION_DEPLOY.md` を見てください。

1. このフォルダをGitHubの非公開リポジトリへ登録します。
2. VercelでリポジトリをImportします。
3. `.env.local` と同じ環境変数をVercelへ登録します。
4. Supabase AuthenticationのSite URLとRedirect URLsへ公開URLを追加します。
5. デプロイ後、管理者と営業担当それぞれでログイン・データ分離・架電保存を確認します。

Codex appserverだけで使う場合はVercel公開やSupabase接続は必須ではありません。

## セキュリティ上の要点

- 共有データのアクセス制御は画面ではなくPostgres RLSで強制します。
- OpenAI APIキーを使う場合もRoute Handlerだけで使用します。
- 文字起こし解析の内部Route HandlerはSupabase接続時にログインを必須とします。
- 架電履歴は営業担当が削除できない設計です。
- 本番投入前にSupabaseのMFA、パスワードポリシー、バックアップ、監査ログ設定を確認してください。

## 主なファイル

- `src/components/callflow-app.tsx` — CRM画面と操作
- `src/lib/data.ts` — Supabase／デモ保存の切替
- `src/app/api/analyze-transcript/route.ts` — appserver文字起こし解析
- `src/proxy.ts` — 認証セッションと保護ルート
- `supabase/schema.sql` — テーブル、索引、RLSポリシー
- `supabase/init-free-production.sql` — 無料本番の初期管理者作成
- `supabase/add-member-template.sql` — 営業メンバー追加テンプレート
- `FREE_PRODUCTION_DEPLOY.md` — 無料本番デプロイ手順
- `.env.example` — 必要な環境変数
- `.env.production.example` — Vercel本番用の環境変数

## 検証

```bash
npm run lint
npm run build
```
