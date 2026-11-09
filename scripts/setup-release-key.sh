#!/usr/bin/env bash
# One-time setup for the downloadable DMG and its self-updates. Run on your Mac, from the repo:
#   scripts/setup-release-key.sh
# 1. Creates the update signing key (Ed25519, with Apple's CryptoKit — nothing to install).
# 2. Keeps a backup of the private key in your login keychain ("Based update signing key").
# 3. Stores the private key as the GitHub secret SPARKLE_PRIVATE_KEY (with the gh CLI if it's signed in,
#    otherwise it copies the key and opens the GitHub page where you paste it).
# 4. Writes the public key to Config/Based.xcconfig, commits and pushes → GitHub builds the first release.
# Running it again replaces the key; copies of Based installed before that can't update anymore (download
# the DMG again once).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
REPO="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/key.swift" <<'EOF'
import CryptoKit
let key = Curve25519.Signing.PrivateKey()
print(key.rawRepresentation.base64EncodedString())
print(key.publicKey.rawRepresentation.base64EncodedString())
EOF
KEYS="$(swift "$TMP/key.swift")"
PRIV="$(printf '%s\n' "$KEYS" | sed -n 1p)"
PUB="$(printf '%s\n' "$KEYS" | sed -n 2p)"
[ ${#PRIV} -eq 44 ] && [ ${#PUB} -eq 44 ] || { echo "error: key generation failed"; exit 1; }

security add-generic-password -U -a "$REPO" -s "Based update signing key" -w "$PRIV" \
  && echo "✓ Backup in your login keychain: \"Based update signing key\""

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  printf '%s' "$PRIV" | gh secret set SPARKLE_PRIVATE_KEY -R "$REPO"
  echo "✓ GitHub secret SPARKLE_PRIVATE_KEY set"
else
  printf '%s' "$PRIV" | pbcopy
  open "https://github.com/$REPO/settings/secrets/actions/new"
  echo
  echo "The private key is on your clipboard. On the GitHub page that just opened:"
  echo "  Name:   SPARKLE_PRIVATE_KEY"
  echo "  Secret: ⌘V"
  echo "  → Add secret"
  read -r -p "Press Enter when the secret is saved… "
  printf '' | pbcopy
fi
unset PRIV KEYS

sed -i '' "s|^BASED_SPARKLE_PUBLIC_KEY =.*|BASED_SPARKLE_PUBLIC_KEY = $PUB|" Config/Based.xcconfig
grep -qF "BASED_SPARKLE_PUBLIC_KEY = $PUB" Config/Based.xcconfig || { echo "error: couldn't update Config/Based.xcconfig"; exit 1; }
git add Config/Based.xcconfig
git commit -q -m "Update signing key for the downloadable build" -- Config/Based.xcconfig
git push -q
echo "✓ Pushed. GitHub now builds the first release (about 10–20 minutes):"
echo "  https://github.com/$REPO/actions"
echo "  Download afterwards: https://github.com/$REPO/releases/latest/download/Based.dmg"
