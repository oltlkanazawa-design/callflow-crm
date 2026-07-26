-- =========================================================
-- CallFlow CRM: 企業の一括アーカイブのロールバック
--
-- add-bulk-company-archive.sql を適用したデータベースを、適用前の状態へ
-- 戻します。このマイグレーションはarchive_companies()という新規関数を
-- 1つ追加するだけで、既存のカラム・ビュー・他の関数は一切変更していない
-- ため、ロールバックはこの関数を削除するだけで完結します。
--
-- 【重要】このロールバックは、companies・call_logs・call_blocklistの行を
-- 一切削除・変更しません。archive_companies()経由で既にアーカイブ済みの
-- 企業も、archived_at等の列自体はこのロールバックでは削除されないため、
-- 引き続き「アーカイブ済み」として扱われます（このロールバックは
-- add-company-detail-edit-archive.sql自体の巻き戻しではありません）。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

drop function if exists public.archive_companies(uuid[]);

commit;
