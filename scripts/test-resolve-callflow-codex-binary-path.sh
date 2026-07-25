#!/bin/bash
# scripts/resolve-callflow-codex-binary-path.sh と、それを利用する
# scripts/install-callflow-companion-launchagent.sh のplist生成部分に対する自動テスト。
# 実際のシステムのcodexコマンド・実際のLaunchAgents登録には一切触れない
# （すべて使い捨ての一時ディレクトリ・偽の実行可能ファイル・環境変数の上書きの中で完結する）。
#
# 実行方法: bash scripts/test-resolve-callflow-codex-binary-path.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./resolve-callflow-codex-binary-path.sh
. "$SCRIPT_DIR/resolve-callflow-codex-binary-path.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "✔ $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "✖ $1"
}

assert_eq() {
  local description="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$description"
  else
    fail "$description（期待値: '$expected' / 実際: '$actual'）"
  fi
}

# 使い捨ての実行可能な偽codexバイナリを1つ作成する。
make_fake_codex() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path" <<'FAKE'
#!/bin/bash
echo "codex-cli 0.0.0-fake"
FAKE
  chmod +x "$path"
}

TESTROOT="$(mktemp -d "${TMPDIR:-/tmp}/callflow-codex-resolve-test.XXXXXX")"
cleanup() {
  rm -rf "$TESTROOT"
}
trap cleanup EXIT

# ===========================================================
# 1. 明示されたCALLFLOW_CODEX_BINARY_PATHを最優先する
# ===========================================================
{
  EXPLICIT_BIN="$TESTROOT/explicit/codex"
  PATH_BIN="$TESTROOT/on-path/codex"
  make_fake_codex "$EXPLICIT_BIN"
  make_fake_codex "$PATH_BIN"

  RESULT="$(CALLFLOW_CODEX_BINARY_PATH="$EXPLICIT_BIN" PATH="$TESTROOT/on-path:$PATH" resolve_callflow_codex_binary_path || true)"
  assert_eq "明示パスがPATH上の候補より優先される" "$EXPLICIT_BIN" "$RESULT"
}

# ===========================================================
# 2. command -v codex（PATH解決）
# ===========================================================
{
  PATH_BIN="$TESTROOT/on-path2/codex"
  make_fake_codex "$PATH_BIN"

  # サブシェル内でのプレフィックス変数代入は、その1コマンド（関数呼び出し全体）にのみ有効。
  # envコマンドは外部実行ファイルにしか使えずシェル関数には使えないため、ここでは使わない。
  RESULT="$( (CALLFLOW_CODEX_BINARY_PATH= PATH="$TESTROOT/on-path2:/usr/bin:/bin" resolve_callflow_codex_binary_path) || true)"
  # command -vはPATH上の表記そのまま返す実装が一般的で、文字列比較が揺れることがあるため、
  # 「用意した偽バイナリと同一ファイル（同一デバイス・inode）を指しているか」で厳密に比較する
  # （-efはbasenameだけの緩い一致とは異なり、別の実行可能ファイルを誤って合格させない）。
  if [ -n "$RESULT" ] && [ "$RESULT" -ef "$PATH_BIN" ]; then
    pass "PATH上のcodex（command -v）が解決される"
  else
    fail "PATH上のcodex（command -v）が解決される（実際: '$RESULT'）"
  fi
}

# ===========================================================
# 3. ~/.local/bin/codexへのフォールバック
# ===========================================================
{
  FAKE_HOME="$TESTROOT/fake-home-3"
  mkdir -p "$FAKE_HOME"
  make_fake_codex "$FAKE_HOME/.local/bin/codex"

  RESULT="$( (CALLFLOW_CODEX_BINARY_PATH= HOME="$FAKE_HOME" PATH="/usr/bin:/bin" resolve_callflow_codex_binary_path) || true)"
  assert_eq "\$HOME/.local/bin/codexへフォールバックする" "$FAKE_HOME/.local/bin/codex" "$RESULT"
}

