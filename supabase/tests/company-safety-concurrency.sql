-- =========================================================
-- 企業安全管理: 同時実行（競合）テスト
--
-- organization advisory lockによる直列化が、実際に別々のDB接続（別トランザクション）
-- の間で機能していることを、dblink拡張を使って同一SQLスクリプト内から検証する。
-- （2つの実プロセスを別々に起動する代わりに、dblinkで2本目のDB接続を張り、
-- 非同期クエリで擬似的に「同時実行」を再現する）
--
-- 検証する競合パターン:
--   1. block_company_calls と create_company_checked の同時実行
--   2. block_company_calls と update_company_checked の同時実行
--   3. block_company_calls と create_companies_checked（CSV update）の同時実行
--   4. unblock_company_calls と update_company_checked の同時実行
--   5. record_call と block_company_calls の同時実行
--   6. unblock_company_calls と record_call の同時実行
--   7. 同一の新規識別子への同時登録（create_company_checked同士の競合）
--
-- いずれも「organization advisory lockが両方の操作を直列化するため、
-- 後から実行された側は、先に実行された側がコミットした後の最新状態を見て
-- 判定する」ことを、実際の結果値をpsql変数へ取り込みdo $$ ... $$ブロックで
-- 検証する（\echoによる説明だけに頼らない）。
--
-- 事前に supabase/tests/00-local-test-harness.sql（またはsupabase CLIの
-- ローカルスタックのようにauth.uid()等が標準提供される環境ではCI用の
-- ci-privileges-setup.sqlのみ）と、schema.sql または
-- （ベーススキーマ＋add-company-safety-stage-a.sql）を適用しておくこと。
-- ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
--
-- 【注意】このファイルはdblink拡張（Postgresの標準contrib）を使用する。
-- =========================================================

\set ON_ERROR_STOP on
create extension if not exists dblink;

insert into public.organizations (id, name) values ('a0000000-0000-0000-0000-00000000000a','テスト組織A');
insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@test.local');
insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true);
insert into public.companies (id, organization_id, name, phone, location, owner_id) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','競合テスト企業1','03-1111-1111','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','競合テスト企業2','03-2222-2222','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-00000000000a','競合テスト企業3','03-3333-3333','東京都','a1111111-1111-1111-1111-111111111111');

-- 2本の別接続を張る（同じDB・同じユーザーだが、advisory lockはセッション/トランザクション
-- ごとに独立するため、実際に別トランザクションとして競合させられる）
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());

\echo '=== 競合1: block_company_calls と create_company_checked の同時実行 ==='
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_a', 'begin');
select dblink_exec('conn_a', $$select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000001', p_match_scope:='phone', p_reason:='競合1テスト')$$);

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222'$$);
select dblink_send_query('conn_b', $$select public.create_company_checked(p_name:='競合1の新規登録', p_phone:='03-1111-1111', p_website_url:=null, p_location:='東京都')$$);

select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result jsonb) \gset r1_
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
begin
  if (:'r1_result')::jsonb->>'status' <> 'blocked' then
    raise exception 'FAIL[競合1]: block_company_callsコミット後にもかかわらずcreate_company_checkedがblockedになりませんでした（結果: %）', :'r1_result';
  end if;
  raise notice 'PASS[競合1]: organization lockにより直列化され、後発のcreateはblockedと正しく判定された';
end $$;

\echo '=== 競合2: block_company_calls と update_company_checked の同時実行 ==='
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_a', 'begin');
select dblink_exec('conn_a', $$select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000002', p_match_scope:='phone', p_reason:='競合2テスト')$$);

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_send_query('conn_b', $$select public.update_company_checked('c0000000-0000-0000-0000-000000000002'::uuid, '{"memo":"競合2更新試行"}'::jsonb, 'skip')$$);

select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result jsonb) \gset r2_
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
declare v_memo text;
begin
  if (:'r2_result')::jsonb->>'status' <> 'blocked' then
    raise exception 'FAIL[競合2]: update_company_checkedがblockedになりませんでした（結果: %）', :'r2_result';
  end if;
  select memo into v_memo from public.companies where id='c0000000-0000-0000-0000-000000000002';
  if v_memo = '競合2更新試行' then
    raise exception 'FAIL[競合2]: blockedにもかかわらずmemoが更新されてしまいました';
  end if;
  raise notice 'PASS[競合2]: 直列化により後発のupdateはblockedと正しく判定され、実データも更新されていない';
