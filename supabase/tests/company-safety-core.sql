-- =========================================================
-- 企業安全管理: コアロジックの回帰テスト
--
-- match_scopeの厳密な適用、禁止先登録の迂回不可、不正なon_duplicateの拒否、
-- CSV一括更新での実効値による禁止判定（空欄入力での回避防止）、CSV一括登録の
-- 部分成功、call_logsへの他組織company_id・禁止企業への直接INSERT拒否、
-- 一般メンバーのblock/unblock拒否、call_blocklist_auditの直接改ざん拒否、
-- 架電履歴のある企業の削除拒否、unblockの冪等性、行エラーに生のPostgres
-- メッセージが含まれないこと、を検証する。
--
-- 「本来失敗すべき操作」は、bareなSQL文としては実行しない（ON_ERROR_STOP=1の
-- もとでは、そこでスクリプト全体が停止してしまうため）。代わりにdo $$ ... $$
-- ブロック内でPERFORMし、期待通り例外が発生したことをexception when others
-- 節で捕捉して確認する。これにより、このファイル全体を通してON_ERROR_STOP=1
-- を維持したまま、「失敗するはずの操作が実際には成功してしまった」という
-- 本当の不具合だけを検出してスクリプトを停止できる。
--
-- 事前に supabase/tests/00-local-test-harness.sql（またはsupabase CLIの
-- ローカルスタックのようにauth.uid()等が標準提供される環境ではCI用の
-- ci-privileges-setup.sqlのみ）と、schema.sql または
-- （ベーススキーマ＋add-company-safety-stage-a.sql）を適用しておくこと。
-- ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
-- トランザクション内で完結し最後にROLLBACKするため、何度でも再実行できる。
-- =========================================================

\set ON_ERROR_STOP on

begin;

insert into public.organizations (id, name) values
  ('a0000000-0000-0000-0000-00000000000a','テスト組織A'),
  ('b0000000-0000-0000-0000-00000000000b','テスト組織B');

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@test.local'),
  ('b1111111-1111-1111-1111-111111111111','admin-b@test.local');

insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true),
  ('b1111111-1111-1111-1111-111111111111','b0000000-0000-0000-0000-00000000000b','管理者B','admin',true);

insert into public.companies (id, organization_id, name, phone, website_url, location, owner_id) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','電話一致企業','03-1111-1111',null,'東京都渋谷区','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','ドメイン一致企業','03-2222-2222','https://domain-match.example.com','大阪府大阪市','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-00000000000a','企業名所在地一致企業','03-3333-3333',null,'愛知県名古屋市','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-00000000000a','企業名のみ一致企業','03-4444-4444',null,'北海道札幌市','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-00000000000b','組織B企業','090-9999-9999',null,'福岡県福岡市',null),
  ('c0000000-0000-0000-0000-000000000006','a0000000-0000-0000-0000-00000000000a','削除拒否確認企業','03-6666-6666',null,'東京都','a1111111-1111-1111-1111-111111111111');

\echo '=== T1: phoneスコープでブロックした企業は電話番号一致でのみヒットし、同じ電話番号を持たない他企業には波及しない ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000001', p_match_scope:='phone', p_reason:='T1電話番号一致テスト');
reset role;
do $$
declare v_hit record; v_none record;
begin
  select * into v_hit from public.match_active_blocklist('a0000000-0000-0000-0000-00000000000a','0311111111',null,null,null);
  if v_hit.blocklist_id is null then raise exception 'FAIL[T1]: 電話番号一致でヒットしませんでした'; end if;
  select * into v_none from public.match_active_blocklist('a0000000-0000-0000-0000-00000000000a',null,'domain-match.example.com',null,null);
  if v_none.blocklist_id is not null then raise exception 'FAIL[T1]: phoneスコープの行がdomain照合にも波及しています'; end if;
  raise notice 'PASS[T1]: phoneスコープはドメイン一致に波及しない';
end $$;

\echo '=== T2: domainスコープでブロックした企業はドメイン一致でのみヒットし、電話番号一致に波及しない ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000002', p_match_scope:='domain', p_reason:='T2ドメイン一致テスト');
reset role;
do $$
declare v_hit record; v_none record;
begin
  select * into v_hit from public.match_active_blocklist('a0000000-0000-0000-0000-00000000000a',null,'domain-match.example.com',null,null);
  if v_hit.blocklist_id is null then raise exception 'FAIL[T2]: ドメイン一致でヒットしませんでした'; end if;
  select * into v_none from public.match_active_blocklist('a0000000-0000-0000-0000-00000000000a','0322222222',null,null,null);
  if v_none.blocklist_id is not null then raise exception 'FAIL[T2]: domainスコープの行が電話番号照合にも波及しています'; end if;
  raise notice 'PASS[T2]: domainスコープは電話番号一致に波及しない';
