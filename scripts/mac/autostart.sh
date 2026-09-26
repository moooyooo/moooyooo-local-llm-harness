#!/bin/sh
# Runs the production harness (port 38720) as a LaunchAgent: it starts at login and is restarted if it crashes.
# Ported from custom-harnes.
#
#   scripts/mac/autostart.sh install     register and start now (run again after moving the folder or node)
#   scripts/mac/autostart.sh uninstall   stop and unregister
#   scripts/mac/autostart.sh restart     rebuild and restart (e.g. after changing the harness)
#   scripts/mac/autostart.sh status
#
# launchd starts jobs with a minimal environment, so PATH, SHELL and LANG are captured here at install time.
# Unlike custom-harnes, the agent here runs commands itself (git, npm, docker, rg, ...), so it gets the whole PATH
# of the shell that runs install, minus what npm adds while running a script.
set -eu

LABEL=com.moooyooo.local-llm-harness
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$ROOT/logs/harness.log"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# $PATH without npm's per-script entries (node_modules/.bin, npm's own helpers) and duplicates.
agent_path() {
  printf '%s' "$PATH" | tr ':' '\n' | grep -v -e 'node_modules' -e '/npm/' -e '^$' | awk '!seen[$0]++' | paste -sd: -
}

install() {
  NODE=$(command -v node) || { echo "node が見つかりません（PATH を確認してください）" >&2; exit 1; }
  USER_SHELL=$(dscl . -read "$HOME" UserShell 2>/dev/null | awk '{print $2}')
  AGENT_PATH="$(agent_path):/usr/bin:/bin:/usr/sbin:/sbin"
  OLLAMA_ENV=""
  if [ -n "${OLLAMA_HOST:-}" ]; then OLLAMA_ENV="<key>OLLAMA_HOST</key><string>$(xml "$OLLAMA_HOST")</string>"; fi
  mkdir -p "$ROOT/logs" "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$ROOT/scripts/harness.mjs")</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$AGENT_PATH")</string>
    <key>SHELL</key><string>$(xml "${USER_SHELL:-/bin/zsh}")</string>
    <key>LANG</key><string>$(xml "${LANG:-en_US.UTF-8}")</string>
    $OLLAMA_ENV
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  if loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; fi
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "登録しました: $PLIST"
  echo "ログイン時に本番サーバー（ポート 38720）を起動します（ログ: logs/harness.log）"
  "$NODE" "$ROOT/scripts/harness.mjs" status --wait || true
}

case "${1:-status}" in
  install) install ;;
  uninstall)
    if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
    rm -f "$PLIST"
    echo "登録を解除しました（本番サーバーも停止しました）"
    ;;
  restart)
    loaded || { echo "登録されていません。先に install を実行してください" >&2; exit 1; }
    launchctl kickstart -k "$DOMAIN/$LABEL"
    node "$ROOT/scripts/harness.mjs" status --wait
    ;;
  status)
    if loaded; then
      echo "ログイン時の自動起動: 登録済み（${LABEL}）"
      # Top-level fields only (one tab deep); nested sections repeat "state".
      launchctl print "$DOMAIN/$LABEL" | grep -E "^$(printf '\t')(state|pid|last exit code) =" | sed 's/^[[:space:]]*/  /'
    else
      echo "ログイン時の自動起動: 未登録"
    fi
    node "$ROOT/scripts/harness.mjs" status || true
    ;;
  *)
    echo "使い方: $0 install | uninstall | restart | status" >&2
    exit 2
    ;;
esac
