# ADR 0017: Speicher und Sync für große Workspaces, alte Geräte und das Web

- **Status:** angenommen (2026-11-17, Elija) – Richtung und die Entscheidungen unten. Umsetzung auf Elijas Wort ab
  17.11. direkt auf main, Stufe A zuerst (Stand siehe „Umsetzung“; Notion: „Based — Speicher und Sync: Befund und Plan“).
- **Maßstab (Elija):** langfristig am stabilsten, schnellsten und verlässlichsten – der Aufwand entscheidet nicht.
- **Bezug:** ADR 0001 (Server-Sync), 0002 (Tombstones), 0003 (Persistenz neben dem Hauptthread), 0008 (Zusammenarbeit
  vorbereiten), 0011 (TypeScript-Stack), 0014 (Properties als Records), 0015 (Ordner-Sync), `docs/sync-protocol.md`,
  `docs/platforms.md` („Performance budget“).
- **Messskripte:** `spikes/storage-bench/` (nicht in Paketen oder CI).

## Anlass

Elija, 17.11.: Sync und Speicherung sollen so effizient wie möglich sein – mit Blick auf alles Geplante (iPhone,
iPad, Android, Web, Based Cloud in der EU, Ende-zu-Ende-Verschlüsselung, Echtzeit, große Datenbanken, Whiteboard),
auf alten Geräten und im Web, „extrem schnell“. Die Grundlage soll jetzt gelegt werden.

## Wie es heute ist

1. **Alles im Speicher.** Beim Start liest der Store-Worker jede Zeile aus `records`, dekodiert sie, parst JSON,
   prüft sie mit Zod und baut den Kinder-Index (`SqlitePersistence.loadAll`, `WorkspaceStore`-Konstruktor). Start und
   Arbeitsspeicher wachsen mit der Zahl der Blöcke, nicht mit dem, was offen ist.
2. **Der Hauptthread ist schon teilweise.** Er bekommt Gliederung und Titel aller Seiten und je offener Seite eine
   Replik mit deren Teilbaum (`openPage`). Das Muster „teilweiser Store“ gibt es also – nur nicht im Worker.
3. **Datei:** `records(kind, id, data)` mit dem ganzen Payload als JSON-BLOB; `parent`, `type` und `sk` stehen nur
   im JSON. Format gleich wie die eingefrorene Swift-App (deshalb auch `history.sqlite` und `ydocs.sqlite` als
   Nebendateien statt Tabellen).
4. **Browser:** SQLite-WASM auf OPFS („opfs-sahpool“, kein WAL). Der Treiber bereitet jede Anweisung bei jedem
   Aufruf neu vor. Dauerhafter Speicher (`navigator.storage.persist()`) wird nicht angefragt.
5. **Sync v2:** JSON über HTTPS, LWW je Record nach HLC-Stempel, Cursor = Änderungsnummer des Servers. Pull in
   Seiten zu 500 Records, Push ohne Kompression (Antworten komprimiert Caddy auf dem Server). Jedes Gerät holt den
   ganzen Workspace.
6. **Server:** hält je Workspace einen ganzen `WorkspaceStore` im Arbeitsspeicher (Sync, MCP, Teilen, Agenten).
   Für Gäste filtert er den Pull schon je Record nach Rolle (`share.ts`).
7. **Gliederung:** bei jeder Strukturänderung baut der Worker sie ganz neu und schickt sie ganz an den Hauptthread.

## Messungen (17.11.2026)

Künstlicher Workspace aus Seiten mit je 25 Blöcken (Text, Listen, To-dos, Überschriften), Ø 376 B JSON je Record.
Maschine: Linux-Container, schneller als jedes Zielgerät – die Zahlen sind eine Untergrenze. Elijas echter Stand
war 71 578 Records vor dem Notion-Import; sein Notion-Workspace hat rund 20 000 Seiten.

**Node (natives SQLite), 520 000 Records = 20 000 Seiten**

