// 営業通話解析の構造化出力スキーマと検証。
// companion/配下は既存方針どおりNode標準機能のみで完結させる（zod等の外部ライブラリは追加しない）。
// turn/startのoutputSchemaにはJSON Schemaをそのまま渡し、返ってきたJSONは
// Codex側のスキーマ適合をそのまま信用せず、ここでもう一度独立に検証する。

export const CALL_RESULT_VALUES = ["アポ獲得", "資料送付", "再架電", "担当者不在", "見込みなし", "その他"] as const;
export type CallResult = (typeof CALL_RESULT_VALUES)[number];

export const HEAT_VALUES = ["高", "中", "低"] as const;
export type Heat = (typeof HEAT_VALUES)[number];

const MAX_SUMMARY_LENGTH = 2000;
const MAX_CONTACT_NAME_LENGTH = 100;
const MAX_CHALLENGE_LENGTH = 300;
const MAX_CHALLENGES_COUNT = 10;
const MAX_NEXT_ACTION_LENGTH = 500;
const MAX_REVIEW_REASON_LENGTH = 300;
const MAX_REVIEW_REASONS_COUNT = 10;

export interface CallAnalysisResult {
  result: CallResult;
  heat: Heat;
  summary: string;
  contact_name: string | null;
  challenges: string[];
  next_action: string;
  next_action_at: string | null;
  confidence: number;
  needs_review: boolean;
  review_reasons: string[];
}

/** turn/startのoutputSchemaパラメータへそのまま渡すJSON Schema。 */
export const ANALYSIS_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "result",
    "heat",
    "summary",
    "contact_name",
    "challenges",
    "next_action",
    "next_action_at",
    "confidence",
    "needs_review",
    "review_reasons",
  ],
  properties: {
    result: { type: "string", enum: [...CALL_RESULT_VALUES] },
    heat: { type: "string", enum: [...HEAT_VALUES] },
    summary: { type: "string", maxLength: MAX_SUMMARY_LENGTH },
    contact_name: { type: ["string", "null"], maxLength: MAX_CONTACT_NAME_LENGTH },
    challenges: {
      type: "array",
      items: { type: "string", maxLength: MAX_CHALLENGE_LENGTH },
      maxItems: MAX_CHALLENGES_COUNT,
    },
    next_action: { type: "string", maxLength: MAX_NEXT_ACTION_LENGTH },
    next_action_at: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_review: { type: "boolean" },
    review_reasons: {
      type: "array",
      items: { type: "string", maxLength: MAX_REVIEW_REASON_LENGTH },
      maxItems: MAX_REVIEW_REASONS_COUNT,
    },
  },
} as const;

export type ValidationResult =
  | { ok: true; value: CallAnalysisResult }
  | { ok: false; reason: string };

function isStringWithin(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isStringArrayWithin(value: unknown, maxItemLength: number, maxItems: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  return value.every((item) => isStringWithin(item, maxItemLength));
}

/**
 * CodexのagentMessage.text（JSON文字列）をパース・検証する。
 * outputSchema適合はCodex側のベストエフォートでしかないため、ここで独立に再検証する。
 * additionalPropertiesはここでも明示的に拒否する（objectとしてキーを検査する）。
 */
export function validateAnalysisJson(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSONとして解釈できません" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "オブジェクトではありません" };
  }

  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(ANALYSIS_OUTPUT_JSON_SCHEMA.required);
  const extraKeys = Object.keys(obj).filter((k) => !allowedKeys.has(k as (typeof ANALYSIS_OUTPUT_JSON_SCHEMA.required)[number]));
  if (extraKeys.length > 0) {
    return { ok: false, reason: `許可されていない項目が含まれています: ${extraKeys.join(",")}` };
  }

  if (!CALL_RESULT_VALUES.includes(obj.result as CallResult)) {
    return { ok: false, reason: "resultの値が不正です" };
  }
  if (!HEAT_VALUES.includes(obj.heat as Heat)) {
    return { ok: false, reason: "heatの値が不正です" };
  }
  if (!isStringWithin(obj.summary, MAX_SUMMARY_LENGTH)) {
    return { ok: false, reason: "summaryが不正です" };
  }
  if (obj.contact_name !== null && !isStringWithin(obj.contact_name, MAX_CONTACT_NAME_LENGTH)) {
    return { ok: false, reason: "contact_nameが不正です" };
  }
  if (!isStringArrayWithin(obj.challenges, MAX_CHALLENGE_LENGTH, MAX_CHALLENGES_COUNT)) {
    return { ok: false, reason: "challengesが不正です" };
  }
  if (!isStringWithin(obj.next_action, MAX_NEXT_ACTION_LENGTH)) {
    return { ok: false, reason: "next_actionが不正です" };
  }
  if (obj.next_action_at !== null && typeof obj.next_action_at !== "string") {
    return { ok: false, reason: "next_action_atが不正です" };
  }
  if (typeof obj.confidence !== "number" || Number.isNaN(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    return { ok: false, reason: "confidenceが不正です" };
  }
  if (typeof obj.needs_review !== "boolean") {
    return { ok: false, reason: "needs_reviewが不正です" };
  }
  if (!isStringArrayWithin(obj.review_reasons, MAX_REVIEW_REASON_LENGTH, MAX_REVIEW_REASONS_COUNT)) {
    return { ok: false, reason: "review_reasonsが不正です" };
  }

  let nextActionAt = obj.next_action_at as string | null;
  let needsReview = obj.needs_review as boolean;
  const reviewReasons = [...(obj.review_reasons as string[])];

  // Codexの自己申告のnext_action_atをそのまま信用しない。ISO 8601として無効、
  // 過去日時、または1年以上先の異常値はneeds_reviewを強制的に立てる。
  if (nextActionAt !== null) {
    const parsedDate = Date.parse(nextActionAt);
    if (Number.isNaN(parsedDate)) {
      needsReview = true;
      reviewReasons.push("次回対応日がISO 8601形式として解釈できません");
      nextActionAt = null;
    } else {
      const now = Date.now();
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      if (parsedDate < now - 24 * 60 * 60 * 1000) {
        needsReview = true;
        reviewReasons.push("次回対応日が過去の日時になっています");
      } else if (parsedDate > now + oneYearMs) {
        needsReview = true;
        reviewReasons.push("次回対応日が1年以上先になっています");
      }
    }
  }

  return {
    ok: true,
    value: {
      result: obj.result as CallResult,
      heat: obj.heat as Heat,
      summary: obj.summary as string,
      contact_name: obj.contact_name as string | null,
      challenges: obj.challenges as string[],
      next_action: obj.next_action as string,
      next_action_at: nextActionAt,
      confidence: obj.confidence as number,
      needs_review: needsReview,
      review_reasons: reviewReasons,
    },
  };
}