end $$;

\echo '=== 競合3: block_company_calls と create_companies_checked（CSV update）の同時実行 ==='
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_a', 'begin');
select dblink_exec('conn_a', $$select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000003', p_match_scope:='phone', p_reason:='競合3テスト')$$);

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_send_query('conn_b', $$select public.create_companies_checked('[{"name":"競合テスト企業3","phone":"03-3333-3333","location":"東京都","memo":"競合3更新試行"}]'::jsonb, 'update')$$);

select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result jsonb) \gset r3_
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
declare v_memo text; v_row jsonb;
begin
  v_row := (:'r3_result')::jsonb -> 'results' -> 0;
  if v_row->>'status' <> 'blocked' then
    raise exception 'FAIL[競合3]: CSV一括updateがblockedになりませんでした（結果: %）', :'r3_result';
  end if;
  select memo into v_memo from public.companies where id='c0000000-0000-0000-0000-000000000003';
  if v_memo = '競合3更新試行' then
    raise exception 'FAIL[競合3]: blockedにもかかわらずCSV一括updateでmemoが更新されてしまいました';
  end if;
  raise notice 'PASS[競合3]: CSV一括updateも直列化により禁止判定を回避できない';
end $$;

\echo '=== 競合4: unblock_company_calls と update_company_checked の同時実行 ==='
select bl.id as blocklist_id_1 from public.call_blocklist bl where bl.company_id='c0000000-0000-0000-0000-000000000001' and bl.active \gset
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_a', 'begin');
select dblink_exec('conn_a', format($$select public.unblock_company_calls('%s'::uuid, '競合4解除テスト')$$, :'blocklist_id_1'));

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_send_query('conn_b', $$select public.update_company_checked('c0000000-0000-0000-0000-000000000001'::uuid, '{"memo":"競合4更新試行"}'::jsonb, 'skip')$$);

select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result jsonb) \gset r4_
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
declare v_memo text;
begin
  if (:'r4_result')::jsonb->>'status' <> 'updated' then
    raise exception 'FAIL[競合4]: unblockコミット後のupdateがupdatedになりませんでした（結果: %）', :'r4_result';
  end if;
  select memo into v_memo from public.companies where id='c0000000-0000-0000-0000-000000000001';
  if v_memo <> '競合4更新試行' then
    raise exception 'FAIL[競合4]: unblock後のupdateが実データへ反映されていません';
  end if;
  raise notice 'PASS[競合4]: unblockが先にコミットされていれば、後発のupdateは正常に成功する';
end $$;

