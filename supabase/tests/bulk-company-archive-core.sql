-- =========================================================
-- 企業の一括アーカイブ（archive_companies）: コアロジックの回帰テスト
--
-- admin限定・active確認・組織分離・空配列拒否・上限500件・重複ID整理・
-- 冪等性（既アーカイブ企業混在）・全対象で同一archived_at・
-- call_logs/call_blocklistの維持・部分更新が起きないこと（原子性）・
-- SECURITY DEFINER + search_path=''・権限（authenticatedのみEXECUTE）を検証する。
--
-- 「本来失敗すべき操作」はbareなSQL文としては実行しない（ON_ERROR_STOP=1の
-- もとではスクリプト全体が停止してしまうため）。do $$ ... $$ ブロック内で
-- PERFORMし、期待通り例外が発生したことをexception when othersで捕捉する。
-- set role / reset role はPL/pgSQLブロック内では実行できないユーティリティ
-- コマンドのため、既存のcompany-safety-core.sqlと同じく必ずdoブロックの
-- 外側で実行する。
--
-- 事前に supabase/tests/00-local-test-harness.sql（またはCI用の
-- ci-privileges-setup.sqlのみ）と、schema.sql（企業の一括アーカイブを
-- 含む最新版）を適用しておくこと。
-- ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
-- トランザクション内で完結し最後にROLLBACKするため、何度でも再実行できる。
-- =========================================================

\set ON_ERROR_STOP on

begin;

insert into public.organizations (id, name) values
  ('a0000000-0000-0000-0000-00000000000a','一括アーカイブテスト組織A'),
  ('a0000000-0000-0000-0000-00000000000b','一括アーカイブテスト組織B');

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@bulk-archive.test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@bulk-archive.test.local'),
  ('a3333333-3333-3333-3333-333333333333','admin-b@bulk-archive.test.local'),
  ('a4444444-4444-4444-4444-444444444444','inactive-admin-a@bulk-archive.test.local');

insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true),
  ('a3333333-3333-3333-3333-333333333333','a0000000-0000-0000-0000-00000000000b','管理者B','admin',true),
  ('a4444444-4444-4444-4444-444444444444','a0000000-0000-0000-0000-00000000000a','利用停止管理者A','admin',false);

insert into public.companies (id, organization_id, name, phone, location, heat) values
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','一括対象企業1','03-2000-0001','東京都','低'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','一括対象企業2','03-2000-0002','東京都','低'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-00000000000a','履歴付き企業','03-2000-0003','大阪府','低'),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-00000000000a','重複ID整理テスト企業','03-2000-0005','愛知県','低'),
  ('b0000000-0000-0000-0000-000000000006','a0000000-0000-0000-0000-00000000000a','他組織混入テスト企業','03-2000-0006','福岡県','低'),
  ('b0000000-0000-0000-0000-000000000007','a0000000-0000-0000-0000-00000000000a','存在しないID混入テスト企業','03-2000-0007','北海道','低'),
  ('b0000000-0000-0000-0000-000000000009','a0000000-0000-0000-0000-00000000000b','組織B企業','090-2000-1001','沖縄県','低');

-- b...0004は最初からアーカイブ済み（冪等性テスト用フィクスチャ）
insert into public.companies (id, organization_id, name, phone, location, heat, archived_at, archived_by) values
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-00000000000a','既アーカイブ企業','03-2000-0004','東京都','低', now() - interval '1 day', 'a1111111-1111-1111-1111-111111111111');

-- 履歴付き企業に架電履歴と架電禁止設定を1件ずつ付け、一括アーカイブ後も消えないことを確認する
insert into public.call_logs (id, organization_id, company_id, caller_id, result, note) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','b0000000-0000-0000-0000-000000000003','a1111111-1111-1111-1111-111111111111','アポ獲得','T-fixture: 履歴付き企業の架電履歴');

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='b0000000-0000-0000-0000-000000000003', p_match_scope:='phone', p_reason:='T-fixture: 履歴付き企業のブロック確認用');
reset role;

