// テスト専用ヘルパー: ffmpeg/whisper-cliの偽実行ファイル（bash）を生成する。
// 実際のffmpeg/whisper-cliバイナリは一切使用しない。*.test.tsではないためテストランナーには収集されない。
// 偽スクリプトの挙動は環境変数 CALLFLOW_FAKE_CONTROL_DIR 配下の制御ファイルで切り替える
// （node:child_process.spawnはデフォルトでprocess.envを子プロセスに継承するため、
//   呼び出し側が同期的に環境変数をセットしてから呼び出す前提）。

import fs from "node:fs/promises";
import path from "node:path";

const FAKE_FFMPEG_SCRIPT = `#!/bin/bash
set -u
CONTROL_DIR="\${CALLFLOW_FAKE_CONTROL_DIR:-}"
MODE="success"
if [ -n "$CONTROL_DIR" ] && [ -f "$CONTROL_DIR/ffmpeg-mode" ]; then
  MODE=$(cat "$CONTROL_DIR/ffmpeg-mode")
fi
OUTPUT="\${@: -1}"
if [ "$MODE" = "fail" ]; then
  echo "fake ffmpeg: simulated failure" >&2
  exit 1
fi
if [ "$MODE" = "hang" ]; then
  sleep 300
  exit 0
fi
SIZE=44
if [ -n "$CONTROL_DIR" ] && [ -f "$CONTROL_DIR/ffmpeg-output-bytes" ]; then
  SIZE=$(cat "$CONTROL_DIR/ffmpeg-output-bytes")
fi
head -c "$SIZE" /dev/zero > "$OUTPUT" 2>/dev/null
exit 0
`;

const FAKE_WHISPER_SCRIPT = `#!/bin/bash
set -u
CONTROL_DIR="\${CALLFLOW_FAKE_CONTROL_DIR:-}"
MODE="success"
if [ -n "$CONTROL_DIR" ] && [ -f "$CONTROL_DIR/whisper-mode" ]; then
  MODE=$(cat "$CONTROL_DIR/whisper-mode")
fi
OUTBASE=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-of" ]; then
    OUTBASE="$2"
  fi
  shift
done
if [ "$MODE" = "fail" ]; then
  echo "fake whisper-cli: simulated failure" >&2
  exit 1
fi
if [ "$MODE" = "hang" ]; then
  sleep 300
  exit 0
fi
TEXT="テストです。"
if [ -n "$CONTROL_DIR" ] && [ -f "$CONTROL_DIR/whisper-text" ]; then
  TEXT=$(cat "$CONTROL_DIR/whisper-text")
fi
MODELTYPE="small"
if [ -n "$CONTROL_DIR" ] && [ -f "$CONTROL_DIR/whisper-model-type" ]; then
  MODELTYPE=$(cat "$CONTROL_DIR/whisper-model-type")
fi
printf '{"model":{"type":"%s"},"transcription":[{"text":"%s"}]}' "$MODELTYPE" "$TEXT" > "\${OUTBASE}.json"
exit 0
`;

export interface FakeTranscriptionBinaries {
  ffmpegPath: string;
  whisperCliPath: string;
  controlDir: string;
}

/** 指定ディレクトリ配下に偽ffmpeg/偽whisper-cli（bash）と制御用ディレクトリを作成する。 */
export async function createFakeTranscriptionBinaries(baseDir: string): Promise<FakeTranscriptionBinaries> {
  const controlDir = path.join(baseDir, "control");
  await fs.mkdir(controlDir, { recursive: true });
  const ffmpegPath = path.join(baseDir, "fake-ffmpeg.sh");
  const whisperCliPath = path.join(baseDir, "fake-whisper-cli.sh");
  await fs.writeFile(ffmpegPath, FAKE_FFMPEG_SCRIPT, "utf8");
  await fs.writeFile(whisperCliPath, FAKE_WHISPER_SCRIPT, "utf8");
  await fs.chmod(ffmpegPath, 0o755);
  await fs.chmod(whisperCliPath, 0o755);
  return { ffmpegPath, whisperCliPath, controlDir };
}

export async function setControlValue(controlDir: string, name: string, value: string): Promise<void> {
  await fs.writeFile(path.join(controlDir, name), value, "utf8");
}

export async function setFfmpegMode(controlDir: string, mode: "success" | "fail" | "hang"): Promise<void> {
  await setControlValue(controlDir, "ffmpeg-mode", mode);
}

export async function setFfmpegOutputBytes(controlDir: string, bytes: number): Promise<void> {
  await setControlValue(controlDir, "ffmpeg-output-bytes", String(bytes));
}

export async function setWhisperMode(controlDir: string, mode: "success" | "fail" | "hang"): Promise<void> {
  await setControlValue(controlDir, "whisper-mode", mode);
}

export async function setWhisperText(controlDir: string, text: string): Promise<void> {
  await setControlValue(controlDir, "whisper-text", text);
}

export async function setWhisperModelType(controlDir: string, modelType: string): Promise<void> {
  await setControlValue(controlDir, "whisper-model-type", modelType);
}
