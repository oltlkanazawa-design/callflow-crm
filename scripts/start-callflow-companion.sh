#!/bin/bash
# CallFlow CompanionをHTTPSモード（既定）で起動する。127.0.0.1:4318のみにbindする。
# gitやブランチの状態には一切触れない。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "エラー: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
CERT_DIR="$APP_SUPPORT_DIR/certificates"
CERT_FILE="$CERT_DIR/companion-cert.pem"
KEY_FILE="$CERT_DIR/companion-key.pem"
PID_FILE="$APP_SUPPORT_DIR/companion.pid"
LOG_FILE="$APP_SUPPORT_DIR/companion.log"
TMP_DIR="$APP_SUPPORT_DIR/tmp"

mkdir -p "$APP_SUPPORT_DIR"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "エラー: TLS証明書が見つかりません（$(basename "$CERT_DIR")/ 配下）。" >&2
  echo "先に次を実行してください: npm run companion:setup-tls" >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "既にCallFlow Companionが起動中です（PID: $EXISTING_PID）。"
    echo "停止するには: npm run companion:stop"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

echo "CallFlow CompanionをHTTPSモードで起動します（127.0.0.1:4318のみ）..."

cd "$REPO_ROOT"
CALLFLOW_COMPANION_TLS_CERT_PATH="$CERT_FILE" \
CALLFLOW_COMPANION_TLS_KEY_PATH="$KEY_FILE" \
CALLFLOW_COMPANION_PORT=4318 \
CALLFLOW_COMPANION_TMP_DIR="$TMP_DIR" \
nohup node companion/src/server.ts > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1

if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "エラー: Companionの起動に失敗しました。ログを確認してください: $(basename "$LOG_FILE")" >&2
  rm -f "$PID_FILE"
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

echo ""
cat "$LOG_FILE"
echo ""
echo "PID: $NEW_PID"
echo "停止するには: npm run companion:stop"
echo "状態を確認するには: npm run companion:check"
