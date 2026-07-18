import { test } from "node:test";
import assert from "node:assert/strict";
import { companySafetyErrorMessage, matchScopeLabel } from "./company-safety.ts";

test("companySafetyErrorMessage: 既知のRPCエラーコードを日本語メッセージへ変換する", () => {
  assert.equal(companySafetyErrorMessage("call_prohibited"), "この企業は架電禁止に設定されています");
  assert.equal(companySafetyErrorMessage("reason_required"), "理由の入力が必要です");
  assert.equal(companySafetyErrorMessage("blocklist_entry_already_active"), "この企業は既に架電禁止に設定されています");
});

test("companySafetyErrorMessage: 未知のコードや空文字はそのまま／フォールバックを返す", () => {
  assert.equal(companySafetyErrorMessage("some_unknown_code"), "some_unknown_code");
  assert.equal(companySafetyErrorMessage(""), "処理に失敗しました");
});

test("companySafetyErrorMessage: 前後の空白は無視して一致判定する", () => {
  assert.equal(companySafetyErrorMessage("  name_required  "), "企業名を入力してください");
});

test("matchScopeLabel: 既知のスコープを日本語ラベルへ変換する", () => {
  assert.equal(matchScopeLabel("phone"), "電話番号が一致");
  assert.equal(matchScopeLabel("domain"), "公式URLのドメインが一致");
  assert.equal(matchScopeLabel("name_location"), "企業名・所在地が一致");
  assert.equal(matchScopeLabel("name_only"), "企業名のみ一致");
});

test("matchScopeLabel: 未知のスコープはそのまま返す", () => {
  assert.equal(matchScopeLabel("strict"), "strict");
});
