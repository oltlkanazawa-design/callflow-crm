// POST/GET/DELETE /v1/analyses のHTTPレベルテスト。
// 実際のCodex CLI・ChatGPTアカウント・実ffmpeg/whisper-cliは一切使用しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer, type StartedCompanion } from "./server.ts";
import type { CompanionConfig } from "./types.ts";
import { createFakeTranscriptionBinaries, setWhisperText } from "./transcription-test-support.ts";
import { createFakeCodexBinary, type FakeCodexConfig } from "./analysis-test-support.ts";

const ALLOWED_ORIGIN = "http://localhost:3002";
const DISALLOWED_ORIGIN = "https://evil.example.com";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-companion-analysis-routes-test-"));
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Harness {
  started: StartedCompanion;
  baseUrl: string;
  cleanup: () => Promise<void>;
  createCompletedTranscription: (token: string, text: string) => Promise<string>;
}

async function withHarness(codexOverrides: Partial<FakeCodexConfig> = {}, overrides: Partial<CompanionConfig> = {}): Promise<Harness> {
  const tmpDir = overrides.tmpDir ?? (await makeTmpDir());
  const transcriptionBinDir = await makeTmpDir();
  // codexWorkDirはCompanion起動時にensureTmpDir/cleanupAllTempFilesで必ず空にされる
  // （本番の安全策どおり）。偽app-serverのスクリプト・設定ファイルはそこに置くと消されて
  // しまうため、別ディレクトリ（codexBinDir）に置く。
  const codexBinDir = await makeTmpDir();
  const codexWorkDir = await makeTmpDir();

  const { ffmpegPath, whisperCliPath, controlDir } = await createFakeTranscriptionBinaries(transcriptionBinDir);
  const { codexArgs } = await createFakeCodexBinary(codexBinDir, codexOverrides);

  process.env.CALLFLOW_TRANSCRIPTION_FFMPEG_PATH = ffmpegPath;
  process.env.CALLFLOW_TRANSCRIPTION_WHISPER_CLI_PATH = whisperCliPath;
  process.env.CALLFLOW_TRANSCRIPTION_MODEL_DIR = transcriptionBinDir;
  process.env.CALLFLOW_FAKE_CONTROL_DIR = controlDir;
  process.env.CALLFLOW_CODEX_BINARY_PATH = process.execPath;
  process.env.CALLFLOW_CODEX_ARGS_JSON = JSON.stringify(codexArgs);
  process.env.CALLFLOW_CODEX_WORK_DIR = codexWorkDir;
  process.env.CALLFLOW_ANALYSIS_TURN_TIMEOUT_MS = "2000";

  const started = await startServer({ allowInsecureHttp: true, port: 0, tmpDir, ...overrides });
  const address = started.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const createCompletedTranscription = async (token: string, text: string): Promise<string> => {
    await setWhisperText(controlDir, text);
    const res = await fetch(`${baseUrl}/v1/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    const created = (await res.json()) as { jobId: string };
    const deadline = Date.now() + 5000;
    for (;;) {
      const pollRes = await fetch(`${baseUrl}/v1/transcriptions/${created.jobId}`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      });
      const body = (await pollRes.json()) as { status: string };
      if (body.status === "completed") return created.jobId;
      if (Date.now() > deadline) throw new Error("timed out waiting for transcription to complete");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };

  const cleanup = async () => {
    await started.close();
    delete process.env.CALLFLOW_TRANSCRIPTION_FFMPEG_PATH;
    delete process.env.CALLFLOW_TRANSCRIPTION_WHISPER_CLI_PATH;
    delete process.env.CALLFLOW_TRANSCRIPTION_MODEL_DIR;
    delete process.env.CALLFLOW_FAKE_CONTROL_DIR;
    delete process.env.CALLFLOW_CODEX_BINARY_PATH;
    delete process.env.CALLFLOW_CODEX_ARGS_JSON;
    delete process.env.CALLFLOW_CODEX_WORK_DIR;
    delete process.env.CALLFLOW_ANALYSIS_TURN_TIMEOUT_MS;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(transcriptionBinDir, { recursive: true, force: true });
    await fs.rm(codexBinDir, { recursive: true, force: true });
    await fs.rm(codexWorkDir, { recursive: true, force: true });
  };

  return { started, baseUrl, cleanup, createCompletedTranscription };
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

test("POST /v1/analyses: Authorizationが無いと401", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ transcriptionJobId: "x", companyId: "company-1" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await h.cleanup();
  }
});

test("POST /v1/analyses: originが無いと403 forbidden_origin", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const res = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcriptionJobId: "x", companyId: "company-1" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await h.cleanup();
  }
});

test("POST /v1/analyses: 未許可originのプリフライトは403でCORSヘッダーなし", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await h.cleanup();
  }
});

test("OPTIONS /v1/analyses/:jobId: DELETEメソッドのプリフライトが許可される", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/analyses/dummy-job-id`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "DELETE" },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  } finally {
    await h.cleanup();
  }
});

