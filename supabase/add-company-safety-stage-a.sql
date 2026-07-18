-- =========================================================
-- CallFlow CRM: 企業安全管理（重複検出・架電禁止）段階A
-- 既存オブジェクトの削除・再作成は最小限（下記2件のみ）で、それ以外は追加のみです。
--
-- 既存オブジェクトへの変更（この2件のみ）：
--   1. public.record_call() の置き換え（署名・返り値・security invoker は維持）
--   2. call_logs.company_id の外部キーを ON DELETE CASCADE → ON DELETE RESTRICT へ
-- 上記以外の既存テーブル・既存RLSポリシー・public.current_organization_id()の
-- ロジックは削除・変更しません（current_organization_id()はsearch_path等の
-- ハードニングのみ、ロジックは無変更でCREATE OR REPLACEします）。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- このSQLは2回連続で実行しても安全なように作られています。
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 0. 正規化関数（電話番号・ドメイン・企業名・所在地）
--    既存のsrc/lib/csv-import.tsのnormalizePhone/urlDomain/normalizeNameと
--    同等のロジックをSQL側にも持たせ、DB内の照合で共通利用する。
-- ---------------------------------------------------------

create or replace function public.normalize_phone(p_raw text) returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.translate(coalesce(p_raw, ''), '０１２３４５６７８９－ー―', '0123456789---'),
    '[^0-9]', '', 'g'
  )
$$;

create or replace function public.normalize_domain(p_raw text) returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(coalesce(p_raw, ''))), '^https?://', ''),
      '^www\.', ''
    ),
    '[/?#].*$', ''
  )
$$;

create or replace function public.normalize_company_name(p_raw text) returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.translate(pg_catalog.btrim(coalesce(p_raw, '')), '　', ' '), '\s+', '', 'g'
  ))
$$;

create or replace function public.normalize_location(p_raw text) returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.translate(pg_catalog.btrim(coalesce(p_raw, '')), '　', ' '), '\s+', '', 'g'
  ))
$$;

-- 正規化関数は入力のみに依存する読み取り専用関数のため、public/anon/authenticatedへの
-- 実行制限は行わない（PostgreSQLの既定でPUBLICに実行権限があり、これは安全側の情報しか
-- 扱わないため問題ない）。ただし明示性のため、authenticatedへの実行権限だけ明記しておく。
grant execute on function public.normalize_phone(text) to authenticated;
grant execute on function public.normalize_domain(text) to authenticated;
grant execute on function public.normalize_company_name(text) to authenticated;
grant execute on function public.normalize_location(text) to authenticated;

-- ---------------------------------------------------------
-- 1. call_blocklist（架電禁止の唯一の正本）
-- ---------------------------------------------------------
create table public.call_blocklist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,

  -- 元データのスナップショット（企業が削除・変更されても消えない）
  snapshot_name text,
  snapshot_location text,
  snapshot_phone text,
  snapshot_domain text,

  -- 正規化済み照合キー
  normalized_name text,
  normalized_location text,
  normalized_phone text,
  normalized_domain text,

  -- 'strict' = 電話/ドメイン/名前+所在地のみで照合。'name_only' = 管理者が明示的に選んだ場合だけ
  match_scope text not null default 'strict' check (match_scope in ('phone','domain','name_location','name_only','strict')),

  reason text not null,
  note text not null default '',
  active boolean not null default true,

  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),

  constraint call_blocklist_has_identifier check (
    normalized_phone is not null
    or normalized_domain is not null
    or (normalized_name is not null and normalized_location is not null)
    or (match_scope = 'name_only' and normalized_name is not null)
  )
);

create index call_blocklist_org_idx on public.call_blocklist(organization_id);
create index call_blocklist_company_idx on public.call_blocklist(company_id) where company_id is not null;

-- 同じ禁止キーの多重登録防止：有効な行は識別子ごとに常に1件だけ
create unique index call_blocklist_phone_unique
  on public.call_blocklist(organization_id, normalized_phone)
  where active and normalized_phone is not null;
create unique index call_blocklist_domain_unique
  on public.call_blocklist(organization_id, normalized_domain)
  where active and normalized_domain is not null;