\echo '=== T1: adminによる正常な一括アーカイブが成功し、全対象のarchived_atが同一である ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb; v_1 public.companies; v_2 public.companies;
begin
  v_result := public.archive_companies(array['b0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000002']::uuid[]);
  if (v_result->>'status') <> 'archived' then raise exception 'FAIL[T1]: statusがarchivedではありません（%）', v_result; end if;
  if (v_result->>'requested_count')::int <> 2 then raise exception 'FAIL[T1]: requested_countが2ではありません（%）', v_result; end if;
  if (v_result->>'archived_count')::int <> 2 then raise exception 'FAIL[T1]: archived_countが2ではありません（%）', v_result; end if;
  if (v_result->>'already_archived_count')::int <> 0 then raise exception 'FAIL[T1]: already_archived_countが0ではありません（%）', v_result; end if;

  select * into v_1 from public.companies where id='b0000000-0000-0000-0000-000000000001';
  select * into v_2 from public.companies where id='b0000000-0000-0000-0000-000000000002';
  if v_1.archived_at is null or v_2.archived_at is null then raise exception 'FAIL[T1]: archived_atが記録されていません'; end if;
  if v_1.archived_by <> 'a1111111-1111-1111-1111-111111111111' or v_2.archived_by <> 'a1111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL[T1]: archived_byが呼び出し元で記録されていません';
  end if;
  if v_1.updated_by <> 'a1111111-1111-1111-1111-111111111111' or v_2.updated_by <> 'a1111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL[T1]: updated_byが呼び出し元で記録されていません';
  end if;
  if v_1.archived_at <> v_2.archived_at then
    raise exception 'FAIL[T1/T11]: 一括アーカイブ対象のarchived_atが同一ではありません（%と%）', v_1.archived_at, v_2.archived_at;
  end if;
  raise notice 'PASS[T1・T11]: adminによる一括アーカイブが成功し、全対象のarchived_atが同一時刻で記録された';
end $$;
reset role;

\echo '=== T2: 一般メンバーはarchive_companies()を実行できない ==='
set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.archive_companies(array['b0000000-0000-0000-0000-000000000003']::uuid[]);
  raise exception 'FAIL[T2]: 一般メンバーによる一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T2]%' then raise; end if;
    if sqlerrm <> 'not_authorized' then raise exception 'FAIL[T2]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T2]: 一般メンバーによるarchive_companies()は not_authorized で拒否された';
end $$;
reset role;

\echo '=== T3: 利用停止中のadminはarchive_companies()を実行できない ==='
set role authenticated;
set request.jwt.claim.sub = 'a4444444-4444-4444-4444-444444444444';
do $$
begin
  perform public.archive_companies(array['b0000000-0000-0000-0000-000000000003']::uuid[]);
  raise exception 'FAIL[T3]: 利用停止中のadminによる一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T3]%' then raise; end if;
    if sqlerrm <> 'not_authorized' then raise exception 'FAIL[T3]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T3]: 利用停止中のadminによるarchive_companies()は not_authorized で拒否された';
end $$;
reset role;

\echo '=== T4: 未認証（auth.uid()がnull）ではnot_authenticatedで拒否される ==='
set role authenticated;
set request.jwt.claim.sub = '';
do $$
begin
  perform public.archive_companies(array['b0000000-0000-0000-0000-000000000003']::uuid[]);
  raise exception 'FAIL[T4]: 未認証での一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T4]%' then raise; end if;
    if sqlerrm <> 'not_authenticated' then raise exception 'FAIL[T4]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T4]: 未認証（auth.uid()がnull）はnot_authenticatedで拒否された';
end $$;
reset role;

do $$
declare v public.companies;
begin
  select * into v from public.companies where id='b0000000-0000-0000-0000-000000000003';
  if v.archived_at is not null then raise exception 'FAIL[T2-T4後確認]: 拒否されたはずの操作で履歴付き企業がアーカイブされています'; end if;
  raise notice 'PASS[T2-T4後確認]: 権限拒否・未認証拒否のいずれでも履歴付き企業は変更されなかった';
end $$;

\echo '=== T5: 他組織のIDが1件でも含まれる場合は全件拒否される（部分更新なし） ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.archive_companies(array['b0000000-0000-0000-0000-000000000006','b0000000-0000-0000-0000-000000000009']::uuid[]);
  raise exception 'FAIL[T5]: 他組織ID混入の一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T5]%' then raise; end if;
    if sqlerrm <> 'company_not_found_in_your_organization' then raise exception 'FAIL[T5]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T5]: 他組織ID混入は company_not_found_in_your_organization で全件拒否された';
