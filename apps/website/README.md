# @based/website – basednotes.app

Die Marketing-Website von Based. Quelle sind die Artboards aus dem Design-Canvas „Based – Website“ (v7), unverändert in
`src/pages/*.dc.html`. Sie sind identisch mit `website/canvas/` auf dem Branch `website` (dort erzeugt `website/src/build.py`
sie aus den Seitenquellen). Nach einer Änderung dort die Dateien hierher kopieren und neu bauen. Dieser Build ersetzt den
älteren GitHub-Pages-Export (`website/export`, Branch `gh-pages`), weil die Seite jetzt auf dem eigenen Server mit Warteliste läuft. `scripts/build.mjs` macht daraus die statische Seite in `public/`:

- `src/static/dc-lite.js`: eigene kleine Laufzeit (≈ 250 Zeilen, ohne Framework) für `{{…}}`, `<sc-for>`, `<sc-if>`,
  `onClick="{{fn}}"` und `class Component extends DCLogic`. Rendert bei jeder Zustandsänderung neu und gleicht das DOM ab,
  damit Animationen, Fokus und das offene Handy-Menü erhalten bleiben.
- Patches beim Bauen (benannt in `build.mjs`, scheitern laut, wenn der Canvas sich ändert): Links auf echte Pfade, Logo-Dateien,
  Schrift selbst gehostet (keine Google Fonts), Footer-Links auf `/imprint` und `/privacy`, Einwilligungstext und Honeypot an
  der Warteliste, Aufruf von `/api/waitlist` und `/api/ideas`.
- Startseite neu gerahmt (17.11.2026, Elija): Headline „Your data. Based.“ (eigene Marke, Notion nur als Umzugsweg
  „Coming from Notion?“). Zuerst die Notiz-App (Arbeitsbereich, Notion-Umzug, Datenbanken, wo die Daten liegen,
  Notion-Ärger, „The notes app we build together.“), Agenten erst danach als „After the beta“. `Main.dc.html` und
  `Mobile.dc.html` werden dafür direkt hier im Repo bearbeitet und sind dem Canvas (v7) voraus; ihre Texte halten sich schon
  an den Beta-Umfang, deshalb gibt es für sie keine `CLAIMS`-Patches mehr. Kopfzeile ohne „Agents“ (bleibt im Footer),
  Footer-Zeile „Your data. Based. …“ auf allen Seiten (`patchNav`). Test: `framing (17.11.2026)` in `test/site.test.mjs`.
- Startseite: am Handy (≤ 760 px) die eigene Mobile-Version (`Mobile.dc.html`), `/?desktop` erzwingt die Desktop-Version.
- Logo-Intro: auf jeder Seite „tippt“ sich das Zeichen im Kopf beim Laden einmal (Linie, Einfügemarke, Stamm, Bauch; wie in
  der App, `apps/web/src/components/logoTimeline.ts`). Reines CSS aus `build.mjs`, weil nur CSS-Animationen das Abgleichen
  des DOM überstehen; `site.js` nimmt danach `lg-intro` weg. Hover gibt einen „Anschlag“ (Linie gibt nach, Blöcke kippeln).
  Die Hüpf-Animationen aus dem Canvas (`bsdStem`, `bsdBowl`) sind überall abgeschaltet.
- Nur heller Modus: kein dunkler Modus, auch nicht per Systemeinstellung.
- Mit Google Chrome auf dem Rechner werden alle Seiten vorgerendert (Inhalt ohne JavaScript sichtbar, gut für Suchmaschinen).
- `src/legal/`: Impressum (Offenlegung § 25 MedienG) und Datenschutzerklärung, Deutsch mit kurzer englischer Zusammenfassung.

```bash
pnpm --filter @based/website build      # → public/
pnpm --filter @based/website waitlist   # Warteliste-Dienst auf :8790 (WAITLIST_ORIGINS=http://localhost:4321 lokal)
pnpm --filter @based/website serve      # Vorschau auf http://localhost:4321, /api/* geht an den Dienst
pnpm --filter @based/website test       # Build-Prüfungen + Warteliste
```

Online stellen: [`deploy/website/README.md`](../../deploy/website/README.md).
