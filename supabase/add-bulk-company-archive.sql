-- =========================================================
-- CallFlow CRM: 企業の一括アーカイブ
--
-- 【重要】このファイルはこの開発環境から本番Supabaseへ直接適用しません。
-- 内容を確認のうえ、ユーザー自身がSupabaseのSQL Editor等で実行してください。
--
-- 既存の企業データ・call_logs（架電履歴）・call_blocklist（架電禁止設定）は
-- このマイグレーションによって一切変更・削除されません。追加するのは新規
-- 関数1つ（archive_companies）のみで、既存オブジェクトは一切変更しません。
--
-- 既存の単体アーカイブ（archive_company(uuid)）をブラウザから複数回連続
-- 実行する方式ではなく、複数企業をまとめて1回のトランザクションで安全に
-- 処理する専用RPCとして追加します。これにより、途中で失敗した場合に
-- 一部の企業だけがアーカイブされた中途半端な状態になることを防ぎます。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 25. archive_companies()：管理者専用。複数企業を1回のトランザクションで
--    まとめてアーカイブする（ハードDELETEしない）。
--
--    設計方針（archive_company(uuid)との違い）：
--      a. 引数はuuid[]。null・重複IDは内部で除去し、空配列は拒否する。
--      b. 一度に処理できるのは最大500件（大量の advisory lock 取得や
--         長時間ロックによる他操作への影響を避けるための上限）。
--      c. 対象IDのうち1件でも「存在しない」または「自分の組織に属さない」
--         ものが含まれる場合は、技術的な理由の区別をせず（他組織の存在有無を
--         漏らさないため、既存のarchive_company(uuid)と同じ
--         company_not_found_in_your_organizationで）全件を拒否する。
--         一部だけを処理する部分更新は行わない。
--      d. 既にアーカイブ済みの企業が含まれていてもエラーにはせず、
--         already_archived_countとして件数に含めて安全に返す（冪等）。
--      e. 実際にアーカイブする対象は、単一のUPDATE文で一括更新するため、
--         archived_atはすべて同一時刻になる。
--      f. call_logs・call_blocklist・企業の識別情報（電話・URL・企業名等）は
--         一切変更しない。
--
--    ロック順序はarchive_company(uuid)・block_company_calls()等の既存の
--    書き込みRPCと同じ：organization advisory lock → profile再確認
--    （admin + active + 組織一致） → 対象行のFOR UPDATE。他の書き込みRPCと
--    同じ順序を守ることで、異なるRPC間のデッドロックを避ける。
-- ---------------------------------------------------------
create or replace function public.archive_companies(
  p_company_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid; v_caller_org uuid; v_caller_profile public.profiles;
  v_dedup_ids uuid[];
  v_requested_count int;
  v_found_count int;
  v_already_archived_ids uuid[];
  v_to_archive_ids uuid[];
  v_now timestamptz;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'not_authenticated'; end if;

  if p_company_ids is null then raise exception 'company_ids_required'; end if;

  -- null要素・重複IDを取り除く（内部で1件へ整理）
  select array_agg(distinct x) into v_dedup_ids from unnest(p_company_ids) x where x is not null;
  if v_dedup_ids is null or array_length(v_dedup_ids, 1) is null then
    raise exception 'company_ids_required';
  end if;
  v_requested_count := array_length(v_dedup_ids, 1);
  if v_requested_count > 500 then
    raise exception 'too_many_company_ids';
  end if;

  select organization_id into v_caller_org from public.profiles where id = v_caller;
  if v_caller_org is null then raise exception 'not_authorized'; end if;

  perform public.acquire_organization_lock(v_caller_org);

  select * into v_caller_profile from public.profiles where id = v_caller;
  if v_caller_profile.role <> 'admin' or v_caller_profile.active <> true
     or v_caller_profile.organization_id <> v_caller_org then
    raise exception 'not_authorized';
  end if;

  -- 対象行を自組織の範囲でロックしつつ、既存/未既存・アーカイブ済み/未アーカイブへ
  -- 振り分ける。FOR UPDATEはCTE自身の行取得に対して適用され、外側の集約は
  -- 既にロック済みの結果を読むだけなので「集約にFOR UPDATEは使えない」という
  -- 制約には抵触しない。
  with locked as (
    select id, archived_at
    from public.companies
    where id = any(v_dedup_ids) and organization_id = v_caller_org
    for update
  )
  select
    count(*),
    array_agg(id) filter (where archived_at is not null),
    array_agg(id) filter (where archived_at is null)
  into v_found_count, v_already_archived_ids, v_to_archive_ids
  from locked;

  -- 存在しないID・他組織のIDが1件でも含まれる場合は全件拒否する
  -- （途中まで成功する部分更新は行わない）
  if v_found_count <> v_requested_count then
    raise exception 'company_not_found_in_your_organization';
  end if;

  v_now := pg_catalog.now();

  if v_to_archive_ids is not null and array_length(v_to_archive_ids, 1) > 0 then
    update public.companies set
      archived_at = v_now,
      archived_by = v_caller,
      updated_by = v_caller
    where id = any(v_to_archive_ids);
  end if;

  return jsonb_build_object(
    'status', 'archived',
    'requested_count', v_requested_count,
    'archived_count', coalesce(array_length(v_to_archive_ids, 1), 0),
    'already_archived_count', coalesce(array_length(v_already_archived_ids, 1), 0),
    'archived_company_ids', to_jsonb(coalesce(v_to_archive_ids, '{}'::uuid[]))
  );
end;
$$;

revoke all on function public.archive_companies(uuid[]) from public, anon, authenticated;
grant execute on function public.archive_companies(uuid[]) to authenticated;

commit;
