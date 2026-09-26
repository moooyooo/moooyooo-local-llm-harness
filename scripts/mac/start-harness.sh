#!/bin/sh
# Starts the production harness if it isn't running, then opens it in the browser.
# With the login agent installed (autostart.sh install), launchd runs it; otherwise it starts in the background.
set -eu

LABEL=com.moooyooo.local-llm-harness
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart "gui/$(id -u)/$LABEL" # no-op when already running
  exec node "$ROOT/scripts/harness.mjs" open
fi
exec node "$ROOT/scripts/harness.mjs" start "$@"
