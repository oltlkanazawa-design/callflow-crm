// AnalysisJobManager（営業通話解析ジョブ、Phase 4）の単体テスト。
// 実際のCodex CLI・ChatGPTアカウントは一切使用せず、analysis-test-support.tsの偽app-server
// （Node製JSONL）を使う。文字起こし側も同様にtranscription-test-support.tsの偽ffmpeg/whisper-cliを使う。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { AnalysisJobManager, loadAnalysisJobConfig, type AnalysisJobPublicView } from "./analysis-jobs.ts";
import { CodexAppServer } from "./codex-app-server.ts";
import { TranscriptionJobManager } from "./transcription-jobs.ts";
import { loadTranscriptionConfig } from "./transcription-config.ts";
import type { CompanionConfig } from "./types.ts";
import {
  createFakeTranscriptionBinaries,
  setWhisperText,
} from "./transcription-test-support.ts";
import { createFakeCodexBinary, type FakeCodexConfig } from "./analysis-test-support.ts";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-analysis-jobs-test-"));
}

function fakeCompanionConfig(tmpDir: string): CompanionConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    secure: false,
    allowInsecureHttp: true,
    tlsCertPath: null,
    tlsKeyPath: null,
    tmpDir,
    tokenStorePath: path.join(tmpDir, "pairing-tokens.json"),
    allowedOrigins: [],
    maxBodyBytes: 100 * 1024 * 1024,
    pairingCodeTtlMs: 5 * 60 * 1000,
    pairingMaxAttempts: 5,
    tokenLockoutOnLimit: true,
  };
}

function fakeRequest(chunks: (Buffer | Uint8Array)[]): IncomingMessage {
  async function* generate() {
    for (const chunk of chunks) yield chunk;
  }
  return Readable.from(generate()) as unknown as IncomingMessage;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!(await predicate())) {
    throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
  }
}

const TOKEN_A = "Bearer token-a-1234567890";
const TOKEN_B = "Bearer token-b-0987654321";

interface Harness {
  transcriptionJobs: TranscriptionJobManager;
  analysisJobs: AnalysisJobManager;
  codex: CodexAppServer;
  createCompletedTranscriptionJob: (text: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function makeHarness(
  analysisOverrides: Partial<import("./analysis-jobs.ts").AnalysisJobConfig> = {},
  codexOverrides: Partial<FakeCodexConfig> = {},
): Promise<Harness> {
  const tmpDir = await makeTmpDir();
  const transcriptionBinDir = await makeTmpDir();
  const codexWorkDir = await makeTmpDir();

  const { ffmpegPath, whisperCliPath, controlDir } = await createFakeTranscriptionBinaries(transcriptionBinDir);
  process.env.CALLFLOW_FAKE_CONTROL_DIR = controlDir;

  const transcriptionConfig = loadTranscriptionConfig({
    ffmpegPath,
    whisperCliPath,
    modelDir: transcriptionBinDir,
    ffmpegTimeoutMs: 5000,
    whisperMinTimeoutMs: 5000,
    whisperMaxTimeoutMs: 5000,
  });
  const transcriptionJobs = new TranscriptionJobManager(fakeCompanionConfig(tmpDir), transcriptionConfig);

  const { codexArgs } = await createFakeCodexBinary(codexWorkDir, codexOverrides);
  const codex = new CodexAppServer({
    codexBinaryPath: process.execPath,
    codexArgs,
    workDir: codexWorkDir,
    startupTimeoutMs: 5000,
    shutdownGraceMs: 200,
  });

  const analysisJobs = new AnalysisJobManager(
    loadAnalysisJobConfig({ workDir: codexWorkDir, turnTimeoutMs: 2000, ...analysisOverrides }),
    transcriptionJobs,
    codex,
  );

  const createCompletedTranscriptionJob = async (text: string): Promise<string> => {
    await setWhisperText(controlDir, text);
    const created = await transcriptionJobs.submitAudio(
      fakeRequest([Buffer.alloc(16, 7)]),
      TOKEN_A,
      "audio/webm",
      16,
    );
    if (!created.ok) throw new Error("failed to create transcription job: " + created.reason);
    await waitFor(() => transcriptionJobs.getJob(created.jobId, TOKEN_A)?.status === "completed", 5000);
    return created.jobId;
  };

  const cleanup = async () => {
    await analysisJobs.shutdown();
    await codex.stop();
    await transcriptionJobs.shutdown();
    delete process.env.CALLFLOW_FAKE_CONTROL_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(transcriptionBinDir, { recursive: true, force: true });
    await fs.rm(codexWorkDir, { recursive: true, force: true });
  };

  return { transcriptionJobs, analysisJobs, codex, createCompletedTranscriptionJob, cleanup };
}

test("正常系: 完了済みtranscriptionJobを参照して解析し、構造化出力を返す", async () => {
  const h = await makeHarness();
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト用の文字起こしです。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => {
      const job = h.analysisJobs.getJob(created.jobId, TOKEN_A);
      return job !== null && (job.status === "completed" || job.status === "failed");
    }, 5000);

    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.status, "completed");
    assert.ok(job.analysis);
    assert.equal(job.analysis?.result, "資料送付");
    assert.equal(job.analysis?.heat, "中");
    assert.equal(job.analysis?.contact_name, "テスト太郎");
  } finally {
    await h.cleanup();
  }
});

