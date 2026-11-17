// Das Tastatur-Register: jede Taste der App an einer Stelle – Quelle für die Übersicht (⇧⌘/), die Anzeige beim
// Halten von ⌘ (passend zur Stelle, an der man gerade ist), die Kürzel in Menüs und das Mac-Menü oben
// (apps/desktop/src-tauri/src/lib.rs; keymap.test.ts prüft, dass beide übereinstimmen). Rein, ohne DOM.
//
// Schreibweise der Tasten: packages/ui/src/keys.ts („Mod“ = ⌘ auf Apple, Strg sonst; mehrere mit „ / “;
// „Arrows“ = alle vier Pfeiltasten, „0–9“ = Ziffernbereich – nur für die Anzeige).
// Die Tasten selbst verarbeiten weiterhin die Stellen, an denen sie gelten (shortcuts.ts für die App, der
// Block-Editor, die Datenbank-Tabelle, die Seitenleiste). Wer dort eine Taste ändert, ändert sie auch hier.

export type KeyScope = "global" | "sidebar" | "editor" | "blocks" | "database" | "table" | "menu";

export interface KeyEntry {
  /** Stabile Kennung; für Einträge mit `command` zugleich die Kennung im Mac-Menü. */
  id: string;
  label: string;
  keys: string;
  scope: KeyScope;
  /** Überschrift in der Übersicht. */
  group: string;
  /** Steht im Mac-Menü unter diesem Menü (in Register-Reihenfolge). */
  menu?: "App" | "File" | "Edit" | "View" | "Go" | "Help";
  /** Trennlinie davor im Mac-Menü. */
  menuSeparator?: boolean;
  /** Anderer Text im Mac-Menü (dort mit „…“ und in Titelschreibweise). */
  menuLabel?: string;
  /** Nur mit eingeschalteter AI. */
  ai?: boolean;
  /** Erscheint in der Kurzanzeige beim Halten von ⌘ (die wichtigsten je Stelle). */
  hud?: boolean;
}

const G = "General", NAV = "Navigation", TABS = "Tabs";

