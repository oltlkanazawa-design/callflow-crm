// 営業通話解析ジョブ（Phase 4）のライフサイクル管理。
// transcription-jobs.tsと同じ設計方針を踏襲する：メモリ内のみ、同時実行数を絞った
// キュー、発行元トークンのハッシュによるアクセス制御（pairing.tsは変更せず独自算出）、
// finishJobの二重実行防止、完了ジョブTTLタイマーのunref。
//
// ブラウザから文字起こし全文を再送させず、Companion内の完了済みtranscriptionJobを
// transcriptionJobIdで参照する。参照した時点でテキストをこのジョブ内へコピーするため、
// 元のtranscriptionJobが後からTTL失効しても解析は継続できる。

import crypto from "node:crypto";
import type { CodexAppServer } from "./codex-app-server.ts";
import { runAnalysis, AnalysisError, type AnalysisErrorCode, type AnalysisStage } from "./codex-analysis.ts";
import type { CallAnalysisResult } from "./analysis-schema.ts";
import type { TranscriptionJobManager } from "./transcription-jobs.ts";

export type AnalysisJobStatus =
  | "queued"
  | "checking_auth"
  | "starting_codex"
  | "analyzing"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled";

export type AnalysisJobErrorCode =
  | AnalysisErrorCode
  | "transcription_not_found"
  | "transcription_not_ready"
  | "transcription_empty"
  | "internal_error";

const JOB_ERROR_MESSAGES: Record<AnalysisJobErrorCode, string> = {
  not_authenticated: "Codexへのログインが必要です。ターミナルで codex login を実行してください。",
  usage_limit_exceeded: "Codexの利用上限に達しています。利用可能になってから再試行してください。",
  codex_unavailable: "Codexアプリサーバーを起動できませんでした。",
  timeout: "解析処理がタイムアウトしました。",
  cancelled: "キャンセルされました。",
  invalid_output: "Codexからの応答を解析結果として解釈できませんでした。",
  transcript_too_long: "文字起こしが長すぎるため解析できません。",
  transcription_not_found: "参照元の文字起こしジョブが見つかりません。",
  transcription_not_ready: "参照元の文字起こしがまだ完了していません。",
  transcription_empty: "参照元の文字起こしが空です。",
  internal_error: "Companion内部でエラーが発生しました。",
};

export function analysisJobErrorMessage(code: AnalysisJobErrorCode): string {
  return JOB_ERROR_MESSAGES[code];
}

export interface AnalysisJobConfig {
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  completedJobTtlMs: number;
  /** turn/start 1回あたりのタイムアウト（修正依頼を含めると最大2回分かかりうる）。 */
  turnTimeoutMs: number;
  /** Codexスレッドの作業ディレクトリ（リポジトリ外の専用ディレクトリ）。 */
  workDir: string;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadAnalysisJobConfig(overrides: Partial<AnalysisJobConfig> & { workDir: string }): AnalysisJobConfig {
  return {
    maxConcurrentJobs: overrides.maxConcurrentJobs ?? readIntEnv("CALLFLOW_ANALYSIS_MAX_CONCURRENT_JOBS", 1),
    maxQueuedJobs: overrides.maxQueuedJobs ?? readIntEnv("CALLFLOW_ANALYSIS_MAX_QUEUED_JOBS", 1),
    completedJobTtlMs: overrides.completedJobTtlMs ?? readIntEnv("CALLFLOW_ANALYSIS_JOB_TTL_MS", 10 * 60 * 1000),
    turnTimeoutMs: overrides.turnTimeoutMs ?? readIntEnv("CALLFLOW_ANALYSIS_TURN_TIMEOUT_MS", 3 * 60 * 1000),
    workDir: overrides.workDir,
  };
}

interface Job {
  id: string;
  tokenHash: string;
  status: AnalysisJobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  transcriptSnapshot: string;
  companyId: string;
  analysis: CallAnalysisResult | null;
  errorCode: AnalysisJobErrorCode | null;
  activeCancel: (() => void) | null;
  finished: boolean;
}

export interface AnalysisJobPublicView {
  jobId: string;
  status: AnalysisJobStatus;
  analysis: CallAnalysisResult | null;
  errorCode: AnalysisJobErrorCode | null;
  message: string | null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export type CreateAnalysisJobResult = { ok: true; jobId: string } | { ok: false; reason: "queue_full" | AnalysisJobErrorCode };

export class AnalysisJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private runningCount = 0;
  private readonly ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shuttingDown = false;

  private readonly config: AnalysisJobConfig;
  private readonly transcriptionJobs: TranscriptionJobManager;
  private readonly codex: CodexAppServer;

  constructor(config: AnalysisJobConfig, transcriptionJobs: TranscriptionJobManager, codex: CodexAppServer) {
    this.config = config;
    this.transcriptionJobs = transcriptionJobs;
    this.codex = codex;
  }

