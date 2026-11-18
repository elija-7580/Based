#!/usr/bin/env bash
# Based · Beta-DMG auf den Website-Server statt an GitHub-Releases (BSD-553)
#
# Aufruf auf dem Mac (ein Befehl, <server> = wie du dich als root anmeldest, z. B. root@basednotes.app):
#   bash <(curl -fsSL https://raw.githubusercontent.com/elija-7580/Based/main/ci/setup-beta-deploy.sh) root@<server>
#
# Was das Skript macht:
#   1. GitHub CLI prüfen (installiert sie bei Bedarf über Homebrew, meldet dich an).
#   2. Einen eigenen SSH-Schlüssel nur für diesen Zweck erzeugen (ed25519, ohne Passwort, nur im Temp-Ordner).
#   3. Auf dem Server (per ssh als root): Benutzer „based-beta“ ohne Passwort, Ordner /srv/based-beta, rsync + rrsync.
#      In authorized_keys darf der Schlüssel NUR „rrsync -wo /srv/based-beta“: Dateien in diesen Ordner schreiben,
#      nichts lesen, keine Shell, kein Port-Forwarding.
#   4. Probe-Upload mit dem neuen Schlüssel, danach wird die Probedatei wieder gelöscht.
#   5. Vier Secrets im Repo setzen: BETA_DEPLOY_HOST, BETA_DEPLOY_USER, BETA_DEPLOY_KEY, BETA_DEPLOY_KNOWN_HOSTS.
# Der private Schlüssel landet nur im GitHub-Secret, nie im Repo oder in Logs. Wiederholen ist sicher (ersetzt den Schlüssel).
#
# Danach: auf dem Server den Dienst-Stand holen (macht der 10-Minuten-Cron auch selbst) und einmal den Beta-Workflow laufen
# lassen: gh workflow run desktop-beta.yml -R elija-7580/Based --ref beta
set -euo pipefail

REPO="elija-7580/Based"
DEPLOY_USER="based-beta"
BETA_DIR="/srv/based-beta"
SERVER="${1:-}"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$SERVER" ] || fail "Bitte den Server angeben, z. B.: bash setup-beta-deploy.sh root@basednotes.app"
HOST="${SERVER#*@}"
command -v ssh >/dev/null && command -v ssh-keygen >/dev/null && command -v ssh-keyscan >/dev/null || fail "OpenSSH fehlt."

# 1 · GitHub CLI ---------------------------------------------------------------
say "1/5 · GitHub CLI"
if ! command -v gh >/dev/null; then
  command -v brew >/dev/null || fail "Weder gh noch Homebrew gefunden. Installiere gh: https://cli.github.com"
  brew install gh
fi
gh auth status >/dev/null 2>&1 || gh auth login -h github.com -w
gh repo view "$REPO" >/dev/null || fail "Kein Zugriff auf $REPO mit diesem gh-Konto."

# 2 · Schlüssel ----------------------------------------------------------------
say "2/5 · Eigener Schlüssel für den Upload"
ssh-keygen -q -t ed25519 -N "" -C "github-actions desktop-beta → $HOST" -f "$WORK/key"
PUB="$(cat "$WORK/key.pub")"
echo "erzeugt: ${PUB%% github-actions*} …"

# 3 · Server ------------------------------------------------------------------
say "3/5 · Server $SERVER einrichten (Benutzer $DEPLOY_USER, Ordner $BETA_DIR, nur rsync)"
ssh -o ConnectTimeout=20 "$SERVER" "PUB='$PUB' DEPLOY_USER='$DEPLOY_USER' BETA_DIR='$BETA_DIR' bash -s" <<'REMOTE'
set -euo pipefail
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
if ! command -v rsync >/dev/null; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq rsync; fi
RRSYNC="$(command -v rrsync || true)"
if [ -z "$RRSYNC" ]; then
  for f in /usr/share/doc/rsync/scripts/rrsync /usr/share/doc/rsync/scripts/rrsync.gz /usr/share/rsync/scripts/rrsync; do
    [ -e "$f" ] || continue
    case "$f" in *.gz) gunzip -c "$f" | $SUDO tee /usr/local/bin/rrsync >/dev/null ;; *) $SUDO cp "$f" /usr/local/bin/rrsync ;; esac
    $SUDO chmod 755 /usr/local/bin/rrsync; RRSYNC=/usr/local/bin/rrsync; break
  done