export const KEYMAP: readonly KeyEntry[] = [
  // MARK: überall
  { id: "quickFind", label: "Search", keys: "Mod+K", scope: "global", group: G, menu: "Go", menuLabel: "Search…", hud: true },
  { id: "palette", label: "New… (page, database, import)", keys: "Mod+N", scope: "global", group: G, menu: "File", menuLabel: "New…", hud: true },
  { id: "newPage", label: "New page", keys: "Mod+Alt+N", scope: "global", group: G, menu: "File", menuLabel: "New Page" },
  { id: "chat", label: "Chat", keys: "Mod+J", scope: "global", group: G, ai: true },
  { id: "settings", label: "Settings", keys: "Mod+,", scope: "global", group: G, menu: "App", menuLabel: "Settings…" },
  { id: "shortcuts", label: "Keyboard shortcuts", keys: "Mod+Shift+/", scope: "global", group: G, menu: "Help", menuLabel: "Keyboard Shortcuts", hud: true },
  { id: "toggleTheme", label: "Switch between light and dark", keys: "Mod+Shift+L", scope: "global", group: G, menu: "View", menuLabel: "Switch Light / Dark" },
  { id: "reportProblem", label: "Report a problem", keys: "Mod+Shift+B", scope: "global", group: G },

  { id: "back", label: "Back", keys: "Mod+[", scope: "global", group: NAV, menu: "Go", menuSeparator: true },
  { id: "forward", label: "Forward", keys: "Mod+]", scope: "global", group: NAV, menu: "Go" },
  { id: "openParent", label: "Open the parent page", keys: "Mod+Shift+U", scope: "global", group: NAV, menu: "Go", menuLabel: "Parent Page" },
  { id: "home", label: "Home", keys: "Mod+Shift+H", scope: "global", group: NAV, menu: "Go", menuSeparator: true },
  { id: "toggleSidebar", label: "Show or hide the sidebar", keys: "Mod+\\", scope: "global", group: NAV, menu: "View", menuLabel: "Show / Hide Sidebar" },
  { id: "focusSidebar", label: "Jump to the sidebar and back", keys: "Mod+Shift+E", scope: "global", group: NAV, menu: "View", menuLabel: "Focus Sidebar", hud: true },
  { id: "region", label: "Next area: sidebar, header, page", keys: "F6 / Shift+F6", scope: "global", group: NAV },
  { id: "arrows", label: "Move between buttons and lists", keys: "Arrows", scope: "global", group: NAV, hud: true },
  { id: "activate", label: "Press the focused button", keys: "Enter / Space", scope: "global", group: NAV },
  { id: "tabStop", label: "Next or previous field", keys: "Tab / Shift+Tab", scope: "global", group: NAV },
  { id: "contextMenu", label: "Open the menu of the focused item", keys: "Shift+F10", scope: "global", group: NAV },
  { id: "find", label: "Find on this page", keys: "Mod+F", scope: "global", group: NAV, menu: "Edit", menuSeparator: true, menuLabel: "Find…" },
  { id: "findNext", label: "Next match", keys: "Mod+G", scope: "global", group: NAV, menu: "Edit", menuLabel: "Find Next" },
  { id: "findPrevious", label: "Previous match", keys: "Mod+Shift+G", scope: "global", group: NAV, menu: "Edit", menuLabel: "Find Previous" },

  { id: "newTab", label: "New tab", keys: "Mod+T", scope: "global", group: TABS, menu: "File", menuSeparator: true, menuLabel: "New Tab" },
  { id: "closeTab", label: "Close tab", keys: "Mod+W", scope: "global", group: TABS },
  { id: "nextTab", label: "Next tab", keys: "Mod+Shift+]", scope: "global", group: TABS, menu: "View", menuSeparator: true, menuLabel: "Next Tab" },
  { id: "previousTab", label: "Previous tab", keys: "Mod+Shift+[", scope: "global", group: TABS, menu: "View", menuLabel: "Previous Tab" },
  { id: "tabNumber", label: "Tab 1 to 8, last tab", keys: "Mod+1–9", scope: "global", group: TABS },

  // MARK: Seitenleiste
  { id: "sidebar.move", label: "Up and down through everything", keys: "ArrowUp / ArrowDown", scope: "sidebar", group: "Sidebar", hud: true },
  { id: "sidebar.open", label: "Open", keys: "Enter", scope: "sidebar", group: "Sidebar", hud: true },
  { id: "sidebar.expand", label: "Expand, or go to the first subpage", keys: "ArrowRight", scope: "sidebar", group: "Sidebar", hud: true },
  { id: "sidebar.collapse", label: "Collapse, or go to the parent", keys: "ArrowLeft", scope: "sidebar", group: "Sidebar", hud: true },
  { id: "sidebar.ends", label: "First or last entry", keys: "Home / End", scope: "sidebar", group: "Sidebar" },
  { id: "sidebar.menu", label: "Page menu (rename, move, delete)", keys: "Shift+F10", scope: "sidebar", group: "Sidebar", hud: true },
  { id: "sidebar.pick", label: "Select several pages", keys: "Shift+Space", scope: "sidebar", group: "Sidebar" },
  { id: "sidebar.leave", label: "Back to the page", keys: "Escape", scope: "sidebar", group: "Sidebar", hud: true },

  // MARK: Text in einem Block
  { id: "editor.slash", label: "Insert a block", keys: "/", scope: "editor", group: "Writing", hud: true },
  { id: "editor.mention", label: "Link a page or a date", keys: "@", scope: "editor", group: "Writing" },
  { id: "editor.blockMenu", label: "Block menu (turn into, colour, delete)", keys: "Mod+/", scope: "editor", group: "Writing", hud: true },
  { id: "editor.bold", label: "Bold", keys: "Mod+B", scope: "editor", group: "Writing", hud: true },
  { id: "editor.italic", label: "Italic", keys: "Mod+I", scope: "editor", group: "Writing" },
  { id: "editor.underline", label: "Underline", keys: "Mod+U", scope: "editor", group: "Writing" },
  { id: "editor.strike", label: "Strikethrough", keys: "Mod+Shift+S", scope: "editor", group: "Writing" },
  { id: "editor.code", label: "Inline code", keys: "Mod+E", scope: "editor", group: "Writing" },
  { id: "editor.link", label: "Link the selected text", keys: "Mod+K", scope: "editor", group: "Writing", hud: true },
  { id: "editor.turnInto", label: "Text, heading 1–3, to-do, list, numbers, toggle, code, page", keys: "Mod+Alt+0–9", scope: "editor", group: "Writing", hud: true },
  { id: "editor.indent", label: "Indent, outdent", keys: "Tab / Shift+Tab", scope: "editor", group: "Writing", hud: true },
  { id: "editor.move", label: "Move the block up or down", keys: "Mod+Shift+ArrowUp / Mod+Shift+ArrowDown", scope: "editor", group: "Writing", hud: true },
  { id: "editor.duplicate", label: "Duplicate the block", keys: "Mod+D", scope: "editor", group: "Writing" },
  { id: "editor.check", label: "Check a to-do, open a toggle", keys: "Mod+Enter", scope: "editor", group: "Writing" },
  { id: "editor.toggles", label: "Open or close all toggles", keys: "Mod+Alt+T", scope: "editor", group: "Writing" },
  { id: "editor.undo", label: "Undo, redo", keys: "Mod+Z / Mod+Shift+Z", scope: "editor", group: "Writing" },
  { id: "editor.selectBlock", label: "Select the block", keys: "Escape", scope: "editor", group: "Writing", hud: true },

  // MARK: ausgewählte Blöcke
  { id: "blocks.move", label: "Previous or next block", keys: "ArrowUp / ArrowDown", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.extend", label: "Select more blocks", keys: "Shift+ArrowUp / Shift+ArrowDown", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.edit", label: "Edit the text", keys: "Enter", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.menu", label: "Block menu (turn into, colour, delete)", keys: "Mod+/", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.delete", label: "Delete", keys: "Backspace", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.duplicate", label: "Duplicate", keys: "Mod+D", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.reorder", label: "Move up or down", keys: "Mod+Shift+ArrowUp / Mod+Shift+ArrowDown", scope: "blocks", group: "Selected blocks", hud: true },
  { id: "blocks.moveTo", label: "Move to another page", keys: "Mod+Shift+P", scope: "blocks", group: "Selected blocks" },
  { id: "blocks.indent", label: "Indent, outdent", keys: "Tab / Shift+Tab", scope: "blocks", group: "Selected blocks" },
  { id: "blocks.all", label: "Select all blocks", keys: "Mod+A", scope: "blocks", group: "Selected blocks" },
  { id: "blocks.clear", label: "Clear the selection", keys: "Escape", scope: "blocks", group: "Selected blocks" },

  // MARK: Datenbank-Tabelle
  { id: "db.move", label: "Move between cells", keys: "Arrows", scope: "database", group: "Database table", hud: true },
  { id: "db.tab", label: "Next or previous cell", keys: "Tab / Shift+Tab", scope: "database", group: "Database table", hud: true },
  { id: "db.edit", label: "Edit the cell (or just start typing)", keys: "Enter", scope: "database", group: "Database table", hud: true },
  { id: "db.open", label: "Open the row", keys: "Space", scope: "database", group: "Database table", hud: true },
  { id: "db.range", label: "Select several cells", keys: "Shift+Arrows", scope: "database", group: "Database table", hud: true },
  { id: "db.copy", label: "Copy, cut, paste", keys: "Mod+C / Mod+X / Mod+V", scope: "database", group: "Database table", hud: true },
  { id: "db.clear", label: "Clear the cells", keys: "Backspace", scope: "database", group: "Database table", hud: true },
  { id: "db.edges", label: "First or last row or column", keys: "Mod+Arrows", scope: "database", group: "Database table" },
  { id: "db.all", label: "Select all rows", keys: "Mod+A", scope: "database", group: "Database table" },
  { id: "db.menu", label: "Row menu", keys: "Shift+F10", scope: "database", group: "Database table", hud: true },
  { id: "db.leave", label: "Clear the selection", keys: "Escape", scope: "database", group: "Database table" },

  // MARK: einfache Tabelle im Text
  { id: "table.tab", label: "Next or previous cell (adds a row at the end)", keys: "Tab / Shift+Tab", scope: "table", group: "Simple table", hud: true },
  { id: "table.rows", label: "Row above or below", keys: "ArrowUp / ArrowDown", scope: "table", group: "Simple table", hud: true },
  { id: "table.down", label: "Cell below", keys: "Enter", scope: "table", group: "Simple table", hud: true },
  { id: "table.leave", label: "Select the table", keys: "Escape", scope: "table", group: "Simple table", hud: true },

  // MARK: Menüs und Dialoge
  { id: "menu.move", label: "Up and down", keys: "ArrowUp / ArrowDown", scope: "menu", group: "Menus and dialogs", hud: true },
  { id: "menu.choose", label: "Choose", keys: "Enter", scope: "menu", group: "Menus and dialogs", hud: true },
  { id: "menu.sub", label: "Open or leave a submenu", keys: "ArrowRight / ArrowLeft", scope: "menu", group: "Menus and dialogs", hud: true },
  { id: "menu.close", label: "Close", keys: "Escape", scope: "menu", group: "Menus and dialogs", hud: true },
];

