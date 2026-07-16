# CallFlow CRM 無料本番デプロイ手順

この手順は、月額0円で本番に近い形で運用するための構成です。

```text
Vercel Free
+ Supabase Free
+ OpenAI APIなし
+ 独自ドメインなし
```

重要：本番で4〜10人が同じデータを見るには、Supabase Freeを使ってください。Supabase未接続のデモモードは各ブラウザ内保存なので、チーム共有には向きません。

## 1. GitHubへアップロード

1. GitHubで新しいPrivate Repositoryを作成します。
2. この `callflow-production` フォルダの中身をアップロードします。
3. `node_modules`、`.next`、`.env.local` はアップロードしません。

## 2. Supabase Freeを作成

1. SupabaseでFreeプロジェクトを作成します。
2. SQL Editorを開きます。
3. `supabase/schema.sql` の内容をすべて実行します。
4. Authenticationで管理者ユーザーを作成します。
5. 作成したユーザーのUUIDをコピーします。
6. `supabase/init-free-production.sql` を開き、`AUTH_USER_UUID` を置換して実行します。

## 2.5 CSV一括登録機能を使う場合の必須手順（重要）

**このバージョンには「CSV一括登録」機能が含まれており、`companies`テーブルに`email`列が必要です。**

- **新規にSupabaseプロジェクトを作成する場合**：手順2で実行する`supabase/schema.sql`に`email`列が最初から含まれているため、追加の作業は不要です。
- **既にこのCRMを本番運用していて、今回このバージョンへアップデートする場合**：`schema.sql`は再実行しないため、`email`列が既存の`companies`テーブルに存在しません。**デプロイ前に必ず`supabase/add-company-email-column.sql`をSupabaseのSQL Editorで実行してください。**

**この手順を飛ばしてデプロイすると何が起きるか**：CSV一括登録機能を使った瞬間、登録しようとした行が1件も保存されずすべてエラーになります（既存データが壊れることはありませんが、営業担当が「CSVをアップロードしたのに何も登録されない」という状態に直面します）。

## 3. Vercel Freeへデプロイ

1. Vercelで「Add New Project」を選びます。
2. GitHubのリポジトリをImportします。
3. Framework PresetはNext.jsのままでOKです。
4. Environment Variablesに `.env.production.example` の内容を入れます。
5. `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` はSupabaseのProject Settingsからコピーします。
6. `OPENAI_API_KEY` は入れません。
7. Deployします。

## 4. Supabase AuthのURL設定

Vercelで発行されたURLを確認します。

例：

```text
https://callflow-crm.vercel.app
```

Supabaseの Authentication → URL Configuration で以下を設定します。

```text
Site URL:
https://あなたのVercel URL

Redirect URLs:
https://あなたのVercel URL/**
```

## 5. 初回確認

1. Vercelの公開URLを開きます。
2. 管理者メールアドレスとパスワードでログインします。
3. 企業を1件追加します。
4. 架電記録を1件保存します。
5. 別ブラウザ、または別PCでログインして、同じデータが見えるか確認します。

## 6. 営業メンバー追加

1. Supabase Authenticationで営業メンバーのユーザーを作成します。
2. 作成したユーザーUUIDをコピーします。
3. `supabase/add-member-template.sql` を使って `profiles` に追加します。

## 7. 無料運用の注意点

- Supabase Freeはデータベース容量が500MBまでです。
- 無料プロジェクトは一定期間使われないと停止することがあります。
- 自動バックアップやSLAは弱いので、重要データが増えたら有料化を検討してください。
- 独自ドメインを使わなければ、Vercelの無料URLで運用できます。
- OpenAI APIキーを入れなければ、文字起こし解析はappserver内のルール解析だけで動きます。

## 推奨の本番環境変数

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxx
NEXT_PUBLIC_ALLOW_DEMO=false
OPENAI_API_KEY=
OPENAI_MODEL=
```