fi
[ -n "$RRSYNC" ] || { echo "rrsync nicht gefunden (Paket rsync zu alt?)"; exit 1; }
id "$DEPLOY_USER" >/dev/null 2>&1 || $SUDO useradd --system --create-home --shell /bin/sh "$DEPLOY_USER"
$SUDO passwd -l "$DEPLOY_USER" >/dev/null 2>&1 || true
# Docker legt den Ordner beim Start des Dienstes evtl. schon als root an: Besitz hier richtigstellen.
$SUDO install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$BETA_DIR"
$SUDO chown "$DEPLOY_USER:$DEPLOY_USER" "$BETA_DIR"
HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
$SUDO install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
printf 'restrict,command="%s -wo %s" %s\n' "$RRSYNC" "$BETA_DIR" "$PUB" | $SUDO tee "$HOME_DIR/.ssh/authorized_keys" >/dev/null
$SUDO chown "$DEPLOY_USER:$DEPLOY_USER" "$HOME_DIR/.ssh/authorized_keys"
$SUDO chmod 600 "$HOME_DIR/.ssh/authorized_keys"
echo "ok: $DEPLOY_USER darf nur in $BETA_DIR schreiben ($RRSYNC -wo)"
REMOTE

# 4 · Probe -------------------------------------------------------------------
say "4/5 · Probe-Upload mit dem neuen Schlüssel"
ssh-keyscan -T 15 "$HOST" 2>/dev/null > "$WORK/known_hosts"
[ -s "$WORK/known_hosts" ] || fail "ssh-keyscan $HOST lieferte keinen Host-Schlüssel."
RSYNC=rsync
if ! rsync --version 2>/dev/null | grep -q "rsync  version 3"; then
  if command -v brew >/dev/null; then brew list rsync >/dev/null 2>&1 || brew install rsync; RSYNC="$(brew --prefix)/bin/rsync"; fi
fi
echo "probe $(date -u +%FT%TZ)" > "$WORK/.setup-check"
"$RSYNC" -t -e "ssh -i $WORK/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$WORK/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes" \
  "$WORK/.setup-check" "$DEPLOY_USER@$HOST:.setup-check" || fail "Probe-Upload fehlgeschlagen."
ssh "$SERVER" "rm -f '$BETA_DIR/.setup-check'"
if ssh -i "$WORK/key" -o IdentitiesOnly=yes -o UserKnownHostsFile="$WORK/known_hosts" -o BatchMode=yes "$DEPLOY_USER@$HOST" "ls /" >/dev/null 2>&1; then
  fail "Der Schlüssel bekommt eine Shell – authorized_keys prüfen."
fi
echo "ok: Upload geht, Shell nicht"

# 5 · Secrets -----------------------------------------------------------------
say "5/5 · Secrets in $REPO setzen"
printf '%s' "$HOST"        | gh secret set BETA_DEPLOY_HOST -R "$REPO"
printf '%s' "$DEPLOY_USER" | gh secret set BETA_DEPLOY_USER -R "$REPO"
gh secret set BETA_DEPLOY_KEY -R "$REPO" < "$WORK/key"
gh secret set BETA_DEPLOY_KNOWN_HOSTS -R "$REPO" < "$WORK/known_hosts"

say "Fertig."
cat <<EOF
Noch zu tun:
  1. Auf dem Server den neuen Dienst-Stand holen (der 10-Minuten-Cron macht das nach dem Merge auch selbst):
       ssh $SERVER 'cd /opt/based && git fetch -q --depth 1 origin main && git reset -q --hard FETCH_HEAD && \\
         if [ -d /opt/edge-caddy ]; then cd deploy/website/edge; else cd deploy/website; fi && docker compose up -d'
  2. Beta-Workflow einmal laufen lassen:  gh workflow run desktop-beta.yml -R $REPO --ref beta
  3. Erste Einladung (Link geht auf die Konsole, du schickst ihn selbst):
       ssh $SERVER 'if [ -d /opt/edge-caddy ]; then cd /opt/based/deploy/website/edge; else cd /opt/based/deploy/website; fi && \\
         docker compose exec waitlist node --no-warnings waitlist.mjs invite du@example.org'
EOF
