#!/bin/bash
# CallFlow CompanionのLaunchAgent登録・起動状態を確認する。秘密情報は一切表示しない。
set -uo pipefail

LABEL="com.callflow.companion"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
CERT_FILE="$APP_SUPPORT_DIR/certificates/companion-cert.pem"
PORT=4318

echo "=== CallFlow Companion LaunchAgent 状態確認 ==="

if [ ! -f "$PLIST_PATH" ]; then
  echo "未登録です（$PLIST_PATH が見つかりません）。"
  echo "登録するには: npm run companion:launchagent:install"
  exit 1
fi

echo "登録済み: $PLIST_PATH"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "launchd上のジョブ状態: 読み込み済み"
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state = |pid = " || true
else
  echo "launchd上のジョブ状態: 読み込まれていません"
fi

echo ""
echo "--- health check (https://127.0.0.1:$PORT/v1/health) ---"

RESPONSE="$(curl -s -m 3 --cacert "$CERT_FILE" "https://127.0.0.1:$PORT/v1/health" 2>&1)"
if [ -z "$RESPONSE" ]; then
  echo "接続できませんでした（起動していないか、証明書が未セットアップの可能性があります）。"
  exit 1
fi

echo "$RESPONSE"
