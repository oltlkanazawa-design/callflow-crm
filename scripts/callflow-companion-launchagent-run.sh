#!/bin/bash
# launchd（macOSログイン時自動起動）専用のCompanion起動スクリプト。
# scripts/start-callflow-companion.sh とは異なり、自分自身をバックグラウンド化しない
# （nohup ... &は使わない）。launchdはフォアグラウンドで動く子プロセスを直接execして
# superviseする必要があるため、execでnode自身にプロセスを置き換える。
# 環境変数はscripts/start-callflow-companion.sh（HTTPS・本番相当モード）と同じものを使う。
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
TMP_DIR="$APP_SUPPORT_DIR/tmp"
PID_FILE="$APP_SUPPORT_DIR/companion-launchagent.pid"

mkdir -p "$APP_SUPPORT_DIR"

# execする前の$$は、exec後もそのままCompanionプロセスのPIDとして有効
# （execはプロセスイメージを置き換えるだけでPIDは変わらないため）。
echo "$$" > "$PID_FILE"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "エラー: TLS証明書が見つかりません（$(basename "$CERT_DIR")/ 配下）。先に次を実行してください: npm run companion:setup-tls" >&2
  exit 1
fi

cd "$REPO_ROOT"

export CALLFLOW_COMPANION_TLS_CERT_PATH="$CERT_FILE"
export CALLFLOW_COMPANION_TLS_KEY_PATH="$KEY_FILE"
export CALLFLOW_COMPANION_PORT=4318
export CALLFLOW_COMPANION_TMP_DIR="$TMP_DIR"

# launchdのEnvironmentVariablesで渡されるnodeの絶対パス（PATHが最小限のため）。
# 通常のシェルから直接この起動スクリプトを試す場合はPATH上のnodeにフォールバックする。
NODE_BIN="${CALLFLOW_COMPANION_NODE_BIN:-node}"

exec "$NODE_BIN" companion/src/server.ts
