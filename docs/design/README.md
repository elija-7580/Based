# Designsprache „Based Default“

Stand 9. 11. 2026, entschieden mit Elija (ADR 0012, Nachtrag v8/v9). Quelle der Werte: `packages/design-tokens/tokens.json`;
das teilbare Brand-Book liegt als Design-System-Artefakt „Based“ in Claude, die Entwürfe auf dem Canvas
„Based – Design“.

## Grundsätze

1. **Leise im Standard, aber greifbar.** Systemschrift, ruhige Farben — gruppiert wird mit Flächen
   (`surface-raised`, große Radien, Pillen), nicht mit Haarlinien. Die Seite selbst bleibt ruhig und deckend.
2. **Ein Signal.** Der Marker (weicher Textmarker-Ton) bedeutet überall genau eins: *ein Agent hat das
   geschrieben oder geändert.* Nie Deko, nie Button-Farbe, nie Status ohne Agentenbezug.
3. **Charakter auf Wunsch.** Stärke steckt im Theme, nicht im Standard: *Stil → Bold* schaltet Schibsted
   Grotesk + Literata und kräftige Überschriften ein. Der Calm-Modus macht das Signal grau.
4. **Daten sehen aus wie Daten.** Monospace nur für IDs, Zeiten, Kürzel, Zahlen, Code und Formeln.
5. **Personalisierbar.** Theme (Hell/Dunkel), Stil (Default/Bold), Marker (Butter/Mint/Sky/Rose), Dichte
   (Comfortable/Compact), Calm-Modus und Agent-Details sind Einstellungen. Alle Werte kommen aus Tokens
   (ADR 0009).

Warum leise: Research-Synthese vom 9. 11. — Nutzer von Notiz-Apps wollen, dass die Oberfläche zurücktritt;
erfolgreiche Apps (Obsidian, Bear) sind im Standard ruhig und lassen sich tief anpassen.

## Tokens in Kürze

| Bereich | Werte |
|---|---|
| Flächen | `canvas` #F1F1EE / #141414 (Grund) · `bg` #FFFFFF / #191919 (Seite) · `surface-raised` #F2F2EF / #262626 (Gruppen, Karten, Pillen) · `sidebar` · `selected` · `line` |
| Text | `ink` #1F1F1D / #E9E9E6 · `ink-2` (Seitentext) · `muted` #6B6A65 / #A3A29D (≥4,5:1 auf allen Flächen) |
| Aktion | `button` = Tinte, eine primäre Aktion pro Ansicht |
| Signal | `marker` #F1DE8A (Fläche, Tag) · `marker-strong` #E0C24A (3-px-Strich) · `marker-calm` |
| Status | Ready, Review, Blocked, Neutral als Tönungen mit Tinte; „In progress“ = Marker |
| Schrift | Default: Systemschrift, Titel 32/650, Text 16/1.68, Beschreibung 13/450 +0,005 em, Meta 12/500 +0,01 em, Tab-Label 10,5/600 +0,02 em · Bold: Schibsted 40/800, Literata 17/1.7 · Mono 11,5 für Daten |
| Abstände | 4-px-Raster `space-1…8` · Seitenbreite 720 px · Randspalte 120 px · Seitenleiste 232 px |
| Radien | 3 (Tags) · 6 (Code) · 10 (Nav, Kacheln) · 14 (Zeilen in Gruppen) · 18 (Karten, Gruppen, Popover) · 36 (Sheets) · Pille (Buttons, Picker, Tab-Leiste) · Icon 23 % |
| Icons | 2 px Strich, 24-px-Raster, runde Enden; Navigation zusätzlich gefüllt im aktiven Zustand; Touch-Ziel ≥ 44 px |
| Material | `data-material="glass"` auf Apple-Plattformen (Blur 22 px, Sättigung 180 %); sonst solid |
| Bewegung | 120/180 ms, ease-out, nur Deckkraft und Position |

Umschalter als Attribute am Wurzelelement: `data-theme`, `data-style="bold"`, `data-density="compact"`,
`data-marker`, `data-calm` — siehe `packages/design-tokens/tokens.css`.

## Der Agent-Marker

| Wo | Wie |
|---|---|
| Absatz/Block, den ein Agent schrieb | 3-px-Strich `marker-strong` im Rand + Tag **Based** in der Randspalte mit Herkunft („aus deiner Aufnahme“) |
| Textstelle im eigenen Text | `marker`-Fläche hinter der Stelle |
| Datenbankzeile/Board-Karte, seit dem letzten Blick geändert | 3-px-Strich am linken Rand |
| Graph-Knoten | `marker`-Füllung, `marker-strong`-Kontur |
| Nachricht des Hauptagenten auf Home | 3-px-Strich links |

