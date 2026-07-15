-- schema.sqlと管理者プロフィール作成後、下記2つを実値へ置換して任意で実行してください。
do $$ declare org uuid := 'ORG_UUID'; uid uuid := 'AUTH_USER_UUID'; begin
  insert into public.companies(organization_id,name,industry,location,phone,website_url,source_url,list_source,contact_name,contact_department,heat,owner_id,memo) values
  (org,'株式会社北陸テック','IT・システム開発','石川県金沢市','076-123-4567','https://example.com/hokuriku-tech','https://example.com/list','デモリスト','山本様','人事部','中',uid,'採用SNSに興味あり'),
  (org,'金沢フーズ株式会社','食品製造','石川県白山市','076-248-8100','https://example.com/kanazawa-foods','https://example.com/list','デモリスト','中田様','総務部','高',uid,'若手採用に課題。事例資料を希望');
end $$;
