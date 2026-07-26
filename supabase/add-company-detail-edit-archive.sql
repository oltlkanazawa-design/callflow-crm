-- =========================================================
-- CallFlow CRM: 企業詳細・編集・アーカイブ管理
--
-- 【重要】このファイルはこの開発環境から本番Supabaseへ直接適用しません。
-- 内容を確認のうえ、ユーザー自身がSupabaseのSQL Editor等で実行してください。
--
-- 既存の約50社の企業データ・既存のcall_logs（架電履歴）・既存のcall_blocklist
-- （架電禁止設定）は、このマイグレーションによって一切変更・削除されません。
-- 追加するのはcompaniesへの新規カラム3つ（すべてnullable）と、
-- 新規関数2つ（archive_company / restore_company）、既存関数の拡張1つ
-- （update_company_checked）、既存関数の重複判定条件への1条件追加3箇所
-- （create_company_checked / create_companies_checked / check_company_safety）、
-- そしてcompanies_with_call_statusビューの明示的な再作成（`select c.*`は
-- ビュー作成時点の列一覧に固定されるため、後から追加した新規カラムを
-- ビュー経由で取得できるようにするために必要）です。
--
-- 【スコープ外】supabase/harden-company-writes-stage-b.sql（companiesテーブルへの
-- 直接INSERT/UPDATE権限の剥奪）はこのマイグレーションでは一切触れません。
-- 現状のRLS "organization members update companies" は admin 以外の組織メンバーにも
-- companiesの直接UPDATEを許可しており、archived_at / archived_by 列もこのRLSの
-- 対象になります（owner_id・heat・memo等、既存の他の列と同じ既知の制限であり、
-- 今回新たに生じる問題ではありません）。archive_company() / restore_company() の
-- admin限定チェックはRPC層で行っており、UIも管理者以外には操作を見せませんが、
-- 「クライアントが独自にcompaniesへ直接UPDATE文を送る」経路までは、Stage Bを
-- 適用しない限り構造的に閉じられません。この既知のギャップはStage Bのスコープです。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 17. companiesへのアーカイブ・監査列の追加
--    updated_at は既存カラム（companies_set_updated_atトリガーで自動更新済み）
--    のため変更しない。新規に追加するのは archived_at / archived_by / updated_by
--    の3列のみで、いずれもnullable。デフォルト値は無いため、既存行は
--    archived_at is null（＝すべて「有効」）のまま、既存データの意味は変わらない。
-- ---------------------------------------------------------
alter table public.companies
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id) on delete set null,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

-- 一覧画面の「有効な企業／アーカイブ済み」切り替えで organization_id + archived_at
-- による絞り込みが多用されるため、複合インデックスを追加する。
create index if not exists companies_archived_idx on public.companies(organization_id, archived_at);

-- ---------------------------------------------------------
-- 18. update_company_checked() の拡張
--    既存のロック順序（organization lock → profile再確認 → 対象企業の再取得 →
--    registration locks → 禁止状態・重複状態の再取得 → 書き込み）は変更しない。
--    追加した点：
--      a. 編集可能フィールドを拡張：contact_department, source_url, heat,
--         owner_id, next_action_at
--      b. owner_id を弱制約列（v_forbidden_keys）から外し、代わりに
--         「同一組織のactiveなprofileであること」を明示的に検証する
--      c. heat は '高'/'中'/'低' 以外を invalid_heat で拒否する
--      d. next_action_at はキーの有無で「変更しない」と「nullへ空欄化する」を
--         区別する（キー自体が無ければ変更しない。キーが空文字列ならnullにする。
--         他の任意テキスト項目（email/memo/list_source等）と同じ規約）
--      e. アーカイブ済み企業への編集はarchive/restore専用RPC以外から行えないよう、
--         company_is_archived で明示的に拒否する
--      f. 重複再確認クエリに archived_at is null を追加する（アーカイブ済み企業は
--         重複判定の対象から外れる＝そのキーを新規・他企業が再利用できる）
--      g. 更新のたびに updated_by = 呼び出し元 を記録する
--         （updated_at は既存トリガーが自動更新するため触れない）
-- ---------------------------------------------------------
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
  v_new_heat text; v_new_owner_id uuid;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_block_check_domain text;
  v_block record;
  v_dup_company public.companies;
  v_updated public.companies;
  v_forbidden_keys text[] := array['id','organization_id','created_at','updated_at','updated_by','archived_at','archived_by','last_called_at'];
  v_key text;
  v_safe_patch jsonb;