| Schritt | Zeit |
| --- | --- |
| Zeilen lesen | 2 232 ms |
| UTF-8 dekodieren | 410 ms |
| JSON.parse | 786 ms |
| Zod-Prüfung | 1 793 ms |
| `openWorkspace` gesamt (mit Index) | 7 218 ms |
| Gliederung bauen | 498 ms |
| eine Taste (Transaktion + Schreiben) | 0,39 ms (p50) |
| **nur Seiten lesen und prüfen (Index auf `type`)** | **188 ms** |
| **Blöcke einer Seite per Index auf `parent`** | **0,04 ms (p50)** |

Datei 309 MB bei 186 MB JSON; Heap nach dem Öffnen 269 MB.

**Woraus die 186 MB bestehen:** Text 44 MB (23 %), IDs und `parent` 47 MB, `stamp` 32 MB, Zeiten als
Kommazahlen 28 MB, `createdBy`/`updatedBy` 17 MB. Voll-Pull als JSON 187 MB, gzip 39 MB, Brotli (Stufe 5) 35 MB.

**Echter Browser (Playwright, dauerhaftes Profil, Seiten mit je einem Block)**

| | 75 000 Records | 520 000 Records |
| --- | --- | --- |
| Chromium: Neuladen bis bereit | 1,5–1,8 s | 10,3–11,2 s |
| WebKit: Neuladen bis bereit | 2,2–2,4 s | 10,5–10,9 s |
| Chromium, Hauptthread 6-fach gedrosselt | 3,4–3,7 s | – |
| belegter Speicher (OPFS) | 77 MB | 269 MB |

Die Drosselung trifft nur den Hauptthread, nicht den Worker; ein altes Gerät ist also langsamer als diese Zeile.

**SQLite im Browser-Modus gegen nativ, 100 000 Records schreiben (wie beim ersten Sync oder Import):** WASM mit dem
heutigen Treiber 6 297 ms, nativ mit vorbereiteten Anweisungen 1 788 ms.

## Was daraus folgt

- Bis etwa 75 000 Records ist der Start in Ordnung. Ab einigen hunderttausend (Elijas Notion-Import, jede Team-Nutzung)
  wird er auf schnellen Rechnern zweistellig in Sekunden, und 270 MB Heap im Worker sind auf einem alten iPad oder
  Android-Gerät ein Absturzrisiko. **Das ist die eine Stelle, die nicht mitwächst.**
- Tippen und Seitenwechsel sind nicht das Problem (unter 1 ms je Schreiben, Seite per Index in 0,04 ms).
- Über das Netz bringt Kompression fast alles (187 → 39 MB); ein kompakteres Record-Format spart vor allem Platte
  und Parse-Zeit, nicht Bandbreite.
- Die Kosten von Based Cloud hängen am Arbeitsspeicher des Servers je Workspace, nicht an der Platte.

## Vorschlag

### Stufe A – ohne Formatänderung (klein, jeweils einzeln messbar)

1. **Vorbereitete Anweisungen im WASM-Treiber** (wie im Node-Treiber). Erwartet: Massen-Schreiben rund 3× schneller.
2. **Laden ohne doppelte Arbeit:** Zeilen in Stücken lesen statt alle auf einmal; Zod beim Laden der eigenen Datei
   nur für Records, die dieses Gerät nicht selbst geprüft geschrieben hat (Merker je Schema-Version). Spart rund ein
   Viertel der Ladezeit und die Speicherspitze.
3. **Pull nach Größe statt 500 Stück** (Ziel etwa 1–2 MB je Seite), Push-Körper komprimiert
   (`CompressionStream`), der lokale Server komprimiert Antworten selbst.
4. **Dauerhaften Speicher anfragen** (`navigator.storage.persist()`), Stand in Einstellungen → Sync zeigen. Safari
   löscht die Daten einer Website nach sieben Tagen Safari-Nutzung ohne Besuch der Seite (nicht bei Apps auf dem
   Home-Bildschirm und nicht in der Mac-App); wer im Web ohne Server arbeitet, muss das wissen.
