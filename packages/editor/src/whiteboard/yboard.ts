// BSD-263 (Whiteboard 1): Yjs-Schema eines Boards. Y.Map „objects“: id → Y.Map mit den flachen Feldern des Objekts
// (wbFields). Jedes Feld ist ein eigener Eintrag, damit zwei Geräte, die verschiedene Felder desselben Objekts ändern
// (eins verschiebt, eins färbt), beide Änderungen behalten. Tinte liegt als Uint8Array (encodeInk) im Feld „ink“.
// Y.Map „meta“: Schema-Version (für spätere Migrationen).
import * as Y from "yjs";
import { danglingConnectors, frontZ, parseWBObject, sortByZ, wbFields, type WBObject } from "@based/core";

export const BOARD_OBJECTS = "objects";
export const BOARD_META = "meta";
export const BOARD_VERSION = 1;

const objects = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>(BOARD_OBJECTS);

function ensureVersion(doc: Y.Doc) {
  const meta = doc.getMap<unknown>(BOARD_META);
  if (meta.get("version") === undefined) meta.set("version", BOARD_VERSION);
}

/** Alle gültigen Objekte, von hinten nach vorn. Unbrauchbare Einträge werden übergangen (nicht gelöscht). */
export function readBoard(doc: Y.Doc): WBObject[] {
  const out: WBObject[] = [];
  for (const m of objects(doc).values()) {
    if (!(m instanceof Y.Map)) continue;
    const o = parseWBObject(m.toJSON());
    if (!o) continue;
    const ink = m.get("ink");
    if (o.kind !== "connector" && ink instanceof Uint8Array) o.ink = ink;
    out.push(o);
  }
  return sortByZ(out);
}

function setFields(m: Y.Map<unknown>, fields: Record<string, unknown>) {
  for (const [k, v] of Object.entries(fields)) {
    if (k === "id") continue;
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
}

export function addObject(doc: Y.Doc, obj: WBObject) {
  doc.transact(() => {
    ensureVersion(doc);
    const m = new Y.Map<unknown>();
    m.set("id", obj.id);
    setFields(m, wbFields(obj));
    objects(doc).set(obj.id, m);
  });
}

/** Einzelne Felder ändern (nur die übergebenen; `undefined` entfernt ein Feld). */
export function updateObject(doc: Y.Doc, id: string, patch: Record<string, unknown>): boolean {
  const m = objects(doc).get(id);
  if (!(m instanceof Y.Map)) return false;
  doc.transact(() => setFields(m, patch));
  return true;
}

/** Ganz nach vorn holen (neues z hinter dem bisher vordersten). */
export function bringToFront(doc: Y.Doc, id: string): boolean {
  const others = readBoard(doc).filter((o) => o.id !== id);
  return updateObject(doc, id, { z: frontZ(others) });
}

/** Objekte löschen, Verbindungen, die danach ins Leere zeigen, gleich mit. Gibt alle gelöschten IDs zurück. */
export function removeObjects(doc: Y.Doc, ids: readonly string[]): string[] {
  const set = new Set(ids);
  for (const c of danglingConnectors(readBoard(doc), set)) set.add(c);
  const map = objects(doc);
  const removed = [...set].filter((id) => map.has(id));
  doc.transact(() => { for (const id of removed) map.delete(id); });
  return removed;
}
