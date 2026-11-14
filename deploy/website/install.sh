#!/usr/bin/env bash
# Puts basednotes.app (Caddy + waitlist) on an existing Linux server, without touching anything else on it.
#   ssh root@<server> 'curl -fsSL https://raw.githubusercontent.com/elija-7580/Based/main/deploy/website/install.sh | bash'
# Safe to run again: it updates the checkout and restarts the two containers.
set -euo pipefail

ACME_EMAIL="${ACME_EMAIL:-hello@basednotes.app}"
DIR=/opt/based
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Prüfe Ports 80 und 443"
busy=""
if command -v docker >/dev/null; then
  busy=$($SUDO docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':(80|443)->' | grep -v '^website-caddy-' || true)
fi
if [ -z "$busy" ] && command -v ss >/dev/null; then
  busy=$($SUDO ss -ltnpH '( sport = :80 or sport = :443 )' | grep -v docker-proxy || true)
fi
if [ -n "$busy" ]; then
  echo "Ports 80/443 sind schon belegt, ich breche ab, damit nichts kaputtgeht:"; echo "$busy"; exit 1
fi

if ! command -v docker >/dev/null; then
  say "Installiere Docker"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
if ! command -v git >/dev/null; then
  say "Installiere git"
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git
fi

say "Hole den Code nach $DIR"
if [ -d "$DIR/.git" ]; then
  $SUDO git -C "$DIR" pull -q --ff-only
else
  $SUDO git clone -q --depth 1 https://github.com/elija-7580/Based "$DIR"
fi
[ -f "$DIR/deploy/website/.env" ] || printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL" | $SUDO tee "$DIR/deploy/website/.env" >/dev/null

say "Starte Caddy und den Warteliste-Dienst"
cd "$DIR/deploy/website"
$SUDO docker compose up -d --remove-orphans

say "Automatische Updates aus main alle 10 Minuten"
echo "*/10 * * * * root cd $DIR && git pull -q --ff-only && docker compose -f deploy/website/docker-compose.yml up -d --remove-orphans >/dev/null 2>&1" \
  | $SUDO tee /etc/cron.d/based-site >/dev/null

if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
  say "Firewall: öffne 80 und 443"
  $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443 >/dev/null
fi

sleep 3
say "Status"
$SUDO docker compose ps
$SUDO docker compose exec -T waitlist wget -qO- http://127.0.0.1:8790/api/health && echo "  (Warteliste läuft)" || true
echo "Fertig. Sobald das DNS auf diesen Server zeigt, holt Caddy das Zertifikat und https://basednotes.app ist live."
