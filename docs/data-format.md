# Datenformat: was fest ist, was sich noch ändert

Stand 18. 11. 2026 · BSD-569. Frage dahinter: Bleiben die Daten eines Beta-Testers bis zur Release-Version so, wie sie
sind? Diese Seite sagt je Schicht, was gilt. Sie wird bei jeder Formatänderung nachgeführt.

## Regeln (gelten für jede Änderung)

- **Nur anhängen.** Neue Felder sind optional, neue Werte kommen in offene Aufzählungen. Kein Feld ändert seine
  Bedeutung, keines wird umbenannt. Unbekannte Felder und Blockarten bleiben beim Lesen und Schreiben erhalten (ADR 0002).
- **Jede Änderung an der Datei braucht eine Migration** in `packages/sync/src/migrations.ts` (anhängen, nie ändern), mit
  Sicherung vorher und einem Test, der eine Datei der Vorversion öffnet.
- **Beta-Dateien sind eingefroren.** `packages/sync/test/fixtures/beta/` hält je Beta-Version eine echte Datei; der
  aktuelle Stand muss jede öffnen und denselben Inhalt lesen (`beta-fixtures.test.ts`). Dateien dort nie ändern oder
  löschen; zu jedem Beta-Build kommt eine dazu.
- **Der Rückweg ist das Based-Archiv** (`.based.zip`, Version 2). Es bleibt im alten, tragbaren Format, die App
  schreibt es vor jedem Update. Eine neuere App liest jedes ältere Archiv.
- Eine Datei aus einer neueren App öffnet eine ältere nicht (`newerFormat`), statt sie falsch zu lesen.

## Stand je Schicht

| Schicht | Stand | Für Beta-Daten heißt das |
|---|---|---|
| Records (Seiten, Blöcke, Zeilen, Ansichten) | fest, nur additiv | bleiben, wie sie sind |
| Datenbank-Spalten als eigene Records (ADR 0014) | **neue Dateien beginnen so (BSD-569)**; alte werden ausdrücklich umgestellt | wer mit der Beta anfängt, braucht keine Umstellung |
| Workspace-Listen (Favoriten, Teamspaces) als feinere Records | offen (ADR 0014, Schritt 9) | spätere Migration, ohne Verlust |
| Prozent-Zahlen | fest: gespeichert wird der Anteil (0.25 = 25 %), wie Notion (BSD-564) | – |
| Datum ohne Uhrzeit | **offen: gespeichert als Mitternacht in der Zeitzone des Geräts** (s. u.) | Migration nötig, je früher desto sauberer |
| Wer hat geschrieben (`createdBy`, `updatedBy`, Personen-Werte) | heute `"me"` | wird beim ersten Konto durch die Nutzerkennung ersetzt; eindeutig, solange nur ein Mensch im Workspace schreibt (Beta: ja) |
| Herkunft Mensch/Agent (`origin`, `author`) | im Format (BSD-522) | – |
| Datei `based.sqlite` | Schema 3 bzw. 4; Schema „v4 mit Spalten“ und Tabellen für Verlauf und Y-Zustände geplant (ADR 0017 B) | Migration mit Sicherung und Probelauf |
| Kompakte Records, Umschlag für Ende-zu-Ende (ADR 0017 C) | geplant vor Based Cloud, eine Umstellung | Migration; Inhalt bleibt gleich |
| Ort der Daten am Mac | OPFS im Datenbereich der App (`~/Library/WebKit/<Kennung>/`); natives SQLite geplant | Umzug der Datei, kein Formatwechsel |
| Sync-Protokoll | 2 (alt) bzw. 3 (Spalten als Records); 4 geplant | Server und App melden „Update nötig“ statt Daten zu mischen |
| Based-Archiv | Version 2, fest | – |
| Import-Kennungen (Notion-ID → Record-ID, Fingerabdruck) | fest; derselbe Notion-Export aktualisiert statt zu verdoppeln | nicht ändern, sonst verdoppelt ein erneuter Import |

## Offen: Datum ohne Uhrzeit

Ein Datum ohne Uhrzeit wird als Zeitpunkt gespeichert: Mitternacht in der Zeitzone des Geräts. „18. November“ aus
Wien ist `2026-11-17T23:00Z`. Auf einem Gerät oder Server in einer Zeitzone westlich davon (UTC-Server für MCP und
Cloud-Agenten, Reise, geteilter Workspace) steht dort der 17. November. Nachgemessen am 18. 11. (Wien → UTC → New
York). Die Tests laufen alle in UTC und sehen das nicht.

Vorschlag: Ein Datum ohne Uhrzeit ist ein Kalendertag, kein Zeitpunkt – gespeichert als Mitternacht UTC, gelesen und
gezeigt in UTC. Vorhandene Werte stellt eine Migration auf dem Gerät um (das Gerät kennt seine Zeitzone). Je weniger
Daten bis dahin entstehen, desto weniger kann die Zeitzone inzwischen gewechselt haben.

## Was die Beta garantieren kann

- Inhalt geht nicht verloren: Datei-Migrationen laufen mit Sicherung, vor jedem Update entsteht ein Archiv, jede
  Beta-Datei bleibt als Testfall im Repo.
- Die Datei selbst wird sich bis zur Release-Version noch ändern (Schema v4, kompakte Records, Verschlüsselung).
  Das sind Umstellungen der Verpackung; Seiten, Blöcke und Werte bleiben dieselben.
