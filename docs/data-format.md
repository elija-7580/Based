# Datenformat: was fest ist, was sich noch ändert

Stand 18. 11. 2026 · BSD-569, BSD-578, BSD-579. Frage dahinter: Bleiben die Daten eines Beta-Testers bis zur Release-Version so, wie sie
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
| Datum ohne Uhrzeit | **fest (BSD-578): trägt den Kalendertag `day` / `endDay`**, gilt in jeder Zeitzone | neue Werte sind eindeutig; ältere ohne `day` bekommen ihn bei der nächsten Änderung |
| Wer hat geschrieben (`createdBy`, `updatedBy`, Personen-Werte) | fest als Regel: **`"me"` heißt „der Besitzer des Workspaces“** (s. u.) | kein Record wird je umgeschrieben; das erste Konto setzt einmal `workspace.ownerID` |
| Herkunft Mensch/Agent (`origin`, `author`) | im Format (BSD-522) | – |
| Datei `based.sqlite` | Records als Zeilen, fest; Spalten und Indizes darüber sind abgeleitet (ADR 0017 B) | Index-Aufbau beim Start, keine Umstellung der Daten |
| Kompakte Records, Umschlag für Ende-zu-Ende (ADR 0017 C) | geplant vor Based Cloud – nach dem Grundsatz unten: beides lesen, Neues schreiben | bestehende Records bleiben, wie sie sind |
| Ort der Daten am Mac | OPFS im Datenbereich der App (`~/Library/WebKit/<Kennung>/`); natives SQLite geplant | Umzug der Datei, kein Formatwechsel |
| Sync-Protokoll | 2 (alt) bzw. 3 (Spalten als Records); 4 geplant | Server und App melden „Update nötig“ statt Daten zu mischen |
| Based-Archiv | Version 2, fest | – |
| Import-Kennungen (Notion-ID → Record-ID, Fingerabdruck) | fest; derselbe Notion-Export aktualisiert statt zu verdoppeln | nicht ändern, sonst verdoppelt ein erneuter Import |

## Grundsatz: keine Datei wird als Ganzes umgeschrieben (Elija, 18. 11. 2026)

Ein Update darf nie alle Records eines Workspaces neu schreiben müssen. Daraus folgt für jede künftige Änderung:

1. **Beides lesen, Neues schreiben.** Eine neue Form eines Records (kompakter, mit Zusatzfeld, verschlüsselt) wird
   gelesen, sobald die App sie kennt; geschrieben wird sie nur für Records, die sich ohnehin ändern. Alte Records
   bleiben gültig – für immer, nicht für eine Übergangszeit.
2. **Bedeutung steht im Record, nicht im Gerät.** Was von Zeitzone, Sprache, Nutzer oder Einstellung des schreibenden
   Geräts abhängt, wird mitgeschrieben (Beispiel: `day` beim Datum). Sonst ließe es sich später nur durch Umschreiben
   retten.
3. **Abgeleitetes ist kein Format.** Spalten und Indizes der Datei (`parent`, `sk`, Suchindex, Link-Tabelle,
   Vektoren) werden aus den Records gebaut und dürfen jederzeit neu entstehen. Das ist ein Index-Aufbau, keine
   Umstellung der Daten (so macht es schon „Fast start“, ADR 0017 B1).
4. **Neue Record-Arten statt Umbau alter.** Wird etwas feiner (Workspace-Listen), kommt eine neue Art dazu; die alte
   Liste bleibt als Rückweg stehen, wie bei den Spalten (ADR 0014).

Was das für die geplanten Schritte heißt – sie sind so zu bauen, nicht als eine große Umstellung (ändert ADR 0017
„eine Formatumstellung statt mehrerer“):