  /**
   * POST /v1/analyses: 完了済みtranscriptionJobを参照して解析ジョブを作成する。
   * 文字起こし全文はここで一度だけ読み取り、このジョブ内にコピーする
   * （元のtranscriptionJobが後でTTL失効しても解析には影響しない）。
   */
  submitAnalysis(authorizationHeader: string | undefined, transcriptionJobId: string, companyId: string): CreateAnalysisJobResult {
    if (this.shuttingDown) {
      return { ok: false, reason: "internal_error" };
    }
    if (this.queue.length >= this.config.maxQueuedJobs && this.runningCount >= this.config.maxConcurrentJobs) {
      return { ok: false, reason: "queue_full" };
    }
    if (!companyId) {
      return { ok: false, reason: "internal_error" };
    }

    const transcriptionJob = this.transcriptionJobs.getJob(transcriptionJobId, authorizationHeader);
    if (!transcriptionJob) {
      return { ok: false, reason: "transcription_not_found" };
    }
    if (transcriptionJob.status !== "completed") {
      return { ok: false, reason: "transcription_not_ready" };
    }
    if (!transcriptionJob.text || !transcriptionJob.text.trim()) {
      return { ok: false, reason: "transcription_empty" };
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
      transcriptSnapshot: transcriptionJob.text,
      companyId,
      analysis: null,
      errorCode: null,
      activeCancel: null,
      finished: false,
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    void this.pump();
    return { ok: true, jobId };
  }

  getJob(jobId: string, authorizationHeader: string | undefined): AnalysisJobPublicView | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const tokenHash = hashToken(authorizationHeader?.slice("Bearer ".length).trim() ?? "");
    if (!timingSafeEqualHex(tokenHash, job.tokenHash)) return null;
    return toPublicView(job);
  }

  cancelJob(jobId: string, authorizationHeader: string | undefined): AnalysisJobPublicView | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const tokenHash = hashToken(authorizationHeader?.slice("Bearer ".length).trim() ?? "");
    if (!timingSafeEqualHex(tokenHash, job.tokenHash)) return null;

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return toPublicView(job);
    }

    if (job.activeCancel) job.activeCancel();
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);

    // finishJobは非同期（TTL登録を含む）だが、呼び出し元へはここで同期的に返答するため、
    // statusはここで即座に確定させる。
    job.status = "cancelled";
    job.errorCode = "cancelled";
    job.activeCancel = null;
    job.updatedAt = Date.now();
    void this.finishJob(job, "cancelled", "cancelled", null);
    return toPublicView(job);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const jobId of [...this.queue]) {
      const job = this.jobs.get(jobId);
      if (job) await this.finishJob(job, "cancelled", "cancelled", null);
    }
    this.queue.length = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
        if (job.activeCancel) job.activeCancel();
        await this.finishJob(job, "cancelled", "cancelled", null);
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
    if (this.runningCount >= this.config.maxConcurrentJobs) return;
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
   * runAnalysis()呼び出しの外側ラッパー。想定外の例外がpump()経由の未処理rejectionとなり
   * Companion全体（進行中の他ジョブも含めて）をクラッシュさせないよう、必ずここでfinishJobへ倒す。
   */
  private async process(job: Job): Promise<void> {
    try {
      const handle = runAnalysis(this.codex, job.transcriptSnapshot, {
        turnTimeoutMs: this.config.turnTimeoutMs,
        workDir: this.config.workDir,
        onStage: (stage: AnalysisStage) => {
          if (job.finished) return;
          job.status = stage;
          job.updatedAt = Date.now();
        },
      });
      job.activeCancel = handle.cancel;
      const outcome = await handle.result;
      job.activeCancel = null;
      await this.finishJob(job, "completed", null, outcome.analysis);
    } catch (error) {
      job.activeCancel = null;
      if (error instanceof AnalysisError) {
        const status: AnalysisJobStatus = error.code === "cancelled" ? "cancelled" : "failed";
        await this.finishJob(job, status, error.code, null);
      } else {
        await this.finishJob(job, "failed", "internal_error", null);
      }
    }
  }

  private async finishJob(
    job: Job,
    status: AnalysisJobStatus,
    errorCode: AnalysisJobErrorCode | null,
    analysis: CallAnalysisResult | null,
  ): Promise<void> {
    // process()の自然完了とcancelJob/shutdownによる明示キャンセルが競合しうるため、
    // transcription-jobs.tsと同じ理由でfinishJobは最初の1回だけを有効とする。
    if (job.finished) return;
    job.finished = true;

    job.status = status;
    job.errorCode = errorCode;
    job.analysis = analysis;
    job.completedAt = Date.now();
    job.updatedAt = job.completedAt;
    job.activeCancel = null;

    const ttl = setTimeout(() => {
      this.jobs.delete(job.id);
      this.ttlTimers.delete(job.id);
    }, this.config.completedJobTtlMs);
    // ハウスキーピング専用タイマー。transcription-jobs.tsで踏んだ教訓（unrefしないと
    // イベントループを引き止め、Companion終了/テスト実行が止まる）を最初から適用する。
    ttl.unref();
    this.ttlTimers.set(job.id, ttl);
  }
}

function toPublicView(job: Job): AnalysisJobPublicView {
  return {
    jobId: job.id,
    status: job.status,
    analysis: job.analysis,
    errorCode: job.errorCode,
    message: job.errorCode ? analysisJobErrorMessage(job.errorCode) : null,
  };
}
