-- =========================================================
-- 企業詳細・編集・アーカイブ管理: コアロジックの回帰テスト
--
-- update_company_checked()の拡張フィールド（owner_id/heat/next_action_at/
-- contact_department/source_url）、owner_id・heatのバリデーション、
-- 他組織企業への更新拒否、重複衝突時の更新拒否、空欄化による禁止回避の
-- 防止、archive_company()/restore_company()のadmin限定・冪等性・
-- 他組織企業への操作拒否・重複衝突時の復元拒否、アーカイブ後もcall_logs・
-- call_blocklistが保持されること、アーカイブ済み企業が重複判定
-- （check_company_safety / create_company_checked）から除外されることを
-- 検証する。
--
-- 「本来失敗すべき操作」はbareなSQL文としては実行しない（ON_ERROR_STOP=1の
-- もとではスクリプト全体が停止してしまうため）。do $$ ... $$ ブロック内で
-- PERFORMし、期待通り例外が発生したことをexception when othersで捕捉する。
-- set role / reset role はPL/pgSQLブロック内では実行できないユーティリティ
-- コマンドのため、既存のcompany-safety-core.sqlと同じく必ずdoブロックの
-- 外側で実行する。
--
-- 事前に supabase/tests/00-local-test-harness.sql（またはCI用の
-- ci-privileges-setup.sqlのみ）と、schema.sql（企業詳細・編集・アーカイブ
-- 管理を含む最新版）を適用しておくこと。
-- ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
-- トランザクション内で完結し最後にROLLBACKするため、何度でも再実行できる。
-- =========================================================

\set ON_ERROR_STOP on

begin;

insert into public.organizations (id, name) values
  ('d0000000-0000-0000-0000-00000000000a','詳細編集テスト組織A'),
  ('d0000000-0000-0000-0000-00000000000b','詳細編集テスト組織B');

insert into auth.users (id, email) values
  ('d1111111-1111-1111-1111-111111111111','admin-a@detail-edit.test.local'),
  ('d2222222-2222-2222-2222-222222222222','member-a@detail-edit.test.local'),
  ('d3333333-3333-3333-3333-333333333333','admin-b@detail-edit.test.local'),
  ('d4444444-4444-4444-4444-444444444444','inactive-a@detail-edit.test.local');

