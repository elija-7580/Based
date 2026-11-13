# Fertig heißt poliert

Stand 11. 11. 2026, entschieden mit Elija. Ein Eintrag mit sichtbarer Oberfläche ist erst „Erledigt“ oder
„Mac-Test nötig“, wenn diese Liste für die berührten Screens abgehakt ist. Die Werte kommen aus der
Designsprache (`docs/design/README.md`) und den Tokens (`packages/design-tokens/tokens.json`).

Hintergrund und Quellen (Linear „Quality Wednesdays“, Vercel „Web Interface Guidelines“, „Details that make
interfaces feel better“) stehen im Entwicklungslog unter „Recherche und Plan 2026-11-11: Feinschliff“.

## So wird geprüft

1. Jeden berührten Screen im Browser öffnen (Playwright), hell und dunkel, in 1280 × 820 (Startfenster),
   900 × 600 (kleinstes Desktop-Fenster) und 1728 × 1000.
2. Jeden Screen in seinen Zuständen ansehen (Abschnitt 2), Bildschirmfotos nach `docs/design/screens/`.
3. Die Fotos wirklich ansehen. Ein Test, der grün ist, sagt nichts darüber, ob es gut aussieht.
4. Was nicht stimmt und nicht zum Eintrag gehört: eigener Backlog-Eintrag, Typ „UX/Polish“, Aufwand S,
   mit Foto oder genauer Stelle. Nicht still liegen lassen.
5. Jeder behobene Mangel bekommt einen Test, der den Rückfall verhindert (`apps/web/e2e/polish.spec.ts`
   oder beim Bereich).

## 1 · Sofortige Reaktion

- [ ] Jede lokale Aktion zeigt in unter 100 ms eine sichtbare Wirkung. Kein Spinner für lokale Aktionen.
- [ ] Änderungen gelten zuerst lokal, dann wird gespeichert und synchronisiert. Schlägt etwas fehl: zurückrollen
      und sagen, was passiert ist.
- [ ] Wartezeiten über 1 s (Import, AI, Sync, Export) zeigen Fortschritt und lassen sich abbrechen.
- [ ] Platzhalter beim Laden haben die Form des späteren Inhalts. Nichts springt, wenn der Inhalt kommt.
- [ ] Das Performance-Budget im Gate (BSD-280) ist nicht schlechter geworden.

## 2 · Jeder Screen in jedem Zustand

- [ ] Leer (frischer Workspace): erklärt in einem Satz, was hierher kommt, und bietet den nächsten Schritt an.
- [ ] Ein Eintrag, viele Einträge (1.000+ Zeilen, 50 Tabs, tiefe Verschachtelung).
- [ ] Sehr langer Text: Titel mit 150 Zeichen, ein Wort mit 200 Zeichen, lange Namen in Seitenleiste, Tabs,
      Breadcrumb, Menüs, Karten, Tabellenzellen. Text kürzt mit „…“ oder bricht um, läuft nie heraus und
      überdeckt nichts. Gekürzter Text ist per Tooltip ganz lesbar.
- [ ] Dauerhaft sichtbare Beschriftungen (Status, Knöpfe, Überschriften) sind in der Standardbreite nie gekürzt.
- [ ] Fehler, offline, nur lesen, kein Modell eingerichtet, keine Berechtigung.
- [ ] Im Startfenster 1280 × 820 ist die wichtigste Bedienung des Screens ohne Scrollen sichtbar.
- [ ] Im kleinsten Fenster 900 × 600 ist alles erreichbar, nichts überlappt, kein waagrechter Rollbalken.
- [ ] Hell und dunkel, Default und Bold, Comfortable und Compact.

## 3 · Jedes Element in jedem Zustand

- [ ] Ruhe, Überfahren, gedrückt, Fokus per Tastatur (neutraler Rahmen `focus-ring`, nie Marker – BSD-367),
      ausgewählt (`selection-bg`/`selected`), deaktiviert.
