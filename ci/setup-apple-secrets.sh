#!/usr/bin/env bash
# Based · Apple-Signatur-Secrets für GitHub einrichten (BSD-272)
#
# Aufruf auf dem Mac (ein Befehl):
#   bash <(curl -fsSL https://raw.githubusercontent.com/elija-7580/Based/main/ci/setup-apple-secrets.sh)
#
# Was das Skript macht:
#   1. GitHub CLI prüfen (installiert sie bei Bedarf über Homebrew, meldet dich an).
#   2. „Developer ID Application“-Zertifikat im Schlüsselbund suchen. Fehlt es, erzeugt es einen
#      Schlüssel + Zertifikatsanfrage und öffnet die Apple-Seite; du lädst dort nur hoch und herunter.
#   3. Zertifikat + Schlüssel als .p12 mit einem Zufallspasswort exportieren (niemand sieht es).
#   4. App-Store-Connect-API-Schlüssel (AuthKey_*.p8) aus „Downloads“ nehmen; fehlt er, öffnet es
#      die Seite zum Anlegen und wartet. Key-ID kommt aus dem Dateinamen, die Issuer-ID fragt es ab.
#   5. Alle sechs Secrets im Repo setzen und temporäre Dateien löschen.
# Werte landen nur in GitHub-Secrets, nie in Logs oder Dateien im Repo.
set -euo pipefail

REPO="elija-7580/Based"
OPENSSL=/usr/bin/openssl            # LibreSSL von macOS: erzeugt .p12, die `security import` versteht
DL="$HOME/Downloads"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }
wait_for_file() { # $1 = glob in ~/Downloads, $2 = Beschreibung
  local f=""
  printf 'Warte auf %s in %s …' "$2" "$DL"
  while :; do
    f=$(ls -t $DL/$1 2>/dev/null | head -1 || true)
    [ -n "$f" ] && { echo " gefunden: $(basename "$f")"; WAITED="$f"; return; }
    sleep 2; printf '.'
  done
}

[ "$(uname)" = Darwin ] || fail "Bitte auf dem Mac ausführen."

# 1 · GitHub CLI ---------------------------------------------------------------
say "1/5 · GitHub CLI"
if ! command -v gh >/dev/null; then
  command -v brew >/dev/null || fail "Homebrew fehlt. Erst https://brew.sh installieren, dann nochmal starten."
  brew install gh
fi
gh auth status -h github.com >/dev/null 2>&1 || gh auth login -h github.com -p https -w
gh repo view "$REPO" --json name >/dev/null || fail "Kein Zugriff auf $REPO mit diesem GitHub-Konto."
echo "ok"

# 2 · Zertifikat ----------------------------------------------------------------
say "2/5 · Developer-ID-Zertifikat"
IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
PASS=$($OPENSSL rand -base64 24)
P12="$WORK/developer-id.p12"

if [ -n "$IDENTITY" ]; then
  echo "Gefunden: $IDENTITY"
  # Nur dieses Zertifikat samt passendem Schlüssel exportieren (nicht alle Identitäten).
  security find-certificate -c "$IDENTITY" -p > "$WORK/cert.pem"
  $OPENSSL x509 -in "$WORK/cert.pem" -pubkey -noout > "$WORK/cert.pub"
  echo "macOS fragt gleich nach dem Schlüsselbund-Zugriff: bitte mit deinem Mac-Passwort „Erlauben“."
  security export -t identities -f pkcs12 -P "$PASS" -o "$WORK/all.p12" >/dev/null
  $OPENSSL pkcs12 -in "$WORK/all.p12" -nodes -nocerts -passin "pass:$PASS" 2>/dev/null \
    | awk -v d="$WORK" '/-----BEGIN .*PRIVATE KEY-----/{n++; f=d"/key"n".pem"} f{print > f} /-----END .*PRIVATE KEY-----/{f=""}'
  KEY=""
  for k in "$WORK"/key*.pem; do
    [ -f "$k" ] || continue
    if $OPENSSL pkey -in "$k" -pubout 2>/dev/null | cmp -s - "$WORK/cert.pub"; then KEY="$k"; break; fi
  done
  [ -n "$KEY" ] || fail "Zum Zertifikat passender privater Schlüssel nicht im Schlüsselbund gefunden."
  $OPENSSL pkcs12 -export -inkey "$KEY" -in "$WORK/cert.pem" -name "$IDENTITY" -passout "pass:$PASS" -out "$P12"