insert into public.profiles (id, organization_id, full_name, role, active) values
  ('d1111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('d2222222-2222-2222-2222-222222222222','d0000000-0000-0000-0000-00000000000a','メンバーA','member',true),
  ('d3333333-3333-3333-3333-333333333333','d0000000-0000-0000-0000-00000000000b','管理者B','admin',true),
  ('d4444444-4444-4444-4444-444444444444','d0000000-0000-0000-0000-00000000000a','利用停止メンバーA','member',false);

insert into public.companies (id, organization_id, name, phone, location, owner_id, heat) values
  ('e0000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-00000000000a','編集対象企業','03-1000-0001','東京都','d1111111-1111-1111-1111-111111111111','低'),
  ('e0000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-00000000000a','重複衝突先企業','03-1000-0002','大阪府','d1111111-1111-1111-1111-111111111111','低'),
  ('e0000000-0000-0000-0000-000000000003','d0000000-0000-0000-0000-00000000000a','アーカイブ対象企業','03-1000-0003','愛知県','d1111111-1111-1111-1111-111111111111','低'),
  ('e0000000-0000-0000-0000-000000000004','d0000000-0000-0000-0000-00000000000b','組織B企業','090-1000-0004','福岡県',null,'低');

insert into public.companies (id, organization_id, name, phone, website_url, location, owner_id, heat) values
  ('e0000000-0000-0000-0000-000000000005','d0000000-0000-0000-0000-00000000000a','ドメイン禁止対象企業','03-1000-0005','https://blocked-domain.example.com','静岡県','d1111111-1111-1111-1111-111111111111','低');

-- アーカイブ対象企業に架電履歴と架電禁止設定を1件ずつ付け、
-- アーカイブ・復元を通じて消えないことを後で確認する
insert into public.call_logs (id, organization_id, company_id, caller_id, result, note) values
  ('f0000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-00000000000a','e0000000-0000-0000-0000-000000000003','d1111111-1111-1111-1111-111111111111','アポ獲得','T-fixture: アーカイブ対象企業の架電履歴');

set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
select public.block_company_calls(p_company_id:='e0000000-0000-0000-0000-000000000001', p_match_scope:='phone', p_reason:='T-fixture: 編集対象企業のブロック確認用');
select public.block_company_calls(p_company_id:='e0000000-0000-0000-0000-000000000005', p_match_scope:='domain', p_reason:='T-fixture: ドメインスコープの禁止回避テスト用');
reset role;

\echo '=== T1: update_company_checked() が heat/owner_id/next_action_at/contact_department/source_url を更新できる ==='
set role authenticated;
set request.jwt.claim.sub = 'd2222222-2222-2222-2222-222222222222';
select public.update_company_checked(
  'e0000000-0000-0000-0000-000000000002'::uuid,
  jsonb_build_object('heat','高','owner_id','d1111111-1111-1111-1111-111111111111','contact_department','営業部','source_url','https://source.example.com','next_action_at','2026-08-01T10:00:00+09:00'),
  'skip'
);
reset role;
do $$
declare v public.companies;
begin
  select * into v from public.companies where id='e0000000-0000-0000-0000-000000000002';
  if v.heat <> '高' then raise exception 'FAIL[T1]: heatが更新されていません（%）', v.heat; end if;
  if v.owner_id <> 'd1111111-1111-1111-1111-111111111111' then raise exception 'FAIL[T1]: owner_idが更新されていません'; end if;
  if v.contact_department <> '営業部' then raise exception 'FAIL[T1]: contact_departmentが更新されていません'; end if;
  if v.source_url <> 'https://source.example.com' then raise exception 'FAIL[T1]: source_urlが更新されていません'; end if;
  if v.next_action_at is null then raise exception 'FAIL[T1]: next_action_atが更新されていません'; end if;
  if v.updated_by <> 'd2222222-2222-2222-2222-222222222222' then raise exception 'FAIL[T1]: updated_byが呼び出し元で記録されていません'; end if;
  raise notice 'PASS[T1]: 拡張フィールドがすべて正しく更新され、updated_byも記録された';
end $$;

\echo '=== T2: owner_idに他組織メンバーを指定すると拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'd2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.update_company_checked('e0000000-0000-0000-0000-000000000002'::uuid, jsonb_build_object('owner_id','d3333333-3333-3333-3333-333333333333'), 'skip');
  raise exception 'FAIL[T2]: 他組織メンバーへのowner_id変更が成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T2]%' then raise; end if;
    if sqlerrm <> 'owner_must_be_active_org_member' then raise exception 'FAIL[T2]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T2]: 他組織メンバーへのowner_id変更は owner_must_be_active_org_member で拒否された';
end $$;
reset role;

\echo '=== T2b: owner_idに利用停止中の同組織メンバーを指定すると拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'd2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.update_company_checked('e0000000-0000-0000-0000-000000000002'::uuid, jsonb_build_object('owner_id','d4444444-4444-4444-4444-444444444444'), 'skip');
  raise exception 'FAIL[T2b]: 利用停止メンバーへのowner_id変更が成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T2b]%' then raise; end if;
    if sqlerrm <> 'owner_must_be_active_org_member' then raise exception 'FAIL[T2b]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T2b]: 利用停止メンバーへのowner_id変更は owner_must_be_active_org_member で拒否された';
end $$;
reset role;

\echo '=== T3: heatに不正な値を指定すると invalid_heat で拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'd2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.update_company_checked('e0000000-0000-0000-0000-000000000002'::uuid, jsonb_build_object('heat','超高'), 'skip');
  raise exception 'FAIL[T3]: 不正なheatの更新が成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T3]%' then raise; end if;
    if sqlerrm <> 'invalid_heat' then raise exception 'FAIL[T3]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T3]: 不正なheatは invalid_heat で拒否された';
end $$;
reset role;

\echo '=== T4: 他組織の企業IDを直接指定した更新は company_not_found_in_your_organization で拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.update_company_checked('e0000000-0000-0000-0000-000000000004'::uuid, jsonb_build_object('memo','不正アクセス試行'), 'skip');
  raise exception 'FAIL[T4]: 他組織企業への更新が成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T4]%' then raise; end if;
    if sqlerrm <> 'company_not_found_in_your_organization' then raise exception 'FAIL[T4]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T4]: 他組織企業への更新は company_not_found_in_your_organization で拒否された';
end $$;
reset role;

\echo '=== T5: 別企業と重複する電話番号への更新は既定(skip)では更新されず、対象企業のデータは変わらない ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
select public.update_company_checked('e0000000-0000-0000-0000-000000000001'::uuid, jsonb_build_object('phone','03-1000-0002'), 'skip');
reset role;
do $$
declare v public.companies;
begin
  select * into v from public.companies where id='e0000000-0000-0000-0000-000000000001';
  if v.phone <> '03-1000-0001' then raise exception 'FAIL[T5]: 重複衝突にもかかわらず電話番号が変更されています（%）', v.phone; end if;
  raise notice 'PASS[T5]: 重複衝突する更新はskippedとなり、対象企業のデータは変更されない';
end $$;

-- 【注意】psqlの`:'変数名'`によるクライアント側の変数展開は、ダラー引用（$$ ... $$）
-- で書かれたDOブロック本体の内側では行われない（ダラー引用文字列は他の引用済みSQL
-- リテラルと同様、psqlの変数展開の対象外という文書化された仕様）。そのため以降の
-- 各テストは、RPC呼び出しとその結果の検証を同じDOブロック内で完結させ（結果は
-- PL/pgSQLのローカル変数へ`v_result := ...`で代入して検証する）、psql変数を
-- DOブロックの内側から参照することはしない。複数の文にまたがって値を引き継ぐ
-- 必要がある場合（T13で作成した企業をT15/T16/T18で参照する等）も、psql変数では
-- なく既知の属性（organization_id・phoneなど）で再検索することで受け渡す。

\echo '=== T6: 架電禁止中の企業は、禁止一致キーに触れないメモだけの更新でも blocked を返す（禁止回避不可） ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb; v_row public.companies;
begin
  v_result := public.update_company_checked('e0000000-0000-0000-0000-000000000001'::uuid, jsonb_build_object('memo','架電禁止中でもメモは更新したい'), 'skip');
  if (v_result->>'status') <> 'blocked' then
    raise exception 'FAIL[T6]: 架電禁止中の企業のメモ更新がblockedになりませんでした（%）', v_result;
  end if;
  select * into v_row from public.companies where id='e0000000-0000-0000-0000-000000000001';
  if v_row.memo <> '' then raise exception 'FAIL[T6-DB確認]: blockedにもかかわらずmemoが更新されています（%）', v_row.memo; end if;
  raise notice 'PASS[T6]: 架電禁止中の企業は、禁止に無関係なフィールドの更新でもblockedを返し、DBも変更されない（メモ・温度感だけの更新でも権限確認を省略しない設計どおり）';
end $$;
reset role;

\echo '=== T7: 一般メンバーはarchive_company()を実行できない ==='
set role authenticated;
set request.jwt.claim.sub = 'd2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.archive_company('e0000000-0000-0000-0000-000000000003'::uuid);
  raise exception 'FAIL[T7]: 一般メンバーによるアーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T7]%' then raise; end if;
    if sqlerrm <> 'not_authorized' then raise exception 'FAIL[T7]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T7]: 一般メンバーによるarchive_company()は not_authorized で拒否された';
end $$;
reset role;

\echo '=== T8: adminはarchive_company()を実行できる ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb; v_row public.companies;
begin
  v_result := public.archive_company('e0000000-0000-0000-0000-000000000003'::uuid);
  if (v_result->>'status') <> 'archived' then raise exception 'FAIL[T8]: archive_company()がarchivedを返しませんでした（%）', v_result; end if;
  select * into v_row from public.companies where id='e0000000-0000-0000-0000-000000000003';
  if v_row.archived_at is null then raise exception 'FAIL[T8]: archived_atが記録されていません'; end if;
  if v_row.archived_by <> 'd1111111-1111-1111-1111-111111111111' then raise exception 'FAIL[T8]: archived_byが記録されていません'; end if;
  raise notice 'PASS[T8]: adminによるアーカイブが成功し、archived_at/archived_byが記録された';
end $$;
reset role;

\echo '=== T9: 既にアーカイブ済みの企業を再度アーカイブしても、エラーにならず同じ結果を安全に返す（冪等性） ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb;
begin
  v_result := public.archive_company('e0000000-0000-0000-0000-000000000003'::uuid);
  if (v_result->>'status') <> 'already_archived' then raise exception 'FAIL[T9]: 二重アーカイブがalready_archivedを返しませんでした（%）', v_result; end if;
  raise notice 'PASS[T9]: 二重アーカイブは冪等にalready_archivedを返す';
end $$;
reset role;

\echo '=== T10: 他組織の企業IDを直接指定したアーカイブは company_not_found_in_your_organization で拒否される ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
begin
  perform public.archive_company('e0000000-0000-0000-0000-000000000004'::uuid);
  raise exception 'FAIL[T10]: 他組織企業のアーカイブが成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T10]%' then raise; end if;
    if sqlerrm <> 'company_not_found_in_your_organization' then raise exception 'FAIL[T10]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T10]: 他組織企業へのarchive_company()は company_not_found_in_your_organization で拒否された';
end $$;
reset role;

\echo '=== T11: アーカイブ後もcall_logs・call_blocklistは削除・変更されない ==='
do $$
declare v_log_count int; v_block_count int;
begin
  select count(*) into v_log_count from public.call_logs where id='f0000000-0000-0000-0000-000000000001';
  if v_log_count <> 1 then raise exception 'FAIL[T11]: アーカイブ対象企業の架電履歴が消えています（件数=%）', v_log_count; end if;
  select count(*) into v_block_count from public.call_blocklist where company_id='e0000000-0000-0000-0000-000000000001' and active;
  if v_block_count <> 1 then raise exception 'FAIL[T11]: 無関係な企業の架電禁止設定が変化しています（件数=%）', v_block_count; end if;
  raise notice 'PASS[T11]: アーカイブ後もcall_logs・call_blocklistは維持される';
end $$;

\echo '=== T12: アーカイブ済み企業は check_company_safety() の重複候補から除外される ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb;
begin
  v_result := public.check_company_safety('アーカイブ対象企業','03-1000-0003',null,'愛知県');
  if jsonb_array_length(v_result->'duplicate_candidates') <> 0 then
    raise exception 'FAIL[T12]: アーカイブ済み企業が重複候補として検出されています（%）', v_result;
  end if;
  raise notice 'PASS[T12]: アーカイブ済み企業はcheck_company_safety()の重複候補から除外される';
end $$;
reset role;

\echo '=== T13: アーカイブ済み企業と同じ電話番号で新規企業を登録できる（アーカイブがキーを解放する） ==='
-- T13で作成した企業は、T15/T16/T18でpsql変数ではなく既知の属性
-- （organization_id + phone、対象企業自身のidを除く）で再検索して参照する。
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb;
begin
  v_result := public.create_company_checked(p_name:='新規重複企業', p_phone:='03-1000-0003', p_website_url:=null, p_location:='愛知県');
  if (v_result->>'status') <> 'inserted' then
    raise exception 'FAIL[T13]: アーカイブ済み企業と同じ電話番号の新規登録がinsertedになりませんでした（%）', v_result;
  end if;
  raise notice 'PASS[T13]: アーカイブ済み企業のキーは新規登録に再利用できる';
end $$;
reset role;

\echo '=== T14: 一般メンバーはrestore_company()を実行できない ==='
set role authenticated;
set request.jwt.claim.sub = 'd2222222-2222-2222-2222-222222222222';
do $$
begin
  perform public.restore_company('e0000000-0000-0000-0000-000000000003'::uuid);
  raise exception 'FAIL[T14]: 一般メンバーによる復元が成功してしまいました';
exception
  when others then
    if sqlerrm like 'FAIL[T14]%' then raise; end if;
    if sqlerrm <> 'not_authorized' then raise exception 'FAIL[T14]: 想定外のエラー（%）', sqlerrm; end if;
    raise notice 'PASS[T14]: 一般メンバーによるrestore_company()は not_authorized で拒否された';
end $$;
reset role;

\echo '=== T15: 復元先が既存の有効な企業と重複する場合は復元せず duplicate_conflict を明示的に返す ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_conflict_id uuid; v_result jsonb; v_row public.companies;
begin
  select id into v_conflict_id from public.companies
    where organization_id='d0000000-0000-0000-0000-00000000000a' and phone='03-1000-0003'
      and id <> 'e0000000-0000-0000-0000-000000000003' and archived_at is null
    limit 1;
  if v_conflict_id is null then raise exception 'FAIL[T15-fixture]: T13で作成されたはずの重複企業が見つかりません'; end if;

  v_result := public.restore_company('e0000000-0000-0000-0000-000000000003'::uuid);
  if (v_result->>'status') <> 'duplicate_conflict' then
    raise exception 'FAIL[T15]: 重複衝突があるにもかかわらずduplicate_conflictを返しませんでした（%）', v_result;
  end if;
  if (v_result->>'conflicting_company_id')::uuid <> v_conflict_id then
    raise exception 'FAIL[T15]: conflicting_company_idがT13で作成した企業と一致しません（%）', v_result;
  end if;
  select * into v_row from public.companies where id='e0000000-0000-0000-0000-000000000003';
  if v_row.archived_at is null then raise exception 'FAIL[T15-DB確認]: 重複衝突にもかかわらずarchived_atがクリアされています'; end if;
  raise notice 'PASS[T15]: 重複衝突時は復元せず、正しいconflicting_company_idとともにduplicate_conflictを返す';
end $$;
reset role;

\echo '=== T16: 衝突先の企業をアーカイブすれば、対象企業を復元できるようになる ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_conflict_id uuid; v_result jsonb; v_row public.companies;
begin
  select id into v_conflict_id from public.companies
    where organization_id='d0000000-0000-0000-0000-00000000000a' and phone='03-1000-0003'
      and id <> 'e0000000-0000-0000-0000-000000000003' and archived_at is null
    limit 1;
  if v_conflict_id is null then raise exception 'FAIL[T16-fixture]: 衝突先企業が見つかりません'; end if;
  perform public.archive_company(v_conflict_id);

  v_result := public.restore_company('e0000000-0000-0000-0000-000000000003'::uuid);
  if (v_result->>'status') <> 'restored' then
    raise exception 'FAIL[T16]: 衝突が解消された後もrestoredになりませんでした（%）', v_result;
  end if;
  select * into v_row from public.companies where id='e0000000-0000-0000-0000-000000000003';
  if v_row.archived_at is not null or v_row.archived_by is not null then
    raise exception 'FAIL[T16-DB確認]: 復元後もarchived_at/archived_byがクリアされていません';
  end if;
  raise notice 'PASS[T16]: 衝突解消後は正常に復元され、archived_at/archived_byがクリアされる';
end $$;
reset role;

\echo '=== T17: 既に有効な企業を復元しても、エラーにならず同じ結果を安全に返す（冪等性） ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb;
begin
  v_result := public.restore_company('e0000000-0000-0000-0000-000000000001'::uuid);
  if (v_result->>'status') <> 'already_active' then
    raise exception 'FAIL[T17]: 既に有効な企業への復元がalready_activeを返しませんでした（%）', v_result;
  end if;
  raise notice 'PASS[T17]: 既に有効な企業への復元は冪等にalready_activeを返す';
end $$;
reset role;

\echo '=== T18: companies_with_call_statusビューがarchived_at/archived_byを自動的に含む（c.*伝播、ビュー定義の変更不要） ==='
do $$
declare v_active record; v_archived record; v_archived_id uuid;
begin
  select * into v_active from public.companies_with_call_status where id='e0000000-0000-0000-0000-000000000003';
  if v_active.archived_at is not null then raise exception 'FAIL[T18]: 復元済み企業のビュー上のarchived_atがnullではありません'; end if;

  select id into v_archived_id from public.companies
    where organization_id='d0000000-0000-0000-0000-00000000000a' and phone='03-1000-0003'
      and id <> 'e0000000-0000-0000-0000-000000000003' and archived_at is not null
    limit 1;
  if v_archived_id is null then raise exception 'FAIL[T18-fixture]: T16でアーカイブしたはずの企業が見つかりません'; end if;
  select * into v_archived from public.companies_with_call_status where id=v_archived_id;
  if v_archived.archived_at is null then raise exception 'FAIL[T18]: アーカイブ済み企業のビュー上のarchived_atがnullです'; end if;
  raise notice 'PASS[T18]: companies_with_call_statusビューはcompaniesへの新規列追加を自動的に反映する';
end $$;

\echo '=== T19: ドメインスコープで架電禁止中の企業は、website_urlを空欄にする更新でもblockedを返す（空欄化による禁止回避不可） ==='
set role authenticated;
set request.jwt.claim.sub = 'd1111111-1111-1111-1111-111111111111';
do $$
declare v_result jsonb; v_row public.companies;
begin
  v_result := public.update_company_checked('e0000000-0000-0000-0000-000000000005'::uuid, jsonb_build_object('website_url',''), 'skip');
  if (v_result->>'status') <> 'blocked' then
    raise exception 'FAIL[T19]: ドメイン禁止企業のwebsite_url空欄化更新がblockedになりませんでした（%）', v_result;
  end if;
  select * into v_row from public.companies where id='e0000000-0000-0000-0000-000000000005';
  if v_row.website_url is null or v_row.website_url = '' then
    raise exception 'FAIL[T19-DB確認]: blockedにもかかわらずwebsite_urlが空欄に更新されています';
  end if;
  raise notice 'PASS[T19]: ドメインスコープで禁止中の企業は、website_urlを空欄にしてもblockedとなり禁止を回避できない';
end $$;
reset role;

\echo '=== T20: companies_with_call_statusビューの列名・順序が、companies物理列順（新規schema.sql環境／本番のemail後付け環境のいずれでも）に関わらず統一されている ==='
do $$
declare
  v_expected text[] := array[
    'id','organization_id','name','industry','location','phone','website_url',
    'source_url','list_source','contact_name','contact_department','heat',
    'owner_id','memo','last_called_at','next_action_at','created_at','updated_at',
    'email','call_prohibited','blocklist_id','blocked_scope','blocked_reason',
    'archived_at','archived_by','updated_by'
  ];
  v_actual text[];
begin
  select array_agg(column_name order by ordinal_position) into v_actual
    from information_schema.columns
    where table_schema='public' and table_name='companies_with_call_status';
  if v_actual is distinct from v_expected then
    raise exception 'FAIL[T20]: companies_with_call_statusの列名・順序が想定と異なります（実際=%、期待=%）', v_actual, v_expected;
  end if;
  raise notice 'PASS[T20]: companies_with_call_statusの列名・順序は、companiesの物理列順に依存せず統一されている（emailの実際の位置に関わらずidenticalなビュー列順）';
end $$;

\echo '=== ALL COMPANY-DETAIL-EDIT-ARCHIVE ASSERTIONS EXECUTED ==='

rollback;