Nie auf Buttons, Überschriften, Hintergründen, Fehlern oder für etwas, das ein Mensch getan hat. Der Marker
trägt Bedeutung nie allein: Tag, Tooltip und Screenreader-Label sagen es in Worten.

## Flächen und Elemente (v8)

- Desktop: Seitenleiste auf `canvas`, die Seite als Panel (`bg`, `shadow-panel`, Radius 16). Aktiver Nav-Eintrag
  = weiße Pille mit gefülltem Icon; Zähler als Badge.
- Gruppen sind Flächen: Listen in `surface-raised` mit Radius 18, Zeilen mit 40-px-Icon-Kachel.
- Composer: graue Fassung, weißes Feld, darin Pillen **Agent · Compute · Permission** (Icon-Kreis + Label +
  Pfeil). Menüs: Popover mit Icon-Kacheln, Beschreibung, Häkchen; Compute = Auto/Fast/Deep/„Specific model…“,
  Permission = Ask every time / Ask before edits (Standard) / Work freely.
- Mobile: runde 44-px-Kopf-Buttons, Menü-Icon = zwei Striche ungleicher Länge, schwebende Tab-Leiste (Pille) mit
  gefülltem aktivem Icon und rundem Capture-Button, Capture als Sheet (Voice/Text/Photo).

## Kleine Schrift (v9)

Unter 20 px wird die Laufweite nur weiter, nie enger; kleine Größen bekommen etwas mehr Gewicht (450–600) und
Zeilenhöhe. Sekundärtext immer `muted`, nie heller. Nie eine Überschrift verkleinern. Auf Apple-Systemen
`font-optical-sizing: auto` lassen und nie „SF Pro Display“ erzwingen — die Systemschrift wählt unter 20 pt
selbst den Text-Schnitt. Ein Test prüft, dass kein Stil unter 20 px negativ gesperrt ist.

## Material je Plattform (v9)

| Plattform | Material |
|---|---|
| iOS · iPadOS · macOS | Liquid Glass nur auf schwebender Bedienung: Tab-Leiste, Kopf-Buttons, Toolbars, Seitenleiste, Sheets, Popover |
| Windows 11 | Mica für Fenster/Seitenleiste, Acrylic für Menüs (nativ über Tauri) |
| Android | Material-Flächen ohne Blur, Navigationsleiste mit Pillen-Indikator, Capture als FAB |
| Linux · Web | solide `surface-raised` + `shadow-float` |
| Barrierefreiheit | „Transparenz reduzieren“ oder Calm-Modus → überall solide |

Text, Listen und Seiten liegen nie auf Glas. Auf iOS kommt echtes Glas nur über native Leisten um die
Web-Ansicht — offene Architekturfrage.

## Muster

- **Home:** Begrüßung, Hauptagent (Nachricht + Composer), „Based is working on“, „This week“, „Pick up
  again“ — Listen, keine Karten. Agent-Details (Modell, Laufzeit, Rechte) nur mit „Show agent details“.
- **Seite:** Breadcrumb, Titel, Metazeile, Randspalte für Agent-Notizen, Text max. 720 px.
- **Datenbank:** Ansichten als Tabs (Table/Board/…), Filter-Chips, Tabelle mit Haarlinien, Mono für IDs/Zeiten.
- **Graph:** Projekte gefüllt in Tinte, Seiten als Ringe, Agent-Änderungen im Marker.
- **Einstellungen → Darstellung:** Theme, Stil, Marker, Dichte, Calm, Agent-Details.
- **Icons:** Linien auf 24-px-Raster, 2 px, runde Enden; gefüllt im aktiven Zustand. Kein Emoji, kein „Sparkle“ für KI.
- **Ton:** kurz, aktiv, Buttons nennen die Aktion („Ask“, „Approve“). Agenten sagen, was sie taten und was
  sie brauchen.

## Logo

Ein **Stencil-b aus zwei weichen Blöcken, die auf einer Basis stehen** (Variante „Soft blocks — C ·
Rendered“): Stamm und Bauch sind Blöcke, die Basis ist der Marker. Dateien in `docs/design/logo/`:

- `based-icon-light.svg`, `based-icon-dark.svg` — App-Icon (gerendert, Kachel mit 23 % Radius)
- `based-mark.svg`, `based-mark-on-dark.svg` — Zeichen ab 32 px
- `based-mark-small.svg`, `based-mark-small-on-dark.svg` — flach, für ≤ 24 px (Seitenleiste, Favicon)
- Wortmarke: Zeichen + „based“ klein, Systemschrift 650, −0,03 em. Schutzraum: eine Stammbreite.