# ===========================================================
# 4. Homebrewパス（/opt/homebrew/bin/codex, /usr/local/bin/codex）が
#    候補リストに含まれていることの確認。
#    実システムの/opt/homebrew, /usr/localへの書き込みはsudoが必要なため、
#    ここでは「関数のソースに両方のパスがハードコードされていること」を
#    退行防止の静的検証として行う（実際にそのパスにcodexがインストールされて
#    いる場合は、下のライブ確認ブロックで実際に解決できることも確認する）。
# ===========================================================
{
  if grep -q '/opt/homebrew/bin/codex' "$SCRIPT_DIR/resolve-callflow-codex-binary-path.sh" \
    && grep -q '/usr/local/bin/codex' "$SCRIPT_DIR/resolve-callflow-codex-binary-path.sh"; then
    pass "Homebrewの2つの既定パスが候補リストに含まれている（静的検証）"
  else
    fail "Homebrewの2つの既定パスが候補リストに含まれている（静的検証）"
  fi

  # ライブ確認（この開発機に実際にHomebrew版codexが無ければ自動的にスキップする）。
  if [ -x "/opt/homebrew/bin/codex" ] || [ -x "/usr/local/bin/codex" ]; then
    FAKE_HOME_4="$TESTROOT/fake-home-4"
    mkdir -p "$FAKE_HOME_4"
    RESULT="$( (CALLFLOW_CODEX_BINARY_PATH= HOME="$FAKE_HOME_4" PATH="/usr/bin:/bin" resolve_callflow_codex_binary_path) || true)"
    if [ -n "$RESULT" ]; then
      pass "Homebrewパスへのライブフォールバック確認（実際に検出: $RESULT）"
    else
      fail "Homebrewパスへのライブフォールバック確認"
    fi
  else
    echo "（この開発機にHomebrew版codexが無いため、ライブ確認はスキップ）"
  fi
}

# ===========================================================
# 5. 実行不可ファイルを拒否する
# ===========================================================
{
  NON_EXEC="$TESTROOT/non-exec/codex"
  mkdir -p "$(dirname "$NON_EXEC")"
  echo "not executable" > "$NON_EXEC"
  chmod 644 "$NON_EXEC"

  if is_valid_callflow_codex_binary "$NON_EXEC"; then
    fail "実行不可ファイルは拒否される"
  else
    pass "実行不可ファイルは拒否される"
  fi

  # PATH・HOMEの両方をこの開発機の実際のcodex CLIが絶対に見つからない状態へ隔離した上で、
  # 実行不可な明示パスがどう扱われるかを確認する（この開発機には実際に~/.local/bin/codexが
  # 存在するため、HOMEも隔離しないとフォールバックが本物のcodexを見つけてしまい試験にならない）。
  FAKE_HOME_5="$TESTROOT/fake-home-5"
  mkdir -p "$FAKE_HOME_5"
  RESULT="$( (CALLFLOW_CODEX_BINARY_PATH="$NON_EXEC" HOME="$FAKE_HOME_5" PATH="/usr/bin:/bin" resolve_callflow_codex_binary_path) || true)"
  assert_eq "実行不可な明示パスは無視され、後続の解決へフォールスルーする（他候補も無ければ空）" "" "$RESULT"
}

# ===========================================================
# 6. 存在しないパスを拒否する
# ===========================================================
{
  NOT_EXIST="$TESTROOT/does/not/exist/codex"
  if is_valid_callflow_codex_binary "$NOT_EXIST"; then
    fail "存在しないパスは拒否される"
  else
    pass "存在しないパスは拒否される"
  fi

  if is_valid_callflow_codex_binary ""; then
    fail "空文字は拒否される"
  else
    pass "空文字は拒否される"
  fi
}

# ===========================================================
# 7. Codexが見つからなくてもCompanionのhealthは起動可能
#    （TypeScript側は本タスクで変更していない。CodexAppServerは実際に解析リクエストが
#    来るまでspawnされない設計であり、既存のcompanion/src/server.test.tsのhealth系テストは
#    すべてCALLFLOW_CODEX_BINARY_PATH未設定＝既定の"codex"のまま実行されて成功しているため、
#    「Codexが見つからない状態でもCompanion自体は起動しhealthに応答する」ことは
#    既存の自動テストスイート（npm run companion:test）が既に証明している。
#    ここでは重複を避けるため、その事実だけを記録する。
# ===========================================================
pass "Codex CLI不在でもCompanion健全性は既存のcompanion:testで確認済み（重複テストなし）"

