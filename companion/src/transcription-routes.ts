// POST/GET/DELETE /v1/transcriptions ハンドラ。既存の/v1/audioと同じ認証・CORS方式を再利用する。

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized } from "./auth.ts";
import { sendJson } from "./responses.ts";
import type { PairingManager } from "./pairing.ts";
import type { TranscriptionJobManager } from "./transcription-jobs.ts";
import { jobErrorMessage, type JobErrorCode } from "./transcription-jobs.ts";

const TRANSCRIPTIONS_PATH = "/v1/transcriptions";

function parseOptionalInt(value: string | string[] | undefined): number | null {
  if (typeof value !== "string") return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const JOB_ERROR_STATUS: Record<JobErrorCode, number> = {
  unsupported_media_type: 415,
  payload_too_large: 413,
  empty_audio: 400,
  audio_too_long: 400,
  conversion_failed: 500,
  conversion_timeout: 504,
  transcription_failed: 500,
  transcription_timeout: 504,
  cancelled: 200,
  internal_error: 500,
};

/**
 * pathnameが/v1/transcriptions関連であればリクエストを処理してtrueを返す。
 * 関連しない場合はfalseを返し、呼び出し側（server.ts）が他のルーティングを続行する。
 */
export async function handleTranscriptionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string | undefined,
  pairing: PairingManager,
  jobManager: TranscriptionJobManager,
  cors: Record<string, string>,
): Promise<boolean> {
  if (pathname === TRANSCRIPTIONS_PATH && method === "POST") {
    await handleCreate(req, res, pairing, jobManager, cors);
    return true;
  }

  if (pathname.startsWith(`${TRANSCRIPTIONS_PATH}/`)) {
    const jobId = pathname.slice(TRANSCRIPTIONS_PATH.length + 1);
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
  jobManager: TranscriptionJobManager,
  cors: Record<string, string>,
): Promise<void> {
  if (!isAuthorized(pairing, req.headers.authorization)) {
    sendJson(res, 401, { ok: false, error: "unauthorized", message: "認証に失敗しました。ペアリングをやり直してください。" }, cors);
    return;
  }

  const contentLengthHeader = parseOptionalInt(req.headers["content-length"]);
  const result = await jobManager.submitAudio(
    req,
    req.headers.authorization,
    req.headers["content-type"] ?? null,
    contentLengthHeader,
  );

  if (!result.ok) {
    if (result.reason === "queue_full") {
      sendJson(res, 429, { ok: false, error: "queue_full", message: "現在処理中のジョブが多いため、しばらくしてから再度お試しください。" }, cors);
      return;
    }
    const status = JOB_ERROR_STATUS[result.reason] ?? 400;
    sendJson(res, status, { ok: false, error: result.reason, message: jobErrorMessage(result.reason) }, cors);
    return;
  }

  sendJson(res, 202, { ok: true, jobId: result.jobId }, cors);
}

function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  pairing: PairingManager,
  jobManager: TranscriptionJobManager,
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
      text: job.text,
      modelUsed: job.modelUsed,
      durationMs: job.durationMs,
      error: job.errorCode,
      message: job.errorCode ? jobErrorMessage(job.errorCode) : null,
      temporaryFilesDeleted: job.temporaryFilesDeleted,
    },
    cors,
  );
}

function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  pairing: PairingManager,
  jobManager: TranscriptionJobManager,
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
