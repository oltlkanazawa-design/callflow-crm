// POST/GET/DELETE /v1/analyses ハンドラ。既存の/v1/transcriptionsと同じ認証・CORS方式を再利用する。

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized } from "./auth.ts";
import { sendJson } from "./responses.ts";
import { readSmallJsonBody } from "./server.ts";
import type { PairingManager } from "./pairing.ts";
import type { AnalysisJobManager } from "./analysis-jobs.ts";
import { analysisJobErrorMessage, type AnalysisJobErrorCode } from "./analysis-jobs.ts";

const ANALYSES_PATH = "/v1/analyses";
const ANALYSIS_BODY_MAX_BYTES = 8192;

interface CreateAnalysisRequestBody {
  transcriptionJobId?: unknown;
  companyId?: unknown;
}

const CREATE_ERROR_STATUS: Record<AnalysisJobErrorCode, number> = {
  not_authenticated: 401,
  usage_limit_exceeded: 429,
  codex_unavailable: 503,
  timeout: 504,
  cancelled: 200,
  invalid_output: 502,
  transcript_too_long: 400,
  transcription_not_found: 404,
  transcription_not_ready: 409,
  transcription_empty: 400,
  internal_error: 500,
};

/**
 * pathnameが/v1/analyses関連であればリクエストを処理してtrueを返す。
 * 関連しない場合はfalseを返し、呼び出し側（server.ts）が他のルーティングを続行する。
 */
export async function handleAnalysisRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string | undefined,
  pairing: PairingManager,
  jobManager: AnalysisJobManager,
  cors: Record<string, string>,
): Promise<boolean> {
  if (pathname === ANALYSES_PATH && method === "POST") {
    await handleCreate(req, res, pairing, jobManager, cors);
    return true;
  }

  if (pathname.startsWith(`${ANALYSES_PATH}/`)) {
    const jobId = pathname.slice(ANALYSES_PATH.length + 1);
    if (!jobId || jobId.includes("/")) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: "リクエストの内容が正しくありません。" }, cors);
      return true;
    }
    if (method === "GET") {
      handleGet(req, res, jobId, pairing, jobManager, cors);
      return true;
    }
    if (method === "DELETE") {
      handleCancel(req, res, jobId, pairing, jobManager, cors);
      return true;
    }
  }

  return false;
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  pairing: PairingManager,
  jobManager: AnalysisJobManager,
  cors: Record<string, string>,
): Promise<void> {
  if (!isAuthorized(pairing, req.headers.authorization)) {
    sendJson(res, 401, { ok: false, error: "unauthorized", message: "認証に失敗しました。ペアリングをやり直してください。" }, cors);
    return;
  }

  let parsed: unknown;
  try {
    parsed = await readSmallJsonBody(req, ANALYSIS_BODY_MAX_BYTES);
  } catch {
    sendJson(res, 400, { ok: false, error: "bad_request", message: "リクエストの内容が正しくありません。" }, cors);
    return;
  }

  const body = parsed as CreateAnalysisRequestBody | undefined;
  const transcriptionJobId = typeof body?.transcriptionJobId === "string" ? body.transcriptionJobId : "";
  const companyId = typeof body?.companyId === "string" ? body.companyId : "";
  if (!transcriptionJobId || !companyId) {
    sendJson(res, 400, { ok: false, error: "bad_request", message: "リクエストの内容が正しくありません。" }, cors);
    return;
  }

  const result = jobManager.submitAnalysis(req.headers.authorization, transcriptionJobId, companyId);
  if (!result.ok) {
    if (result.reason === "queue_full") {
      sendJson(res, 429, { ok: false, error: "queue_full", message: "現在処理中の解析が多いため、しばらくしてから再度お試しください。" }, cors);
      return;
    }
    const status = CREATE_ERROR_STATUS[result.reason] ?? 400;
    sendJson(res, status, { ok: false, error: result.reason, message: analysisJobErrorMessage(result.reason) }, cors);
    return;
  }

  sendJson(res, 202, { ok: true, jobId: result.jobId }, cors);
}

function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  pairing: PairingManager,
  jobManager: AnalysisJobManager,
  cors: Record<string, string>,
): void {
  if (!isAuthorized(pairing, req.headers.authorization)) {
    sendJson(res, 401, { ok: false, error: "unauthorized", message: "認証に失敗しました。ペアリングをやり直してください。" }, cors);
    return;
  }
  const job = jobManager.getJob(jobId, req.headers.authorization);
  if (!job) {
    sendJson(res, 404, { ok: false, error: "not_found", message: "ジョブが見つかりません。" }, cors);
    return;
  }
  sendJson(
    res,
    200,
    {
      ok: true,
      jobId: job.jobId,
      status: job.status,
      analysis: job.analysis,
      error: job.errorCode,
      message: job.message,
    },
    cors,
  );
}

function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  pairing: PairingManager,
  jobManager: AnalysisJobManager,
  cors: Record<string, string>,
): void {
  if (!isAuthorized(pairing, req.headers.authorization)) {
    sendJson(res, 401, { ok: false, error: "unauthorized", message: "認証に失敗しました。ペアリングをやり直してください。" }, cors);
    return;
  }
  const job = jobManager.cancelJob(jobId, req.headers.authorization);
  if (!job) {
    sendJson(res, 404, { ok: false, error: "not_found", message: "ジョブが見つかりません。" }, cors);
    return;
  }
  sendJson(res, 200, { ok: true, jobId: job.jobId, status: job.status }, cors);
}