test("POST→GET: 完了済みtranscriptionJobを参照して解析し、202→completedになる", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const transcriptionJobId = await h.createCompletedTranscription(token, "HTTP経由の解析テスト文章です。");

    const createRes = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcriptionJobId, companyId: "company-1" }),
    });
    assert.equal(createRes.status, 202);
    const created = await readJson<{ ok: boolean; jobId: string }>(createRes);
    assert.equal(created.ok, true);

    let finalBody: Record<string, unknown> = {};
    await waitFor(async () => {
      const res = await fetch(`${h.baseUrl}/v1/analyses/${created.jobId}`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      });
      const body = await readJson<Record<string, unknown>>(res);
      finalBody = body;
      return body.status === "completed" || body.status === "failed";
    }, 8000);

    assert.equal(finalBody.status, "completed");
    assert.ok(finalBody.analysis);

    const raw = JSON.stringify(finalBody);
    assert.doesNotMatch(raw, /\/Users\//);
    assert.doesNotMatch(raw, /Bearer/);
  } finally {
    await h.cleanup();
  }
});

test("POST /v1/analyses: 存在しないtranscriptionJobIdは404 transcription_not_found", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const res = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcriptionJobId: "00000000-0000-0000-0000-000000000000", companyId: "company-1" }),
    });
    assert.equal(res.status, 404);
    const body = await readJson<{ error: string }>(res);
    assert.equal(body.error, "transcription_not_found");
  } finally {
    await h.cleanup();
  }
});

test("GET /v1/analyses/:jobId: 別の（有効な）トークンでは404（存在漏洩なし）", async () => {
  const h = await withHarness();
  try {
    const tokenA = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const transcriptionJobId = await h.createCompletedTranscription(tokenA, "テスト。");
    const createRes = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ transcriptionJobId, companyId: "company-1" }),
    });
    const created = await readJson<{ jobId: string }>(createRes);

    h.started.pairing.regenerate();
    const tokenB = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);

    const res = await fetch(`${h.baseUrl}/v1/analyses/${created.jobId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await h.cleanup();
  }
});

test("DELETE /v1/analyses/:jobId: 実行中ジョブをキャンセルできる", async () => {
  const h = await withHarness({ firstTurnBehavior: "hang" });
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const transcriptionJobId = await h.createCompletedTranscription(token, "テスト。");
    const createRes = await fetch(`${h.baseUrl}/v1/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcriptionJobId, companyId: "company-1" }),
    });
    const created = await readJson<{ jobId: string }>(createRes);

    await waitFor(async () => {
      const res = await fetch(`${h.baseUrl}/v1/analyses/${created.jobId}`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      });
      const body = await readJson<{ status: string }>(res);
      return body.status === "analyzing" || body.status === "validating" || body.status === "starting_codex";
    }, 5000);

    const cancelRes = await fetch(`${h.baseUrl}/v1/analyses/${created.jobId}`, {
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

test("DELETE /v1/analyses/:jobId: Authorizationが無いと401", async () => {
  const h = await withHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/analyses/dummy`, {
      method: "DELETE",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 401);
  } finally {
    await h.cleanup();
  }
});

test("GET /v1/analyses/:jobId: 存在しないjobIdは404", async () => {
  const h = await withHarness();
  try {
    const token = await pairAndGetToken(h.baseUrl, h.started.pairing.currentCode);
    const res = await fetch(`${h.baseUrl}/v1/analyses/00000000-0000-0000-0000-000000000000`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await h.cleanup();
  }
});
