-- CSV一括登録機能のためのマイグレーション
-- companiesテーブルにemail列を追加します（追加のみ・nullable・既存データへの影響なし）。
-- Supabaseダッシュボードの SQL Editor に貼り付けて実行してください。
alter table public.companies add column if not exists email text;
