# Designsprache „Based Default“

Stand 9. 11. 2026, entschieden mit Elija (ADR 0012). Quelle der Werte: `packages/design-tokens/tokens.json`;
das teilbare Brand-Book liegt als Design-System-Artefakt „Based“ in Claude, die Entwürfe auf dem Canvas
„Based – Design“.

## Grundsätze

1. **Leise im Standard.** Systemschrift, leichte Gewichte, Haarlinien statt Kästen. Was eine Listenzeile sein
   kann, ist keine Karte. Nur die Seite hat Gewicht.
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
| Flächen | `bg` #FFFFFF / #191919 · `sidebar` #F7F7F5 / #202020 · `surface-soft` · `selected` · `line` |
| Text | `ink` #1F1F1D / #E9E9E6 · `ink-2` (Seitentext) · `muted` #6B6A65 / #9D9C97 (≥4,5:1) |
| Aktion | `button` = Tinte, eine primäre Aktion pro Ansicht |
| Signal | `marker` #F1DE8A (Fläche, Tag) · `marker-strong` #E0C24A (3-px-Strich) · `marker-calm` |
| Status | Ready, Review, Blocked, Neutral als Tönungen mit Tinte; „In progress“ = Marker |
| Schrift | Default: Systemschrift, Titel 32/650, Text 16/1.68 · Bold: Schibsted 40/800, Literata 17/1.7 · Mono 11,5 für Daten |
| Abstände | 4-px-Raster `space-1…8` · Seitenbreite 720 px · Randspalte 120 px · Seitenleiste 232 px |
| Radien | 3 (Tags) · 5 (Chips) · 6 (Buttons, Nav) · 10 (Composer, Menüs, Karten) · Icon 23 % |
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

## Muster

- **Home:** Begrüßung, Hauptagent (Nachricht + Composer), „Based is working on“, „This week“, „Pick up
  again“ — Listen, keine Karten. Agent-Details (Modell, Laufzeit, Rechte) nur mit „Show agent details“.
- **Seite:** Breadcrumb, Titel, Metazeile, Randspalte für Agent-Notizen, Text max. 720 px.
- **Datenbank:** Ansichten als Tabs (Table/Board/…), Filter-Chips, Tabelle mit Haarlinien, Mono für IDs/Zeiten.
- **Graph:** Projekte gefüllt in Tinte, Seiten als Ringe, Agent-Änderungen im Marker.
- **Einstellungen → Darstellung:** Theme, Stil, Marker, Dichte, Calm, Agent-Details.
- **Icons:** Linien auf 24-px-Raster, 1,9 px, runde Enden. Kein Emoji, kein „Sparkle“ für KI.
- **Ton:** kurz, aktiv, Buttons nennen die Aktion („Ask“, „Approve“). Agenten sagen, was sie taten und was
  sie brauchen.

## Logo

Ein **Stencil-b aus zwei weichen Blöcken, die auf einer Basis stehen** (Variante „Soft blocks — C ·
Rendered“): Stamm und Bauch sind Blöcke, die Basis ist der Marker. Dateien in `docs/design/logo/`:

- `based-icon-light.svg`, `based-icon-dark.svg` — App-Icon (gerendert, Kachel mit 23 % Radius)
- `based-mark.svg`, `based-mark-on-dark.svg` — Zeichen ab 32 px
- `based-mark-small.svg`, `based-mark-small-on-dark.svg` — flach, für ≤ 24 px (Seitenleiste, Favicon)
- Wortmarke: Zeichen + „based“ klein, Systemschrift 650, −0,03 em. Schutzraum: eine Stammbreite.
