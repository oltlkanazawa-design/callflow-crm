-- 営業メンバー追加用テンプレート
-- 先に Supabase Authentication でメンバーのユーザーを作成してください。
-- MEMBER_AUTH_USER_UUID、ORG_UUID、メンバー名を実値へ置換して実行します。

insert into public.profiles(id, organization_id, full_name, role, active)
values ('MEMBER_AUTH_USER_UUID', 'ORG_UUID', '営業メンバー名', 'member', true);

