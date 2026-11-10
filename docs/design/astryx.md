# Astryx in Based Next

[Astryx](https://github.com/meta/astryx) ist Metas offenes Design-System (React 19, MIT, Beta): Komponenten,
Themes, Seitenvorlagen und eine CLI, die auch Agenten bedienen. Based Next nutzt es als Komponenten-Baukasten;
das Aussehen bleibt „Based Default“ (ADR 0012).

## Was eingebaut ist

- `apps/web`: `@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@stylexjs/stylex` (Peer), `@astryxdesign/cli` (dev).
- React 18 → 19 im ganzen Workspace (Astryx verlangt React 19).
- `src/main.tsx` lädt `reset.css` und `astryx.css` **vor** `styles.css` und legt `<Theme>` um die App.
  Astryx-Styles liegen in CSS-Layern, die Based-Styles ohne Layer gewinnen also immer.
- `src/astryxTheme.ts`: vorerst das neutrale Theme, ohne `fonts.css` (würde Google Fonts laden).
- `AGENTS.md` und `.claude/CLAUDE.md`: Kurzanleitung der CLI für Agenten (`astryx init`).

## Regeln

- Fertig gebaute CSS, kein StyleX-Compiler: keine `xstyle`-Props, keine Vorlagen, die StyleX brauchen.
- Nichts von fremden Servern laden (Schriften, Icons). `astryx theme add` nicht benutzen, es bindet `fonts.css` ein.
- Farben, Radien, Abstände kommen aus `@based/design-tokens`. Astryx-Tokens werden im Theme darauf abgebildet,
  nicht per `:root` überschrieben.
- Editor (BlockNote) und Datenbank-Views (virtualisiert) bleiben eigene Bausteine. Astryx ist für Shell, Menüs,
  Dialoge, Einstellungen, Formulare, Chat- und Agenten-Oberflächen.

## Offen

- Theme „Based Default“ mit `defineTheme` aus den Based-Tokens (hell und dunkel, Appearance-Umschalter anbinden).
- Bestehende Shell-Teile schrittweise auf Astryx-Komponenten umstellen, Screenshots vorher/nachher.
- Bundle-Größe beobachten (Komponenten einzeln importieren: `@astryxdesign/core/Button`).

## Nachschlagen

`pnpm --filter @based/web exec astryx search "<begriff>"`, `… component <Name>`, `… docs theme`, `… doctor`.
