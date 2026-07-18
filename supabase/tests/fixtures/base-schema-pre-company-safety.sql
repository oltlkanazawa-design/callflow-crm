-- =========================================================
-- テスト専用フィクスチャ：企業安全管理（PR1）着手前のschema.sql相当
--
-- 「既存プロジェクトに add-company-safety-stage-a.sql を追加適用する」
-- （経路B）を検証するためだけに使う、CI専用の基準スキーマ。
-- 本番運用のどの時点のスキーマとも厳密には同一ではない可能性があるため、
-- 本番マイグレーションとしては使用しないこと。
--
-- current_organization_id() / record_call() は、企業安全管理PR以前の
-- ハードニング前ロジック（search_path=public、明示的なrevoke/grant無し）
-- のまま。stage-A適用時にこれらがCREATE OR REPLACEで安全化されることを
-- 確認するのが、このフィクスチャを使う目的の一つ。
-- =========================================================

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
  company_id uuid not null references public.companies(id) on delete cascade,
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

create or replace function public.current_organization_id() returns uuid language sql stable security definer set search_path=public as $$
  select organization_id from public.profiles where id=auth.uid() and active=true
$$;

create policy "organization members read organization" on public.organizations for select using (id=public.current_organization_id());
create policy "organization members read profiles" on public.profiles for select using (organization_id=public.current_organization_id());
create policy "organization members read companies" on public.companies for select using (organization_id=public.current_organization_id());
create policy "organization members insert companies" on public.companies for insert with check (organization_id=public.current_organization_id());
create policy "organization members update companies" on public.companies for update using (organization_id=public.current_organization_id()) with check (organization_id=public.current_organization_id());
create policy "admins delete companies" on public.companies for delete using (organization_id=public.current_organization_id() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'));
create policy "organization members read logs" on public.call_logs for select using (organization_id=public.current_organization_id());
create policy "organization members insert logs" on public.call_logs for insert with check (organization_id=public.current_organization_id() and caller_id=auth.uid());
create policy "admins update logs" on public.call_logs for update using (organization_id=public.current_organization_id() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'));

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