end $$;
reset role;
do $$
declare v public.companies;
begin
  select * into v from public.companies where id='b0000000-0000-0000-0000-000000000006';
  if v.archived_at is not null then raise exception 'FAIL[T5-DB確認]: 拒否されたにもかかわらず自組織側の企業がアーカイブされています（部分更新が発生）'; end if;
  raise notice 'PASS[T5-DB確認]: 他組織ID混入で全件拒否された際、自組織側の対象も一切変更されない（部分更新なし）';
end $$;

\echo '=== T6: 存在しないIDが1件でも含まれる場合は全件拒否される（部分更新なし） ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.archive_companies(array['b0000000-0000-0000-0000-000000000007','ffffffff-ffff-ffff-ffff-ffffffffffff']::uuid[]);
  raise exception 'FAIL[T6]: 存在しないID混入の一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T6]%' then raise; end if;
    if sqlerrm <> 'company_not_found_in_your_organization' then raise exception 'FAIL[T6]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T6]: 存在しないID混入は company_not_found_in_your_organization で全件拒否された';
end $$;
reset role;
do $$
declare v public.companies;
begin
  select * into v from public.companies where id='b0000000-0000-0000-0000-000000000007';
  if v.archived_at is not null then raise exception 'FAIL[T6-DB確認]: 拒否されたにもかかわらず存在するIDの企業がアーカイブされています（部分更新が発生）'; end if;
  raise notice 'PASS[T6-DB確認]: 存在しないID混入で全件拒否された際、実在する対象も一切変更されない（部分更新なし）';
end $$;

\echo '=== T7: 空配列は company_ids_required で拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.archive_companies(array[]::uuid[]);
  raise exception 'FAIL[T7]: 空配列の一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T7]%' then raise; end if;
    if sqlerrm <> 'company_ids_required' then raise exception 'FAIL[T7]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T7]: 空配列は company_ids_required で拒否された';
end $$;

\echo '=== T7b: null要素のみの配列も company_ids_required で拒否される ==='
do $$
begin
  perform public.archive_companies(array[null,null]::uuid[]);
  raise exception 'FAIL[T7b]: null要素のみの配列での一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T7b]%' then raise; end if;
    if sqlerrm <> 'company_ids_required' then raise exception 'FAIL[T7b]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T7b]: null要素のみの配列は company_ids_required で拒否された';
end $$;
reset role;

\echo '=== T8: 500件を超えるIDは too_many_company_ids で拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_ids uuid[];
begin
  select array_agg(gen_random_uuid()) into v_ids from generate_series(1,501);
  perform public.archive_companies(v_ids);
  raise exception 'FAIL[T8]: 501件の一括アーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T8]%' then raise; end if;
    if sqlerrm <> 'too_many_company_ids' then raise exception 'FAIL[T8]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T8]: 501件（上限500件超過）は too_many_company_ids で拒否された';
end $$;
reset role;

\echo '=== T9: 重複したIDは内部で1件へ整理される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb;
begin
  v_result := public.archive_companies(array[
    'b0000000-0000-0000-0000-000000000005',
    'b0000000-0000-0000-0000-000000000005',
    'b0000000-0000-0000-0000-000000000005'
  ]::uuid[]);
  if (v_result->>'requested_count')::int <> 1 then raise exception 'FAIL[T9]: requested_countが重複整理後の1になっていません（%）', v_result; end if;
  if (v_result->>'archived_count')::int <> 1 then raise exception 'FAIL[T9]: archived_countが1ではありません（%）', v_result; end if;
  raise notice 'PASS[T9]: 同一IDを複数回渡しても内部で1件へ整理され、requested_count/archived_countともに1になる';
end $$;
reset role;

