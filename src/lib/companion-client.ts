// ブラウザ側からCallFlow Companion（Mac上でローカル動作するHTTP(S)サーバー）を呼び出すクライアント。
// このファイルはブラウザAPI（fetch, localStorage, crypto.randomUUID, AbortController）のみに依存する。

export const DEFAULT_COMPANION_URL = "https://callflow-companion.localhost:4318";
const TOKEN_STORAGE_KEY = "callflow_companion_token_v1";

const DEFAULT_HEALTH_TIMEOUT_MS = 4000;
const DEFAULT_PAIR_TIMEOUT_MS = 8000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

export function getCompanionBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL;
  const trimmed = configured?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : DEFAULT_COMPANION_URL;
}

export function isInsecureHttpAllowed(): boolean {
  return process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP === "true";
}

// ---------------------------------------------------------
// Companion URLの検証。localhost系以外への音声送信を防ぐための最終防波堤。
// ---------------------------------------------------------
const ALLOWED_HTTPS_HOSTS = ["callflow-companion.localhost", "localhost"];
const ALLOWED_INSECURE_HTTP_HOSTS = ["127.0.0.1", "localhost"];
const REQUIRED_PORT = "4318";

export type CompanionUrlInvalidReason =
  | "invalid_url"
  | "credentials_not_allowed"
  | "query_or_fragment_not_allowed"
  | "port_not_allowed"
  | "host_not_allowed"
  | "insecure_http_not_allowed"
  | "protocol_not_allowed";

export type CompanionUrlValidation = { ok: true } | { ok: false; reason: CompanionUrlInvalidReason };

/**
 * Companion URLが「localhost系のCompanionだけ」を指しているかを検証する。
 * 外部ドメイン・LAN IP・任意ポート・認証情報付きURL・query/fragment付きURLを拒否し、
 * 開発フラグが無い限りhttp URLも拒否する。
 */
export function validateCompanionUrl(rawUrl: string, options: { allowInsecureHttp?: boolean } = {}): CompanionUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "credentials_not_allowed" };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: "query_or_fragment_not_allowed" };
  }
  if (url.port !== REQUIRED_PORT) {
    return { ok: false, reason: "port_not_allowed" };
  }

  if (url.protocol === "https:") {
    if (!ALLOWED_HTTPS_HOSTS.includes(url.hostname)) {
      return { ok: false, reason: "host_not_allowed" };
    }
    return { ok: true };
  }

  if (url.protocol === "http:") {
    if (!options.allowInsecureHttp) {
      return { ok: false, reason: "insecure_http_not_allowed" };
    }
    if (!ALLOWED_INSECURE_HTTP_HOSTS.includes(url.hostname)) {
      return { ok: false, reason: "host_not_allowed" };
    }
    return { ok: true };
  }

  return { ok: false, reason: "protocol_not_allowed" };
}

// ---------------------------------------------------------
// トークン保存（localStorage、SSR安全）
// ---------------------------------------------------------
export function loadStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorageが使えない環境では何もしない（致命的ではない）
  }
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 無視する
  }
}

// ---------------------------------------------------------
// エラー
// ---------------------------------------------------------
export type CompanionErrorCode =
  | "network_error"
  | "timeout"
  | "unauthorized"
  | "forbidden_origin"
  | "unsupported_media_type"
  | "payload_too_large"
  | "empty_audio"
  | "invalid_code"
  | "expired_code"
  | "code_already_used"
  | "too_many_attempts"
  | "invalid_request"
  | "not_found"
  | "server_error"
  | "invalid_companion_url"
  | "queue_full"
  | "audio_too_long"
  | "conversion_failed"
  | "conversion_timeout"
  | "transcription_failed"
  | "transcription_timeout"
  | "not_authenticated"
  | "usage_limit_exceeded"
  | "codex_unavailable"
  | "invalid_output"
  | "transcript_too_long"
  | "transcription_not_found"
  | "transcription_not_ready"
  | "transcription_empty"
  | "internal_error"
  | "unknown";

export class CompanionClientError extends Error {
  readonly code: CompanionErrorCode;
  readonly httpStatus: number | null;

