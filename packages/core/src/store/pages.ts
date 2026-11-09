// BSD-153: Seiten verwalten (Seitenleiste, Papierkorb, Favoriten), portiert aus BasedCore
// Store/PageManagement.swift und Store/PageOps.swift. Reine Funktionen über dem WorkspaceStore, je eine
// Transaktion (ein Undo-Schritt). Neu in TS, damit Web-Shell und spätere Clients dieselben Regeln haben.
import { keyBetween, keysBetween } from "../sortkeys.js";
import { isTrashed } from "../query/engine.js";
import type { Block, Workspace } from "../model/records.js";
import { keyOf, type Tx, type WorkspaceStore } from "./store.js";

/** Seitenleisten-Abschnitt einer Seite oben: ein Teamspace oder „Private“. */
export type SectionID = { kind: "private" } | { kind: "teamspace"; id: string };
export const PRIVATE: SectionID = { kind: "private" };

export type PageDestination = { kind: "top"; section: SectionID } | { kind: "page"; id: string };
export type InsertPosition = { kind: "end" } | { kind: "before"; id: string } | { kind: "after"; id: string };
export type DropZone = "before" | "inside" | "after";

export const isPageLike = (b: Block | undefined): boolean => b?.type === "page" || b?.type === "databasePage";

const newID = () => crypto.randomUUID().toUpperCase();

/** Abschnitt einer Seite oben; ein gelöschter Teamspace fällt auf Private zurück. */
export function sectionOf(store: WorkspaceStore, b: Block): SectionID {
  const t = b.props?.teamspace;
  if (t && (store.workspace.teamspaces ?? []).some((x) => x.id === t)) return { kind: "teamspace", id: t };
  return PRIVATE;
}

export const sameSection = (a: SectionID, b: SectionID) => a.kind === b.kind && (a.kind === "private" || a.id === (b as { id: string }).id);

/** `id` liegt (über Blöcke und Datenbanken) in `ancestor`. */
export function isDescendant(store: WorkspaceStore, id: string, ancestor: string): boolean {
  let p = store.blocks.get(id)?.parent;
  for (let n = 0; p && n < 10_000; n++) {
    if (p === "w") return false;
    let next: string | undefined;
    if (p.startsWith("b:")) next = p.slice(2);
    else next = store.databases.get(p.slice(2))?.blockID;
    if (!next) return false;
    if (next === ancestor) return true;
    p = store.blocks.get(next)?.parent;
  }
  return false;
}

/** Alles in einem Block, Datenbankzeilen eingeschlossen (Swift `descendants(of:includeRows:)`). */
export function subtree(store: WorkspaceStore, id: string, includeRows = true): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    let kids = [...store.children("b:" + cur)];
    const db = store.blocks.get(cur)?.props?.databaseID;
    if (includeRows && db && store.databases.get(db)?.blockID === cur) kids = kids.concat(store.children("d:" + db));
    out.push(...kids);
    stack.push(...kids.reverse());
  }
  return out;
}

/** Sortierschlüssel für `count` neue Kinder von `parent` an `position`; `excluding` (die bewegten) zählen nicht als Nachbarn. */
export function sortKeys(store: WorkspaceStore, parent: string, position: InsertPosition, count: number, excluding: ReadonlySet<string> = new Set()): string[] {
  const kids = store.children(parent).filter((k) => !excluding.has(k));
  const key = (id: string | undefined) => (id === undefined ? undefined : store.blocks.get(id)?.sk);
  let lo: string | undefined, hi: string | undefined;
  const at = position.kind === "end" ? -1 : kids.indexOf(position.id);
  if (position.kind === "end" || at < 0) lo = key(kids[kids.length - 1]);
  else if (position.kind === "before") {
    lo = key(kids[at - 1]);
    hi = key(kids[at]);
  } else {
    lo = key(kids[at]);
    hi = key(kids[at + 1]);
  }
  return count === 1 ? [keyBetween(lo, hi)] : keysBetween(count, lo, hi);
}

function updateWorkspace(store: WorkspaceStore, tx: Tx, f: (w: Workspace) => void) {
  const w = structuredClone(store.workspace);
  f(w);
  tx.put({ kind: "workspace", data: w });
}

export interface CreatePageOptions {
  /** Elternseite; ohne Angabe oben im Abschnitt `section`. */
  parent?: string;
  section?: SectionID;
  title?: string;
  position?: InsertPosition;
  id?: string;
}

/** Neue leere Seite (Swift `createTopLevelPage` / `createPage`). */
export function createPage(store: WorkspaceStore, opts: CreatePageOptions = {}): string {
  return store.transact("New page", (tx) => insertPage(store, tx, opts));
}

