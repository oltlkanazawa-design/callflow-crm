#!/bin/bash
# CallFlow Companion（開発用HTTPモード）の起動状態を確認する。
# 秘密情報（トークン等）は一切表示しない。
set -uo pipefail

APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
PID_FILE="$APP_SUPPORT_DIR/companion-dev.pid"
PORT=4318

echo "=== CallFlow Companion 状態確認 ==="

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "PID: $PID（起動中）"
  else
    echo "PID: $PID（記録されていますが、プロセスは存在しません）"
  fi
else
  echo "PIDファイルが見つかりません（起動していない可能性があります）。"
fi

echo "ポート: $PORT"
echo ""
echo "--- health check (http://127.0.0.1:$PORT/v1/health) ---"

RESPONSE="$(curl -s -m 3 "http://127.0.0.1:$PORT/v1/health")"
if [ -z "$RESPONSE" ]; then
  echo "接続できませんでした。Companionが起動しているか確認してください。"
  echo "起動するには: npm run companion:start:dev"
  exit 1
fi

echo "$RESPONSE"

if [[ "$RESPONSE" == *'"secure":false'* ]]; then
  echo ""
  echo "モード: HTTP（開発用・安全でない接続）"
fi
