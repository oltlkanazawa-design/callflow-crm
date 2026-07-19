-- =========================================================
-- ローカル／隔離環境専用のテストハーネス。本番Supabaseでは実行しないこと。
--
-- 本番Supabaseはauthスキーマ・auth.users・anon/authenticatedロール・
-- ALTER DEFAULT PRIVILEGESを標準で用意していますが、素のPostgresコンテナには
-- 存在しないため、schema.sql（またはベーススキーマ＋段階A）を適用する前に、
-- このファイルでSupabaseの標準構成を最小限だけ再現します。
--
-- 想定手順（例）:
--   docker run -d --name cf-test -e POSTGRES_PASSWORD=test -p 15432:5432 postgres:17
--   docker cp supabase/tests/00-local-test-harness.sql cf-test:/tmp/
--   docker exec cf-test psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/00-local-test-harness.sql
--   docker cp supabase/schema.sql cf-test:/tmp/          -- 経路A: schema.sql単独適用
--   docker exec cf-test psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/schema.sql
--   docker cp supabase/tests/company-safety-multi-org.sql cf-test:/tmp/
--   docker exec cf-test psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/company-safety-multi-org.sql
--   docker rm -f cf-test
-- =========================================================

create extension if not exists "pgcrypto";

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to public;
grant usage on schema public to authenticated, anon;

-- 本番Supabaseは新規作成されるテーブル/ビューへ既定でこの権限を自動付与する。
-- これが無いと「revoke漏れ」のようなバグをローカルテストで検出できないため必須。
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;
