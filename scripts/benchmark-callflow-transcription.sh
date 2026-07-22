#!/bin/bash
# base/smallモデルを直列（並列禁止）で比較する。合成音声（macOS `say`）のみを使用し、
# 実際の営業電話・第三者音声は使用しない。一時ファイルはmktempで作成しtrapで削除する。
set -euo pipefail
set -m  # ジョブ制御を有効化する。バックグラウンドジョブごとに独立したプロセスグループが
        # 作られるため、タイムアウト時に負のPID（プロセスグループ全体）へシグナルを送ることで、
        # `/usr/bin/time`配下の孫プロセス（whisper-cli本体）まで確実に終了できる。

if [ "$(uname -s)" != "Darwin" ]; then
  echo "エラー: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

for bin in ffmpeg whisper-cli say shasum; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "エラー: $bin が見つかりません。先に npm run transcription:setup を実行してください。" >&2
    exit 1
  fi
done

MODEL_DIR="$HOME/Library/Application Support/CallFlow Companion/models"
for name in base small; do
  if [ ! -f "$MODEL_DIR/ggml-${name}.bin" ]; then
    echo "エラー: ggml-${name}.bin が見つかりません。先に npm run transcription:setup を実行してください。" >&2
    exit 1
  fi
done

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# macOSには`timeout`コマンドが標準で無いため、bashのジョブ制御だけで簡易タイムアウトを実装する。
# 監視用のサブシェルが期限切れで対象プロセスをTERMし、対象プロセス側の終了コードをそのまま返す。
run_with_timeout() {
  local timeout_sec="$1"
  shift
  "$@" &
  local target_pid=$!
  (
    sleep "$timeout_sec"
    kill -TERM -- "-$target_pid" 2>/dev/null || true
  ) &
  local watcher_pid=$!
  local status=0
  wait "$target_pid" 2>/dev/null || status=$?
  # 対象・監視用いずれも、プロセスグループ全体（負のPID）へシグナルを送ることで、
  # `/usr/bin/time`の子プロセスや監視サブシェルの`sleep`が孤児として残らないようにする。
  kill -TERM -- "-$target_pid" 2>/dev/null || true
  kill -TERM -- "-$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
  return "$status"
}

TEXT="これはCallFlowの文字起こしテストです。採用担当の田中です。現在は新卒の応募が少ないことが課題です。資料をメールで送ってください。来週の火曜日にもう一度連絡をお願いします。"

echo "合成音声（macOS say, Kyoko）を生成します..."
if ! run_with_timeout 60 say -v Kyoko "$TEXT" -o "$WORKDIR/synthetic.aiff"; then
  echo "エラー: 音声合成がタイムアウトまたは失敗しました。" >&2
  exit 1
fi

echo "ffmpegで16kHz/mono/PCM16へ変換します..."
if ! run_with_timeout 60 ffmpeg -y -loglevel error -i "$WORKDIR/synthetic.aiff" -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav "$WORKDIR/synthetic.wav"; then
  echo "エラー: ffmpeg変換がタイムアウトまたは失敗しました。" >&2
  exit 1
fi

run_model_benchmark() {
  local model_name="$1"
  local model_file="$2"

  echo ""
  echo "=== ${model_name} モデル ==="
  local status=0
  run_with_timeout 300 /usr/bin/time -l whisper-cli -m "$model_file" -f "$WORKDIR/synthetic.wav" -l ja -oj -of "$WORKDIR/result-${model_name}" -np -nt 2> "$WORKDIR/${model_name}.stderr" || status=$?

  if [ "$status" -ne 0 ] || [ ! -f "$WORKDIR/result-${model_name}.json" ]; then
    echo "エラー: ${model_name}モデルの文字起こしに失敗しました（終了コード: ${status}）。" >&2
    echo "--- whisper-cliのエラー出力 ---" >&2
    tail -20 "$WORKDIR/${model_name}.stderr" >&2 || true
    return 0
  fi

  echo "--- 文字起こし結果 ---"
  python3 - "$WORKDIR/result-${model_name}.json" <<'PY' 2>/dev/null || echo "(JSON解析に失敗しました)"
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(''.join(seg['text'] for seg in data['transcription']))
PY
  echo "--- 処理時間・メモリ ---"
  grep -E "real|maximum resident set size|peak memory footprint" "$WORKDIR/${model_name}.stderr" || true
}

run_model_benchmark "base" "$MODEL_DIR/ggml-base.bin"
run_model_benchmark "small" "$MODEL_DIR/ggml-small.bin"

echo ""
echo "ベンチマーク完了。一時ファイルは自動的に削除されます（$WORKDIR）。"
echo "詳細な採用理由は docs/callflow-transcription-phase3a.md を参照してください。"
