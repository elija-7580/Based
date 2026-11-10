#!/bin/sh
# BSD-75: tägliches Backup der Server-Datenbank (sqlite3 .backup ist auch bei laufendem Server konsistent).
# Behält die Sicherungen der letzten 7 Tage. Läuft im backup-Dienst von docker-compose.ts.yml.
set -u
apk add --no-cache sqlite >/dev/null 2>&1 || true
while true; do
  day=$(date +%F)
  if sqlite3 -readonly /data/based.sqlite ".backup /backup/based-$day.sqlite"; then
    echo "backup ok $day"
  else
    echo "backup failed $day" >&2
  fi
  # Ältere als 7 Tage entfernen (nur unsere eigenen Dateien im Backup-Ordner).
  for f in /backup/based-*.sqlite; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .sqlite)
    d=${name#based-}
    if [ "$(date -d "$d" +%s 2>/dev/null || echo 0)" -lt "$(( $(date +%s) - 7 * 86400 ))" ]; then rm "$f"; fi
  done
  sleep 86400
done
