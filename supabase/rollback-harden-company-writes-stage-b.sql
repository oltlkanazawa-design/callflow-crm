-- =========================================================
-- CallFlow CRM: 企業安全管理 段階B のロールバック
--
-- harden-company-writes-stage-b.sql を適用したデータベースを、
-- 適用前の状態（companiesへの直接INSERT/UPDATEが可能で、record_call()が
-- SECURITY INVOKERの状態）へ戻します。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

-- 1. companiesへの直接書き込み権限を先に戻す（record_call()をinvokerへ戻す前に、
--    companiesのUPDATE権限が既にauthenticatedへ戻っている必要があるため）
grant insert, update on table public.companies to authenticated;

-- 2. record_call()を段階A相当（SECURITY INVOKER）へ戻す。ロジックは無変更。
create or replace function public.record_call(
  p_company_id uuid, p_result text, p_note text default '', p_transcript text default null,
  p_ai_summary text default null, p_next_action_at timestamptz default null, p_heat text default '低'
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_company public.companies;
  v_block record;
  v_log_id uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_company from public.companies where id = p_company_id and organization_id = v_caller_org;
  if not found then raise exception 'company not found'; end if;

  select * into v_block from public.match_active_blocklist(
    v_caller_org, public.normalize_phone(v_company.phone), public.normalize_domain(v_company.website_url),
    public.normalize_company_name(v_company.name), public.normalize_location(v_company.location));
  if found then raise exception 'call_prohibited'; end if;

  if p_result not in ('アポ獲得','資料送付','再架電','担当者不在','見込みなし','その他') then raise exception 'invalid result'; end if;
  if p_heat not in ('高','中','低') then raise exception 'invalid heat'; end if;

  insert into public.call_logs(organization_id, company_id, caller_id, result, note, transcript, ai_summary, next_action_at)
  values (v_caller_org, p_company_id, v_caller, p_result, coalesce(p_note,''), p_transcript, p_ai_summary, p_next_action_at)
  returning id into v_log_id;
  update public.companies
    set heat = p_heat, memo = coalesce(nullif(p_note,''), memo), last_called_at = pg_catalog.now(), next_action_at = p_next_action_at
    where id = p_company_id;

  return v_log_id;
end;
$$;

revoke all on function public.record_call(uuid,text,text,text,text,timestamptz,text) from public, anon;
grant execute on function public.record_call(uuid,text,text,text,text,timestamptz,text) to authenticated;

commit;