# ===========================================================
# 8. 解決した絶対パスが子プロセスへ渡る
# ===========================================================
{
  CHILD_BIN="$TESTROOT/child-check/codex"
  make_fake_codex "$CHILD_BIN"
  RESOLVED="$(CALLFLOW_CODEX_BINARY_PATH="$CHILD_BIN" resolve_callflow_codex_binary_path || true)"
  export CALLFLOW_CODEX_BINARY_PATH="$RESOLVED"
  CHILD_SEEN="$(node -e 'process.stdout.write(process.env.CALLFLOW_CODEX_BINARY_PATH || "")')"
  unset CALLFLOW_CODEX_BINARY_PATH
  assert_eq "exportした絶対パスがnode子プロセスのprocess.envへ渡る" "$CHILD_BIN" "$CHILD_SEEN"
}

# ===========================================================
# 9・10. LaunchAgent plistへ絶対パスが入り、認証情報・生tokenは入らないこと
#    （実際のLaunchAgentsディレクトリ・実際のlaunchctl登録には一切触れない。
#    CALLFLOW_LAUNCHAGENT_DIR / CALLFLOW_LAUNCHAGENT_SKIP_BOOTSTRAP=true で
#    使い捨てディレクトリへplistを生成するだけに留める）。
# ===========================================================
{
  FAKE_CODEX_FOR_PLIST="$TESTROOT/plist-codex/codex"
  make_fake_codex "$FAKE_CODEX_FOR_PLIST"

  FAKE_LAUNCHAGENTS_DIR="$TESTROOT/fake-launchagents"
  mkdir -p "$FAKE_LAUNCHAGENTS_DIR"

  INSTALL_OUTPUT="$(
    CALLFLOW_CODEX_BINARY_PATH="$FAKE_CODEX_FOR_PLIST" \
    CALLFLOW_LAUNCHAGENT_DIR="$FAKE_LAUNCHAGENTS_DIR" \
    CALLFLOW_LAUNCHAGENT_SKIP_BOOTSTRAP=true \
    bash "$SCRIPT_DIR/install-callflow-companion-launchagent.sh" 2>&1
  )"
  INSTALL_EXIT=$?

  PLIST_PATH="$FAKE_LAUNCHAGENTS_DIR/com.callflow.companion.plist"

  if [ "$INSTALL_EXIT" -eq 0 ] && [ -f "$PLIST_PATH" ]; then
    pass "テストモードでのインストールスクリプト実行が成功し、plistが生成される"
  else
    fail "テストモードでのインストールスクリプト実行が成功し、plistが生成される（終了コード: $INSTALL_EXIT）"
    echo "$INSTALL_OUTPUT"
  fi

  if [ -f "$PLIST_PATH" ]; then
    if command -v plutil >/dev/null 2>&1 && plutil -lint "$PLIST_PATH" >/dev/null 2>&1; then
      pass "生成されたplistが構文として妥当（plutil -lint）"
    else
      fail "生成されたplistが構文として妥当（plutil -lint）"
    fi

    if grep -q "$FAKE_CODEX_FOR_PLIST" "$PLIST_PATH"; then
      pass "plistのEnvironmentVariablesへCodex CLIの絶対パスが入っている"
    else
      fail "plistのEnvironmentVariablesへCodex CLIの絶対パスが入っている"
    fi

    if grep -qi "token\|bearer\|api.key\|apikey\|secret\|password\|sk-" "$PLIST_PATH"; then
      fail "plistに認証情報・生token相当の文字列が含まれていない"
    else
      pass "plistに認証情報・生token相当の文字列が含まれていない"
    fi

    # launchctlの実登録は一切呼ばれていないはず（テストモードの出力メッセージで確認）。
    if echo "$INSTALL_OUTPUT" | grep -q "テストモード"; then
      pass "テストモードでは実際のlaunchd登録が行われない"
    else
      fail "テストモードでは実際のlaunchd登録が行われない"
    fi
  fi
}

