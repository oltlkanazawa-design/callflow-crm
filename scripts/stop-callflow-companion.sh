#!/bin/bash
# CallFlow Companion（HTTPSモード）を安全に停止する。
# 対象PIDが本当にCallFlow Companionのプロセスであることを確認してから停止する。
# killall/pkillは使用しない。
set -euo pipefail

APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
PID_FILE="$APP_SUPPORT_DIR/companion.pid"
TMP_DIR="$APP_SUPPORT_DIR/tmp"

if [ ! -f "$PID_FILE" ]; then
  echo "CallFlow Companionは起動していません（PIDファイルが見つかりません）。"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "CallFlow Companionは起動していません（プロセスが存在しません）。"
  rm -f "$PID_FILE"
  exit 0
fi

PROCESS_COMMAND="$(ps -p "$PID" -o command= 2>/dev/null || true)"
if [[ "$PROCESS_COMMAND" != *"companion/src/server.ts"* ]]; then
  echo "エラー: PID $PID はCallFlow Companionのプロセスではないようです。安全のため停止しません。" >&2
  echo "確認したコマンド: $PROCESS_COMMAND" >&2
  exit 1
fi

echo "CallFlow Companion（PID: $PID）を停止します..."
kill -TERM "$PID"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if kill -0 "$PID" 2>/dev/null; then
  echo "警告: プロセスが終了しませんでした。手動で確認してください（PID: $PID）。" >&2
else
  echo "停止しました。"
fi

rm -f "$PID_FILE"

if [ -d "$TMP_DIR" ]; then
  find "$TMP_DIR" -type f -delete 2>/dev/null || true
fi
