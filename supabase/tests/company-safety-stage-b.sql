-- =========================================================
-- 企業安全管理: 段階B（harden-company-writes-stage-b.sql）の適用・ロールバックテスト
--
-- 【重要】このテストはローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
-- 段階Bは、承認された範囲では「作成のみ・本番未適用」。このテストファイルの実行も
-- 隔離環境限定であり、本番への段階B適用を意味しない。
--
-- 前提: schema.sql または（ベーススキーマ＋add-company-safety-stage-a.sql）を
-- 適用済みの隔離データベースに対して実行すること（このファイル自身が段階Bの
-- 適用・ロールバックを内部の\iコマンドで行う）。
--
-- 検証項目:
--   1. 段階A適用後（段階B適用前）はrecord_callが成功する
--   2. 段階B適用後もrecord_callが成功する（record_call()がSECURITY DEFINERへ
--      変更されているため、companiesのUPDATE権限が無くても動作する）
--   3. 段階B適用後、companiesへの直接INSERTが拒否される
--   4. 段階B適用後、companiesへの直接UPDATEが拒否される
--   5. 段階B適用後もcreate_company_checked等の確認済みRPCは成功する
--   6. 段階B適用後も、他組織企業へのrecord_callは拒否される
--   7. 段階B適用後も、inactiveユーザーのrecord_callは拒否される
--   8. 段階B適用後も、禁止企業へのrecord_callは拒否される
--   9. 段階Bロールバック後、companiesへの直接INSERT/UPDATEが復元され、
--      record_call()がSECURITY INVOKERへ戻る
--  10. ロールバック後、段階Bを再適用しても正常に完了する
--
-- 「本来失敗すべき操作」はdo $$ ... $$ブロック内でPERFORMし、
-- exception when othersで捕捉して確認する（ON_ERROR_STOP=1のまま
-- スクリプト全体を通せるようにするため）。
--
-- このファイルはDDL権限変更（段階Bそのもの）を含むためトランザクションで
-- 囲えない。実行前後で必ずデータベース自体を隔離環境専用の使い捨てにすること。
-- =========================================================

\set ON_ERROR_STOP on

insert into public.organizations (id, name) values
  ('a0000000-0000-0000-0000-00000000000a','テスト組織A'),
  ('b0000000-0000-0000-0000-00000000000b','テスト組織B');

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@test.local'),
  ('a3333333-3333-3333-3333-333333333333','inactive-a@test.local'),
  ('b1111111-1111-1111-1111-111111111111','admin-b@test.local');

insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true),
  ('a3333333-3333-3333-3333-333333333333','a0000000-0000-0000-0000-00000000000a','無効化メンバー','member',false),
  ('b1111111-1111-1111-1111-111111111111','b0000000-0000-0000-0000-00000000000b','管理者B','admin',true);

insert into public.companies (id, organization_id, name, phone, location, owner_id) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','組織A企業1','03-1111-1111','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','組織A企業2','03-2222-2222','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000009','b0000000-0000-0000-0000-00000000000b','組織B企業','090-9999-9999','福岡県',null);

\echo '=== T1: 段階A適用後（段階B適用前）、record_callが成功する ==='
set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.record_call('c0000000-0000-0000-0000-000000000001', '再架電', '段階B適用前テスト');
  raise notice 'PASS[T1]: 段階B適用前のrecord_callは成功する';
end $$;
reset role;

\echo '=== 段階Bを適用 ==='
\i supabase/harden-company-writes-stage-b.sql

\echo '=== T2: 段階B適用後もrecord_callが成功する（SECURITY DEFINER化により） ==='
set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.record_call('c0000000-0000-0000-0000-000000000002', '再架電', '段階B適用後テスト');
  raise notice 'PASS[T2]: 段階B適用後もrecord_callは成功する（record_call()のSECURITY DEFINER化が機能している）';
end $$;
reset role;

