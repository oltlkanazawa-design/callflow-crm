// Codex解析結果のnext_action_at（日付のみ・オフセット付き日時・UTC日時・オフセットなし日時のいずれか、
// またはnull）を、画面の「日付」欄・「時刻（任意）」欄へ安全に分解・結合するための純粋関数群。
//
// <input type="datetime-local">はYYYY-MM-DDTHH:mm形式以外を受け付けず、日付のみ判明している場合
// （例：「来週火曜日」のように時刻が発言に存在しない場合）にそのまま値を渡すと空欄表示になる。
// また、発言にない時刻を09:00や00:00へ勝手に補完すると、実際には分かっていない情報をあたかも
// 聞き取った内容であるかのように表示してしまうため、時刻が不明な場合は「不明」のまま扱う。

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** 実在する暦日かどうかをタイムゾーンに依存せず検証する（UTC基準のカレンダー計算のみ使用）。 */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

export interface SplitDateTime {
  /** YYYY-MM-DD。不明な場合は空文字。 */
  date: string;
  /** HH:mm。不明な場合は空文字。 */
  time: string;
}

/**
 * next_action_atを「日付」と「時刻（任意）」へ分解する。
 * - 日付のみの文字列（YYYY-MM-DD）はタイムゾーン変換を一切行わずそのまま日付として扱う
 *   （Dateオブジェクトを経由すると常にUTC 0時として解釈されるため、Asia/Tokyoより西の
 *   タイムゾーンで動作するブラウザでは前日にずれてしまう）。
 * - オフセット・Z付きの日時は、ブラウザ実行環境のシステムタイムゾーン設定に依存しないよう、
 *   Asia/Tokyoの暦日・時刻へ明示的に変換する。
 * - オフセットのない日時（Codexは通常生成しない想定だが、防御的に扱う）は、既にAsia/Tokyoの
 *   壁時計時刻を表しているものとみなし、Dateオブジェクトを経由せず文字列から直接取り出す。
 */
export function splitAnalysisDateTime(iso: string | null): SplitDateTime {
  if (!iso) return { date: "", time: "" };

  const dateOnly = DATE_ONLY_RE.exec(iso);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return isValidCalendarDate(Number(y), Number(mo), Number(d)) ? { date: iso, time: "" } : { date: "", time: "" };
  }

  const naive = NAIVE_DATETIME_RE.exec(iso);
  if (naive) {
    const [, datePart, h, mi] = naive;
    const [y, mo, d] = datePart.split("-").map(Number);
    const validDate = isValidCalendarDate(y, mo, d);
    const validTime = Number(h) <= 23 && Number(mi) <= 59;
    return validDate && validTime ? { date: datePart, time: `${h}:${mi}` } : { date: "", time: "" };
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { date: "", time: "" };

  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(parsed);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/**
 * 「日付」と「時刻（任意）」からnext_action_atとして保存する文字列を組み立てる。
 * 時刻が空の場合は日付のみのISO文字列にする（時刻を捏造しない）。日付が空なら常にnull。
 */
export function combineDateTime(date: string, time: string): string | null {
  if (!date) return null;
  return time ? `${date}T${time}` : date;
}

/** next_action_atを「分解して結合し直す」ことで、UI入力欄と一致する正規形へ変換する。 */
export function normalizeAnalysisDateTime(iso: string | null): string {
  const { date, time } = splitAnalysisDateTime(iso);
  return combineDateTime(date, time) ?? "";
}
