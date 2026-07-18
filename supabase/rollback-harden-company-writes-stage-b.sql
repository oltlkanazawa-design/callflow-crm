-- =========================================================
-- CallFlow CRM: 企業安全管理 段階B のロールバック
--
-- harden-company-writes-stage-b.sql を適用したデータベースを、
-- 適用前の状態（companiesへの直接INSERT/UPDATEが可能な状態）へ戻します。
--
-- 適用前に必ず内容を確認し、承認を得てから実行してください。
-- =========================================================

begin;

grant insert, update on table public.companies to authenticated;

commit;