test("未ログイン: authMethodがnullの場合はnot_authenticatedになる", async () => {
  const h = await makeHarness({}, { authMethod: null });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.errorCode, "not_authenticated");
  } finally {
    await h.cleanup();
  }
});

test("利用上限: Codexが利用上限エラーを返した場合はusage_limit_exceededになる", async () => {
  const h = await makeHarness({}, { firstTurnBehavior: "usage_limit" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.errorCode, "usage_limit_exceeded");
  } finally {
    await h.cleanup();
  }
});

test("認証切れ: turnエラーがunauthorizedの場合はnot_authenticatedになる", async () => {
  const h = await makeHarness({}, { firstTurnBehavior: "unauthorized_turn_error" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.errorCode, "not_authenticated");
  } finally {
    await h.cleanup();
  }
});

test("不正JSON: 1回目が不正でも2回目（修正依頼）が正常なら完了する", async () => {
  const h = await makeHarness({}, { firstTurnBehavior: "invalid_json", secondTurnBehavior: "success" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => {
      const job = h.analysisJobs.getJob(created.jobId, TOKEN_A);
      return job !== null && (job.status === "completed" || job.status === "failed");
    }, 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.status, "completed");
  } finally {
    await h.cleanup();
  }
});

test("不正JSON: 2回連続で不正な場合はinvalid_outputでfailedになる（ローカル解析へは切り替えない）", async () => {
  const h = await makeHarness({}, { firstTurnBehavior: "invalid_json", secondTurnBehavior: "invalid_json" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.errorCode, "invalid_output");
    assert.equal(job.analysis, null);
  } finally {
    await h.cleanup();
  }
});

test("enum不正: 1回目のresultが不正な値でも2回目の修正依頼で完了する", async () => {
  const h = await makeHarness({}, { firstTurnBehavior: "invalid_enum", secondTurnBehavior: "success" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "completed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.status, "completed");
    assert.equal(job.analysis?.result, "資料送付");
  } finally {
    await h.cleanup();
  }
});

test("解析タイムアウト: turnが完了しない場合はtimeoutになる", async () => {
  const h = await makeHarness({ turnTimeoutMs: 300 }, { firstTurnBehavior: "hang" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A) as AnalysisJobPublicView;
    assert.equal(job.errorCode, "timeout");
  } finally {
    await h.cleanup();
  }
});

test("キャンセル: 実行中(analyzing)のジョブをキャンセルするとcancelledになる", async () => {
  const h = await makeHarness({}, { firstTurnBehavior: "hang" });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => {
      const s = h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status;
      return s === "analyzing" || s === "validating";
    }, 5000);
    const cancelled = h.analysisJobs.cancelJob(created.jobId, TOKEN_A);
    assert.equal(cancelled?.status, "cancelled");
  } finally {
    await h.cleanup();
  }
});

test("キャンセル: 待機中(queued)のジョブはキューから除去されてcancelledになる", async () => {
  const h = await makeHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 2 }, { firstTurnBehavior: "hang" });
  try {
    const t1 = await h.createCompletedTranscriptionJob("テスト1。");
    const t2 = await h.createCompletedTranscriptionJob("テスト2。");
    const first = h.analysisJobs.submitAnalysis(TOKEN_A, t1, "company-1");
    assert.equal(first.ok, true);
    await waitFor(() => h.analysisJobs.stats.running === 1, 5000);

    const second = h.analysisJobs.submitAnalysis(TOKEN_A, t2, "company-1");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    await waitFor(() => h.analysisJobs.stats.queued === 1, 4000);

    const cancelled = h.analysisJobs.cancelJob(second.jobId, TOKEN_A);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(h.analysisJobs.stats.queued, 0);
  } finally {
    await h.cleanup();
  }
});

test("アクセス制御: 別トークンでのgetJob/cancelJobはnull（存在漏洩なし）", async () => {
  const h = await makeHarness();
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("秘密のテスト文章。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    assert.equal(h.analysisJobs.getJob(created.jobId, TOKEN_B), null);
    assert.equal(h.analysisJobs.cancelJob(created.jobId, TOKEN_B), null);
    assert.notEqual(h.analysisJobs.getJob(created.jobId, TOKEN_A), null);
  } finally {
    await h.cleanup();
  }
});

test("transcriptionJobId不正: 存在しない場合はtranscription_not_found", async () => {
  const h = await makeHarness();
  try {
    const result = h.analysisJobs.submitAnalysis(TOKEN_A, "00000000-0000-0000-0000-000000000000", "company-1");
    assert.deepEqual(result, { ok: false, reason: "transcription_not_found" });
  } finally {
    await h.cleanup();
  }
});

