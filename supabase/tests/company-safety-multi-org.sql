-- =========================================================
-- 企業安全管理: 複数組織の回帰テスト
--
-- 目的: 2026-07-18に発見したcompanies_with_call_status（security_invoker漏れによる
-- 組織横断の情報漏洩）の再発防止。以下3つの独立したセットアップ経路それぞれに対して
-- このファイルを実行し、最後に「ALL ASSERTIONS PASSED」が出力されることを確認すること。
--
--   経路A: supabase/schema.sql を新規DBへ単独適用
--   経路B: 既存のベーススキーマ（旧schema.sql相当）＋ supabase/add-company-safety-stage-a.sql
--   経路C: 経路A または B の後、supabase/rollback-company-safety-stage-a.sql を実行し、
--          さらに supabase/add-company-safety-stage-a.sql を再適用
--
-- 事前に supabase/tests/00-local-test-harness.sql を適用しておくこと。
-- ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
-- このファイルはトランザクション内で完結し、最後にROLLBACKするため、
-- 実行後にテストデータは残らず何度でも再実行できる。
--
-- 途中で何らかのアサーションに失敗した場合は例外が送出され、
-- psqlを -v ON_ERROR_STOP=1 で実行していれば非ゼロ終了コードになる。
-- =========================================================

begin;

-- ---------------------------------------------------------
-- セットアップ: 組織A（企業4件・admin+member）、組織B（企業1件・admin+member）
-- ---------------------------------------------------------
insert into public.organizations (id, name) values
  ('a0000000-0000-0000-0000-00000000000a','テスト組織A'),
  ('b0000000-0000-0000-0000-00000000000b','テスト組織B');

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@test.local'),
  ('b1111111-1111-1111-1111-111111111111','admin-b@test.local'),
  ('b2222222-2222-2222-2222-222222222222','member-b@test.local');

insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true),
  ('b1111111-1111-1111-1111-111111111111','b0000000-0000-0000-0000-00000000000b','管理者B','admin',true),
  ('b2222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-00000000000b','メンバーB','member',true);

insert into public.companies (id, organization_id, name, phone, location, owner_id) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','組織A企業1','03-1111-1111','東京都渋谷区','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','組織A企業2','03-2222-2222','大阪府大阪市','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-00000000000a','組織A企業3','03-3333-3333','愛知県名古屋市','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-00000000000a','組織A企業4','03-4444-4444','北海道札幌市','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000009','b0000000-0000-0000-0000-00000000000b','組織B企業1','090-9999-9999','福岡県福岡市',null);

-- 組織Aの管理者が組織A企業1を架電禁止に設定（他組織へ理由が漏れないことの確認用）
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(
  p_company_id := 'c0000000-0000-0000-0000-000000000001',
  p_phone := null, p_website_url := null, p_name := null, p_location := null,
  p_match_scope := 'phone', p_reason := '回帰テスト用の禁止理由（組織A限定）'
);
reset role;

-- ---------------------------------------------------------
-- アサーション 1-2: ビュー定義そのものの安全性（postgresセッションで確認）
-- ---------------------------------------------------------
do $$
declare
  v_reloptions text[];
  v_grant_cnt int;
begin
  select reloptions into v_reloptions from pg_class where relname = 'companies_with_call_status';
  if v_reloptions is null or not ('security_invoker=true' = any(v_reloptions)) then
    raise exception 'FAIL[1]: companies_with_call_status に security_invoker=true が設定されていません（reloptions=%）', v_reloptions;
  end if;
  if not ('security_barrier=true' = any(v_reloptions)) then
    raise exception 'FAIL[1]: companies_with_call_status に security_barrier=true が設定されていません（reloptions=%）', v_reloptions;
  end if;
  raise notice 'PASS[1]: security_invoker=true / security_barrier=true を確認';

  select count(*) into v_grant_cnt from information_schema.role_table_grants
    where table_name = 'companies_with_call_status' and grantee in ('anon','public');
  if v_grant_cnt <> 0 then
    raise exception 'FAIL[2]: companies_with_call_status に anon/public への権限が残っています（% 件）', v_grant_cnt;
  end if;
  select count(*) into v_grant_cnt from information_schema.role_table_grants
    where table_name = 'companies_with_call_status' and grantee = 'authenticated' and privilege_type = 'SELECT';
  if v_grant_cnt <> 1 then
    raise exception 'FAIL[2]: companies_with_call_status のauthenticated:SELECT権限が見つかりません';
  end if;
  select count(*) into v_grant_cnt from information_schema.role_table_grants
    where table_name = 'companies_with_call_status' and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if v_grant_cnt <> 0 then
    raise exception 'FAIL[2]: companies_with_call_status のauthenticatedにSELECT以外の権限が残っています（% 件）', v_grant_cnt;
  end if;
  raise notice 'PASS[2]: ビュー権限はauthenticated:SELECTのみ、anon/publicには権限なし';
end $$;

