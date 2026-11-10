// Synced Blocks (BSD-41/120), portiert aus Swift Store/SyncedBlockOps.swift: Ein Original (`syncedBlock`) trägt den
// Inhalt als Kinder; eine Kopie ist ein `syncedBlock` mit `props.syncSource` = Original und ohne eigene Kinder.
import { keysBetween } from "../sortkeys.js";
import type { Block } from "../model/records.js";
import { isDescendant } from "./pages.js";
import type { Tx, WorkspaceStore } from "./store.js";

export type SyncedPasteProblem =
  /** Die Zwischenablage nennt keinen (mehr vorhandenen) Synced Block. */
  | "noSource"
  /** Derselbe Synced Block steht schon in diesem Dokument. */
  | "alreadyOnPage"
  /** Einfügen in den eigenen Inhalt: der Block enthielte sich selbst. */
  | "insideItself";

/** Das Original eines Synced Blocks (er selbst oder `syncSource`); `undefined` für andere Blöcke. */
export function syncedOriginal(store: WorkspaceStore, id: string): string | undefined {
  const b = store.blocks.get(id);
  if (!b || b.type !== "syncedBlock") return undefined;
  return b.props?.syncSource ?? b.id;
}

/** Kopien eines Originals. */
export function syncedCopies(store: WorkspaceStore, original: string): string[] {
  const out: string[] = [];
  for (const b of store.blocks.values()) if (b.type === "syncedBlock" && b.props?.syncSource === original) out.push(b.id);
  return out;
}

/** Der Block im Papierkorb, der `id` verdeckt (er selbst oder ein Vorfahr); `undefined`, wenn nichts im Papierkorb liegt. */
export function trashedRoot(store: WorkspaceStore, id: string): string | undefined {
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (cur.trashedAt !== undefined) return cur.id;
    const p = cur.parent;
    if (p.startsWith("b:")) cur = store.blocks.get(p.slice(2));
    else if (p.startsWith("d:")) {
      const owner = store.databases.get(p.slice(2))?.blockID;
      cur = owner ? store.blocks.get(owner) : undefined;
    } else return undefined;
  }
  return undefined;
}

/** Synced Blocks (Original oder Kopie von `original`), die unter `rootID` sichtbar stehen – ohne in Unterseiten zu schauen. */
export function syncedInstances(store: WorkspaceStore, rootID: string, original: string): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined) continue;
      if (b.type === "syncedBlock") {
        if ((b.props?.syncSource ?? b.id) === original) out.push(id);
        continue;
      }
      if (b.type === "page" || b.type === "databasePage" || b.type === "databaseInline") continue;
      walk("b:" + id);
    }
  };
  walk("b:" + rootID);
  return out;
}

/**
 * Darf eine Kopie von `source` in das Dokument `rootID` (Seite oder Synced-Original)? `ancestors`: Wurzeln der
 * umgebenden Editoren. Abgelehnt: unbekannte Quelle, in sich selbst, und ein zweites Mal im selben Dokument.
 */
export function syncedPasteProblem(store: WorkspaceStore, source: string, rootID: string, ancestors: readonly string[] = []): SyncedPasteProblem | undefined {
  const original = syncedOriginal(store, source);
  if (original === undefined || !store.blocks.has(original)) return "noSource";
  if (original === rootID || ancestors.includes(original) || isDescendant(store, rootID, original)) return "insideItself";
  if (syncedInstances(store, rootID, original).length > 0) return "alreadyOnPage";
  return undefined;
}

const newID = () => crypto.randomUUID().toUpperCase();

function copySubtree(store: WorkspaceStore, tx: Tx, src: Block, parent: string, sk: string): void {
  const copy = structuredClone(src);
  copy.id = newID();
  copy.parent = parent;
  copy.sk = sk;
  copy.createdAt = store.now();
  copy.updatedAt = copy.createdAt;
  if (store.userID != null) copy.createdBy = store.userID;
  else delete copy.createdBy;
  delete copy.trashedAt;
  delete copy.stamp;
  tx.put({ kind: "block", data: copy });
  for (const kid of store.children("b:" + src.id)) {
    const k = store.blocks.get(kid);
    if (k && k.trashedAt === undefined) copySubtree(store, tx, k, "b:" + copy.id, k.sk);
  }
}

/**
 * „Unsync“: Die Kopie bekommt ein eigenes Duplikat des Inhalts (neue IDs) und zeigt nicht mehr auf das Original.
 * Eine Transaktion. Ohne Wirkung für Originale und andere Blöcke. Gibt zurück, ob etwas geändert wurde.
 */
export function unsyncCopy(store: WorkspaceStore, id: string, opts: { undoable?: boolean } = {}): boolean {
  const b = store.blocks.get(id);
  const source = b?.type === "syncedBlock" ? b.props?.syncSource : undefined;
  if (!b || !source) return false;
  store.transact("Unsync", (tx) => {
    const kids = store.blocks.has(source)
      ? store.children("b:" + source).map((k) => store.blocks.get(k)).filter((k): k is Block => !!k && k.trashedAt === undefined)
      : [];
    const keys = keysBetween(kids.length, undefined, undefined);
    kids.forEach((k, i) => copySubtree(store, tx, k, "b:" + id, keys[i]!));
    tx.update(id, (x) => {
      if (!x.props) return;
      delete x.props.syncSource;
      if (Object.keys(x.props).length === 0) delete x.props;
    });
  }, { undoable: opts.undoable ?? true });
  return true;
}

/**
 * Was eine Seiten-Replik zusätzlich braucht, damit Synced-Kopien auf ihr funktionieren: die Originale samt Inhalt
 * (`roots`, auch verschachtelt) und deren Vorfahren bis zur Workspace-Wurzel (`ancestors`, nur die Records selbst –
 * für „liegt im Papierkorb“ und „Original auf Seite X“).
 */
export function syncedDependencies(store: WorkspaceStore, pageID: string, subtreeOf: (id: string) => string[]): { roots: Set<string>; ancestors: Set<string> } {
  const roots = new Set<string>();
  const ancestors = new Set<string>();
  const own = new Set<string>([pageID, ...subtreeOf(pageID)]);
  const queue: string[] = [...own];
  while (queue.length) {
    const b = store.blocks.get(queue.pop()!);
    const src = b?.type === "syncedBlock" ? b.props?.syncSource : undefined;
    if (!src || roots.has(src) || own.has(src) || !store.blocks.has(src)) continue;
    roots.add(src);
    for (const id of subtreeOf(src)) queue.push(id);
  }
  for (const r of roots) {
    let cur = store.blocks.get(r);
    for (let n = 0; cur && n < 1000; n++) {
      const p = cur.parent;
      let next: string | undefined;
      if (p.startsWith("b:")) next = p.slice(2);
      else if (p.startsWith("d:")) next = store.databases.get(p.slice(2))?.blockID;
      if (!next || own.has(next) || ancestors.has(next)) break;
      ancestors.add(next);
      cur = store.blocks.get(next);
    }
  }
  for (const r of roots) ancestors.delete(r);
  return { roots, ancestors };
}
