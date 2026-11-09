#!/usr/bin/env bash
# Builds a Release Based.app and installs it to /Applications, replacing the previous version, then deletes
# old build products (Debug/Release apps, dSYMs, iOS builds) so only one Based exists on this Mac.
# Debug builds are several times slower (no optimisation, debug driver, extra logging) — use this for daily use.
# Also installs the updater agent, so later versions install with one click in Based (Settings → Updates).
#   usage: scripts/install-mac.sh            (from the repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DD="${BASED_DERIVED_DATA:-$ROOT/build}"
cd "$ROOT"
# Progress for Based's update screen when run by scripts/update-mac.sh.
phase() { [ -n "${BASED_UPDATE_STATUS:-}" ] && printf '%s|%s\n' "$1" "${2:-}" > "$BASED_UPDATE_STATUS" || true; }

COMMIT="$(git rev-parse HEAD)"
COMMIT_DATE="$(git log -1 --format=%cI)"
BUILD_NUMBER="$(git rev-list --count HEAD)"
xcodegen generate >/dev/null
# The commit goes into Info.plist (BasedGitCommit) so Based can ask GitHub what's new since this build.
xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Release -derivedDataPath "$DD" -skipPackagePluginValidation -skipMacroValidation \
  BASED_GIT_COMMIT="$COMMIT" BASED_GIT_DATE="$COMMIT_DATE" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" build | tail -3
APP="$DD/Build/Products/Release/Based.app"
[ -d "$APP" ] || { echo "build failed: $APP missing"; exit 1; }
# Never replace a working Based with a build that can't start (P0 9.11.: Sparkle signed by another team).
"$ROOT/scripts/check-mac-signature.sh" "$APP" || { phase failed "signature"; echo "Not installed: the build would crash at launch. /Applications/Based.app is unchanged."; exit 1; }
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || echo com.friedrich-ulrich.based)"

phase installing "$(git rev-parse --short HEAD)"
osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Based >/dev/null || break; sleep 1; done
rm -rf /Applications/Based.app
ditto "$APP" /Applications/Based.app
# Old versions: everything except the app just installed.
rm -rf "$DD/Build/Products/Debug" "$DD/Build/Products/Debug-iphonesimulator" "$DD/Build/Products/Debug-iphoneos" \
       "$DD/Build/Products/Release/Based.app" "$DD/Build/Products/Release/Based.app.dSYM" "$ROOT/build-ios"

# Updater agent: a launchd job listening on 127.0.0.1:47321 that runs update-mac.sh for Based. The scripts are
# copied out of the repo (macOS can block launchd jobs from reading ~/Documents or ~/Desktop).
SUPPORT="$HOME/Library/Application Support/Based Updater"
LABEL="$BUNDLE_ID.updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$SUPPORT" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Based"
# Copy + rename (new inode): an update that is running update-mac.sh right now keeps reading the old file.
put() { cp "$1" "$SUPPORT/.$2.new" && chmod +x "$SUPPORT/.$2.new" && mv -f "$SUPPORT/.$2.new" "$SUPPORT/$2"; }
put "$ROOT/scripts/update-mac.sh" update-mac.sh
put "$ROOT/scripts/update-agent.sh" update-agent.sh
printf '#!/bin/bash\nBASED_REPO=%q /bin/bash "$(dirname "$0")/update-mac.sh"\necho\nread -n 1 -s -r -p "Done — press any key to close."\n' "$ROOT" > "$SUPPORT/.cmd.new"
put "$SUPPORT/.cmd.new" update-in-terminal.command; rm -f "$SUPPORT/.cmd.new"
cat > "$PLIST.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>/bin/bash</string><string>$SUPPORT/update-agent.sh</string></array>
	<key>EnvironmentVariables</key><dict><key>BASED_REPO</key><string>$ROOT</string></dict>
	<key>inetdCompatibility</key><dict><key>Wait</key><false/></dict>
	<key>Sockets</key><dict><key>Listener</key><dict>
		<key>SockNodeName</key><string>127.0.0.1</string>
		<key>SockServiceName</key><string>47321</string>
		<key>SockType</key><string>stream</string>
		<key>SockFamily</key><string>IPv4</string>
	</dict></dict>
	<key>AbandonProcessGroup</key><true/>
</dict>
</plist>
EOF

phase done "$(git rev-parse --short HEAD)"
echo "Installed /Applications/Based.app ($(git rev-parse --short HEAD), build $BUILD_NUMBER)"
open /Applications/Based.app

# (Re)load the agent last, and only when its definition changed or it isn't loaded: reloading ends the job
# whose connection may have started this very update.
if ! cmp -s "$PLIST.new" "$PLIST" || ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  mv -f "$PLIST.new" "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || echo "note: couldn't load the updater agent ($PLIST)"
else
  rm -f "$PLIST.new"
fi