end $$;

\echo '=== T3: name_onlyは明示的に選んだ場合だけ機能し、通常のcheck時の企業名+所在地一致とは独立して働く ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000004', p_match_scope:='name_only', p_reason:='T3企業名のみ一致テスト');
reset role;
do $$
declare v_hit record;
begin
  select * into v_hit from public.match_active_blocklist('a0000000-0000-0000-0000-00000000000a',null,null,public.normalize_company_name('企業名のみ一致企業'),public.normalize_location('別の所在地'));
  if v_hit.blocklist_id is null or v_hit.matched_scope <> 'name_only' then raise exception 'FAIL[T3]: name_onlyスコープが機能していません'; end if;
  raise notice 'PASS[T3]: name_onlyは所在地が異なっても企業名だけで一致する（設計どおり）';
end $$;

\echo '=== T4: 電話番号が空の企業をphoneスコープで禁止しようとするとエラーになる（迂回を許さない） ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
insert into public.companies (id, organization_id, name, phone, location) values
  ('c0000000-0000-0000-0000-000000000009','a0000000-0000-0000-0000-00000000000a','電話番号なし企業','','東京都');
do $$
begin
  perform public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000009', p_match_scope:='phone', p_reason:='電話番号なしテスト');
  raise exception 'FAIL[T4]: 電話番号が空の企業がphoneスコープで禁止できてしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T4]%' then raise; end if;
    raise notice 'PASS[T4]: 電話番号が空の企業はphoneスコープで禁止できない（%）', sqlerrm;
end $$;
reset role;

\echo '=== T5: call_blocklist_scope_columns制約により、phoneスコープの行にdomain等の余計な列は入らない ==='
do $$
declare v_row public.call_blocklist;
begin
  select * into v_row from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000001' and match_scope='phone';
  if v_row.normalized_domain is not null or v_row.normalized_name is not null or v_row.normalized_location is not null then
    raise exception 'FAIL[T5]: phoneスコープの行に余計な正規化キーが保存されています';
  end if;
  if v_row.normalized_phone is null then raise exception 'FAIL[T5]: phoneスコープの行にnormalized_phoneがありません'; end if;
  raise notice 'PASS[T5]: phoneスコープの行はnormalized_phoneだけを保持している';
end $$;

\echo '=== T6: strictスコープは利用可能な強一致キーをすべて保存する ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000003', p_match_scope:='strict', p_reason:='T6強一致テスト');
reset role;
do $$
declare v_row public.call_blocklist;
begin
  select * into v_row from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000003' and match_scope='strict';
  if v_row.normalized_phone is null then raise exception 'FAIL[T6]: strictスコープにnormalized_phoneが保存されていません'; end if;
  if v_row.normalized_name is null or v_row.normalized_location is null then raise exception 'FAIL[T6]: strictスコープにnormalized_name/locationが保存されていません'; end if;
  raise notice 'PASS[T6]: strictスコープは利用可能な強一致キーをすべて保存している';
end $$;

\echo '=== T7: create_company_checkedは禁止先に一致した企業を、いかなる引数によっても登録できない ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.create_company_checked(
  p_name:='電話一致企業（別表記）', p_phone:='03-1111-1111', p_website_url:=null, p_location:='東京都渋谷区'
);
reset role;
do $$
declare v_cnt int;
begin
  select count(*) into v_cnt from public.companies where phone='03-1111-1111';
  if v_cnt <> 1 then raise exception 'FAIL[T7]: 禁止先の企業が登録されてしまいました（%件）', v_cnt; end if;
  raise notice 'PASS[T7]: 禁止先一致企業は登録されない（迂回引数なし）';
end $$;

\echo '=== T8: create_company_checkedは不正なon_duplicateを拒否する ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.create_company_checked(
    p_name:='不正duplicateモードテスト', p_phone:='090-0000-1111', p_website_url:=null, p_location:='テスト所在地',
    p_on_duplicate:='not_a_real_mode'
  );
  raise exception 'FAIL[T8]: 不正なon_duplicateが受理されてしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T8]%' then raise; end if;
    raise notice 'PASS[T8]: 不正なon_duplicateは拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T9: create_companies_checkedは行ごとに不正なon_duplicateをinsertせずエラーにする ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select * from public.create_companies_checked(
  p_rows := $j$[{"name":"不正モード行テスト","phone":"090-2222-3333","location":"テスト","on_duplicate":"delete_everything"}]$j$::jsonb
);
reset role;
do $$
declare v_cnt int;
begin
  select count(*) into v_cnt from public.companies where phone='090-2222-3333';
  if v_cnt <> 0 then raise exception 'FAIL[T9]: 不正なon_duplicateの行が登録されてしまいました'; end if;
  raise notice 'PASS[T9]: 不正なon_duplicateの行はinsertされずエラーになる';
