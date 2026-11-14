// BSD-407 Teil 3: einfache Tabelle im Block-Editor auf dem gemeinsamen Format (wie Swift, BlockNote-Mapping und alle
// Importer): Block `table` mit `tableColumns`, `tableHeaderRow`, `tableHeaderColumn`, `tableColumnWidths`; jede Zeile ein
// Kind-Block `tableRow` mit `cells` (RichText je Spalte) und `cellColors`. Bis Teil 2 schrieb der Block-Editor die Zellen
// flach in `table.props.cells`; solche Tabellen werden gelesen und beim ersten Bearbeiten in Zeilen-Records überführt
// (nichts geht verloren). Zellen werden als Klartext bearbeitet, Formatierung außerhalb der Änderung bleibt.
import type { Block, BlockProps, RichText } from "../../model/records.js";
import type { Tx, WorkspaceStore } from "../../store/store.js";
import { sortKeys } from "../../store/pages.js";
import { create, type Focus } from "./blocks.js";
import { blockText, editPlainText, runsOf } from "./text.js";
import { liveChildren } from "./tree.js";

export interface TableModel {
  cols: number;
  /** Zeilen; `id` fehlt bei einer alten flachen Tabelle (noch ohne Zeilen-Records). */
  rows: { id?: string; cells: RichText[] }[];
  header: boolean;
}

const rowIDs = (store: WorkspaceStore, tableId: string) => liveChildren(store, tableId).filter((id) => store.blocks.get(id)?.type === "tableRow");

/** Tabelle lesen: Zeilen-Records, sonst die alte flache Form `props.cells`. */
export function tableModel(store: WorkspaceStore, tableId: string): TableModel | undefined {
  const t = store.blocks.get(tableId);
  if (t?.type !== "table") return undefined;
  const p = t.props ?? {};
  const ids = rowIDs(store, tableId);
  let rows: TableModel["rows"];
  if (ids.length > 0) rows = ids.map((id) => ({ id, cells: [...(store.blocks.get(id)!.props?.cells ?? [])] }));
  else if (Array.isArray(p.cells) && p.cells.length > 0) {
    const n = Math.max(1, p.tableColumns ?? 1);
    rows = [];
    for (let i = 0; i < p.cells.length; i += n) rows.push({ cells: p.cells.slice(i, i + n) });
  } else rows = [];
  const cols = Math.max(p.tableColumns ?? 0, ...rows.map((r) => r.cells.length), 1);
  for (const r of rows) while (r.cells.length < cols) r.cells.push("");
  return { cols, rows, header: p.tableHeaderRow === true };
}

/** Neue einfache Tabelle (Slash „Simple table“): 2 × 2 mit Kopfzeile. */
export function tableProps(cols = 2): BlockProps {
  return { tableColumns: cols, tableHeaderRow: true };
}

/** Zeilen-Records für eine Tabelle schreiben (Inhalt `rows`), alte flache Zellen und überzählige Zeilen entfernen. */
function writeRows(store: WorkspaceStore, tx: Tx, tableId: string, rows: RichText[][], cols: number) {
  const parent = "b:" + tableId;
  const existing = rowIDs(store, tableId);
  const extra = rows.length > existing.length ? sortKeys(store, parent, { kind: "end" }, rows.length - existing.length) : [];
  rows.forEach((cells, i) => {
    const norm = Array.from({ length: cols }, (_, k) => cells[k] ?? "");
    const id = existing[i];
    if (id) {
      const cur = store.blocks.get(id)!.props?.cells ?? [];
      if (JSON.stringify(cur) === JSON.stringify(norm)) return;
      tx.update(id, (x) => { x.props = { ...(x.props ?? {}), cells: norm } as BlockProps; });
    } else create(store, tx, "tableRow", parent, extra[i - existing.length]!, [], { cells: norm });
  });
  if (existing.length > rows.length) store.deleteBlocksIn(tx, existing.slice(rows.length));
  tx.update(tableId, (x) => {
    const p: Record<string, unknown> = { ...(x.props ?? {}) };
    delete p.cells;
    p.tableColumns = cols;
    x.props = p as BlockProps;
  });
}

