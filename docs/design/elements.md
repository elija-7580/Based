# Element-System (v11)

Stand 17. 11. 2026. Diese Datei legt fest, **wie jedes Bedienelement in Based aussieht und sich verhält** – Größe,
Schrift, Fläche, Zustand, Einblendung. Sie ergänzt `README.md` (Designsprache, Farben, Marker) und `astryx.md`
(Bausteine im Code). Für alles, was man anklicken, antippen oder ausfüllen kann, gilt diese Datei zuerst.

Wer eine sichtbare Stelle baut oder ändert, nimmt ein Element aus Abschnitt 4. Gibt es keins, das passt, wird
**erst hier** ein neues beschrieben (mit Baustein in `packages/ui/src/astryx` und Eintrag im Design-Kit
`#prefs-kit`), dann gebaut. Einzelfälle in einer View gibt es nicht.

Entwurf mit Vorher/Nachher: Canvas „Based – Design“, Reihe v11.

## Warum es diese Datei gibt

Rückmeldung von Elija (17. 11.): Elemente sind oft zu klein (Reiter „Pages · Graph · Meetings“ in der Library),
Einblendungen wirken unterschiedlich, die Tastenkürzel beim Halten von ⌘ passen nicht zum Rest, eine Tabelle zeigt
bis zu drei Rahmen gleichzeitig, die Sprachliste im Code-Block sieht anders aus als jedes andere Menü.

Der Bestand am 17. 11. erklärt das:

| Befund | Zahl |
|---|---|
| Bedienelemente mit `size="sm"` (28 px, in Compact 24 px) | 171 von 174 |
| Häufigste Schriftgröße in der Oberfläche | `meta` 12 px (82 Stellen), dann `description` 13 px (40), erst dann `ui` 14 px (24) |
| Eigene Menü-Familien nebeneinander | 5 (`.menu-item`, `.bx2-menu-item`, `.dbui-menu-item`, `.nf-item`, Astryx-Menü) |
| Darstellungen eines Tastenkürzels | 3 (dunkle Plakette, 3-D-Tastenkappe, grauer Text) |
| Eigene Einblend-Animationen | 13 `@keyframes` |
| Fokus in der Tabelle | Tabellenrahmen 3 px + Zellenrahmen 2 px + Feldrahmen 1 px, in zwei Grautönen |

Die Farben und Abstände stimmen (alles aus Tokens). Was fehlte, war eine Festlegung **pro Element**. Das ist sie.

## 1 · Größen

Drei Höhen, eine davon ist der Standard.

| Token | Höhe | Wofür |
|---|---|---|
| `--control-md` | 32 px | **Standard für alles:** Buttons, Umschalter, Felder, Menüzeilen, Zeilen der Seitenleiste |
| `--control-sm` | 28 px | Nur in dichten Daten: Tabellenzelle, Werkzeugleiste einer Inline-Datenbank, Chips in einer Zeile |
| `--control-lg` | 40 px | Einstiege: Feld von Quick Find, Composer, Hauptaktion auf Touch (Ziel dort 44 px) |

- Wer `size` nicht angibt, bekommt `md`. `size="sm"` steht nur in `packages/database-ui`. Der Wächter zählt jedes
  `size="sm"` in `apps/web` und `packages/editor`; die Zahl darf nur sinken.
- Dichte „Compact“ verschiebt alles um eine Stufe (md 28, sm 24). Nur dort gibt es 24 px.
- Die Klickfläche ist nie kleiner als die Höhe des Elements, auch wenn das Icon kleiner ist.
- Icons: 20 px in allem mit `md` (Seitenleiste, Leisten, Buttons), 16 px nur in `sm` und im Fließtext, 24 px mobil.
- Nebeneinander stehende Elemente haben dieselbe Höhe. Ein Umschalter neben einem Feld ist so hoch wie das Feld.

## 2 · Schrift in Bedienelementen

| Rolle | Wert | Wofür | Nie für |
|---|---|---|---|
| `label` | 14 / 500 | Beschriftung von Buttons, Umschaltern, Feldern, Spaltenköpfen | – |
| `ui` | 14 / 400 | Menüzeilen, Listenzeilen, Feldinhalt, Zellen | – |
| `description` | 13 / 450, `muted` | zweite Zeile, Hinweis unter einem Feld, Erklärung in einem Menü | etwas, das man allein anklickt |
| `meta` | 12 / 500, `muted` | Zeit, Anzahl, Gruppenüberschrift („Private“), Text in einer Tastenkappe | Buttons, Reiter, Menüeinträge, Filter |
| `data` | Mono 11,5 | IDs und Code | Datum, Zeit, Zahlen, Tastenkürzel |