begin
  -- 0. duplicate modeの検証
  if p_on_duplicate not in ('skip','update','insert') then
    raise exception 'invalid_on_duplicate';
  end if;

  -- 1. 認証確認
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  -- 2. 所属組織の仮取得
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  -- 3. organization advisory lock
  perform public.acquire_organization_lock(v_caller_org);

  -- 4. ロック取得後にprofileを再確認
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  -- 5. ロック取得後に対象企業を再取得する
  select * into v_target from public.companies where id = p_company_id and organization_id = v_caller_org;
  if not found then raise exception 'company_not_found_in_your_organization'; end if;

  -- アーカイブ済み企業は、専用のrestore_company()を経由しない限り編集不可
  if v_target.archived_at is not null then
    raise exception 'company_is_archived';
  end if;

  -- クライアントが自由に変更すべきでない列をpatchから除外する
  v_safe_patch := p_patch;
  foreach v_key in array v_forbidden_keys loop
    v_safe_patch := v_safe_patch - v_key;
  end loop;

  v_new_name := coalesce(nullif(v_safe_patch->>'name',''), v_target.name);
  v_new_phone := coalesce(nullif(v_safe_patch->>'phone',''), v_target.phone);
  v_new_website_url := coalesce(v_safe_patch->>'website_url', v_target.website_url);
  v_new_location := coalesce(nullif(v_safe_patch->>'location',''), v_target.location);

  if pg_catalog.btrim(coalesce(v_new_name,'')) = '' then raise exception 'name_required'; end if;

  -- heatの検証（キーが無ければ既存値を維持＝v_new_heatはnullのまま）
  if v_safe_patch ? 'heat' then
    v_new_heat := v_safe_patch->>'heat';
    if v_new_heat not in ('高','中','低') then raise exception 'invalid_heat'; end if;
  end if;

  -- owner_idの検証：nullへの変更（未割当化）は許可する。非nullの場合は
  -- 同一組織に所属するactiveなprofileであることを要求する
  if v_safe_patch ? 'owner_id' then
    v_new_owner_id := nullif(v_safe_patch->>'owner_id','')::uuid;
    if v_new_owner_id is not null then
      if not exists (
        select 1 from public.profiles
        where id = v_new_owner_id and organization_id = v_caller_org and active = true
      ) then
        raise exception 'owner_must_be_active_org_member';
      end if;
    end if;
  end if;

  v_norm_phone := public.normalize_phone(v_new_phone);
  v_norm_domain := public.normalize_domain(v_new_website_url);
  v_norm_name := public.normalize_company_name(v_new_name);
  v_norm_location := public.normalize_location(v_new_location);

  -- 6. registration advisory lock
  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  -- 7. 更新後の実効値で禁止判定（空欄入力で既存の禁止一致キーを外して回避できないよう、
  --    パッチが空欄の項目は既存値を引き継いだ実効値で判定する）。
  --    website_urlは（禁止されていない企業が正当にURLを削除できるように）書き込み値
  --    自体は空欄を許すが、禁止判定用のドメインだけは name/phone/location と同じく
  --    「パッチが空欄なら既存値を維持」した値から算出し、空欄化による禁止回避を防ぐ。
  v_block_check_domain := public.normalize_domain(coalesce(nullif(v_safe_patch->>'website_url',''), v_target.website_url));
  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_block_check_domain, v_norm_name, v_norm_location);
  if found then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  -- 8. 対象企業自身を除外して重複候補を再確認する。アーカイブ済み企業は
  --    重複判定の対象から除外する（アーカイブによってそのキーは再利用可能になる）
  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org and c.id <> p_company_id and c.archived_at is null
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
    -- 明示的な処理方針（'insert'=別企業として続行を承知のうえで更新）が無ければ更新しない
    return jsonb_build_object('status','needs_explicit_resolution','conflicting_company_id',v_dup_company.id);
  end if;

  -- 9. 書き込み
  update public.companies set
    name = v_new_name,
    phone = v_new_phone,
    website_url = nullif(v_new_website_url,''),
    location = v_new_location,
    industry = coalesce(v_safe_patch->>'industry', industry),
    contact_name = coalesce(v_safe_patch->>'contact_name', contact_name),
    contact_department = coalesce(v_safe_patch->>'contact_department', contact_department),
    email = coalesce(v_safe_patch->>'email', email),
    memo = coalesce(v_safe_patch->>'memo', memo),
    list_source = coalesce(v_safe_patch->>'list_source', list_source),
    source_url = coalesce(v_safe_patch->>'source_url', source_url),
    heat = coalesce(v_new_heat, heat),
    owner_id = case when v_safe_patch ? 'owner_id' then v_new_owner_id else owner_id end,
    next_action_at = case
      when v_safe_patch ? 'next_action_at' then nullif(v_safe_patch->>'next_action_at','')::timestamptz
      else next_action_at
    end,
    updated_by = v_caller
  where id = p_company_id
  returning * into v_updated;

  return jsonb_build_object('status','updated','company',to_jsonb(v_updated));
