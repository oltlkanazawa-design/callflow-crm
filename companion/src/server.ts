// CallFlow Companion (Phase 2A) 本体。
// Node標準機能（node:http/https/crypto/fs/path/os/stream/url）のみで実装する。
// 役割は「音声を受信し、検証し、一時保存し、削除する」ことに限定される。
// 文字起こし・Codex解析・Supabase保存はこのファイルには一切含まれない。

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, canStartServer } from "./config.ts";
import { ensureTmpDir, cleanupAllTempFiles, deleteTempFile } from "./temp-files.ts";
import { PairingManager } from "./pairing.ts";
import { isAuthorized } from "./auth.ts";
import { corsHeadersFor, preflightHeadersFor, isOriginAllowed } from "./cors.ts";
import { receiveAudioUpload } from "./audio-upload.ts";
import { sendJson, sendNoContent } from "./responses.ts";
import { TranscriptionJobManager } from "./transcription-jobs.ts";
import { handleTranscriptionRequest } from "./transcription-routes.ts";
import type {
  AudioUploadFailureReason,
  CompanionConfig,
  HealthResponseBody,
  PairFailureReason,
  PairRequestBody,
} from "./types.ts";

export const COMPANION_VERSION = "0.1.0";
const PAIR_BODY_MAX_BYTES = 4096;

function readSmallJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // ソケットは破棄しない（応答を返せなくなるため）。以降のchunkは単に保持しない。
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

const PAIR_FAILURE_MESSAGES: Record<PairFailureReason, string> = {
  invalid_request: "ペアリングコードの形式が正しくありません（6桁の数字を入力してください）。",
  invalid_code: "ペアリングコードが正しくありません。",
  expired_code: "ペアリングコードの有効期限が切れました。Companionを再起動してください。",
  code_already_used: "このペアリングコードは既に使用されています。",
  too_many_attempts: "失敗回数が上限を超えました。Companionを再起動してください。",
  no_active_code: "有効なペアリングコードがありません。",
};

const AUDIO_FAILURE_STATUS: Record<AudioUploadFailureReason, number> = {
  unauthorized: 401,
  forbidden_origin: 403,
  unsupported_media_type: 415,
  payload_too_large: 413,
  empty_audio: 400,
  bad_request: 400,
  internal_error: 500,
};

const AUDIO_FAILURE_MESSAGES: Record<AudioUploadFailureReason, string> = {
  unauthorized: "認証に失敗しました。ペアリングをやり直してください。",
  forbidden_origin: "許可されていない送信元からのリクエストです。",
  unsupported_media_type: "対応していない音声形式です。",
  payload_too_large: "音声ファイルのサイズが上限（100MB）を超えています。",
  empty_audio: "音声データが空です。",
  bad_request: "リクエストの内容が正しくありません。",
  internal_error: "Companion内部でエラーが発生しました。",
};