else
  echo "Kein Developer-ID-Zertifikat gefunden – ich lege eins an."
  $OPENSSL genrsa -out "$WORK/key.pem" 2048 2>/dev/null
  CSR="$HOME/Desktop/Based-DeveloperID.certSigningRequest"
  $OPENSSL req -new -key "$WORK/key.pem" -out "$CSR" -subj "/emailAddress=hello@basednotes.app/CN=Based Developer ID/C=AT"
  echo "Zertifikatsanfrage liegt auf dem Schreibtisch: $(basename "$CSR")"
  echo "Im Browser: „Developer ID Application“ wählen (Profiltyp G2 Sub-CA) → Continue → diese Datei hochladen → Download."
  open "https://developer.apple.com/account/resources/certificates/add"
  wait_for_file "developerID_application*.cer" "dem geladenen Zertifikat (developerID_application.cer)"
  $OPENSSL x509 -inform DER -in "$WAITED" -out "$WORK/cert.pem"
  IDENTITY=$($OPENSSL x509 -in "$WORK/cert.pem" -noout -subject | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p')
  $OPENSSL pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$IDENTITY" -passout "pass:$PASS" -out "$P12"
  # Auch lokal im Schlüsselbund ablegen, damit du auf dem Mac signieren kannst.
  security import "$P12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -T /usr/bin/codesign >/dev/null || true
  rm -f "$CSR"
  echo "Angelegt: $IDENTITY"
fi
case "$IDENTITY" in "Developer ID Application:"*) ;; *) fail "Unerwarteter Zertifikatsname: $IDENTITY";; esac

# 3 · API-Schlüssel -------------------------------------------------------------
say "3/5 · App-Store-Connect-API-Schlüssel (für die Notarisierung)"
P8=$(ls -t "$DL"/AuthKey_*.p8 2>/dev/null | head -1 || true)
if [ -z "$P8" ]; then
  echo "Im Browser: „Team Keys“ → „+“ → Name „Based CI“, Zugriff „Developer“ → Generieren → „Download“."
  echo "(Der Download geht nur einmal. Die Issuer-ID steht oben auf derselben Seite.)"
  open "https://appstoreconnect.apple.com/access/integrations/api"
  wait_for_file "AuthKey_*.p8" "dem API-Schlüssel (AuthKey_….p8)"
  P8="$WAITED"
fi
KEY_ID=$(basename "$P8" | sed -n 's/^AuthKey_\([A-Z0-9]*\)\.p8$/\1/p')
[ -n "$KEY_ID" ] || fail "Key-ID nicht aus dem Dateinamen lesbar: $(basename "$P8")"
echo "Key-ID: $KEY_ID"
ISSUER=""
until [[ "$ISSUER" =~ ^[0-9a-fA-F-]{36}$ ]]; do
  read -r -p "Issuer-ID (steht über der Schlüsselliste, Format xxxxxxxx-xxxx-…): " ISSUER < /dev/tty
done

# 4 · Secrets setzen ------------------------------------------------------------
say "4/5 · GitHub-Secrets setzen"
base64 -i "$P12" | gh secret set APPLE_CERTIFICATE -R "$REPO"
printf '%s' "$PASS"     | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
printf '%s' "$IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
printf '%s' "$KEY_ID"   | gh secret set APPLE_API_KEY -R "$REPO"
printf '%s' "$ISSUER"   | gh secret set APPLE_API_ISSUER -R "$REPO"
gh secret set APPLE_API_KEY_P8 -R "$REPO" < "$P8"

# 5 · Prüfen --------------------------------------------------------------------
say "5/5 · Prüfen"
n=$(gh secret list -R "$REPO" | grep -cE '^APPLE_(CERTIFICATE|CERTIFICATE_PASSWORD|SIGNING_IDENTITY|API_KEY|API_ISSUER|API_KEY_P8)\b' || true)
[ "$n" -eq 6 ] || fail "Nur $n von 6 Secrets gefunden."
echo "Alle 6 Apple-Secrets sind gesetzt ($IDENTITY, Key-ID $KEY_ID)."
echo "Tipp: $(basename "$P8") aus „Downloads“ an einen sicheren Ort verschieben (Apple gibt ihn nur einmal heraus)."
echo "Der nächste Beta-Build (täglich 13:43 oder bei jedem Push auf beta) wird signiert und notarisiert."
