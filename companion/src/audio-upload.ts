// 音声Blobの受信。multipart/form-dataは使わず、リクエストボディをそのまま音声データとして扱う。
// ストリーミング中に実受信バイト数を数え、Content-Lengthの偽装があっても上限を超えたら即座に打ち切る。

import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import { SUPPORTED_AUDIO_MIME_TYPES, type SupportedAudioMimeType } from "./types.ts";
import { createTempFile, createWriteStream, deleteTempFile } from "./temp-files.ts";

export function normalizeMimeType(rawContentType: string | undefined | null): string | null {
  if (!rawContentType) return null;
  const normalized = rawContentType
    .trim()
    .toLowerCase()
    .split(";")
    .map((part) => part.trim())
    .join(";");
  return normalized || null;
}

export function isSupportedMimeType(rawContentType: string | undefined | null): rawContentType is string {
  const normalized = normalizeMimeType(rawContentType);
  if (!normalized) return false;
  return (SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(normalized);
}

export function extensionForMimeType(mimeType: SupportedAudioMimeType): string {
  if (mimeType.startsWith("audio/mp4")) return "mp4";
  return "webm";
}

class ByteLimitExceededError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`受信バイト数が上限（${limitBytes}バイト）を超えました`);
    this.name = "ByteLimitExceededError";
    this.limitBytes = limitBytes;
  }
}

/** ストリーミング中に実受信バイト数を数え、上限を超えたら即座にエラーで打ち切るTransform。 */
function createByteLimiter(maxBytes: number): { transform: Transform; bytesReceived: () => number } {
  let total = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new ByteLimitExceededError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
  return { transform, bytesReceived: () => total };
}

export type AudioReceiveResult =
  | {
      ok: true;
      filePath: string;
      recordingId: string;
      sizeBytes: number;
      mimeType: SupportedAudioMimeType;
    }
  | {
      ok: false;
      reason: "unsupported_media_type" | "payload_too_large" | "empty_audio" | "internal_error";
    };

export interface ReceiveAudioOptions {
  tmpDir: string;
  maxBodyBytes: number;
  contentType: string | null;
  contentLengthHeader: number | null;
}

export async function receiveAudioUpload(
  req: IncomingMessage,
  options: ReceiveAudioOptions,
): Promise<AudioReceiveResult> {
  if (!isSupportedMimeType(options.contentType)) {
    return { ok: false, reason: "unsupported_media_type" };
  }
  const mimeType = normalizeMimeType(options.contentType) as SupportedAudioMimeType;

  if (options.contentLengthHeader !== null && options.contentLengthHeader > options.maxBodyBytes) {
    return { ok: false, reason: "payload_too_large" };
  }

  const extension = extensionForMimeType(mimeType);
  const { filePath, recordingId } = await createTempFile(options.tmpDir, extension);

  const { transform, bytesReceived } = createByteLimiter(options.maxBodyBytes);
  const writeStream = createWriteStream(filePath);

  try {
    await pipeline(req, transform, writeStream);
  } catch (error) {
    await deleteTempFile(options.tmpDir, filePath);
    if (error instanceof ByteLimitExceededError) {
      return { ok: false, reason: "payload_too_large" };
    }
    return { ok: false, reason: "internal_error" };
  }

  const sizeBytes = bytesReceived();
  if (sizeBytes === 0) {
    await deleteTempFile(options.tmpDir, filePath);
    return { ok: false, reason: "empty_audio" };
  }

  return { ok: true, filePath, recordingId, sizeBytes, mimeType };
}
