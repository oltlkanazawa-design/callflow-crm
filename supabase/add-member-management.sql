-- =========================================================
-- CallFlow CRM: メンバー管理・招待制ログイン（最終ハードニング版）
-- 既存オブジェクトの削除・再作成は一切行いません。
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- このSQLは2回連続で実行しても安全なように作られています。
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. profiles.email（順序固定：追加→トリガー→バックフィル→重複確認→インデックス）
-- ---------------------------------------------------------

-- 1-1. カラム追加
alter table public.profiles add column if not exists email text;

-- 1-2. 正規化トリガー（security definerではないが同様にsearch_pathを固定）
create or replace function public.normalize_profile_email() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is not null then
    new.email := pg_catalog.lower(pg_catalog.btrim(new.email));
  end if;
  return new;
end;
$$;

revoke all on function public.normalize_profile_email() from public;
revoke all on function public.normalize_profile_email() from anon;
revoke all on function public.normalize_profile_email() from authenticated;
-- クライアントから直接実行する必要がないため再付与しない（トリガーとしての発火はEXECUTE権限と無関係に機能する）

drop trigger if exists profiles_normalize_email on public.profiles;
create trigger profiles_normalize_email
  before insert or update of email on public.profiles
  for each row execute function public.normalize_profile_email();

-- 1-3. バックフィル（確認済みメールのみ、既にemailがある行は上書きしない）
update public.profiles p
set email = pg_catalog.lower(pg_catalog.btrim(u.email))
from auth.users u
where p.id = u.id
  and u.email_confirmed_at is not null
  and p.email is null;

-- 1-4/1-5. 重複確認（重複があれば例外でトランザクション全体をロールバック）
do $$
declare
  v_dupe_count int;
begin
  select pg_catalog.count(*) into v_dupe_count
  from (
    select email from public.profiles
    where email is not null
    group by email
    having pg_catalog.count(*) > 1
  ) d;
  if v_dupe_count > 0 then
    raise exception 'profiles.emailに重複が%件あります。profiles_email_uniqueを作成する前に解消してください。', v_dupe_count;
  end if;
end;
$$;

-- 1-6. ユニークインデックス（再実行しても安全）
create unique index if not exists profiles_email_unique
  on public.profiles (email) where email is not null;

-- ---------------------------------------------------------
-- 2. member_invitations（新規テーブル）
-- ---------------------------------------------------------
create table if not exists public.member_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  full_name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'pending' check (status in ('pending','accepted','cancelled','expired')),
  invited_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint member_invitations_email_length check (pg_catalog.length(email) between 3 and 320),
  constraint member_invitations_full_name_length check (pg_catalog.length(pg_catalog.btrim(full_name)) between 1 and 200)
);

create or replace function public.normalize_invitation_email() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := pg_catalog.lower(pg_catalog.btrim(new.email));
  return new;
end;
$$;

revoke all on function public.normalize_invitation_email() from public;
revoke all on function public.normalize_invitation_email() from anon;
revoke all on function public.normalize_invitation_email() from authenticated;

drop trigger if exists member_invitations_normalize_email on public.member_invitations;
create trigger member_invitations_normalize_email
  before insert or update of email on public.member_invitations
  for each row execute function public.normalize_invitation_email();

create unique index if not exists member_invitations_pending_unique
  on public.member_invitations (email) where status = 'pending';

create index if not exists member_invitations_org_idx on public.member_invitations(organization_id);

alter table public.member_invitations enable row level security;

-- テーブル権限：クライアントからの書き込みをRPCのみに限定する
revoke all on table public.member_invitations from public, anon, authenticated;
grant select on table public.member_invitations to authenticated;

-- RLS：同一組織の有効な管理者だけが一覧を取得できる
-- pg_policiesを確認してから作成することで、2回目以降の実行でも
-- "policy already exists" エラーにならないようにする
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'member_invitations'
      and policyname = 'admins read own org invitations'
  ) then
    create policy "admins read own org invitations" on public.member_invitations
      for select to authenticated
      using (
        organization_id = public.current_organization_id()
        and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active = true)
      );
  end if;
end;
$$;

-- ---------------------------------------------------------
-- 3. 招待作成RPC
-- ---------------------------------------------------------
create or replace function public.create_member_invitation(p_email text, p_full_name text, p_role text)
returns public.member_invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_org uuid;
  v_caller_profile public.profiles;
  v_email text;
  v_name text;
  v_invite public.member_invitations;
  v_existing public.profiles;