end;
$$;

revoke all on function public.update_company_checked(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.update_company_checked(uuid,jsonb,text) to authenticated;

-- ---------------------------------------------------------
-- 19. create_company_checked() の重複判定に archived_at is null を追加
--    （アーカイブ済み企業のキーを新規登録が再利用できるようにする）。
--    それ以外のロジック・シグネチャ・ロック順序は一切変更しない。
-- ---------------------------------------------------------
create or replace function public.create_company_checked(
  p_name text, p_phone text, p_website_url text, p_location text,
  p_industry text default '', p_contact_name text default '', p_email text default null,
  p_memo text default '', p_list_source text default null,
  p_on_duplicate text default 'skip'          -- 'skip' | 'update' | 'insert'
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

  -- archived_at is null を追加：アーカイブ済み企業は重複判定の対象から外れる
  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org and c.archived_at is null
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

-- ---------------------------------------------------------
-- 20. create_companies_checked() の重複判定2箇所に archived_at is null を追加
--    （CSV一括登録時も、アーカイブ済み企業のキーを再利用可能にするため）。
--    それ以外のロジック・シグネチャ・行単位のSAVEPOINT方式・例外分類は
--    一切変更しない。
-- ---------------------------------------------------------
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

      -- archived_at is null を追加：アーカイブ済み企業は重複判定の対象から外れる
      select c.* into v_dup_company from public.companies c
        where c.organization_id = v_caller_org and c.archived_at is null
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

        -- archived_at is null を追加（対象自身は除外）
        select c.* into v_dup_after from public.companies c
          where c.organization_id = v_caller_org and c.id <> v_dup_company.id and c.archived_at is null
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
          list_source = coalesce(nullif(v_row->>'list_source',''), list_source),
          updated_by = v_caller
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

-- ---------------------------------------------------------
-- 21. archive_company()：管理者専用。企業をアーカイブする（ハードDELETEしない）。
--    call_logs / call_blocklist は一切変更・削除しない。
--    既に archived_at is not null の企業に対する再アーカイブは、エラーにせず
--    同じ結果（status='already_archived'）を安全に返す（冪等性）。
--    ロック順序はblock_company_calls()と同じ：organization lock → profile
--    再確認（admin + active + 組織一致） → 対象企業の再取得。
-- ---------------------------------------------------------
create or replace function public.archive_company(
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_target public.companies;
  v_updated public.companies;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  if p_company_id is null then raise exception 'company_id_required'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.companies
    where id = p_company_id and organization_id = v_caller_org
    for update;
  if not found then raise exception 'company_not_found_in_your_organization'; end if;

  -- 既にアーカイブ済みなら、技術エラーにせず同じ状態を安全に返す（冪等）
  if v_target.archived_at is not null then
    return jsonb_build_object('status','already_archived','company',to_jsonb(v_target));
  end if;

  update public.companies set
    archived_at = pg_catalog.now(),
    archived_by = v_caller,
    updated_by = v_caller
  where id = p_company_id
  returning * into v_updated;

  return jsonb_build_object('status','archived','company',to_jsonb(v_updated));
end;
$$;

revoke all on function public.archive_company(uuid) from public, anon, authenticated;
grant execute on function public.archive_company(uuid) to authenticated;

-- ---------------------------------------------------------
-- 22. restore_company()：管理者専用。アーカイブ済み企業を有効な状態へ戻す。
--    復元前に、現在有効な（archived_at is null）他企業との重複衝突を必ず
--    再確認する。衝突する場合は復元せず、status='duplicate_conflict' を
--    明示的に返す（サイレントにマージしたり、エラーを握りつぶしたりしない）。
--    架電禁止（call_blocklist）状態は復元をブロックしない。企業の識別情報
--    （電話・URL・企業名・所在地）はarchive/restoreで一切変更しないため、
--    call_blocklistの側は何も更新する必要がない（match_active_blocklistが
--    復元後も同じ条件で自動的に再評価するだけで、禁止状態は維持される）。
--    既に有効（archived_at is null）な企業への復元操作は、エラーにせず
--    同じ結果（status='already_active'）を安全に返す（冪等性）。
-- ---------------------------------------------------------
create or replace function public.restore_company(
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_target public.companies;
  v_updated public.companies;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_dup_company public.companies;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  if p_company_id is null then raise exception 'company_id_required'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.companies
    where id = p_company_id and organization_id = v_caller_org
    for update;
  if not found then raise exception 'company_not_found_in_your_organization'; end if;

  -- 既に有効なら、技術エラーにせず同じ状態を安全に返す（冪等）
  if v_target.archived_at is null then
    return jsonb_build_object('status','already_active','company',to_jsonb(v_target));
  end if;

  v_norm_phone := public.normalize_phone(v_target.phone);
  v_norm_domain := public.normalize_domain(v_target.website_url);
  v_norm_name := public.normalize_company_name(v_target.name);
  v_norm_location := public.normalize_location(v_target.location);

  -- 復元先の識別キーに対するregistration locksを取得し、他の作成/更新/復元と直列化する
  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  -- 現在有効な他企業との重複を再確認する（対象自身は除外）
  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org and c.id <> p_company_id and c.archived_at is null
      and (
        (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
        or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
        or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
      )
    limit 1;

  if found then
    return jsonb_build_object('status','duplicate_conflict','conflicting_company_id',v_dup_company.id);
  end if;

  update public.companies set
    archived_at = null,
    archived_by = null,
    updated_by = v_caller
  where id = p_company_id
  returning * into v_updated;

  return jsonb_build_object('status','restored','company',to_jsonb(v_updated));
end;
$$;

revoke all on function public.restore_company(uuid) from public, anon, authenticated;
grant execute on function public.restore_company(uuid) to authenticated;

-- ---------------------------------------------------------
-- 23. check_company_safety() の重複候補検索4箇所に archived_at is null を追加
--    （読み取り専用の事前確認RPC。create_company_checked / update_company_checked
--    と重複判定の対象範囲を一致させるための整合性維持のみが目的で、
--    禁止判定(block_matches)のロジックは一切変更しない）。
-- ---------------------------------------------------------
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
    where c.organization_id = v_caller_org and c.archived_at is null
      and v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','phone','company_id',v_dup_phone.id));
  end if;

  select c.* into v_dup_domain from public.companies c
    where c.organization_id = v_caller_org and c.archived_at is null
      and v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain
      and (v_dup_phone.id is null or c.id <> v_dup_phone.id) limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','domain','company_id',v_dup_domain.id));
  end if;

  select c.* into v_dup_name_location from public.companies c
    where c.organization_id = v_caller_org and c.archived_at is null
      and v_norm_name <> '' and v_norm_location <> ''
      and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location
      and c.id not in (select x from unnest(array[v_dup_phone.id, v_dup_domain.id]) x where x is not null) limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('tier','name_location','company_id',v_dup_name_location.id));
  end if;

  select c.* into v_dup_name from public.companies c
    where c.organization_id = v_caller_org and c.archived_at is null
      and v_norm_name <> ''
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

-- ---------------------------------------------------------
-- 24. companies_with_call_status ビューへ archived_at/archived_by/updated_by を追加
--    （既存オブジェクトの変更）。
--
--    【重要な訂正】このビューは `select c.*, ...` という定義だが、`c.*` は
--    ビュー作成時点で実列名の一覧へ展開され、ビュー定義（pg_rewrite）に
--    固定される。companiesへ後から列を追加しても、ビュー側は自動的には
--    反映されない（ビューを明示的に作り直さない限り、新しい列はSELECT結果に
--    現れない）。そのため、このマイグレーションのcompaniesへのADD COLUMNだけ
--    では companies_with_call_status経由（本番のloadCRMData()が使う経路）で
--    archived_at等を取得できず、フロントエンドは常にarchived_atが無い状態
--    として企業を扱ってしまう（アーカイブ機能が実質的に機能しない）。
--
--    【重要：CREATE OR REPLACE VIEWを使わない理由】
--    本番環境と、schema.sqlだけで作る新規環境とでは、companies.emailの
--    物理的な列順序が異なる。本番ではemailを add-company-email-column.sql
--    （ALTER TABLE ADD COLUMN email）で後から追加したため、実際の物理列順は
--    …, updated_at, email（一番最後）。一方、新規プロジェクト用schema.sqlの
--    CREATE TABLE文ではemailをlist_sourceの直後に読みやすく記述しているため、
--    新規環境ではemailがその位置に来る。CREATE OR REPLACE VIEWは「既存の列は
--    同じ名前・同じ順序・同じ型のまま残し、新しい列は末尾にしか追加できない」
--    という制約があるため、どちらか一方の環境に列順を合わせて固定してしまうと、
--    もう一方の環境でREPLACEが失敗する（本番実機で実際に検証し、本番の物理列
--    順は「…, updated_at, email」であることを確認済み）。
--    そのため、CREATE OR REPLACE VIEWではなく、まずビューを一旦DROPしてから
--    （CASCADEは使わない。事前にpg_depend等で依存オブジェクトが無いことを
--    本番で確認済み）、列順の制約を受けないCREATE VIEWで明示的な列挙により
--    作り直す。列順は「本番の実際の物理列順」を正とし、archived_at/
--    archived_by/updated_byは列挙の一番最後に追加する。
-- ---------------------------------------------------------
drop view if exists public.companies_with_call_status;

create view public.companies_with_call_status
with (
  security_barrier = true,
  security_invoker = true
)
as
select
  c.id, c.organization_id, c.name, c.industry, c.location, c.phone, c.website_url,
  c.source_url, c.list_source, c.contact_name, c.contact_department, c.heat,
  c.owner_id, c.memo, c.last_called_at, c.next_action_at, c.created_at, c.updated_at,
  c.email,
  (m.blocklist_id is not null) as call_prohibited,
  m.blocklist_id,
  m.matched_scope as blocked_scope,
  m.reason as blocked_reason,
  c.archived_at, c.archived_by, c.updated_by
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
