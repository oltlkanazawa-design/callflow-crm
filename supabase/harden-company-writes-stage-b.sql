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

revoke insert, update on table public.companies from authenticated;

commit;
