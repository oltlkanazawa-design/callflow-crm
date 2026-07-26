import type { Company } from "./types";

// archived_atが入っていればアーカイブ済み。null/undefinedなら有効企業。
export function isCompanyArchived(company: Pick<Company, "archived_at">): boolean {
  return Boolean(company.archived_at);
}

// 企業一覧の「有効な企業／アーカイブ済み」切り替え用。
export function filterCompaniesByArchiveState(companies: Company[], showArchived: boolean): Company[] {
  return companies.filter(c => isCompanyArchived(c) === showArchived);
}
