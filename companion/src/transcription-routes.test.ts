// POST/GET/DELETE /v1/transcriptions のHTTPレベルテスト。
// 実際のffmpeg/whisper-cliは使わず、transcription-test-support.tsの偽実行ファイルを
// CALLFLOW_TRANSCRIPTION_FFMPEG_PATH / CALLFLOW_TRANSCRIPTION_WHISPER_CLI_PATH 経由で差し替える。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer, type StartedCompanion } from "./server.ts";
import type { CompanionConfig } from "./types.ts";
import {
  createFakeTranscriptionBinaries,
  setFfmpegMode,
  setWhisperText,
} from "./transcription-test-support.ts";

const ALLOWED_ORIGIN = "http://localhost:3002";
const DISALLOWED_ORIGIN = "https://evil.example.com";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-companion-transcription-routes-test-"));
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Harness {
  started: StartedCompanion;
  baseUrl: string;
  controlDir: string;
  cleanup: () => Promise<void>;
}

async function withHarness(overrides: Partial<CompanionConfig> = {}): Promise<Harness> {
  const tmpDir = overrides.tmpDir ?? (await makeTmpDir());
  const binDir = await makeTmpDir();
  const { ffmpegPath, whisperCliPath, controlDir } = await createFakeTranscriptionBinaries(binDir);

  process.env.CALLFLOW_TRANSCRIPTION_FFMPEG_PATH = ffmpegPath;
  process.env.CALLFLOW_TRANSCRIPTION_WHISPER_CLI_PATH = whisperCliPath;
  process.env.CALLFLOW_TRANSCRIPTION_MODEL_DIR = binDir;
  process.env.CALLFLOW_FAKE_CONTROL_DIR = controlDir;

  const tokenStorePath = overrides.tokenStorePath ?? path.join(tmpDir, "pairing-tokens.json");
  const started = await startServer({ allowInsecureHttp: true, port: 0, tmpDir, tokenStorePath, ...overrides });
  const address = started.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanup = async () => {
    await started.close();
    delete process.env.CALLFLOW_TRANSCRIPTION_FFMPEG_PATH;
    delete process.env.CALLFLOW_TRANSCRIPTION_WHISPER_CLI_PATH;
    delete process.env.CALLFLOW_TRANSCRIPTION_MODEL_DIR;
    delete process.env.CALLFLOW_FAKE_CONTROL_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  };

  return { started, baseUrl, controlDir, cleanup };
}

async function pairAndGetToken(baseUrl: string, code: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json()) as { ok: boolean; token?: string };
  assert.equal(body.ok, true);
  return body.token as string;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 30): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!(await predicate())) {
    throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
  }
}

test("POST /v1/transcriptions: Authorizationが無いと401", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 401);
  } finally {
    await h.cleanup();
  }
});

test("POST /v1/transcriptions: originが無いと403 forbidden_origin", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const res = await fetch(`${h.baseUrl}/v1/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 403);
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.error, "forbidden_origin");
  } finally {
    await h.cleanup();
  }
});

test("POST /v1/transcriptions: 未許可originのプリフライトは403でCORSヘッダーなし", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/transcriptions`, {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await h.cleanup();
  }
});

test("OPTIONS /v1/transcriptions/:jobId: DELETEメソッドのプリフライトが許可される", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/transcriptions/dummy-job-id`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "DELETE" },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  } finally {
    await h.cleanup();
  }
});

test("POST→GET: 正常系で202+jobIdを返し、pollingでcompletedになる", async () => {
  const h = await withHarness();
  try {
    await setWhisperText(h.controlDir, "HTTP経由の文字起こしテスト");
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);

    const createRes = await fetch(`${h.baseUrl}/v1/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    assert.equal(createRes.status, 202);
    const created = await readJson<{ ok: boolean; jobId: string }>(createRes);
    assert.equal(created.ok, true);

    let finalBody: Record<string, unknown> = {};
    await waitFor(async () => {
      const res = await fetch(`${h.baseUrl}/v1/transcriptions/${created.jobId}`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      });
      const body = await readJson<Record<string, unknown>>(res);
      finalBody = body;
      return body.status === "completed" || body.status === "failed";
    }, 5000);

    assert.equal(finalBody.status, "completed");
    assert.equal(finalBody.text, "HTTP経由の文字起こしテスト");
    assert.equal(finalBody.temporaryFilesDeleted, true);

    const raw = JSON.stringify(finalBody);
    assert.doesNotMatch(raw, /\/Users\//);
    assert.doesNotMatch(raw, /Bearer/);
  } finally {
    await h.cleanup();
  }
});

test("GET /v1/transcriptions/:jobId: 別の（有効な）トークンでは404（存在漏洩なし）", async () => {
  const h = await withHarness();
  try {
    const tokenA = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const createRes = await fetch(`${h.baseUrl}/v1/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenA}` },
      body: new Uint8Array([1, 2, 3]),
    });
    const created = await readJson<{ jobId: string }>(createRes);

    // 別ユーザー（別トークン）を模擬するため、ペアリングコードを再発行してtokenBを別途発行する。
    // 認証自体は通る（tokenBは有効）が、ジョブの所有者はtokenAのため404になる必要がある。
    h.started.pairing.regenerate();
    const tokenB = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    assert.notEqual(tokenA, tokenB);

    const res = await fetch(`${h.baseUrl}/v1/transcriptions/${created.jobId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await h.cleanup();
  }
});

test("GET /v1/transcriptions/:jobId: 存在しないjobIdは404", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const res = await fetch(`${h.baseUrl}/v1/transcriptions/00000000-0000-0000-0000-000000000000`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await h.cleanup();
  }
});

test("GET /v1/transcriptions/:jobId: URLエンコードされたスラッシュを含むjobIdでも404（パス解釈のバイパスにならない）", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const res = await fetch(`${h.baseUrl}/v1/transcriptions/foo%2Fbar`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await h.cleanup();
  }
});

test("DELETE /v1/transcriptions/:jobId: 実行中ジョブをキャンセルできる", async () => {
  const h = await withHarness();
  try {
    await setFfmpegMode(h.controlDir, "hang");
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const createRes = await fetch(`${h.baseUrl}/v1/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3]),
    });
    const created = await readJson<{ jobId: string }>(createRes);

    await waitFor(async () => {
      const res = await fetch(`${h.baseUrl}/v1/transcriptions/${created.jobId}`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      });
      const body = await readJson<{ status: string }>(res);
      return body.status === "converting";
    }, 2000);

    const cancelRes = await fetch(`${h.baseUrl}/v1/transcriptions/${created.jobId}`, {
      method: "DELETE",
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await readJson<{ status: string }>(cancelRes);
    assert.equal(cancelBody.status, "cancelled");
  } finally {
    await h.cleanup();
  }
});

test("DELETE /v1/transcriptions/:jobId: Authorizationが無いと401", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/transcriptions/dummy`, {
      method: "DELETE",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 401);
  } finally {
    await h.cleanup();
  }
});
