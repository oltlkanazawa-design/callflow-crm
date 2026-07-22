// 文字起こしジョブのライフサイクル管理（メモリ内のみ、Companion再起動で全失効）。
// 同時実行1件・待機キュー上限あり。発行元トークンのハッシュでアクセス制御する
// （pairing.tsは変更せず、同一アルゴリズムでこのモジュール内に独自算出する）。

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createTempFile, deleteTempFile } from "./temp-files.ts";
import { receiveAudioUpload } from "./audio-upload.ts";
import {
  runFfmpegConvert,
  runWhisperTranscribe,
  estimateWavDurationMs,
  readWhisperJsonResult,
} from "./transcription-process.ts";
import { loadTranscriptionConfig, modelPathFor, computeWhisperTimeoutMs, type TranscriptionConfig } from "./transcription-config.ts";
import type { CompanionConfig } from "./types.ts";

export type JobStatus = "queued" | "converting" | "transcribing" | "completed" | "failed" | "cancelled";

export type JobErrorCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "empty_audio"
  | "audio_too_long"
  | "conversion_failed"
  | "conversion_timeout"
  | "transcription_failed"
  | "transcription_timeout"
  | "cancelled"
  | "internal_error";

interface Job {
  id: string;
  tokenHash: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  text: string | null;
  modelUsed: string | null;
  durationMs: number | null;
  errorCode: JobErrorCode | null;
  activeCancel: (() => void) | null;
  audioFilePath: string | null;
  wavFilePath: string | null;
  jsonBasePath: string | null;
  temporaryFilesDeleted: boolean;
  /** finishJobが既に一度確定させたか。process()側とcancelJob/shutdown側が競合して二重に確定させるのを防ぐ。 */
  finished: boolean;
}

export interface JobPublicView {
  jobId: string;
  status: JobStatus;
  text: string | null;
  modelUsed: string | null;
  durationMs: number | null;
  errorCode: JobErrorCode | null;
  temporaryFilesDeleted: boolean;
}

const JOB_ERROR_MESSAGES: Record<JobErrorCode, string> = {
  unsupported_media_type: "対応していない録音形式です。",
  payload_too_large: "録音ファイルのサイズが上限を超えています。",
  empty_audio: "録音データが空です。",
  audio_too_long: "音声が60分を超えているため、現在のバージョンでは文字起こしできません。",
  conversion_failed: "音声の変換に失敗しました。",
  conversion_timeout: "音声の変換がタイムアウトしました。",
  transcription_failed: "文字起こし処理に失敗しました。",
  transcription_timeout: "文字起こし処理がタイムアウトしました。",
  cancelled: "キャンセルされました。",
  internal_error: "Companion内部でエラーが発生しました。",
};

export function jobErrorMessage(code: JobErrorCode): string {
  return JOB_ERROR_MESSAGES[code];
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export type CreateJobResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "queue_full" | JobErrorCode };

