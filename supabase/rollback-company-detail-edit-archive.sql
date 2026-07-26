-- =========================================================
-- CallFlow CRM: 企業詳細・編集・アーカイブ管理のロールバック
--
-- add-company-detail-edit-archive.sql を適用したデータベースを、適用前の
-- 状態へ戻します。
--
-- 【重要】archived_at / archived_by 列にデータが入っている場合（＝実際に
-- アーカイブ操作が行われた場合)、この列を削除するとその「アーカイブされて
-- いる」という情報は失われます（companies行自体・call_logs・call_blocklistは
-- 削除されません。あくまで「どの企業がアーカイブ済みか」の情報だけが失われ、
-- 全企業が「有効」として扱われる状態に戻ります）。同様に updated_by 列の
-- 「誰が最後に編集したか」の情報も失われます。実行前に必要であれば
-- companiesテーブルのバックアップを取得してください。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

-- 1. 新規RPCを削除する
drop function if exists public.restore_company(uuid);
drop function if exists public.archive_company(uuid);

-- 2. update_company_checked() を、archive機能追加前の版へ戻す
--    （owner_id/heat/next_action_at/contact_department/source_url の編集と
--    company_is_archivedチェックを取り除いた、元のシグネチャ・ロジック）
create or replace function public.update_company_checked(
  p_company_id uuid, p_patch jsonb, p_on_duplicate text default 'skip'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_target public.companies;
  v_new_name text; v_new_phone text; v_new_website_url text; v_new_location text;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_block record;
  v_dup_company public.companies;
  v_updated public.companies;
  v_forbidden_keys text[] := array['id','organization_id','owner_id','created_at','updated_at'];
  v_key text;
  v_safe_patch jsonb;
begin
  if p_on_duplicate not in ('skip','update','insert') then
    raise exception 'invalid_on_duplicate';
  end if;

  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  select * into v_target from public.companies where id = p_company_id and organization_id = v_caller_org;
  if not found then raise exception 'company_not_found_in_your_organization'; end if;

  v_safe_patch := p_patch;
  foreach v_key in array v_forbidden_keys loop
    v_safe_patch := v_safe_patch - v_key;
  end loop;

  v_new_name := coalesce(nullif(v_safe_patch->>'name',''), v_target.name);
  v_new_phone := coalesce(nullif(v_safe_patch->>'phone',''), v_target.phone);
  v_new_website_url := coalesce(v_safe_patch->>'website_url', v_target.website_url);
  v_new_location := coalesce(nullif(v_safe_patch->>'location',''), v_target.location);

  if pg_catalog.btrim(coalesce(v_new_name,'')) = '' then raise exception 'name_required'; end if;

  v_norm_phone := public.normalize_phone(v_new_phone);
  v_norm_domain := public.normalize_domain(v_new_website_url);
  v_norm_name := public.normalize_company_name(v_new_name);
  v_norm_location := public.normalize_location(v_new_location);

  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
  if found then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org and c.id <> p_company_id
      and (
        (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
        or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
        or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
      )
    limit 1;

  if found and p_on_duplicate = 'skip' then
    return jsonb_build_object('status','skipped','conflicting_company_id',v_dup_company.id);
  end if;
  if found and p_on_duplicate not in ('insert') then
    return jsonb_build_object('status','needs_explicit_resolution','conflicting_company_id',v_dup_company.id);
  end if;

  update public.companies set
    name = v_new_name,
    phone = v_new_phone,
    website_url = nullif(v_new_website_url,''),
    location = v_new_location,
    industry = coalesce(v_safe_patch->>'industry', industry),
    contact_name = coalesce(v_safe_patch->>'contact_name', contact_name),
    email = coalesce(v_safe_patch->>'email', email),
    memo = coalesce(v_safe_patch->>'memo', memo),
    list_source = coalesce(v_safe_patch->>'list_source', list_source)
  where id = p_company_id
  returning * into v_updated;

  return jsonb_build_object('status','updated','company',to_jsonb(v_updated));
end;
$$;

revoke all on function public.update_company_checked(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.update_company_checked(uuid,jsonb,text) to authenticated;

-- 3. create_company_checked() / create_companies_checked() を、
--    archived_at is null 条件追加前の版へ戻す
create or replace function public.create_company_checked(
  p_name text, p_phone text, p_website_url text, p_location text,
  p_industry text default '', p_contact_name text default '', p_email text default null,
  p_memo text default '', p_list_source text default null,
  p_on_duplicate text default 'skip'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_block record;
  v_dup_company public.companies;
  v_new_company public.companies;
begin
  if p_on_duplicate not in ('skip','update','insert') then
    raise exception 'invalid_on_duplicate';
  end if;

  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  if pg_catalog.btrim(coalesce(p_name,'')) = '' then raise exception 'name_required'; end if;

  v_norm_phone := public.normalize_phone(p_phone);
  v_norm_domain := public.normalize_domain(p_website_url);
  v_norm_name := public.normalize_company_name(p_name);
  v_norm_location := public.normalize_location(p_location);

  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
  if found then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org
      and (
        (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
        or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
        or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
      )
    limit 1;

  if found and p_on_duplicate = 'skip' then
    return jsonb_build_object('status','skipped','existing_company_id',v_dup_company.id);
  end if;
  if found and p_on_duplicate = 'update' then
    return jsonb_build_object('status','needs_explicit_update','existing_company_id',v_dup_company.id);
  end if;

  insert into public.companies(
    organization_id, name, industry, location, phone, website_url, list_source,
    contact_name, email, memo, heat, owner_id
  ) values (
    v_caller_org, p_name, coalesce(p_industry,''), p_location, p_phone, nullif(p_website_url,''), p_list_source,
    coalesce(p_contact_name,''), p_email, coalesce(p_memo,''), '低', v_caller
  ) returning * into v_new_company;

  return jsonb_build_object('status','inserted','company',to_jsonb(v_new_company));
end;
$$;

revoke all on function public.create_company_checked(text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_company_checked(text,text,text,text,text,text,text,text,text,text) to authenticated;

-- create_companies_checked()：archived_at is null 追加前の版へ戻す
create or replace function public.create_companies_checked(
  p_rows jsonb, p_default_on_duplicate text default 'skip'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_row jsonb; v_idx int := 0;
  v_results jsonb := '[]'::jsonb;
  v_row_result jsonb;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_seen_phones text[] := '{}'; v_seen_domains text[] := '{}'; v_seen_name_locs text[] := '{}';
  v_block record; v_dup_company public.companies; v_new_company public.companies; v_updated public.companies;
  v_on_duplicate text;
  v_eff_name text; v_eff_phone text; v_eff_website_url text; v_eff_location text;
  v_dup_after record;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_idx := v_idx + 1;
    begin

      select * into v_caller_profile from public.profiles where id = v_caller;
      if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
        raise exception 'account_inactive';
      end if;

      v_on_duplicate := coalesce(v_row->>'on_duplicate', p_default_on_duplicate);
      if v_on_duplicate not in ('skip','update','insert') then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'invalid_on_duplicate');
        v_results := v_results || jsonb_build_array(v_row_result);
        continue;
      end if;

      v_norm_phone := public.normalize_phone(v_row->>'phone');
      v_norm_domain := public.normalize_domain(v_row->>'website_url');
      v_norm_name := public.normalize_company_name(v_row->>'name');
      v_norm_location := public.normalize_location(v_row->>'location');

      if v_norm_name = '' then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'name_required');
        v_results := v_results || jsonb_build_array(v_row_result);
        continue;
      end if;

      perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

      if (v_norm_phone <> '' and v_norm_phone = any(v_seen_phones))
         or (v_norm_domain <> '' and v_norm_domain = any(v_seen_domains))
         or (v_norm_name <> '' and v_norm_location <> '' and (v_norm_name||'|'||v_norm_location) = any(v_seen_name_locs)) then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'skipped', 'reason', 'duplicate_within_csv');
        v_results := v_results || jsonb_build_array(v_row_result);
        continue;
      end if;

      select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
      if found then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'blocked', 'blocklist_id', v_block.blocklist_id, 'matched_scope', v_block.matched_scope);
        v_results := v_results || jsonb_build_array(v_row_result);
        if v_norm_phone <> '' then v_seen_phones := array_append(v_seen_phones, v_norm_phone); end if;
        if v_norm_domain <> '' then v_seen_domains := array_append(v_seen_domains, v_norm_domain); end if;
        if v_norm_name <> '' and v_norm_location <> '' then v_seen_name_locs := array_append(v_seen_name_locs, v_norm_name||'|'||v_norm_location); end if;
        continue;
      end if;

      select c.* into v_dup_company from public.companies c
        where c.organization_id = v_caller_org
          and (
            (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
            or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
            or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
          )
        limit 1;

      if found and v_on_duplicate = 'skip' then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'skipped', 'existing_company_id', v_dup_company.id);

      elsif found and v_on_duplicate = 'update' then
        select * into v_dup_company from public.companies where id = v_dup_company.id for update;

        v_eff_name := coalesce(nullif(v_row->>'name',''), v_dup_company.name);
        v_eff_phone := coalesce(nullif(v_row->>'phone',''), v_dup_company.phone);
        v_eff_website_url := coalesce(nullif(v_row->>'website_url',''), v_dup_company.website_url);
        v_eff_location := coalesce(nullif(v_row->>'location',''), v_dup_company.location);

        v_norm_phone := public.normalize_phone(v_eff_phone);
        v_norm_domain := public.normalize_domain(v_eff_website_url);
        v_norm_name := public.normalize_company_name(v_eff_name);
        v_norm_location := public.normalize_location(v_eff_location);

        perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

        select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
        if found then
          v_row_result := jsonb_build_object('row', v_idx, 'status', 'blocked', 'blocklist_id', v_block.blocklist_id, 'matched_scope', v_block.matched_scope);
          v_results := v_results || jsonb_build_array(v_row_result);
          if v_norm_phone <> '' then v_seen_phones := array_append(v_seen_phones, v_norm_phone); end if;
          if v_norm_domain <> '' then v_seen_domains := array_append(v_seen_domains, v_norm_domain); end if;
          if v_norm_name <> '' and v_norm_location <> '' then v_seen_name_locs := array_append(v_seen_name_locs, v_norm_name||'|'||v_norm_location); end if;
          continue;
        end if;

        select c.* into v_dup_after from public.companies c
          where c.organization_id = v_caller_org and c.id <> v_dup_company.id
            and (
              (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
              or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
              or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
            )
          limit 1;
        if found then
          v_row_result := jsonb_build_object('row', v_idx, 'status', 'skipped', 'reason', 'duplicate_conflict', 'conflicting_company_id', v_dup_after.id);
          v_results := v_results || jsonb_build_array(v_row_result);
          if v_norm_phone <> '' then v_seen_phones := array_append(v_seen_phones, v_norm_phone); end if;
          if v_norm_domain <> '' then v_seen_domains := array_append(v_seen_domains, v_norm_domain); end if;
          if v_norm_name <> '' and v_norm_location <> '' then v_seen_name_locs := array_append(v_seen_name_locs, v_norm_name||'|'||v_norm_location); end if;
          continue;
        end if;

        update public.companies set
          name = v_eff_name,
          phone = v_eff_phone,
          website_url = nullif(v_eff_website_url,''),
          location = v_eff_location,
          industry = coalesce(nullif(v_row->>'industry',''), industry),
          contact_name = coalesce(nullif(v_row->>'contact_name',''), contact_name),
          email = coalesce(nullif(v_row->>'email',''), email),
          memo = coalesce(nullif(v_row->>'memo',''), memo),
          list_source = coalesce(nullif(v_row->>'list_source',''), list_source)
        where id = v_dup_company.id returning * into v_updated;
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'updated', 'company_id', v_updated.id);

      else
        insert into public.companies(organization_id, name, industry, location, phone, website_url, list_source, contact_name, email, memo, heat, owner_id)
        values (v_caller_org, v_row->>'name', coalesce(v_row->>'industry',''), v_row->>'location', v_row->>'phone', nullif(v_row->>'website_url',''),
                v_row->>'list_source', coalesce(v_row->>'contact_name',''), v_row->>'email', coalesce(v_row->>'memo',''), '低', v_caller)
        returning * into v_new_company;
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'inserted', 'company_id', v_new_company.id);
      end if;
      v_results := v_results || jsonb_build_array(v_row_result);

      if v_norm_phone <> '' then v_seen_phones := array_append(v_seen_phones, v_norm_phone); end if;
      if v_norm_domain <> '' then v_seen_domains := array_append(v_seen_domains, v_norm_domain); end if;
      if v_norm_name <> '' and v_norm_location <> '' then v_seen_name_locs := array_append(v_seen_name_locs, v_norm_name||'|'||v_norm_location); end if;

    exception
      when deadlock_detected or lock_not_available or query_canceled or serialization_failure then
        raise;
      when unique_violation then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'duplicate_key');
        v_results := v_results || jsonb_build_array(v_row_result);
      when not_null_violation or check_violation or invalid_text_representation then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'invalid_value');
        v_results := v_results || jsonb_build_array(v_row_result);
      when string_data_right_truncation then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'value_too_long');
        v_results := v_results || jsonb_build_array(v_row_result);
    end;
  end loop;

  return jsonb_build_object('results', v_results);