  constructor(code: CompanionErrorCode, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "CompanionClientError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const SERVER_ERROR_CODE_MAP: Record<string, CompanionErrorCode> = {
  unauthorized: "unauthorized",
  forbidden_origin: "forbidden_origin",
  unsupported_media_type: "unsupported_media_type",
  payload_too_large: "payload_too_large",
  empty_audio: "empty_audio",
  invalid_code: "invalid_code",
  expired_code: "expired_code",
  code_already_used: "code_already_used",
  too_many_attempts: "too_many_attempts",
  invalid_request: "invalid_request",
  bad_request: "invalid_request",
  not_found: "not_found",
  queue_full: "queue_full",
  audio_too_long: "audio_too_long",
  conversion_failed: "conversion_failed",
  conversion_timeout: "conversion_timeout",
  transcription_failed: "transcription_failed",
  transcription_timeout: "transcription_timeout",
  not_authenticated: "not_authenticated",
  usage_limit_exceeded: "usage_limit_exceeded",
  codex_unavailable: "codex_unavailable",
  invalid_output: "invalid_output",
  transcript_too_long: "transcript_too_long",
  transcription_not_found: "transcription_not_found",
  transcription_not_ready: "transcription_not_ready",
  transcription_empty: "transcription_empty",
  // 解析ジョブ（analysis-jobs.ts）の"timeout"エラーコードも既存のtimeoutへ寄せる
  // （"cancelled"はエラーというよりjob.statusで表現される状態のため、あえてマッピングしない）。
  timeout: "timeout",
  internal_error: "internal_error",
};

export const COMPANION_ERROR_MESSAGES: Record<CompanionErrorCode, string> = {
  network_error:
    "Macの処理アプリ（CallFlow Companion）に接続できませんでした。次のいずれかの可能性があります。" +
    "①Companionが起動していない ②証明書が信頼されていない（scripts/setup-callflow-companion-tls.shを再実行してください） " +
    "③Chromeでローカルネットワークへのアクセスが許可されていない（アドレスバー左側のサイト設定から許可してください）。" +
    "npm run companion:check で状態を確認できます。",
  timeout: "Macの処理アプリへの接続がタイムアウトしました。Companionが起動しているか確認してください。",
  unauthorized: "認証が切れています。「ペアリングを解除」してから、もう一度ペアリングしてください。",
  forbidden_origin: "この画面からの接続が許可されていません。",
  unsupported_media_type: "対応していない録音形式です。",
  payload_too_large: "録音ファイルのサイズが上限を超えています。",
  empty_audio: "録音データが空です。もう一度録音してください。",
  invalid_code: "ペアリングコードが正しくありません。",
  expired_code: "ペアリングコードの有効期限が切れました。Companion画面の新しいコードを確認してください。",
  code_already_used: "このペアリングコードは既に使用されています。新しいコードを確認してください。",
  too_many_attempts: "失敗回数が上限を超えました。Companionを再起動してください。",
  invalid_request: "入力内容が正しくありません。",
  not_found: "Companionのエンドポイントが見つかりません。",
  server_error: "Companion内部でエラーが発生しました。",
  invalid_companion_url: "Companionの接続先設定が正しくありません（localhost系以外への送信は許可されていません）。",
  queue_full: "現在処理中のジョブが多いため、しばらくしてから再度お試しください。",
  audio_too_long: "音声が60分を超えているため、現在のバージョンでは文字起こしできません。",
  conversion_failed: "音声の変換に失敗しました。",
  conversion_timeout: "音声の変換がタイムアウトしました。",
  transcription_failed: "文字起こし処理に失敗しました。",
  transcription_timeout: "文字起こし処理がタイムアウトしました。",
  not_authenticated: "Codexへのログインが必要です。ターミナルで codex login を実行してください。",
  usage_limit_exceeded: "Codexの利用上限に達しています。利用可能になってから再試行してください。",
  codex_unavailable: "Codexアプリサーバーを起動できませんでした。",
  invalid_output: "Codexからの応答を解析結果として解釈できませんでした。",
  transcript_too_long: "文字起こしが長すぎるため解析できません。",
  transcription_not_found: "参照元の文字起こしジョブが見つかりません。",
  transcription_not_ready: "参照元の文字起こしがまだ完了していません。",
  transcription_empty: "参照元の文字起こしが空です。",
  internal_error: "Companion内部でエラーが発生しました。",
  unknown: "予期しないエラーが発生しました。",
};

export function companionErrorMessage(error: unknown): string {
  if (error instanceof CompanionClientError) {
    return COMPANION_ERROR_MESSAGES[error.code] ?? COMPANION_ERROR_MESSAGES.unknown;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return COMPANION_ERROR_MESSAGES.timeout;
  }
  if (error instanceof TypeError) {
    return COMPANION_ERROR_MESSAGES.network_error;
  }
  return COMPANION_ERROR_MESSAGES.unknown;
}

// ---------------------------------------------------------
// fetchヘルパー（タイムアウト対応）
// ---------------------------------------------------------
interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new CompanionClientError("network_error", COMPANION_ERROR_MESSAGES.network_error);
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function assertValidCompanionUrl(baseUrl: string): void {
  const result = validateCompanionUrl(baseUrl, { allowInsecureHttp: isInsecureHttpAllowed() });
  if (!result.ok) {
    throw new CompanionClientError("invalid_companion_url", COMPANION_ERROR_MESSAGES.invalid_companion_url);
  }
}

async function parseErrorResponse(res: Response): Promise<CompanionClientError> {
  let serverErrorCode: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    serverErrorCode = body.error;
    message = body.message;
  } catch {
    // JSON以外のレスポンス（想定外）。ステータスコードのみで判断する。
  }
  const mapped = (serverErrorCode && SERVER_ERROR_CODE_MAP[serverErrorCode]) || (res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden_origin" : res.status >= 500 ? "server_error" : "unknown");
  return new CompanionClientError(mapped, message ?? COMPANION_ERROR_MESSAGES[mapped], res.status);
}

// ---------------------------------------------------------
// Health check
// ---------------------------------------------------------
export interface CompanionHealth {
  ok: true;
  service: string;
  version: string;
  secure: boolean;
  phase: string;
}

export async function checkCompanionHealth(baseUrl: string, options: RequestOptions = {}): Promise<CompanionHealth> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(`${baseUrl}/v1/health`, { method: "GET" }, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS, options.signal);
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as CompanionHealth;
}

