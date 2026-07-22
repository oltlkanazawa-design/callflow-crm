// 1回分の営業通話解析の実行（thread/start → turn/start → turn/completed待機 → thread/read →
// 検証 → 不正なら1回だけ修正依頼 → thread/delete）。
// Codex App Serverとの実プロトコルは companion/src/codex-app-server.ts が担い、
// このファイルは解析固有のフロー（認証確認・タイムアウト・キャンセル・検証・後片付け）に専念する。

import { CodexRequestError, type CodexAppServer } from "./codex-app-server.ts";
import {
  buildDeveloperInstructions,
  buildRepairInputText,
  buildTranscriptInputText,
  isTranscriptTooLong,
} from "./analysis-prompt.ts";
import { validateAnalysisJson, ANALYSIS_OUTPUT_JSON_SCHEMA, type CallAnalysisResult } from "./analysis-schema.ts";

export type AnalysisErrorCode =
  | "not_authenticated"
  | "usage_limit_exceeded"
  | "codex_unavailable"
  | "timeout"
  | "cancelled"
  | "invalid_output"
  | "transcript_too_long"
  | "internal_error";

export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  constructor(code: AnalysisErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AnalysisError";
    this.code = code;
  }
}

export interface AnalysisRunResult {
  analysis: CallAnalysisResult;
}

export interface AnalysisRunHandle {
  result: Promise<AnalysisRunResult>;
  cancel: () => void;
}

export type AnalysisStage = "checking_auth" | "starting_codex" | "analyzing" | "validating";

export interface AnalysisRunConfig {
  turnTimeoutMs: number;
  workDir: string;
  onStage?: (stage: AnalysisStage) => void;
}

interface TurnCompletedPayload {
  threadId: string;
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    error: { message: string; codexErrorInfo: unknown } | null;
  };
}

function mapCodexErrorInfo(info: unknown): AnalysisErrorCode {
  if (info === "unauthorized") return "not_authenticated";
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return "usage_limit_exceeded";
  return "internal_error";
}

function waitForTurnCompleted(
  codex: CodexAppServer,
  threadId: string,
  turnId: string,
  timeoutMs: number,
  cancelSignal: { cancelled: boolean; onCancel: (fn: () => void) => void },
): Promise<TurnCompletedPayload["turn"]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new AnalysisError("timeout"));
    }, timeoutMs);

    const unsubscribe = codex.onNotification((method, params) => {
      if (settled || method !== "turn/completed") return;
      const payload = params as TurnCompletedPayload;
      if (payload.threadId !== threadId || payload.turn.id !== turnId) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(payload.turn);
    });

    cancelSignal.onCancel(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      reject(new AnalysisError("cancelled"));
    });

    if (cancelSignal.cancelled) {
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      reject(new AnalysisError("cancelled"));
    }
  });
}

interface ThreadReadResult {
  thread: { turns: Array<{ id: string; items: Array<{ type: string; text?: string }> }> };
}

async function findAgentMessageText(codex: CodexAppServer, threadId: string, turnId: string): Promise<string> {
  const readResult = (await codex.request("thread/read", { threadId, includeTurns: true })) as ThreadReadResult;
  const turn = readResult.thread.turns.find((t) => t.id === turnId);
  if (!turn) throw new AnalysisError("internal_error", "対象のturnが見つかりません");
  const agentMessages = turn.items.filter((item) => item.type === "agentMessage");
  const last = agentMessages[agentMessages.length - 1];
  if (!last || typeof last.text !== "string") {
    throw new AnalysisError("invalid_output", "Codexからの応答メッセージが見つかりません");
  }
  return last.text;
}

/**
 * 文字起こしテキストを解析する。呼び出し側（analysis-jobs.ts）はcancel()を保持し、
 * ジョブがキャンセルされた場合に呼ぶ。
 */
export function runAnalysis(codex: CodexAppServer, transcript: string, config: AnalysisRunConfig): AnalysisRunHandle {
  let cancelled = false;
  const cancelCallbacks: Array<() => void> = [];
  const cancelSignal = {
    get cancelled() {
      return cancelled;
    },
    onCancel(fn: () => void) {
      cancelCallbacks.push(fn);
    },
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const fn of cancelCallbacks) fn();
  };

  const result = (async (): Promise<AnalysisRunResult> => {
    try {
      return await runAnalysisSteps(codex, transcript, config, cancelSignal, () => cancelled);
    } catch (error) {
      // AnalysisErrorはそのまま伝える。CodexAppServer由来の生のCodexRequestError
      // （起動失敗・request timeout・プロセス異常終了等）は、ここで一律に
      // codex_unavailableへ正規化する。そうしないとジョブが原因不明のinternal_errorに
      // 分類され、利用者に「Codexを起動できない」ことが伝わらない。
      if (error instanceof AnalysisError) throw error;
      if (error instanceof CodexRequestError) {
        throw new AnalysisError("codex_unavailable", error.message);
      }
      throw error;
    }
  })();

  return { result, cancel };
}