begin
  if p_role is null then
    raise exception 'role_required';
  end if;
  if p_role not in ('admin','member') then
    raise exception 'invalid_role';
  end if;

  v_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_name := pg_catalog.btrim(coalesce(p_full_name, ''));

  if v_email = '' then
    raise exception 'email_required';
  end if;
  if pg_catalog.length(v_email) < 3 or pg_catalog.length(v_email) > 320 then
    raise exception 'invalid_email_length';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email';
  end if;
  if v_name = '' then
    raise exception 'full_name_required';
  end if;
  if pg_catalog.length(v_name) > 200 then
    raise exception 'full_name_too_long';
  end if;

  -- 1. 呼び出し元
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  -- 2. 仮取得（ロック対象組織を決めるためだけ。この時点の内容はまだ信用しない）
  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then
    raise exception 'not_authorized';
  end if;

  -- 3. 組織行をロック
  perform 1 from public.organizations where id = v_caller_org for update;

  -- 4. 呼び出し元profileを再取得
  select * into v_caller_profile from public.profiles where id = v_caller;

  -- 5. 権限を再確認
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  update public.member_invitations
    set status = 'expired'
    where email = v_email and status = 'pending' and expires_at <= pg_catalog.now();

  -- 6. 対象メールの既存profileをロック後に再取得
  select * into v_existing from public.profiles where email = v_email;
  if found then
    if v_existing.organization_id = v_caller_org and v_existing.active = true then
      raise exception 'already_active_member';
    elsif v_existing.organization_id = v_caller_org and v_existing.active = false then
      raise exception 'inactive_member_use_reactivate';
    else
      -- 他組織の情報（氏名・状態・組織名）は一切開示しない
      raise exception 'email_unavailable';
    end if;
  end if;

  -- 7. 更新処理
  begin
    insert into public.member_invitations(organization_id, email, full_name, role, invited_by)
    values (v_caller_org, v_email, v_name, p_role, v_caller)
    returning * into v_invite;
  exception
    when unique_violation then
      raise exception 'pending_invitation_already_exists';
  end;

  return v_invite;
end;
$$;

revoke all on function public.create_member_invitation(text, text, text) from public;
revoke all on function public.create_member_invitation(text, text, text) from anon;
revoke all on function public.create_member_invitation(text, text, text) from authenticated;
grant execute on function public.create_member_invitation(text, text, text) to authenticated;

-- ---------------------------------------------------------
-- 4. 招待取消RPC
-- ---------------------------------------------------------
create or replace function public.cancel_member_invitation(invitation_id uuid)
returns public.member_invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_org uuid;
  v_caller_profile public.profiles;
  v_invite public.member_invitations;
begin
  if invitation_id is null then
    raise exception 'invitation_id_required';
  end if;

  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.organizations where id = v_caller_org for update;

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_invite from public.member_invitations
    where id = invitation_id and organization_id = v_caller_org
    for update;
  if not found then
    raise exception 'invitation_not_found';
  end if;
  if v_invite.status not in ('pending','expired') then
    raise exception 'invitation_not_cancellable';
  end if;

  update public.member_invitations
    set status = 'cancelled'
    where id = invitation_id and organization_id = v_caller_org
    returning * into v_invite;
  return v_invite;
end;
$$;

revoke all on function public.cancel_member_invitation(uuid) from public;
revoke all on function public.cancel_member_invitation(uuid) from anon;
revoke all on function public.cancel_member_invitation(uuid) from authenticated;
grant execute on function public.cancel_member_invitation(uuid) to authenticated;

-- ---------------------------------------------------------
-- 5. 招待受け入れRPC（Googleログイン直後にコールバックから呼ぶ）
-- ---------------------------------------------------------
create or replace function public.accept_pending_invitation()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_email text;
  v_confirmed timestamptz;
  v_profile public.profiles;
  v_invite public.member_invitations;
  v_invite_count int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(email)), email_confirmed_at
    into v_email, v_confirmed
    from auth.users where id = v_uid;

  if v_email is null or v_confirmed is null then
    raise exception 'email_not_confirmed';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if found then
    if v_profile.active = true then
      if v_profile.email is distinct from v_email then
        update public.profiles set email = v_email where id = v_uid returning * into v_profile;
      end if;
      return v_profile;
    else
      raise exception 'account_inactive';
    end if;
  end if;

  select * into v_invite
    from public.member_invitations
    where email = v_email and status = 'pending' and expires_at > pg_catalog.now()
    order by created_at desc
    limit 1
    for update;

  if not found then
    raise exception 'no_pending_invitation';
  end if;

  select pg_catalog.count(*) into v_invite_count
    from public.member_invitations
    where email = v_email and status = 'pending' and expires_at > pg_catalog.now();
  if v_invite_count <> 1 then
    raise exception 'ambiguous_invitation_state';
  end if;

  insert into public.profiles(id, organization_id, full_name, role, active, email)
  values (v_uid, v_invite.organization_id, v_invite.full_name, v_invite.role, true, v_email)
  returning * into v_profile;

  update public.member_invitations
    set status = 'accepted', accepted_user_id = v_uid, accepted_at = pg_catalog.now()
    where id = v_invite.id;

  return v_profile;
