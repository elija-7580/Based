#!/bin/bash
# Based updater agent. launchd starts it for every connection to 127.0.0.1:47321 (inetd style: the socket
# is stdin/stdout); install-mac.sh installs it as ~/Library/LaunchAgents/<bundle id>.updater.plist.
# Based (sandboxed or not) talks to it over that local socket, so the app never needs to run git or Xcode
# itself. One command per connection:
#   status    → "phase|detail" of the last/current update (idle, fetching, building, installing, done, failed)
#   update    → starts scripts/update-mac.sh in the background → "started" or "running"
#   terminal  → runs the update in a Terminal window instead (when macOS blocks background access) → "opened"
#   ack       → resets a finished status to idle → "ok"
#   info      → "repo <path>"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BASED_REPO:-}"
LOGDIR="$HOME/Library/Logs/Based"; mkdir -p "$LOGDIR"
STATUS="$LOGDIR/update-status"

running() { [ -f "$LOGDIR/update.pid" ] && kill -0 "$(cat "$LOGDIR/update.pid")" 2>/dev/null; }

IFS= read -r -t 5 cmd || cmd=""
cmd="${cmd%%$'\r'}"
case "$cmd" in
  status)
    if [ -f "$STATUS" ]; then
      line="$(head -n 1 "$STATUS")"
      # A build that died without reporting (Mac restarted, killed) must not look like it's still running.
      case "$line" in fetching*|building*|installing*) running || line="failed|The update stopped unexpectedly. See ~/Library/Logs/Based/update.log." ;; esac
      echo "$line"
    else echo "idle|"; fi ;;
  update)
    if running; then echo "running"; else
      printf 'fetching|\n' > "$STATUS"
      BASED_REPO="$ROOT" nohup /bin/bash "$DIR/update-mac.sh" >/dev/null 2>&1 </dev/null &
      echo $! > "$LOGDIR/update.pid"   # before replying, so the next "status" already sees it running
      echo "started"
    fi ;;
  terminal)
    if running; then echo "running"; else open -a Terminal "$DIR/update-in-terminal.command" && echo "opened" || echo "error"; fi ;;
  ack)
    case "$(head -n 1 "$STATUS" 2>/dev/null)" in done*|failed*) printf 'idle|\n' > "$STATUS" ;; esac
    echo "ok" ;;
  info) echo "repo $ROOT" ;;
  *) echo "unknown command" ;;
esac