5. **Gliederung als Änderung** statt ganz neu bauen und schicken.
6. **Ordner-Sync:** Segmente komprimiert schreiben.
7. **Zeitmessung ins Gate:** 100 000 Records – Start, Heap, erster Sync – als `@perf` mit Schwellen.

### Stufe B – lokales Schema v4: Inhalt erst beim Öffnen laden

- `records` bekommt echte Spalten `parent`, `type`, `sk`, `trashed` und einen Index auf `(parent, sk)`.
- Beim Start lädt der Worker nur das **Gerüst**: Workspace, Seiten, Datenbanken, Ansichten, Properties. Der Inhalt
  einer Seite kommt beim Öffnen (wie heute die Replik im Hauptthread), Zeilen einer Datenbank beim Öffnen einer
  Ansicht. Gemessen: 188 ms statt 7,2 s für 20 000 Seiten.
- Alles, was heute über alle Blöcke läuft, wandert in SQL: Suche (FTS5 statt Index im Speicher), Backlinks und
  Graph (Tabelle `links`), Papierkorb/Duplizieren (rekursive Abfrage), Export und Backups (streamen), Waisen-Rettung.
  Das ist der eigentliche Aufwand – nicht die Spalten.
- `history` und `ydocs` können dann Tabellen derselben Datei werden (eine Datei, ein Backup).
- Voraussetzung: Die Datei muss nicht mehr von der Swift-App geöffnet werden können (Frage 1).

### Stufe C – Protokoll v4, alles in einer Umstellung (wie BSD-30, mit Probelauf auf Elijas Workspace)

- **Kompakte Records:** Stempel als Zeichenkette `millis:counter:node`, Zeiten als ganze Millisekunden,
  `createdBy`/`updatedBy` nur wenn nicht Standard. Rund ein Drittel weniger Bytes (Schätzung aus den Anteilen oben).
- **Sync in Reihenfolge, immer vollständig:** Jedes Gerät hat den ganzen Workspace offline (entschieden). Der
  Pull kommt aber nach Bereich geordnet – erst das Gerüst (in Sekunden benutzbar), dann der Inhalt nach Wichtigkeit
  (offene Seite, zuletzt benutzt, Favoriten), dann der Rest im Hintergrund; unterbrechbar und fortsetzbar. Die
  Oberfläche zeigt ehrlich, wie viel schon da ist. Der Server kann je Record filtern (Gäste); das wird der
  allgemeine Weg. Ein Gerät, das nur einen Teil hält, gibt es nicht.
- **Umschlag für Ende-zu-Ende:** im Klartext nur `id`, `kind`, `stamp`, `scope` (die Seite, zu der der Record
  gehört) und gelöscht ja/nein; alles andere verschlüsselt. Damit funktionieren Cursor, LWW und der geordnete Pull,
  ohne dass der Server Inhalte liest. Suche und MCP auf dem Server gibt es nur in Bereichen, die für Agenten offen
  sind (siehe „Bereiche und Agenten“).
- **Erster Sync als Strom:** ein komprimierter Schnappschuss (eine Antwort, Zeile für Zeile verarbeitet) statt
  hunderter Seiten.

### Stufe D – Server für viele Workspaces (vor Based Cloud)

Push und Pull vergleichen nur Schlüssel und Stempel; dafür braucht der Server keinen Store im Arbeitsspeicher. Der
Sync-Kern arbeitet direkt auf SQLite, ein Store wird nur geladen, wenn MCP, Teilen oder ein Agent ihn braucht, und
nach Leerlauf wieder entlassen. Mit E2E ist das ohnehin der einzige Weg.

### Regeln für Neues (gelten ab jetzt)

- **Tinte (vor BSD-265):** nicht ein Record je Strich. Der Umschlag eines Records wiegt rund 300 B, ein kurzer
  Strich (20 Punkte) 109 B. Striche eines Zugs (gleicher Stift, kurze Pause, nah beieinander) kommen in ein Objekt mit
  mehreren Strichen, bis etwa 8 KB; Radieren teilt.