end;
$$;

revoke all on function public.create_companies_checked(jsonb,text) from public, anon, authenticated;
grant execute on function public.create_companies_checked(jsonb,text) to authenticated;

-- 4. check_company_safety() を archived_at is null 追加前の版へ戻す
create or replace function public.check_company_safety(
  p_name text, p_phone text, p_website_url text, p_location text
) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_caller_org uuid;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_block record;
  v_dup_phone public.companies; v_dup_domain public.companies;
  v_dup_name_location public.companies; v_dup_name public.companies;
  v_candidates jsonb := '[]'::jsonb;
begin
  v_caller_org := public.current_organization_id();
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  v_norm_phone := public.normalize_phone(p_phone);
  v_norm_domain := public.normalize_domain(p_website_url);
  v_norm_name := public.normalize_company_name(p_name);
  v_norm_location := public.normalize_location(p_location);

  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  select c.* into v_dup_phone from public.companies c
    where c.organization_id = v_caller_org and v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','phone','company_id',v_dup_phone.id));
  end if;

  select c.* into v_dup_domain from public.companies c
    where c.organization_id = v_caller_org and v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain
      and (v_dup_phone.id is null or c.id <> v_dup_phone.id) limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','domain','company_id',v_dup_domain.id));
  end if;

  select c.* into v_dup_name_location from public.companies c
    where c.organization_id = v_caller_org and v_norm_name <> '' and v_norm_location <> ''
      and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location
      and c.id not in (select x from unnest(array[v_dup_phone.id, v_dup_domain.id]) x where x is not null) limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','name_location','company_id',v_dup_name_location.id));
  end if;

  select c.* into v_dup_name from public.companies c
    where c.organization_id = v_caller_org and v_norm_name <> ''
      and public.normalize_company_name(c.name) = v_norm_name
      and c.id not in (select x from unnest(array[v_dup_phone.id, v_dup_domain.id, v_dup_name_location.id]) x where x is not null) limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','name','company_id',v_dup_name.id));
  end if;

  return jsonb_build_object(
    'blocked', v_block.blocklist_id is not null,
    'block_matches', case when v_block.blocklist_id is not null
      then jsonb_build_array(jsonb_build_object('blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason))
      else '[]'::jsonb end,
    'duplicate_candidates', v_candidates
  );
end;
$$;

revoke all on function public.check_company_safety(text,text,text,text) from public, anon, authenticated;
grant execute on function public.check_company_safety(text,text,text,text) to authenticated;

-- 5. companies_with_call_status ビューを一旦削除する。
--    現在のビュー定義はcompanies由来の列を明示的に列挙しており
--    （archived_at/archived_by/updated_byを含む）、この状態のまま列を
--    DROPしようとすると依存関係エラーになる。
--    【注意】CREATE OR REPLACE VIEWは列を追加方向にしか使えず、列数を減らす
--    リプレースは "cannot drop columns from view" エラーで失敗するため使えない。
--    また、companiesがまだarchived_at等を持ったまま`c.*`でビューを作り直すと
--    その時点の`c.*`に再びarchived_at等が含まれてしまい、直後のDROP COLUMNが
--    同じ依存関係エラーで失敗する。そのため、ここでは一旦ビューを完全に削除し、
--    列を削除した後（手順7）で`c.*`ベースの元の定義として作り直す（手順8）。
drop view if exists public.companies_with_call_status;

-- 6. companiesの新規列を削除する（archived_at/archived_by列にデータがある場合は
--    「どの企業がアーカイブ済みか」の情報が失われる。上記の注意書きを参照）
alter table public.companies
  drop column if exists archived_at,
  drop column if exists archived_by,
  drop column if exists updated_by;

drop index if exists public.companies_archived_idx;

-- 7. companies_with_call_status ビューを、archived_at等を含まない元の定義
--    （`c.*`。この時点でcompaniesは既にarchived_at等を持たないため、`c.*`は
--    自然に元の19列だけへ展開される）で作り直す。
create view public.companies_with_call_status
with (
  security_barrier = true,
  security_invoker = true
)
as
select
  c.*,
  (m.blocklist_id is not null) as call_prohibited,
  m.blocklist_id,
  m.matched_scope as blocked_scope,
  m.reason as blocked_reason
from public.companies c
left join lateral public.match_active_blocklist(
  c.organization_id,
  public.normalize_phone(c.phone),
  public.normalize_domain(c.website_url),
  public.normalize_company_name(c.name),
  public.normalize_location(c.location)
) m on true;

revoke all on public.companies_with_call_status from public, anon, authenticated;
grant select on public.companies_with_call_status to authenticated;

commit;