/** Reihenfolge der Abschnitte in der Übersicht. */
export const KEY_GROUPS: readonly string[] = [G, NAV, TABS, "Sidebar", "Writing", "Selected blocks", "Database table", "Simple table", "Menus and dialogs"];

export const visibleEntries = (opts: { ai: boolean }): KeyEntry[] => KEYMAP.filter((e) => opts.ai || !e.ai);

/** Einträge passend zur Suche (Wörter in Beschriftung oder Abschnitt, in beliebiger Reihenfolge). */
export function searchKeymap(entries: readonly KeyEntry[], query: string): KeyEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => { const hay = `${e.label} ${e.group}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

/** Nach Abschnitt gruppiert, in fester Reihenfolge; leere Abschnitte fallen weg. */
export function groupKeymap(entries: readonly KeyEntry[]): { group: string; entries: KeyEntry[] }[] {
  return KEY_GROUPS.map((group) => ({ group, entries: entries.filter((e) => e.group === group) })).filter((g) => g.entries.length);
}

/** Womit die Stelle bestimmt wird: nur `closest`, damit es ohne DOM testbar bleibt. */
export interface ScopeTarget { closest(selector: string): unknown }

/** An welcher Stelle steht der Fokus? Bestimmt, welche Tasten die Kurzanzeige beim Halten von ⌘ nennt. */
export function scopeOf(el: ScopeTarget | null | undefined): KeyScope {
  if (!el) return "global";
  if (el.closest("[role=menu], [role=listbox], [role=dialog], .dbui-popover")) return "menu";
  if (el.closest(".bx2-cell")) return "table";
  if (el.closest("[role=grid]")) return "database";
  if (el.closest("[data-editable-id]")) return "editor";
  if (el.closest("[data-testid=block-editor]")) return "blocks";
  if (el.closest("nav.sidebar")) return "sidebar";
  return "global";
}

const SCOPE_TITLE: Record<KeyScope, string> = {
  global: "Everywhere", sidebar: "In the sidebar", editor: "While writing", blocks: "With blocks selected",
  database: "In a database table", table: "In a table", menu: "In menus and dialogs",
};

/** Kurzanzeige: die wichtigsten Tasten der Stelle, dazu (außer in Menüs) die wichtigsten von überall. */
export function hudFor(scope: KeyScope, opts: { ai: boolean }): { title: string; entries: KeyEntry[] }[] {
  const pick = (s: KeyScope) => visibleEntries(opts).filter((e) => e.scope === s && e.hud);
  const here = { title: SCOPE_TITLE[scope], entries: pick(scope) };
  if (scope === "global") return [here];
  return scope === "menu" ? [here] : [here, { title: SCOPE_TITLE.global, entries: pick("global") }];
}

/** Einträge fürs Mac-Menü, je Menü in Register-Reihenfolge. */
export function menuEntries(): Record<string, KeyEntry[]> {
  const out: Record<string, KeyEntry[]> = {};
  for (const e of KEYMAP) if (e.menu) (out[e.menu] ??= []).push(e);
  return out;
}

/** Erste Kombination eines Eintrags (für Menü und Tastendruck aus dem Menü). */
export const firstCombo = (e: KeyEntry) => e.keys.split(" / ")[0]!;
