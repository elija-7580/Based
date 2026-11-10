// BSD-153: Navigation über schlichte Hash-Namen (#home, #graph, #appearance, #prefs-<seite>, #trash, #page-<id>; die claude.ai-
// Vorschau kennt nur #name, „settings“ ist dort reserviert) mit eigenem Verlauf für Vor/Zurück.

export type Route =
  | { name: "home" }
  | { name: "graph" }
  | { name: "library" }
  | { name: "settings"; page?: string }
  | { name: "trash" }
  /** Vollseiten-Chat (BSD-159). */
  | { name: "chat" }
  /** Aufträge des Hauptagenten (BSD-195). */
  | { name: "tasks" }
  /** Coding-Agenten auf dem Server (BSD-223). */
  | { name: "coding" }
  /** Agent-Detail (ein Lauf) und Projekt-Detail der Startseite (BSD-133). */
  | { name: "agent"; id: string }
  | { name: "project"; id: string }
  | { name: "page"; id: string };

export function routeToHash(r: Route): string {
  switch (r.name) {
    case "home": return "home";
    case "graph": return "graph";
    case "library": return "library";
    case "settings": return r.page ? "prefs-" + r.page : "appearance";
    case "trash": return "trash";
    case "chat": return "chat";
    case "tasks": return "tasks";
    case "coding": return "coding";
    case "agent": return "agent-" + r.id;
    case "project": return "project-" + r.id;
    case "page": return "page-" + r.id;
  }
}

export function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("page-") && h.length > 5) return { name: "page", id: decodeURIComponent(h.slice(5)) };
  if (h.startsWith("agent-") && h.length > 6) return { name: "agent", id: decodeURIComponent(h.slice(6)) };
  if (h.startsWith("project-") && h.length > 8) return { name: "project", id: decodeURIComponent(h.slice(8)) };
  if (h.startsWith("prefs-") && h.length > 6) return { name: "settings", page: decodeURIComponent(h.slice(6)) };
  switch (h) {
    case "graph": return { name: "graph" };
    case "library": return { name: "library" };
    case "appearance": case "settings": return { name: "settings" };
    case "trash": return { name: "trash" };
    case "chat": return { name: "chat" };
    case "tasks": return { name: "tasks" };
    case "coding": return { name: "coding" };
    default: return { name: "home" };
  }
}

export const sameRoute = (a: Route, b: Route) => routeToHash(a) === routeToHash(b);

/** Ein Tab der Shell: eigener Verlauf. */
export interface TabInfo {
  id: string;
  route: Route;
  canBack: boolean;
  canForward: boolean;
}

interface TabState {
  id: string;
  entries: Route[];
  index: number;
}

/** Gespeicherte Tabs (Routen als Hash-Namen). */
export interface SavedTabs {
  v: 1;
  tabs: { id: string; entries: string[]; index: number }[];
  active: string;
}

export interface TabsStorage {
  load(): SavedTabs | undefined;
  save(s: SavedTabs): void;
}

const MAX_ENTRIES = 50;
const TABS_KEY = "based.tabs";

/**
 * Tabs im Browser: sessionStorage gehört zu genau diesem Browser-Tab (überlebt Neuladen, mehrere Browser-Tabs kommen
 * sich nicht in die Quere); localStorage hält den letzten Stand für ein neues Fenster.
 */
export function browserTabsStorage(): TabsStorage {
  const get = (s: () => Storage | undefined) => {
    try {
      const raw = s()?.getItem(TABS_KEY);
      return raw ? (JSON.parse(raw) as SavedTabs) : undefined;
    } catch {
      return undefined;
    }
  };
  const put = (s: () => Storage | undefined, v: SavedTabs) => {
    try {
      s()?.setItem(TABS_KEY, JSON.stringify(v));
    } catch {
      // nur für diese Sitzung
    }
  };
  const session = () => globalThis.sessionStorage;
  const local = () => globalThis.localStorage;
  return {
    load: () => get(session) ?? get(local),
    save(v) {
      put(session, v);
      put(local, v);
    },
  };
}

const newTabID = () => Math.random().toString(36).slice(2, 10);

function validSaved(s: SavedTabs | undefined): s is SavedTabs {
  return !!s && s.v === 1 && Array.isArray(s.tabs) && s.tabs.length > 0 && s.tabs.every((t) => typeof t?.id === "string" && Array.isArray(t.entries) && t.entries.length > 0);
}

/**
 * Tabs mit je eigenem Verlauf (wie Notion/Browser). `route`, `navigate`, `back`, `forward` betreffen den aktiven Tab.
 *
 * Browser-Verlauf: Jede Navigation legt einen Eintrag an (`history.state.b` = Position), damit Zurück/Vor des
 * Browsers funktionieren – sie gehen im aktiven Tab zurück bzw. vor. Die Knöpfe der Shell ändern nur den Tab-Verlauf
 * und ersetzen den aktuellen Browser-Eintrag (der Browser-Verlauf ist über mehrere Tabs hinweg ohnehin nur ein Faden).
 * Die Adresse zeigt immer die Route des aktiven Tabs.
 */
export class History {
  private list: TabState[];
  private activeIndex = 0;
  private pos = 0;
  private listeners = new Set<() => void>();
  private snapshot: readonly TabInfo[] = [];

