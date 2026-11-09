// BSD-154: BlockNote-Dokument → Änderungen an den Records (richText als materialisierte Ansicht).
// Regeln:
//  - Felder, die der Editor nicht besitzt, bleiben wie im Record (auch unbekannte Felder, ADR 0002).
//  - Ein eigenes Feld, dessen Editor-Darstellung sich nicht geändert hat, bleibt byte-gleich (z. B. Läufe mit
//    unbekannten Feldern, `toggleable: false`, Bild-Assets mit Größe und MIME-Typ).
//  - Entfernte Seiten/eigene Datenbanken kommen in den Papierkorb, andere Blöcke werden gelöscht; darin
//    liegende Seiten werden gerettet (wie `WorkspaceStore.deleteBlocks`).
//  - Sortierschlüssel bleiben, wo die Reihenfolge stimmt.
import { canonicalStringify, keyOf, type Block, type Database, type DatabaseView, type WorkspaceStore } from "@based/core";
import type { BNBlock } from "./bn.js";
import { BOUNDARY_TYPES, docBlockIDs, extractOwned, OWNED_PROPS, OWNS_TEXT, ownedRow, projectBlock, tableRows, type BlockSource, type Owned } from "./blocks.js";
import { assignSortKeys } from "./sortkeys.js";

export interface RecordSource extends BlockSource {
  readonly views?: ReadonlyMap<string, DatabaseView>;
  readonly databases?: ReadonlyMap<string, Database>;
}

export interface MaterializeOptions {
  /** Swift-Datum (Sekunden seit 2001). */
  now: number;
  userID?: string | null;
  /** Neue IDs (Tabellenzeilen). */
  newID?: () => string;
}

export interface DocChanges {
  /** Neue oder geänderte Block-Records (vollständig). */
  puts: Block[];
  /** Zu löschende Block-IDs. */
  removeBlocks: string[];
  removeViews: string[];
  removeDatabases: string[];
}

const same = (a: unknown, b: unknown) => canonicalStringify(a ?? null) === canonicalStringify(b ?? null);
const randomID = () => globalThis.crypto.randomUUID();

/** Ist das Ergebnis leer (nichts zu schreiben)? */
export function isEmptyChange(c: DocChanges): boolean {
  return c.puts.length === 0 && c.removeBlocks.length === 0 && c.removeViews.length === 0 && c.removeDatabases.length === 0;
}

export function materializeDoc(src: RecordSource, rootID: string, blocks: readonly BNBlock[], opts: MaterializeOptions): DocChanges {
  const newID = opts.newID ?? randomID;
  const oldIDs = docBlockIDs(src, rootID);
  const seen = new Set<string>([rootID]);
  const puts = new Map<string, Block>();
  const put = (b: Block) => {
    const prev = src.blocks.get(b.id);
    if (!prev || !same(prev, b)) puts.set(b.id, b);
  };
  const fresh = (id: string, type: string, parent: string, sk: string): Block => {
    const b: Block = { id, type, parent, sk, createdAt: opts.now, updatedAt: opts.now };
    if (opts.userID) b.createdBy = opts.userID;
    return b;
  };

  const walk = (list: readonly BNBlock[], parent: string) => {
    const usable = list.filter((bn) => {
      if (seen.has(bn.id)) return false; // doppelte ID (sollte BlockNote nie liefern)
      seen.add(bn.id);
      return true;
    });
    const sks = assignSortKeys(usable.map((b) => b.id), usable.map((b) => {
      const prev = src.blocks.get(b.id);
      return prev && prev.parent === parent ? prev.sk : undefined;
    }));
    usable.forEach((bn, i) => {
      const prev = src.blocks.get(bn.id);
      const own = extractOwned(bn);
      const rec = buildRecord(bn.id, own, prev, parent, sks[i]!, fresh);
      put(rec);
      if (own.type === "table" && own.rows) materializeRows(rec.id, own, prev, src, seen, put, fresh, newID);
      if (bn.children.length > 0 || !BOUNDARY_TYPES.has(rec.type)) walk(bn.children, "b:" + bn.id);
    });
  };
  walk(blocks, "b:" + rootID);

  // Entfernt: was das Dokument vorher zeigte und jetzt nicht mehr.
  const removeBlocks: string[] = [];
  const removeViews: string[] = [];
  const removeDatabases: string[] = [];
  const removed = [...oldIDs].filter((id) => !seen.has(id));
  const removedSet = new Set(removed);
  const gone = new Set<string>();
  const rescueParent = "b:" + rootID;
  const removeSubtree = (id: string) => {
    if (gone.has(id)) return;
    const b = src.blocks.get(id);
    if (!b) return;
    if (isTrashable(src, b)) {
      // Gerettet: bleibt, kommt aber in den Papierkorb (unter der Wurzel, falls sein Elternteil verschwindet).
      const parentGone = b.parent.startsWith("b:") && (gone.has(b.parent.slice(2)) || removedSet.has(b.parent.slice(2)));
      const keep = structuredClone(b);
      if (keep.trashedAt === undefined) keep.trashedAt = opts.now;
      if (parentGone) keep.parent = rescueParent;
      put(keep);
      return;
    }
    gone.add(id);
    removeBlocks.push(id);
    for (const v of src.views?.values() ?? []) if (v.blockID === id) removeViews.push(v.id);
    const db = b.props?.databaseID;
    if (db && src.databases?.get(db)?.blockID === id) removeDatabases.push(db);
    for (const c of src.children("b:" + id)) if (!seen.has(c)) removeSubtree(c);
  };
  for (const id of removed) removeSubtree(id);
  return { puts: [...puts.values()], removeBlocks, removeViews, removeDatabases };
}

