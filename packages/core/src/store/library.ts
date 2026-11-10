// Library: Übersicht über alles im Workspace (Seiten, Datenbanken, Zeilen) mit Suche, Filtern und Sortierung.
// Port von Swift Store/LibraryOps.swift (`libraryItems`, `filterLibrary`) – reine Funktionen, damit die Liste im
// Worker gebaut und im Hauptthread gefiltert werden kann. Memories/Skills/Dateien der Swift-Fassung fehlen hier
// (kein Agent Brain, Dateien haben in der Web-Shell keine eigene Zeile).
import { titleOf } from "../query/engine.js";
import type { Block } from "../model/records.js";
import { PRIVATE_SECTION } from "./outline.js";
import type { WorkspaceStore } from "./store.js";

export type LibraryKind = "page" | "database" | "row";
export const LIBRARY_KINDS: readonly LibraryKind[] = ["page", "database", "row"];

export interface LibraryItem {
  id: string;
  title: string;
  kind: LibraryKind;
  /** „Private“, Name des Teamspaces oder Titel der Elternseite/-datenbank. */
  location: string;
  /** Seite oder Datenbank, in der der Eintrag liegt; fehlt auf oberster Ebene. */
  parentID?: string;
  /** Abschnitt der obersten Seite darüber: `private` oder Teamspace-ID. */
  section: string;
  /** Swift-Daten (Sekunden seit 2001). */
  created: number;
  edited: number;
  favorite: boolean;
  /** Emoji der Seite, falls gesetzt. */
  icon?: string;
}

export type LibrarySort = "title" | "edited" | "created" | "kind" | "location";

export interface LibraryQuery {
  text?: string;
  /** Leer oder nicht gesetzt: alle Arten. */
  kinds?: readonly LibraryKind[];
  /** `private` oder Teamspace-ID. */
  section?: string;
  favoritesOnly?: boolean;
  /** Nur Einträge, deren Titel (ohne Groß/klein, ohne Rand-Leerzeichen) mehrfach vorkommt. */
  onlyDuplicateTitles?: boolean;
  sort?: LibrarySort;
  ascending?: boolean;
}

export const titleKey = (t: string) => t.trim().toLowerCase();

/** Jeder Eintrag außerhalb des Papierkorbs, unsortiert. Ein Durchlauf, Vorfahren-Infos gemerkt. */
export function libraryItems(store: WorkspaceStore): LibraryItem[] {
  const favorites = new Set(store.workspace.favorites);
  const teamspaces = new Map((store.workspace.teamspaces ?? []).map((t) => [t.id, t.name]));
  // Je Block: im Papierkorb? Abschnitt? (über die Elternkette, gemerkt)
  const info = new Map<string, { trashed: boolean; section: string }>();
  const resolve = (b: Block): { trashed: boolean; section: string } => {
    const chain: Block[] = [];
    let cur: Block | undefined = b;
    let base: { trashed: boolean; section: string } | undefined;
    for (let n = 0; cur && n < 10_000; n++) {
      const known = info.get(cur.id);
      if (known) { base = known; break; }
      chain.push(cur);
      const p: string = cur.parent;
      if (p === "w") {
        const t = cur.props?.teamspace;
        base = { trashed: false, section: t && teamspaces.has(t) ? t : PRIVATE_SECTION };
        break;
      }
      const up: string | undefined = p.startsWith("b:") ? p.slice(2) : store.databases.get(p.slice(2))?.blockID;
      cur = up ? store.blocks.get(up) : undefined;
      // Elternteil fehlt: wie im Papierkorb (nicht erreichbar)
      if (!cur) base = { trashed: true, section: PRIVATE_SECTION };
    }
    let state = base ?? { trashed: true, section: PRIVATE_SECTION };
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i]!;
      state = { trashed: state.trashed || c.trashedAt !== undefined, section: state.section };
      info.set(c.id, state);
    }
    return info.get(b.id) ?? state;
  };
  const container = (b: Block): string | undefined => {
    let p = b.parent;
    for (let n = 0; n < 10_000; n++) {
      if (p === "w") return undefined;
      const id: string | undefined = p.startsWith("b:") ? p.slice(2) : store.databases.get(p.slice(2))?.blockID;
      const pb = id ? store.blocks.get(id) : undefined;
      if (!pb) return undefined;
      if (pb.type === "page" || pb.type === "databasePage" || (pb.type === "databaseInline" && ownsDatabase(store, pb))) return pb.id;
      p = pb.parent;
    }
    return undefined;
  };

  const out: LibraryItem[] = [];
  for (const b of store.blocks.values()) {
    let kind: LibraryKind;
    if (b.type === "databasePage") kind = "database";
    else if (b.type === "databaseInline") {
      if (!ownsDatabase(store, b)) continue;
      kind = "database";
    } else if (b.type === "page") kind = b.parent.startsWith("d:") ? "row" : "page";
    else continue;
    const st = resolve(b);
    if (st.trashed) continue;
    const parentID = b.parent === "w" ? undefined : container(b);
    const location = b.parent === "w" ? (st.section === PRIVATE_SECTION ? "Private" : (teamspaces.get(st.section) ?? "Private")) : parentID ? titleOf(store, parentID) : "—";
    const item: LibraryItem = { id: b.id, title: titleOf(store, b.id), kind, location, section: st.section, created: b.createdAt, edited: b.updatedAt, favorite: favorites.has(b.id) };
    if (parentID) item.parentID = parentID;
    const icon = b.props?.icon;
    const emoji = typeof icon === "string" ? icon : icon?.emoji;
    if (emoji) item.icon = emoji;
    out.push(item);
  }
  return out;
}

