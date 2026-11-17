# Tastatur überall

Stand 17. 11. 2026. Ziel (Elija): die ganze App lässt sich ohne Maus bedienen, und man sieht jederzeit, welche
Tasten an der Stelle gelten, an der man gerade ist.

## Die Teile

| Teil | Datei | Was es tut |
|---|---|---|
| Tastatur-Register | `apps/web/src/shell/keymap.ts` | Jede Taste der App an einer Stelle: Kennung, Beschriftung, Tasten, Stelle (`scope`), Abschnitt. Quelle für Übersicht, Kurzanzeige und Mac-Menü. |
| Schreibweise | `packages/ui/src/keys.ts` | „Mod+Shift+K“ lesen, anzeigen (⇧⌘K / Ctrl+Shift+K), mit Ereignissen abgleichen, als Menü-Kürzel schreiben. |
| App-Kürzel | `apps/web/src/shell/shortcuts.ts` | Taste → Aktion für alles, was überall gilt (unverändert der Ort der Verarbeitung). |
| Pfeiltasten | `apps/web/src/shell/arrowNav.ts`, `packages/ui/src/spatial.ts` | Fokus zum nächstgelegenen Bedienelement in Pfeilrichtung; Seitenleiste als eine Liste; ⇧F10 = Kontextmenü; verlorenen Fokus zurückholen. |
| Übersicht | `apps/web/src/components/ShortcutSheet.tsx` | ⇧⌘/ (⌘?), Hilfe-Menü, ⌘K „Keyboard shortcuts“. Durchsuchbar. |
| Kurzanzeige | `apps/web/src/components/ShortcutHud.tsx` | ⌘ lange halten: Tasten der Stelle (Seitenleiste, Text, Blöcke, Datenbank, Tabelle, Menü) plus das Wichtigste von überall. |
| Mac-Menü | `apps/desktop/src-tauri/src/menu.rs` | File, Edit, View, Go, Help mit denselben Kürzeln. Ein Klick schickt `desktop://command`; die Oberfläche drückt dann die Taste des Eintrags selbst (`shell/commands.ts`) – ein Weg für Taste und Menü. |

## Regeln

- Neue Taste: dort verarbeiten, wo sie gilt, **und** im Register eintragen. `keymap.test.ts` prüft, dass an einer
  Stelle keine Taste doppelt liegt, dass die App-Kürzel des Registers ihre Aktion auslösen und dass `menu.rs` genau
  die Menü-Einträge des Registers nennt (Kennung, Beschriftung, Kürzel, Reihenfolge).
- Pfeiltasten gehören zuerst dem Element: Textfelder, Editor, `role=grid`, `role=menu`, `role=application`, Canvas
  behalten sie. Wer Pfeile selbst verarbeitet, ruft `preventDefault()`. Bereich ganz ausnehmen: `data-arrow-nav="off"`.
- Jedes Bedienelement ist ein echter Knopf/Link oder hat `tabindex` und eine Tastaturaktion. Zeilen, die nur per
  Pfeil erreichbar sein sollen (Seitenbaum), bekommen `tabindex="-1"`.
- Schließt ein Menü, geht der Fokus an den Auslöser zurück. Fällt er doch auf die Seite, holt ihn die nächste
  Pfeil- oder Tab-Taste zurück.
- ⌘/ gehört im Editor dem Blockmenü (wie Notion); die Übersicht liegt deshalb auf ⇧⌘/. ⌘0 bleibt dem Browser-Zoom;
  „in die Seitenleiste und zurück“ ist ⇧⌘E.

## Offen

- Whiteboard und Graph haben eigene Tasten, stehen aber noch nicht im Register.
- Kürzel selbst belegen (Einstellungen) – das Register ist dafür vorbereitet, die Verarbeitung noch nicht.
- Am Mac zu prüfen: Menüleiste (Klick und Kürzelanzeige), ⇧⌘/ gegen die Hilfe-Suche von macOS.
