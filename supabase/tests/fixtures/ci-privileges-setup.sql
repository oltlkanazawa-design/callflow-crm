-- =========================================================
-- CI専用：GitHub Actions上のsupabase CLIローカルスタックに対して、
-- anon/authenticatedの権限を本番Supabaseと同等の既定値へ明示的に揃える。
--
-- supabase CLIのローカルスタックは既にauthスキーマ・auth.users・auth.uid()・
-- anon/authenticated/service_roleロールを標準で用意しているため、
-- それらを再作成する必要はない。ここではpublicスキーマの権限だけを
-- 明示的に設定し、CLIバージョン差異による既定権限の揺れに依存しないようにする。
-- =========================================================

grant usage on schema public to authenticated, anon;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;
