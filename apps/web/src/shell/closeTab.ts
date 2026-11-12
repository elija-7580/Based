// BSD-310: Was ⌘W tut. Mehrere Tabs: den Tab schließen. Beim letzten Tab wie macOS-Apps: ein Seitenfenster schließt
// sich, das Hauptfenster blendet sich aus, solange noch andere Fenster offen sind. Nur im letzten Fenster wird der
// letzte Tab zur Startseite (die App bleibt offen, wie bisher).

export type CloseTabAction = "tab" | "close-window" | "hide-window" | "home";

export function closeTabAction(o: { tabs: number; pageWindow: boolean; otherVisibleWindows: number }): CloseTabAction {
  if (o.tabs > 1) return "tab";
  if (o.pageWindow) return "close-window";
  if (o.otherVisibleWindows > 0) return "hide-window";
  return "home";
}
