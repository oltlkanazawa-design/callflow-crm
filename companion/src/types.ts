// CallFlow Companion (Phase 2A) の共有型定義。
// Node標準機能のみで完結させるため、外部ライブラリの型には依存しない。

export interface CompanionConfig {
  host: "127.0.0.1";
  port: number;
  secure: boolean;
  allowInsecureHttp: boolean;
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  tmpDir: string;
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  pairingCodeTtlMs: number;
  pairingMaxAttempts: number;
  tokenLockoutOnLimit: boolean;
  /** 永続化されたペアリングトークンハッシュの保存先（リポジトリ外）。生トークンは保存しない。 */
  tokenStorePath: string;
}

export const SUPPORTED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

export type SupportedAudioMimeType = (typeof SUPPORTED_AUDIO_MIME_TYPES)[number];

export interface HealthResponseBody {
  ok: true;
  service: "callflow-companion";
  version: string;
  secure: boolean;
  phase: "audio-receive-only";
}

export interface PairRequestBody {
  code: string;
}

export interface PairSuccessResponseBody {
  ok: true;
  token: string;
  tokenType: "Bearer";
  /** falseの場合、今回のセッションでは認証済みだが、Mac側への永続化に失敗している
   * （＝Companion再起動後に再ペアリングが必要になる可能性がある）。 */
  persisted: boolean;
}

export type PairFailureReason =
  | "invalid_request"
  | "invalid_code"
  | "expired_code"
  | "code_already_used"
  | "too_many_attempts"
  | "no_active_code";

export interface PairFailureResponseBody {
  ok: false;
  error: PairFailureReason;
  message: string;
}

/** GET /v1/pair/status: 保存済みトークンが今も有効かどうかを確認する（自動接続用）。 */
export interface PairStatusResponseBody {
  ok: true;
  paired: true;
}

/**
 * POST /v1/pair/revoke, POST /v1/pair/revoke-all の成功レスポンス。
 * persistedがfalseの場合、失効自体はメモリ上で完了しているが永続化ファイルへの書き込みに
 * 失敗している（＝Companionを再起動すると失効させたはずのトークンが復元されてしまう恐れが
 * ある）ことを示す。呼び出し側はこの場合、ユーザーへ警告を出すことが望ましい。
 */
export interface PairRevokeResponseBody {
  ok: true;
  revokedCount: number;
  persisted: boolean;
}

export type PairAuthFailureReason = "unauthorized" | "forbidden_origin";

export interface PairAuthFailureResponseBody {
  ok: false;
  error: PairAuthFailureReason;
  message: string;
}

export interface AudioUploadMeta {
  recordingId: string;
  companyId: string | null;
  durationMs: number | null;
  contentType: string | null;
  contentLengthHeader: number | null;
}

export interface AudioUploadSuccessResponseBody {
  ok: true;
  recordingId: string;
  mimeType: SupportedAudioMimeType;
  sizeBytes: number;
  durationMs: number;
  temporaryFileDeleted: boolean;
  message: string;
}

export type AudioUploadFailureReason =
  | "unauthorized"
  | "forbidden_origin"
  | "unsupported_media_type"
  | "payload_too_large"
  | "empty_audio"
  | "bad_request"
  | "internal_error";

export interface AudioUploadFailureResponseBody {
  ok: false;
  error: AudioUploadFailureReason;
  message: string;
}

export interface PairingSession {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  failedAttempts: number;
  locked: boolean;
}

export interface IssuedToken {
  tokenHash: string;
  issuedAt: number;
}