\echo '=== 競合5: record_call と block_company_calls の同時実行 ==='
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222'$$);
select dblink_exec('conn_a', 'begin');
select dblink_exec('conn_a', $$select public.record_call('c0000000-0000-0000-0000-000000000002'::uuid, '再架電'::text, '競合5架電テスト'::text)$$);

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_send_query('conn_b', $$select to_jsonb(public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000002', p_match_scope:='phone', p_reason:='競合5禁止テスト'))$$);

select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result jsonb) \gset r5_
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
declare v_log_cnt int; v_prohibited boolean;
begin
  if (:'r5_result')::jsonb->>'reason' <> '競合5禁止テスト' then
    raise exception 'FAIL[競合5]: block_company_callsが正しく完了しませんでした（結果: %）', :'r5_result';
  end if;
  select count(*) into v_log_cnt from public.call_logs where company_id='c0000000-0000-0000-0000-000000000002' and note='競合5架電テスト';
  if v_log_cnt <> 1 then
    raise exception 'FAIL[競合5]: record_callの架電記録が残っていません（デッドロック・データ不整合の可能性）';
  end if;
  select call_prohibited into v_prohibited from public.companies_with_call_status where id='c0000000-0000-0000-0000-000000000002';
  if not v_prohibited then
    raise exception 'FAIL[競合5]: blockがコミットされたにもかかわらずcall_prohibitedがtrueになっていません';
  end if;
  raise notice 'PASS[競合5]: record_callとblock_company_callsは直列化され、両方とも矛盾なく完了した（デッドロック無し）';
end $$;

\echo '=== 競合6: unblock_company_calls と record_call の同時実行 ==='
-- 企業2は競合5でブロック済み。それをunblockする側と、record_callを試みる側を競合させる。
select bl.id as blocklist_id_2 from public.call_blocklist bl where bl.company_id='c0000000-0000-0000-0000-000000000002' and bl.active \gset
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_a', 'begin');
select dblink_exec('conn_a', format($$select public.unblock_company_calls('%s'::uuid, '競合6解除テスト')$$, :'blocklist_id_2'));

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222'$$);
select dblink_send_query('conn_b', $$select public.record_call('c0000000-0000-0000-0000-000000000002'::uuid, '再架電'::text, '競合6架電テスト'::text)$$);

select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result uuid) \gset r6_
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
declare v_log_cnt int;
begin
  if :'r6_result' is null or :'r6_result' = '' then
    raise exception 'FAIL[競合6]: unblockコミット後のrecord_callが失敗しました';
  end if;
  select count(*) into v_log_cnt from public.call_logs where id = (:'r6_result')::uuid;
  if v_log_cnt <> 1 then raise exception 'FAIL[競合6]: record_callの架電記録が見つかりません'; end if;
  raise notice 'PASS[競合6]: unblockが先にコミットされていれば、後発のrecord_callは正常に成功する';
end $$;

\echo '=== 競合7: 同一の新規識別子への同時登録（create_company_checked同士の競合） ==='
select dblink_connect('conn_a', 'dbname=' || current_database());
select dblink_connect('conn_b', 'dbname=' || current_database());
select dblink_exec('conn_a', 'set role authenticated');
select dblink_exec('conn_a', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_a', 'begin');
select dblink_send_query('conn_a', $$select public.create_company_checked(p_name:='同時登録テストA', p_phone:='090-7777-8888', p_website_url:=null, p_location:='東京都')$$);

select dblink_exec('conn_b', 'set role authenticated');
select dblink_exec('conn_b', $$set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111'$$);
select dblink_exec('conn_b', 'begin');
select dblink_send_query('conn_b', $$select public.create_company_checked(p_name:='同時登録テストB', p_phone:='090-7777-8888', p_website_url:=null, p_location:='東京都')$$);

select result from dblink_get_result('conn_a') as t(result jsonb) \gset ra_
select dblink_exec('conn_a', 'commit');
select result from dblink_get_result('conn_b') as t(result jsonb) \gset rb_
select dblink_exec('conn_b', 'commit');
select dblink_disconnect('conn_a');
select dblink_disconnect('conn_b');
do $$
declare v_cnt int; v_statuses text[];
begin
  select count(*) into v_cnt from public.companies where phone='090-7777-8888';
  if v_cnt <> 1 then
    raise exception 'FAIL[競合7]: 同時登録の結果、企業が%件登録されています（1件のはず＝重複防止が機能していない）', v_cnt;
  end if;
  v_statuses := array[(:'ra_result')::jsonb->>'status', (:'rb_result')::jsonb->>'status'];
  if not (v_statuses @> array['inserted'] and v_statuses @> array['skipped']) then
    raise exception 'FAIL[競合7]: 期待される結果の組み合わせ（inserted 1件・skipped 1件）になっていません（A:%, B:%）', :'ra_result', :'rb_result';
  end if;
  raise notice 'PASS[競合7]: 同一識別子への同時登録は、片方だけがinsertedになりもう片方はskippedになる（重複防止が機能している）';
end $$;

\echo '=== ALL CONCURRENCY ASSERTIONS EXECUTED ==='
