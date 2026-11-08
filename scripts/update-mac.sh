#!/usr/bin/env bash
# Updates Based on this Mac: pulls the newest main from GitHub, rebuilds a Release app and installs it
# (scripts/install-mac.sh quits Based, replaces /Applications/Based.app and reopens it).
# Started by the updater agent when you click "Update now" in Based (Settings → Updates), or by hand.
# Progress goes to ~/Library/Logs/Based/update-status ("phase|detail"), which Based shows while it runs.
#   usage: update-mac.sh             (install-mac.sh copies it next to the agent with BASED_REPO baked in)
set -euo pipefail
ROOT="${BASED_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LOGDIR="$HOME/Library/Logs/Based"; mkdir -p "$LOGDIR"
STATUS="$LOGDIR/update-status"; LOG="$LOGDIR/update.log"
echo $$ > "$LOGDIR/update.pid"
exec > >(tee -a "$LOG") 2>&1
echo "=== Based update $(date '+%Y-%m-%d %H:%M:%S') in $ROOT"

phase() { printf '%s|%s\n' "$1" "${2:-}" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"; echo "--- $1 ${2:-}"; }
fail() { phase failed "$1"; rm -f "$LOGDIR/update.pid"; exit 1; }
trap 'fail "$(tail -n 4 "$LOG" | tr "\n|" "  " | cut -c1-400)"' ERR

# launchd starts with a bare PATH; Homebrew (xcodegen) and the login shell's PATH are needed for the build.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -x /bin/zsh ]; then LOGIN_PATH="$(/bin/zsh -lc 'printf %s "$PATH"' 2>/dev/null || true)"; [ -n "$LOGIN_PATH" ] && export PATH="$LOGIN_PATH:$PATH"; fi

phase fetching
cd "$ROOT" || fail "Can't open the repository at $ROOT (macOS may block background access to Documents/Desktop — use \"Run in Terminal\")."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = main ] || fail "The repository is on branch \"$BRANCH\". Switch to main to update."
git fetch --quiet origin main
if ! git merge --ff-only --quiet origin/main; then
  fail "Your local copy has changes that conflict with GitHub (git status in $ROOT). Commit or stash them, then try again."
fi

phase building "$(git rev-parse --short HEAD)"
command -v xcodebuild >/dev/null || fail "xcodebuild not found — install Xcode."
command -v xcodegen >/dev/null || fail "xcodegen not found — brew install xcodegen."
BASED_UPDATE_STATUS="$STATUS" "$ROOT/scripts/install-mac.sh"
rm -f "$LOGDIR/update.pid"
