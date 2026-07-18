import type { DuplicateMode } from "./csv-import";

export type OnDuplicate = DuplicateMode;

export interface BlockMatch {
  blocklist_id: string;
  matched_scope: string;
  reason: string;
}

export interface DuplicateCandidate {
  tier: "phone" | "domain" | "name_location" | "name";
  company_id: string;
}

export interface CheckCompanySafetyResult {
  blocked: boolean;
  block_matches: BlockMatch[];
  duplicate_candidates: DuplicateCandidate[];
}

export interface BlocklistEntry {
  id: string;
  organization_id: string;
  company_id: string | null;
  snapshot_name: string | null;
  snapshot_location: string | null;
  snapshot_phone: string | null;
  snapshot_domain: string | null;
  match_scope: string;
  reason: string;
  note: string;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

// create_company_checked / update_company_checked が返すjsonbのstatus判別
export type CheckedWriteResult =
  | { status: "inserted"; company: Record<string, unknown> }
  | { status: "updated"; company: Record<string, unknown> }
  | { status: "skipped"; existing_company_id?: string; conflicting_company_id?: string }
  | { status: "blocked"; blocklist_id: string; matched_scope: string; reason: string }
  | { status: "needs_explicit_update"; existing_company_id: string }
  | { status: "needs_explicit_resolution"; conflicting_company_id: string };

export interface BulkRowResult {
  row: number;
  status: "inserted" | "updated" | "skipped" | "blocked" | "error";
  company_id?: string;
  existing_company_id?: string;
  blocklist_id?: string;
  matched_scope?: string;
  reason?: string;
  error_code?: string;
  error_message?: string;
}

export interface CreateCompaniesCheckedResult {
  results: BulkRowResult[];
}

// SQL側のRPCが投げるエラーコード（raise exceptionのメッセージ）を、
// 営業担当にも分かる日本語へ変換する
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "ログインが必要です",
  not_authorized: "この操作を行う権限がありません",
  account_inactive: "アカウントが無効化されています。管理者にご確認ください",
  name_required: "企業名を入力してください",
  invalid_on_duplicate: "重複時の処理方法の指定が正しくありません",
  company_not_found_in_your_organization: "対象の企業が見つかりません（自組織の企業のみ操作できます）",
  reason_required: "理由の入力が必要です",
  identifier_required: "電話番号・URL・企業名のいずれかを入力してください",
  blocklist_entry_already_active: "この企業は既に架電禁止に設定されています",
  blocklist_entry_not_found: "対象の架電禁止設定が見つかりません",
  blocklist_id_required: "架電禁止設定のIDが必要です",
  call_prohibited: "この企業は架電禁止に設定されています",
  "company not found": "対象の企業が見つかりません",
  "invalid result": "架電結果の指定が正しくありません",
  "invalid heat": "温度感の指定が正しくありません",
};

export function companySafetyErrorMessage(raw: string): string {
  const key = raw.trim();
  return ERROR_MESSAGES[key] || raw || "処理に失敗しました";
}

export function matchScopeLabel(scope: string): string {
  switch (scope) {
    case "phone": return "電話番号が一致";
    case "domain": return "公式URLのドメインが一致";
    case "name_location": return "企業名・所在地が一致";
    case "name_only": return "企業名のみ一致";
    default: return scope;
  }
}
