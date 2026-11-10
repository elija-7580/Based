# Astryx in Based Next

[Astryx](https://github.com/meta/astryx) ist Metas offenes Design-System (React 19, MIT, Beta): Komponenten,
Themes, Seitenvorlagen und eine CLI, die auch Agenten bedienen. Based Next nutzt es als Komponenten-Baukasten;
das Aussehen bleibt „Based Default“ (ADR 0012).

## Was eingebaut ist

- `apps/web`: `@astryxdesign/core`, `@stylexjs/stylex` (Peer), `@astryxdesign/cli` (dev). Kein `@astryxdesign/theme-*`.
- React 18 → 19 im ganzen Workspace (Astryx verlangt React 19).
- `src/main.tsx` lädt `reset.css` und `astryx.css` **vor** `styles.css` und legt `<Theme>` um die App.
  Astryx-Styles liegen in CSS-Layern (`reset` → `astryx-base` → `astryx-theme`); Based-Klassen ohne Layer gewinnen
  also immer. Die wenigen Element-Grundregeln von Based (`button`, `a`, `h1…`, Fokusring) stehen deshalb im Layer
  `reset`, damit sie Astryx-Komponenten nicht Schrift und Textfarbe wegnehmen.
- `AGENTS.md` und `.claude/CLAUDE.md`: Kurzanleitung der CLI für Agenten (`astryx init`).

## Theme „Based Default“

| Wo | Was |
|---|---|
| `packages/design-tokens/src/astryx.ts` | `astryxThemeSpec({ density })`: die Abbildung Based-Token → Astryx-Token als reine Funktion, getestet in `test/astryx.test.ts` (Werte, Kontraste, kein Marker, keine fremde Schrift) |
| `apps/web/src/astryxTheme.ts` | ruft damit nur `defineTheme` auf (Laufzeit-Theme, keine generierte Datei) |
| `apps/web/src/astryxIcons.tsx` | Icons für Astryx-Komponenten im Based-Strich (ersetzt Lucide aus dem neutralen Theme) |

Abbildung in Kürze:

| Astryx | Based |
|---|---|
| `--color-background-body` / `-surface` / `-card` / `-popover` | `canvas` / `bg` / `surface-raised` / `surface-card` |
| `--color-text-primary` / `-secondary` / `-disabled` | `ink` / `muted` / `control-border` |
| `--color-accent` + `--color-on-accent` (primärer Button, Fokus) | `button` + `button-ink` (Tinte) |
| `--color-neutral`, `--color-accent-muted`, Track, Skeleton | `selected` |
| `--color-border` / `-emphasized` | `line` / `control-border` |
| Fehler | `danger` (Text, Rand, Füllung), Tönung `status-blocked` |
| Info / Warnung / Erfolg, Farbfamilien (Badge) | Tönungen `status-ready` / `-blocked` / `-neutral` / `-review` mit Tinte; `synced` nur für Icon und Rand |
| `--radius-inner` / `-element` / `-container` / `-page` | 6 / 10 / 18 / 36; Buttons, Badges, Segmente = Pille |
| `--spacing-1…4`, `-6`, `-8`, `-10` | `space-1…7` (gleiches 4-px-Raster) |
| `--shadow-low` / `-med` / `-high` | `shadow-control` / `-float` / `-menu` |
| Schrift | `--font-ui` / `--font-head` / `--font-mono` (Systemschrift), Größen aus den Typo-Rollen |
| Bewegung | 120 / 180 ms, `ease-out` |

Der **Marker ist nicht abgebildet** – er ist nie Akzent-, Button- oder Statusfarbe (ein Test prüft das).

Schalter aus Einstellungen → My settings:

| Schalter | Wirkung auf Astryx |
|---|---|
| Theme Hell / Dunkel / System | `<Theme mode>`; „System“ wird in `appearance.ts` aufgelöst, damit `data-theme` für tokens.css und Astryx gleich ist |
| Dichte | eigenes Theme `based-compact` (Steuerhöhen 24/28/32 statt 28/32/36) |
| Stil Bold | über `--font-ui`, `--font-head`, `--size-title`, `--weight-title` aus tokens.css |
| Marker, Calm | keine – der Marker ist kein Theme-Wert |

Nicht aus Based-Tokens (es gibt keine): Diagrammfarben (`--color-data-*`) und Syntaxfarben von `CodeBlock` – Astryx-Standard.

Schriften für Stil Bold (Schibsted Grotesk, Literata) sind lokal gebündelt: `@fontsource/schibsted-grotesk` und
`@fontsource/literata`, beide **SIL Open Font License 1.1** (Lizenztext in den Paketen). `src/boldFonts.ts` wird nur
nachgeladen, wenn der Stil aktiv ist. E2E `theme.spec.ts` prüft für Default und Bold, dass kein Request an fremde
Hosts geht.

## Based-Wrapper (`@based/ui/astryx`)

Dünne Wrapper, damit Views keine Astryx-Props kennen müssen. Ansehen: Einstellungen → Diagnostics → „Open design
kit“ (`#prefs-kit`), Screenshots `screens/web-astryx-kit-*.png`.

| Baustein | Wofür |
|---|---|
| `BasedButton` | `variant`: `primary` (Tinte, eine pro Ansicht) · `secondary` · `ghost` · `danger`; `busy`, `disabled`, `type="submit"` |
| `BasedDialog` | Titel, Untertitel, Inhalt, `actions` rechts unten; `busy` sperrt das Schließen, `form` den Klick daneben |
| `BasedConfirm` | Rückfrage vor Unumkehrbarem (AlertDialog), schließt nach `onConfirm` |
| `BasedMenu` | Menü an einem Button: `items` mit `label`, `description`, `danger`, `{}` = Trennlinie |
| `BasedPopover` | freier Inhalt an einem Auslöser |
| `BasedField` | einzeiliges Feld mit Label, `hint`, `error` |

```tsx
import { BasedButton, BasedDialog, BasedField } from "@based/ui/astryx";

<BasedDialog open={open} onClose={close} title="Rename page" form
  actions={<><BasedButton label="Cancel" variant="ghost" onClick={close} /><BasedButton label="Rename" variant="primary" onClick={save} /></>}>
  <BasedField label="Page name" value={name} onChange={setName} error={error} />
</BasedDialog>
```

## Einstellungen erweitern

Seiten (wie in der Swift-Vorlage) stehen in `apps/web/src/shell/settings.ts`. Ein Bereich hängt seinen Abschnitt
über die Registry ein und fasst `Settings.tsx` nicht an:

```tsx
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";

function AIKeys({ client }: SettingsSectionProps) { … }
registerSettingsSection({ id: "ai-keys", page: "agents", title: "API keys", component: AIKeys,
  provides: ["API keys for AI providers"] }); // nimmt den Eintrag aus „Not available yet“
```

`page` ist eine ID aus `SETTINGS_PAGES`, `order` sortiert (Standard 100), die Rückgabe meldet wieder ab. Bausteine
für Zeilen: `screens/settings/parts.tsx` (`Group`, `Row`, `Value`). Adresse einer Seite: `#prefs-<id>`.

## Regeln

- Fertig gebaute CSS, kein StyleX-Compiler: keine `xstyle`-Props, keine Vorlagen, die StyleX brauchen.
- Nichts von fremden Servern laden (Schriften, Icons). `astryx theme add` nicht benutzen, es bindet `fonts.css` ein.
- Farben, Radien, Abstände kommen aus `@based/design-tokens`. Astryx-Tokens werden im Theme darauf abgebildet,
  nicht per `:root` überschrieben. Neue Abbildungen gehören in `astryxThemeSpec` (mit Test).
- Editor (BlockNote) und Datenbank-Views (virtualisiert) bleiben eigene Bausteine. Astryx ist für Shell, Menüs,
  Dialoge, Einstellungen, Formulare, Chat- und Agenten-Oberflächen.

## Offen

- Bestehende Shell-Teile schrittweise auf Astryx-Komponenten umstellen (Import-/Export-Dialoge, Seitenmenü,
  Quick Find, Papierkorb nutzen noch die eigenen Klassen), Screenshots vorher/nachher.
- Scrim im Dunkeln: `--color-overlay` mischt wie `.dialog-backdrop` 16 % `ink` – im Dunkeln hellt das auf. Ein
  eigenes Token `scrim` wäre sauberer (Designentscheidung).
- Tokens für Diagramm- und Syntaxfarben, falls Astryx-Charts/CodeBlock genutzt werden.
- Glas (`data-material="glass"`) für Astryx-Popover und -Dialoge auf Apple-Plattformen.
- Bundle-Größe beobachten (Komponenten einzeln importieren: `@astryxdesign/core/Button`).

## Nachschlagen

`pnpm --filter @based/web exec astryx search "<begriff>"`, `… component <Name>`, `… docs theme`, `… doctor`.