async function runAnalysisSteps(
  codex: CodexAppServer,
  transcript: string,
  config: AnalysisRunConfig,
  cancelSignal: { cancelled: boolean; onCancel: (fn: () => void) => void },
  isCancelled: () => boolean,
): Promise<AnalysisRunResult> {
  if (isTranscriptTooLong(transcript)) {
    throw new AnalysisError("transcript_too_long");
  }

  config.onStage?.("checking_auth");
  const authStatus = (await codex.request("getAuthStatus", { includeToken: false, refreshToken: false })) as {
    authMethod: string | null;
  };
  if (!authStatus.authMethod) {
    throw new AnalysisError("not_authenticated");
  }
  if (isCancelled()) throw new AnalysisError("cancelled");

  config.onStage?.("starting_codex");
  const threadStart = (await codex.request("thread/start", {
    cwd: config.workDir,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: buildDeveloperInstructions(),
  })) as { thread: { id: string } };
  const threadId = threadStart.thread.id;
  if (isCancelled()) {
    await safeDeleteThread(codex, threadId);
    throw new AnalysisError("cancelled");
  }

  try {
    config.onStage?.("analyzing");
    let text = await runTurn(codex, threadId, buildTranscriptInputText(transcript), config.turnTimeoutMs, cancelSignal);
    config.onStage?.("validating");
    let validated = validateAnalysisJson(text);

    if (!validated.ok) {
      if (isCancelled()) throw new AnalysisError("cancelled");
      config.onStage?.("analyzing");
      text = await runTurn(codex, threadId, buildRepairInputText(validated.reason), config.turnTimeoutMs, cancelSignal);
      config.onStage?.("validating");
      validated = validateAnalysisJson(text);
    }

    if (!validated.ok) {
      throw new AnalysisError("invalid_output", validated.reason);
    }

    return { analysis: validated.value };
  } finally {
    await safeDeleteThread(codex, threadId);
  }
}

async function runTurn(
  codex: CodexAppServer,
  threadId: string,
  inputText: string,
  turnTimeoutMs: number,
  cancelSignal: { cancelled: boolean; onCancel: (fn: () => void) => void },
): Promise<string> {
  const turnStart = (await codex.request("turn/start", {
    threadId,
    input: [{ type: "text", text: inputText, text_elements: [] }],
    outputSchema: ANALYSIS_OUTPUT_JSON_SCHEMA,
  })) as { turn: { id: string } };
  const turnId = turnStart.turn.id;

  let turn: TurnCompletedPayload["turn"];
  try {
    turn = await waitForTurnCompleted(codex, threadId, turnId, turnTimeoutMs, cancelSignal);
  } catch (error) {
    if (error instanceof AnalysisError && (error.code === "timeout" || error.code === "cancelled")) {
      await safeInterruptTurn(codex, threadId, turnId);
    }
    throw error;
  }

  if (turn.status === "failed") {
    throw new AnalysisError(mapCodexErrorInfo(turn.error?.codexErrorInfo ?? null), turn.error?.message);
  }
  if (turn.status === "interrupted") {
    throw new AnalysisError("cancelled");
  }

  return findAgentMessageText(codex, threadId, turnId);
}

async function safeInterruptTurn(codex: CodexAppServer, threadId: string, turnId: string): Promise<void> {
  try {
    await codex.request("turn/interrupt", { threadId, turnId }, 5000);
  } catch {
    // ベストエフォート。失敗してもthread/deleteで後片付けを続行する。
  }
}

async function safeDeleteThread(codex: CodexAppServer, threadId: string): Promise<void> {
  try {
    await codex.request("thread/delete", { threadId }, 5000);
  } catch {
    // ベストエフォート。スレッド削除に失敗してもジョブ自体の結果には影響させない
    // （Codex側のメモリはスレッドの寿命内でしか保持されないため致命的ではない）。
  }
}