- [ ] Gleiche Elemente verhalten sich überall gleich (ein Menü ist überall dasselbe Menü).
- [ ] Zustände fremder Bibliotheken (BlockNote, Ariakit, Astryx) sind auf Based-Flächen umgestellt. Kein
      fremdes Blau, keine fremden Schatten, keine fremde Schrift.
- [ ] Klickflächen mindestens 24 × 24 px, auf Touch 44 × 44 px, auch wenn das Icon kleiner ist.
- [ ] Icon-Knöpfe haben einen Namen (`aria-label`) und einen Tooltip mit Tastenkürzel.

## 4 · Ein System statt Einzelwerte

- [ ] Farben, Abstände, Radien, Schatten, Schriftgrößen nur aus Tokens. Kein Hex, kein rgb(), keine freien
      Pixelwerte in `apps/web/src` und `packages/*/src`.
- [ ] Verschachtelte Rundungen: innen = außen minus Abstand.
- [ ] Ein Icon-Satz (24-px-Raster, 2 px Strich, runde Enden). Ein Ziel hat überall dasselbe Icon
      (Seitenleiste, Tab, Quick Find, Breadcrumb).
- [ ] Linke Kanten auf einem Screen liegen auf einer Linie (Titel, Text, Tabelle, Knöpfe).
- [ ] Zahlen, Zeiten und IDs in Mono mit Tabellenziffern. Zahl und Einheit ohne Lücke im Umbruch.
- [ ] Bewegung: 120 oder 180 ms, ease-out, nur Deckkraft und Position, nie `transition: all`, unterbrechbar,
      aus bei „Bewegung reduzieren“.

## 5 · Kein toter Klick

- [ ] Alles, was wie ein Knopf aussieht, tut etwas. Was noch nicht fertig ist, ist nicht sichtbar (Labs).
- [ ] Jeder Ablauf geht ohne Maus. Fokus landet nach Öffnen und Schließen dort, wo man ihn erwartet.
      Escape schließt das Oberste.
- [ ] Jede Änderung lässt sich rückgängig machen (⌘Z). Endgültiges Löschen fragt nach, alles andere nicht.
- [ ] Keine Konsolenfehler, keine unbehandelten Ausnahmen beim Durchklicken.
- [ ] Doppelklick, schnelles Mehrfachklicken und Klick während des Ladens richten nichts an.

## 6 · Eine Sprache

- [ ] Gleiche Dinge heißen überall gleich (Page, Database, Teamspace, Trash, Library).
- [ ] Knöpfe nennen die Aktion („Export page“ statt „OK“). Satzanfang groß, sonst klein.
- [ ] Fehlermeldungen sagen, was passiert ist und was man tun kann. Keine Fehlercodes, IDs, Stacktraces oder
      Entwicklerbegriffe in der Oberfläche.
- [ ] Kein Platzhaltertext, kein „TODO“, kein „undefined“, kein „[object Object]“, kein leeres Feld.
- [ ] Typografie: „…“ als ein Zeichen, echte Anführungszeichen, Tastenkürzel in der Schreibweise des Systems.

## 7 · Vertrauen

- [ ] Nichts geht verloren: Schließen, Neuladen und Absturz mitten in der Eingabe behalten den Text.
- [ ] Der Speicherzustand ist sichtbar und stimmt (gespeichert, wird synchronisiert, offline, nicht gespeichert).
- [ ] Datenformat nur mit Migration und einem Test, der alte Daten liest.

## Was bewusst nicht poliert wird

Alles hinter „Labs“ (Sandbox, Coding-Konsole, Meeting-Notizen) bekommt nur die Abschnitte 5 und 7. Tiefe für
die Kernflächen in dieser Reihenfolge: Editor, Datenbanken, Seitenleiste und ⌘K, Home, erster Start und
Import, Einstellungen.
