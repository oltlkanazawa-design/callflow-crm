import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAnalysisDateTime, combineDateTime, normalizeAnalysisDateTime } from "./analysis-datetime.ts";

test("splitAnalysisDateTime: 日付のみ（YYYY-MM-DD）はタイムゾーン変換せずそのまま日付として扱う", () => {
  assert.deepEqual(splitAnalysisDateTime("2026-07-28"), { date: "2026-07-28", time: "" });
});

test("splitAnalysisDateTime: オフセットなしの日時（YYYY-MM-DDTHH:mm）はAsia/Tokyoの壁時計時刻としてそのまま扱う", () => {
  assert.deepEqual(splitAnalysisDateTime("2026-07-28T14:30"), { date: "2026-07-28", time: "14:30" });
});

test("splitAnalysisDateTime: 秒付き・オフセット付き日時（YYYY-MM-DDTHH:mm:ss+09:00）を正しく分解する", () => {
  assert.deepEqual(splitAnalysisDateTime("2026-07-28T14:30:00+09:00"), { date: "2026-07-28", time: "14:30" });
});

test("splitAnalysisDateTime: UTCのZ付き日時をAsia/Tokyoの暦日へ正しく変換する（日またぎ）", () => {
  // 2026-07-27T15:00:00Z は Asia/Tokyo では 2026-07-28T00:00（翌日）
  assert.deepEqual(splitAnalysisDateTime("2026-07-27T15:00:00Z"), { date: "2026-07-28", time: "00:00" });
});

test("splitAnalysisDateTime: UTCのZ付き日時で前日にずれるケースも正しく変換する", () => {
  // 2026-07-28T23:30:00+09:00 は UTC では 2026-07-28T14:30:00Z
  assert.deepEqual(splitAnalysisDateTime("2026-07-28T14:30:00Z"), { date: "2026-07-28", time: "23:30" });
});

test("splitAnalysisDateTime: nullは日付・時刻ともに空文字", () => {
  assert.deepEqual(splitAnalysisDateTime(null), { date: "", time: "" });
});

test("splitAnalysisDateTime: 無効な日時文字列は空文字にフォールバックする（inputへ無効値を設定しない）", () => {
  assert.deepEqual(splitAnalysisDateTime("来週火曜日"), { date: "", time: "" });
  assert.deepEqual(splitAnalysisDateTime("2026-13-99"), { date: "", time: "" });
});

test("splitAnalysisDateTime: 日付だけ判明し時刻が無いケースで、時刻を09:00や00:00へ捏造しない", () => {
  const result = splitAnalysisDateTime("2026-07-28");
  assert.equal(result.time, "");
});

test("combineDateTime: 日付のみの場合は時刻を補完せず日付のみのISO文字列にする", () => {
  assert.equal(combineDateTime("2026-07-28", ""), "2026-07-28");
});

test("combineDateTime: 日付・時刻の両方がある場合はdatetime-local形式で結合する", () => {
  assert.equal(combineDateTime("2026-07-28", "14:30"), "2026-07-28T14:30");
});

test("combineDateTime: 日付が空の場合は常にnull（時刻だけの入力は無視する）", () => {
  assert.equal(combineDateTime("", ""), null);
  assert.equal(combineDateTime("", "14:30"), null);
});

test("normalizeAnalysisDateTime: 日付のみ・日時・null・無効値のいずれも正しい正規形へ変換する", () => {
  assert.equal(normalizeAnalysisDateTime("2026-07-28"), "2026-07-28");
  assert.equal(normalizeAnalysisDateTime("2026-07-28T14:30:00+09:00"), "2026-07-28T14:30");
  assert.equal(normalizeAnalysisDateTime(null), "");
  assert.equal(normalizeAnalysisDateTime("invalid"), "");
});

test("normalizeAnalysisDateTime: 分解して結合し直しても同じ暦日になる（往復で日付がずれない）", () => {
  const iso = "2026-07-27T15:00:00Z"; // Asia/Tokyoでは2026-07-28T00:00
  assert.equal(normalizeAnalysisDateTime(iso), "2026-07-28T00:00");
});
