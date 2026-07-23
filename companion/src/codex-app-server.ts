// `codex app-server` の子プロセス管理。
// node:child_process.spawnをargv配列で呼び出す（shell:trueは使用しない、evalも使用しない）。
// 標準入出力は改行区切りJSON（JSONL）のJSON-RPC 2.0。JSONとして解釈できない行は
// 実行せずログにも本文を出さずに破棄する（stdoutを信頼できるJSON-RPC通信路以外の
// 用途に使わない）。
//
// 実プロトコルは `codex app-server generate-ts` で生成した型と、実際にプロセスを
// 起動しての生テストで確認済み（initialize→getAuthStatus→thread/start→turn/start→
// turn/completed通知→thread/read→thread/delete）。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexAppServerConfig {
  /** codexバイナリのパス。テスト時はfakeスクリプトに差し替える。 */
  codexBinaryPath: string;
  /** 子プロセスのargs（既定は ["app-server"]）。 */
  codexArgs: readonly string[];
  /** 子プロセスの作業ディレクトリ（リポジトリ外の専用ディレクトリを渡すこと）。 */
  workDir: string;
  /** initializeの応答を待つ上限時間。 */
  startupTimeoutMs: number;
  /** 個別リクエストの既定タイムアウト（呼び出し側で上書き可能）。 */
  defaultRequestTimeoutMs: number;
  /** 異常終了後に自動で再起動を試みる最大回数（無限再起動はしない）。 */
  maxRestarts: number;
  /** 終了時、SIGTERM後にSIGKILLへ切り替えるまでの猶予。 */
  shutdownGraceMs: number;
}

/** Codexスレッドの作業ディレクトリの既定値（リポジトリ外、Companionの他データと同じ場所）。 */
export function defaultCodexWorkDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "CallFlow Companion", "codex-workdir");
}

function readCodexArgsEnv(): readonly string[] | null {
  // テスト専用: 偽app-server（[スクリプトパス, 設定ファイルパス]）へ差し替えるためのフック。
  // 本番では設定されない（通常のcodex CLIは常に["app-server"]で起動する）。
  const raw = process.env.CALLFLOW_CODEX_ARGS_JSON;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch {
    // 不正な値は無視して既定値にフォールバックする。
  }
  return null;
}

export function loadCodexAppServerConfig(overrides: Partial<CodexAppServerConfig> = {}): CodexAppServerConfig {
  return {
    codexBinaryPath: overrides.codexBinaryPath ?? process.env.CALLFLOW_CODEX_BINARY_PATH ?? "codex",
    codexArgs: overrides.codexArgs ?? readCodexArgsEnv() ?? ["app-server"],
    workDir: overrides.workDir ?? process.env.CALLFLOW_CODEX_WORK_DIR ?? defaultCodexWorkDir(),
    startupTimeoutMs: overrides.startupTimeoutMs ?? 15_000,
    defaultRequestTimeoutMs: overrides.defaultRequestTimeoutMs ?? 30_000,
    maxRestarts: overrides.maxRestarts ?? 1,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 3000,
  };
}

export type CodexNotificationHandler = (method: string, params: unknown) => void;

export type CodexAppServerState = "stopped" | "starting" | "ready" | "crashed" | "unavailable";

class CodexRequestError extends Error {
  readonly rpcError?: JsonRpcErrorShape;
  constructor(message: string, rpcError?: JsonRpcErrorShape) {
    super(message);
    this.name = "CodexRequestError";
    this.rpcError = rpcError;
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 許可された環境変数だけを子プロセスへ渡す（Companion自身の環境に紛れうる秘密情報を渡さない）。 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const allowedKeys = ["HOME", "PATH", "LANG", "CODEX_HOME", "TMPDIR"] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 既に終了している場合は無視する。
  }
}

export class CodexAppServer {
  private readonly config: CodexAppServerConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<CodexNotificationHandler>();
  private restartCount = 0;
  private state: CodexAppServerState = "stopped";
  private startPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(config: Partial<CodexAppServerConfig> = {}) {
    this.config = loadCodexAppServerConfig(config);
  }

  get workDir(): string {
    return this.config.workDir;
  }

