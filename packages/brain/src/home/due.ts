// BSD-278: fällige Aufgaben aus den Datenbanken des Nutzers für den rechten Bogen der Startseite – rein, ohne DOM.
// Welche Datenbanken zählen (entschieden im Nachtlauf 11.11., Vorschlag aus dem Eintrag): jede mit einer Datums-
// Property und einer Status- oder Checkbox-Property. Eine Zeile ist fällig, wenn ihr Datum (erste Datums-Property,
// Beginn) im Fenster liegt und sie nicht erledigt ist (Status in der Gruppe „Complete“ bzw. Checkbox angehakt).
// Überfälliges von heute (Uhrzeit vorbei, ganztägig heute) liegt auf „now“, damit es rechts sichtbar bleibt.
import { isTrashed, plainText, rowsOf, titleOf, type Block, type Database, type PropertySchema, type WorkspaceStore } from "@based/core";
import { SWIFT_EPOCH_MS } from "../agents/records.js";

export interface DueItem {
  rowID: string;
  title: string;
  databaseID: string;
  databaseTitle: string;
  /** Fälligkeit (ms seit 1970); ganztägig = lokale Mitternacht des Tages. */
  dueMs: number;
  allDay: boolean;
}

const toMs = (swift: number) => swift * 1000 + SWIFT_EPOCH_MS;

/** Erledigt-Gruppe eines Status: „Complete“/„Done“/„Erledigt“, sonst die letzte von mindestens drei Gruppen. */
function doneOptionIDs(p: PropertySchema): Set<string> {
  const groups = p.statusGroups ?? [];
  const g = groups.find((x) => /^(complete|completed|done|erledigt|fertig)$/i.test(x.name.trim())) ?? (groups.length >= 3 ? groups[groups.length - 1] : undefined);
  return new Set(g?.optionIDs ?? []);
}

interface Rule {
  date: PropertySchema;
  isDone: (row: Block) => boolean;
}

/** Zählt die Datenbank? Dann: welche Datums-Property und wann ist eine Zeile erledigt. */
export function dueRule(db: Database): Rule | undefined {
  const date = db.properties.find((p) => p.type === "date");
  if (!date) return undefined;
  const status = db.properties.find((p) => p.type === "status");
  if (status) {
    const done = doneOptionIDs(status);
    return { date, isDone: (row) => { const v = row.values?.[status.id] as { status?: { _0?: string } } | undefined; return v?.status?._0 !== undefined && done.has(v.status._0); } };
  }
  const box = db.properties.find((p) => p.type === "checkbox");
  if (box) return { date, isDone: (row) => (row.values?.[box.id] as { checkbox?: { _0?: boolean } } | undefined)?.checkbox?._0 === true };
  return undefined;
}

/** Fällige, offene Zeilen mit Datum in [fromMs, toMs], nach Fälligkeit sortiert (höchstens `limit`). */
export function dueItems(store: WorkspaceStore, fromMs: number, toMs_: number, limit = 50): DueItem[] {
  const out: DueItem[] = [];
  for (const db of store.databases.values()) {
    if (!store.blocks.has(db.blockID) || isTrashed(store, db.blockID)) continue;
    const rule = dueRule(db);
    if (!rule) continue;
    const dbTitle = plainText(db.title) || "Untitled";
    for (const row of rowsOf(store, db.id)) {
      if (row.props?.isTemplate) continue;
      const v = (row.values?.[rule.date.id] as { date?: { _0?: { start: number; includeTime: boolean } } } | undefined)?.date?._0;
      if (!v) continue;
      const at = toMs(v.start);
      if (at < fromMs || at > toMs_ || rule.isDone(row)) continue;
      out.push({ rowID: row.id, title: titleOf(store, row.id) || "Untitled", databaseID: db.id, databaseTitle: dbTitle, dueMs: at, allDay: !v.includeTime });
    }
  }
  out.sort((a, b) => a.dueMs - b.dueMs || (a.rowID < b.rowID ? -1 : 1));
  return out.slice(0, limit);
}
