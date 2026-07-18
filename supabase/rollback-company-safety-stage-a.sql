-- =========================================================
-- CallFlow CRM: 企業安全管理（段階A）のロールバック
--
-- add-company-safety-stage-a.sql を適用したデータベースを、適用前の状態へ
-- 戻します。call_blocklist / call_blocklist_audit に蓄積されたデータは
-- 全て失われます（架電禁止設定・監査履歴の削除を意味します）。
-- 実行前に必要であればテーブルのバックアップを取得してください。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

-- 1. call_logsの新規RESTRICTIVEポリシーを削除
drop policy if exists "block call_logs insert for prohibited companies" on public.call_logs;

-- 2. call_logs.company_idの外部キーをON DELETE CASCADEへ戻す（制約名は動的に特定）
do $$
declare
  v_constraint_name text;
begin
  select tc.constraint_name into v_constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
  join information_schema.referential_constraints rc
    on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
  join information_schema.table_constraints tc2
    on tc2.constraint_name = rc.unique_constraint_name and tc2.table_schema = rc.unique_constraint_schema
  where tc.table_schema = 'public'
    and tc.table_name = 'call_logs'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'company_id'
    and tc2.table_name = 'companies';

  if v_constraint_name is null then
    raise exception 'call_logs.company_id の外部キー制約名を特定できませんでした。適用を中止してください。';
  end if;

  execute format('alter table public.call_logs drop constraint %I', v_constraint_name);
  alter table public.call_logs
    add constraint call_logs_company_id_fkey
    foreign key (company_id) references public.companies(id) on delete cascade;
end;
$$;

-- 3. record_call()を段階A適用前のロジックへ戻す（署名・返り値・security invokerは維持）
create or replace function public.record_call(
  p_company_id uuid, p_result text, p_note text default '', p_transcript text default null,
  p_ai_summary text default null, p_next_action_at timestamptz default null, p_heat text default '低'
) returns uuid language plpgsql security invoker set search_path=public as $$
declare v_org uuid; v_log_id uuid;
begin
  select organization_id into v_org from public.companies where id=p_company_id;
  if v_org is null or v_org<>public.current_organization_id() then raise exception 'company not found'; end if;
  if p_result not in ('アポ獲得','資料送付','再架電','担当者不在','見込みなし','その他') then raise exception 'invalid result'; end if;
  if p_heat not in ('高','中','低') then raise exception 'invalid heat'; end if;
  insert into public.call_logs(organization_id,company_id,caller_id,result,note,transcript,ai_summary,next_action_at)
  values(v_org,p_company_id,auth.uid(),p_result,coalesce(p_note,''),p_transcript,p_ai_summary,p_next_action_at) returning id into v_log_id;
  update public.companies set heat=p_heat,memo=coalesce(nullif(p_note,''),memo),last_called_at=now(),next_action_at=p_next_action_at where id=p_company_id;
  return v_log_id;
end $$;
grant execute on function public.record_call(uuid,text,text,text,text,timestamptz,text) to authenticated;

-- 4. current_organization_id()を段階A適用前の定義へ戻す（ロジック自体は無変更のため実質的に同一）
create or replace function public.current_organization_id() returns uuid language sql stable security definer set search_path=public as $$
  select organization_id from public.profiles where id=auth.uid() and active=true
$$;

-- 【注意】段階Aはcurrent_organization_id()の実行権限をpublic/anonから明示的にrevokeし、
-- authenticatedのみに絞っています。CREATE OR REPLACEは既存の権限設定を変更しないため、
-- このロールバックを実行してもpublic/anonへの実行権限は復元されず、authenticated限定の
-- ままになります。これは意図的な措置です：段階A適用前は権限管理をしておらずPostgresの
-- 既定でpublicに実行権限がありましたが、この関数は組織メンバー以外が呼ぶ必要が無いため、
-- 制限したままの方が安全です。完全に段階A適用前の権限へ戻したい場合は、別途
--   grant execute on function public.current_organization_id() to public;
-- を実行してください（非推奨）。

-- 5. 新規RPC群を削除（段階Aで導入した最終シグネチャに合わせる。
--    p_acknowledge_blocklist引数は削除済みのため10引数版を指定する）
drop function if exists public.scan_duplicate_candidates();
drop function if exists public.unblock_company_calls(uuid,text);
drop function if exists public.block_company_calls(uuid,text,text,text,text,text,text);
drop function if exists public.create_companies_checked(jsonb,text);
drop function if exists public.update_company_checked(uuid,jsonb,text);
drop function if exists public.create_company_checked(text,text,text,text,text,text,text,text,text,text);
drop function if exists public.check_company_safety(text,text,text,text);

-- 6. ビューを削除
drop view if exists public.companies_with_call_status;

-- 7. ロック関数・共通照合関数を削除
drop function if exists public.acquire_registration_locks(uuid,text,text,text,text);
drop function if exists public.acquire_organization_lock(uuid);
drop function if exists public.match_active_blocklist(uuid,text,text,text,text);

-- 8. call_blocklist_audit / call_blocklistを削除（データも失われる）
drop table if exists public.call_blocklist_audit;
drop table if exists public.call_blocklist;

-- 9. 正規化関数を削除
--    他のオブジェクトから参照されなくなったことを確認してから削除する
drop function if exists public.normalize_location(text);
drop function if exists public.normalize_company_name(text);
drop function if exists public.normalize_domain(text);
drop function if exists public.normalize_phone(text);

commit;
