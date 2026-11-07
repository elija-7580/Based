#!/usr/bin/env bash
# Builds a Release Based.app and installs it to /Applications, replacing the previous version, then deletes
# old build products (Debug/Release apps, dSYMs, iOS builds) so only one Based exists on this Mac.
# Debug builds are several times slower (no optimisation, debug driver, extra logging) — use this for daily use.
#   usage: scripts/install-mac.sh            (from the repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DD="${BASED_DERIVED_DATA:-$ROOT/build}"
cd "$ROOT"
xcodegen generate >/dev/null
xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Release -derivedDataPath "$DD" build | tail -3
APP="$DD/Build/Products/Release/Based.app"
[ -d "$APP" ] || { echo "build failed: $APP missing"; exit 1; }
osascript -e 'tell application id "com.friedrich-ulrich.based" to quit' 2>/dev/null || true
sleep 1
rm -rf /Applications/Based.app
ditto "$APP" /Applications/Based.app
# Old versions: everything except the app just installed.
rm -rf "$DD/Build/Products/Debug" "$DD/Build/Products/Debug-iphonesimulator" "$DD/Build/Products/Debug-iphoneos" \
       "$DD/Build/Products/Release/Based.app" "$DD/Build/Products/Release/Based.app.dSYM" "$ROOT/build-ios"
echo "Installed /Applications/Based.app ($(git rev-parse --short HEAD))"
open /Applications/Based.app