- **Große Datenbanken:** Zeilen werden je Datenbank geladen, nicht mit dem Workspace. Über etwa 50 000 Zeilen
  filtert und sortiert SQLite, nicht JavaScript.
- **Echtzeit-Text:** Y-Zustände bleiben neben den Records (Records als lesbare Sicht), wie in ADR 0008 und
  `docs/server.md`; sie gehören zum Bereich ihrer Seite und werden mit ihr geladen und entlassen.
- **Dateien:** lokale Blobs, die 90 Tage kein Record nennt, dürfen gelöscht werden (der Server tut das schon).
- **Versionsverlauf:** Obergrenze je Seite und Gesamtgröße sichtbar in den Einstellungen.

## Reihenfolge

Stufe A ist unabhängig und klein. Stufe B ist der große Hebel für alte Geräte und das Web und sollte vor Mobil
(Phase 5) fertig sein. Stufe C und D gehören vor Based Cloud; C zusammen entwerfen, weil E2E-Umschlag, Teil-Sync und
kompaktes Format dieselben Felder berühren. Elija am 17.11.: alles umsetzen, direkt nach main. Grenze dabei: Eine
Migration, die seine vorhandene Datei umschreibt (Schema v4), kommt erst mit Sicherung, Rückweg und einem Probelauf
auf seinem echten Workspace nach main.

## Umsetzung

| Teil | Stand | Gemessen |
| --- | --- | --- |
| A1 Vorbereitete Anweisungen im WASM-Treiber, Laden in Stücken | auf main (17.11.) | 100 000 Records schreiben: Chromium 6,2 s → 4,3 s, WebKit 6,0 s → 4,0 s (1,5×, nicht die erwarteten 3×); Start unverändert 2,1 s / 2,4–3,0 s |
| A3 Pull nach Größe, gzip für Push und Antworten | auf main (17.11.) | 12 000 Records: 24 Pull-Anfragen → höchstens 4; Seiten und Push auf rund ein Fünftel. Nur gegen einen Server mit diesem Stand; ein älterer bekommt unveränderte Anfragen |
| A4 Dauerhafter Web-Speicher, Zeile „Browser storage“ | auf main (17.11.) | – |
| A7 Zeitmessung `@perf` mit 100 000 Records | auf main (17.11., BSD-495: `scale-perf`) | Schwellen: Start 5 s (WebKit 7 s), Schreiben 9 s; Unit: erster Sync 6 s, Start 4 s, Heap 150 MB |
| A2 Zod beim Laden überspringen | gestrichen | Prüfung beim Laden bleibt (Sicherheit vor Tempo); der Gewinn kommt mit Stufe B |
| A5 Gliederung als Änderung, A6 Ordner-Segmente komprimiert | offen | A6 zuerst nur lesen beider Formen |
| B, C, D, Bereiche | offen | – |

## Entscheidungen (Elija, 17.11.2026)

1. `based.sqlite` muss nicht mehr von der Swift-App lesbar sein. → Schema v4 ist frei; `history` und `ydocs` dürfen
   Tabellen derselben Datei werden.
2. **Jedes Gerät hält den ganzen Workspace offline** – auch Telefon, iPad und Web. → Kein Teil-Sync als Dauerzustand.
   Umso wichtiger ist Stufe B: Auf der Platte liegt alles, im Arbeitsspeicher nur das Gerüst und das Offene.
3. **Mehrstufig statt entweder–oder** (Elija, 17.11. nachmittags; ersetzt „Suche und MCP nur auf den Geräten“):
   Agenten sollen auch ohne eingeschaltetes Gerät Kontext haben, mit vektorbasierter Memory über MCP. Ein Bereich
   ist entweder *privat* (Ende-zu-Ende, Suche und Agenten nur auf den Geräten) oder *für Agenten offen* (der Server
   darf lesen, baut den Vektor-Index und bedient MCP). Wichtigste Vorgabe: einfach und übersichtlich einstellbar,
   wenig nötig; technisch tief nur für die, die wollen. Siehe „Bereiche und Agenten“ unten.