-- ---------------------------------------------------------
-- アサーション 3-6: 組織A・組織Bの相互分離（admin/member 双方）
-- ---------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_cnt int; v_wrong int;
begin
  select count(*), count(*) filter (where organization_id <> 'a0000000-0000-0000-0000-00000000000a')
    into v_cnt, v_wrong from public.companies_with_call_status;
  if v_cnt <> 4 then raise exception 'FAIL[3]: 組織A管理者に見える件数が4件ではありません（%件）', v_cnt; end if;
  if v_wrong <> 0 then raise exception 'FAIL[3]: 組織A管理者に他組織の行が見えています（%件）', v_wrong; end if;
  raise notice 'PASS[3]: 組織A管理者 → 4件、他組織行0件';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
declare v_cnt int; v_wrong int;
begin
  select count(*), count(*) filter (where organization_id <> 'a0000000-0000-0000-0000-00000000000a')
    into v_cnt, v_wrong from public.companies_with_call_status;
  if v_cnt <> 4 then raise exception 'FAIL[4]: 組織A一般メンバーに見える件数が4件ではありません（%件）', v_cnt; end if;
  if v_wrong <> 0 then raise exception 'FAIL[4]: 組織A一般メンバーに他組織の行が見えています（%件）', v_wrong; end if;
  raise notice 'PASS[4]: 組織A一般メンバー → 4件、他組織行0件';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'b1111111-1111-1111-1111-111111111111';
do $$
declare v_cnt int; v_wrong int; v_leak int;
begin
  select count(*), count(*) filter (where organization_id <> 'b0000000-0000-0000-0000-00000000000b')
    into v_cnt, v_wrong from public.companies_with_call_status;
  if v_cnt <> 1 then raise exception 'FAIL[5]: 組織B管理者に見える件数が1件ではありません（%件）', v_cnt; end if;
  if v_wrong <> 0 then raise exception 'FAIL[5]: 組織B管理者に他組織の行が見えています（%件）', v_wrong; end if;

  -- 組織Aで設定した架電禁止情報（blocklist_id / blocked_reason / call_prohibited）が
  -- 組織Bから一切見えないこと（漏洩の本丸）
  select count(*) into v_leak from public.companies_with_call_status
    where blocklist_id is not null or blocked_reason is not null or call_prohibited;
  if v_leak <> 0 then raise exception 'FAIL[5]: 組織Bから他組織の架電禁止情報が%件見えています', v_leak; end if;
  raise notice 'PASS[5]: 組織B管理者 → 1件、他組織行0件、他組織の禁止理由0件';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'b2222222-2222-2222-2222-222222222222';
do $$
declare v_cnt int; v_wrong int;
begin
  select count(*), count(*) filter (where organization_id <> 'b0000000-0000-0000-0000-00000000000b')
    into v_cnt, v_wrong from public.companies_with_call_status;
  if v_cnt <> 1 then raise exception 'FAIL[6]: 組織B一般メンバーに見える件数が1件ではありません（%件）', v_cnt; end if;
  if v_wrong <> 0 then raise exception 'FAIL[6]: 組織B一般メンバーに他組織の行が見えています（%件）', v_wrong; end if;
  raise notice 'PASS[6]: 組織B一般メンバー → 1件、他組織行0件';
end $$;
reset role;

-- ---------------------------------------------------------
-- アサーション 7: 組織Aから見て、ブロックした企業に正しく禁止情報が付いていること
-- （漏洩防止だけでなく、機能そのものが壊れていないことの確認）
-- ---------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_prohibited boolean; v_reason text;
begin
  select call_prohibited, blocked_reason into v_prohibited, v_reason
    from public.companies_with_call_status where id = 'c0000000-0000-0000-0000-000000000001';
  if v_prohibited is distinct from true then
    raise exception 'FAIL[7]: 組織A企業1がcall_prohibited=trueになっていません';
  end if;
  if v_reason <> '回帰テスト用の禁止理由（組織A限定）' then
    raise exception 'FAIL[7]: 組織A企業1のblocked_reasonが一致しません（%）', v_reason;
  end if;
  raise notice 'PASS[7]: 組織A自身からは正しく禁止情報が見える';
end $$;
reset role;

-- ---------------------------------------------------------
-- アサーション 8: anonはSELECT・関数実行いずれも拒否される
-- ---------------------------------------------------------
set role anon;
do $$
declare v_denied boolean := false;
begin
  begin
    perform 1 from public.companies_with_call_status limit 1;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL[8]: anonがcompanies_with_call_statusをSELECTできてしまいます';
  end if;
  raise notice 'PASS[8-1]: anonはcompanies_with_call_statusをSELECTできない';

  v_denied := false;
  begin
    perform * from public.match_active_blocklist('a0000000-0000-0000-0000-00000000000a','0311111111',null,null,null);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL[8]: anonがmatch_active_blocklist()を実行できてしまいます';
  end if;
  raise notice 'PASS[8-2]: anonはmatch_active_blocklist()を実行できない';

  v_denied := false;
  begin
    perform public.current_organization_id();
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL[8]: anonがcurrent_organization_id()を実行できてしまいます';
  end if;
  raise notice 'PASS[8-3]: anonはcurrent_organization_id()を実行できない';
end $$;
reset role;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
