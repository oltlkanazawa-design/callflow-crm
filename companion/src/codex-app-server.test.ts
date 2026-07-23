// CodexAppServer（codex app-server子プロセス管理）の単体テスト。
// 実際のcodex CLI・ChatGPTアカウントは一切使用せず、analysis-test-support.tsの
// 偽app-server（Node製JSONL）を使う。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { CodexAppServer } from "./codex-app-server.ts";
import { createFakeCodexBinary } from "./analysis-test-support.ts";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-codex-app-server-test-"));
}

test("initialize→getAuthStatus: 正常に起動しログイン状態を取得できる", async () => {
  const baseDir = await makeTmpDir();
  const { codexArgs } = await createFakeCodexBinary(baseDir);
  const codex = new CodexAppServer({
    codexBinaryPath: process.execPath,
    codexArgs,
    workDir: baseDir,
    startupTimeoutMs: 5000,
    shutdownGraceMs: 200,
  });
  try {
    const auth = (await codex.request("getAuthStatus", { includeToken: false, refreshToken: false })) as { authMethod: string | null };
    assert.equal(auth.authMethod, "chatgpt");
    assert.equal(codex.currentState, "ready");
  } finally {
    await codex.stop();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("getAuthStatus: includeToken:falseの場合、authTokenは常にnullで返る（トークン非露出の確認）", async () => {
  const baseDir = await makeTmpDir();
  const { codexArgs } = await createFakeCodexBinary(baseDir);
  const codex = new CodexAppServer({ codexBinaryPath: process.execPath, codexArgs, workDir: baseDir, startupTimeoutMs: 5000, shutdownGraceMs: 200 });
  try {
    const auth = (await codex.request("getAuthStatus", { includeToken: false, refreshToken: false })) as { authToken: string | null };
    assert.equal(auth.authToken, null);
  } finally {
    await codex.stop();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("起動タイムアウト: initializeの応答が遅い場合は起動失敗として扱われる", async () => {
  const baseDir = await makeTmpDir();
  const { codexArgs } = await createFakeCodexBinary(baseDir, { initializeDelayMs: 3000 });
  const codex = new CodexAppServer({
    codexBinaryPath: process.execPath,
    codexArgs,
    workDir: baseDir,
    startupTimeoutMs: 300,
    shutdownGraceMs: 200,
  });
  try {
    await assert.rejects(() => codex.request("getAuthStatus", {}));
    assert.equal(codex.currentState, "crashed");
  } finally {
    await codex.stop();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("存在しないバイナリを指定した場合、1回だけ再起動を試みて以後はcodex_unavailableになる（無限再起動しない）", async () => {
  const baseDir = await makeTmpDir();
  const codex = new CodexAppServer({
    codexBinaryPath: path.join(baseDir, "does-not-exist-binary"),
    codexArgs: [],
    workDir: baseDir,
    startupTimeoutMs: 2000,
    maxRestarts: 1,
    shutdownGraceMs: 200,
  });
  try {
    // 1回目: 起動失敗（restartCountはまだ0のまま。この呼び出し自体はensureReady()が
    // "stopped"状態から素直にstart()を試みた結果の失敗であり、再起動の消費ではない）
    await assert.rejects(() => codex.request("getAuthStatus", {}));
    assert.equal(codex.currentState, "crashed");
    // 2回目: ensureReady()が「crashed」を見て1回だけ再起動を試みる（が、これも失敗する）
    await assert.rejects(() => codex.request("getAuthStatus", {}));
    assert.equal(codex.currentState, "crashed");
    // 3回目: 再起動予算を使い切っているため、再度spawnせずcodex_unavailableで即座に拒否される
    await assert.rejects(() => codex.request("getAuthStatus", {}), /codex_unavailable/);
    assert.equal(codex.currentState, "unavailable");
  } finally {
    await codex.stop();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("stop(): 終了後は偽app-serverプロセスが残存しない", async () => {
  const baseDir = await makeTmpDir();
  const { scriptPath, codexArgs } = await createFakeCodexBinary(baseDir);
  const codex = new CodexAppServer({ codexBinaryPath: process.execPath, codexArgs, workDir: baseDir, startupTimeoutMs: 5000, shutdownGraceMs: 200 });
  try {
    await codex.request("getAuthStatus", {});
    assert.equal(codex.currentState, "ready");
  } finally {
    await codex.stop();
  }
  assert.equal(codex.currentState, "stopped");
  let remaining = "";
  try {
    remaining = execFileSync("pgrep", ["-f", scriptPath], { encoding: "utf8" });
  } catch {
    remaining = "";
  }
  assert.equal(remaining.trim(), "", "stop()後は偽app-serverプロセスが残っていてはいけない");
  await fs.rm(baseDir, { recursive: true, force: true });
});

test("リクエストタイムアウト: 応答が来ない場合は個別リクエストがタイムアウトする", async () => {
  const baseDir = await makeTmpDir();
  const { codexArgs } = await createFakeCodexBinary(baseDir);
  const codex = new CodexAppServer({
    codexBinaryPath: process.execPath,
    codexArgs,
    workDir: baseDir,
    startupTimeoutMs: 5000,
    defaultRequestTimeoutMs: 300,
    shutdownGraceMs: 200,
  });
  try {
    await codex.request("getAuthStatus", {});
    await assert.rejects(() => codex.request("__test_never_respond__", {}, 200), /codex_request_timeout/);
  } finally {
    await codex.stop();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