/** Wie `createPage`, aber in einer laufenden Transaktion. */
export function insertPage(store: WorkspaceStore, tx: Tx, opts: CreatePageOptions = {}): string {
  const parent = opts.parent ? "b:" + opts.parent : "w";
  const id = opts.id ?? newID();
  const now = store.now();
  const b: Block = { id, type: "page", parent, sk: sortKeys(store, parent, opts.position ?? { kind: "end" }, 1)[0]!, createdAt: now, updatedAt: now };
  if (opts.title) b.text = opts.title;
  if (store.userID != null) b.createdBy = store.userID;
  if (!opts.parent && opts.section?.kind === "teamspace") b.props = { teamspace: opts.section.id };
  tx.put({ kind: "block", data: b });
  return id;
}

/** Seite oder Datenbank umbenennen (der Titel einer Datenbank liegt auf dem Datenbank-Record). */
export function renamePage(store: WorkspaceStore, id: string, title: string) {
  const b = store.blocks.get(id);
  if (!b) return;
  const dbID = b.type === "databasePage" || b.type === "databaseInline" ? b.props?.databaseID : undefined;
  const db = dbID ? store.databases.get(dbID) : undefined;
  if (db) {
    if (db.title === title) return;
    store.transact("Rename", (tx) => tx.put({ kind: "database", data: { ...structuredClone(db), title } }), { coalesce: "rename:" + id });
    return;
  }
  if ((typeof b.text === "string" ? b.text : undefined) === title || (title === "" && b.text === undefined)) return;
  store.transact("Rename", (tx) => tx.update(id, (x) => {
    if (title === "") delete x.text;
    else x.text = title;
  }), { coalesce: "rename:" + id });
}

/** Seiten in den Papierkorb (darin liegende verschwinden mit). Gibt die verschobenen Wurzeln zurück. */
export function trashPages(store: WorkspaceStore, ids: string[]): string[] {
  const unique = [...new Set(ids)].filter((id) => store.blocks.has(id) && !isTrashed(store, id));
  const roots = unique.filter((id) => !unique.some((o) => o !== id && isDescendant(store, id, o)));
  if (roots.length === 0) return [];
  store.transact(roots.length === 1 ? "Move to Trash" : `Move ${roots.length} pages to Trash`, (tx) => {
    const now = store.now();
    for (const id of roots) tx.update(id, (b) => { b.trashedAt = now; });
  });
  return roots;
}

/** Alles im Papierkorb (Seiten, Datenbanken, Zeilen), zuletzt gelöschtes zuerst. */
export function trashedPages(store: WorkspaceStore): Block[] {
  const out: Block[] = [];
  for (const b of store.blocks.values()) if (b.trashedAt !== undefined) out.push(b);
  return out.sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0) || (a.id < b.id ? -1 : 1));
}

/** Stempelt alles in einer wiederhergestellten Seite neu, damit sie gegen ein älteres „Endgültig löschen“ gewinnt. */
function restampSubtree(store: WorkspaceStore, id: string, tx: Tx) {
  for (const d of [id, ...subtree(store, id)]) {
    if (d !== id) tx.restamp(keyOf("block", d));
    for (const v of store.views.values()) if (v.blockID === d) tx.restamp(keyOf("view", v.id));
    const db = store.blocks.get(d)?.props?.databaseID;
    if (db && store.databases.get(db)?.blockID === d) tx.restamp(keyOf("database", db));
  }
}

/** Aus dem Papierkorb holen. Ist die Elternseite weg oder selbst im Papierkorb, kommt die Seite nach oben (Private). */
export function restorePages(store: WorkspaceStore, ids: string[]) {
  const roots = ids.filter((id) => store.blocks.get(id)?.trashedAt !== undefined);
  if (roots.length === 0) return;
  store.transact(roots.length === 1 ? "Restore" : `Restore ${roots.length} pages`, (tx) => {
    for (const id of roots) {
      const b = tx.block(id);
      if (!b) continue;
      let orphaned = false;
      if (b.parent.startsWith("b:")) {
        const pid = b.parent.slice(2);
        orphaned = !store.blocks.has(pid) || isTrashed(store, pid);
      } else if (b.parent.startsWith("d:")) {
        const owner = store.databases.get(b.parent.slice(2))?.blockID;
        orphaned = !owner || !store.blocks.has(owner) || isTrashed(store, owner);
      }
      const key = orphaned ? sortKeys(store, "w", { kind: "end" }, 1)[0]! : b.sk;
      tx.update(id, (x) => {
        delete x.trashedAt;
        if (orphaned) {
          x.parent = "w";
          x.sk = key;
          if (x.props) {
            delete x.props.teamspace;
            if (Object.keys(x.props).length === 0) delete x.props;
          }
          if (x.type === "databaseInline") x.type = "databasePage";
        }
      });
      restampSubtree(store, id, tx);
    }
  });
}

