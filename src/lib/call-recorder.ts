// ブラウザ録音機能（Phase 1）の純粋関数群。
// getUserMedia/MediaRecorder/AudioContext等のブラウザAPIには一切依存しない。
// src/components/call-recorder.tsx から呼び出される。

export type RecorderState =
  | "unsupported"
  | "idle"
  | "requesting_permission"
  | "ready"
  | "testing"
  | "test_recorded"
  | "recording"
  | "recorded"
  | "error";

export type RecorderEvent =
  | { type: "UNSUPPORTED" }
  | { type: "REQUEST_PERMISSION" }
  | { type: "PERMISSION_GRANTED" }
  | { type: "PERMISSION_DENIED" }
  | { type: "START_TEST" }
  | { type: "TEST_COMPLETE" }
  | { type: "DISCARD_TEST" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" }
  | { type: "DISCARD_RECORDING" }
  | { type: "ERROR" }
  | { type: "RESET" };

// 録音状態の遷移表。ここに定義した組み合わせ以外は無効な遷移として無視する
// （不正な状態遷移の防止。例: 録音中の二重録音開始、未録音での停止、録音中のテスト開始等）。
const TRANSITIONS: Partial<Record<RecorderState, Partial<Record<RecorderEvent["type"], RecorderState>>>> = {
  idle: { REQUEST_PERMISSION: "requesting_permission", UNSUPPORTED: "unsupported" },
  requesting_permission: { PERMISSION_GRANTED: "ready", PERMISSION_DENIED: "error" },
  ready: { START_TEST: "testing", START_RECORDING: "recording" },
  testing: { TEST_COMPLETE: "test_recorded", ERROR: "error" },
  test_recorded: { DISCARD_TEST: "ready", START_TEST: "testing", START_RECORDING: "recording" },
  recording: { STOP_RECORDING: "recorded", ERROR: "error" },
  recorded: { DISCARD_RECORDING: "ready" },
  error: { RESET: "idle" },
  unsupported: {},
};

/** 現在の状態とイベントから次の状態を返す。無効な遷移の場合は現在の状態のまま（no-op）。 */
export function transition(state: RecorderState, event: RecorderEvent): RecorderState {
  return TRANSITIONS[state]?.[event.type] ?? state;
}

export function canStartTest(state: RecorderState): boolean {
  return state === "ready" || state === "test_recorded";
}
export function canStartRecording(state: RecorderState): boolean {
  return state === "ready" || state === "test_recorded";
}
export function canStopRecording(state: RecorderState): boolean {
  return state === "recording";
}
export function canChangeMicrophone(state: RecorderState): boolean {
  return state !== "recording" && state !== "testing" && state !== "requesting_permission";
}
export function isLocked(state: RecorderState): boolean {
  return state === "recording";
}
export function hasPendingRecording(state: RecorderState): boolean {
  return state === "recorded";
}

// ---------------------------------------------------------
// 上限・タイミング関連の定数
// ---------------------------------------------------------
export const MAX_RECORDING_MS = 60 * 60 * 1000; // 60分
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024; // 100MB
export const TEST_RECORDING_MS = 5000; // 5秒マイクテスト
export const RECORDING_TIMESLICE_MS = 1000; // MediaRecorder.startのtimeslice

export function isOverMaxDuration(elapsedMs: number): boolean {
  return elapsedMs >= MAX_RECORDING_MS;
}
export function isOverMaxSize(bytes: number): boolean {
  return bytes >= MAX_RECORDING_BYTES;
}

// ---------------------------------------------------------
// MIME Type選択
// ---------------------------------------------------------
export const MIME_TYPE_PRIORITY = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

/**
 * 優先順位に従って、ブラウザが対応するMIME Typeを選ぶ。
 * isTypeSupportedはMediaRecorder.isTypeSupportedを渡すことを想定した注入可能な関数
 * （テストではモックを渡す）。すべて非対応の場合はnull（呼び出し側はブラウザ既定のMIME Typeで録音する）。
 */
export function pickSupportedMimeType(isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of MIME_TYPE_PRIORITY) {
    if (isTypeSupported(mime)) return mime;
  }
  return null;
}

export function extensionForMimeType(mime: string | null): string {
  if (!mime) return "webm";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return "webm";
}

// ---------------------------------------------------------
// 表示用フォーマット
// ---------------------------------------------------------
function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

/** 経過時間をmm:ss（1時間以上ならhh:mm:ss）形式で表示する。 */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** おおよそのファイルサイズをB/KB/MB単位で表示する。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 2桁ゼロ埋めの日時文字列（ローカル時刻）を生成する。ダウンロードファイル名に使う。 */
function localTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * ダウンロード用ファイル名を生成する。企業名・電話番号等の個人情報を含めない
 * （ご指示どおり、日時のみで一意になるようにする）。
 */
export function buildRecordingFileName(date: Date, mime: string | null): string {
  return `callflow-recording-${localTimestamp(date)}.${extensionForMimeType(mime)}`;
}

// ---------------------------------------------------------
// マイク音量の目安判定
// ---------------------------------------------------------
/** 0〜1に正規化された音量ピーク値から、目安を判定する（あくまで目安。厳密なdB計測ではない）。 */
export const LOW_VOLUME_THRESHOLD = 0.02;

export function classifyVolumeLevel(peakLevel: number): "ok" | "low" {
  return peakLevel < LOW_VOLUME_THRESHOLD ? "low" : "ok";
}

// ---------------------------------------------------------
// 企業の取り違え防止
// ---------------------------------------------------------
/** 録音開始時に記録した企業idと、現在表示中の企業idが一致するかを判定する。 */
export function isSameCompany(recordingCompanyId: string | null, currentCompanyId: string | undefined): boolean {
  return Boolean(recordingCompanyId) && recordingCompanyId === currentCompanyId;
}