\echo '=== T10: 既にアーカイブ済みの企業が混在していてもエラーにならず、件数として冪等に処理される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb; v_row public.companies;
begin
  v_result := public.archive_companies(array[
    'b0000000-0000-0000-0000-000000000003',
    'b0000000-0000-0000-0000-000000000004'
  ]::uuid[]);
  if (v_result->>'status') <> 'archived' then raise exception 'FAIL[T10]: 既アーカイブ企業混在でエラーになりました（%）', v_result; end if;
  if (v_result->>'requested_count')::int <> 2 then raise exception 'FAIL[T10]: requested_countが2ではありません（%）', v_result; end if;
  if (v_result->>'archived_count')::int <> 1 then raise exception 'FAIL[T10]: archived_countが1ではありません（%）', v_result; end if;
  if (v_result->>'already_archived_count')::int <> 1 then raise exception 'FAIL[T10]: already_archived_countが1ではありません（%）', v_result; end if;

  select * into v_row from public.companies where id='b0000000-0000-0000-0000-000000000003';
  if v_row.archived_at is null then raise exception 'FAIL[T10-DB確認]: 履歴付き企業がアーカイブされていません'; end if;
  raise notice 'PASS[T10]: 既アーカイブ企業が混在していてもエラーにならず、archived_count/already_archived_countで正しく内訳を返す（冪等）';
end $$;
reset role;

\echo '=== T12: 一括アーカイブ後もcall_logsは削除・変更されない ==='
do $$
declare v_log_count int;
begin
  select count(*) into v_log_count from public.call_logs where id='c0000000-0000-0000-0000-000000000001';
  if v_log_count <> 1 then raise exception 'FAIL[T12]: 一括アーカイブ対象企業の架電履歴が消えています（件数=%）', v_log_count; end if;
  raise notice 'PASS[T12]: 一括アーカイブ後もcall_logsは維持される';
end $$;

\echo '=== T13: 一括アーカイブ後もcall_blocklistは削除・変更されない ==='
do $$
declare v_block_count int;
begin
  select count(*) into v_block_count from public.call_blocklist where company_id='b0000000-0000-0000-0000-000000000003' and active;
  if v_block_count <> 1 then raise exception 'FAIL[T13]: 一括アーカイブ対象企業の架電禁止設定が変化しています（件数=%）', v_block_count; end if;
  raise notice 'PASS[T13]: 一括アーカイブ後もcall_blocklistは維持される';
end $$;

\echo '=== T14: archive_companies()はSECURITY DEFINERかつsearch_path=''''でハードニングされている ==='
do $$
declare v_prosecdef boolean; v_cfg text[]; v_ok boolean;
begin
  select prosecdef, proconfig into v_prosecdef, v_cfg
    from pg_proc where proname='archive_companies' and pronamespace='public'::regnamespace;
  if not v_prosecdef then raise exception 'FAIL[T14]: archive_companies()がSECURITY DEFINERではありません'; end if;
  v_ok := v_cfg is not null and exists (
    select 1 from unnest(v_cfg) e
    where split_part(e, '=', 1) = 'search_path' and btrim(substring(e from position('=' in e) + 1), '"') = ''
  );
  if not v_ok then raise exception 'FAIL[T14]: archive_companies()のsearch_pathが空文字に固定されていません（proconfig: %）', v_cfg; end if;
  raise notice 'PASS[T14]: archive_companies()はSECURITY DEFINERかつsearch_path=''''でハードニングされている';
end $$;

\echo '=== T15: archive_companies()はauthenticatedのみEXECUTE可能で、anon/publicには付与されていない ==='
do $$
begin
  if not has_function_privilege('authenticated', 'public.archive_companies(uuid[])', 'execute') then
    raise exception 'FAIL[T15]: authenticatedがarchive_companies()を実行できません';
  end if;
  if has_function_privilege('anon', 'public.archive_companies(uuid[])', 'execute') then
    raise exception 'FAIL[T15]: anonがarchive_companies()を実行できてしまいます';
  end if;
  if has_function_privilege('public', 'public.archive_companies(uuid[])', 'execute') then
    raise exception 'FAIL[T15]: publicロールがarchive_companies()を実行できてしまいます';
  end if;
  raise notice 'PASS[T15]: archive_companies()はauthenticatedのみEXECUTE可能で、anon/publicには付与されていない';
end $$;

\echo '=== ALL BULK-COMPANY-ARCHIVE ASSERTIONS EXECUTED ==='

rollback;
