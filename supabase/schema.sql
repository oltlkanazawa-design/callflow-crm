-- CallFlow CRM 本番データベース
create extension if not exists "pgcrypto";

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  industry text not null default '', location text not null default '', phone text not null,
  website_url text, source_url text, list_source text, email text,
  contact_name text not null default '', contact_department text not null default '',
  heat text not null default '低' check (heat in ('高','中','低')),
  owner_id uuid references public.profiles(id) on delete set null,
  memo text not null default '', last_called_at timestamptz, next_action_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.call_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  caller_id uuid not null references public.profiles(id) on delete restrict,
  result text not null check (result in ('アポ獲得','資料送付','再架電','担当者不在','見込みなし','その他')),
  note text not null default '', transcript text, ai_summary text, ai_fields jsonb,
  next_action_at timestamptz, created_at timestamptz not null default now()
);

create index companies_org_idx on public.companies(organization_id);
create index companies_next_action_idx on public.companies(organization_id,next_action_at);
create index call_logs_org_created_idx on public.call_logs(organization_id,created_at desc);
create index call_logs_company_idx on public.call_logs(company_id);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end $$;
create trigger companies_set_updated_at before update on public.companies for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.call_logs enable row level security;

create or replace function public.current_organization_id() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select organization_id from public.profiles where id = auth.uid() and active = true
$$;

revoke all on function public.current_organization_id() from public, anon, authenticated;
grant execute on function public.current_organization_id() to authenticated;