// ---------------------------------------------------------
// Pairing
// ---------------------------------------------------------
export async function pairWithCompanion(baseUrl: string, code: string, options: RequestOptions = {}): Promise<string> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/pair`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as { ok: true; token: string };
  return body.token;
}

// ---------------------------------------------------------
// 音声アップロード
// ---------------------------------------------------------
export interface CompanionUploadMeta {
  recordingId: string;
  companyId: string | null;
  durationMs: number;
}

export interface CompanionUploadResult {
  ok: true;
  recordingId: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  temporaryFileDeleted: boolean;
  message: string;
}

export async function uploadRecordingToCompanion(
  baseUrl: string,
  token: string,
  blob: Blob,
  meta: CompanionUploadMeta,
  options: RequestOptions = {},
): Promise<CompanionUploadResult> {
  assertValidCompanionUrl(baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": blob.type || "application/octet-stream",
    Authorization: `Bearer ${token}`,
    "X-CallFlow-Recording-Id": meta.recordingId,
    "X-CallFlow-Duration-Ms": String(Math.max(0, Math.floor(meta.durationMs))),
  };
  if (meta.companyId) {
    headers["X-CallFlow-Company-Id"] = meta.companyId;
  }

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/audio`,
    { method: "POST", headers, body: blob },
    options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as CompanionUploadResult;
}

export function generateRecordingId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------
// 文字起こしジョブ（Phase 3B）
// ---------------------------------------------------------
export type TranscriptionJobStatus = "queued" | "converting" | "transcribing" | "completed" | "failed" | "cancelled";

export interface TranscriptionJobView {
  jobId: string;
  status: TranscriptionJobStatus;
  text: string | null;
  modelUsed: string | null;
  durationMs: number | null;
  error: CompanionErrorCode | null;
  message: string | null;
  temporaryFilesDeleted: boolean;
}

const DEFAULT_CREATE_JOB_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_TIMEOUT_MS = 8_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 8_000;

/** 音声Blobを送信し、文字起こしジョブを作成する。202と同時にjobIdが返る（結果は別途ポーリングする）。 */
export async function createTranscriptionJob(
  baseUrl: string,
  token: string,
  blob: Blob,
  options: RequestOptions = {},
): Promise<string> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/transcriptions`,
    {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream", Authorization: `Bearer ${token}` },
      body: blob,
    },
    options.timeoutMs ?? DEFAULT_CREATE_JOB_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as { ok: true; jobId: string };
  return body.jobId;
}

export async function getTranscriptionJob(
  baseUrl: string,
  token: string,
  jobId: string,
  options: RequestOptions = {},
): Promise<TranscriptionJobView> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/transcriptions/${encodeURIComponent(jobId)}`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as {
    ok: true;
    jobId: string;
    status: TranscriptionJobStatus;
    text: string | null;
    modelUsed: string | null;
    durationMs: number | null;
    error: string | null;
    message: string | null;
    temporaryFilesDeleted: boolean;
  };
  return {
    jobId: body.jobId,
    status: body.status,
    text: body.text,
    modelUsed: body.modelUsed,
    durationMs: body.durationMs,
    error: body.error ? (SERVER_ERROR_CODE_MAP[body.error] ?? "unknown") : null,
    message: body.message,
    temporaryFilesDeleted: body.temporaryFilesDeleted,
  };
}