function change(store: WorkspaceStore, tableId: string, name: string, f: (m: TableModel) => { rows: RichText[][]; cols: number } | undefined): boolean {
  const m = tableModel(store, tableId);
  if (!m) return false;
  const next = f(m);
  if (!next) return false;
  store.transact(name, (tx) => writeRows(store, tx, tableId, next.rows, next.cols));
  return true;
}

/** Zelle (Zeile, Spalte) als Klartext setzen; Formatierung außerhalb der Änderung bleibt. Ein Undo-Schritt. */
export function setTableCell(store: WorkspaceStore, tableId: string, row: number, col: number, text: string): boolean {
  return change(store, tableId, "Edit table", (m) => {
    const r = m.rows[row];
    if (!r || col < 0 || col >= m.cols) return undefined;
    const old = runsOf(r.cells[col]);
    if (old.map((x) => x.t).join("") === text) return undefined;
    const rows = m.rows.map((x) => [...x.cells]);
    rows[row]![col] = blockText(editPlainText(old, text)) ?? "";
    return { rows, cols: m.cols };
  });
}

export function addTableRow(store: WorkspaceStore, tableId: string): boolean {
  return change(store, tableId, "Add row", (m) => ({ rows: [...m.rows.map((r) => r.cells), Array.from({ length: m.cols }, () => "")], cols: m.cols }));
}

export function addTableColumn(store: WorkspaceStore, tableId: string): boolean {
  return change(store, tableId, "Add column", (m) => ({ rows: (m.rows.length ? m.rows.map((r) => r.cells) : [[]]).map((c) => [...c, ""]), cols: m.cols + 1 }));
}

/** Zeile löschen (die letzte bleibt). */
export function deleteTableRow(store: WorkspaceStore, tableId: string, row: number): boolean {
  const m = tableModel(store, tableId);
  const id = m && m.rows.length > 1 ? m.rows[row]?.id : undefined;
  if (id) {
    // Zeilen-Record selbst löschen (die anderen behalten ihre ID)
    store.transact("Delete row", (tx) => store.deleteBlocksIn(tx, [id]));
    return true;
  }
  return change(store, tableId, "Delete row", (m) => (m.rows.length <= 1 || !m.rows[row] ? undefined : { rows: m.rows.filter((_, i) => i !== row).map((r) => r.cells), cols: m.cols }));
}

/** Spalte löschen (die letzte bleibt). */
export function deleteTableColumn(store: WorkspaceStore, tableId: string, col: number): boolean {
  return change(store, tableId, "Delete column", (m) => (m.cols <= 1 || col < 0 || col >= m.cols ? undefined : { rows: m.rows.map((r) => r.cells.filter((_, j) => j !== col)), cols: m.cols - 1 }));
}

/** Leeren Textblock in eine 2 × 2-Tabelle verwandeln oder dahinter einfügen (Slash „Simple table“). */
export function insertTable(store: WorkspaceStore, after: string, replace: boolean, cols = 2, rows = 2): Focus | undefined {
  const a = store.blocks.get(after);
  if (!a) return undefined;
  return store.transact("New table", (tx) => {
    let id: string;
    if (replace) {
      id = a.id;
      tx.update(id, (x) => { x.type = "table" as Block["type"]; delete x.text; x.props = tableProps(cols); });
    } else id = create(store, tx, "table", a.parent, sortKeys(store, a.parent, { kind: "after", id: a.id }, 1)[0]!, [], tableProps(cols));
    const keys = sortKeys(store, "b:" + id, { kind: "end" }, rows);
    for (let i = 0; i < rows; i++) create(store, tx, "tableRow", "b:" + id, keys[i]!, [], { cells: Array.from({ length: cols }, () => "") });
    return { blockId: id, selected: true } as Focus;
  });
}