create policy "organization members read organization" on public.organizations for select using (id=public.current_organization_id());
create policy "organization members read profiles" on public.profiles for select using (organization_id=public.current_organization_id());
create policy "organization members read companies" on public.companies for select using (organization_id=public.current_organization_id());
create policy "organization members insert companies" on public.companies for insert with check (organization_id=public.current_organization_id());
create policy "organization members update companies" on public.companies for update using (organization_id=public.current_organization_id()) with check (organization_id=public.current_organization_id());
create policy "admins delete companies" on public.companies for delete using (organization_id=public.current_organization_id() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'));
create policy "organization members read logs" on public.call_logs for select using (organization_id=public.current_organization_id());
create policy "organization members insert logs" on public.call_logs for insert with check (organization_id=public.current_organization_id() and caller_id=auth.uid());
create policy "admins update logs" on public.call_logs for update using (organization_id=public.current_organization_id() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'));

-- 最初の組織と管理者は、Supabase Authenticationでユーザー作成後に以下を実行します。
-- insert into organizations(name) values ('OLTL') returning id;
-- insert into profiles(id,organization_id,full_name,role) values ('AUTH_USER_UUID','ORG_UUID','辻 保','admin');

-- 既にこのschema.sqlを実行済みの既存プロジェクトでは、emailカラムが無いため
-- add-company-email-column.sql を別途実行してください（このファイルは新規プロジェクト用）。


-- =========================================================
-- 企業安全管理（重複検出・架電禁止）
-- 以下は supabase/add-company-safety-stage-a.sql と同内容です。
-- 新規プロジェクトではこのschema.sqlの実行だけで完結しますが、
-- 既にこのファイルの旧版（企業安全管理を含まない版）を実行済みの
-- 既存プロジェクトでは、代わりに add-company-safety-stage-a.sql を
-- 別途実行してください。
-- =========================================================


-- ---------------------------------------------------------
-- 0. 正規化関数（電話番号・ドメイン・企業名・所在地）
--    既存のsrc/lib/csv-import.tsのnormalizePhone/urlDomain/normalizeNameと
--    同等のロジックをSQL側にも持たせ、DB内の照合で共通利用する。
--    企業名の正規化では、株式会社／(株)／（株）／㈱ などの法人格の表記揺れも
--    同一形式へ統一する（法人格そのものを削除すると誤検出が広がるため、
--    明確な表記差だけを吸収する）。
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

-- 法人格の表記揺れ（株式会社／(株)／（株）／㈱ など）を同一形式へ正規化してから
-- 空白除去・小文字化する。法人格そのものを削除すると別の企業と誤って一致する
-- 範囲が広がるため、明確な表記差だけを吸収する（TypeScript側のnormalizeName
-- と同じ変換内容・同じ優先順位で実装すること）。
create or replace function public.normalize_company_name(p_raw text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result text := pg_catalog.btrim(coalesce(p_raw, ''));
begin
  v_result := pg_catalog.regexp_replace(v_result, '\(株\)', '株式会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '（株）', '株式会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '㈱', '株式会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '\(有\)', '有限会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '（有）', '有限会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '㈲', '有限会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '\(同\)', '合同会社', 'g');
  v_result := pg_catalog.regexp_replace(v_result, '（同）', '合同会社', 'g');
  v_result := pg_catalog.translate(v_result, '　', ' ');
  v_result := pg_catalog.regexp_replace(v_result, '\s+', '', 'g');
  return pg_catalog.lower(v_result);
end;
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
--    match_scopeは次の意味に厳密に統一する：
--      phone         = 電話番号だけで一致
--      domain        = ドメインだけで一致
--      name_location = 企業名＋所在地だけで一致
--      name_only     = 企業名だけで一致（誤検出範囲が広いため管理者が明示的に選んだ場合だけ）
--      strict        = 電話・ドメイン・企業名+所在地のうち利用可能な強一致キーのいずれかで一致
--    正規化キーは、選択したmatch_scopeに必要な列だけを保存する
--    （strictのみ、利用可能な強一致キーをすべて保存する）。
-- ---------------------------------------------------------
create table public.call_blocklist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,

  -- 元データのスナップショット（企業が削除・変更されても消えない。scopeに関わらず保存する）
  snapshot_name text,
  snapshot_location text,
  snapshot_phone text,
  snapshot_domain text,

  -- 正規化済み照合キー（match_scopeに応じて必要な列だけをNOT NULLにする）
  normalized_name text,
  normalized_location text,
  normalized_phone text,
  normalized_domain text,

  match_scope text not null default 'strict' check (match_scope in ('phone','domain','name_location','name_only','strict')),

  reason text not null,
  note text not null default '',
  active boolean not null default true,

  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),

  -- match_scopeごとに、保存してよい正規化キーの組み合わせを厳密に制約する。
  -- 例えばphoneスコープの行にnormalized_domainが紛れ込むと、意図せずドメイン一致でも
  -- ヒットしてしまうため、スコープに無関係な列は必ずNULLでなければならない。
  constraint call_blocklist_scope_columns check (
    case match_scope
      when 'phone' then
        normalized_phone is not null
        and normalized_domain is null and normalized_name is null and normalized_location is null
      when 'domain' then
        normalized_domain is not null
        and normalized_phone is null and normalized_name is null and normalized_location is null
      when 'name_location' then
        normalized_name is not null and normalized_location is not null
        and normalized_phone is null and normalized_domain is null
      when 'name_only' then
        normalized_name is not null and normalized_location is null
        and normalized_phone is null and normalized_domain is null
      when 'strict' then
        normalized_phone is not null or normalized_domain is not null
        or (normalized_name is not null and normalized_location is not null)
      else false
    end
  )
);

create index call_blocklist_org_idx on public.call_blocklist(organization_id);
create index call_blocklist_company_idx on public.call_blocklist(company_id) where company_id is not null;

-- 同じ禁止キーの多重登録防止：有効な行は識別子ごとに常に1件だけ
-- （strictスコープの行も同じ列に値を持つため、同じインデックスで一意性を共有する）
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
--    保存されている列の非NULLだけに頼らず、match_scopeそのものも必ず確認する
--    （多層防御：スコープ列制約が万一破られても、ここで意図しない一致を防ぐ）。
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
      when b.match_scope in ('phone','strict') and p_phone <> '' and b.normalized_phone is not null
        and b.normalized_phone = p_phone then 'phone'
      when b.match_scope in ('domain','strict') and p_domain <> '' and b.normalized_domain is not null
        and b.normalized_domain = p_domain then 'domain'
      when b.match_scope in ('name_location','strict') and p_name <> '' and p_location <> ''
        and b.normalized_name is not null and b.normalized_location is not null
        and b.normalized_name = p_name and b.normalized_location = p_location then 'name_location'
      when b.match_scope = 'name_only' and p_name <> '' and b.normalized_name is not null
        and b.normalized_name = p_name then 'name_only'
    end as scope
  ) mt
  where b.organization_id = p_organization_id and b.active and mt.scope is not null
  order by case mt.scope when 'phone' then 1 when 'domain' then 2 when 'name_location' then 3 else 4 end
  limit 1