function parseOptionalInt(value: string | string[] | undefined): number | null {
  if (typeof value !== "string") return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function safeRecordingIdFromHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function createRequestListener(config: CompanionConfig, pairing: PairingManager, jobManager: TranscriptionJobManager) {
  return async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      const requestPrivateNetwork = req.headers["access-control-request-private-network"] === "true";
      const headers = preflightHeadersFor(origin, config.allowedOrigins, requestPrivateNetwork);
      if (!headers) {
        sendNoContent(res, 403);
        return;
      }
      sendNoContent(res, 204, headers);
      return;
    }

    const cors = corsHeadersFor(origin, config.allowedOrigins) ?? {};

    if (pathname === "/v1/health" && req.method === "GET") {
      const body: HealthResponseBody = {
        ok: true,
        service: "callflow-companion",
        version: COMPANION_VERSION,
        secure: config.secure,
        phase: "audio-receive-only",
      };
      sendJson(res, 200, body, cors);
      return;
    }

    if (pathname === "/v1/pair" && req.method === "POST") {
      let parsed: unknown;
      try {
        parsed = await readSmallJsonBody(req, PAIR_BODY_MAX_BYTES);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid_request", message: PAIR_FAILURE_MESSAGES.invalid_request }, cors);
        return;
      }
      const code = typeof (parsed as PairRequestBody | undefined)?.code === "string" ? (parsed as PairRequestBody).code : "";
      const result = pairing.attemptPair(code);
      if (result.ok) {
        sendJson(res, 200, { ok: true, token: result.token, tokenType: "Bearer" }, cors);
        return;
      }
      const status = result.reason === "too_many_attempts" ? 429 : 401;
      sendJson(res, status, { ok: false, error: result.reason, message: PAIR_FAILURE_MESSAGES[result.reason] }, cors);
      return;
    }

    if (pathname === "/v1/audio" && req.method === "POST") {
      // 音声アップロードはOriginなし・未許可Originを明示的に拒否する。
      // レスポンスを送り終えるまでソケットは破棄しない（req.destroy()は応答も道連れにするため使わない）。
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        sendJson(
          res,
          AUDIO_FAILURE_STATUS.forbidden_origin,
          { ok: false, error: "forbidden_origin", message: AUDIO_FAILURE_MESSAGES.forbidden_origin },
          {},
        );
        return;
      }
      if (!isAuthorized(pairing, req.headers.authorization)) {
        sendJson(
          res,
          AUDIO_FAILURE_STATUS.unauthorized,
          { ok: false, error: "unauthorized", message: AUDIO_FAILURE_MESSAGES.unauthorized },
          cors,
        );
        return;
      }

      const contentLengthHeader = parseOptionalInt(req.headers["content-length"]);
      const result = await receiveAudioUpload(req, {
        tmpDir: config.tmpDir,
        maxBodyBytes: config.maxBodyBytes,
        contentType: req.headers["content-type"] ?? null,
        contentLengthHeader,
      });

      if (!result.ok) {
        sendJson(
          res,
          AUDIO_FAILURE_STATUS[result.reason],
          { ok: false, error: result.reason, message: AUDIO_FAILURE_MESSAGES[result.reason] },
          cors,
        );
        return;
      }

      const deleted = await deleteTempFile(config.tmpDir, result.filePath);
      const durationMs = parseOptionalInt(req.headers["x-callflow-duration-ms"]) ?? 0;
      const clientRecordingId = safeRecordingIdFromHeader(req.headers["x-callflow-recording-id"]);

      sendJson(
        res,
        200,
        {
          ok: true,
          recordingId: clientRecordingId ?? result.recordingId,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          durationMs,
          temporaryFileDeleted: deleted,
          message: deleted ? "音声をMacで受信し、安全に削除しました" : "一時音声を削除できませんでした",
        },
        cors,
      );
      return;
    }

    if (pathname === "/v1/transcriptions" || pathname.startsWith("/v1/transcriptions/")) {
      // /v1/audioと同様に、トークン検証より前にOriginなし・未許可Originを明示的に拒否する
      // （POSTだけでなくGET/DELETEも含める。Bearerトークンによる認証がありプリフライトでも
      //  実質的に守られてはいるが、多層防御としてエンドポイント全体で一貫させる）。
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        sendJson(
          res,
          AUDIO_FAILURE_STATUS.forbidden_origin,
          { ok: false, error: "forbidden_origin", message: AUDIO_FAILURE_MESSAGES.forbidden_origin },
          {},
        );
        return;
      }
    }

    const handledTranscription = await handleTranscriptionRequest(req, res, pathname, req.method, pairing, jobManager, cors);
    if (handledTranscription) return;

    sendJson(res, 404, { ok: false, error: "not_found", message: "エンドポイントが見つかりません。" }, cors);
  };
}

export interface StartedCompanion {
  server: http.Server | https.Server;
  config: CompanionConfig;
  pairing: PairingManager;
  jobManager: TranscriptionJobManager;
  close: () => Promise<void>;
}

export async function startServer(overrides: Partial<CompanionConfig> = {}): Promise<StartedCompanion> {
  const config = loadConfig(overrides);
  const startCheck = canStartServer(config);
  if (!startCheck.ok) {
    throw new Error(startCheck.reason);
  }

  await ensureTmpDir(config.tmpDir);
  await cleanupAllTempFiles(config.tmpDir);

  const pairing = new PairingManager(config);
  const jobManager = new TranscriptionJobManager(config);
  const listener = createRequestListener(config, pairing, jobManager);

  let server: http.Server | https.Server;
  if (config.secure) {
    try {
      server = https.createServer(
        {
          cert: fs.readFileSync(config.tlsCertPath as string),
          key: fs.readFileSync(config.tlsKeyPath as string),
          minVersion: "TLSv1.2",
        },
        listener,
      );
    } catch {
      // 証明書・秘密鍵が不正な組み合わせの場合。HTTPへは絶対にフォールバックしない。
      throw new Error(
        "TLS証明書・秘密鍵の読み込みに失敗しました（不正な組み合わせの可能性があります）。scripts/setup-callflow-companion-tls.sh を再実行してください。",
      );
    }
  } else {
    server = http.createServer(listener);
  }

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });

  const close = async (): Promise<void> => {
    await jobManager.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await cleanupAllTempFiles(config.tmpDir);
  };

  return { server, config, pairing, jobManager, close };
}

function formatLocalTime(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP");
}

async function main(): Promise<void> {
  let started: StartedCompanion;
  try {
    started = await startServer();
  } catch (error) {
    console.error(`[callflow-companion] 起動できませんでした: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const { config, pairing } = started;
  console.log("[callflow-companion] 起動しました");
  console.log(`[callflow-companion] モード: ${config.secure ? "HTTPS" : "HTTP（開発用・安全でない接続）"}`);
  console.log(`[callflow-companion] アドレス: ${config.secure ? "https" : "http"}://${config.host}:${config.port}`);
  console.log(`[callflow-companion] 許可オリジン: ${config.allowedOrigins.join(", ")}`);
  console.log(`[callflow-companion] ペアリングコード: ${pairing.currentCode}（有効期限: ${formatLocalTime(pairing.currentExpiresAt)}）`);
  if (!config.secure) {
    console.log("[callflow-companion] 警告: これは開発用の安全でない接続です。本番originからは接続できません。");
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[callflow-companion] ${signal}を受信しました。終了処理を行います。`);
    await started.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
