import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowDemoEntry } from "./login-demo-entry.ts";

test("shouldShowDemoEntry: Supabase設定済みならデモ版ボタンを表示しない（デモ許可の値によらない）", () => {
  assert.equal(shouldShowDemoEntry(true, true), false);
  assert.equal(shouldShowDemoEntry(true, false), false);
});

test("shouldShowDemoEntry: Supabase未設定＋デモ許可ならデモ版ボタンを表示する", () => {
  assert.equal(shouldShowDemoEntry(false, true), true);
});

test("shouldShowDemoEntry: Supabase未設定＋デモ不許可（NEXT_PUBLIC_ALLOW_DEMO=false）ならデモ版ボタンを表示しない", () => {
  assert.equal(shouldShowDemoEntry(false, false), false);
});
