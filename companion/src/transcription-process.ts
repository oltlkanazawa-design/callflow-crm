// ffmpeg変換・whisper-cli実行のプロセス制御。
// node:child_process.spawn を argv 配列で呼び出す（shell:trueは使用しない、evalは使用しない）。
// 各プロセスは独立したプロセスグループ（detached:true）で起動し、タイムアウト・キャンセル時は
// 子プロセスグループ全体（負のPID）へシグナルを送ることで孫プロセスの孤児化を防ぐ。

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { TranscriptionConfig } from "./transcription-config.ts";

export interface RunResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface RunHandle {
  result: Promise<RunResult>;
  cancel: () => void;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 既に終了している場合は無視する。
  }
}

function runCommand(cmd: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number): RunHandle {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });

  let timedOut = false;
  let cancelled = false;
  let stderrBytes = 0;
  const stderrChunks: Buffer[] = [];

  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killProcessGroup(child.pid, "SIGTERM");
  }, timeoutMs);

  child.stdout?.on("data", () => {
    // 標準出力は使用しない（whisper-cliは-npで抑制、ffmpegは-loglevel errorで抑制済み）。破棄する。
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes < maxOutputBytes) {
      const remaining = maxOutputBytes - stderrBytes;
      const slice = chunk.subarray(0, remaining);
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    }
  });

  const result = new Promise<RunResult>((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stderrTail = Buffer.concat(stderrChunks).toString("utf8").slice(-4000);
      resolve({
        ok: code === 0 && !timedOut && !cancelled,
        code,
        signal,
        stderrTail,
        timedOut,
        cancelled,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, stderrTail: "プロセスの起動に失敗しました。", timedOut, cancelled });
    });
  });

  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    if (child.pid) {
      killProcessGroup(child.pid, "SIGTERM");
      // SIGTERMで反応しない場合の保険（3秒後にSIGKILL）。あくまで安全網でしかないため、
      // これ自体がイベントループを引き止めないようにunref()する
      // （生きている子プロセス自体は引き続きイベントループを保持するので、ここをunrefしても
      //  「キャンセルしたのにプロセスが残っているうちにNodeが終了してしまう」ことにはならない）。
      const killTimer = setTimeout(() => {
        if (child.pid) killProcessGroup(child.pid, "SIGKILL");
      }, 3000);
      killTimer.unref();
    }
  };

  return { result, cancel };
}

export function runFfmpegConvert(config: TranscriptionConfig, inputPath: string, outputWavPath: string): RunHandle {
  const args = ["-y", "-loglevel", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", outputWavPath];
  return runCommand(config.ffmpegPath, args, config.ffmpegTimeoutMs, config.maxProcessOutputBytes);
}

export function runWhisperTranscribe(
  config: TranscriptionConfig,
  modelPath: string,
  wavPath: string,
  outputBaseNoExt: string,
  timeoutMs: number,
): RunHandle {
  const args = ["-m", modelPath, "-f", wavPath, "-l", "ja", "-oj", "-of", outputBaseNoExt, "-np", "-nt"];
  return runCommand(config.whisperCliPath, args, timeoutMs, config.maxProcessOutputBytes);
}

const WAV_HEADER_BYTES = 44;
const BYTES_PER_MS_16K_MONO_16BIT = 32; // 16000 samples/sec * 2 bytes/sample / 1000 ms

/** 16kHz/mono/16bit PCM WAVのファイルサイズから、おおよその音声長（ミリ秒）を算出する。 */
export async function estimateWavDurationMs(wavPath: string): Promise<number> {
  const stat = await fs.stat(wavPath);
  const dataBytes = Math.max(0, stat.size - WAV_HEADER_BYTES);
  return Math.floor(dataBytes / BYTES_PER_MS_16K_MONO_16BIT);
}

interface WhisperJsonSegment {
  text: string;
}
interface WhisperJsonOutput {
  model?: { type?: string };
  transcription?: WhisperJsonSegment[];
}

export interface WhisperResult {
  text: string;
  modelType: string;
}

/** whisper-cliが出力したJSON結果を読み取り、文字起こし全文を結合して返す。読み取り後の削除は呼び出し側の責務。 */
export async function readWhisperJsonResult(jsonPath: string): Promise<WhisperResult> {
  const raw = await fs.readFile(jsonPath, "utf8");
  const data = JSON.parse(raw) as WhisperJsonOutput;
  const text = (data.transcription ?? []).map((seg) => seg.text).join("").trim();
  const modelType = data.model?.type ?? "unknown";
  return { text, modelType };
}
