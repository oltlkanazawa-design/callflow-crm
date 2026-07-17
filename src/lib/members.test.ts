import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterCompaniesByMember, filterLogsByMember, activeMemberOptions, buildMemberListRows, memberErrorMessage,
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