**Alles, was man anklicken oder ausfüllen kann, ist mindestens 14 px groß.** Kleiner als 12 px ist auf dem
Desktop nichts (`tab-label` 10,5 px gibt es nur unter den Icons der mobilen Tab-Leiste).

## 3 · Flächen, Zustände, Fokus

Ein Element in Ruhe ist eine Fläche oder nichts – kein Rahmen.

| Zustand | Darstellung |
|---|---|
| Ruhe | Fläche `surface-raised` (Feld, sekundärer Button, Filter) oder keine (Ghost, Zeile) |
| Überfahren | `surface-raised`; liegt das Element schon auf `surface-raised`: `selected` |
| Gedrückt | wie Überfahren, keine Verkleinerung |
| Ausgewählt, aktiv | `selected`; in der Navigation zusätzlich gefülltes Icon. Im Umschalter: `bg` + `shadow-control` |
| Tastatur-Fokus | 2 px `focus-ring`, 2 px Abstand; in Zellen und Zeilen innen. Nur bei `:focus-visible` |
| In Bearbeitung | derselbe Fokusrahmen bleibt stehen, das Eingabefeld darin hat keinen eigenen Rahmen |
| Deaktiviert | 40 % Deckkraft, kein Überfahren |
| Von einem Agenten | Marker-Strich (siehe `README.md`) – nie als Zustand eines Bedienelements |

**Ein Rahmen zur Zeit.** Auf dem ganzen Bildschirm ist höchstens ein Fokusrahmen zu sehen, und zwar am innersten
Element, das den Fokus hat. Behälter (Tabelle, Board, Liste, Block, Dialog) zeichnen keinen Rahmen, sobald etwas
in ihnen die Position zeigt. Ein Mausklick auf einen Button zeigt keinen Rahmen.

Für die Tabelle heißt das:

- Die aktive Zelle hat 2 px `focus-ring` innen, Radius `radius-xs`. Das ist die einzige Linie.
- Kein Rahmen um die Tabelle. Springt man per Tab hinein, bekommt die erste Zelle den Rahmen.
- Die Zeile mit der aktiven Zelle bekommt keine Überfahr-Fläche.
- Der Zelleneditor öffnet im selben Rahmen. Auswahllisten (Select, Datum, Person) hängen als Menü 4 px darunter.
- `control-border` ist keine Fokusfarbe. Es gibt genau eine: `focus-ring`.

## 4 · Die Elemente

Jede Zeile ist ein Element, das es genau einmal gibt. „Baustein“ ist der Name in `@based/ui/astryx`.

