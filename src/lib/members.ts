import type { Company, CallLog, Member, MemberInvitation } from "./types";

// 担当者切替は名前ではなくIDで行う（同姓同名・氏名変更で壊れないようにするため）。
// "all" は絞り込みなし（全員）を表す。
export type ViewFilterMemberId = "all" | string;

export function filterCompaniesByMember(companies: Company[], viewFilterMemberId: ViewFilterMemberId): Company[] {
  if (viewFilterMemberId === "all") return companies;
  return companies.filter(c => c.owner_id === viewFilterMemberId);
}

export function filterLogsByMember(logs: CallLog[], viewFilterMemberId: ViewFilterMemberId): CallLog[] {
  if (viewFilterMemberId === "all") return logs;
  return logs.filter(l => l.caller_id === viewFilterMemberId);
}

// statusはまだ'pending'のままでもexpires_atが過去のものは、
// 「初回ログイン待ち」として画面に表示しない（クライアント側の防御的フィルタ。
// data.tsのSupabaseクエリ側でも.gt("expires_at", now)を適用済み）。
export function filterActivePendingInvitations(invitations: MemberInvitation[], now: Date = new Date()): MemberInvitation[] {
  return invitations.filter(i => i.status === "pending" && new Date(i.expires_at).getTime() > now.getTime());
}

// 担当者選択欄（新規割当・表示絞り込み）にはactive=trueのメンバーのみを出す。
// 利用停止メンバーは新しい担当者として選択できないようにするため。
export function activeMemberOptions(members: Member[]): Member[] {
  return members.filter(m => m.active);
}

// 保存済みの担当者フィルターが、現在の有効なメンバー一覧に存在しない
// （削除・利用停止済みを含む）場合は"all"へ戻す。担当者セレクトが
// 空欄になる状態を防ぐため。allMembersがまだ読み込まれていない（空配列の）
// 間は判定しない（呼び出し側でactiveMembers.length>0のときだけ呼ぶ想定）。
export function resolveViewFilterMemberId(candidateId: ViewFilterMemberId, activeMembers: Member[]): ViewFilterMemberId {
  if (candidateId === "all") return "all";
  return activeMembers.some(m => m.id === candidateId) ? candidateId : "all";
}

// 担当者フィルターが変わったら0へ戻す。件数が変わって現在のインデックスが
// 範囲外になった場合も0へ補正する。件数が0の場合は補正しない
// （CallScreen側で「架電対象の企業がありません」を表示するため）。
export function resolveCallIndex(params: { filterChanged: boolean; callIndex: number; filteredCompaniesLength: number }): number {
  const { filterChanged, callIndex, filteredCompaniesLength } = params;
  if (filterChanged) return 0;
  if (filteredCompaniesLength > 0 && callIndex >= filteredCompaniesLength) return 0;
  return callIndex;
}

export interface TeamKpis { totalCalls: number; totalAppointments: number; connectionRate: number }

// メンバー実績画面のKPI（架電数・アポ数・平均接続率）。担当者で絞り込んだ
// ログを渡せば、その担当者だけの数値になる（"全員"ならチーム全体のまま）。
export function computeTeamKpis(logs: CallLog[]): TeamKpis {
  const totalCalls = logs.length;
  const totalAppointments = logs.filter(l => l.result === "アポ獲得").length;
  const connectionRate = logs.length ? Math.round(logs.filter(l => l.result !== "担当者不在").length / logs.length * 100) : 0;
  return { totalCalls, totalAppointments, connectionRate };
}

export type MemberDisplayStatus = "invited" | "active" | "inactive";

export interface MemberListRow {
  kind: "member" | "invitation";
  id: string;
  full_name: string;
  email: string | null;
  role: Member["role"];
  status: MemberDisplayStatus;
  created_at?: string;
}

