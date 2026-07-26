import type { DuplicateMode } from "./csv-import";

export type OnDuplicate = DuplicateMode;
export type MatchScope = "phone" | "domain" | "name_location" | "name_only" | "strict";

export const MATCH_SCOPES: MatchScope[] = ["phone", "domain", "name_location", "name_only", "strict"];

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
// （create_company_checked に禁止先登録の迂回引数は存在しない。禁止一致は常にblockedになる）
export type CheckedWriteResult =
  | { status: "inserted"; company: Record<string, unknown> }
  | { status: "updated"; company: Record<string, unknown> }
  | { status: "skipped"; existing_company_id?: string; conflicting_company_id?: string }
  | { status: "blocked"; blocklist_id: string; matched_scope: string; reason: string }
  | { status: "needs_explicit_update"; existing_company_id: string }
  | { status: "needs_explicit_resolution"; conflicting_company_id: string };

// archive_company / restore_company が返すjsonbのstatus判別
export type ArchiveCompanyResult =
  | { status: "archived"; company: Record<string, unknown> }
  | { status: "already_archived"; company: Record<string, unknown> };

export type RestoreCompanyResult =
  | { status: "restored"; company: Record<string, unknown> }
  | { status: "already_active"; company: Record<string, unknown> }
  | { status: "duplicate_conflict"; conflicting_company_id: string };

// 行エラーには管理された安全なerror_codeだけを含める。Postgresの生メッセージ
// （制約名・テーブル名・SQL・データ型を含みうる）は一切含めない
export interface BulkRowResult {
  row: number;
  status: "inserted" | "updated" | "skipped" | "blocked" | "error";
  company_id?: string;
  existing_company_id?: string;
  conflicting_company_id?: string;
  blocklist_id?: string;
  matched_scope?: string;
  reason?: string;
  error_code?: string;
}

export interface CreateCompaniesCheckedResult {
  results: BulkRowResult[];
}

// SQL側のRPCが投げるエラーコード（raise exceptionのメッセージ）を、
// 営業担当にも分かる日本語へ変換する。ここに無い未知の文字列は、原因不明な
// Postgresの生メッセージである可能性があるため、そのままは表示せず
// 汎用メッセージへ変換する
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "ログインが必要です",
  not_authorized: "この操作を行う権限がありません",
  account_inactive: "アカウントが無効化されています。管理者にご確認ください",
  name_required: "企業名を入力してください",
  invalid_on_duplicate: "重複時の処理方法の指定が正しくありません",
  company_not_found_in_your_organization: "対象の企業が見つかりません（自組織の企業のみ操作できます）",
  reason_required: "理由の入力が必要です",
  identifier_required: "電話番号・URL・企業名のいずれかを入力してください",
  invalid_match_scope: "一致条件の指定が正しくありません",
  phone_required_for_scope: "電話番号一致を選ぶ場合は、電話番号の入力が必要です",
  domain_required_for_scope: "公式URLドメイン一致を選ぶ場合は、公式URLの入力が必要です",
  name_and_location_required_for_scope: "企業名+所在地一致を選ぶ場合は、企業名と所在地の両方の入力が必要です",
  name_required_for_scope: "企業名のみ一致を選ぶ場合は、企業名の入力が必要です",
  blocklist_entry_already_active: "この企業は既に架電禁止に設定されています",
  blocklist_entry_not_found: "対象の架電禁止設定が見つかりません",
  blocklist_id_required: "架電禁止設定のIDが必要です",
  call_prohibited: "この企業は架電禁止に設定されています",
  duplicate_key: "同じ識別子の登録が既に存在するため保存できませんでした",
  invalid_value: "入力値の形式が正しくありません",
  value_too_long: "入力値が長すぎます",
  row_save_failed: "この行の保存に失敗しました",
  invalid_heat: "温度感の指定が正しくありません",
  owner_must_be_active_org_member: "担当メンバーは、同じ組織の有効なメンバーから選択してください",
  company_is_archived: "この企業はアーカイブ済みのため編集できません。先に復元してください",
  company_id_required: "対象の企業を指定してください",
  "company not found": "対象の企業が見つかりません",
  "invalid result": "架電結果の指定が正しくありません",
  "invalid heat": "温度感の指定が正しくありません",
};

// トランザクションを再試行すべき一時的な障害のPostgres SQLSTATE。
// メッセージではなくコードで判定する（メッセージは言語・バージョンで変わりうるため）
const RETRYABLE_SQLSTATES: Record<string, string> = {
  "40P01": "他の操作と同時に更新が集中したため処理できませんでした。少し時間をおいて再度お試しください",
  "55P03": "他の操作がロックを保持しているため処理できませんでした。少し時間をおいて再度お試しください",
  "57014": "処理に時間がかかりすぎたため中断しました。少し時間をおいて再度お試しください",
  "40001": "他の操作と競合したため処理できませんでした。少し時間をおいて再度お試しください",
};

export function companySafetyErrorMessage(raw: string, code?: string | null): string {
  if (code && RETRYABLE_SQLSTATES[code]) return RETRYABLE_SQLSTATES[code];
  const key = (raw || "").trim();
  return ERROR_MESSAGES[key] || "処理に失敗しました";
}

export function matchScopeLabel(scope: string): string {
  switch (scope) {
    case "phone": return "電話番号が一致";
    case "domain": return "公式URLのドメインが一致";
    case "name_location": return "企業名・所在地が一致";
    case "name_only": return "企業名のみ一致";
    case "strict": return "強一致条件のいずれかが一致";
    default: return "不明な一致条件";
  }
}

export const MATCH_SCOPE_OPTION_LABELS: Record<MatchScope, string> = {
  phone: "電話番号",
  domain: "公式URLドメイン",
  name_location: "企業名＋所在地",
  name_only: "企業名のみ（誤検出範囲が広いため慎重に選択してください）",
  strict: "強一致条件のいずれか（電話・ドメイン・企業名+所在地）",
};
