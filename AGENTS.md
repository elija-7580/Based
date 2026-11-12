# AGENTS

Project-specific guidance for AI coding agents.

## Based zuerst

Für Based Next gelten zuerst die Regeln aus `docs/design/README.md` (Designsprache „Based Default“) und
`docs/design/astryx.md`. Wo der Astryx-Block unten dem widerspricht, gewinnt Based:

- Vor jeder sichtbaren Änderung den Skill `.claude/skills/based-design/SKILL.md` lesen und befolgen.
- Eine Bedienoberfläche überall: Menüs, Popover, Toolbars und Dialoge – auch im Editor und in Datenbank-Views –
  kommen aus `@based/ui/astryx` (oder sehen genau so aus). Views importieren `@astryxdesign/core` nicht direkt.
- Bestehender Blockinhalt (Editor) und der Tabellenkörper (Datenbank) werden nicht wegen „No <div>“ umgeschrieben.
- `astryx theme add` nicht benutzen (bindet `fonts.css` ein, das lädt Google Fonts). Theme: `apps/web/src/astryxTheme.ts`.
- CLI im Repo: `pnpm --filter @based/web exec astryx <cmd>`.

## Fertig heißt poliert

Ein Eintrag mit sichtbarer Oberfläche ist erst fertig, wenn `docs/quality/checklist.md` für die berührten Screens
abgehakt ist: in 1280 × 820, 900 × 600 und 1728 × 1000, hell und dunkel, in allen Zuständen im Browser ansehen
(Playwright), Bildschirmfotos nach `docs/design/screens/`, Verstöße beheben und jeden mit einem Test absichern
(`apps/web/e2e/polish.spec.ts` oder beim Bereich). Was nicht zum Eintrag gehört, wird ein eigener Backlog-Eintrag
„Feinschliff · …“ (Typ „UX/Polish“). Ins Ergebnisfeld gehört die Zeile „Checkliste: geprüft …, behoben …, offen …“.

## Prüfen (gestuft, BSD-322)

- **Pro Änderung:** `ci/typecheck/run-ts.sh --fast` – typecheck, lint, Unit-Tests in beiden Datenformaten
  (inkl. Fixture-Runner) und Playwright-Smoke (`@smoke`, Chromium, ~1 min). Bei sichtbarer Oberfläche zusätzlich
  die betroffenen Specs in beiden Browsern: `ci/typecheck/run-ts.sh --e2e-area <muster>` (Dateiname oder Titel).
  Mehrere Arbeitsordner: `BASED_E2E_PORT=<port>`, Playwright mit `--trace off`.
- **Vor dem Merge nach main:** der CI-Job `ts-fast` muss grün sein (Branch `ci-logs`, `ts-fast/status.txt`; für
  Pushes auf `nightly/**` unter `branch-<name>/`). Den vollen Lauf (`--e2e`, ~20 min) nicht in jeder Schicht
  wiederholen: in der CI läuft er als Matrix (Chromium/WebKit × 2 Shards), Ergebnis in `ts/status.txt`
  (grün | rot | abgebrochen).
- **Zeitmessungen** (`@perf` in Playwright, `expectWithinBudget` aus `packages/core/test/perf-budget.ts` in
  Unit-Tests): lokal gelten die Schwellen, in der CI nur Warnung. Eine rote Zeitmessung erst wiederholen und
  dann die Ursache ansehen, nicht die Schwelle anheben.
- `@smoke` nur für Kernfälle vergeben (Seite anlegen, tippen, Slash, Datenbank, Sidebar, ⌘K, Neuladen; ~20 Tests).
- Swift (`legacy/`) nur prüfen, wenn Swift-Code oder `fixtures/` berührt sind.

<!-- ASTRYX:START -->
Astryx v0.7.11 · 174 components
CLI: run every command as `pnpm dlx @astryxdesign/cli@0.7.11 <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then tokens (var(--color-*|--spacing-*|--radius-*)). No raw hex/px. No StyleX/Tailwind compiler here — don't use xstyle/utility classes directly. Some templates use StyleX and need a compiler plugin; see `astryx docs styling-overview`.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->
