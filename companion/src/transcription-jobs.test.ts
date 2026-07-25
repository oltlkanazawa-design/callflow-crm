// TranscriptionJobManagerの単体テスト。
// 実際のffmpeg/whisper-cliは一切使用せず、transcription-test-support.tsの偽実行ファイル（bash）を使う。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { TranscriptionJobManager, type JobPublicView } from "./transcription-jobs.ts";
import { loadTranscriptionConfig, type TranscriptionConfig } from "./transcription-config.ts";
import type { CompanionConfig } from "./types.ts";
import {
  createFakeTranscriptionBinaries,
  setFfmpegMode,
  setFfmpegOutputBytes,
  setWhisperMode,
  setWhisperText,
  setWhisperModelType,
} from "./transcription-test-support.ts";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-companion-jobs-test-"));
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

function audioBytes(n = 16): Buffer {
  return Buffer.alloc(n, 7);
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

interface Harness {
  manager: TranscriptionJobManager;
  tmpDir: string;
  baseDir: string;
  controlDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(configOverrides: Partial<TranscriptionConfig> = {}): Promise<Harness> {
  const tmpDir = await makeTmpDir();
  const baseDir = await makeTmpDir();
  const { ffmpegPath, whisperCliPath, controlDir } = await createFakeTranscriptionBinaries(baseDir);
  process.env.CALLFLOW_FAKE_CONTROL_DIR = controlDir;

  const transcriptionConfig = loadTranscriptionConfig({
    ffmpegPath,
    whisperCliPath,
    modelDir: baseDir,
    ffmpegTimeoutMs: 5000,
    whisperMinTimeoutMs: 5000,
    whisperMaxTimeoutMs: 5000,
    maxUploadBytes: 100 * 1024 * 1024,
    ...configOverrides,
  });
  const manager = new TranscriptionJobManager(fakeCompanionConfig(tmpDir), transcriptionConfig);

  const cleanup = async () => {
    await manager.shutdown();
    delete process.env.CALLFLOW_FAKE_CONTROL_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(baseDir, { recursive: true, force: true });
  };

  return { manager, tmpDir, baseDir, controlDir, cleanup };
}

const TOKEN_A = "Bearer token-a-1234567890";
const TOKEN_B = "Bearer token-b-0987654321";

test("submitAudio→完了: 正常系で文字起こし結果を取得し、一時ファイルを残さない", async () => {
  const h = await makeHarness();
  try {
    await setFfmpegOutputBytes(h.controlDir, 44 + 32 * 500); // 500ms相当
    await setWhisperText(h.controlDir, "これはテストの文字起こし結果です。");
    await setWhisperModelType(h.controlDir, "small");

    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => {
      const job = h.manager.getJob(created.jobId, TOKEN_A);
      return job !== null && (job.status === "completed" || job.status === "failed");
    }, 5000);

    const job = h.manager.getJob(created.jobId, TOKEN_A) as JobPublicView;
    assert.equal(job.status, "completed");
    assert.equal(job.text, "これはテストの文字起こし結果です。");
    assert.equal(job.modelUsed, "small");
    assert.equal(job.temporaryFilesDeleted, true);
    assert.equal(job.durationMs, 500);

    const entries = await fs.readdir(h.tmpDir);
    assert.equal(entries.length, 0, "完了後は一時ファイル（音声・wav・json）が残っていてはいけない");
  } finally {
    await h.cleanup();
  }
});

test("submitAudio: 不正なMIME Typeはジョブを作成しない", async () => {
  const h = await makeHarness();
  try {
    const result = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "application/octet-stream", 16);
    assert.deepEqual(result, { ok: false, reason: "unsupported_media_type" });
    assert.equal(h.manager.stats.total, 0);
  } finally {
    await h.cleanup();
  }
});

test("submitAudio: 空の音声は拒否される", async () => {
  const h = await makeHarness();
  try {
    const result = await h.manager.submitAudio(fakeRequest([]), TOKEN_A, "audio/webm", 0);
    assert.deepEqual(result, { ok: false, reason: "empty_audio" });
    assert.equal(h.manager.stats.total, 0);
  } finally {
    await h.cleanup();
  }
});

test("submitAudio: サイズ上限を超える音声は拒否される", async () => {
  const h = await makeHarness({ maxUploadBytes: 10 });
  try {
    const result = await h.manager.submitAudio(fakeRequest([audioBytes(1000)]), TOKEN_A, "audio/webm", 1000);
    assert.deepEqual(result, { ok: false, reason: "payload_too_large" });
    assert.equal(h.manager.stats.total, 0);
  } finally {
    await h.cleanup();
  }
});

test("同時実行制御: 実行中1件・待機1件を超える3件目はqueue_fullで拒否される", async () => {
  const h = await makeHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 1 });
  try {
    await setFfmpegMode(h.controlDir, "hang");

    const first = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(first.ok, true);
    await waitFor(() => h.manager.stats.running === 1, 2000);

    const second = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(second.ok, true);
    await waitFor(() => h.manager.stats.queued === 1, 2000);

    const third = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.deepEqual(third, { ok: false, reason: "queue_full" });
  } finally {
    await h.cleanup();
  }
});

