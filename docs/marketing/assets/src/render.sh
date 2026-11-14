#!/usr/bin/env bash
# Renders every marketing image from asset.html with headless Chrome into ../ (PNG).
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME_BIN:-google-chrome}"
r() { # name kind w h [theme]
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$3,$4" --virtual-time-budget=1500 --screenshot="../$1.png" \
    "file://$PWD/asset.html?k=$2&w=$3&h=$4&t=${5:-light}" >/dev/null 2>&1
  echo "$1.png  $3x$4"
}
r avatar-light            avatar 1024 1024
r avatar-dark             avatar 1024 1024 dark
r producthunt-thumbnail   avatar 240 240
r x-header                wide   1500 500
r mastodon-header         wide   1500 500
r bluesky-banner          wide   3000 1000
r linkedin-cover          strip  1128 191
r reddit-profile-banner   center 1920 384
r reddit-community-banner center 1600 480
r github-social-preview   og     1280 640
r og-image                og     1200 630
r og-image-dark           og     1200 630 dark
r producthunt-gallery-1   og     1270 760
r post-square             square 1080 1080
r post-square-dark        square 1080 1080 dark
r story-short-cover       tall   1080 1920