| Element | Baustein | Festlegung |
|---|---|---|
| **Button** | `BasedButton` | Pille, `md`, `label`. `primary` = Tinte, einmal pro Ansicht. `secondary` = `surface-raised`. `ghost` = keine Fläche. `danger` = Text `danger`. Icon allein: 32 × 32, Icon 20, mit `aria-label` und Tooltip |
| **Umschalter** | `BasedSwitcher` (neu; ersetzt direkte `SegmentedControl` und `BasedTabs`) | Schiene `surface-raised`, Pille, Höhe `md`. Aktives Segment `bg` + `shadow-control`. `label`. 2–5 Einträge, sonst Menü. Wechselt eine Ansicht desselben Inhalts (Pages · Graph · Meetings; Summary · Notes · Transcript; Ansichten einer Datenbank) |
| **Feld** | `BasedField` | Fläche `surface-raised`, kein Rahmen, Radius `radius-md`, Höhe `md`, `ui`. Platzhalter `muted`. Fokus = Fokusrahmen statt Rahmenfarbe. Suchfelder haben links ein Such-Icon (20), in Menüs füllen sie die Breite |
| **Filter, Auswahl** | `BasedPicker` (neu) | Pille `surface-raised`, `md`, Text „Type: All types“ + Pfeil. Öffnet ein Menü. Gesetzter Filter: `selected` |
| **Menü** | `BasedMenu` | Fläche `surface-card`, Radius `radius-xl`, `shadow-menu`, Innenabstand `space-1`. Zeile: Höhe `md`, Radius `radius-md`, optional Icon-Kachel 24 (Icon 16), Text `ui`, rechts Häkchen, Tastenkappe oder Pfeil. Mit Beschreibung: zweizeilig, 44 px. Gruppenüberschrift `meta`. Aktive Zeile `surface-raised`, gewählter Eintrag mit Häkchen. Breiten 240 oder 320 px, höchstens 10 Zeilen hoch, dann rollen. Suchfeld ab 9 Einträgen, oben, als Feld (siehe oben). Jede Liste, aus der man wählt, ist dieses Menü: Slash, @, Blockmenü, „Turn into“, Sprache im Code-Block, Filter, Sortierung, Spaltenmenü, Kontextmenü, `<select>` |
| **Popover** | `BasedPopover` | Fläche und Schatten wie das Menü, Innenabstand `space-3`. Für kleine Formulare am Auslöser (Link, Farbe, Datum) |
| **Dialog** | `BasedDialog`, `BasedConfirm` | Fläche `surface-card`, Radius `radius-xl`, Breite 480 px (Formular 640), Titel `heading`, Aktionen rechts unten, primäre ganz rechts. Abdunklung dahinter |
| **Seitenblatt** | `BasedSheet` (neu; Zeile öffnen, Verlauf, Teilen) | rechte Kante, Breite 480 px, Fläche `bg`, `shadow-float`, schließt mit Escape |
| **Tooltip** | `title` → `@based/ui/native` | Fläche Tinte, Text `button-ink` in `meta`, Radius `radius-sm`, Höhe 24. Nennt Name und Tastenkürzel, nie einen Satz |
| **Tastenkappe** | `BasedKeys` | Fläche `selected`, Text Tinte in `meta` mit festen Ziffern, Höhe und Mindestbreite `keycap` (20), Radius `radius-sm`. Eine Kombination ist **eine** Kappe („⇧⌘E“), Schreibweise des Systems. Auf Tinte (Tooltip): Fläche 20 % `button-ink`. Kein 3-D, keine dunkle Plakette, kein Mono |
| **Hinweis, Anzeige** | `BasedToast` (neu; Rückmeldung, ⌘-Halten) | unten Mitte, 24 px vom Rand, Fläche und Schatten wie das Menü (auf Apple: Glas), eine zur Zeit |
| **Chip, Tag** | `BasedChip` | Höhe 24 (in Zellen 20), Radius `radius-sm`, Fläche aus den Block-Farben, Text Tinte in `description` |
| **Kopf eines App-Screens** | Muster | Zeile 1: Titel `heading` (20 / 600) + Anzahl in `meta`, rechts die Hauptaktion. Zeile 2: links Umschalter, dann Filter, rechts Suchfeld – alle `md`, Abstand `space-2`. Der große Titel (`title`, 32) gehört nur eigenen Seiten und Datenbanken |

Die Anzeige beim Halten von ⌘: ein Hinweis (oben) mit Überschrift für den Ort („In this table“) und „Everywhere“,
Zeilen 28 px, Text `ui`, rechts eine Tastenkappe, höchstens zwei Spalten mit je sechs Zeilen, letzte Zeile
„All shortcuts“. Die Plaketten an Seitenleiste und Tabs sind dieselbe Tastenkappe.

## 5 · Einblendungen

Vier Arten. Jede Einblendung in Based ist eine davon.

| Art | Kommt | Geht | Schließt durch |
|---|---|---|---|
| Tooltip | 500 ms nach dem Überfahren, 120 ms einblenden; beim Weiterwandern zum Nachbarn sofort | 80 ms | Verlassen, Escape, Klick |
| Menü, Popover | sofort, 120 ms einblenden + 4 px vom Auslöser weg | 80 ms | Auswahl, Klick daneben, Escape |
| Dialog, Seitenblatt | 180 ms einblenden + 8 px (Blatt: von rechts) | 120 ms | Aktion, Escape; Klick daneben nur ohne Eingaben |
| Hinweis | 180 ms einblenden + 8 px von unten | 120 ms | nach 4 s, oder wenn der Anlass endet (Taste losgelassen) |

- Nichts verschiebt den Inhalt darunter. Was aufgeht, liegt darüber (`openLayer`/`showMenu`, Top Layer).
- Ein Menü öffnet an der linken Kante seines Auslösers, `overlay-gap` (4 px) darunter; reicht der Platz nicht,
  darüber. Es bleibt 8 px vom Fensterrand.
- Nur Deckkraft und Position, `ease-out`, keine Skalierung, kein Federn (Ausnahme: Logo-Intro).
- Es gibt drei Animationen: `fade-in`, `rise-in`, `pulse` (laufende Aufnahme, laufender Agent). Neue `@keyframes`
  legt niemand an.