end $$;

\echo '=== T10: create_companies_checkedのCSV更新は、空欄入力で既存の禁止一致キーを外して更新を回避できない ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select * from public.create_companies_checked(
  p_rows := $j$[{"name":"電話一致企業","phone":"","location":"東京都渋谷区","memo":"回避試行"}]$j$::jsonb,
  p_default_on_duplicate := 'update'
);
reset role;
do $$
declare v_memo text;
begin
  select memo into v_memo from public.companies where id='c0000000-0000-0000-0000-000000000001';
  if v_memo = '回避試行' then raise exception 'FAIL[T10]: 空欄入力による禁止判定の回避を許してしまいました'; end if;
  raise notice 'PASS[T10]: 空欄入力では既存の禁止一致キーを外せない（実効値で判定される）';
end $$;

\echo '=== T11: call_logsへ他組織のcompany_idを直接INSERTすると拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  insert into public.call_logs(organization_id, company_id, caller_id, result, note)
  values ('a0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-000000000005','a1111111-1111-1111-1111-111111111111','再架電','他組織企業への直接insert試行');
  raise exception 'FAIL[T11]: 他組織企業へのcall_logs直接insertが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T11]%' then raise; end if;
    raise notice 'PASS[T11]: 他組織企業へのcall_logs直接insertは拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T12: FK RESTRICTにより、他組織企業のcompany_id詐称を使ったcall_logs挿入は、企業削除の妨害にも利用できない ==='
do $$
declare v_cnt int;
begin
  select count(*) into v_cnt from public.call_logs where company_id='c0000000-0000-0000-0000-000000000005';
  if v_cnt <> 0 then raise exception 'FAIL[T12]: 他組織企業への call_logs 参照行が作られてしまいました'; end if;
  raise notice 'PASS[T12]: 他組織企業への call_logs 参照行は作られていない';
end $$;

\echo '=== T13: unblock_company_callsは同じblocklist_idを2回解除しても技術エラーにならない（冪等） ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select bl.id as target_id from public.call_blocklist bl where bl.company_id='c0000000-0000-0000-0000-000000000002' and bl.active \gset
select * from public.unblock_company_calls(:'target_id', '1回目の解除');
select * from public.unblock_company_calls(:'target_id', '2回目の解除（冪等性確認）');
reset role;
do $$
begin
  raise notice 'PASS[T13]: 2回目のunblockもエラーにならなかった';
end $$;

\echo '=== T14: 行エラーの結果にPostgresの生メッセージ（制約名等）が含まれない ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.create_companies_checked(
  p_rows := $j$[{"name":"重複キー衝突テスト1","phone":"070-5555-5555","location":"テスト"},{"name":"重複キー衝突テスト1","phone":"070-5555-5555","location":"テスト"}]$j$::jsonb
) as t14_result \gset
reset role;
do $$
declare v_row jsonb;
begin
  v_row := (:'t14_result')::jsonb -> 'results' -> 1;
  if v_row->>'status' <> 'skipped' or v_row->>'reason' <> 'duplicate_within_csv' then
    raise exception 'FAIL[T14]: 2行目がduplicate_within_csvとして処理されませんでした（結果: %）', v_row;
  end if;
  if (:'t14_result') like '%constraint%' or (:'t14_result') like '%duplicate key value violates%' then
    raise exception 'FAIL[T14]: 行エラーの結果にPostgresの生メッセージが含まれています';
  end if;
  raise notice 'PASS[T14]: 行エラーの結果に生のPostgresメッセージは含まれていない';
end $$;

\echo '=== T15: 一般メンバーはblock_company_calls / unblock_company_callsを実行できない ==='
set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000006', p_match_scope:='phone', p_reason:='一般メンバーによる禁止試行');
  raise exception 'FAIL[T15]: 一般メンバーがblock_company_callsを実行できてしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T15]%' then raise; end if;
    raise notice 'PASS[T15-block]: 一般メンバーはblock_company_callsを実行できない（%）', sqlerrm;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000006', p_match_scope:='phone', p_reason:='T15管理者による禁止（正常系）');
reset role;

set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
do $$
declare v_id uuid;
begin
  select bl.id into v_id from public.call_blocklist bl where bl.company_id='c0000000-0000-0000-0000-000000000006' and bl.active;
  perform public.unblock_company_calls(v_id, '一般メンバーによる解除試行');
  raise exception 'FAIL[T15]: 一般メンバーがunblock_company_callsを実行できてしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T15]%' then raise; end if;
    raise notice 'PASS[T15-unblock]: 一般メンバーはunblock_company_callsを実行できない（%）', sqlerrm;
end $$;
reset role;

