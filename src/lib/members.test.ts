import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterCompaniesByMember, filterLogsByMember, activeMemberOptions, buildMemberListRows, memberErrorMessage, invitationErrorCode,
  filterActivePendingInvitations, resolveViewFilterMemberId, resolveCallIndex, computeTeamKpis,
} from "./members.ts";
import type { Company, CallLog, Member, MemberInvitation } from "./types";

const companies: Company[] = [
  { id: "c1", name: "同姓同名テスト株式会社A", industry: "IT", location: "石川県", phone: "076-0000-0001", owner_id: "u1", owner_name: "辻 保", contact_name: "", heat: "低", memo: "" },
  { id: "c2", name: "同姓同名テスト株式会社B", industry: "IT", location: "石川県", phone: "076-0000-0002", owner_id: "u2", owner_name: "辻 保", contact_name: "", heat: "低", memo: "" },
  { id: "c3", name: "未割当企業", industry: "IT", location: "石川県", phone: "076-0000-0003", owner_name: "", contact_name: "", heat: "低", memo: "" },
];

const logs: CallLog[] = [
  { id: "l1", company_id: "c1", company_name: "同姓同名テスト株式会社A", caller_id: "u1", caller_name: "辻 保", result: "アポ獲得", note: "", created_at: "2026-07-01T00:00:00+09:00" },
  { id: "l2", company_id: "c2", company_name: "同姓同名テスト株式会社B", caller_id: "u2", caller_name: "辻 保", result: "資料送付", note: "", created_at: "2026-07-02T00:00:00+09:00" },
];

test("filterCompaniesByMember: 'all'では絞り込まない", () => {
  assert.equal(filterCompaniesByMember(companies, "all").length, 3);
});

test("filterCompaniesByMember: 同姓同名でもowner_id（ID）で正しく絞り込める", () => {
  const filtered = filterCompaniesByMember(companies, "u1");
  assert.deepEqual(filtered.map(c => c.id), ["c1"]);
});

test("filterLogsByMember: 'all'では絞り込まない", () => {
  assert.equal(filterLogsByMember(logs, "all").length, 2);
});

test("filterLogsByMember: caller_id（ID）で絞り込める。氏名変更後も壊れない", () => {
  // u2の表示名が後から変わっても、絞り込みキーはIDのままなので結果は変わらない
  const renamed: CallLog[] = logs.map(l => l.caller_id === "u2" ? { ...l, caller_name: "改名 太郎" } : l);
  const filtered = filterLogsByMember(renamed, "u2");
  assert.deepEqual(filtered.map(l => l.id), ["l2"]);
  assert.equal(filtered[0].caller_name, "改名 太郎");
});

test("activeMemberOptions: active=falseのメンバーは除外される", () => {
  const members: Member[] = [
    { id: "u1", full_name: "辻 保", email: "a@example.com", role: "admin", active: true },
    { id: "u2", full_name: "退職済み 太郎", email: "b@example.com", role: "member", active: false },
  ];
  const options = activeMemberOptions(members);
  assert.deepEqual(options.map(m => m.id), ["u1"]);
});

test("buildMemberListRows: 利用停止メンバーも履歴表示用の一覧には含まれる（statusがinactive）", () => {
  const members: Member[] = [
    { id: "u1", full_name: "辻 保", email: "a@example.com", role: "admin", active: true },
    { id: "u2", full_name: "退職済み 太郎", email: "b@example.com", role: "member", active: false },
  ];
  const rows = buildMemberListRows(members, []);
  const inactiveRow = rows.find(r => r.id === "u2");
  assert.equal(inactiveRow?.status, "inactive");
});