// メンバー管理画面用：既存メンバーと招待待ちを1つの一覧にまとめる。
// 同一メールで既にprofilesが存在する招待（受け入れ済みでstatus更新待ちの取りこぼし等）は
// メンバー行を優先し、招待行は表示しない。
export function buildMemberListRows(members: Member[], invitations: MemberInvitation[]): MemberListRow[] {
  const memberEmails = new Set(members.map(m => m.email).filter((e): e is string => Boolean(e)));
  const memberRows: MemberListRow[] = members.map(m => ({
    kind: "member",
    id: m.id,
    full_name: m.full_name,
    email: m.email,
    role: m.role,
    status: m.active ? "active" : "inactive",
    created_at: m.created_at,
  }));
  const invitationRows: MemberListRow[] = invitations
    .filter(i => i.status === "pending" && !memberEmails.has(i.email))
    .map(i => ({
      kind: "invitation",
      id: i.id,
      full_name: i.full_name,
      email: i.email,
      role: i.role,
      status: "invited",
      created_at: i.created_at,
    }));
  return [...invitationRows, ...memberRows];
}

// RPCが投げるエラーコード（英語のスネークケース）を、画面表示用の日本語メッセージへ変換する。
// サーバー側の技術的なエラーメッセージをそのまま表示しないための変換表。
const MEMBER_ERROR_MESSAGES: Record<string, string> = {
  role_required: "権限を選択してください",
  invalid_role: "権限の指定が正しくありません",
  email_required: "メールアドレスを入力してください",
  invalid_email_length: "メールアドレスの長さが正しくありません",
  invalid_email: "メールアドレスの形式を確認してください",
  full_name_required: "氏名を入力してください",
  full_name_too_long: "氏名が長すぎます（200文字以内）",
  not_authenticated: "ログインが必要です",
  not_authorized: "この操作を行う権限がありません",
  already_active_member: "このメールアドレスは既に有効なメンバーとして登録されています",
  inactive_member_use_reactivate: "このメールアドレスは利用停止中のメンバーです。招待ではなく再有効化を行ってください",
  email_unavailable: "このメールアドレスは使用できません",
  pending_invitation_already_exists: "このメールアドレス宛の招待は既に送信済みです",
  invitation_id_required: "招待を指定してください",
  invitation_not_found: "招待が見つかりません",
  invitation_not_cancellable: "この招待は取り消せない状態です",
  email_not_confirmed: "メールアドレスが確認されていません",
  account_inactive: "このアカウントは利用停止中です。管理者にお問い合わせください",
  no_pending_invitation: "有効な招待が見つかりません。管理者に招待を依頼してください",
  ambiguous_invitation_state: "招待の状態を確認できませんでした。管理者にお問い合わせください",
  member_id_required: "メンバーを指定してください",
  new_active_required: "状態を指定してください",
  new_role_required: "権限を指定してください",
  member_not_found_in_your_organization: "同じ組織のメンバーが見つかりません",
  cannot_change_own_active_status: "自分自身の利用状態は変更できません",
  cannot_deactivate_last_admin: "組織内で最後の管理者を利用停止にはできません",
  cannot_change_own_role: "自分自身の権限は変更できません",
  cannot_demote_last_admin: "組織内で最後の管理者の権限は変更できません",
};

export function memberErrorMessage(rawMessage: string | undefined | null): string {
  const code = (rawMessage || "").trim();
  return MEMBER_ERROR_MESSAGES[code] || "操作に失敗しました。時間をおいて再度お試しください";
}

// accept_pending_invitation()が投げる例外メッセージを、/loginへ渡すエラーコードへ変換する。
// RPC未作成・SQL不整合・DB障害などの未知のエラーを「招待されていない」と
// 誤表示しないよう、既知のビジネスエラーコード以外はsystem_errorにする。
export function invitationErrorCode(message: string | undefined | null): string {
  const code = (message || "").trim();
  if (code === "no_pending_invitation") return "no_invitation";
  if (code === "account_inactive" || code === "email_not_confirmed" || code === "ambiguous_invitation_state") return code;
  return "system_error";
}

const sessionKey = "callflow_view_filter_member_id";

export function readStoredViewFilter(): ViewFilterMemberId {
  if (typeof window === "undefined") return "all";
  return sessionStorage.getItem(sessionKey) || "all";
}

export function writeStoredViewFilter(viewFilterMemberId: ViewFilterMemberId): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(sessionKey, viewFilterMemberId);
}
