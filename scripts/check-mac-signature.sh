#!/usr/bin/env bash
# Checks a built Based.app before it replaces anything: valid signature, and every embedded framework signed by
# the same team as the app (otherwise dyld refuses to load it at launch – P0 of 9.11.: Sparkle.framework).
#   usage: scripts/check-mac-signature.sh path/to/Based.app
set -euo pipefail
APP="${1:?usage: $0 Based.app}"
team() { codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
codesign --verify --deep --strict "$APP" || { echo "error: $APP has an invalid signature"; exit 1; }
APP_TEAM="$(team "$APP")"
bad=0
for f in "$APP"/Contents/Frameworks/*.framework "$APP"/Contents/Frameworks/*.dylib; do
  [ -e "$f" ] || continue
  T="$(team "$f")"
  if [ "$T" != "$APP_TEAM" ]; then
    echo "error: $(basename "$f") is signed by team '${T}', the app by '${APP_TEAM}' – macOS would refuse to load it"
    bad=1
  fi
done
[ "$bad" = 0 ] && echo "signature OK (team '${APP_TEAM:-ad hoc}')"
exit "$bad"
