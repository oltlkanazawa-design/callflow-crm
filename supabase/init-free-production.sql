-- Free本番用の初期組織・管理者作成SQL
-- 先に Supabase Authentication で管理者ユーザーを作成してください。
-- その後、AUTH_USER_UUID を実際のユーザーUUIDへ置換して実行します。

do $$
declare
  org_id uuid;
  admin_user_id uuid := 'AUTH_USER_UUID';
begin
  insert into public.organizations(name)
  values ('OLTL')
  returning id into org_id;

  insert into public.profiles(id, organization_id, full_name, role, active)
  values (admin_user_id, org_id, '辻 保', 'admin', true);
end $$;