test("ffmpeg失敗: conversion_failedとなり一時ファイルを残さない", async () => {
  const h = await makeHarness();
  try {
    await setFfmpegMode(h.controlDir, "fail");
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.manager.getJob(created.jobId, TOKEN_A) as JobPublicView;
    assert.equal(job.errorCode, "conversion_failed");
    assert.equal(job.temporaryFilesDeleted, true);
    assert.equal((await fs.readdir(h.tmpDir)).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("ffmpegタイムアウト: conversion_timeoutとなり、プロセスは残らない", async () => {
  const h = await makeHarness({ ffmpegTimeoutMs: 200 });
  try {
    await setFfmpegMode(h.controlDir, "hang");
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.manager.getJob(created.jobId, TOKEN_A) as JobPublicView;
    assert.equal(job.errorCode, "conversion_timeout");
    assert.equal((await fs.readdir(h.tmpDir)).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("whisper失敗: transcription_failedとなる", async () => {
  const h = await makeHarness();
  try {
    await setWhisperMode(h.controlDir, "fail");
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.manager.getJob(created.jobId, TOKEN_A) as JobPublicView;
    assert.equal(job.errorCode, "transcription_failed");
    assert.equal((await fs.readdir(h.tmpDir)).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("whisperタイムアウト: transcription_timeoutとなる", async () => {
  const h = await makeHarness({ whisperMinTimeoutMs: 200, whisperMaxTimeoutMs: 200 });
  try {
    await setWhisperMode(h.controlDir, "hang");
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "failed", 5000);
    const job = h.manager.getJob(created.jobId, TOKEN_A) as JobPublicView;
    assert.equal(job.errorCode, "transcription_timeout");
    assert.equal((await fs.readdir(h.tmpDir)).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("キャンセル: 実行中(converting)のジョブをキャンセルするとcancelledになり一時ファイルを削除する", async () => {
  const h = await makeHarness();
  try {
    await setFfmpegMode(h.controlDir, "hang");
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "converting", 2000);
    const cancelled = h.manager.cancelJob(created.jobId, TOKEN_A);
    assert.equal(cancelled?.status, "cancelled");

    await waitFor(async () => (await fs.readdir(h.tmpDir)).length === 0, 5000);
  } finally {
    await h.cleanup();
  }
});

test("キャンセル: 待機中(queued)のジョブはキューから除去されてcancelledになる", async () => {
  const h = await makeHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 2 });
  try {
    await setFfmpegMode(h.controlDir, "hang");
    const first = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(first.ok, true);
    await waitFor(() => h.manager.stats.running === 1, 2000);

    const second = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    await waitFor(() => h.manager.stats.queued === 1, 2000);

    const cancelled = h.manager.cancelJob(second.jobId, TOKEN_A);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(h.manager.stats.queued, 0, "キャンセルされた待機ジョブはキューから除去されている必要がある");
  } finally {
    await h.cleanup();
  }
});

test("アクセス制御: 別トークンでのgetJob/cancelJobはnull（存在漏洩なし）", async () => {
  const h = await makeHarness();
  try {
    await setWhisperText(h.controlDir, "秘密のテキスト");
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.equal(h.manager.getJob(created.jobId, TOKEN_B), null);
    assert.equal(h.manager.cancelJob(created.jobId, TOKEN_B), null);
    assert.notEqual(h.manager.getJob(created.jobId, TOKEN_A), null, "正しいトークンでは取得できる必要がある");
  } finally {
    await h.cleanup();
  }
});

test("getJob: 存在しないjobIdはnullを返す", async () => {
  const h = await makeHarness();
  try {
    assert.equal(h.manager.getJob("00000000-0000-0000-0000-000000000000", TOKEN_A), null);
  } finally {
    await h.cleanup();
  }
});

test("shutdown: 実行中・待機中ジョブをすべてキャンセルし一時ファイルを削除する", async () => {
  const h = await makeHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 2 });
  try {
    await setFfmpegMode(h.controlDir, "hang");
    const first = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    const second = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    await waitFor(() => h.manager.stats.running === 1 && h.manager.stats.queued === 1, 2000);

    await h.manager.shutdown();

    await waitFor(async () => (await fs.readdir(h.tmpDir)).length === 0, 5000);
  } finally {
    // shutdownは既に呼んだが、cleanup内でも再度呼ばれる（冪等であることも同時に確認する）。
    await h.cleanup();
  }
});

test("TTL: 完了ジョブは設定時間の経過後にメモリから消える", async () => {
  const h = await makeHarness({ completedJobTtlMs: 50 });
  try {
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "completed", 5000);
    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A) === null, 2000);
  } finally {
    await h.cleanup();
  }
});

test("レスポンス相当のJobPublicViewに絶対パス・トークンを含まない", async () => {
  const h = await makeHarness();
  try {
    const created = await h.manager.submitAudio(fakeRequest([audioBytes()]), TOKEN_A, "audio/webm", 16);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await waitFor(() => h.manager.getJob(created.jobId, TOKEN_A)?.status === "completed", 5000);
    const job = h.manager.getJob(created.jobId, TOKEN_A);
    const raw = JSON.stringify(job);
    assert.doesNotMatch(raw, /\/Users\//);
    assert.doesNotMatch(raw, /token-a/);
    assert.doesNotMatch(raw, new RegExp(h.tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await h.cleanup();
  }
});
