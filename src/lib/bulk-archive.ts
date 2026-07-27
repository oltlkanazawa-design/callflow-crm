import type { Company } from "./types";
import type { BulkArchiveCompaniesResult } from "./company-safety";

// archive_companies() RPC・デモモード実装の両方で使う上限（サーバー側と同じ値）
export const MAX_BULK_ARCHIVE_IDS = 500;

// null/undefinedと重複を取り除く（サーバー側のarchive_companies()と同じ整理規則）
export function dedupeCompanyIds(ids: (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

export interface BulkArchivePreview {
  shownNames: string[];
  moreCount: number;
}

// 確認モーダルに表示する企業名（先頭5件＋「ほかN件」）
export function buildBulkArchivePreview(companies: Pick<Company, "name">[], maxShown = 5): BulkArchivePreview {
  return {
    shownNames: companies.slice(0, maxShown).map(c => c.name),
    moreCount: Math.max(0, companies.length - maxShown),
  };
}

// 完了トースト用メッセージ。既にアーカイブ済みの企業が混在していた場合は内訳を示す
export function bulkArchiveResultMessage(result: Pick<BulkArchiveCompaniesResult, "archived_count" | "already_archived_count">): string {
  if (result.already_archived_count > 0) {
    return `${result.archived_count}件をアーカイブしました（${result.already_archived_count}件は既にアーカイブ済みでした）`;
  }
  return `${result.archived_count}件の企業をアーカイブしました`;
}
