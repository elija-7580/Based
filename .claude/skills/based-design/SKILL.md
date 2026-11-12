---
name: based-design
description: Pflicht vor jeder sichtbaren Änderung an Based Next (apps/web, apps/desktop, packages/editor, packages/database-ui, packages/ui) – Designsprache „Based Default“, Based-Bausteine auf Astryx, Tokens, Selbstprüfung.
---

# Based-Design anwenden

Quelle der Wahrheit: `docs/design/README.md` (Designsprache „Based Default“, ADR 0012) und
`docs/design/astryx.md` (Bausteine und Regeln). Werte nur aus `packages/design-tokens/tokens.json` (ADR 0009).
Bei Widerspruch zum Astryx-Block in `CLAUDE.md` gewinnt Based.

## Vor dem Bauen

1. Betroffene Oberfläche im Browser ansehen (1280 × 820, hell und dunkel) und mit dem Design-Kit vergleichen:
   Einstellungen → Diagnostics → „Open design kit“ (`#prefs-kit`).
2. Für jedes Element den passenden Baustein wählen:

| Element | Baustein |
|---|---|
| Button, Icon-Button | `BasedButton` (`primary` nur einmal pro Ansicht, sonst `secondary`/`ghost`/`danger`) |
| Menü an einem Auslöser (auch Slash, @, Blockmenü, Turn into, Filter, Sortierung) | `BasedMenu` – Zeilen mit Icon-Kachel, Label, optional Beschreibung und Häkchen |
| freies Popover (Link, Farbe, Formatleiste) | `BasedPopover` |
| Dialog, Rückfrage | `BasedDialog`, `BasedConfirm` |
| Eingabefeld | `BasedField` |
| fehlt | neuen Wrapper in `packages/ui/src/astryx` anlegen, ins Design-Kit aufnehmen, testen – nicht in der View basteln |

3. Views importieren nur `@based/ui/astryx`, nie `@astryxdesign/core` direkt.

## Regeln, die am häufigsten verletzt werden

- Kein BlockNote-/Ariakit-Standardaussehen: Editor-Menüs und -Toolbars sehen aus wie das Seitenmenü.
- Keine rohen `<button>`, keine neuen eigenen `.menu`/`.dialog`/`.popover`-Klassen.
- Keine festen Hex-, px- oder ms-Werte: `var(--…)` aus `tokens.css` (Ausnahmen: 1-px-Linie, 3-px-Marker-Strich).
- Gruppieren mit Flächen (`surface-raised`, Radius 18, Pillen), nicht mit Haarlinien.
- Marker nur für Agentenarbeit – nie Button, Fokus, Status oder Deko.
- Kleine Schrift (< 20 px) nie negativ gesperrt, Sekundärtext `muted`, kein „SF Pro Display“ erzwingen.
- Icons: 2-px-Strich, 24-px-Raster, aktiv gefüllt. Kein Emoji, kein Sparkle für KI.
- Keine System-/Apple-Elemente (auch kein natives Kontextmenü): jeder Klick öffnet Based-UI.
- UI-Beschriftungen sind nicht als Text markierbar (`user-select: none`), Inhalte schon.
- Bewegung 120/180 ms, ease-out, nur Deckkraft und Position.

## Selbstprüfung vor „fertig“

```sh
# in den geänderten Dateien darf nichts davon neu auftauchen
git diff -U0 main -- 'apps/**/*.tsx' 'packages/**/*.tsx' | grep -E '^\+.*(<button|@astryxdesign/core|#[0-9a-fA-F]{3,8}\b)'
git diff -U0 main -- '*.css' | grep -E '^\+.*[^-]\b[0-9]+px'
```

Dann die Checkliste aus `docs/quality/checklist.md` (drei Größen, hell/dunkel, alle Zustände), Bildschirmfotos
nach `docs/design/screens/`. Was du nebenbei Unpassendes siehst: eigener Backlog-Eintrag
„Design · Umstellung …“ oder „Feinschliff · …“, nicht im selben Commit mitändern.
