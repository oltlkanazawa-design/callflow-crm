import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transition, canStartTest, canStartRecording, canStopRecording, canChangeMicrophone, isLocked, hasPendingRecording,
  pickSupportedMimeType, extensionForMimeType, formatElapsedTime, formatFileSize, buildRecordingFileName,
  isOverMaxDuration, isOverMaxSize, classifyVolumeLevel, isSameCompany,
  MAX_RECORDING_MS, MAX_RECORDING_BYTES,
} from "./call-recorder.ts";

// --- MIME Type優先順位 ---
test("pickSupportedMimeType: 優先順位どおりに最初の対応形式を選ぶ", () => {
  const supported = new Set(["audio/webm", "audio/mp4"]);
  const mime = pickSupportedMimeType((m) => supported.has(m));
  assert.equal(mime, "audio/webm");
});
test("pickSupportedMimeType: opus対応なら最優先で選ぶ", () => {
  const supported = new Set(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
  assert.equal(pickSupportedMimeType((m) => supported.has(m)), "audio/webm;codecs=opus");
});
test("pickSupportedMimeType: 対応MIMEが無い場合はnullを返す", () => {
  assert.equal(pickSupportedMimeType(() => false), null);
});

// --- 拡張子判定 ---
test("extensionForMimeType: webm系はwebm", () => {
  assert.equal(extensionForMimeType("audio/webm;codecs=opus"), "webm");
});
test("extensionForMimeType: mp4系はmp4", () => {
  assert.equal(extensionForMimeType("audio/mp4"), "mp4");
});
test("extensionForMimeType: nullはwebmへフォールバック", () => {
  assert.equal(extensionForMimeType(null), "webm");
});

// --- 経過時間表示 ---
test("formatElapsedTime: 分・秒を2桁ゼロ埋めで表示する", () => {
  assert.equal(formatElapsedTime(5000), "00:05");
  assert.equal(formatElapsedTime(65000), "01:05");
});
test("formatElapsedTime: 1時間以上はhh:mm:ssで表示する", () => {
  assert.equal(formatElapsedTime(60 * 60 * 1000 + 61000), "01:01:01");
});
test("formatElapsedTime: 負の値でも00:00のまま", () => {
  assert.equal(formatElapsedTime(-100), "00:00");
});

// --- 60分・100MB制限 ---
test("isOverMaxDuration: 60分ちょうどで上限超過と判定する", () => {
  assert.equal(isOverMaxDuration(MAX_RECORDING_MS - 1), false);
  assert.equal(isOverMaxDuration(MAX_RECORDING_MS), true);
});
test("isOverMaxSize: 100MBちょうどで上限超過と判定する", () => {
  assert.equal(isOverMaxSize(MAX_RECORDING_BYTES - 1), false);
  assert.equal(isOverMaxSize(MAX_RECORDING_BYTES), true);
});

// --- 録音サイズ表示 ---
test("formatFileSize: バイト単位を適切な単位で表示する", () => {
  assert.equal(formatFileSize(500), "500B");
  assert.equal(formatFileSize(2048), "2.0KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5.0MB");
});

// --- ダウンロード拡張子判定（ファイル名） ---
test("buildRecordingFileName: 日時と拡張子からファイル名を生成し、個人情報を含めない", () => {
  const date = new Date(2026, 6, 21, 14, 30, 0); // 2026-07-21 14:30:00 (ローカル)
  const name = buildRecordingFileName(date, "audio/webm;codecs=opus");
  assert.equal(name, "callflow-recording-20260721-143000.webm");
  assert.doesNotMatch(name, /[ぁ-んァ-ヶ一-龠]/); // 企業名等の日本語文字を含まないこと
});
test("buildRecordingFileName: mp4形式ならmp4拡張子になる", () => {
  const date = new Date(2026, 0, 1, 0, 0, 0);
  assert.equal(buildRecordingFileName(date, "audio/mp4"), "callflow-recording-20260101-000000.mp4");
});

// --- 音量の目安判定 ---
test("classifyVolumeLevel: 閾値未満はlow、以上はok", () => {
  assert.equal(classifyVolumeLevel(0.001), "low");
  assert.equal(classifyVolumeLevel(0.5), "ok");
});

// --- 企業ID一致判定 ---
test("isSameCompany: 一致する場合はtrue", () => {
  assert.equal(isSameCompany("company-1", "company-1"), true);
});
test("isSameCompany: 不一致の場合はfalse", () => {
  assert.equal(isSameCompany("company-1", "company-2"), false);
});
test("isSameCompany: 録音開始時の企業idが無い場合はfalse", () => {
  assert.equal(isSameCompany(null, "company-1"), false);
  assert.equal(isSameCompany("company-1", undefined), false);
});

// --- 状態遷移 ---
test("transition: idle→権限要求→許可でreadyになる", () => {
  let s = transition("idle", { type: "REQUEST_PERMISSION" });
  assert.equal(s, "requesting_permission");
  s = transition(s, { type: "PERMISSION_GRANTED" });
  assert.equal(s, "ready");
});
test("transition: 権限拒否でerrorになる", () => {
  const s = transition("requesting_permission", { type: "PERMISSION_DENIED" });
  assert.equal(s, "error");
});
test("transition: ready→録音開始→recordingになる", () => {
  assert.equal(transition("ready", { type: "START_RECORDING" }), "recording");
});
test("transition: 録音中にもう一度録音開始しても状態は変わらない（無効な遷移）", () => {
  assert.equal(transition("recording", { type: "START_RECORDING" }), "recording");
});
test("transition: 録音されていない状態で停止しても状態は変わらない（無効な遷移）", () => {
  assert.equal(transition("ready", { type: "STOP_RECORDING" }), "ready");
  assert.equal(transition("idle", { type: "STOP_RECORDING" }), "idle");
});
test("transition: 録音中に5秒テストを開始しても状態は変わらない（無効な遷移）", () => {
  assert.equal(transition("recording", { type: "START_TEST" }), "recording");
});
test("transition: recording→停止→recordedになる", () => {
  assert.equal(transition("recording", { type: "STOP_RECORDING" }), "recorded");
});
test("transition: recorded→破棄→readyになる", () => {
  assert.equal(transition("recorded", { type: "DISCARD_RECORDING" }), "ready");
});
test("transition: test_recorded→録音開始→recordingになる（テスト後に本番録音できる）", () => {
  assert.equal(transition("test_recorded", { type: "START_RECORDING" }), "recording");
});
test("transition: error→リセット→idleになる", () => {
  assert.equal(transition("error", { type: "RESET" }), "idle");
});
test("transition: unsupportedからは録音関連イベントで状態が変わらない", () => {
  assert.equal(transition("unsupported", { type: "START_RECORDING" }), "unsupported");
});

// --- 状態に応じた操作可否（マイク変更含む） ---
test("canStartTest: ready/test_recordedのみ許可", () => {
  assert.equal(canStartTest("ready"), true);
  assert.equal(canStartTest("test_recorded"), true);
  assert.equal(canStartTest("recording"), false);
  assert.equal(canStartTest("testing"), false);
});
test("canStartRecording: ready/test_recordedのみ許可", () => {
  assert.equal(canStartRecording("ready"), true);
  assert.equal(canStartRecording("recorded"), false);
});
test("canStopRecording: recordingのときだけ許可", () => {
  assert.equal(canStopRecording("recording"), true);
  assert.equal(canStopRecording("ready"), false);
});
test("canChangeMicrophone: 録音中・テスト中・権限要求中は変更不可", () => {
  assert.equal(canChangeMicrophone("recording"), false);
  assert.equal(canChangeMicrophone("testing"), false);
  assert.equal(canChangeMicrophone("requesting_permission"), false);
  assert.equal(canChangeMicrophone("ready"), true);
  assert.equal(canChangeMicrophone("idle"), true);
});
test("isLocked: recordingのときだけロック中と判定する", () => {
  assert.equal(isLocked("recording"), true);
  assert.equal(isLocked("recorded"), false);
});
test("hasPendingRecording: recordedのときだけ未破棄の録音ありと判定する", () => {
  assert.equal(hasPendingRecording("recorded"), true);
  assert.equal(hasPendingRecording("recording"), false);
  assert.equal(hasPendingRecording("ready"), false);
});
