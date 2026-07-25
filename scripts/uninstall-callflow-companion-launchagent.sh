#!/bin/bash
# CallFlow CompanionのLaunchAgent登録を取り消す（プロセスの停止＋plist削除）。
# 証明書・保存済みペアリング情報（信頼済み端末のトークンハッシュ）・一時ファイルには
# 一切触れない。既存のnpm run companion:start/stop/checkにも影響しない。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "エラー: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

LABEL="com.callflow.companion"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
PID_FILE="$APP_SUPPORT_DIR/companion-launchagent.pid"

if [ ! -f "$PLIST_PATH" ]; then
  echo "LaunchAgentは登録されていません（$PLIST_PATH が見つかりません）。"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
rm -f "$PID_FILE"

echo "LaunchAgentの登録を取り消しました。"
echo "（証明書・保存済みペアリング情報・一時ファイルは削除していません。）"
