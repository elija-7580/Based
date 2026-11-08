#!/usr/bin/env bash
# Builds the downloadable Based for Mac: a universal (Apple silicon + Intel) Release app in a DMG, plus the
# Sparkle appcast that tells installed copies about it. Run by .github/workflows/release.yml on every push to
# main; works the same on any Mac with Xcode and xcodegen.
#
#   SPARKLE_PRIVATE_KEY=<base64 seed> scripts/release-mac.sh     → dist/Based-<version>.dmg, dist/appcast.xml,
#                                                                   dist/notes.md, dist/version
# The version is 0.1.<number of commits>, so every commit on main is a newer update.
# Without a Developer ID the app is ad-hoc signed: the first open needs Control-click → Open (or System
# Settings → Privacy & Security → Open Anyway). Updates after that install without asking.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
: "${SPARKLE_PRIVATE_KEY:?Set SPARKLE_PRIVATE_KEY (GitHub → Settings → Secrets → Actions)}"
REPO="${GITHUB_REPOSITORY:-elija-7580/Based}"
DD="$ROOT/build/release"; DIST="$ROOT/dist"
rm -rf "$DIST"; mkdir -p "$DIST"

BUILD="$(git rev-list --count HEAD)"
BASE="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([0-9]*\.[0-9]*\).*/\1/p' project.yml | head -n 1)"
VERSION="${BASE:-0.1}.$BUILD"
COMMIT="$(git rev-parse HEAD)"
echo "== Based $VERSION (build $BUILD, ${COMMIT:0:7})"

# The public key in Config/Based.xcconfig must belong to this private key, or installed apps reject the update.
PUB="$(python3 "$ROOT/scripts/sparkle_sign.py" --public-key)"
grep -qF "BASED_SPARKLE_PUBLIC_KEY = $PUB" Config/Based.xcconfig || {
  echo "error: SPARKLE_PRIVATE_KEY doesn't match BASED_SPARKLE_PUBLIC_KEY in Config/Based.xcconfig (expected $PUB)"; exit 1; }

xcodegen generate >/dev/null
# Distribution build: no App Sandbox (local coding agents work), no iCloud (that needs your Apple team),
# ad-hoc signature, Sparkle updates on.
xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Release -derivedDataPath "$DD" \
  -destination 'generic/platform=macOS' -skipPackagePluginValidation -skipMacroValidation \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  BASED_GIT_COMMIT="$COMMIT" BASED_GIT_DATE="$(git log -1 --format=%cI)" BASED_DISTRIBUTION=release \
  BASED_AGENTS_SUFFIX=-Agents BASED_ENTITLEMENTS_SUFFIX= BASED_CLOUD_SYNC=NO \
  DEVELOPMENT_TEAM= CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- PROVISIONING_PROFILE_SPECIFIER= \
  ENABLE_HARDENED_RUNTIME=NO \
  build | tail -n 5
APP="$DD/Build/Products/Release/Based.app"
[ -d "$APP" ] || { echo "error: build failed ($APP missing)"; exit 1; }
codesign --verify --deep --strict "$APP"
/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist"

# DMG: the app and an Applications shortcut to drag it onto.
STAGE="$ROOT/build/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Based.app"
ln -s /Applications "$STAGE/Applications"
DMG="$DIST/Based-$VERSION.dmg"
hdiutil create -quiet -volname "Based" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

SIG="$(python3 "$ROOT/scripts/sparkle_sign.py" "$DMG")"
LEN="$(stat -f%z "$DMG")"

# Release notes: commits since the previous release (shown in the update dialog and on GitHub).
PREV="$(git describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || true)"
if [ -n "$PREV" ]; then RANGE="$PREV..HEAD"; else RANGE="-n 20"; fi
# shellcheck disable=SC2086
git log --no-merges --format='%s' $RANGE | grep -v '^$' > "$DIST/changes.txt" || true
{
  echo "**Download:** Based-$VERSION.dmg below → open it → drag Based into Applications."
  echo
  echo "First launch of a downloaded copy: Control-click Based → Open (or System Settings → Privacy & Security → Open Anyway). Updates afterwards install from inside Based."
  echo
  echo "### Changes"
  sed 's/^/- /' "$DIST/changes.txt"
} > "$DIST/notes.md"
NOTES_HTML="$(python3 - "$DIST/changes.txt" <<'EOF'
import html, sys
lines = [l.strip() for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
print("<ul>" + "".join(f"<li>{html.escape(l)}</li>" for l in lines[:60]) + "</ul>" if lines else "<p>Fixes and improvements.</p>")
EOF
)"

cat > "$DIST/appcast.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Based</title>
    <link>https://github.com/$REPO/releases</link>
    <item>
      <title>Based $VERSION</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <description><![CDATA[$NOTES_HTML]]></description>
      <enclosure url="https://github.com/$REPO/releases/download/v$VERSION/Based-$VERSION.dmg" length="$LEN" type="application/octet-stream" sparkle:edSignature="$SIG"/>
    </item>
  </channel>
</rss>
EOF
cp "$DMG" "$DIST/Based.dmg"   # stable name: …/releases/latest/download/Based.dmg
echo "$VERSION" > "$DIST/version"
echo "== dist: $(ls "$DIST" | tr '\n' ' ')"