end;
$$;

revoke all on function public.accept_pending_invitation() from public;
revoke all on function public.accept_pending_invitation() from anon;
revoke all on function public.accept_pending_invitation() from authenticated;
grant execute on function public.accept_pending_invitation() to authenticated;

-- ---------------------------------------------------------
-- 6. 管理者専用：メンバー状態変更RPC（3種）
-- ---------------------------------------------------------

create or replace function public.set_member_active(member_id uuid, new_active boolean)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_org uuid;
  v_caller_profile public.profiles;
  v_target public.profiles;
  remaining_admins int;
begin
  if member_id is null then
    raise exception 'member_id_required';
  end if;
  if new_active is null then
    raise exception 'new_active_required';
  end if;

  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;
  if member_id = v_caller then
    raise exception 'cannot_change_own_active_status';
  end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.organizations where id = v_caller_org for update;

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.profiles
    where id = member_id and organization_id = v_caller_org;
  if not found then
    raise exception 'member_not_found_in_your_organization';
  end if;

  if new_active = false and v_target.role = 'admin' and v_target.active = true then
    select pg_catalog.count(*) into remaining_admins from public.profiles
      where organization_id = v_caller_org
        and role = 'admin' and active = true and id <> member_id;
    if remaining_admins = 0 then
      raise exception 'cannot_deactivate_last_admin';
    end if;
  end if;

  update public.profiles
    set active = new_active
    where id = member_id and organization_id = v_caller_org
    returning * into v_target;
  return v_target;
end;
$$;

revoke all on function public.set_member_active(uuid, boolean) from public;
revoke all on function public.set_member_active(uuid, boolean) from anon;
revoke all on function public.set_member_active(uuid, boolean) from authenticated;
grant execute on function public.set_member_active(uuid, boolean) to authenticated;


create or replace function public.set_member_role(member_id uuid, new_role text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_org uuid;
  v_caller_profile public.profiles;
  v_target public.profiles;
  remaining_admins int;
begin
  if member_id is null then
    raise exception 'member_id_required';
  end if;
  if new_role is null then
    raise exception 'new_role_required';
  end if;
  if new_role not in ('admin','member') then
    raise exception 'invalid_role';
  end if;

  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;
  if member_id = v_caller then
    raise exception 'cannot_change_own_role';
  end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.organizations where id = v_caller_org for update;

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.profiles
    where id = member_id and organization_id = v_caller_org;
  if not found then
    raise exception 'member_not_found_in_your_organization';
  end if;

  if new_role = 'member' and v_target.role = 'admin' and v_target.active = true then
    select pg_catalog.count(*) into remaining_admins from public.profiles
      where organization_id = v_caller_org
        and role = 'admin' and active = true and id <> member_id;
    if remaining_admins = 0 then
      raise exception 'cannot_demote_last_admin';
    end if;
  end if;

  update public.profiles
    set role = new_role
    where id = member_id and organization_id = v_caller_org
    returning * into v_target;
  return v_target;
end;
$$;

revoke all on function public.set_member_role(uuid, text) from public;
revoke all on function public.set_member_role(uuid, text) from anon;
revoke all on function public.set_member_role(uuid, text) from authenticated;
grant execute on function public.set_member_role(uuid, text) to authenticated;


create or replace function public.update_member_name(member_id uuid, new_full_name text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_org uuid;
  v_caller_profile public.profiles;
  v_target public.profiles;
  v_name text;
begin
  if member_id is null then
    raise exception 'member_id_required';
  end if;
  v_name := pg_catalog.btrim(coalesce(new_full_name, ''));
  if v_name = '' then
    raise exception 'full_name_required';
  end if;
  if pg_catalog.length(v_name) > 200 then
    raise exception 'full_name_too_long';
  end if;

  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.organizations where id = v_caller_org for update;

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.profiles
    where id = member_id and organization_id = v_caller_org;
  if not found then
    raise exception 'member_not_found_in_your_organization';
  end if;

  update public.profiles
    set full_name = v_name
    where id = member_id and organization_id = v_caller_org
    returning * into v_target;
  return v_target;
end;
$$;

revoke all on function public.update_member_name(uuid, text) from public;
revoke all on function public.update_member_name(uuid, text) from anon;
revoke all on function public.update_member_name(uuid, text) from authenticated;
grant execute on function public.update_member_name(uuid, text) to authenticated;

commit;