\echo '=== T3: 段階B適用後、companiesへの直接INSERTが拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  insert into public.companies(organization_id, name, phone, location) values ('a0000000-0000-0000-0000-00000000000a','直接insert試行','000','テスト');
  raise exception 'FAIL[T3]: 段階B適用後もcompaniesへの直接insertが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T3]%' then raise; end if;
    raise notice 'PASS[T3]: 段階B適用後はcompaniesへの直接insertが拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T4: 段階B適用後、companiesへの直接UPDATEが拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  update public.companies set memo='直接update試行' where id='c0000000-0000-0000-0000-000000000001';
  raise exception 'FAIL[T4]: 段階B適用後もcompaniesへの直接updateが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T4]%' then raise; end if;
    raise notice 'PASS[T4]: 段階B適用後はcompaniesへの直接updateが拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T5: 段階B適用後もcreate_company_checked()は成功する ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb;
begin
  select public.create_company_checked(
    p_name:='段階B後のRPC経由登録', p_phone:='080-1234-5678', p_website_url:=null, p_location:='テスト所在地'
  ) into v_result;
  if v_result->>'status' <> 'inserted' then
    raise exception 'FAIL[T5]: 段階B適用後にcreate_company_checkedが失敗しました（結果: %）', v_result;
  end if;
  raise notice 'PASS[T5]: 段階B適用後も確認済みRPC経由の登録は成功する';
end $$;

\echo '=== T6: 段階B適用後も、他組織企業へのrecord_callは拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.record_call('c0000000-0000-0000-0000-000000000009', '再架電', '他組織企業テスト');
  raise exception 'FAIL[T6]: 他組織企業へのrecord_callが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T6]%' then raise; end if;
    raise notice 'PASS[T6]: 他組織企業へのrecord_callは拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T7: 段階B適用後も、inactiveユーザーのrecord_callは拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a3333333-3333-3333-3333-333333333333';
do $$
begin
  perform public.record_call('c0000000-0000-0000-0000-000000000001', '再架電', '無効化ユーザーテスト');
  raise exception 'FAIL[T7]: inactiveユーザーのrecord_callが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T7]%' then raise; end if;
    raise notice 'PASS[T7]: inactiveユーザーのrecord_callは拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T8: 段階B適用後も、禁止企業へのrecord_callは拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000001', p_match_scope:='phone', p_reason:='段階Bテスト用禁止');
reset role;
set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.record_call('c0000000-0000-0000-0000-000000000001', '再架電', '禁止企業テスト');
  raise exception 'FAIL[T8]: 禁止企業へのrecord_callが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T8]%' then raise; end if;
    raise notice 'PASS[T8]: 禁止企業へのrecord_callは拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== 段階Bをロールバック ==='
\i supabase/rollback-harden-company-writes-stage-b.sql

\echo '=== T9: ロールバック後、companiesへの直接INSERT/UPDATEが復元される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
insert into public.companies(organization_id, name, phone, location) values ('a0000000-0000-0000-0000-00000000000a','ロールバック後直接insert','000','テスト') returning id;
update public.companies set memo='ロールバック後直接update' where id='c0000000-0000-0000-0000-000000000002';
reset role;
do $$
declare v_memo text;
begin
  select memo into v_memo from public.companies where id='c0000000-0000-0000-0000-000000000002';
  if v_memo <> 'ロールバック後直接update' then raise exception 'FAIL[T9]: ロールバック後もcompaniesへの直接updateが機能していません'; end if;
  raise notice 'PASS[T9]: ロールバック後、companiesへの直接INSERT/UPDATEが復元されている';
end $$;

\echo '=== T10: ロールバック後、record_call()がSECURITY INVOKERへ戻っている ==='
do $$
declare v_secdef boolean;
begin
  select prosecdef into v_secdef from pg_proc where proname='record_call';
  if v_secdef then raise exception 'FAIL[T10]: ロールバック後もrecord_call()がSECURITY DEFINERのままです'; end if;
  raise notice 'PASS[T10]: ロールバック後、record_call()はSECURITY INVOKERへ戻っている';
end $$;

\echo '=== T11: ロールバック後、段階Bを再適用しても正常に完了する ==='
\i supabase/harden-company-writes-stage-b.sql
do $$
declare v_secdef boolean;
begin
  select prosecdef into v_secdef from pg_proc where proname='record_call';
  if not v_secdef then raise exception 'FAIL[T11]: 段階B再適用後もrecord_call()がSECURITY DEFINERになっていません'; end if;
  raise notice 'PASS[T11]: 段階Bはロールバック後に再適用しても正常に完了する';
end $$;

\echo '=== ALL STAGE-B ASSERTIONS EXECUTED ==='