$$;

revoke all on function public.match_active_blocklist(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.match_active_blocklist(uuid,text,text,text,text) to authenticated;

-- ---------------------------------------------------------
-- 4. 組織単位のロック関数（企業を書き込む全RPCが、必ず最初にこの関数で
--    同じキーを取得し、直列化するための共通関数）
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
--    必ずacquire_organization_lock()の後に呼び出すこと。
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
--    security_invoker=trueを明示しないと、PostgreSQLの既定挙動により
--    ビュー所有者の権限でRLSが評価され、組織を越えて全件が見えてしまう
--    （2026-07-18、隔離テスト環境で実際に確認・修正）。
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
--    禁止先に一致した企業は、いかなる引数によっても登録を迂回できない
--    （p_acknowledge_blocklistのような迂回引数は存在しない）。
--    ロック順序：organization lock → profile再確認 → registration locks →
--                禁止状態・重複状態の再取得 → 書き込み
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
  -- 0. duplicate modeの検証（重複が見つかるかどうかに関わらず、最初に検証する）
  if p_on_duplicate not in ('skip','update','insert') then
    raise exception 'invalid_on_duplicate';
  end if;

  -- 1. 認証確認
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  -- 2. 所属組織の仮取得（ロックのキーを知るためだけの参照。書き込み判断には使わない）
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  -- 3. organization advisory lock（他の全書き込みRPCと共通のキー・共通の取得順）
  perform public.acquire_organization_lock(v_caller_org);

  -- 4. ロック取得後にprofileを再取得し、active状態を確認
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  if pg_catalog.btrim(coalesce(p_name,'')) = '' then raise exception 'name_required'; end if;

  -- 5. 入力値の正規化
  v_norm_phone := public.normalize_phone(p_phone);
  v_norm_domain := public.normalize_domain(p_website_url);
  v_norm_name := public.normalize_company_name(p_name);
  v_norm_location := public.normalize_location(p_location);

  -- 6. registration advisory lock（適用可能な全キーを昇順で取得）
  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  -- 7. ロック取得後、最新状態で禁止先照合。一致すれば理由の如何を問わず登録しない
  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
  if found then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  -- 8. 最新状態で重複候補照合
  select c.* into v_dup_company from public.companies c
    where c.organization_id = v_caller_org
      and (
        (v_norm_phone <> '' and public.normalize_phone(c.phone) = v_norm_phone)
        or (v_norm_domain <> '' and public.normalize_domain(c.website_url) = v_norm_domain)
        or (v_norm_location <> '' and public.normalize_company_name(c.name) = v_norm_name and public.normalize_location(c.location) = v_norm_location)
      )
    limit 1;

  -- 9. insert/skip/needs_explicit_updateを決定
  if found and p_on_duplicate = 'skip' then
    return jsonb_build_object('status','skipped','existing_company_id',v_dup_company.id);
  end if;
  if found and p_on_duplicate = 'update' then
    return jsonb_build_object('status','needs_explicit_update','existing_company_id',v_dup_company.id);
  end if;

  -- 10. 書き込み
  insert into public.companies(
    organization_id, name, industry, location, phone, website_url, list_source,
    contact_name, email, memo, heat, owner_id
  ) values (
    v_caller_org, p_name, coalesce(p_industry,''), p_location, p_phone, nullif(p_website_url,''), p_list_source,
    coalesce(p_contact_name,''), p_email, coalesce(p_memo,''), '低', v_caller
  ) returning * into v_new_company;

  -- 11. 構造化結果を返す
  return jsonb_build_object('status','inserted','company',to_jsonb(v_new_company));
end;
$$;

revoke all on function public.create_company_checked(text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_company_checked(text,text,text,text,text,text,text,text,text,text) to authenticated;

-- ---------------------------------------------------------
-- 9. update_company_checked()
--    ロック順序：organization lock → profile再確認 → 対象企業の再取得 →
--                registration locks → 禁止状態・重複状態の再取得 → 書き込み
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

  -- 5. ロック取得後に対象企業を再取得する（他の書き込みRPCも同じorganization lockを
  --    取得してからでないと対象企業を書き換えられないため、ここでの取得値は最新）
  select * into v_target from public.companies where id = p_company_id and organization_id = v_caller_org;
  if not found then raise exception 'company_not_found_in_your_organization'; end if;

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

  v_norm_phone := public.normalize_phone(v_new_phone);
  v_norm_domain := public.normalize_domain(v_new_website_url);
  v_norm_name := public.normalize_company_name(v_new_name);
  v_norm_location := public.normalize_location(v_new_location);

  -- 6. registration advisory lock
  perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

  -- 7. 更新後の実効値で禁止判定（空欄入力で既存の禁止一致キーを外して回避できないよう、
  --    パッチが空欄の項目は既存値を引き継いだ実効値で判定する）
  select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
  if found then
    return jsonb_build_object('status','blocked','blocklist_id',v_block.blocklist_id,'matched_scope',v_block.matched_scope,'reason',v_block.reason);
  end if;

  -- 8. 対象企業自身を除外して重複候補を再確認
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

  -- 9. 書き込み
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
--    organization advisory lockはバッチ開始時に1回だけ取得する（1行ごとに
--    取得し直さない）。長時間のバッチ中にアカウントが無効化されるケースを
--    検出できるよう、行ごとにactive状態を再確認する。
--    各行のon_duplicateは処理前に必ず検証し、不正な値はinsert扱いにせず
--    行単位のinvalid_on_duplicateエラーにする。
--    update時は「重複先企業をロック後に再取得→実効値を合成→正規化→
--    registration locks→実効値で禁止判定→重複再確認→更新」の順で処理し、
--    空欄入力で既存の禁止一致キーを外したまま更新できないようにする。
--    行エラーの結果には、安全なerror_codeのみを含め、Postgresの生エラー
--    メッセージ（制約名・テーブル名・SQL・データ型を含みうる）は含めない。
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
  -- 1. 認証確認
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  -- 2. 所属組織の仮取得
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  -- 3. organization advisory lock（バッチ全体で1回だけ）
  perform public.acquire_organization_lock(v_caller_org);

  -- 4. ロック取得後にprofileを再確認
  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.active <> true or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'account_inactive';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_idx := v_idx + 1;
    begin  -- PL/pgSQLの例外ブロックはSAVEPOINT相当。1行の失敗が他行を巻き込まない

      -- 長時間バッチ中のアカウント無効化を検出するため、行ごとに再確認する
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
        -- 1. 重複先企業をロック後に再取得（organization lockで直列化済みのため、
        --    ここでの再取得値が最新。行ロックも重ねて明示的に取得する）
        select * into v_dup_company from public.companies where id = v_dup_company.id for update;

        -- 2. CSVの値と既存値を統合し、更新後の実効値を作る
        --    （空欄のCSV項目は既存値のまま＝既存の禁止一致キーを空欄入力で
        --    外して禁止判定を回避できないようにする）
        v_eff_name := coalesce(nullif(v_row->>'name',''), v_dup_company.name);
        v_eff_phone := coalesce(nullif(v_row->>'phone',''), v_dup_company.phone);
        v_eff_website_url := coalesce(nullif(v_row->>'website_url',''), v_dup_company.website_url);
        v_eff_location := coalesce(nullif(v_row->>'location',''), v_dup_company.location);

        -- 3. 実効値を正規化
        v_norm_phone := public.normalize_phone(v_eff_phone);
        v_norm_domain := public.normalize_domain(v_eff_website_url);
        v_norm_name := public.normalize_company_name(v_eff_name);
        v_norm_location := public.normalize_location(v_eff_location);

        -- 4. 実効値に基づくregistration locksを取得
        perform public.acquire_registration_locks(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);

        -- 5. 実効値でmatch_active_blocklist()を実行
        select * into v_block from public.match_active_blocklist(v_caller_org, v_norm_phone, v_norm_domain, v_norm_name, v_norm_location);
        if found then
          -- 6. 禁止一致なら更新せずblockedを返す
          v_row_result := jsonb_build_object('row', v_idx, 'status', 'blocked', 'blocklist_id', v_block.blocklist_id, 'matched_scope', v_block.matched_scope);
          v_results := v_results || jsonb_build_array(v_row_result);
          if v_norm_phone <> '' then v_seen_phones := array_append(v_seen_phones, v_norm_phone); end if;
          if v_norm_domain <> '' then v_seen_domains := array_append(v_seen_domains, v_norm_domain); end if;
          if v_norm_name <> '' and v_norm_location <> '' then v_seen_name_locs := array_append(v_seen_name_locs, v_norm_name||'|'||v_norm_location); end if;
          continue;
        end if;

        -- 7. 重複状態を最新値で再確認（対象自身は除外）
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

        -- 8. 更新
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
      -- トランザクション全体を再試行すべき障害は行エラーへ握りつぶさず、そのまま再送出する
      when deadlock_detected or lock_not_available or query_canceled or serialization_failure then
        raise;
      -- Postgresの生メッセージ（制約名・テーブル名・SQL・データ型を含みうる）は
      -- 一切JSONへ入れず、安全な分類済みerror_codeだけを返す
      when unique_violation then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'duplicate_key');
        v_results := v_results || jsonb_build_array(v_row_result);
      when not_null_violation or check_violation or invalid_text_representation then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'invalid_value');
        v_results := v_results || jsonb_build_array(v_row_result);
      when string_data_right_truncation then
        v_row_result := jsonb_build_object('row', v_idx, 'status', 'error', 'error_code', 'value_too_long');
        v_results := v_results || jsonb_build_array(v_row_result);
      -- 意図的にWHEN OTHERSを置かない：上記で明示的に想定した業務エラー・制約エラー
      -- 以外（undefined_column/undefined_table/undefined_function/insufficient_privilege
      -- 等の未分類エラーを含む）は、行エラーへ変換せずそのまま呼び出し元へ再送出する
    end;
  end loop;

  return jsonb_build_object('results', v_results);
