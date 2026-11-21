# basednotes.app online stellen

Die Website (`apps/website/public`, fertig gebaut im Repo) und der Warteliste-Dienst (`apps/website/server/waitlist.mjs`)
laufen zusammen auf einem kleinen Server. Caddy holt das TLS-Zertifikat selbst und schreibt keine Zugriffsprotokolle.

## Schnellweg auf einem bestehenden Server

```bash
ssh root@<server> 'curl -fsSL https://raw.githubusercontent.com/elija-7580/Based/main/deploy/website/install.sh | bash'
```

Prüft, ob 80/443 frei sind, installiert bei Bedarf Docker und git, startet Caddy + Warteliste und holt alle 10 Minuten Updates aus `main`.

## Einmalig (neuer Server)

1. **Server:** In der Hetzner Cloud Console einen CX22 anlegen (Standort Nürnberg oder Falkenstein, damit die Daten in
   Deutschland liegen, wie es in der Datenschutzerklärung steht), Image „Docker CE“ aus den Apps, SSH-Schlüssel hinterlegen.
2. **Auftragsverarbeitung:** In der Hetzner Console unter *Datenschutz* den Vertrag zur Auftragsverarbeitung (AVV) abschließen.
   Die Datenschutzerklärung verweist darauf.
3. **DNS** (Hetzner DNS Console, Zone `basednotes.app`):
   - `A` `@` → IPv4 des Servers, `AAAA` `@` → IPv6 des Servers
   - `CNAME` `www` → `basednotes.app.`
4. **Mail für hello@basednotes.app:** z. B. iCloud+ → Einstellungen → *Eigene E-Mail-Domain* → `basednotes.app` hinzufügen.
   Apple zeigt die nötigen `MX`-, `TXT`- (SPF, Verifizierung) und `CNAME`-Einträge (DKIM) an; diese in der Hetzner DNS Console
   eintragen, dann `hello@basednotes.app` anlegen.
5. **Starten:**
   ```bash
   ssh root@<server>
   git clone --depth 1 https://github.com/elija-7580/Based && cd Based/deploy/website
   cp .env.example .env        # ACME_EMAIL prüfen
   docker compose up -d
   curl -s https://basednotes.app/api/health    # {"ok":true}
   ```

## Aktualisieren

```bash
cd Based && git pull && docker compose -f deploy/website/docker-compose.yml restart caddy
```

Von selbst: der Cron holt `main` alle 10 Minuten. Der Warteliste-Dienst merkt eine geänderte `waitlist.mjs`
(`WAITLIST_RELOAD=1`) und startet sich innerhalb von etwa zwei Minuten mit dem neuen Code neu; laufende Downloads
dürfen bis zu 10 Minuten zu Ende laufen. Ein Neustart von Hand ist dafür nicht mehr nötig.

Die Seiten neu bauen (nach einer Änderung im Canvas oder an den Texten): `pnpm --filter @based/website build`
(mit Google Chrome auf dem Rechner werden die Seiten vorgerendert) und `apps/website/public` committen.

## Warteliste verwalten

```bash
docker compose exec waitlist node --no-warnings waitlist.mjs export        # CSV auf die Konsole
docker compose exec waitlist node --no-warnings waitlist.mjs ideas         # Ideen von der Roadmap
docker compose exec waitlist node --no-warnings waitlist.mjs delete a@b.c  # Löschwunsch erfüllen
docker compose exec waitlist node --no-warnings waitlist.mjs purge         # Einträge älter als 24 Monate löschen (Berichte: 90 Tage)
```

Die Datenbank liegt im Volume `waitlist-data` (`/data/waitlist.sqlite`). Sicherung:
`docker compose exec -T waitlist sh -c 'cat /data/waitlist.sqlite' > waitlist-$(date +%F).sqlite`.

## Beta-Einladungen (BSD-553)

Die Mac-Beta gibt es nur mit persönlichem Link: `https://basednotes.app/download?i=<token>`, 30 Tage gültig,
höchstens 5 Downloads. `GET /api/download?i=<token>` prüft das Token und liefert `/srv/based-beta/Based-Notes-Beta.dmg`
(im Container `/beta`). Die DMG lädt der Workflow „Desktop Beta“ per rsync hoch; einrichten mit
`bash ci/setup-beta-deploy.sh root@<server>` (Schlüssel, Benutzer `based-beta`, Secrets). Ohne die Secrets hängt der
Workflow die DMG wie früher öffentlich an die Releases.

```bash
# im Ordner deploy/website (bzw. deploy/website/edge auf dem Server mit edge-caddy)
docker compose exec waitlist node --no-warnings waitlist.mjs invite a@b.c          # Link ausgeben (vorhandener wird wiederverwendet)
docker compose exec waitlist node --no-warnings waitlist.mjs invite a@b.c --new    # alten Link sperren, neuen ausgeben
docker compose exec -T waitlist node --no-warnings waitlist.mjs invite --wave - < welle1.txt   # eine Adresse pro Zeile, CSV zurück
docker compose exec waitlist node --no-warnings waitlist.mjs invites               # Liste mit Status und Downloads
docker compose exec waitlist node --no-warnings waitlist.mjs revoke a@b.c          # Link sperren
```