export class TranscriptionJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private runningCount = 0;
  /** アップロード受信中（まだqueueに積まれていない）件数。上限判定に含めないと同時アップロードで上限を回避できてしまう。 */
  private reservedUploadSlots = 0;
  private readonly ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly companionConfig: CompanionConfig;
  private readonly transcriptionConfig: TranscriptionConfig;
  private shuttingDown = false;

  constructor(companionConfig: CompanionConfig, transcriptionConfig: TranscriptionConfig = loadTranscriptionConfig()) {
    this.companionConfig = companionConfig;
    this.transcriptionConfig = transcriptionConfig;
  }

  /** POST /v1/transcriptions: 音声を受信してジョブを作成し、即座にjobIdを返す。処理は非同期に進む。 */
  async submitAudio(req: IncomingMessage, authorizationHeader: string | undefined, contentType: string | null, contentLengthHeader: number | null): Promise<CreateJobResult> {
    if (this.shuttingDown) {
      return { ok: false, reason: "internal_error" };
    }
    // アップロード受信中の件数も上限判定に含める。そうしないと、受信中（await receiveAudioUpload）は
    // まだqueueに積まれていないため、同時に大量のリクエストが来ると全てがこのチェックを通過してしまう。
    if (
      this.queue.length + this.reservedUploadSlots >= this.transcriptionConfig.maxQueuedJobs &&
      this.runningCount >= this.transcriptionConfig.maxConcurrentJobs
    ) {
      return { ok: false, reason: "queue_full" };
    }

    this.reservedUploadSlots += 1;
    let received: Awaited<ReturnType<typeof receiveAudioUpload>>;
    try {
      received = await receiveAudioUpload(req, {
        tmpDir: this.companionConfig.tmpDir,
        maxBodyBytes: this.transcriptionConfig.maxUploadBytes,
        contentType,
        contentLengthHeader,
      });
    } finally {
      this.reservedUploadSlots -= 1;
    }

    if (!received.ok) {
      return { ok: false, reason: received.reason };
    }

    const tokenHash = hashToken(authorizationHeader?.slice("Bearer ".length).trim() ?? "");
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const job: Job = {
      id: jobId,
      tokenHash,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      text: null,
      modelUsed: null,
      durationMs: null,
      errorCode: null,
      activeCancel: null,
      audioFilePath: received.filePath,
      wavFilePath: null,
      jsonBasePath: null,
      // 処理中は「まだ削除されていない」が正しい。finishJobが実際に削除してからtrueにする
      // （trueで初期化すると、処理中に問い合わせたクライアントへ「音声は既に削除済み」という誤った情報を返してしまう）。
      temporaryFilesDeleted: false,
      finished: false,
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    void this.pump();
    return { ok: true, jobId };
  }

  getJob(jobId: string, authorizationHeader: string | undefined): JobPublicView | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const tokenHash = hashToken(authorizationHeader?.slice("Bearer ".length).trim() ?? "");
    if (!timingSafeEqualHex(tokenHash, job.tokenHash)) return null;
    return toPublicView(job);
  }

  cancelJob(jobId: string, authorizationHeader: string | undefined): JobPublicView | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const tokenHash = hashToken(authorizationHeader?.slice("Bearer ".length).trim() ?? "");
    if (!timingSafeEqualHex(tokenHash, job.tokenHash)) return null;

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return toPublicView(job);
    }

    if (job.activeCancel) {
      job.activeCancel();
    }
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
    }

    // 一時ファイル削除・TTL登録は非同期（finishJob）だが、呼び出し元へはここで同期的に
    // 返答するため、statusはここで即座に確定させる（そうしないと返り値が古い状態のままになる）。
    job.status = "cancelled";
    job.errorCode = "cancelled";
    job.activeCancel = null;
    job.updatedAt = Date.now();
    void this.finishJob(job, "cancelled", "cancelled", null, null);
    return toPublicView(job);
  }

  /** Companion終了時に呼ぶ。実行中・待機中のジョブをすべてキャンセルし、一時ファイルを削除する。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const jobId of [...this.queue]) {
      const job = this.jobs.get(jobId);
      if (job) await this.finishJob(job, "cancelled", "cancelled", null, null);
    }
    this.queue.length = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "converting" || job.status === "transcribing") {
        if (job.activeCancel) job.activeCancel();
        await this.finishJob(job, "cancelled", "cancelled", null, null);
      }
    }
    for (const timer of this.ttlTimers.values()) clearTimeout(timer);
    this.ttlTimers.clear();
  }

  get stats(): { queued: number; running: number; total: number } {
    return { queued: this.queue.length, running: this.runningCount, total: this.jobs.size };
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.runningCount >= this.transcriptionConfig.maxConcurrentJobs) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job) {
      void this.pump();
      return;
    }
    this.runningCount += 1;
    try {
      await this.process(job);
    } finally {
      this.runningCount -= 1;
      void this.pump();
    }
  }

  /**
   * ffmpeg変換・whisper-cli実行のステップを実行する。
   * fs操作（createTempFile/estimateWavDurationMs等）は例外を投げうるため、
   * ここで捕捉せず外側のprocess()に任せる（一箇所でまとめて安全にfinishJobへ倒す）。
   */
  private async runProcessSteps(job: Job): Promise<void> {
    const tmpDir = this.companionConfig.tmpDir;

    // --- 変換 ---
    job.status = "converting";
    job.updatedAt = Date.now();
    const wavHandle = await createTempFile(tmpDir, "wav");
    job.wavFilePath = wavHandle.filePath;

    const ffmpegRun = runFfmpegConvert(this.transcriptionConfig, job.audioFilePath as string, wavHandle.filePath);
    job.activeCancel = ffmpegRun.cancel;
    const ffmpegResult = await ffmpegRun.result;
    job.activeCancel = null;

    if (!ffmpegResult.ok) {
      const code: JobErrorCode = ffmpegResult.timedOut ? "conversion_timeout" : ffmpegResult.cancelled ? "cancelled" : "conversion_failed";
      await this.finishJob(job, code === "cancelled" ? "cancelled" : "failed", code, null, null);
      return;
    }

    // ffmpeg完了直後〜次のフェーズ開始までの間にcancelJob/shutdownが割り込んだ場合、
    // job.finishedは既にtrue（一時ファイルも削除済み）になっている。
    // ここでreturnしないと、既に削除されたWAVに対してwhisper-cliを起動してしまう。
    if (job.finished) return;

    const durationMs = await estimateWavDurationMs(wavHandle.filePath);
    if (durationMs > this.transcriptionConfig.maxAudioDurationMs) {
      await this.finishJob(job, "failed", "audio_too_long", null, durationMs);
      return;
    }

    if (job.finished) return;

    // --- 文字起こし ---
    job.status = "transcribing";
    job.updatedAt = Date.now();
    const modelPath = modelPathFor(this.transcriptionConfig.modelDir, this.transcriptionConfig.defaultModel);
    const jsonBase = wavHandle.filePath.replace(/\.wav$/, "");
    job.jsonBasePath = jsonBase;
    const timeoutMs = computeWhisperTimeoutMs(this.transcriptionConfig, durationMs);

    const whisperRun = runWhisperTranscribe(this.transcriptionConfig, modelPath, wavHandle.filePath, jsonBase, timeoutMs);
    job.activeCancel = whisperRun.cancel;
    const whisperResult = await whisperRun.result;
    job.activeCancel = null;

    if (!whisperResult.ok) {
      const code: JobErrorCode = whisperResult.timedOut ? "transcription_timeout" : whisperResult.cancelled ? "cancelled" : "transcription_failed";
      await this.finishJob(job, code === "cancelled" ? "cancelled" : "failed", code, null, durationMs);
      return;
    }

    try {
      const parsed = await readWhisperJsonResult(`${jsonBase}.json`);
      await this.finishJob(job, "completed", null, { text: parsed.text, modelUsed: parsed.modelType }, durationMs);
    } catch {
      await this.finishJob(job, "failed", "internal_error", null, durationMs);
    }
  }

  /**
   * runProcessStepsの外側ラッパー。fs操作等での想定外の例外（ディスク容量不足・権限エラー等）が
   * 補足されずに外へ漏れると、pump()経由のvoid呼び出しが未処理rejectionとなり、
   * Companionプロセス全体（進行中の/v1/audioアップロードも含めて）を巻き込んでクラッシュさせてしまう。
   * そのため、このジョブ以外に影響が及ばないよう必ずここでfinishJobへ倒す。
   */
  private async process(job: Job): Promise<void> {
    try {
      await this.runProcessSteps(job);
    } catch {
      await this.finishJob(job, "failed", "internal_error", null, null);
    }
  }

  private async finishJob(
    job: Job,
    status: JobStatus,
    errorCode: JobErrorCode | null,
    result: { text: string; modelUsed: string } | null,
    durationMs: number | null,
  ): Promise<void> {
    // process()の自然完了とcancelJob/shutdownによる明示キャンセルが競合すると、
    // 同じジョブに対してfinishJobが二重に呼ばれうる（片方はプロセスをkillした側、
    // もう片方はkillされたプロセスのclose/timeoutを検知した側）。
    // 二重実行するとTTLタイマーが再登録されてクリアされずに残り、
    // Companion終了後もイベントループが生き続ける（テスト実行時はプロセスが終了しない）原因になるため、
    // 最初の1回だけを有効とする。
    if (job.finished) return;
    job.finished = true;

    // 一時ファイルは成功・失敗・キャンセルいずれの場合も必ず削除する。削除失敗は成功扱いにしない。
    let allDeleted = true;
    if (job.audioFilePath) {
      allDeleted = (await deleteTempFile(this.companionConfig.tmpDir, job.audioFilePath)) && allDeleted;
    }
    if (job.wavFilePath) {
      allDeleted = (await deleteTempFile(this.companionConfig.tmpDir, job.wavFilePath)) && allDeleted;
    }
    if (job.jsonBasePath) {
      allDeleted = (await deleteTempFile(this.companionConfig.tmpDir, `${job.jsonBasePath}.json`)) && allDeleted;
    }

    job.status = status;
    job.errorCode = errorCode;
    job.text = result?.text ?? null;
    job.modelUsed = result?.modelUsed ?? null;
    job.durationMs = durationMs;
    job.completedAt = Date.now();
    job.updatedAt = job.completedAt;
    job.activeCancel = null;
    job.temporaryFilesDeleted = allDeleted;

    const ttl = setTimeout(() => {
      this.jobs.delete(job.id);
      this.ttlTimers.delete(job.id);
    }, this.transcriptionConfig.completedJobTtlMs);
    // 完了ジョブのメモリ回収のためだけのハウスキーピングタイマーであり、これ自体がプロセスの
    // 生存を左右してはいけない。cancelJob()はfinishJob()をawaitせず同期的に返答するため、
    // shutdown()のタイマー一括clearとこの登録がすり抜けて競合するケースが理論上あり得るが、
    // unref()しておけば競合してもイベントループを掴んだままにはならない。
    ttl.unref();
    this.ttlTimers.set(job.id, ttl);
  }
}

function toPublicView(job: Job): JobPublicView {
  return {
    jobId: job.id,
    status: job.status,
    text: job.text,
    modelUsed: job.modelUsed,
    durationMs: job.durationMs,
    errorCode: job.errorCode,
    temporaryFilesDeleted: job.temporaryFilesDeleted,
  };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