  get currentState(): CodexAppServerState {
    return this.state;
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * 起動済み・利用可能であることを保証する。停止中なら起動し、直近でクラッシュしていれば
   * 1回だけ再起動を試みる。再起動回数の上限に達している場合は例外を投げる（無限再起動しない）。
   */
  async ensureReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "starting" && this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.state === "unavailable") {
      throw new CodexRequestError("codex_unavailable");
    }
    if (this.state === "crashed") {
      if (this.restartCount >= this.config.maxRestarts) {
        this.state = "unavailable";
        throw new CodexRequestError("codex_unavailable");
      }
      this.restartCount += 1;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    this.state = "starting";
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
      this.state = "ready";
    } catch (error) {
      this.state = "crashed";
      // 起動失敗（起動タイムアウト等）でchildが生きたまま残ると、次のensureReady()が
      // 再起動時に新しい子プロセスを追加でspawnし、古い方が孤児として残ってしまう。
      // 起動シーケンスの失敗はここで一箇所にまとめて後始末する。
      if (this.child && this.child.pid) {
        killProcessGroup(this.child.pid, "SIGTERM");
      }
      this.child = null;
      this.rl?.close();
      this.rl = null;
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    const child = spawn(this.config.codexBinaryPath, [...this.config.codexArgs], {
      cwd: this.config.workDir,
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    this.rl = rl;
    rl.on("line", (line) => this.handleLine(line));

    // 標準エラー出力はJSON-RPC通信路には混ぜない。デバッグ用に末尾のみ保持し、
    // 生の文字起こし内容・認証情報を含みうる詳細はログへ出さない（サイズのみ記録）。
    child.stderr.on("data", () => {
      // 現状は破棄のみ（将来的な診断強化のためのフックポイント）。
    });

    // プロセス終了直後の書き込み（キャンセル時のturn/interrupt送信等との競合）でstdinが
    // 'error'（EPIPE/ERR_STREAM_WRITE_AFTER_END等）を出すことがある。リスナーが無いと
    // Node.jsの既定動作でCompanionプロセス全体が丸ごと落ちるため、ここで必ず受け止める
    // （実際の失敗はrawRequest側のwriteコールバック・タイムアウトで別途処理済み）。
    // stdin/stdoutだけでなくstderrも同様（読み取り専用パイプでも'error'は起こりうる）。
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("exit", () => this.handleExit());
    child.on("error", () => this.handleExit());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CodexRequestError("codex_startup_timeout"));
      }, this.config.startupTimeoutMs);

      this.rawRequest("initialize", {
        clientInfo: { name: "callflow-companion", title: "CallFlow Companion", version: "0.1.0" },
        capabilities: null,
      })
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("initialize_failed"));
        });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // JSONとして解釈できない行は実行せず破棄する。
      return;
    }

    if (typeof msg.id !== "undefined" && (typeof msg.id === "number" || typeof msg.id === "string")) {
      const id = typeof msg.id === "string" ? Number.parseInt(msg.id, 10) : msg.id;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if ("error" in msg && msg.error) {
        const rpcError = msg.error as JsonRpcErrorShape;
        entry.reject(new CodexRequestError(rpcError.message || "codex_rpc_error", rpcError));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      for (const handler of this.notificationHandlers) {
        try {
          handler(msg.method, msg.params);
        } catch {
          // 通知ハンドラ側の例外でプロセス管理そのものを壊さない。
        }
      }
    }
  }

  private handleExit(): void {
    const wasStopping = this.stopping;
    this.child = null;
    this.rl?.close();
    this.rl = null;

    const crashError = new CodexRequestError("codex_process_exited");
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(crashError);
      this.pending.delete(id);
    }

    if (!wasStopping) {
      this.state = "crashed";
    }
  }

  private rawRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new CodexRequestError("codex_not_running"));
    }
    const id = this.nextId++;
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestError("codex_request_timeout"));
      }, timeoutMs ?? this.config.defaultRequestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      child.stdin.write(payload, (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            reject(new CodexRequestError("codex_write_failed"));
          }
        }
      });
    });
  }

  /** ensureReady()を呼んだ上でリクエストを送る。認証情報・文字起こし全文はこの層ではログに出さない。 */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    await this.ensureReady();
    return this.rawRequest(method, params, timeoutMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CodexRequestError("codex_shutting_down"));
      this.pending.delete(id);
    }
    const child = this.child;
    if (!child || !child.pid) {
      this.state = "stopped";
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = () => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        resolve();
      };
      child.once("exit", finish);

      try {
        child.stdin.end();
      } catch {
        // 既に閉じている場合は無視する。
      }

      // stdin.endだけで終了しない場合に備え、猶予後にSIGTERM→さらに猶予後にSIGKILLへ進める。
      const termTimer = setTimeout(() => {
        if (child.pid) killProcessGroup(child.pid, "SIGTERM");
      }, this.config.shutdownGraceMs);
      const killTimer = setTimeout(() => {
        if (child.pid) killProcessGroup(child.pid, "SIGKILL");
      }, this.config.shutdownGraceMs * 2);
      // 最終手段として、exitイベントを取りこぼした場合でも必ず解決する。
      const fallbackTimer = setTimeout(finish, this.config.shutdownGraceMs * 2 + 1000);
      termTimer.unref();
      killTimer.unref();
      fallbackTimer.unref();
      timers.push(termTimer, killTimer, fallbackTimer);
    });

    this.state = "stopped";
    this.child = null;
  }
}

export { CodexRequestError };
