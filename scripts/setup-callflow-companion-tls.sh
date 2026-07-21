#!/bin/bash
# CallFlow Companion用のローカルTLS証明書をmkcertで発行する。
# 証明書・秘密鍵はリポジトリの外（~/Library/Application Support/CallFlow Companion/certificates）に
# 保存し、リポジトリ内には一切作成しない。秘密鍵の中身は絶対に表示しない。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "エラー: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "エラー: Homebrewが見つかりません。先にHomebrewをインストールしてください（https://brew.sh）。" >&2
  exit 1
fi

if ! command -v mkcert >/dev/null 2>&1; then
  echo "エラー: mkcertが見つかりません。'brew install mkcert' を実行してください。" >&2
  exit 1
fi

echo "mkcertバージョン: $(mkcert -version 2>&1 || echo unknown)"

CAROOT="$(mkcert -CAROOT)"
echo "ローカルCAディレクトリ名: $(basename "$CAROOT")"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# CAROOTがリポジトリ外にあることを確認する（安全確認、内容は表示しない）。
case "$CAROOT" in
  "$REPO_ROOT"*)
    echo "エラー: mkcertのCAROOTがリポジトリ内を指しています。証明書は作成せず停止します。" >&2
    exit 1
    ;;
esac

if [ ! -f "$CAROOT/rootCA.pem" ] || [ ! -f "$CAROOT/rootCA-key.pem" ]; then
  echo "エラー: ローカルCAが見つかりません。先に 'mkcert -install' を実行してください。" >&2
  exit 1
fi

# 秘密鍵が「誰でも読める」権限になっていないかを確認する（内容は表示しない）。
KEY_PERMS="$(stat -f "%Lp" "$CAROOT/rootCA-key.pem" 2>/dev/null || echo "unknown")"
if [ "$KEY_PERMS" != "unknown" ]; then
  OTHER_READABLE=$((0$KEY_PERMS & 0004))
  if [ "$OTHER_READABLE" -ne 0 ]; then
    echo "エラー: ローカルCAの秘密鍵が他ユーザーから読み取り可能な権限になっています。証明書は作成せず停止します。" >&2
    exit 1
  fi
fi

# クラウド同期フォルダ配下ではないことの簡易確認（既知の同期フォルダ名を含まないか）。
case "$CAROOT" in
  *"Library/Mobile Documents"*|*"iCloud Drive"*|*"Dropbox"*|*"Google Drive"*|*"OneDrive"*)
    echo "エラー: ローカルCAがクラウド同期フォルダ内にあるようです。証明書は作成せず停止します。" >&2
    exit 1
    ;;
esac

echo "ローカルCAの安全確認が完了しました（秘密鍵の内容は表示していません）。"

CERT_DIR="$HOME/Library/Application Support/CallFlow Companion/certificates"
mkdir -p "$CERT_DIR"
chmod 0700 "$CERT_DIR"

CERT_FILE="$CERT_DIR/companion-cert.pem"
KEY_FILE="$CERT_DIR/companion-key.pem"

# 証明書のSAN確認は、macOS標準のLibreSSLが対応していない「-ext」オプションに依存せず、
# LibreSSL・OpenSSLどちらにも存在する「-text」出力をgrepする方式で行う。
read_san() {
  openssl x509 -in "$1" -noout -text 2>/dev/null | grep -A1 "Subject Alternative Name" || true
}

# 既に必要なSANを含む有効期限内の証明書があれば、不要な再発行はしない。
CERT_IS_CURRENT=false
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  if openssl x509 -in "$CERT_FILE" -noout -checkend 0 >/dev/null 2>&1; then
    SAN_TEXT="$(read_san "$CERT_FILE")"
    if echo "$SAN_TEXT" | grep -q "callflow-companion.localhost" \
      && echo "$SAN_TEXT" | grep -q "DNS:localhost" \
      && echo "$SAN_TEXT" | grep -q "127.0.0.1"; then
      CERT_IS_CURRENT=true
    fi
  fi
fi

if [ "$CERT_IS_CURRENT" = true ]; then
  echo "既存の証明書は有効期限内で、必要なSANを含んでいるため再発行しません。"
else
  # 既存証明書のバックアップ
  if [ -f "$CERT_FILE" ] || [ -f "$KEY_FILE" ]; then
    BACKUP_DIR="$CERT_DIR/backup-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    [ -f "$CERT_FILE" ] && cp "$CERT_FILE" "$BACKUP_DIR/"
    [ -f "$KEY_FILE" ] && cp "$KEY_FILE" "$BACKUP_DIR/"
    echo "既存証明書を $(basename "$BACKUP_DIR")/ へバックアップしました。"
  fi

  echo "証明書を発行します（callflow-companion.localhost, localhost, 127.0.0.1, ::1）..."
  mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" \
    callflow-companion.localhost localhost 127.0.0.1 ::1

  chmod 0600 "$KEY_FILE"
  chmod 0644 "$CERT_FILE"
fi

echo ""
echo "=== 証明書の状態 ==="
echo "証明書ディレクトリ: $(basename "$CERT_DIR")/"
echo "証明書ファイル名: $(basename "$CERT_FILE")（権限: $(stat -f "%Lp" "$CERT_FILE")）"
echo "秘密鍵ファイル名: $(basename "$KEY_FILE")（権限: $(stat -f "%Lp" "$KEY_FILE")）"
echo ""
echo "--- 証明書の有効期限・SAN（秘密鍵の内容は表示しません） ---"
openssl x509 -in "$CERT_FILE" -noout -dates
read_san "$CERT_FILE"

echo ""
echo "セットアップが完了しました。"
echo "Companionを起動するには: npm run companion:start"
