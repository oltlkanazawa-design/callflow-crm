#!/bin/bash
# ffmpeg・whisper-cppの存在確認と、Whisperモデル（base/small多言語）の取得を行う。
# 不足しているものだけをインストール・取得する（冪等）。モデルはリポジトリ外へ保存する。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "エラー: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "エラー: Homebrewが見つかりません。先にHomebrewをインストールしてください（https://brew.sh）。" >&2
  exit 1
fi

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg: 既にインストール済み（$(command -v ffmpeg)）"
else
  echo "ffmpegをインストールします..."
  brew install ffmpeg
fi

if command -v whisper-cli >/dev/null 2>&1; then
  echo "whisper-cli: 既にインストール済み（$(command -v whisper-cli)）"
else
  echo "whisper-cppをインストールします..."
  brew install whisper-cpp
fi

MODEL_DIR="$HOME/Library/Application Support/CallFlow Companion/models"
mkdir -p "$MODEL_DIR"
chmod 0700 "$MODEL_DIR"

# 事前のディスク空き容量確認（base+small合計で約640MB必要。安全のため2GB以上を推奨値とする）。
AVAIL_KB="$(df -k "$MODEL_DIR" | awk 'NR==2 {print $4}')"
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 2097152 ]; then
  echo "警告: 空きディスク容量が少ない可能性があります（推奨2GB以上）。ダウンロードが失敗する場合があります。" >&2
fi

MODEL_BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# 公式HuggingFaceリポジトリ（ggerganov/whisper.cpp）のAPIで公開されているSHA-256（2026-07-22確認）。
BASE_SHA="60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
SMALL_SHA="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"

# ダウンロード中の一時ファイルは、Ctrl-C（INT/TERM）やスクリプト終了時にも確実に削除する
# （関数ローカルのRETURNトラップではなく、スクリプト全体のEXIT/INT/TERMトラップで一元管理する）。
CURRENT_TMP_FILE=""
cleanup_current_tmp() {
  if [ -n "$CURRENT_TMP_FILE" ] && [ -f "$CURRENT_TMP_FILE" ]; then
    rm -f "$CURRENT_TMP_FILE"
  fi
}
trap cleanup_current_tmp EXIT INT TERM

fetch_model() {
  local name="$1"
  local expected_sha="$2"
  local dest="$MODEL_DIR/ggml-${name}.bin"

  if [ -f "$dest" ]; then
    local actual
    actual="$(shasum -a 256 "$dest" | awk '{print $1}')"
    if [ "$actual" = "$expected_sha" ]; then
      echo "ggml-${name}.bin: 既に取得済みでSHA-256が一致するため再取得しません。"
      return 0
    else
      echo "警告: ggml-${name}.binのSHA-256が期待値と一致しません。再取得します。" >&2
    fi
  fi

  local tmp
  tmp="$(mktemp "$MODEL_DIR/ggml-${name}.bin.download-XXXXXX")"
  CURRENT_TMP_FILE="$tmp"

  echo "ggml-${name}.binをダウンロード中..."
  # --connect-timeout: 接続確立自体のタイムアウト。--speed-limit/--speed-time: 60秒間
  # 転送速度が1KB/s未満のまま停滞した場合は中断する（ハング状態で無期限に待たない）。
  if ! curl -fL --connect-timeout 30 --speed-limit 1024 --speed-time 60 --retry 3 -o "$tmp" "$MODEL_BASE_URL/ggml-${name}.bin"; then
    echo "エラー: ggml-${name}.binのダウンロードに失敗しました。" >&2
    rm -f "$tmp"
    CURRENT_TMP_FILE=""
    return 1
  fi

  local actual
  actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [ "$actual" != "$expected_sha" ]; then
    echo "エラー: ggml-${name}.binのSHA-256が一致しません（期待: $expected_sha / 実際: $actual）。ファイルを削除します。" >&2
    rm -f "$tmp"
    CURRENT_TMP_FILE=""
    return 1
  fi

  mv "$tmp" "$dest"
  chmod 0644 "$dest"
  CURRENT_TMP_FILE=""
  echo "ggml-${name}.bin: 取得・検証完了。"
}

fetch_model "base" "$BASE_SHA"
fetch_model "small" "$SMALL_SHA"

echo ""
echo "=== セットアップ完了 ==="
echo "モデルディレクトリ: $(basename "$MODEL_DIR")/"
ls -la "$MODEL_DIR" | grep -v "^total\|^d" || true
echo ""
echo "動作確認: npm run transcription:check"
echo "ベンチマーク: npm run transcription:benchmark"