| Geplant | So, dass nichts umgeschrieben wird |
|---|---|
| Kompakte Records (ADR 0017 C) | zweite Schreibform mit Kennzeichen je Zeile; der Leser kann beide; eine Spalte dafür lässt sich in SQLite ohne Umschreiben anhängen |
| Ende-zu-Ende-Verschlüsselung | betrifft den Weg zum Server und dessen Ablage, nicht die lokale Datei; der Server bekommt die Records beim nächsten Sync verschlüsselt |
| Bereich je Record (`scope`) für geordneten Pull und Agenten-Zugriff | ergibt sich aus der Eltern-Kette; wird berechnet und als Spalte geführt, nicht in jeden Record geschrieben |
| Zugriffsstufe für Agenten (Private / Balanced / Open) | Feld an Workspace, Teamspace oder Seite; additiv |
| Erinnerungen der Agenten | gewöhnliche Records (Datenbank); Vektoren sind abgeleitet und werden nie synchronisiert |
| Chat-Verläufe als Ereignisse | in der Beta entstehen keine (AI ist aus); das Ereignis-Format kommt, bevor AI eingeschaltet wird |
| Sprecher im Transkript | Zusatzfeld je Abschnitt; ohne Feld gilt „unbekannt“ |
| Natives SQLite am Mac | dieselbe Datei an einem anderen Ort; einmal kopieren, nicht umschreiben |
| Konten und Teilen | `"me"` behält seine Bedeutung (unten); neue Schreiber tragen ihre Kennung |

## Festgelegt: `"me"` (BSD-579)

`createdBy`, `updatedBy`, Personen-Werte und Personen-Erwähnungen tragen heute `"me"`. Das heißt ab jetzt verbindlich:
**der Besitzer dieses Workspaces.** Solange es keine Konten gibt, ist das der eine Mensch am Gerät. Mit dem ersten
Konto schreibt die App einmal `workspace.ownerID`; jeder Leser setzt `"me"` damit gleich. Andere Menschen und Agenten
schreiben von Anfang an ihre eigene Kennung (`u-…`, `g-…`, `a-…`, BSD-522). Kein Record muss dafür je geändert werden.
Voraussetzung, die deshalb gilt: Vor Konten darf kein zweiter Mensch als `"me"` in denselben Workspace schreiben
(Gäste schreiben als Gast).

## Festgelegt: Datum ohne Uhrzeit (BSD-578)

Bisher war ein Datum ohne Uhrzeit nur ein Zeitpunkt: Mitternacht in der Zeitzone des schreibenden Geräts.
„18. November“ aus Wien ist `2026-11-17T23:00Z` und stand auf einem UTC-Server oder in New York als 17. November
(nachgemessen am 18. 11.). Jetzt trägt der Wert zusätzlich den Tag: `day: "2026-11-18"`, bei Bereichen `endDay`.

- Geschrieben wird `day` überall, wo ein Datum entsteht: beim Lesen von Text (`parseDate`, alle Importe, Notion-API)
  und bei jeder eigenen Änderung im Store (`withCalendarDays`). Was von einem anderen Gerät kommt, behält dessen Tag.
- Gelesen wird über `resolveDate`: Datenbank-Abfragen (Filter, Sortierung, Kalender, Timeline, Formeln) und die
  Anzeige nehmen den Tag. `start` bleibt für ältere Stände und als Sortierwert.
- Der Import-Fingerabdruck rechnet ohne `day`; ein erneuter Notion-Import erkennt Unverändertes weiter.
- Werte ohne `day` (vor dieser Änderung entstanden) bleiben, wie sie sind, und bekommen den Tag, wenn sie das nächste
  Mal geändert werden. Niemand schreibt sie in einem Durchgang um.
- Noch offen (Verhalten, kein Format): Datumsauswahl in der Zelle und Datums-Erwähnungen im Editor lesen noch `start`
  direkt. Auf dem Gerät, das geschrieben hat, ist das dasselbe; in einer anderen Zeitzone zeigt die Auswahl bis dahin
  den Nachbartag, die Zelle den richtigen.
- Die Suite läuft in UTC. Den Zeitzonen-Fall prüft `calendar-day.test.ts` in eigenen Prozessen (Wien, UTC, New York,
  Tokio, Auckland).

## Was die Beta garantieren kann

- Inhalt geht nicht verloren: Datei-Migrationen laufen mit Sicherung, vor jedem Update entsteht ein Archiv, jede
  Beta-Datei bleibt als Testfall im Repo.
- Kein Update schreibt den Workspace als Ganzes um (Grundsatz oben). Neue Formen kommen dazu und werden gelesen;
  alte Records bleiben gültig.
- Was sich noch ändern darf: abgeleitete Indizes in der Datei und ihr Ort am Mac.
