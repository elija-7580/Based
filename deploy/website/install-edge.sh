#!/usr/bin/env bash
# basednotes.app on a server whose ports 80/443 already belong to a shared Caddy in /opt/edge-caddy.
#   ssh root@<server> 'curl -fsSL https://raw.githubusercontent.com/elija-7580/Based/main/deploy/website/install-edge.sh | bash'
# Adds one site block and one read-only mount to edge-caddy (backups first, validated, rolled back on error)
# and runs the waitlist service on the "edge" network. Safe to run again.
set -euo pipefail
DIR=/opt/based
EDGE=/opt/edge-caddy
STAMP=$(date +%Y%m%d-%H%M%S)
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ -f "$EDGE/Caddyfile" ] && [ -f "$EDGE/docker-compose.yml" ] || { echo "$EDGE fehlt, nimm install.sh"; exit 1; }

say "Code nach $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 https://github.com/elija-7580/Based "$DIR"; fi

say "Alten eigenen Caddy-Versuch aufräumen (falls vorhanden)"
if [ -f "$DIR/deploy/website/docker-compose.yml" ]; then
  (cd "$DIR/deploy/website" && docker compose down --remove-orphans 2>/dev/null) || true
fi
docker volume rm website_caddy-data website_caddy-config >/dev/null 2>&1 || true

say "Warteliste-Dienst im Netz 'edge' starten"
(cd "$DIR/deploy/website/edge" && docker compose up -d --remove-orphans)

say "edge-caddy erweitern (Sicherung: *.bak-basednotes-$STAMP)"
cp "$EDGE/Caddyfile" "$EDGE/Caddyfile.bak-basednotes-$STAMP"
cp "$EDGE/docker-compose.yml" "$EDGE/docker-compose.yml.bak-basednotes-$STAMP"
restore() {
  echo "Fehler, stelle edge-caddy wieder her"
  cat "$EDGE/Caddyfile.bak-basednotes-$STAMP" > "$EDGE/Caddyfile"
  cp "$EDGE/docker-compose.yml.bak-basednotes-$STAMP" "$EDGE/docker-compose.yml"
  (cd "$EDGE" && docker compose up -d) || true
  exit 1
}
# Site block: replace an earlier copy, else append. Write in place (keeps the inode of the bind mount).
python3 - "$EDGE/Caddyfile" "$DIR/deploy/website/edge/basednotes.caddy" <<'PY'
import re, sys
cf, block = sys.argv[1], open(sys.argv[2]).read().strip() + "\n"
s = open(cf).read()
pat = re.compile(r"# >>> basednotes\.app.*?# <<< basednotes\.app\n?", re.S)
s = pat.sub(block, s) if pat.search(s) else s.rstrip("\n") + "\n\n" + block
with open(cf, "r+") as f:
    f.seek(0); f.write(s); f.truncate()
PY
if ! grep -q '/srv/basednotes:ro' "$EDGE/docker-compose.yml"; then
  sed -i "s#^\(\s*\)- /srv/publit-site:/srv/publit-site:ro#&\n\1- $DIR/apps/website/public:/srv/basednotes:ro#" "$EDGE/docker-compose.yml"
  grep -q '/srv/basednotes:ro' "$EDGE/docker-compose.yml" || restore
fi
docker exec edge-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || {
  docker exec edge-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5; restore; }

say "edge-caddy mit neuem Ordner neu starten (wenige Sekunden)"
(cd "$EDGE" && docker compose up -d) || restore
sleep 4
docker ps --filter name=edge-caddy --format '{{.Names}}: {{.Status}}' | grep -q Up || restore

say "Automatische Updates aus main alle 10 Minuten"
echo "*/10 * * * * root cd $DIR && git pull -q --ff-only && (cd deploy/website/edge && docker compose up -d) >/dev/null 2>&1" > /etc/cron.d/based-site

say "Status"
docker ps --filter name=basednotes-waitlist --filter name=edge-caddy --format '{{.Names}}: {{.Status}}'
docker exec basednotes-waitlist wget -qO- http://127.0.0.1:8790/api/health && echo "  (Warteliste läuft)"
echo "Fertig. Caddy holt das Zertifikat, sobald das DNS auf diesen Server zeigt."
