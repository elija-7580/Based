# ADR 0012: Designsprache „Based Default“ und Token-Paket

- **Status:** akzeptiert (2026-11-09, Elija)
- **Bezug:** ADR 0009 (Werte nur aus Tokens), ADR 0011 (TypeScript-Stack), `docs/design/README.md`

## Kontext

Based kopierte bisher den Notion-Look. ADR 0009 sah eine eigene Gestaltung nach der Parität vor. In sechs
Entwurfsrunden (Canvas „Based – Design“) war Elija jede starke Richtung „etwas zu stark“ für den Alltag; eine
Research-Synthese bestätigte: Notiz-Apps sollen im Standard zurücktreten und sich tief anpassen lassen.

## Optionen

1. Notion-Look behalten.
2. Starker eigener Look als Standard (Schibsted + Literata, kräftige Titel, Akzentfarbe).
3. **Leiser Standard mit einem einzigen Signal (Agent-Marker), Stärke als wählbares Theme „Bold“.**

## Entscheidung

Option 3. Werte stehen in `packages/design-tokens/tokens.json`; `tokens.css` wird daraus erzeugt und per
Test auf Aktualität und Kontrast (Text ≥ 4,5:1, Bedienelement-Ränder ≥ 3:1, beide Themes) geprüft.
Einstellungen schalten über Attribute am Wurzelelement: `data-theme`, `data-style`, `data-density`,
`data-marker`, `data-calm`. Logo: Stencil-b aus zwei weichen Blöcken auf einer Marker-Basis.

## Folgen

- Oberflächen in `apps/*` importieren `@based/design-tokens/tokens.css` und nutzen nur `var(--…)`.
- Der Marker ist reserviert für Agent-Arbeit; Reviews und der Nachtlauf melden andere Verwendungen.
- Neue Werte kommen zuerst in `tokens.json`, danach `pnpm --filter @based/design-tokens css`.
