// テスト専用ヘルパー: `codex app-server`の偽実装（Node製・JSONL）を生成する。
// 実際のCodex CLI/ChatGPTアカウントは一切使用しない。*.test.tsではないためテストランナーには
// 収集されない。挙動は起動時にCALLFLOW_FAKE_CODEX_CONFIG（JSONファイルパス）から読み込む
// （CodexAppServerは長期生存プロセスのため、1テスト＝1プロセスとして都度起動する運用を前提にする）。

import fs from "node:fs/promises";
import path from "node:path";

export type FakeTurnBehavior =
  | "success"
  | "invalid_json"
  | "invalid_enum"
  | "usage_limit"
  | "unauthorized_turn_error"
  | "server_error"
  | "hang";

export interface FakeCodexConfig {
  authMethod: "chatgpt" | null;
  firstTurnBehavior: FakeTurnBehavior;
  secondTurnBehavior: FakeTurnBehavior;
  analysisJson: string;
  initializeDelayMs: number;
  exitAfterRequestCount: number | null;
}

export function defaultFakeCodexConfig(overrides: Partial<FakeCodexConfig> = {}): FakeCodexConfig {
  return {
    authMethod: "chatgpt",
    firstTurnBehavior: "success",
    secondTurnBehavior: "success",
    analysisJson: JSON.stringify({
      result: "資料送付",
      heat: "中",
      summary: "テスト用の要約です。",
      contact_name: "テスト太郎",
      challenges: ["テスト課題"],
      next_action: "資料を送付する",
      next_action_at: null,
      confidence: 0.9,
      needs_review: false,
      review_reasons: [],
    }),
    initializeDelayMs: 0,
    exitAfterRequestCount: null,
    ...overrides,
  };
}

const FAKE_CODEX_SCRIPT = `
const readline = require("node:readline");
const fs = require("node:fs");

// 設定ファイルのパスはCLI引数で受け取る（env経由にしないのは、本番のCodexAppServerが
// 子プロセスへ渡す環境変数を許可リスト化しており、テスト専用の変数が渡らないため）。
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

let requestCount = 0;
const threads = new Map(); // threadId -> { turns: [{id, status, items}] }

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function randomId() {
  return "id-" + Math.random().toString(36).slice(2) + "-" + Date.now();
}

function turnErrorInfoFor(behavior) {
  if (behavior === "usage_limit") return "usageLimitExceeded";
  if (behavior === "unauthorized_turn_error") return "unauthorized";
  if (behavior === "server_error") return "internalServerError";
  return null;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  requestCount += 1;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    setTimeout(() => {
      respond(id, { userAgent: "fake-codex/0.0.0", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" });
    }, config.initializeDelayMs || 0);
  } else if (method === "getAuthStatus") {
    respond(id, { authMethod: config.authMethod, authToken: null, requiresOpenaiAuth: true });
  } else if (method === "thread/start") {
    const threadId = randomId();
    threads.set(threadId, { turns: [] });
    respond(id, { thread: { id: threadId } });
  } else if (method === "thread/delete") {
    threads.delete(params.threadId);
    respond(id, {});
  } else if (method === "thread/read") {
    const thread = threads.get(params.threadId);
    respond(id, { thread: { turns: thread ? thread.turns : [] } });
  } else if (method === "turn/interrupt") {
    respond(id, {});
  } else if (method === "__test_never_respond__") {
    // 意図的に何も返さない（個別リクエストのタイムアウト検証用）。
  } else if (method === "turn/start") {
    const threadId = params.threadId;
    const thread = threads.get(threadId);
    const turnId = randomId();
    const turnIndex = thread ? thread.turns.length : 0;
    const behavior = turnIndex === 0 ? config.firstTurnBehavior : config.secondTurnBehavior;

    respond(id, { turn: { id: turnId } });

    if (behavior === "hang") {
      // turn/completedを送らない（タイムアウト検証用）。
      return;
    }

    const errorInfo = turnErrorInfoFor(behavior);
    if (errorInfo) {
      if (thread) thread.turns.push({ id: turnId, status: "failed", items: [] });
      notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", error: { message: "fake failure", codexErrorInfo: errorInfo } } });
      return;
    }

    let text;
    if (behavior === "invalid_json") {
      text = "これはJSONではありません。";
    } else if (behavior === "invalid_enum") {
      text = JSON.stringify({ ...JSON.parse(config.analysisJson), result: "不正な値" });
    } else {
      text = config.analysisJson;
    }

    if (thread) {
      thread.turns.push({ id: turnId, status: "completed", items: [{ type: "userMessage", id: randomId() }, { type: "agentMessage", id: randomId(), text }] });
    }
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } });
  } else {
    respondError(id, -32601, "method not found");
  }

  if (config.exitAfterRequestCount && requestCount >= config.exitAfterRequestCount) {
    process.exit(1);
  }
});
`;

export interface FakeCodexBinary {
  scriptPath: string;
  configPath: string;
  /** CodexAppServerのcodexArgsにそのまま渡す（[スクリプトパス, 設定ファイルパス]）。 */
  codexArgs: readonly string[];
  writeConfig: (config: FakeCodexConfig) => Promise<void>;
}

export async function createFakeCodexBinary(baseDir: string, initial: Partial<FakeCodexConfig> = {}): Promise<FakeCodexBinary> {
  const scriptPath = path.join(baseDir, "fake-codex-app-server.cjs");
  const configPath = path.join(baseDir, "fake-codex-config.json");
  await fs.writeFile(scriptPath, FAKE_CODEX_SCRIPT, "utf8");
  await fs.chmod(scriptPath, 0o755);
  const writeConfig = async (config: FakeCodexConfig) => {
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  };
  await writeConfig(defaultFakeCodexConfig(initial));
  return { scriptPath, configPath, codexArgs: [scriptPath, configPath], writeConfig };
}
