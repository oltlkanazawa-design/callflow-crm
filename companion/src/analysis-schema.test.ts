import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnalysisJson } from "./analysis-schema.ts";

function validAnalysisJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: "資料送付",
    heat: "中",
    summary: "採用広報について説明した。",
    contact_name: null,
    challenges: [],
    next_action: "資料をメールで送付する",
    next_action_at: null,
    confidence: 0.8,
    needs_review: false,
    review_reasons: [],
    ...overrides,
  });
}

test("validateAnalysisJson: next_action_atが日付のみ（YYYY-MM-DD）でも、null化・needs_review強制なしで通過する", () => {
  const result = validateAnalysisJson(validAnalysisJson({ next_action_at: "2026-07-28" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.next_action_at, "2026-07-28");
    assert.equal(result.value.needs_review, false);
    assert.deepEqual(result.value.review_reasons, []);
  }
});

test("validateAnalysisJson: next_action_atが日付＋時刻（オフセット付き）でも正しく通過する", () => {
  const result = validateAnalysisJson(validAnalysisJson({ next_action_at: "2026-07-28T10:00:00+09:00" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.next_action_at, "2026-07-28T10:00:00+09:00");
    assert.equal(result.value.needs_review, false);
  }
});

test("validateAnalysisJson: next_action_atがISO 8601として解釈できない場合はnull化しneeds_reviewを立てる", () => {
  const result = validateAnalysisJson(validAnalysisJson({ next_action_at: "来週火曜日" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.next_action_at, null);
    assert.equal(result.value.needs_review, true);
    assert.ok(result.value.review_reasons.some((r) => r.includes("解釈できません")));
  }
});

test("validateAnalysisJson: next_action_atがnullなら何もせずそのまま通過する", () => {
  const result = validateAnalysisJson(validAnalysisJson({ next_action_at: null }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.next_action_at, null);
    assert.equal(result.value.needs_review, false);
  }
});

test("validateAnalysisJson: next_action_atが過去日時（日付のみ）ならneeds_reviewを立てる", () => {
  const result = validateAnalysisJson(validAnalysisJson({ next_action_at: "2020-01-01" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.next_action_at, "2020-01-01");
    assert.equal(result.value.needs_review, true);
    assert.ok(result.value.review_reasons.some((r) => r.includes("過去")));
  }
});

test("validateAnalysisJson: next_action_atが1年以上先ならneeds_reviewを立てる", () => {
  const result = validateAnalysisJson(validAnalysisJson({ next_action_at: "2099-01-01" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.needs_review, true);
    assert.ok(result.value.review_reasons.some((r) => r.includes("1年以上先")));
  }
});
