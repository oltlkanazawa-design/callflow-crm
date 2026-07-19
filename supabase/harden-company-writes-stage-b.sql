-- =========================================================
-- CallFlow CRM: 企業安全管理（重複検出・架電禁止）段階B
--
-- 【重要】このファイルは作成のみで、まだ適用していません。
-- 段階Aとは別に、ユーザーの明示的な承認を得てから別途適用してください。
--
-- 目的：
--   段階Aはcompaniesへの直接INSERT/UPDATE権限を残したまま、
--   check_company_safety() / create_company_checked() /
--   update_company_checked() / create_companies_checked() という
--   「確認込みの安全なRPC」を追加する形にとどめました（既存のクライアント
--   コードを壊さないため）。段階Bは、companiesへの直接INSERT/UPDATEを
--   authenticatedから完全に外し、以後すべての企業登録・更新が上記RPC
--   経由でしか行えないようにします。
--
-- 【record_call()との関係・必須の対応】
--   record_call()はSECURITY INVOKERのまま、companiesをUPDATEします
--   （架電結果に応じてheat/memo/last_called_at/next_action_atを更新）。
--   companiesのUPDATE権限をauthenticatedから剥奪すると、SECURITY INVOKERの
--   record_call()はこのUPDATEで permission denied for table companies に
--   なり、架電記録そのものが保存できなくなってしまいます。
--   そのため、companiesの権限剥奪より前に、record_call()をSECURITY DEFINER
--   へ変更します。呼び出し元の権限に依存せず自分自身で全ての認可判定
--   （認証・active・組織一致・企業の組織一致・架電禁止再確認・
--   result/heatの許可値・organization advisory lock）を行うロジックは
--   段階Aの時点で既に実装済みのため、SECURITY DEFINERへ変更しても
--   チェックの内容自体は変わりません。
--
-- 影響範囲：
--   ・admin/一般メンバーを問わず、companiesテーブルへの直接INSERT/UPDATEは
--     PostgreSQL権限エラー（permission denied for table companies）になります。
--   ・companiesへのSELECT・DELETEは変更しません
--     （DELETEは既存の"admins delete companies"ポリシーのまま、admin限定で継続）。
--   ・"organization members insert companies" / "organization members update
--     companies" のRLSポリシーは削除しません。GRANT側で先に権限が無くなる
--     ため、これらのポリシーは以後到達不能（休眠）になりますが、あえて
--     残すことで、万一将来この段階Bをロールバックした際に、RLSポリシーを
--     作り直す必要がなく、GRANTを戻すだけで済むようにしています。
--   ・本番へこのSQLを適用する前に、companiesへ直接INSERT/UPDATEしている
--     クライアントコードが他に残っていないことを必ず確認してください
--     （このリポジトリ内では、CompanyModal / LeadImportModal / CsvImportModal
--     はいずれも本PRで create_company_checked() / create_companies_checked()
--     経由に変更済みです）。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

-- 1. record_call()をSECURITY DEFINERへ変更する。
--    ロジック自体は段階Aのrecord_call()と完全に同一（認証・active確認・
--    organization advisory lock・企業の組織一致・架電禁止再確認・
--    result/heat許可値チェックは全て維持）。security invoker→definerと
--    search_path=''の維持だけが変更点。
create or replace function public.record_call(
  p_company_id uuid, p_result text, p_note text default '', p_transcript text default null,
  p_ai_summary text default null, p_next_action_at timestamptz default null, p_heat text default '低'
) returns uuid
language plpgsql
security definer
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

-- 2. companiesへの直接書き込み権限を剥奪する（record_call()をSECURITY DEFINERへ
--    変更した後に実行する。順序を逆にすると、権限剥奪の直後に実行される可能性のある
--    architectural race window は無いが、念のため必ずこのファイル内の順序を維持すること）
revoke insert, update on table public.companies from authenticated;

commit;
