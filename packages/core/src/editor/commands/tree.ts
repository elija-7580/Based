// BSD-382 (ADR 0016, E1): Lesen im Blockbaum für die Editor-Befehle – sichtbare Reihenfolge (zugeklappte Toggles
// verbergen ihre Kinder), Grenzen (Seite, Spalte), Typ-Gruppen. Nur lesend; die Befehle stehen in blocks.ts.
import type { Block } from "../../model/records.js";
import type { WorkspaceStore } from "../../store/store.js";

/** Typen mit eigenem Textfeld im neuen Editor. */
export const TEXT_TYPES: ReadonlySet<string> = new Set([
  "text", "heading1", "heading2", "heading3", "heading4", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "code",
]);
/** Diese Typen setzt Enter am Ende im neuen Block fort (Notion: Listen, To-dos, Toggles). */
export const CONTINUING_TYPES: ReadonlySet<string> = new Set(["bulletedList", "numberedList", "todo", "toggle"]);
/** Blöcke, unter die man mit Tab einrücken kann (Überschriften nur als Toggle-Überschrift). */
const NESTABLE_TYPES: ReadonlySet<string> = new Set(["text", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout"]);
/** Grenzen: über sie hinweg wird nicht zusammengeführt oder ausgerückt. */
const BOUNDARY_TYPES: ReadonlySet<string> = new Set(["page", "databasePage", "column", "columnList", "table", "meeting", "meetingSection", "syncedBlock"]);
/** Kinder dieser Blöcke sind keine Editor-Blöcke (Tabellenzeilen) oder liegen auf einer eigenen Seite. */
// BSD-407 Teil 5: Meeting – Notizen, Zusammenfassung und Transkript zeichnet der Meeting-Block selbst (Reiter), nicht der Seitenfluss.
const OPAQUE_TYPES: ReadonlySet<string> = new Set(["page", "databasePage", "databaseInline", "table", "linkToPage", "meeting"]);

export const isHeading = (type: string) => /^heading[1-4]$/.test(type);
export const isTextBlock = (b: Block | undefined): boolean => b !== undefined && TEXT_TYPES.has(b.type);

/** Toggle oder Toggle-Überschrift. */
export function isToggle(b: Block): boolean {
  return b.type === "toggle" || (isHeading(b.type) && b.props?.toggleable === true);
}
/** Zugeklappt: Kinder sind nicht sichtbar. */
export function isCollapsed(b: Block): boolean {
  return isToggle(b) && b.props?.isOpen !== true;
}

export function canNestUnder(b: Block | undefined): boolean {
  if (!b || b.trashedAt !== undefined) return false;
  return NESTABLE_TYPES.has(b.type) || (isHeading(b.type) && b.props?.toggleable === true);
}

export const isBoundary = (b: Block | undefined) => b === undefined || BOUNDARY_TYPES.has(b.type);

export function parentBlockID(b: Block): string | undefined {
  return b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
}

/** Kinder ohne Papierkorb. */
export function liveChildren(store: WorkspaceStore, id: string): string[] {
  return store.children("b:" + id).filter((c) => store.blocks.get(c)?.trashedAt === undefined);
}

export function siblings(store: WorkspaceStore, b: Block): string[] {
  return store.children(b.parent).filter((c) => store.blocks.get(c)?.trashedAt === undefined);
}

/** Sichtbare Kinder in der Seite: zugeklappte Toggles und eigene Seiten/Datenbanken/Tabellen zeigen keine. */
export function visibleChildren(store: WorkspaceStore, b: Block): string[] {
  if (OPAQUE_TYPES.has(b.type) || isCollapsed(b)) return [];
  return liveChildren(store, b.id);
}

function lastVisibleDescendant(store: WorkspaceStore, id: string): string {
  let cur = id;
  for (let n = 0; n < 100_000; n++) {
    const b = store.blocks.get(cur);
    const kids = b ? visibleChildren(store, b) : [];
    if (kids.length === 0) return cur;
    cur = kids[kids.length - 1]!;
  }
  return cur;
}

/** Der Block direkt über `id` in der Seite (Pfeil hoch, ⌫ am Anfang); `undefined` am Anfang der Seite oder Spalte. */
export function previousVisible(store: WorkspaceStore, id: string): string | undefined {
  const b = store.blocks.get(id);
  if (!b) return undefined;
  const sibs = siblings(store, b);
  const i = sibs.indexOf(id);
  if (i > 0) return lastVisibleDescendant(store, sibs[i - 1]!);
  const pid = parentBlockID(b);
  const parent = pid ? store.blocks.get(pid) : undefined;
  return parent && !isBoundary(parent) ? parent.id : undefined;
}

/** Der Block direkt unter `id` in der Seite (Pfeil runter, Entf am Ende); bleibt in seiner Spalte/Seite. */
export function nextVisible(store: WorkspaceStore, id: string): string | undefined {
  const b = store.blocks.get(id);
  if (!b) return undefined;
  const kids = visibleChildren(store, b);
  if (kids.length > 0) return kids[0];
  let cur: Block | undefined = b;
  for (let n = 0; cur && n < 100_000; n++) {
    const sibs = siblings(store, cur);
    const i = sibs.indexOf(cur.id);
    if (i >= 0 && i < sibs.length - 1) return sibs[i + 1];
    const pid = parentBlockID(cur);
    const parent = pid ? store.blocks.get(pid) : undefined;
    if (!parent || isBoundary(parent)) return undefined;
    cur = parent;
  }
  return undefined;
}

/** Alle sichtbaren Blöcke einer Seite in Lesereihenfolge (Spalten von links nach rechts). */
export function visibleOrder(store: WorkspaceStore, pageID: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const c of liveChildren(store, id)) {
      out.push(c);
      const b = store.blocks.get(c)!;
      if (visibleChildren(store, b).length > 0) walk(c);
    }
  };
  walk(pageID);
  return out;
}

/** Ist `id` gleich `ancestor` oder liegt darin? */
export function isInside(store: WorkspaceStore, id: string, ancestor: string): boolean {
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 100_000; n++) {
    if (cur.id === ancestor) return true;
    const p = parentBlockID(cur);
    cur = p ? store.blocks.get(p) : undefined;
  }
  return false;
}

/** Nur die obersten der Blöcke (Kinder ausgewählter Blöcke gehen ohnehin mit), in Dokumentreihenfolge. */
export function topLevel(store: WorkspaceStore, ids: readonly string[]): string[] {
  const set = new Set(ids.filter((id) => store.blocks.has(id)));
  const roots = [...set].filter((id) => {
    let cur = store.blocks.get(id);
    for (let n = 0; cur && n < 100_000; n++) {
      const p = parentBlockID(cur);
      if (!p) return true;
      if (set.has(p)) return false;
      cur = store.blocks.get(p);
    }
    return true;
  });
  return sortByDocument(store, roots);
}

/** Pfad der Positionen von der Wurzel bis zum Block, zum Sortieren in Dokumentreihenfolge. */
function path(store: WorkspaceStore, id: string): number[] {
  const out: number[] = [];
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 100_000; n++) {
    out.unshift(store.children(cur.parent).indexOf(cur.id));
    const p = parentBlockID(cur);
    cur = p ? store.blocks.get(p) : undefined;
  }
  return out;
}

export function sortByDocument(store: WorkspaceStore, ids: readonly string[]): string[] {
  const paths = new Map(ids.map((id) => [id, path(store, id)]));
  return [...ids].sort((x, y) => {
    const a = paths.get(x)!, b = paths.get(y)!;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
}