const ownsDatabase = (store: WorkspaceStore, b: Block) => b.props?.databaseID !== undefined && store.databases.get(b.props.databaseID)?.blockID === b.id;

/** Titel, die mehr als einmal vorkommen (als `titleKey`). */
export function duplicateTitleKeys(items: readonly LibraryItem[]): Set<string> {
  const seen = new Map<string, number>();
  for (const i of items) {
    const k = titleKey(i.title);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [k, n] of seen) if (n > 1) out.add(k);
  return out;
}

const KIND_ORDER: Record<LibraryKind, number> = { page: 0, database: 1, row: 2 };

/** Filtert und sortiert (Swift `filterLibrary`). Standard: zuletzt bearbeitet zuerst. `locale` nur für Tests. */
export function filterLibrary(items: readonly LibraryItem[], q: LibraryQuery = {}, locale?: string): LibraryItem[] {
  const text = (q.text ?? "").trim().toLowerCase();
  const kinds = q.kinds && q.kinds.length > 0 ? new Set(q.kinds) : undefined;
  const dup = q.onlyDuplicateTitles ? duplicateTitleKeys(items) : undefined;
  const list = items.filter((i) => {
    if (kinds && !kinds.has(i.kind)) return false;
    if (q.section !== undefined && i.section !== q.section) return false;
    if (q.favoritesOnly && !i.favorite) return false;
    if (text && !i.title.toLowerCase().includes(text) && !i.location.toLowerCase().includes(text)) return false;
    if (dup && !dup.has(titleKey(i.title))) return false;
    return true;
  });
  const sort = q.sort ?? "edited";
  const asc = q.ascending ?? (sort === "title" || sort === "kind" || sort === "location");
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const byTitle = (a: LibraryItem, b: LibraryItem) => collator.compare(a.title, b.title);
  const cmp = (a: LibraryItem, b: LibraryItem): number => {
    switch (sort) {
      case "title": return byTitle(a, b);
      case "kind": return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byTitle(a, b);
      case "location": return collator.compare(a.location, b.location) || byTitle(a, b);
      case "edited": return a.edited - b.edited;
      case "created": return a.created - b.created;
    }
  };
  const tie = (a: LibraryItem, b: LibraryItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  list.sort((a, b) => {
    const r = cmp(a, b);
    return r === 0 ? tie(a, b) : asc ? r : -r;
  });
  if (dup && sort !== "title") {
    // Gruppen gleicher Titel bleiben zusammen (stabile Sortierung behält die gewählte Ordnung in der Gruppe).
    list.sort((a, b) => collator.compare(titleKey(a.title), titleKey(b.title)));
  }
  return list;
}
