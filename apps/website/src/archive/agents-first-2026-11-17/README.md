# Archiv: Website mit Agenten zuerst (Stand 17.11.2026)

Am 17.11.2026 hat Elija die Website umgestellt: zuerst die Notiz-App und die eigene Marke („Your data. Based.“), Agenten
erst nach der Beta. Die Agenten-Teile sind nicht verworfen, sie kommen wieder, wenn die AI-Schicht da ist. Hier liegt
deshalb der alte Stand zum Wiederverwenden. Nichts davon wird gebaut: `scripts/build.mjs` liest nur `src/pages/`.

Quelle: `main` @ 838b3ef (vor PR #32).

## Was hier liegt

| Datei | Inhalt |
| --- | --- |
| `pages/Main.dc.html` | alte Startseite (Desktop), Canvas v7 unverändert |
| `pages/Mobile.dc.html` | alte Startseite (Handy) |
| `pages/Workspace.dc.html`, `Agents.dc.html`, `Switch.dc.html` | die Seiten, deren Texte sich geändert haben (Original aus dem Canvas) |
| `build.mjs.txt` | alter Build mit den alten `CLAIMS` für Main und Mobile (welche Aussagen die Beta damals nicht halten konnte) |
| `marketing/asset.html` | alte Quelle der Profil- und Marketingbilder (Zeile „Databases, docs and agents.“, Agenten-Zeile im App-Bild) |
| `marketing/og-image.png` | altes Link-Vorschaubild |
| `marketing/README.md` | alte Bios, Slogans, Product-Hunt-Texte, angepinnter Post |

## Bausteine für später (in `pages/Main.dc.html`)

- **Hero „Databases, docs and agents. Instant. Private. Everywhere.“** mit Buchstaben-Animation (`hero1`, `hero2`).
- **Home-Vorschau mit Agenten-Timeline:** Tageszeitleiste mit Spuren (Done, Working, Needs you, Scheduled), Jetzt-Linie,
  darunter „Good morning. What should we do today?“ und das Eingabefeld mit Pillen Agent, Model, Permission, Tools, Privacy,
  deren Menüs nacheinander aufgehen (`lanes`, `menus`, `prompts`, Timer `typeTimer`, `menuTimer`).
- **„Two things, done properly“:** Karte „02 The agents, opt-in“ mit „A crew that comes to you.“ und den Agenten-Meldungen (`pings`).
- **„Start in your terminal. Finish on your phone.“:** Weg Terminal → Cloud sandbox → Phone → Workspace mit Punkt und
  Meldungen (`evNodes`, `evMsg`, Timer `evTimer`).
- **„What you get, and when.“:** Beta- und Release-Liste mit Agenten-Punkten.
- **Warteliste-Antworten mit Agenten-Stimme** (`composeReply`: Morgen-Briefing, Vorlesung mitschreiben, Terminal bis Handy).
- **Anwendungsfälle mit Agenten:** „Agents keep them current and brief you every morning“, „Record, transcribe on device“.
- **Schluss „Based on nobody's cloud.“**

Beim Zurückholen gilt weiter `docs/website-claims.md`: nur versprechen, was der Build kann, sonst „at release“ dazu.