\echo '=== T16: call_blocklist_auditへの直接INSERT/UPDATE/DELETEは拒否される（追記はRPC内部からのみ） ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  insert into public.call_blocklist_audit(organization_id, blocklist_id, action, reason, actor_id)
  values ('a0000000-0000-0000-0000-00000000000a', (select id from public.call_blocklist limit 1), 'blocked', '直接insert試行', 'a1111111-1111-1111-1111-111111111111');
  raise exception 'FAIL[T16]: call_blocklist_auditへの直接insertが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T16]%' then raise; end if;
    raise notice 'PASS[T16]: call_blocklist_auditへの直接insertは拒否される（%）', sqlerrm;
end $$;
reset role;

\echo '=== T17: 架電履歴のある企業は削除できない（FK RESTRICT） ==='
-- 企業6は既にT15で禁止済みのため、先に解除してから架電記録を作る
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select bl.id as t17_block_id from public.call_blocklist bl where bl.company_id='c0000000-0000-0000-0000-000000000006' and bl.active \gset
select public.unblock_company_calls(:'t17_block_id', 'T17架電履歴作成のため解除');
reset role;
set role authenticated;
set request.jwt.claim.sub = 'a2222222-2222-2222-2222-222222222222';
select public.record_call('c0000000-0000-0000-0000-000000000006','再架電','T17架電履歴作成用');
reset role;
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
do $$
begin
  delete from public.companies where id='c0000000-0000-0000-0000-000000000006';
  raise exception 'FAIL[T17]: 架電履歴のある企業が削除できてしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T17]%' then raise; end if;
    raise notice 'PASS[T17]: 架電履歴のある企業はFK RESTRICTにより削除できない（%）', sqlerrm;
end $$;
reset role;

\echo '=== T18: create_companies_checkedはCSV一括登録で新規・重複スキップ・エラーが混在しても部分成功する ==='
set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-1111-1111-111111111111';
select public.create_companies_checked(
  p_rows := $j$[
    {"name":"T18新規企業","phone":"050-1000-0001","location":"北海道札幌市"},
    {"name":"T18新規企業複製","phone":"050-1000-0001","location":"北海道札幌市"},
    {"name":"","phone":"050-9999-0000","location":"沖縄県那覇市"},
    {"name":"T18企業名所在地一致企業","phone":"","location":"愛知県名古屋市"}
  ]$j$::jsonb
) as t18_result \gset
reset role;
do $$
declare v_r jsonb;
begin
  v_r := (:'t18_result')::jsonb -> 'results' -> 0;
  if v_r->>'status' <> 'inserted' then raise exception 'FAIL[T18]: 1行目(新規)がinsertedになりませんでした（%）', v_r; end if;
  v_r := (:'t18_result')::jsonb -> 'results' -> 1;
  if v_r->>'status' <> 'skipped' or v_r->>'reason' <> 'duplicate_within_csv' then raise exception 'FAIL[T18]: 2行目(CSV内重複)が正しく処理されませんでした（%）', v_r; end if;
  v_r := (:'t18_result')::jsonb -> 'results' -> 2;
  if v_r->>'status' <> 'error' or v_r->>'error_code' <> 'name_required' then raise exception 'FAIL[T18]: 3行目(企業名なし)がエラーになりませんでした（%）', v_r; end if;
  v_r := (:'t18_result')::jsonb -> 'results' -> 3;
  if v_r->>'status' <> 'skipped' then raise exception 'FAIL[T18]: 4行目(既存企業名+所在地一致)がスキップされませんでした（%）', v_r; end if;
  raise notice 'PASS[T18]: CSV一括登録は新規・重複スキップ・エラー混在でも部分成功する';
end $$;
do $$
declare v_cnt int;
begin
  select count(*) into v_cnt from public.companies where phone='050-1000-0001';
  if v_cnt <> 1 then raise exception 'FAIL[T18]: 新規企業が%件登録されています（1件のはず）', v_cnt; end if;
  raise notice 'PASS[T18-DB確認]: 実際にDBへ反映された件数も一致している';
end $$;

\echo '=== T19: create_companies_checkedはトランザクション致命的エラーを行エラーとして握りつぶさない（静的確認） ==='
do $$
declare v_def text;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname='create_companies_checked';
  if v_def !~ 'when\s+deadlock_detected\s+or\s+lock_not_available\s+or\s+query_canceled\s+or\s+serialization_failure\s+then\s+raise;' then
    raise exception 'FAIL[T19]: create_companies_checked()にdeadlock/lock/timeout/serialization系エラーの再送出節が見当たりません';
  end if;
  raise notice 'PASS[T19]: トランザクション致命的エラーの再送出節が関数定義に存在する';
end $$;

\echo '=== ALL CORE ASSERTIONS EXECUTED ==='

rollback;