/** Endgültig löschen: der Block mit allem darin (Zeilen, Datenbanken, Ansichten); raus aus den Favoriten. */
export function deleteForever(store: WorkspaceStore, ids: string[]) {
  const present = ids.filter((id) => store.blocks.has(id));
  if (present.length === 0) return;
  store.transact("Delete forever", (tx) => {
    for (const id of present) {
      if (!store.blocks.has(id)) continue; // schon mit einem anderen gelöscht
      for (const d of [id, ...subtree(store, id)]) {
        for (const v of [...store.views.values()]) if (v.blockID === d) tx.remove(keyOf("view", v.id));
        const db = store.blocks.get(d)?.props?.databaseID;
        if (db && store.databases.get(db)?.blockID === d) tx.remove(keyOf("database", db));
        tx.remove(keyOf("block", d));
      }
    }
    if (store.workspace.favorites.some((f) => !store.blocks.has(f))) {
      updateWorkspace(store, tx, (w) => { w.favorites = w.favorites.filter((f) => store.blocks.has(f)); });
    }
  });
}

export function emptyTrash(store: WorkspaceStore) {
  deleteForever(store, trashedPages(store).map((b) => b.id));
}

/** Seiten verschieben (ein Schritt). Was in sich selbst landen würde, bleibt; Mitgezogene werden übersprungen. */
export function movePages(store: WorkspaceStore, ids: string[], dest: PageDestination, position: InsertPosition = { kind: "end" }): boolean {
  const set = new Set(ids);
  let moving = ids.filter((id) => store.blocks.has(id) && !ids.some((o) => o !== id && set.has(o) && isDescendant(store, id, o)));
  if (dest.kind === "page") moving = moving.filter((id) => id !== dest.id && !isDescendant(store, dest.id, id));
  if (moving.length === 0) return false;
  if (position.kind !== "end" && set.has(position.id)) return false;
  const parent = dest.kind === "page" ? "b:" + dest.id : "w";
  const teamspace = dest.kind === "top" && dest.section.kind === "teamspace" ? dest.section.id : undefined;
  const keys = sortKeys(store, parent, position, moving.length, set);
  store.transact(moving.length === 1 ? "Move page" : `Move ${moving.length} pages`, (tx) => {
    moving.forEach((id, i) => tx.update(id, (b) => {
      b.parent = parent;
      b.sk = keys[i]!;
      const props = { ...(b.props ?? {}) };
      if (teamspace) props.teamspace = teamspace;
      else delete props.teamspace;
      if (Object.keys(props).length) b.props = props;
      else delete b.props;
      if (parent === "w" && b.type === "databaseInline") b.type = "databasePage";
    }));
  });
  return true;
}

/** Ziehen in der Seitenleiste: Mitte = hinein, Rand = davor/dahinter im Abschnitt des Ziels. */
export function dropPages(store: WorkspaceStore, ids: string[], target: string, zone: DropZone): boolean {
  const t = store.blocks.get(target);
  if (!t) return false;
  const valid = ids.filter((id) => id !== target && !isDescendant(store, target, id) && store.blocks.has(id));
  if (valid.length === 0) return false;
  if (zone === "inside") {
    if (t.type !== "page") return false;
    return movePages(store, valid, { kind: "page", id: target });
  }
  const pos: InsertPosition = { kind: zone, id: target };
  if (t.parent === "w") return movePages(store, valid, { kind: "top", section: sectionOf(store, t) }, pos);
  if (t.parent.startsWith("b:")) return movePages(store, valid, { kind: "page", id: t.parent.slice(2) }, pos);
  return false; // Datenbankzeilen werden in der Datenbank sortiert
}

/** Favoriten setzen oder entfernen (ein Schritt). */
export function setFavorite(store: WorkspaceStore, ids: string[], on: boolean) {
  const favs = store.workspace.favorites;
  const next = on ? [...favs, ...ids.filter((id, i) => !favs.includes(id) && ids.indexOf(id) === i)] : favs.filter((f) => !ids.includes(f));
  if (next.length === favs.length && next.every((f, i) => f === favs[i])) return;
  store.transact(on ? "Add to Favorites" : "Remove from Favorites", (tx) => updateWorkspace(store, tx, (w) => { w.favorites = next; }));
}

export function createTeamspace(store: WorkspaceStore, name: string): string {
  const id = newID();
  store.transact("New teamspace", (tx) => updateWorkspace(store, tx, (w) => {
    w.teamspaces = [...(w.teamspaces ?? []), { id, name: name || "New teamspace", createdAt: store.now() }];
  }));
  return id;
}
