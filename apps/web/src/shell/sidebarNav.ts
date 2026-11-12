// BSD-281 (entschieden von Elija am 11.11.): Einträge der Seitenleiste. Oben fest Search, Home, Chat; unten Library,
// Trash, Settings als Icon-Zeile neben dem Sync-Status; Tasks, Graph und Coding stehen nicht mehr in der Leiste
// (Tasks über „All tasks“ auf der Startseite, Graph als Reiter in der Library, Coding nur im erweiterten
// Agenten-Modus = „Show agent details“). Jeder Eintrag lässt sich per Rechtsklick oben anpinnen oder ausblenden und per
// Ziehen umsortieren oder zwischen oben und Fuß verschieben (moveNav); das gilt pro Gerät (localStorage). Alles bleibt über ⌘K erreichbar (NAV_COMMANDS). Rein, ohne DOM.

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
  /** Vom Stammplatz oben in den Fuß gezogen (Search, Home, Chat). */
  lowered?: NavID[];
  /** Eigene Reihenfolge oben bzw. im Fuß (durch Ziehen); was hier fehlt, steht in der Standardreihenfolge dahinter. */
  order?: NavID[];
  footerOrder?: NavID[];
}

export const EMPTY_NAV_PREFS: NavPrefs = { pinned: [], hidden: [] };

const KNOWN = new Set<string>(NAV.map((n) => n.id));

/** Gespeicherte Wahl säubern (unbekannte oder doppelte IDs fallen weg). */
export function cleanNavPrefs(v: unknown): NavPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const list = (x: unknown) => [...new Set(Array.isArray(x) ? x.filter((s): s is NavID => typeof s === "string" && KNOWN.has(s)) : [])];
  const hidden = list(o.hidden);
  const pinned = list(o.pinned).filter((id) => !hidden.includes(id));
  const lowered = list(o.lowered).filter((id) => !hidden.includes(id) && !pinned.includes(id));
  const order = list(o.order);
  const footerOrder = list(o.footerOrder);
  return { pinned, hidden, ...(lowered.length ? { lowered } : {}), ...(order.length ? { order } : {}), ...(footerOrder.length ? { footerOrder } : {}) };
}

/** Optionen: erweiterter Agenten-Modus und AI-Schalter (shell/ai.ts; fehlt `ai`, gilt an). */
export interface NavOpts { advanced: boolean; ai?: boolean }

/** Einträge, die nur mit eingeschalteter AI erscheinen. */
export const AI_NAV: ReadonlySet<NavID> = new Set<NavID>(["chat", "tasks", "coding"]);

/** Darf der Eintrag überhaupt erscheinen? Coding nur im erweiterten Agenten-Modus; Chat, Tasks, Coding nur mit AI. */
export const navAvailable = (id: NavID, opts: NavOpts) => (opts.ai !== false || !AI_NAV.has(id)) && (id !== "coding" || opts.advanced);

export interface NavLayout {
  top: NavID[];
  footer: NavID[];
}

/** Nach eigener Reihenfolge sortieren; Einträge ohne Platz darin bleiben in ihrer Reihenfolge dahinter. */
function sorted(ids: NavID[], order: readonly NavID[] | undefined): NavID[] {
  if (!order?.length) return ids;
  const at = (id: NavID) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return ids.map((id, i) => ({ id, i })).sort((a, b) => at(a.id) - at(b.id) || a.i - b.i).map((x) => x.id);
}

export function navLayout(prefs: NavPrefs, opts: NavOpts): NavLayout {
  const shown = (id: NavID) => navAvailable(id, opts) && !prefs.hidden.includes(id);
  const lowered = prefs.lowered ?? [];
  const top = NAV.filter((n) => n.home === "top" && shown(n.id) && !lowered.includes(n.id)).map((n) => n.id);
  for (const id of prefs.pinned) if (shown(id) && !top.includes(id)) top.push(id);
  const footer = NAV.filter((n) => (n.home === "footer" || lowered.includes(n.id)) && shown(n.id) && !top.includes(n.id)).map((n) => n.id);
  return { top: sorted(top, prefs.order), footer: sorted(footer, prefs.footerOrder) };
}

/** Wo steht der Eintrag gerade? */
export function navPlace(id: NavID, prefs: NavPrefs, opts: NavOpts): "top" | "footer" | "none" {
  const l = navLayout(prefs, opts);
  return l.top.includes(id) ? "top" : l.footer.includes(id) ? "footer" : "none";
}