- Was beim Überfahren erscheint (Griff, „Open“, Werkzeuge einer Zeile), blendet in 120 ms ein und nimmt vorher
  schon seinen Platz ein – die Zeile wird dadurch nicht breiter oder höher.
- „Bewegung reduzieren“: alles erscheint sofort.

## 6 · Für Agenten: so wird gearbeitet

1. Vor jeder sichtbaren Änderung diese Datei und den Skill `.claude/skills/based-design/SKILL.md` lesen.
2. Jedes Element der Änderung einem Eintrag aus Abschnitt 4 zuordnen. Passt keiner: zuerst diese Datei und das
   Design-Kit erweitern, im Ergebnisfeld des Backlog-Eintrags nennen, dann bauen.
3. Größe weglassen (= `md`). `sm` nur in `packages/database-ui`.
4. Schrift nach Abschnitt 2: anklickbar heißt mindestens 14 px.
5. Zustände nach Abschnitt 3 prüfen, vor allem: ist irgendwo mehr als ein Rahmen zu sehen?
6. Einblendungen nach Abschnitt 5: keine neue Animation, kein Verschieben.
7. `node ci/design-guard.mjs` muss grün sein, dann `docs/quality/checklist.md`.

Wer eine Stelle sieht, die dieser Datei widerspricht und nicht zum eigenen Eintrag gehört, legt einen
Backlog-Eintrag „Design · Element-System …“ an und ändert sie nicht nebenbei.

## 7 · Umstellung

**Stand 17. 11. 2026 (erste Runde, Fotos `screens/web-elements-v11-*.png`):** umgesetzt sind die Standardgröße (kein
`size="sm"` mehr außerhalb der Datenbank, Wächter-Bestand 0), `lg` = 40 px, Felder als Flächen mit Fokusrahmen, die
eine Tastenkappe (`BasedKeys`, Seitenleiste, Tabs, ⌘-Anzeige, Übersicht), ein Rahmen in der Tabelle, der Kopf von
Library und Meetings und die Sprachliste im Code-Block. **18. 11. (BSD-525):** `BasedSwitcher`, `BasedPicker`,
`BasedSheet` und `BasedToast` liegen in `packages/ui/src/astryx` und im Design-Kit (Fotos `screens/web-elements-v11-kit-*.png`,
`-sheet-*.png`); die Views nutzen `BasedSwitcher` statt `SegmentedControl` (außer den Einstellungen mit Farbfeldern).
Ebenfalls 18. 11.: Menü-Familien sehen gleich aus (BSD-527, `e2e/one-menu.spec.ts`), Anklickbares ≥ 14 px
(BSD-528, `e2e/elements-size.spec.ts`), nur noch die drei Keyframes `fade-in`, `rise-in`, `pulse` (BSD-529, Wächter in
`apps/web/src/tokens-only.test.ts`; `rise-in` nimmt den Abstand aus `--rise`), Köpfe von Trash, Graph und Einstellungen
(BSD-530). Offen: `BasedTabs` (Meeting) auf den Umschalter, das eine Menü als ein Baustein im Code, anklickbare
Texte unter 14 px (Rest von Punkt 4), die Animationen (Punkt 5), die Köpfe von Trash, Graph und Einstellungen.

Der Bestand wird in dieser Reihenfolge umgestellt (je ein Backlog-Eintrag „Design · Element-System …“):

1. **Grundlage:** `BasedSwitcher`, `BasedPicker`, `BasedSheet`, `BasedToast` und die neue Tastenkappe in
   `packages/ui`; Standardgröße der Bausteine auf `md`; Feld ohne Rahmen; Design-Kit zeigt jedes Element in
   jedem Zustand (hell, dunkel, Compact).
2. **Fokus:** ein Rahmen zur Zeit – Tabelle, Zelleneditor, Board, Liste, Blöcke; `control-border` als
   Fokusfarbe entfernen.
3. **Ein Menü:** `.bx2-menu-*`, `.dbui-menu-*`, `.menu-*` und `.nf-*` auf das eine Menü; darunter die
   Sprachliste im Code-Block (zeigt heute „Plain text“ doppelt).
4. **Größe und Schrift:** alle `size="sm"` außerhalb der Datenbank entfernen; anklickbare Texte auf 14 px;
   Mono bei Datum und Zeit entfernen (Library).
5. **Einblendungen:** 13 `@keyframes` auf drei; Zeiten und Abstände nach Abschnitt 5; ⌘-Anzeige neu.
6. **Köpfe der App-Screens:** Library, Trash, Meetings, Graph, Einstellungen nach dem Muster in Abschnitt 4.