export async function cancelTranscriptionJob(
  baseUrl: string,
  token: string,
  jobId: string,
  options: RequestOptions = {},
): Promise<TranscriptionJobStatus> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/transcriptions/${encodeURIComponent(jobId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    options.timeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as { ok: true; status: TranscriptionJobStatus };
  return body.status;
}

/**
 * ジョブが完了/失敗/キャンセルになるまでポーリングする。
 * onUpdateが呼ばれるたびに最新状態を通知する（UIの進行表示に使う）。
 */
export async function pollTranscriptionJob(
  baseUrl: string,
  token: string,
  jobId: string,
  options: RequestOptions & { intervalMs?: number; onUpdate?: (job: TranscriptionJobView) => void } = {},
): Promise<TranscriptionJobView> {
  const intervalMs = options.intervalMs ?? 1000;
  for (;;) {
    if (options.signal?.aborted) {
      throw new CompanionClientError("timeout", COMPANION_ERROR_MESSAGES.timeout);
    }
    const job = await getTranscriptionJob(baseUrl, token, jobId, options);
    options.onUpdate?.(job);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------
// 営業通話解析ジョブ（Phase 4）
// ---------------------------------------------------------
export type AnalysisJobStatus =
  | "queued"
  | "checking_auth"
  | "starting_codex"
  | "analyzing"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled";

export interface CallAnalysisResult {
  result: string;
  heat: string;
  summary: string;
  contact_name: string | null;
  challenges: string[];
  next_action: string;
  next_action_at: string | null;
  confidence: number;
  needs_review: boolean;
  review_reasons: string[];
}

export interface AnalysisJobView {
  jobId: string;
  status: AnalysisJobStatus;
  analysis: CallAnalysisResult | null;
  error: CompanionErrorCode | null;
  message: string | null;
}

const DEFAULT_CREATE_ANALYSIS_TIMEOUT_MS = 8_000;
const DEFAULT_ANALYSIS_POLL_TIMEOUT_MS = 8_000;
const DEFAULT_CANCEL_ANALYSIS_TIMEOUT_MS = 8_000;

/**
 * 完了済みのtranscriptionJobIdを参照して解析ジョブを作成する。文字起こし全文は
 * 再送しない（Companion内の完了済みジョブをサーバー側が直接参照する）。
 */
export async function createAnalysisJob(
  baseUrl: string,
  token: string,
  transcriptionJobId: string,
  companyId: string,
  options: RequestOptions = {},
): Promise<string> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/analyses`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcriptionJobId, companyId }),
    },
    options.timeoutMs ?? DEFAULT_CREATE_ANALYSIS_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as { ok: true; jobId: string };
  return body.jobId;
}

export async function getAnalysisJob(
  baseUrl: string,
  token: string,
  jobId: string,
  options: RequestOptions = {},
): Promise<AnalysisJobView> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/analyses/${encodeURIComponent(jobId)}`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    options.timeoutMs ?? DEFAULT_ANALYSIS_POLL_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as {
    ok: true;
    jobId: string;
    status: AnalysisJobStatus;
    analysis: CallAnalysisResult | null;
    error: string | null;
    message: string | null;
  };
  return {
    jobId: body.jobId,
    status: body.status,
    analysis: body.analysis,
    error: body.error ? (SERVER_ERROR_CODE_MAP[body.error] ?? "unknown") : null,
    message: body.message,
  };
}

export async function cancelAnalysisJob(
  baseUrl: string,
  token: string,
  jobId: string,
  options: RequestOptions = {},
): Promise<AnalysisJobStatus> {
  assertValidCompanionUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/analyses/${encodeURIComponent(jobId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    options.timeoutMs ?? DEFAULT_CANCEL_ANALYSIS_TIMEOUT_MS,
    options.signal,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as { ok: true; status: AnalysisJobStatus };
  return body.status;
}

/** ジョブが完了/失敗/キャンセルになるまでポーリングする。 */
export async function pollAnalysisJob(
  baseUrl: string,
  token: string,
  jobId: string,
  options: RequestOptions & { intervalMs?: number; onUpdate?: (job: AnalysisJobView) => void } = {},
): Promise<AnalysisJobView> {
  const intervalMs = options.intervalMs ?? 1000;
  for (;;) {
    if (options.signal?.aborted) {
      throw new CompanionClientError("timeout", COMPANION_ERROR_MESSAGES.timeout);
    }
    const job = await getAnalysisJob(baseUrl, token, jobId, options);
    options.onUpdate?.(job);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
