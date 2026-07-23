#!/bin/bash
# ffmpeg・whisper-cli・Whisperモデルの状態を確認する。秘密情報・モデル本文は表示しない。
set -uo pipefail

echo "=== CallFlow 文字起こしエンジン 状態確認 ==="

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg: $(command -v ffmpeg)"
  ffmpeg -version 2>/dev/null | head -1
else
  echo "ffmpeg: 見つかりません（npm run transcription:setup を実行してください）"
fi

echo ""

if command -v whisper-cli >/dev/null 2>&1; then
  echo "whisper-cli: $(command -v whisper-cli)"
  whisper-cli --version 2>&1 | grep -i "whisper.cpp version" || true
else
  echo "whisper-cli: 見つかりません（npm run transcription:setup を実行してください）"
fi

echo ""
echo "--- モデル ---"
MODEL_DIR="$HOME/Library/Application Support/CallFlow Companion/models"
if [ -d "$MODEL_DIR" ]; then
  for name in base small; do
    f="$MODEL_DIR/ggml-${name}.bin"
    if [ -f "$f" ]; then
      SIZE="$(stat -f "%z" "$f" 2>/dev/null || echo unknown)"
      PERMS="$(stat -f "%Lp" "$f" 2>/dev/null || echo unknown)"
      echo "ggml-${name}.bin: 存在します（サイズ: ${SIZE} bytes, 権限: ${PERMS}）"
    else
      echo "ggml-${name}.bin: 見つかりません"
    fi
  done
else
  echo "モデルディレクトリが見つかりません（npm run transcription:setup を実行してください）"
fi