const without = (list: readonly NavID[] | undefined, id: NavID) => (list ?? []).filter((x) => x !== id);
/** Felder für eigene Reihenfolge und „in den Fuß gezogen“ mitnehmen (leere fallen weg). */
function keep(prefs: NavPrefs, lowered: NavID[]): Pick<NavPrefs, "lowered" | "order" | "footerOrder"> {
  return { ...(lowered.length ? { lowered } : {}), ...(prefs.order?.length ? { order: prefs.order } : {}), ...(prefs.footerOrder?.length ? { footerOrder: prefs.footerOrder } : {}) };
}

/** Oben anpinnen (holt ihn auch aus „ausgeblendet“ und aus dem Fuß zurück). */
export function pinNav(prefs: NavPrefs, id: NavID): NavPrefs {
  const home = NAV.find((n) => n.id === id)?.home;
  const pinned = home === "top" ? without(prefs.pinned, id) : [...without(prefs.pinned, id), id];
  return { pinned, hidden: without(prefs.hidden, id), ...keep(prefs, without(prefs.lowered, id)) };
}

/** Lösen: zurück an seinen Stammplatz (oben feste bleiben oben, Fuß-Einträge gehen zurück in den Fuß). */
export function unpinNav(prefs: NavPrefs, id: NavID): NavPrefs {
  return { pinned: without(prefs.pinned, id), hidden: prefs.hidden, ...keep(prefs, prefs.lowered ?? []) };
}

export function hideNav(prefs: NavPrefs, id: NavID): NavPrefs {
  return { pinned: without(prefs.pinned, id), hidden: [...without(prefs.hidden, id), id], ...keep(prefs, without(prefs.lowered, id)) };
}

/** Wieder zeigen: an seinem Stammplatz, bzw. oben angepinnt, wenn er keinen hat (Tasks, Graph, Coding). */
export function showNav(prefs: NavPrefs, id: NavID): NavPrefs {
  const next: NavPrefs = { pinned: prefs.pinned, hidden: without(prefs.hidden, id), ...keep(prefs, prefs.lowered ?? []) };
  return NAV.find((n) => n.id === id)?.home === "none" ? pinNav(next, id) : next;
}

/**
 * Ziehen: `id` nach oben oder in den Fuß, vor `before` (ohne `before` ans Ende). Legt die Reihenfolge beider Listen
 * fest und merkt, was dadurch seinen Stammplatz verlassen hat.
 */
export function moveNav(prefs: NavPrefs, id: NavID, to: "top" | "footer", before: NavID | undefined, opts: NavOpts): NavPrefs {
  if (before === id) return prefs;
  const shownPrefs: NavPrefs = { ...prefs, hidden: without(prefs.hidden, id) };
  const l = navLayout(shownPrefs, opts);
  const top = l.top.filter((x) => x !== id);
  const footer = l.footer.filter((x) => x !== id);
  const list = to === "top" ? top : footer;
  const at = before ? list.indexOf(before) : -1;
  list.splice(at < 0 ? list.length : at, 0, id);
  const home = (x: NavID) => NAV.find((n) => n.id === x)?.home;
  const pinned = top.filter((x) => home(x) !== "top");
  const lowered = footer.filter((x) => home(x) !== "footer");
  // Angepinntes, das gerade nicht erscheinen darf (Coding ohne Agenten-Modus), bleibt angepinnt.
  for (const x of prefs.pinned) if (x !== id && !pinned.includes(x) && !top.includes(x) && !footer.includes(x) && !shownPrefs.hidden.includes(x)) pinned.push(x);
  return { pinned, hidden: shownPrefs.hidden, ...(lowered.length ? { lowered } : {}), order: top, footerOrder: footer };
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
  // BSD-319: Fehler festhalten (⇧⌘B)
  { id: "report", label: "Report a problem", keywords: ["bug", "feedback", "diagnostics", "issue"] },
];

/** Befehle, die nur mit eingeschalteter AI erscheinen (Dashboard = Zeitbogen der Agenten). */
const AI_COMMANDS = new Set(["chat", "tasks", "coding", "dashboard"]);

/**
 * Befehle passend zur Eingabe (Wortanfang in Name oder Suchwort); leere Eingabe: keine. Coding gibt es hier immer,
 * solange AI an ist; mit `ai: false` fallen Chat, Tasks, Coding und Dashboard weg.
 */
export function matchCommands(query: string, opts: { ai?: boolean } = {}): NavCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = (s: string) => s.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || s.toLowerCase().startsWith(q);
  return NAV_COMMANDS.filter((c) => (opts.ai !== false || !AI_COMMANDS.has(c.id)) && (starts(c.label) || c.keywords.some(starts)));
}