4. Stufe A: zuerst ohne Vorgabe; am 17.11. abends: alles umsetzen, direkt nach main (A1 und der Zeitmess-Test
   zuerst, weil sie B messbar machen).
5. Größe: rund 20 000 Seiten in Elijas Workspace – die Größenordnung der 520 000-Records-Messung. Stufe B ist damit
   für den eigenen Alltag nötig, nicht erst für Mobil.

## Bereiche und Agenten (Vorschlag zur Entscheidung 3, Feinentwurf offen)

- **Zwei Stufen je Bereich, vererbt wie Rechte** (Workspace → Teamspace → Seite): *Private* und *Open to agents*.
  Teilen mit Menschen bleibt eine eigene Achse (Rollen wie heute).
- **Einfach zuerst:** ein Schalter „Let agents work while my devices are off“ (Standard aus) und drei Arbeitsweisen
  zur Wahl – *Private* (alles Ende-zu-Ende), *Balanced* (alles privat, ein Bereich „Agents“ offen), *Open* (alles
  offen). **Entschieden (Elija, 17.11.): Balanced ist die Voreinstellung, die drei Namen bleiben so.** Jede Seite zeigt ihre Stufe mit einem Zeichen; ein Klick erklärt in einem Satz, wer lesen kann.
- **Wechsel ist ausdrücklich:** privat → offen nennt die Zahl der Seiten und fragt nach; offen → privat löscht die
  lesbare Kopie und den Index auf dem Server.
- **Agent = Mitglied mit Rolle** (lesen, kommentieren, bearbeiten) nur in offenen Bereichen; er schreibt normale
  Records über den Sync (sichtbar, im Verlauf, rückgängig zu machen). Jeder Zugriff steht in einem Protokoll.
- **Memory:** Erinnerungen und ihre Relationen sind normale Records (Datenbank „Memories“, bearbeitbar). Vektoren
  sind abgeleitet, nie synchronisiert, jederzeit neu berechenbar: auf den Geräten für alles, auf dem Server nur für
  offene Bereiche.
- **Für Technische (Einstellungen → Advanced):** Rolle je Agent, Stufe je Seite, eigener Server, eigenes
  Embedding-Modell, Aufbewahrung, Zugriffsprotokoll als Export.
- **Für das Format (Stufe C):** Der Umschlag trägt je Record den Bereich und dessen Stufe; in privaten Bereichen
  reicht der Server Records und Y-Änderungen nur verschlüsselt weiter, in offenen liest er sie.

## Was aus „Aufwand egal, langfristig am besten“ folgt

- **Stufe B ganz, nicht halb:** SQLite ist die eine Quelle; der Store im Worker ist ein Zwischenspeicher mit fester
  Obergrenze (Gerüst immer, Seiteninhalt nach Benutzung, ältestes zuerst entlassen). Keine Mischform, in der manche
  Funktionen weiter „alles im Speicher“ voraussetzen – jede solche Stelle wird auf SQL umgestellt und bekommt einen
  Test mit einem Workspace, der größer ist als die Obergrenze.
- **Eine Formatumstellung statt mehrerer:** lokales Schema v4 und Protokoll v4 werden zusammen entworfen (Spalten,
  kompakte Records, `scope`, E2E-Umschlag) und in einem Schritt mit Sicherung, Probelauf und Rückweg eingeführt.
  Die Umsetzung von B kann vorher beginnen, soweit sie das Format nicht festlegt.
- **Natives SQLite in den Apps:** Mac, iPhone, iPad und Android bekommen SQLite über die Hülle (mit WAL) statt
  SQLite-WASM auf OPFS; WASM bleibt dem Browser. Das war schon vorgesehen (`sql.ts`) und wird Teil von B.
- **Verlässlichkeit messbar halten:** vor jeder Stufe die Zeitmessung mit 100 000 und 500 000 Records, dazu ein
  Dauerlauf (zufällige Änderungen, Abbruch mitten im Schreiben, Neustart, Vergleich mit einer Referenz).
