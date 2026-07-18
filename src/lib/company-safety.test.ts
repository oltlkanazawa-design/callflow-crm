import { test } from "node:test";
import assert from "node:assert/strict";
import { companySafetyErrorMessage, matchScopeLabel } from "./company-safety.ts";

test("companySafetyErrorMessage: 既知のRPCエラーコードを日本語メッセージへ変換する", () => {
  assert.equal(companySafetyErrorMessage("call_prohibited"), "この企業は架電禁止に設定されています");
  assert.equal(companySafetyErrorMessage("reason_required"), "理由の入力が必要です");
  assert.equal(companySafetyErrorMessage("blocklist_entry_already_active"), "この企業は既に架電禁止に設定されています");
});

test("companySafetyErrorMessage: match_scope関連の新しいエラーコードを日本語へ変換する", () => {
  assert.equal(companySafetyErrorMessage("invalid_match_scope"), "一致条件の指定が正しくありません");
  assert.equal(companySafetyErrorMessage("phone_required_for_scope"), "電話番号一致を選ぶ場合は、電話番号の入力が必要です");
  assert.equal(companySafetyErrorMessage("domain_required_for_scope"), "公式URLドメイン一致を選ぶ場合は、公式URLの入力が必要です");
  assert.equal(companySafetyErrorMessage("name_and_location_required_for_scope"), "企業名+所在地一致を選ぶ場合は、企業名と所在地の両方の入力が必要です");
  assert.equal(companySafetyErrorMessage("name_required_for_scope"), "企業名のみ一致を選ぶ場合は、企業名の入力が必要です");
});

test("companySafetyErrorMessage: create_companies_checkedの安全な行エラーコードを日本語へ変換する", () => {
  assert.equal(companySafetyErrorMessage("invalid_on_duplicate"), "重複時の処理方法の指定が正しくありません");
  assert.equal(companySafetyErrorMessage("duplicate_key"), "同じ識別子の登録が既に存在するため保存できませんでした");
  assert.equal(companySafetyErrorMessage("invalid_value"), "入力値の形式が正しくありません");
  assert.equal(companySafetyErrorMessage("value_too_long"), "入力値が長すぎます");
  assert.equal(companySafetyErrorMessage("row_save_failed"), "この行の保存に失敗しました");
});

test("companySafetyErrorMessage: 未知の文字列はそのまま表示せず汎用メッセージへ変換する（Postgresの生メッセージを画面に出さないため）", () => {
  assert.equal(companySafetyErrorMessage("some_unknown_code"), "処理に失敗しました");
  assert.equal(companySafetyErrorMessage("ERROR: duplicate key value violates unique constraint \"call_blocklist_phone_unique\""), "処理に失敗しました");
  assert.equal(companySafetyErrorMessage(""), "処理に失敗しました");
});

test("companySafetyErrorMessage: 前後の空白は無視して一致判定する", () => {
  assert.equal(companySafetyErrorMessage("  name_required  "), "企業名を入力してください");
});

test("companySafetyErrorMessage: Postgresの再試行可能なSQLSTATEコードを日本語の再試行メッセージへ変換する", () => {
  assert.match(companySafetyErrorMessage("deadlock detected", "40P01"), /再度お試しください/);
  assert.match(companySafetyErrorMessage("lock not available", "55P03"), /再度お試しください/);
  assert.match(companySafetyErrorMessage("query canceled", "57014"), /再度お試しください/);
  assert.match(companySafetyErrorMessage("serialization failure", "40001"), /再度お試しください/);
});

test("companySafetyErrorMessage: コードが既知のエラーメッセージと一致する場合はコードを優先する（メッセージ内容に依存しない）", () => {
  // メッセージが未知の生文字列でも、コードがSQLSTATEと一致すれば安全な再試行メッセージになる
  assert.match(companySafetyErrorMessage("could not serialize access due to concurrent update", "40001"), /再度お試しください/);
});

test("matchScopeLabel: 既知のスコープを日本語ラベルへ変換する", () => {
  assert.equal(matchScopeLabel("phone"), "電話番号が一致");
  assert.equal(matchScopeLabel("domain"), "公式URLのドメインが一致");
  assert.equal(matchScopeLabel("name_location"), "企業名・所在地が一致");
  assert.equal(matchScopeLabel("name_only"), "企業名のみ一致");
  assert.equal(matchScopeLabel("strict"), "強一致条件のいずれかが一致");
});

test("matchScopeLabel: 未知のスコープは不明として表示する（そのままの値を画面に出さない）", () => {
  assert.equal(matchScopeLabel("something_unexpected"), "不明な一致条件");
  assert.equal(matchScopeLabel(""), "不明な一致条件");
});
