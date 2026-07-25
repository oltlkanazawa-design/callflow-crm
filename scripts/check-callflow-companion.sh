#!/bin/bash
# CallFlow Companion（HTTPSモード）の起動状態を確認する。秘密情報は一切表示しない。
# Codex CLIの絶対パス・バージョンは、ローカルの管理者向け確認コマンドとしてここでのみ表示する
# （ブラウザ・Vercelなど外部へは一切送信しない）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./resolve-callflow-codex-binary-path.sh
. "$SCRIPT_DIR/resolve-callflow-codex-binary-path.sh"

APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
PID_FILE="$APP_SUPPORT_DIR/companion.pid"
CERT_FILE="$APP_SUPPORT_DIR/certificates/companion-cert.pem"
PORT=4318

echo "=== CallFlow Companion 状態確認（HTTPS） ==="

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

if [ -f "$CERT_FILE" ]; then
  echo "証明書: 存在します（有効期限は以下）"
  openssl x509 -in "$CERT_FILE" -noout -dates 2>/dev/null || echo "証明書の読み取りに失敗しました"
else
  echo "証明書: 見つかりません（npm run companion:setup-tls を実行してください）"
fi

echo ""
echo "--- Codex CLI（営業内容解析に使用） ---"
RESOLVED_CODEX_BIN="$(resolve_callflow_codex_binary_path || true)"
if [ -n "$RESOLVED_CODEX_BIN" ]; then
  CODEX_VERSION="$("$RESOLVED_CODEX_BIN" --version 2>/dev/null || echo "取得できませんでした")"
  echo "検出済み: $RESOLVED_CODEX_BIN（バージョン: $CODEX_VERSION）"
else
  echo "見つかりません（Codexによる営業内容解析は利用できません。録音・文字起こしは利用できます）"
fi

echo ""
echo "--- health check (https://127.0.0.1:$PORT/v1/health) ---"

RESPONSE="$(curl -s -m 3 --cacert "$CERT_FILE" "https://127.0.0.1:$PORT/v1/health" 2>&1)"
if [ -z "$RESPONSE" ]; then
  echo "接続できませんでした。Companionが起動しているか確認してください。"
  echo "起動するには: npm run companion:start"
  exit 1
fi

echo "$RESPONSE"

if [[ "$RESPONSE" == *'"secure":true'* ]]; then
  echo ""
  echo "モード: HTTPS（証明書は信頼できるものとして応答しています）"
elif [[ "$RESPONSE" == *'"secure":false'* ]]; then
  echo ""
  echo "警告: HTTPモードで応答しています（開発用スクリプトが起動している可能性があります）。"
fi