create unique index call_blocklist_name_location_unique
  on public.call_blocklist(organization_id, normalized_name, normalized_location)
  where active and normalized_name is not null and normalized_location is not null and match_scope <> 'name_only';
create unique index call_blocklist_name_only_unique
  on public.call_blocklist(organization_id, normalized_name)
  where active and match_scope = 'name_only';

alter table public.call_blocklist enable row level security;

create policy "org members read call_blocklist" on public.call_blocklist
  for select to authenticated
  using (organization_id = public.current_organization_id());

-- クライアントからの直接書き込みは一切不可。すべてRPC経由
revoke all on table public.call_blocklist from public, anon, authenticated;
grant select on table public.call_blocklist to authenticated;

-- ---------------------------------------------------------
-- 2. call_blocklist_audit（append-only監査ログ）
-- ---------------------------------------------------------
create table public.call_blocklist_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  blocklist_id uuid not null references public.call_blocklist(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  action text not null check (action in ('blocked','unblocked')),
  snapshot_name text,
  snapshot_location text,
  snapshot_phone text,
  snapshot_domain text,
  normalized_name text,
  normalized_location text,
  normalized_phone text,
  normalized_domain text,
  match_scope text,
  reason text not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index call_blocklist_audit_blocklist_idx on public.call_blocklist_audit(blocklist_id);
create index call_blocklist_audit_org_idx on public.call_blocklist_audit(organization_id);

alter table public.call_blocklist_audit enable row level security;
create policy "org members read call_blocklist_audit" on public.call_blocklist_audit
  for select to authenticated
  using (organization_id = public.current_organization_id());

-- クライアントからの直接書き込みは一切不可。追加はblock/unblock RPC内部だけ
revoke all on table public.call_blocklist_audit from public, anon, authenticated;
grant select on table public.call_blocklist_audit to authenticated;

-- ---------------------------------------------------------
-- 3. match_active_blocklist()：架電禁止判定の唯一の共通関数
--    該当する有効な禁止設定があれば1行、無ければ0行を返す。
--    security invoker（既定）：call_blocklistの既存SELECT RLSがそのまま適用される。
-- ---------------------------------------------------------
create or replace function public.match_active_blocklist(
  p_organization_id uuid, p_phone text, p_domain text, p_name text, p_location text
) returns table(blocklist_id uuid, matched_scope text, reason text)
language sql
stable
set search_path = ''
as $$
  select b.id, mt.scope, b.reason
  from public.call_blocklist b
  cross join lateral (
    select case
      when p_phone <> '' and b.normalized_phone = p_phone then 'phone'
      when p_domain <> '' and b.normalized_domain = p_domain then 'domain'
      when b.match_scope <> 'name_only' and p_location <> '' and p_name <> ''
        and b.normalized_name = p_name and b.normalized_location = p_location then 'name_location'
      when b.match_scope = 'name_only' and p_name <> '' and b.normalized_name = p_name then 'name_only'
    end as scope
  ) mt
  where b.organization_id = p_organization_id and b.active and mt.scope is not null
  order by case mt.scope when 'phone' then 1 when 'domain' then 2 when 'name_location' then 3 else 4 end
  limit 1
$$;

revoke all on function public.match_active_blocklist(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.match_active_blocklist(uuid,text,text,text,text) to authenticated;

-- ---------------------------------------------------------
-- 4. 組織単位のロック関数（record_call / block_company_calls / unblock_company_callsが
--    まったく同じ方式・同じキーで直列化するための共通関数）
--
--    【重要】public.organizationsに対するSELECT ... FOR UPDATEは、authenticatedロールに
--    UPDATE系の権限が無いため permission denied for table organizations で失敗することを
--    ローカルの隔離Postgres環境で実証済み（authenticatedにはSELECTポリシーしか無く、
--    UPDATEポリシー・UPDATE権限を一般メンバーへ追加することは今回禁止されているため）。
--    そのため、行ロックの代わりにトランザクション単位のadvisory lockを採用する。
--    record_call()はSECURITY INVOKERを維持するため、この関数はauthenticatedへ実行権限を
--    付与する（advisory lock自体はテーブル権限を必要としないPostgresの組み込み機能）。
-- ---------------------------------------------------------
create or replace function public.acquire_organization_lock(p_organization_id uuid) returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
$$;

revoke all on function public.acquire_organization_lock(uuid) from public, anon, authenticated;
grant execute on function public.acquire_organization_lock(uuid) to authenticated;

-- ---------------------------------------------------------
-- 5. 企業登録時の複数キーadvisory lock（電話・ドメイン・企業名+所在地のうち
--    存在するものすべてを、常に同じ昇順で取得しデッドロックを防ぐ）。
--    security definer関数の内部だけから呼ばれるため、外部への実行権限は一切付与しない。
-- ---------------------------------------------------------
create or replace function public.acquire_registration_locks(
  p_organization_id uuid, p_phone text, p_domain text, p_name text, p_location text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_keys bigint[] := '{}';
  v_key bigint;
begin
  if p_phone <> '' then
    v_keys := array_append(v_keys, pg_catalog.hashtextextended(p_organization_id::text || ':phone:' || p_phone, 0));
  end if;
  if p_domain <> '' then
    v_keys := array_append(v_keys, pg_catalog.hashtextextended(p_organization_id::text || ':domain:' || p_domain, 0));
  end if;
  if p_name <> '' and p_location <> '' then
    v_keys := array_append(v_keys, pg_catalog.hashtextextended(p_organization_id::text || ':name_loc:' || p_name || '|' || p_location, 0));
  end if;
  if pg_catalog.array_length(v_keys, 1) is null then
    return;
  end if;
  select pg_catalog.array_agg(k order by k) into v_keys from pg_catalog.unnest(v_keys) as k;
  foreach v_key in array v_keys loop
    perform pg_catalog.pg_advisory_xact_lock(v_key);
  end loop;
end;
$$;

revoke all on function public.acquire_registration_locks(uuid,text,text,text,text) from public, anon, authenticated;
-- 外部への実行権限は付与しない（security definer関数の内部専用）

-- ---------------------------------------------------------
-- 6. companies_with_call_status：SECURITY INVOKERビュー
--    companies / call_blocklist それぞれの既存RLSがそのまま適用される。
--    同じ企業に複数の一致理由があっても、match_active_blocklistがLIMIT 1で
--    1件だけ返すため、企業行が重複表示されることはない。
-- ---------------------------------------------------------
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

-- 実運用のSupabaseはALTER DEFAULT PRIVILEGESでanon/authenticatedへ新規オブジェクトの
-- SELECT/INSERT/UPDATE/DELETEを自動付与するため、他の新規オブジェクトと同様に
-- authenticatedも含めて明示的にrevokeしてからSELECTのみ付与し直す。
revoke all on public.companies_with_call_status from public, anon, authenticated;
grant select on public.companies_with_call_status to authenticated;

-- ---------------------------------------------------------
-- 7. check_company_safety()：読み取り専用の事前確認RPC
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

-- ---------------------------------------------------------
-- 8. create_company_checked()：確認と保存を1トランザクションで統一
-- ---------------------------------------------------------
create or replace function public.create_company_checked(
  p_name text, p_phone text, p_website_url text, p_location text,
  p_industry text default '', p_contact_name text default '', p_email text default null,
  p_memo text default '', p_list_source text default null,
  p_on_duplicate text default 'skip',          -- 'skip' | 'update' | 'insert'
  p_acknowledge_blocklist boolean default false
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
  -- 1. 認証確認
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  -- 2. 所属組織の仮取得
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  -- 3. 入力値の正規化
  v_norm_phone := public.normalize_phone(p_phone);
  v_norm_domain := public.normalize_domain(p_website_url);
  v_norm_name := public.normalize_company_name(p_name);
  v_norm_location := public.normalize_location(p_location);

  -- 4. registration advisory lock（適用可能な全キーを昇順で取得）
  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  -- 呼び出し元profileを再取得し、active状態を確認
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  if v_norm_name = '' then raise exception 'name_required'; end if;

  -- 5. 最新状態で禁止先照合
  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
  if found and not p_acknowledge_blocklist then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  -- 6. 最新状態で重複候補照合
  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org
      and (
        (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
        or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
        or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
      )
    limit 1;

  -- 7. duplicate modeの検証
  if found and p_on_duplicate not in ('skip','update','insert') then
    raise exception 'invalid_on_duplicate';
  end if;

  -- 8. insert/update/skip/blockedを決定
  if found and p_on_duplicate = 'skip' then
    return jsonb_build_object('status','skipped','existing_company_id',v_dup_company.id);
  end if;
  if found and p_on_duplicate = 'update' then
    return jsonb_build_object('status','needs_explicit_update','existing_company_id',v_dup_company.id);
  end if;

  -- 9. 書き込み
  insert into public.companies(
    organization_id, name, industry, location, phone, website_url, list_source,
    contact_name, email, memo, heat, owner_id
  ) values (
    v_caller_org, p_name, coalesce(p_industry,''), p_location, p_phone, nullif(p_website_url,''), p_list_source,
    coalesce(p_contact_name,''), p_email, coalesce(p_memo,''), '低', v_caller
  ) returning * into v_new_company;

  -- 10. 構造化結果を返す
  return jsonb_build_object('status','inserted','company',to_jsonb(v_new_company));
end;
$$;

revoke all on function public.create_company_checked(text,text,text,text,text,text,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.create_company_checked(text,text,text,text,text,text,text,text,text,text,boolean) to authenticated;

-- ---------------------------------------------------------
-- 9. update_company_checked()
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
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
  v_block record;
  v_dup_company public.companies;
  v_updated public.companies;
  v_forbidden_keys text[] := array['id','organization_id','owner_id','created_at','updated_at'];
  v_key text;
  v_safe_patch jsonb;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  select * into v_target from public.companies where id = p_company_id and organization_id = v_caller_org;
  if not found then raise exception 'company_not_found_in_your_organization'; end if;

  -- クライアントが自由に変更すべきでない列をpatchから除外する
  v_safe_patch := p_patch;
  foreach v_key in array v_forbidden_keys loop
    v_safe_patch := v_safe_patch - v_key;
  end loop;

  v_new_name := coalesce(v_safe_patch->>'name', v_target.name);
  v_new_phone := coalesce(v_safe_patch->>'phone', v_target.phone);
  v_new_website_url := coalesce(v_safe_patch->>'website_url', v_target.website_url);
  v_new_location := coalesce(v_safe_patch->>'location', v_target.location);

  v_norm_phone := public.normalize_phone(v_new_phone);
  v_norm_domain := public.normalize_domain(v_new_website_url);
  v_norm_name := public.normalize_company_name(v_new_name);
  v_norm_location := public.normalize_location(v_new_location);

  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  -- 更新後の値で禁止・重複判定
  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
  if found then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  -- 対象企業自身を重複候補から除外する
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
    -- 明示的な処理方針（'insert'=別企業として続行を承知のうえで更新）が無ければ更新しない
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

-- ---------------------------------------------------------
-- 10. create_companies_checked()：CSV一括登録の部分成功方式
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
  v_sqlstate text;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_idx := v_idx + 1;
    begin  -- PL/pgSQLの例外ブロックはSAVEPOINT相当。1行の失敗が他行を巻き込まない
      v_norm_phone := public.normalize_phone(v_row->>'phone');
      v_norm_domain := public.normalize_domain(v_row->>'website_url');
      v_norm_name := public.normalize_company_name(v_row->>'name');
      v_norm_location := public.normalize_location(v_row->>'location');
      v_on_duplicate := coalesce(v_row->>'on_duplicate', p_default_on_duplicate);

      if v_norm_name = '' then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'name_required');
        v_results := v_results || jsonb_build_array(v_row_result);
        continue;
      end if;

      -- 複数キーを昇順ロック
      perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

      -- CSV内重複（このバッチ内で既に処理済みの行と比較）
      if (v_norm_phone <> '' and v_norm_phone = any(v_seen_phones))
         or (v_norm_domain <> '' and v_norm_domain = any(v_seen_domains))
         or (v_norm_name <> '' and v_norm_location <> '' and (v_norm_name||'|'||v_norm_location) = any(v_seen_name_locs)) then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'skipped', 'reason', 'duplicate_within_csv');
        v_results := v_results || jsonb_build_array(v_row_result);
        continue;
      end if;

      -- 架電禁止照合：バルク登録では既定でblocked
      select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
      if found then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'blocked', 'blocklist_id', v_block.blocklist_id, 'matched_scope', v_block.matched_scope);
        v_results := v_results || jsonb_build_array(v_row_result);
        if v_norm_phone <> '' then v_seen_phones := array_append(v_seen_phones, v_norm_phone); end if;
        if v_norm_domain <> '' then v_seen_domains := array_append(v_seen_domains, v_norm_domain); end if;
        if v_norm_name <> '' and v_norm_location <> '' then v_seen_name_locs := array_append(v_seen_name_locs, v_norm_name||'|'||v_norm_location); end if;
        continue;
      end if;

      -- 重複候補照合（指定されたduplicate modeに従う）
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
        update public.companies set
          name = coalesce(nullif(v_row->>'name',''), name),
          phone = coalesce(nullif(v_row->>'phone',''), phone),
          website_url = coalesce(nullif(v_row->>'website_url',''), website_url),
          location = coalesce(nullif(v_row->>'location',''), location),
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
      -- トランザクション全体を再試行すべき障害は行エラーへ握りつぶさず、そのまま再送出する
      when deadlock_detected or lock_not_available or query_canceled or serialization_failure then
        raise;
      when others then
        get stacked diagnostics v_sqlstate = returned_sqlstate;
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', v_sqlstate, 'error_message', sqlerrm);
        v_results := v_results || jsonb_build_array(v_row_result);
    end;
  end loop;

  return jsonb_build_object('results', v_results);
end;
$$;

revoke all on function public.create_companies_checked(jsonb,text) from public, anon, authenticated;
grant execute on function public.create_companies_checked(jsonb,text) to authenticated;

-- ---------------------------------------------------------
-- 11. block_company_calls() / unblock_company_calls()：管理者専用
-- ---------------------------------------------------------
create or replace function public.block_company_calls(
  p_company_id uuid default null,
  p_phone text default null,
  p_website_url text default null,
  p_name text default null,
  p_location text default null,
  p_match_scope text default 'strict',
  p_reason text default null
) returns public.call_blocklist
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_company public.companies;
  v_entry public.call_blocklist;
  v_norm_phone text; v_norm_domain text; v_norm_name text; v_norm_location text;
begin
  -- 1. 認証確認
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then raise exception 'reason_required'; end if;

  -- 2. 呼び出し元組織の仮取得
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  -- 3. 組織ロック取得
  perform public.acquire_organization_lock(v_caller_org);

  -- 4-5. profile再取得・active/admin/組織一致を再確認
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  -- 6. 対象企業または入力キーを再取得・正規化
  if p_company_id is not null then
    select * into v_company from public.companies where id = p_company_id and organization_id = v_caller_org;
    if not found then raise exception 'company_not_found_in_your_organization'; end if;
    v_norm_phone := public.normalize_phone(v_company.phone);
    v_norm_domain := public.normalize_domain(v_company.website_url);
    v_norm_name := public.normalize_company_name(v_company.name);
    v_norm_location := public.normalize_location(v_company.location);
  else
    v_norm_phone := public.normalize_phone(coalesce(p_phone,''));
    v_norm_domain := public.normalize_domain(coalesce(p_website_url,''));
    v_norm_name := public.normalize_company_name(coalesce(p_name,''));
    v_norm_location := public.normalize_location(coalesce(p_location,''));
  end if;

  if v_norm_phone = '' and v_norm_domain = '' and not (v_norm_name <> '' and (v_norm_location <> '' or p_match_scope = 'name_only')) then
    raise exception 'identifier_required';
  end if;

  -- 7. 最新の禁止状態を確認（同じ有効な行が既にあれば安全に返す＝繰り返し操作対策）
  select * into v_entry from public.call_blocklist
    where organization_id = v_caller_org and active
      and (
        (v_norm_phone <> '' and normalized_phone = v_norm_phone)
        or (v_norm_domain <> '' and normalized_domain = v_norm_domain)
        or (p_match_scope <> 'name_only' and v_norm_name <> '' and v_norm_location <> '' and normalized_name = v_norm_name and normalized_location = v_norm_location)
        or (p_match_scope = 'name_only' and v_norm_name <> '' and match_scope = 'name_only' and normalized_name = v_norm_name)
      )
    limit 1;
  if found then
    return v_entry; -- 既に禁止済み。安全に同じ行を返す
  end if;

  -- 8. call_blocklistへ追加
  insert into public.call_blocklist(
    organization_id, company_id, snapshot_name, snapshot_location, snapshot_phone, snapshot_domain,
    normalized_name, normalized_location, normalized_phone, normalized_domain,
    match_scope, reason, created_by, updated_by
  ) values (
    v_caller_org, p_company_id,
    coalesce(v_company.name, p_name), coalesce(v_company.location, p_location),
    coalesce(v_company.phone, p_phone), coalesce(v_company.website_url, p_website_url),
    nullif(v_norm_name,''), nullif(v_norm_location,''), nullif(v_norm_phone,''), nullif(v_norm_domain,''),
    p_match_scope, p_reason, v_caller, v_caller
  ) returning * into v_entry;

  -- 9. 監査履歴へ追加
  insert into public.call_blocklist_audit(
    organization_id, blocklist_id, company_id, action, reason, actor_id,
    snapshot_name, snapshot_location, snapshot_phone, snapshot_domain,
    normalized_name, normalized_location, normalized_phone, normalized_domain, match_scope
  ) values (
    v_caller_org, v_entry.id, p_company_id, 'blocked', p_reason, v_caller,
    v_entry.snapshot_name, v_entry.snapshot_location, v_entry.snapshot_phone, v_entry.snapshot_domain,
    v_entry.normalized_name, v_entry.normalized_location, v_entry.normalized_phone, v_entry.normalized_domain, v_entry.match_scope
  );

  -- 10. 結果を返す
  return v_entry;
exception
  when unique_violation then
    raise exception 'blocklist_entry_already_active';
end;
$$;

revoke all on function public.block_company_calls(uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.block_company_calls(uuid,text,text,text,text,text,text) to authenticated;


create or replace function public.unblock_company_calls(
  p_blocklist_id uuid, p_reason text default null
) returns public.call_blocklist
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_entry public.call_blocklist;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  if p_blocklist_id is null then raise exception 'blocklist_id_required'; end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then raise exception 'reason_required'; end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  -- 対象組織以外のblocklist_idは、organization_id条件で最初から見えない
  select * into v_entry from public.call_blocklist
    where id = p_blocklist_id and organization_id = v_caller_org and active
    for update;
  if not found then
    raise exception 'blocklist_entry_not_found';
  end if;

  update public.call_blocklist
    set active = false, updated_by = v_caller, updated_at = pg_catalog.now()
    where id = p_blocklist_id
    returning * into v_entry;

  insert into public.call_blocklist_audit(
    organization_id, blocklist_id, company_id, action, reason, actor_id,
    snapshot_name, snapshot_location, snapshot_phone, snapshot_domain,
    normalized_name, normalized_location, normalized_phone, normalized_domain, match_scope
  ) values (
    v_caller_org, v_entry.id, v_entry.company_id, 'unblocked', p_reason, v_caller,
    v_entry.snapshot_name, v_entry.snapshot_location, v_entry.snapshot_phone, v_entry.snapshot_domain,
    v_entry.normalized_name, v_entry.normalized_location, v_entry.normalized_phone, v_entry.normalized_domain, v_entry.match_scope
  );

  return v_entry;
end;
$$;

revoke all on function public.unblock_company_calls(uuid,text) from public, anon, authenticated;
grant execute on function public.unblock_company_calls(uuid,text) to authenticated;

-- ---------------------------------------------------------
-- 12. scan_duplicate_candidates()：読み取り専用・admin限定
-- ---------------------------------------------------------
create or replace function public.scan_duplicate_candidates()
returns table (company_id uuid, related_company_id uuid, match_tier text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true then
    raise exception 'not_authorized';
  end if;

  return query
    select a.id, b.id, 'phone'::text
    from public.companies a join public.companies b
      on b.organization_id = a.organization_id and b.id > a.id
      and public.normalize_phone(a.phone) <> '' and public.normalize_phone(a.phone) = public.normalize_phone(b.phone)
    where a.organization_id = v_caller_org
    union
    select a.id, b.id, 'domain'
    from public.companies a join public.companies b
      on b.organization_id = a.organization_id and b.id > a.id
      and public.normalize_domain(a.website_url) <> '' and public.normalize_domain(a.website_url) = public.normalize_domain(b.website_url)
    where a.organization_id = v_caller_org
    union
    select a.id, b.id, 'name_location'
    from public.companies a join public.companies b
      on b.organization_id = a.organization_id and b.id > a.id
      and public.normalize_company_name(a.name) = public.normalize_company_name(b.name)
      and public.normalize_location(a.location) <> '' and public.normalize_location(a.location) = public.normalize_location(b.location)
    where a.organization_id = v_caller_org
    union
    select a.id, b.id, 'name_only'
    from public.companies a join public.companies b
      on b.organization_id = a.organization_id and b.id > a.id
      and public.normalize_company_name(a.name) = public.normalize_company_name(b.name)
    where a.organization_id = v_caller_org;
end;
$$;

revoke all on function public.scan_duplicate_candidates() from public, anon, authenticated;
grant execute on function public.scan_duplicate_candidates() to authenticated;

-- ---------------------------------------------------------
-- 13. record_call() の置き換え（既存オブジェクト変更・その1）
--    署名・返り値・security invoker は維持。ロジックへ架電禁止チェックと
--    組織単位のadvisory lockを追加する。
-- ---------------------------------------------------------
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
  -- 1. 認証確認
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  -- 2. 呼び出し元組織の仮取得
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  -- 3. 組織ロック取得（block/unblock_company_callsと同じ方式・同じキー）
  perform public.acquire_organization_lock(v_caller_org);

  -- 4-5. profile再取得、active状態を再確認
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  -- 6. 対象企業を再取得（同じ組織であることも確認）
  select * into v_company from public.companies where id = p_company_id and organization_id = v_caller_org;
  if not found then raise exception 'company not found'; end if;

  -- 7. ロック取得後に架電禁止状態を再確認
  select * into v_block from public.match_active_blocklist(
    v_caller_org, public.normalize_phone(v_company.phone), public.normalize_domain(v_company.website_url),
    public.normalize_company_name(v_company.name), public.normalize_location(v_company.location));
  if found then raise exception 'call_prohibited'; end if;

  if p_result not in ('アポ獲得','資料送付','再架電','担当者不在','見込みなし','その他') then raise exception 'invalid result'; end if;
  if p_heat not in ('高','中','低') then raise exception 'invalid heat'; end if;

  -- 8-9. 書き込み。同一トランザクション内で完了
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

-- ---------------------------------------------------------
-- 14. call_logsへの直接INSERT対策（新規RESTRICTIVEポリシー1件のみ追加。
--    既存permissiveポリシー "organization members insert logs" は変更しない）
-- ---------------------------------------------------------
create policy "block call_logs insert for prohibited companies" on public.call_logs
  as restrictive
  for insert to authenticated
  with check (
    not exists (
      select 1 from public.match_active_blocklist(
        call_logs.organization_id,
        (select public.normalize_phone(c.phone) from public.companies c where c.id = call_logs.company_id),
        (select public.normalize_domain(c.website_url) from public.companies c where c.id = call_logs.company_id),
        (select public.normalize_company_name(c.name) from public.companies c where c.id = call_logs.company_id),
        (select public.normalize_location(c.location) from public.companies c where c.id = call_logs.company_id)
      )
    )
  );

-- ---------------------------------------------------------
-- 15. current_organization_id() の安全化（既存関数・ロジック無変更）
-- ---------------------------------------------------------
create or replace function public.current_organization_id() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select organization_id from public.profiles where id = auth.uid() and active = true
$$;

revoke all on function public.current_organization_id() from public, anon, authenticated;
grant execute on function public.current_organization_id() to authenticated;

-- ---------------------------------------------------------
-- 16. call_logs.company_id の外部キーをRESTRICTへ（既存オブジェクト変更・その2）
--    架電履歴のある企業は削除できなくする。制約名は決め打ちせず動的に特定する。
-- ---------------------------------------------------------
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
    foreign key (company_id) references public.companies(id) on delete restrict;
end;
$$;

commit;