`invites` meldet am Ende, ob die DMG auf dem Server liegt. Ohne DMG antwortet der Download mit 503 und zählt nichts.
`purge` löscht Einladungen 30 Tage nach Ablauf (steht so in der Datenschutzerklärung).

## Zahlen von außen prüfen (BSD-631)

Damit Elija und die Agenten ohne SSH sehen, ob die Warteliste speichert, gibt es zwei Lese-Routen. Sie zeigen nur
Zahlen bzw. Ja/Nein, nie eine Adressliste, und sind aus (404), solange kein Token gesetzt ist.

Einmalig am Server (5 Minuten):

```bash
cd Based/deploy/website            # bzw. Based/deploy/website/edge (Server mit edge-caddy)
openssl rand -hex 24               # Token erzeugen
echo 'WAITLIST_STATS_TOKEN=<das Token>' >> .env
docker compose up -d waitlist
```

Das Token dann auf einer privaten Notion-Seite „Based — Zugänge für Agenten“ ablegen (nur dieses Token, es zeigt nur
Zahlen). Prüfen:

```bash
curl -s -H "Authorization: Bearer <Token>" https://basednotes.app/api/waitlist/stats
# {"count":12,"last_created_at":"2026-11-20T…","invites_active":0,"reports":{"total":0,"in_backlog":0,"waiting":0,"notion":false}}
curl -s -H "Authorization: Bearer <Token>" "https://basednotes.app/api/waitlist/check?email=a@b.c"
# {"listed":true,"created_at":"2026-11-20T…"}
```

Falsches Token: 401. Gleiches Ratenlimit wie die Formulare (8 Abrufe je 10 Minuten und Adresse).

## Problemberichte aus der App ins Backlog (BSD-632)

In der App schickt ⇧⌘B → „Send to Based“ den Bericht an `POST /api/report`. Der Dienst speichert ihn unter
`/data/reports/<id>.json` (+ `.png`, falls ein Bildschirmfoto dabei ist) und legt im Notion-Backlog einen Eintrag an:
Name „Mac-Beta · Bericht <Datum> – <Version>, <System>“, Status Inbox, Quelle Log/Bericht, Typ Bug, im Inhalt Notiz,
Zusammenfassung, Layout-Funde, letzte Schritte, Bildschirmfoto und das Bündel als Datei. Ohne Einrichtung werden die
Berichte nur gespeichert; nichts geht verloren, sie gehen nach der Einrichtung von selbst nach Notion. Klappt Notion
nicht, versucht der Dienst es wieder (5 Minuten, dann doppelt so lange, höchstens 6 Stunden, 12 Versuche). Nach 90 Tagen
werden die Berichte auf dem Server gelöscht.

Einmalig einrichten (10 Minuten):

1. In Notion: **Settings → Connections → Develop or manage integrations** (öffnet notion.so/profile/integrations)
   → **New integration**: Name „Based Server“, Workspace „Elijás Second Brain“, Typ **Internal** → Save.
2. Bei der Integration unter **Capabilities** „Read content“, „Update content“ und „Insert content“ anhaken, sonst
   nichts (keine Nutzerinformationen). Dann den **Internal Integration Secret** kopieren (beginnt mit `ntn_`).
3. Die Datenbank **Based Backlog** öffnen → oben rechts **•••** → **Connections** → **Based Server** hinzufügen.
   (Nur diese Datenbank, damit der Schlüssel sonst nichts sieht.)
4. Am Server:
   ```bash
   cd Based/deploy/website            # bzw. Based/deploy/website/edge
   cat >> .env <<'ENV'
   NOTION_TOKEN=ntn_…
   NOTION_BACKLOG_DATA_SOURCE=756f15b3-f24d-4b7c-aecf-88ed8fac1119
   ENV
   docker compose up -d waitlist
   ```
5. Prüfen: in der App ⇧⌘B → „Send to Based“ → „Sent“. Nach ein paar Sekunden steht der Eintrag im Backlog (Inbox).
   Am Server:
   ```bash
   docker compose exec waitlist node --no-warnings waitlist.mjs reports         # Liste, Spalte notion_page
   docker compose exec waitlist node --no-warnings waitlist.mjs reports retry   # aufgegebene erneut senden
   ```
   Oder ohne SSH über `stats` (oben): `reports.in_backlog` zählt hoch, `reports.notion` ist `true`.

`.env` ist in git ausgeschlossen (`deploy/**/.env`) und bleibt beim automatischen Update erhalten.

## Später: based-server auf derselben Maschine

Den Block `sync.basednotes.app` in `Caddyfile` einkommentieren und den Dienst `based` aus `deploy/docker-compose.yml`
in diese Compose-Datei übernehmen (nur ein Caddy pro Server, weil beide die Ports 80/443 brauchen).