test("transcriptionJobId未完了: converting中の場合はtranscription_not_ready", async () => {
  const h = await makeHarness();
  try {
    const { createFakeTranscriptionBinaries: _unused } = await import("./transcription-test-support.ts");
    void _unused;
    // whisperをhangさせてconverting/transcribing状態のまま止める
    const controlDir = process.env.CALLFLOW_FAKE_CONTROL_DIR as string;
    const { setFfmpegMode } = await import("./transcription-test-support.ts");
    await setFfmpegMode(controlDir, "hang");
    const created = await h.transcriptionJobs.submitAudio(fakeRequest([Buffer.alloc(16, 7)]), TOKEN_A, "audio/webm", 16);
    if (!created.ok) return assert.fail();
    await waitFor(() => h.transcriptionJobs.getJob(created.jobId, TOKEN_A)?.status === "converting", 4000);

    const result = h.analysisJobs.submitAnalysis(TOKEN_A, created.jobId, "company-1");
    assert.deepEqual(result, { ok: false, reason: "transcription_not_ready" });

    h.transcriptionJobs.cancelJob(created.jobId, TOKEN_A);
  } finally {
    await h.cleanup();
  }
});

test("transcriptionJobId空文字起こし: 空文字の場合はtranscription_empty", async () => {
  const h = await makeHarness();
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob(" ");
    const result = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    assert.deepEqual(result, { ok: false, reason: "transcription_empty" });
  } finally {
    await h.cleanup();
  }
});

test("同時実行制御: 実行中1件・待機上限を超える解析リクエストはqueue_fullで拒否される", async () => {
  const h = await makeHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 1 }, { firstTurnBehavior: "hang" });
  try {
    const t1 = await h.createCompletedTranscriptionJob("テスト1。");
    const t2 = await h.createCompletedTranscriptionJob("テスト2。");
    const t3 = await h.createCompletedTranscriptionJob("テスト3。");
    const first = h.analysisJobs.submitAnalysis(TOKEN_A, t1, "company-1");
    assert.equal(first.ok, true);
    await waitFor(() => h.analysisJobs.stats.running === 1, 5000);

    const second = h.analysisJobs.submitAnalysis(TOKEN_A, t2, "company-1");
    assert.equal(second.ok, true);
    await waitFor(() => h.analysisJobs.stats.queued === 1, 4000);

    const third = h.analysisJobs.submitAnalysis(TOKEN_A, t3, "company-1");
    assert.deepEqual(third, { ok: false, reason: "queue_full" });
  } finally {
    await h.cleanup();
  }
});

test("TTL: 完了ジョブは設定時間の経過後にメモリから消える", async () => {
  const h = await makeHarness({ completedJobTtlMs: 50 });
  try {
    const transcriptionJobId = await h.createCompletedTranscriptionJob("テスト。");
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "completed", 5000);
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A) === null, 4000);
  } finally {
    await h.cleanup();
  }
});

test("shutdown: 実行中・待機中ジョブをすべてキャンセルし、Codexプロセスも停止する", async () => {
  const h = await makeHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 1 }, { firstTurnBehavior: "hang" });
  try {
    const t1 = await h.createCompletedTranscriptionJob("テスト1。");
    const t2 = await h.createCompletedTranscriptionJob("テスト2。");
    const first = h.analysisJobs.submitAnalysis(TOKEN_A, t1, "company-1");
    const second = h.analysisJobs.submitAnalysis(TOKEN_A, t2, "company-1");
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    await waitFor(() => h.analysisJobs.stats.running === 1 && h.analysisJobs.stats.queued === 1, 5000);

    await h.analysisJobs.shutdown();
    // queueは同期的に空になるが、実行中ジョブはキャンセル処理（turn/interrupt送信等）が
    // 非同期のため、runningCountが0になるまで数ティック遅れることがある。即時一致は要求しない。
    assert.equal(h.analysisJobs.stats.queued, 0);
    await waitFor(() => h.analysisJobs.stats.running === 0, 5000);
  } finally {
    await h.cleanup();
  }
});

test("レスポンス相当のAnalysisJobPublicViewに文字起こし全文・認証情報を含まない", async () => {
  const h = await makeHarness();
  try {
    const secretText = "これは秘密の文字起こし本文トークンBearer12345です。";
    const transcriptionJobId = await h.createCompletedTranscriptionJob(secretText);
    const created = h.analysisJobs.submitAnalysis(TOKEN_A, transcriptionJobId, "company-1");
    if (!created.ok) return assert.fail();
    await waitFor(() => h.analysisJobs.getJob(created.jobId, TOKEN_A)?.status === "completed", 5000);
    const job = h.analysisJobs.getJob(created.jobId, TOKEN_A);
    const raw = JSON.stringify(job);
    assert.doesNotMatch(raw, /Bearer12345/);
    assert.doesNotMatch(raw, new RegExp(secretText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(raw, /token-a/);
  } finally {
    await h.cleanup();
  }
});
