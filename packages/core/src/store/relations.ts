// Relationen schreiben (portiert aus BasedCore Store/DatabaseOps.swift `setRelation`) mit „Limit to 1 page“
// im Kern erzwungen (BSD-125): gilt damit für UI, Agenten, Import und MCP gleichermaßen.
import type { Block, PropertyValue } from "../model/records.js";
import { databaseOfRow, propertyById } from "../query/engine.js";
import type { Tx, WorkspaceStore } from "./store.js";

function relationIDs(v: PropertyValue | undefined): string[] {
  const inner = (v as { relation?: { _0?: unknown } } | undefined)?.relation?._0;
  return Array.isArray(inner) ? (inner as string[]) : [];
}
const relationValue = (ids: string[]): PropertyValue => ({ relation: { _0: ids } }) as PropertyValue;

function setIDs(tx: Tx, rowID: string, propertyID: string, ids: string[]) {
  tx.update(rowID, (b: Block) => {
    const values = { ...(b.values ?? {}) };
    if (ids.length === 0) delete values[propertyID];
    else values[propertyID] = relationValue(ids);
    if (Object.keys(values).length === 0) delete b.values;
    else b.values = values;
  });
}

/** Ziele einer Relation setzen; bei two-way wird die Gegenseite mitgeführt. Ein Undo-Schritt. */
export function setRelation(store: WorkspaceStore, rowID: string, propertyID: string, targets: string[]): void {
  const db = databaseOfRow(store, rowID);
  const p = db ? propertyById(db, propertyID) : undefined;
  const rel = p?.relation;
  if (!rel) return;
  let wanted = [...new Set(targets)];
  // Limit to 1 page: das zuletzt gewählte Ziel gewinnt.
  if (rel.limitOne && wanted.length > 1) wanted = [wanted[wanted.length - 1]!];
  const row = store.blocks.get(rowID);
  const old = relationIDs(row?.values?.[propertyID]);
  const added = wanted.filter((t) => !old.includes(t));
  const removed = old.filter((t) => !wanted.includes(t));
  const mirror = rel.syncedPropertyID;
  const targetDB = store.databases.get(rel.databaseID);
  const mirrorLimitOne = mirror && targetDB ? propertyById(targetDB, mirror)?.relation?.limitOne === true : false;

  store.transact("Edit relation", (tx) => {
    setIDs(tx, rowID, propertyID, wanted);
    if (!mirror) return;
    for (const t of added) {
      const target = tx.block(t);
      if (!target) continue;
      const current = relationIDs(target.values?.[mirror]);
      if (mirrorLimitOne) {
        // Die Gegenseite darf nur auf eine Zeile zeigen: frühere Zeilen verlieren dieses Ziel (beide Seiten konsistent).
        for (const other of current) {
          if (other === rowID || !tx.block(other)) continue;
          setIDs(tx, other, propertyID, relationIDs(tx.block(other)!.values?.[propertyID]).filter((x) => x !== t));
        }
        setIDs(tx, t, mirror, [rowID]);
      } else if (!current.includes(rowID)) setIDs(tx, t, mirror, [...current, rowID]);
    }
    for (const t of removed) {
      const target = tx.block(t);
      if (!target) continue;
      setIDs(tx, t, mirror, relationIDs(target.values?.[mirror]).filter((x) => x !== rowID));
    }
  });
}

/**
 * Zeilen, die beim Einschalten von „Limit to 1 page“ noch auf mehrere Seiten zeigen. Sie bleiben unverändert
 * (kein Datenverlust); die UI zeigt die Zahl als Hinweis am Schalter („N pages link more than one“).
 */
export function relationLimitViolations(store: WorkspaceStore, databaseID: string, propertyID: string): string[] {
  const out: string[] = [];
  for (const id of store.children("d:" + databaseID)) {
    const b = store.blocks.get(id);
    if (b && b.trashedAt === undefined && relationIDs(b.values?.[propertyID]).length > 1) out.push(id);
  }
  return out;
}