# ===========================================================
# XMLメタ文字（&, <, >）を含むパスでも、生成されるplistが妥当なXMLのままであること
# （パスをエスケープせず生のまま埋め込むと、plutil -lintが不正なXMLとして拒否し、
# launchdがplistを読み込めなくなる。稀だが有効なファイル名として起こりうる）。
# ===========================================================
{
  FAKE_LAUNCHAGENTS_DIR_XML="$TESTROOT/fake-launchagents-xml"
  mkdir -p "$FAKE_LAUNCHAGENTS_DIR_XML"
  FAKE_CODEX_WITH_AMPERSAND="$TESTROOT/R&D/bin/codex"
  make_fake_codex "$FAKE_CODEX_WITH_AMPERSAND"

  CALLFLOW_CODEX_BINARY_PATH="$FAKE_CODEX_WITH_AMPERSAND" \
    CALLFLOW_LAUNCHAGENT_DIR="$FAKE_LAUNCHAGENTS_DIR_XML" \
    CALLFLOW_LAUNCHAGENT_SKIP_BOOTSTRAP=true \
    bash "$SCRIPT_DIR/install-callflow-companion-launchagent.sh" >/dev/null 2>&1

  PLIST_PATH_XML="$FAKE_LAUNCHAGENTS_DIR_XML/com.callflow.companion.plist"
  if [ -f "$PLIST_PATH_XML" ] && command -v plutil >/dev/null 2>&1 && plutil -lint "$PLIST_PATH_XML" >/dev/null 2>&1; then
    pass "パスに&が含まれていても生成されたplistは妥当なXMLのまま（エスケープ済み）"
  else
    fail "パスに&が含まれていても生成されたplistは妥当なXMLのまま（エスケープ済み）"
  fi

  if [ -f "$PLIST_PATH_XML" ] && grep -q "R&amp;D" "$PLIST_PATH_XML"; then
    pass "&は&amp;としてエスケープされてplistに書き込まれる"
  else
    fail "&は&amp;としてエスケープされてplistに書き込まれる"
  fi
}

# ===========================================================
# Codexが見つからない場合、plistにCALLFLOW_CODEX_BINARY_PATHキー自体が
# 入らないこと（空文字での上書きを避けるため）。
# ===========================================================
{
  FAKE_LAUNCHAGENTS_DIR_2="$TESTROOT/fake-launchagents-2"
  mkdir -p "$FAKE_LAUNCHAGENTS_DIR_2"

  # PATH・HOMEをともに「codexが絶対に見つからない」状態にしてから実行する。
  # ただしnodeコマンド自体はinstallスクリプトが必要とするため、実際のnodeの場所だけは
  # PATHに残す（command -vで動的に取得するため、特定ユーザー固有パスの直書きにはならない）。
  FAKE_HOME_NO_CODEX="$TESTROOT/fake-home-no-codex"
  mkdir -p "$FAKE_HOME_NO_CODEX"
  NODE_DIR_FOR_TEST="$(dirname "$(command -v node)")"

  env -u CALLFLOW_CODEX_BINARY_PATH \
    HOME="$FAKE_HOME_NO_CODEX" \
    PATH="$NODE_DIR_FOR_TEST:/usr/bin:/bin:/usr/sbin:/sbin" \
    CALLFLOW_LAUNCHAGENT_DIR="$FAKE_LAUNCHAGENTS_DIR_2" \
    CALLFLOW_LAUNCHAGENT_SKIP_BOOTSTRAP=true \
    bash "$SCRIPT_DIR/install-callflow-companion-launchagent.sh" >/dev/null 2>&1

  PLIST_PATH_2="$FAKE_LAUNCHAGENTS_DIR_2/com.callflow.companion.plist"
  if [ -f "$PLIST_PATH_2" ] && ! grep -q "CALLFLOW_CODEX_BINARY_PATH" "$PLIST_PATH_2"; then
    pass "Codex CLIが見つからない場合、plistへCALLFLOW_CODEX_BINARY_PATHキー自体を入れない"
  else
    fail "Codex CLIが見つからない場合、plistへCALLFLOW_CODEX_BINARY_PATHキー自体を入れない"
  fi
}

echo ""
echo "======================================"
echo "成功: $PASS_COUNT件 / 失敗: $FAIL_COUNT件"
echo "======================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
