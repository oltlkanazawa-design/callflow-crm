// 文字起こしジョブ（Phase 3B）専用の設定。
// 既存のCompanionConfig（types.ts/config.ts）は変更せず、独立した設定として読み込む。

import os from "node:os";
import path from "node:path";

export type WhisperModelName = "base" | "small";

export interface TranscriptionConfig {
  ffmpegPath: string;
  whisperCliPath: string;
  modelDir: string;
  defaultModel: WhisperModelName;
  /** アップロード可能な音声の最大サイズ（既存/v1/audioと同じ100MBを既定とする）。 */
  maxUploadBytes: number;
  /** MVPでの音声長上限（Phase 1の録音上限と同じ60分）。超過時は実行前に拒否する。 */
  maxAudioDurationMs: number;
  /** ffmpeg変換のタイムアウト。 */
  ffmpegTimeoutMs: number;
  /** whisper-cli実行の絶対上限（実測real-time factorから安全マージンを掛けた値を超えないようにする）。 */
  whisperMaxTimeoutMs: number;
  /** 音声長に対して許容するreal-time factorの安全係数（実測値に対するマージン）。 */
  whisperRtfSafetyMultiplier: number;
  /** whisper-cli実行に許す最低タイムアウト（短い音声でも極端に短くしない）。 */
  whisperMinTimeoutMs: number;
  /** 同時実行数（常に1、将来の拡張余地として設定値にしている）。 */
  maxConcurrentJobs: number;
  /** 待機キューの上限。 */
  maxQueuedJobs: number;
  /** 完了・失敗ジョブをメモリ上に保持する時間（TTL）。 */
  completedJobTtlMs: number;
  /** サブプロセスの標準出力・標準エラー出力バッファ上限（バイト）。 */
  maxProcessOutputBytes: number;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultModelDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "CallFlow Companion", "models");
}

export function modelPathFor(modelDir: string, model: WhisperModelName): string {
  return path.join(modelDir, `ggml-${model}.bin`);
}

export function loadTranscriptionConfig(overrides: Partial<TranscriptionConfig> = {}): TranscriptionConfig {
  const envModel = process.env.CALLFLOW_TRANSCRIPTION_MODEL;
  const defaultModel: WhisperModelName = envModel === "base" ? "base" : "small";

  return {
    ffmpegPath: overrides.ffmpegPath ?? process.env.CALLFLOW_TRANSCRIPTION_FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg",
    whisperCliPath:
      overrides.whisperCliPath ?? process.env.CALLFLOW_TRANSCRIPTION_WHISPER_CLI_PATH ?? "/opt/homebrew/bin/whisper-cli",
    modelDir: overrides.modelDir ?? process.env.CALLFLOW_TRANSCRIPTION_MODEL_DIR ?? defaultModelDir(),
    defaultModel: overrides.defaultModel ?? defaultModel,
    maxUploadBytes: overrides.maxUploadBytes ?? readIntEnv("CALLFLOW_COMPANION_MAX_BODY_BYTES", 100 * 1024 * 1024),
    maxAudioDurationMs: overrides.maxAudioDurationMs ?? 60 * 60 * 1000,
    ffmpegTimeoutMs: overrides.ffmpegTimeoutMs ?? 2 * 60 * 1000,
    whisperMaxTimeoutMs: overrides.whisperMaxTimeoutMs ?? 30 * 60 * 1000,
    whisperRtfSafetyMultiplier: overrides.whisperRtfSafetyMultiplier ?? 4,
    whisperMinTimeoutMs: overrides.whisperMinTimeoutMs ?? 2 * 60 * 1000,
    maxConcurrentJobs: overrides.maxConcurrentJobs ?? 1,
    maxQueuedJobs: overrides.maxQueuedJobs ?? 2,
    completedJobTtlMs: overrides.completedJobTtlMs ?? 10 * 60 * 1000,
    maxProcessOutputBytes: overrides.maxProcessOutputBytes ?? 1024 * 1024,
  };
}

/**
 * 音声長からwhisper-cliの実行タイムアウトを決定する。
 * 実測real-time factorに安全マージンを掛けた値とし、min/maxの範囲に収める。
 */
export function computeWhisperTimeoutMs(config: TranscriptionConfig, audioDurationMs: number): number {
  const estimated = audioDurationMs * config.whisperRtfSafetyMultiplier;
  return Math.min(config.whisperMaxTimeoutMs, Math.max(config.whisperMinTimeoutMs, estimated));
}