end;
$$;

revoke all on function public.create_companies_checked(jsonb,text) from public, anon, authenticated;
grant execute on function public.create_companies_checked(jsonb,text) to authenticated;

-- ---------------------------------------------------------
-- 11. block_company_calls() / unblock_company_calls()：管理者専用
--    p_match_scopeの意味を厳密に適用する。指定したscopeに必要な識別子が
--    空の場合は登録せずエラーにする（例：電話番号が空の企業をphoneスコープで
--    禁止することはできない）。正規化キーは、選択したscopeに必要な列だけを
--    保存する（strictのみ、利用可能な強一致キーをすべて保存する）。
--    unblock_company_calls()は同じblocklist_idを2回解除しても技術エラーに
--    せず、冪等に振る舞う。
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
  if p_match_scope not in ('phone','domain','name_location','name_only','strict') then
    raise exception 'invalid_match_scope';
  end if;

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

  -- 6. 対象企業または入力キーを、ロック取得後に再取得・正規化する
  --    （更新との競合により古い電話番号やドメインを禁止しないよう、companyは
  --    ここで初めて取得する）
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

  -- 7. scopeごとに必要な識別子が揃っているか検証する
  if p_match_scope = 'phone' and v_norm_phone = '' then raise exception 'phone_required_for_scope'; end if;
  if p_match_scope = 'domain' and v_norm_domain = '' then raise exception 'domain_required_for_scope'; end if;
  if p_match_scope = 'name_location' and (v_norm_name = '' or v_norm_location = '') then raise exception 'name_and_location_required_for_scope'; end if;
  if p_match_scope = 'name_only' and v_norm_name = '' then raise exception 'name_required_for_scope'; end if;
  if p_match_scope = 'strict' and v_norm_phone = '' and v_norm_domain = ''
     and not (v_norm_name <> '' and v_norm_location <> '') then
    raise exception 'identifier_required';
  end if;

  -- 8. 同じscopeで既に有効な禁止設定があれば、安全に同じ行を返す（繰り返し操作対策）
  select * into v_entry from public.call_blocklist
    where organization_id = v_caller_org and active and match_scope = p_match_scope
      and (
        (p_match_scope = 'phone' and normalized_phone = v_norm_phone)
        or (p_match_scope = 'domain' and normalized_domain = v_norm_domain)
        or (p_match_scope = 'name_location' and normalized_name = v_norm_name and normalized_location = v_norm_location)
        or (p_match_scope = 'name_only' and normalized_name = v_norm_name)
        or (p_match_scope = 'strict' and (
              (v_norm_phone <> '' and normalized_phone = v_norm_phone)
              or (v_norm_domain <> '' and normalized_domain = v_norm_domain)
              or (v_norm_name <> '' and v_norm_location <> '' and normalized_name = v_norm_name and normalized_location = v_norm_location)
           ))
      )
    limit 1;
  if found then
    return v_entry;
  end if;

  -- 9. call_blocklistへ追加（scopeに必要な正規化キーだけを保存する）
  insert into public.call_blocklist(
    organization_id, company_id, snapshot_name, snapshot_location, snapshot_phone, snapshot_domain,
    normalized_name, normalized_location, normalized_phone, normalized_domain,
    match_scope, reason, created_by, updated_by
  ) values (
    v_caller_org, p_company_id,
    coalesce(v_company.name, p_name), coalesce(v_company.location, p_location),
    coalesce(v_company.phone, p_phone), coalesce(v_company.website_url, p_website_url),
    case when p_match_scope in ('name_location','name_only','strict') then nullif(v_norm_name,'') else null end,
    case when p_match_scope in ('name_location','strict') then nullif(v_norm_location,'') else null end,
    case when p_match_scope in ('phone','strict') then nullif(v_norm_phone,'') else null end,
    case when p_match_scope in ('domain','strict') then nullif(v_norm_domain,'') else null end,
    p_match_scope, p_reason, v_caller, v_caller
  ) returning * into v_entry;

  -- 10. 監査履歴へ追加
  insert into public.call_blocklist_audit(
    organization_id, blocklist_id, company_id, action, reason, actor_id,
    snapshot_name, snapshot_location, snapshot_phone, snapshot_domain,
    normalized_name, normalized_location, normalized_phone, normalized_domain, match_scope
  ) values (
    v_caller_org, v_entry.id, p_company_id, 'blocked', p_reason, v_caller,
    v_entry.snapshot_name, v_entry.snapshot_location, v_entry.snapshot_phone, v_entry.snapshot_domain,
    v_entry.normalized_name, v_entry.normalized_location, v_entry.normalized_phone, v_entry.normalized_domain, v_entry.match_scope
  );

  -- 11. 結果を返す
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

  -- 対象組織以外・存在しないblocklist_idはnot foundとして扱う（activeかどうかは問わない。
  -- 冪等な解除を許可するため）
  select * into v_entry from public.call_blocklist
    where id = p_blocklist_id and organization_id = v_caller_org
    for update;
  if not found then
    raise exception 'blocklist_entry_not_found';
  end if;

  -- 既に解除済みなら、技術エラーにせず同じ行を安全に返す（監査ログは重複追加しない）
  if not v_entry.active then
    return v_entry;
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
  -- organization_id・role・activeを1回のSELECTで同一スナップショットから取得し、
  -- 判定の途中でプロフィール所属が変わる余地（TOCTOU）を無くす
  select * into v_caller_profile from public.profiles where id = v_caller;
  if not found or v_caller_profile.organization_id is null
     or v_caller_profile.role <> 'admin' or v_caller_profile.active <> true then
    raise exception 'not_authorized';
  end if;
  v_caller_org := v_caller_profile.organization_id;

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
--    組織単位のadvisory lockを追加する（他の全書き込みRPCと同じ順序・同じキー）。
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

  -- 3. 組織ロック取得（block/unblock_company_calls・create/update系と同じ方式・同じキー）
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
--    既存permissiveポリシー "organization members insert logs" は変更しない）。
--    company_idが指すcompanyが、call_logs.organization_idと同じ組織に
--    属していることも必須条件に含める（他組織企業のUUIDをcompany_idへ
--    指定した直接INSERTを拒否するため）。
-- ---------------------------------------------------------
create policy "block call_logs insert for prohibited companies" on public.call_logs
  as restrictive
  for insert to authenticated
  with check (
    exists (
      select 1 from public.companies c
      where c.id = call_logs.company_id and c.organization_id = call_logs.organization_id
    )
    and not exists (
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



-- =========================================================
-- 企業詳細・編集・アーカイブ管理
-- 以下は supabase/add-company-detail-edit-archive.sql と同内容です。
-- 新規プロジェクトではこのschema.sqlの実行だけで完結しますが、
-- 既にこのファイルの旧版（企業詳細・編集・アーカイブ管理を含まない版）を
-- 実行済みの既存プロジェクトでは、代わりに add-company-detail-edit-archive.sql を
-- 別途実行してください。
-- =========================================================

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
--    反映されない（`create or replace view` などでビューを明示的に
--    作り直さない限り、新しい列はSELECT結果に現れない）。
--    そのため、このマイグレーションのcompaniesへのADD COLUMNだけでは
--    companies_with_call_status経由（本番のloadCRMData()が使う経路）で
--    archived_at等を取得できず、フロントエンドは常にarchived_atが
--    無い状態として企業を扱ってしまう（アーカイブ機能が実質的に機能しない）。
--
--    `create or replace view` は「既存の列は同じ名前・同じ順序・同じ型で
--    残し、新しい列は末尾にしか追加できない」という制約があるため、
--    `c.*` を使い続けたまま新しい列を追加すると、companies側で新しく
--    増えた列（archived_at等）がcall_prohibited等より前に挿入されてしまい、
--    既存列の並びが変わってREPLACEに失敗する。これを避けるため、companies
--    由来の列は `c.*` ではなく、元のビュー定義時点の列を明示的に同じ順序で
--    列挙し、archived_at/archived_by/updated_byは列挙の一番最後に追加する。
-- ---------------------------------------------------------
create or replace view public.companies_with_call_status
with (
  security_barrier = true,
  security_invoker = true
)
as
select
  c.id, c.organization_id, c.name, c.industry, c.location, c.phone, c.website_url,
  c.source_url, c.list_source, c.email, c.contact_name, c.contact_department, c.heat,
  c.owner_id, c.memo, c.last_called_at, c.next_action_at, c.created_at, c.updated_at,
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