  constructor(
    private readonly win: Pick<Window, "location" | "history" | "addEventListener"> = window,
    private readonly storage: TabsStorage | undefined = browserTabsStorage(),
    /** Startseite für neue Tabs und nach dem Schließen des letzten Tabs (Einstellung „Start page“). */
    private readonly home: () => Route = () => ({ name: "home" }),
  ) {
    const fromHash = routeFromHash(win.location.hash);
    const saved = storage?.load();
    if (validSaved(saved)) {
      this.list = saved.tabs.map((t) => ({ id: t.id, entries: t.entries.map((h) => routeFromHash("#" + h)), index: Math.min(Math.max(0, t.index | 0), t.entries.length - 1) }));
      this.activeIndex = Math.max(0, this.list.findIndex((t) => t.id === saved.active));
    } else {
      this.list = [{ id: newTabID(), entries: [win.location.hash.replace(/^#\/?/, "") ? fromHash : this.home()], index: 0 }];
    }
    const st = win.history.state as { b?: number } | null;
    if (typeof st?.b === "number") this.pos = st.b;
    // Ausdrücklicher Hash (Link, Lesezeichen), der nicht zum gespeicherten Tab passt: dort hin
    if (win.location.hash.replace(/^#\/?/, "") && !sameRoute(fromHash, this.route)) this.push(this.active, fromHash);
    this.syncURL();
    this.refresh();
    win.addEventListener("popstate", () => {
      const s = win.history.state as { b?: number } | null;
      const tab = this.active;
      if (typeof s?.b !== "number") {
        // Hash von Hand geändert: der Browser hat einen neuen Eintrag angelegt
        this.pos += 1;
        this.push(tab, routeFromHash(win.location.hash));
      } else {
        if (s.b < this.pos && tab.index > 0) tab.index -= 1;
        else if (s.b > this.pos && tab.index < tab.entries.length - 1) tab.index += 1;
        this.pos = s.b;
      }
      this.syncURL();
      this.changed();
    });
  }

  // MARK: aktiver Tab

  private get active(): TabState {
    return this.list[this.activeIndex]!;
  }

  get route(): Route {
    const t = this.active;
    return t.entries[t.index]!;
  }

  get canBack() {
    return this.active.index > 0;
  }
  get canForward() {
    const t = this.active;
    return t.index < t.entries.length - 1;
  }

  navigate(r: Route, opts: { replace?: boolean } = {}) {
    if (sameRoute(r, this.route) && !opts.replace) return;
    const tab = this.active;
    if (opts.replace) {
      tab.entries[tab.index] = r;
      this.syncURL();
    } else {
      this.push(tab, r);
      this.pos += 1;
      this.win.history.pushState({ b: this.pos }, "", "#" + routeToHash(r));
    }
    this.changed();
  }

  back() {
    if (!this.canBack) return;
    this.active.index -= 1;
    this.syncURL();
    this.changed();
  }
  forward() {
    if (!this.canForward) return;
    this.active.index += 1;
    this.syncURL();
    this.changed();
  }

  // MARK: Tabs

  /** Alle Tabs (neues Array bei jeder Änderung, für useSyncExternalStore). */
  get tabs(): readonly TabInfo[] {
    return this.snapshot;
  }

  get activeID(): string {
    return this.active.id;
  }

  /** Neuer Tab rechts vom aktiven; `background`: der aktive bleibt (⌘-Klick). */
  openTab(r: Route = this.home(), opts: { background?: boolean } = {}): string {
    const tab: TabState = { id: newTabID(), entries: [r], index: 0 };
    this.list.splice(this.activeIndex + 1, 0, tab);
    if (!opts.background) {
      this.activeIndex += 1;
      this.syncURL();
    }
    this.changed();
    return tab.id;
  }

  activate(id: string) {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0 || i === this.activeIndex) return;
    this.activeIndex = i;
    this.syncURL();
    this.changed();
  }

  /** Tab schließen; nach dem letzten öffnet ein neuer Tab mit der Startseite – die App bleibt offen. */
  close(id: string = this.activeID) {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const wasActive = i === this.activeIndex;
    this.list.splice(i, 1);
    if (this.list.length === 0) this.list.push({ id: newTabID(), entries: [this.home()], index: 0 });
    if (i < this.activeIndex || (wasActive && this.activeIndex >= this.list.length)) this.activeIndex -= 1;
    this.activeIndex = Math.max(0, Math.min(this.activeIndex, this.list.length - 1));
    this.syncURL();
    this.changed();
  }

  /** Tab an Position `to` verschieben (Ziehen). */
  move(id: string, to: number) {
    const from = this.list.findIndex((t) => t.id === id);
    if (from < 0) return;
    const target = Math.max(0, Math.min(to, this.list.length - 1));
    if (target === from) return;
    const activeID = this.activeID;
    const [tab] = this.list.splice(from, 1);
    this.list.splice(target, 0, tab!);
    this.activeIndex = this.list.findIndex((t) => t.id === activeID);
    this.changed();
  }

  /** Nächster/vorheriger Tab (ringsum). */
  cycle(delta: number) {
    const n = this.list.length;
    if (n < 2) return;
    this.activate(this.list[(((this.activeIndex + delta) % n) + n) % n]!.id);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  // MARK: intern

  private push(tab: TabState, r: Route) {
    tab.entries.splice(tab.index + 1);
    tab.entries.push(r);
    tab.index = tab.entries.length - 1;
    if (tab.entries.length > MAX_ENTRIES) {
      tab.entries.shift();
      tab.index -= 1;
    }
  }

  private syncURL() {
    this.win.history.replaceState({ b: this.pos }, "", "#" + routeToHash(this.route));
  }

  private refresh() {
    this.snapshot = this.list.map((t) => ({ id: t.id, route: t.entries[t.index]!, canBack: t.index > 0, canForward: t.index < t.entries.length - 1 }));
  }

  private changed() {
    this.refresh();
    this.storage?.save({ v: 1, tabs: this.list.map((t) => ({ id: t.id, entries: t.entries.map(routeToHash), index: t.index })), active: this.activeID });
    for (const fn of this.listeners) fn();
  }
}
