# @based/website – basednotes.app

Die Marketing-Website von Based. Quelle sind die Artboards aus dem Design-Canvas „Based – Website“ (v7), unverändert in
`src/pages/*.dc.html`. `scripts/build.mjs` macht daraus die statische Seite in `public/`:

- `src/static/dc-lite.js`: eigene kleine Laufzeit (≈ 250 Zeilen, ohne Framework) für `{{…}}`, `<sc-for>`, `<sc-if>`,
  `onClick="{{fn}}"` und `class Component extends DCLogic`. Rendert bei jeder Zustandsänderung neu und gleicht das DOM ab,
  damit Animationen, Fokus und das offene Handy-Menü erhalten bleiben.
- Patches beim Bauen (benannt in `build.mjs`, scheitern laut, wenn der Canvas sich ändert): Links auf echte Pfade, Logo-Dateien,
  Schrift selbst gehostet (keine Google Fonts), Footer-Links auf `/imprint` und `/privacy`, Einwilligungstext und Honeypot an
  der Warteliste, Aufruf von `/api/waitlist` und `/api/ideas`.
- Startseite: am Handy (≤ 760 px) die eigene Mobile-Version (`Mobile.dc.html`), `/?desktop` erzwingt die Desktop-Version.
- Dunkler Modus folgt der Systemeinstellung; `?theme=dark|light` erzwingt ihn.
- Mit Google Chrome auf dem Rechner werden alle Seiten vorgerendert (Inhalt ohne JavaScript sichtbar, gut für Suchmaschinen).
- `src/legal/`: Impressum (Offenlegung § 25 MedienG) und Datenschutzerklärung, Deutsch mit kurzer englischer Zusammenfassung.

```bash
pnpm --filter @based/website build      # → public/
pnpm --filter @based/website waitlist   # Warteliste-Dienst auf :8790 (WAITLIST_ORIGINS=http://localhost:4321 lokal)
pnpm --filter @based/website serve      # Vorschau auf http://localhost:4321, /api/* geht an den Dienst
pnpm --filter @based/website test       # Build-Prüfungen + Warteliste
```

Online stellen: [`deploy/website/README.md`](../../deploy/website/README.md).
