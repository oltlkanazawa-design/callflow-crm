#!/bin/bash
# CallFlow Companionをmacログイン時に自動起動するLaunchAgentをインストールする。
# 既存のnpm run companion:start/stop/checkは一切変更しない（このLaunchAgentは追加の起動経路）。
# 127.0.0.1:4318にのみbindし、既存のHTTPS証明書設定をそのまま利用する。
# このスクリプトの実行自体が明示的なユーザー操作であり、それ以外の外部通信は一切開始しない
# （インストール後にlaunchdが行うのは、ローカルの127.0.0.1:4318で待受を開始することだけ）。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "エラー: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

# plistのXMLテキストへ値を埋め込む前に、XMLの特殊文字（&, <, >）をエスケープする。
# パス自体に&や<等が含まれる場合（稀だが有効なファイル名）でも、生成されるplistが
# 不正なXMLにならないようにするための保険（plutil -lintで失敗し、launchdが読み込めなくなるため）。
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER_SCRIPT="$SCRIPT_DIR/callflow-companion-launchagent-run.sh"
# shellcheck source=./resolve-callflow-codex-binary-path.sh
. "$SCRIPT_DIR/resolve-callflow-codex-binary-path.sh"

LABEL="com.callflow.companion"
# テスト用に登録先ディレクトリを差し替えられるようにする（既定は実際のLaunchAgentsディレクトリ）。
LAUNCH_AGENTS_DIR="${CALLFLOW_LAUNCHAGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
APP_SUPPORT_DIR="$HOME/Library/Application Support/CallFlow Companion"
LOG_FILE="$APP_SUPPORT_DIR/companion-launchagent.log"
CERT_FILE="$APP_SUPPORT_DIR/certificates/companion-cert.pem"
KEY_FILE="$APP_SUPPORT_DIR/certificates/companion-key.pem"

if [ ! -f "$RUNNER_SCRIPT" ]; then
  echo "エラー: 実行スクリプトが見つかりません: $RUNNER_SCRIPT" >&2
  exit 1
fi
chmod +x "$RUNNER_SCRIPT"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "エラー: nodeコマンドが見つかりません。Node.jsをインストールしてから再実行してください。" >&2
  exit 1
fi

# Codex CLIの絶対パスをインストール時に解決し、plistへ埋め込む（見つからなくてもインストール自体は
# 継続する。録音・文字起こしはLaunchAgent経由でも利用でき、Codex解析だけが利用できなくなる）。
RESOLVED_CODEX_BIN="$(resolve_callflow_codex_binary_path || true)"
if [ -z "$RESOLVED_CODEX_BIN" ]; then
  echo "警告: Codex CLI（codexコマンド）が見つかりませんでした。LaunchAgent経由のCompanionでも" >&2
  echo "録音・文字起こしは利用できますが、Codexによる営業内容解析は利用できません。" >&2
  echo "Codex CLIをインストール後、このインストールスクリプトを再実行すれば反映されます。" >&2
fi

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "警告: TLS証明書がまだセットアップされていません。先に次を実行することをお勧めします: npm run companion:setup-tls" >&2
  echo "（証明書が無いままインストールした場合、Companionは起動に失敗し続けます。証明書セットアップ後に自動的に起動します。）" >&2
fi

if lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "警告: ポート4318は既に使用中です。npm run companion:start で手動起動したCompanionが" >&2
  echo "動いている場合は、先に npm run companion:stop で停止することをお勧めします" >&2
  echo "（同じポートには1つのプロセスしかbindできません）。" >&2
fi

mkdir -p "$APP_SUPPORT_DIR"
mkdir -p "$LAUNCH_AGENTS_DIR"

# テスト時（CALLFLOW_LAUNCHAGENT_SKIP_BOOTSTRAP=true）はplist生成のみ行い、実際のlaunchdへの
# 登録・取り消しは一切行わない（本物のLaunchAgentをインストールせずに、生成内容だけを検証するため）。
SKIP_BOOTSTRAP="${CALLFLOW_LAUNCHAGENT_SKIP_BOOTSTRAP:-false}"

if [ "$SKIP_BOOTSTRAP" != "true" ]; then
  # 既に読み込まれている場合は一度取り外してから登録し直す（設定変更の反映・二重登録防止）。
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
fi

# EnvironmentVariablesはCodex CLIが見つかった場合のみCALLFLOW_CODEX_BINARY_PATHを含める
# （見つからない場合にキーだけ空値で入れると、Companion側の既定値へのフォールバック（"codex"）を
# 空文字が上書きしてしまうため、キー自体を省略する）。
ENV_VARS_XML="		<key>CALLFLOW_COMPANION_NODE_BIN</key>
		<string>$(xml_escape "$NODE_BIN")</string>"
if [ -n "$RESOLVED_CODEX_BIN" ]; then
  ENV_VARS_XML="$ENV_VARS_XML
		<key>CALLFLOW_CODEX_BINARY_PATH</key>
		<string>$(xml_escape "$RESOLVED_CODEX_BIN")</string>"
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$(xml_escape "$LABEL")</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$RUNNER_SCRIPT")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$REPO_ROOT")</string>
	<key>EnvironmentVariables</key>
	<dict>
$ENV_VARS_XML
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_FILE")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST_PATH"

if [ "$SKIP_BOOTSTRAP" != "true" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  echo "LaunchAgentを登録しました: $PLIST_PATH"
  echo "次回ログイン時から自動的にCallFlow Companionが起動します（127.0.0.1:4318のみ）。"
  echo "今すぐ起動状態を確認するには: npm run companion:launchagent:check"
  echo "取り消すには: npm run companion:launchagent:uninstall"
else
  echo "[テストモード] plistを生成しました（launchdへの実登録はスキップ）: $PLIST_PATH"
fi
