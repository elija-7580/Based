// BSD-281 (entschieden von Elija am 11.11.): Einträge der Seitenleiste. Oben fest Search, Home, Chat; unten Library,
// Trash, Settings als Icon-Zeile neben dem Sync-Status; Tasks, Graph und Coding stehen nicht mehr in der Leiste
// (Tasks über „All tasks“ auf der Startseite, Graph als Reiter in der Library, Coding nur im erweiterten
// Agenten-Modus = „Show agent details“). Jeder Eintrag lässt sich per Rechtsklick oben anpinnen oder ausblenden; das
// gilt pro Gerät (localStorage). Alles bleibt über ⌘K erreichbar (NAV_COMMANDS). Rein, ohne DOM.

export type NavID = "search" | "home" | "chat" | "tasks" | "coding" | "graph" | "library" | "trash" | "settings";

export interface NavDef {
  id: NavID;
  name: string;
  /** Wo der Eintrag ohne eigene Wahl steht. */
  home: "top" | "footer" | "none";
}

export const NAV: readonly NavDef[] = [
  { id: "search", name: "Search", home: "top" },
  { id: "home", name: "Home", home: "top" },
  { id: "chat", name: "Chat", home: "top" },
  { id: "tasks", name: "Tasks", home: "none" },
  { id: "coding", name: "Coding", home: "none" },
  { id: "graph", name: "Graph", home: "none" },
  { id: "library", name: "Library", home: "footer" },
  { id: "trash", name: "Trash", home: "footer" },
  { id: "settings", name: "Settings", home: "footer" },
];

/**
 * Fuß als Icon-Zeile („probieren wir es mal“, Elija). Zurück auf die alte Liste: hier "list" setzen – Sidebar.tsx
 * zeichnet dann Library, Trash, Settings wieder als Zeilen mit Text über dem Sync-Status.
 */
export const FOOTER_STYLE: "icons" | "list" = "icons";

export interface NavPrefs {
  /** Oben angepinnt (in dieser Reihenfolge, hinter den festen Einträgen). */
  pinned: NavID[];
  /** Ausgeblendet (weder oben noch unten). */
  hidden: NavID[];
}

export const EMPTY_NAV_PREFS: NavPrefs = { pinned: [], hidden: [] };

const KNOWN = new Set<string>(NAV.map((n) => n.id));

/** Gespeicherte Wahl säubern (unbekannte oder doppelte IDs fallen weg). */
export function cleanNavPrefs(v: unknown): NavPrefs {
  const o = (v && typeof v === "object" ? v : {}) as { pinned?: unknown; hidden?: unknown };
  const list = (x: unknown) => [...new Set(Array.isArray(x) ? x.filter((s): s is NavID => typeof s === "string" && KNOWN.has(s)) : [])];
  const hidden = list(o.hidden);
  return { pinned: list(o.pinned).filter((id) => !hidden.includes(id)), hidden };
}

/** Darf der Eintrag überhaupt erscheinen? Coding nur im erweiterten Agenten-Modus. */
export const navAvailable = (id: NavID, opts: { advanced: boolean }) => id !== "coding" || opts.advanced;

export interface NavLayout {
  top: NavID[];
  footer: NavID[];
}

export function navLayout(prefs: NavPrefs, opts: { advanced: boolean }): NavLayout {
  const shown = (id: NavID) => navAvailable(id, opts) && !prefs.hidden.includes(id);
  const top = NAV.filter((n) => n.home === "top" && shown(n.id)).map((n) => n.id);
  for (const id of prefs.pinned) if (shown(id) && !top.includes(id)) top.push(id);
  const footer = NAV.filter((n) => n.home === "footer" && shown(n.id) && !top.includes(n.id)).map((n) => n.id);
  return { top, footer };
}

/** Wo steht der Eintrag gerade? */
export function navPlace(id: NavID, prefs: NavPrefs, opts: { advanced: boolean }): "top" | "footer" | "none" {
  const l = navLayout(prefs, opts);
  return l.top.includes(id) ? "top" : l.footer.includes(id) ? "footer" : "none";
}

/** Oben anpinnen (holt ihn auch aus „ausgeblendet“ zurück). */
export function pinNav(prefs: NavPrefs, id: NavID): NavPrefs {
  return { pinned: [...prefs.pinned.filter((x) => x !== id), id], hidden: prefs.hidden.filter((x) => x !== id) };
}

/** Lösen: zurück an seinen Stammplatz (oben feste bleiben oben, Fuß-Einträge gehen zurück in den Fuß). */
export function unpinNav(prefs: NavPrefs, id: NavID): NavPrefs {
  return { pinned: prefs.pinned.filter((x) => x !== id), hidden: prefs.hidden };
}

export function hideNav(prefs: NavPrefs, id: NavID): NavPrefs {
  return { pinned: prefs.pinned.filter((x) => x !== id), hidden: [...prefs.hidden.filter((x) => x !== id), id] };
}

/** Wieder zeigen: an seinem Stammplatz, bzw. oben angepinnt, wenn er keinen hat (Tasks, Graph, Coding). */
export function showNav(prefs: NavPrefs, id: NavID): NavPrefs {
  const next = { pinned: prefs.pinned, hidden: prefs.hidden.filter((x) => x !== id) };
  return NAV.find((n) => n.id === id)?.home === "none" ? pinNav(next, id) : next;
}

// MARK: ⌘K – alles bleibt erreichbar

export interface NavCommand {
  id: string;
  label: string;
  /** Weitere Suchwörter. */
  keywords: string[];
}

export const NAV_COMMANDS: readonly NavCommand[] = [
  { id: "home", label: "Home", keywords: ["start"] },
  // immer das Dashboard (Zeitbogen), auch wenn als Home eine Seite gewählt ist
  { id: "dashboard", label: "Dashboard", keywords: ["arc", "agents", "overview", "home dashboard"] },
  { id: "chat", label: "Chat", keywords: ["ask", "ai"] },
  { id: "tasks", label: "All tasks", keywords: ["tasks", "agents", "inbox"] },
  { id: "coding", label: "Coding", keywords: ["code", "agent", "terminal"] },
  { id: "graph", label: "Graph", keywords: ["links", "map"] },
  { id: "meetings", label: "Meetings", keywords: ["meeting notes", "recordings", "transcripts"] },
  { id: "meeting", label: "New meeting", keywords: ["meeting", "notes", "record", "transcribe"] },
  { id: "library", label: "Library", keywords: ["all pages", "pages", "databases"] },
  { id: "trash", label: "Trash", keywords: ["deleted", "bin"] },
  { id: "settings", label: "Settings", keywords: ["preferences", "options"] },
];

/** Befehle passend zur Eingabe (Wortanfang in Name oder Suchwort); leere Eingabe: keine. Coding gibt es hier immer. */
export function matchCommands(query: string): NavCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = (s: string) => s.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || s.toLowerCase().startsWith(q);
  return NAV_COMMANDS.filter((c) => starts(c.label) || c.keywords.some(starts));
}