test("buildMemberListRows: pending招待は「招待待ち」として一覧に出る", () => {
  const invitations: MemberInvitation[] = [
    { id: "inv1", email: "new@example.com", full_name: "新規 花子", role: "member", status: "pending", expires_at: "2099-01-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
  ];
  const rows = buildMemberListRows([], invitations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "invitation");
  assert.equal(rows[0].status, "invited");
});

test("buildMemberListRows: 既にprofileが存在するメールの招待行は重複表示しない", () => {
  const members: Member[] = [
    { id: "u1", full_name: "辻 保", email: "a@example.com", role: "admin", active: true },
  ];
  const invitations: MemberInvitation[] = [
    { id: "inv1", email: "a@example.com", full_name: "辻 保", role: "admin", status: "pending", expires_at: "2099-01-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
  ];
  const rows = buildMemberListRows(members, invitations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "member");
});

test("memberErrorMessage: 既知のエラーコードを日本語メッセージへ変換する", () => {
  assert.equal(memberErrorMessage("cannot_deactivate_last_admin"), "組織内で最後の管理者を利用停止にはできません");
  assert.equal(memberErrorMessage("already_active_member"), "このメールアドレスは既に有効なメンバーとして登録されています");
});

test("memberErrorMessage: 未知のコードや空文字はフォールバックメッセージになる", () => {
  assert.equal(memberErrorMessage("some_unknown_code"), "操作に失敗しました。時間をおいて再度お試しください");
  assert.equal(memberErrorMessage(undefined), "操作に失敗しました。時間をおいて再度お試しください");
  assert.equal(memberErrorMessage(""), "操作に失敗しました。時間をおいて再度お試しください");
});

test("invitationErrorCode: 既知のビジネスエラーはそのままのコード（またはno_invitation）に変換される", () => {
  assert.equal(invitationErrorCode("no_pending_invitation"), "no_invitation");
  assert.equal(invitationErrorCode("account_inactive"), "account_inactive");
  assert.equal(invitationErrorCode("email_not_confirmed"), "email_not_confirmed");
  assert.equal(invitationErrorCode("ambiguous_invitation_state"), "ambiguous_invitation_state");
});

test("invitationErrorCode: 未知のRPCエラー・DB障害はsystem_errorになる（「招待なし」と誤表示しない）", () => {
  assert.equal(invitationErrorCode("function public.accept_pending_invitation() does not exist"), "system_error");
  assert.equal(invitationErrorCode("relation \"member_invitations\" does not exist"), "system_error");
  assert.equal(invitationErrorCode("connection timeout"), "system_error");
  assert.equal(invitationErrorCode(undefined), "system_error");
  assert.equal(invitationErrorCode(""), "system_error");
});

test("filterActivePendingInvitations: 期限切れのpending招待は「初回ログイン待ち」として表示しない", () => {
  const now = new Date("2026-07-17T00:00:00Z");
  const invitations: MemberInvitation[] = [
    { id: "inv-valid", email: "valid@example.com", full_name: "有効 太郎", role: "member", status: "pending", expires_at: "2026-07-20T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
    { id: "inv-expired", email: "expired@example.com", full_name: "期限切れ 花子", role: "member", status: "pending", expires_at: "2026-07-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
    { id: "inv-cancelled", email: "cancelled@example.com", full_name: "取消済 次郎", role: "member", status: "cancelled", expires_at: "2026-07-20T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
  ];
  const result = filterActivePendingInvitations(invitations, now);
  assert.deepEqual(result.map(i => i.id), ["inv-valid"]);
});

test("resolveViewFilterMemberId: 'all'はそのまま維持される", () => {
  const active: Member[] = [{ id: "u1", full_name: "辻 保", email: null, role: "admin", active: true }];
  assert.equal(resolveViewFilterMemberId("all", active), "all");
});

test("resolveViewFilterMemberId: 有効なメンバーIDはそのまま維持される", () => {
  const active: Member[] = [{ id: "u1", full_name: "辻 保", email: null, role: "admin", active: true }];
  assert.equal(resolveViewFilterMemberId("u1", active), "u1");
});

test("resolveViewFilterMemberId: 存在しない（削除・利用停止済みで有効メンバー一覧から外れた）IDは'all'へ戻る", () => {
  const active: Member[] = [{ id: "u1", full_name: "辻 保", email: null, role: "admin", active: true }];
  assert.equal(resolveViewFilterMemberId("u-deleted", active), "all");
  assert.equal(resolveViewFilterMemberId("u2-now-inactive", active), "all");
});

test("resolveCallIndex: 担当者フィルターが変わったら0へ戻る", () => {
  assert.equal(resolveCallIndex({ filterChanged: true, callIndex: 5, filteredCompaniesLength: 10 }), 0);
});

test("resolveCallIndex: フィルターは変わらないが件数減少でインデックスが範囲外になったら0へ補正する", () => {
  assert.equal(resolveCallIndex({ filterChanged: false, callIndex: 5, filteredCompaniesLength: 3 }), 0);
});

test("resolveCallIndex: 範囲内なら変更しない", () => {
  assert.equal(resolveCallIndex({ filterChanged: false, callIndex: 1, filteredCompaniesLength: 3 }), 1);
});

test("resolveCallIndex: 件数が0の場合はインデックスを補正しない（0除算を避けるのはnext側の責務）", () => {
  assert.equal(resolveCallIndex({ filterChanged: false, callIndex: 2, filteredCompaniesLength: 0 }), 2);
});

test("computeTeamKpis: 全ログを渡すとチーム全体の数値になる", () => {
  const logs: CallLog[] = [
    { id: "l1", company_id: "c1", company_name: "A", caller_id: "u1", caller_name: "辻 保", result: "アポ獲得", note: "", created_at: "2026-07-01T00:00:00Z" },
    { id: "l2", company_id: "c2", company_name: "B", caller_id: "u2", caller_name: "山田 花子", result: "担当者不在", note: "", created_at: "2026-07-02T00:00:00Z" },
  ];
  const kpis = computeTeamKpis(logs);
  assert.equal(kpis.totalCalls, 2);
  assert.equal(kpis.totalAppointments, 1);
  assert.equal(kpis.connectionRate, 50);
});

test("computeTeamKpis: filterLogsByMemberと組み合わせると、選択担当者だけの数値になる（メンバー実績画面の担当者フィルター連動）", () => {
  const logs: CallLog[] = [
    { id: "l1", company_id: "c1", company_name: "A", caller_id: "u1", caller_name: "辻 保", result: "アポ獲得", note: "", created_at: "2026-07-01T00:00:00Z" },
    { id: "l2", company_id: "c2", company_name: "B", caller_id: "u2", caller_name: "山田 花子", result: "資料送付", note: "", created_at: "2026-07-02T00:00:00Z" },
    { id: "l3", company_id: "c3", company_name: "C", caller_id: "u1", caller_name: "辻 保", result: "担当者不在", note: "", created_at: "2026-07-03T00:00:00Z" },
  ];
  const kpisForU1 = computeTeamKpis(filterLogsByMember(logs, "u1"));
  assert.equal(kpisForU1.totalCalls, 2);
  assert.equal(kpisForU1.totalAppointments, 1);
  const kpisForAll = computeTeamKpis(filterLogsByMember(logs, "all"));
  assert.equal(kpisForAll.totalCalls, 3);
});