/** Seite oder eigene Datenbank: Papierkorb statt Löschen (wie `WorkspaceStore.isTrashable`). */
export function isTrashable(src: RecordSource, b: Block): boolean {
  if (b.type === "page" || b.type === "databasePage") return true;
  if (b.type === "databaseInline") {
    const db = b.props?.databaseID;
    return db !== undefined && src.databases?.get(db)?.blockID === b.id;
  }
  return false;
}

function buildRecord(id: string, own: Owned, prev: Block | undefined, parent: string, sk: string,
  fresh: (id: string, type: string, parent: string, sk: string) => Block): Block {
  if (own.raw) {
    // Opaque: der Editor trägt den ganzen Record.
    const base = prev ? structuredClone(prev) : fresh(id, own.type, parent, sk);
    const meta: Record<string, unknown> = {};
    for (const k of ["createdAt", "updatedAt", "createdBy", "updatedBy", "stamp"] as const) if (base[k] !== undefined) meta[k] = base[k];
    return { ...(own.raw as object), ...meta, id, parent, sk } as Block;
  }
  const rec: Block = prev ? structuredClone(prev) : fresh(id, own.type, parent, sk);
  const ref: Owned | undefined = prev ? extractOwned(projectBlock(prev)) : undefined;
  rec.type = own.type;
  rec.parent = parent;
  rec.sk = sk;
  delete rec.trashedAt;
  // Text
  if (OWNS_TEXT.has(own.type)) {
    const keep = prev && ref && OWNS_TEXT.has(ref.type) && same(ref.text, own.text);
    if (!keep) {
      if (own.text === undefined) delete rec.text;
      else rec.text = own.text;
    }
  } else if (ref && OWNS_TEXT.has(ref.type)) delete rec.text;
  // Props
  const props: Record<string, unknown> = { ...(rec.props ?? {}) };
  const keys = new Set([...(OWNED_PROPS[own.type] ?? []), ...(ref ? OWNED_PROPS[ref.type] ?? [] : [])]);
  for (const k of keys) {
    const now = own.props[k];
    if (ref && same(now, ref.props[k])) continue; // Darstellung unverändert: Record-Wert behalten
    if (now === undefined) delete props[k];
    else props[k] = now;
  }
  if (Object.keys(props).length === 0) delete rec.props;
  else rec.props = props as Block["props"];
  return rec;
}

function materializeRows(tableID: string, own: Owned, prevTable: Block | undefined, src: RecordSource, seen: Set<string>,
  put: (b: Block) => void, fresh: (id: string, type: string, parent: string, sk: string) => Block, newID: () => string) {
  const parent = "b:" + tableID;
  const existing = prevTable ? tableRows(src, tableID) : [];
  let rows = own.rows ?? [];
  // Die leere Platzhalterzeile einer Tabelle ohne Zeilen bleibt ohne Record.
  if (existing.length === 0 && rows.length === 1 && rows[0]!.cells.every((c) => c === undefined) && !rows[0]!.cellColors) rows = [];
  const ids = rows.map((_, i) => existing[i]?.id ?? newID());
  const sks = assignSortKeys(ids, ids.map((id) => {
    const r = src.blocks.get(id);
    return r && r.parent === parent ? r.sk : undefined;
  }));
  const cols = Math.max(Number(own.props.tableColumns ?? 0), ...rows.map((r) => r.cells.length));
  rows.forEach((row, i) => {
    const id = ids[i]!;
    seen.add(id);
    const prev = src.blocks.get(id);
    const rec: Block = prev ? structuredClone(prev) : fresh(id, "tableRow", parent, sks[i]!);
    rec.type = "tableRow";
    rec.parent = parent;
    rec.sk = sks[i]!;
    delete rec.trashedAt;
    const ref = prev ? ownedRow(prev, cols) : undefined;
    const props: Record<string, unknown> = { ...(rec.props ?? {}) };
    if (!ref || !same(ref.cells, row.cells)) props.cells = row.cells.map((c) => c ?? "");
    if (!ref || !same(ref.cellColors, row.cellColors)) {
      if (row.cellColors) props.cellColors = row.cellColors;
      else delete props.cellColors;
    }
    rec.props = props as Block["props"];
    put(rec);
  });
}

/** Änderungen in einer Store-Transaktion schreiben (ein Schritt, nicht im Store-Undo: Undo macht Yjs). */
export function applyDocChanges(store: WorkspaceStore, changes: DocChanges, name = "Edit"): void {
  if (isEmptyChange(changes)) return;
  store.transact(name, (tx) => {
    for (const b of changes.puts) tx.put({ kind: "block", data: b });
    for (const id of changes.removeViews) tx.remove(keyOf("view", id));
    for (const id of changes.removeDatabases) tx.remove(keyOf("database", id));
    for (const id of changes.removeBlocks) tx.remove(keyOf("block", id));
  }, { undoable: false });
}
