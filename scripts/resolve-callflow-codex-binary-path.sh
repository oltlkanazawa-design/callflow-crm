#!/bin/bash
# Codex CLIの絶対パスを安全に解決する共有ヘルパー。
# start-callflow-companion.sh・install-callflow-companion-launchagent.sh・
# check-callflow-companion*.shから source（. "$SCRIPT_DIR/resolve-callflow-codex-binary-path.sh"）
# して使う。特定ユーザー固有のパスは一切ハードコードしない。
#
# 解決順序：
#   1. CALLFLOW_CODEX_BINARY_PATHが既に有効な値として設定されていればそれを使う
#   2. command -v codex（PATH解決）
#   3. $HOME/.local/bin/codex
#   4. /opt/homebrew/bin/codex（Apple Silicon Homebrew）
#   5. /usr/local/bin/codex（Intel Homebrew等）
#
# このファイル自体は直接実行しない（sourceして関数を使うだけ）。

# 候補パスが「（symlinkなら辿った先も含めて）実行可能な通常ファイル」であることを検証する。
# 空文字・存在しないパス・ディレクトリ・実行不可なファイルはすべて拒否する。
# [ -f ]・[ -x ] はどちらもsymlinkを自動的に辿って判定するため、追加のreadlink処理は不要
# （macOS標準のreadlinkは-fオプションを持たないため、GNU coreutils依存を避ける意味もある）。
is_valid_callflow_codex_binary() {
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  [ -f "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  return 0
}

# 解決できた場合は絶対パスを標準出力へ1行だけ出力しexit 0。
# 見つからない場合は何も出力せずexit 1（呼び出し側は `|| true` 等で受け止めること）。
resolve_callflow_codex_binary_path() {
  if [ -n "${CALLFLOW_CODEX_BINARY_PATH:-}" ] && is_valid_callflow_codex_binary "$CALLFLOW_CODEX_BINARY_PATH"; then
    echo "$CALLFLOW_CODEX_BINARY_PATH"
    return 0
  fi

  local via_path
  via_path="$(command -v codex 2>/dev/null || true)"
  if [ -n "$via_path" ] && is_valid_callflow_codex_binary "$via_path"; then
    echo "$via_path"
    return 0
  fi

  local candidate
  for candidate in "$HOME/.local/bin/codex" "/opt/homebrew/bin/codex" "/usr/local/bin/codex"; do
    if is_valid_callflow_codex_binary "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}
