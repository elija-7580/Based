// BSD-155: Layout-Logik der virtualisierten Ansichten (rein, ohne React): flache Elementlisten für Tabelle,
// Liste und Galerie, Spaltenzahl der Galerie, Spaltenbreiten der Tabelle.
import type { Block, Database, DatabaseView, QueryResult, RowGroup } from "@based/core";

export type FlatItem =
  | { kind: "group"; key: string; group: RowGroup; collapsed: boolean }
  | { kind: "row"; key: string; row: Block; groupID: string | null }
  | { kind: "cards"; key: string; rows: Block[]; groupID: string | null }
  | { kind: "new"; key: string; groupID: string | null };

export interface FlattenOptions {
  /** Eingeklappte Gruppen (IDs). */
  collapsed?: ReadonlySet<string>;
  /** „+ New“ am Ende jeder Gruppe bzw. der Liste. */
  newRow?: boolean;
  /** Galerie: Karten je Zeile (sonst eine Zeile pro Element). */
  columns?: number;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Flache Liste für einen Virtualisierer: Gruppenköpfe, Zeilen (oder Kartenreihen), „+ New“. */
export function flatten(result: QueryResult, opts: FlattenOptions = {}): FlatItem[] {
  const out: FlatItem[] = [];
  const push = (rows: Block[], groupID: string | null) => {
    if (opts.columns && opts.columns > 0) {
      chunk(rows, opts.columns).forEach((rs, i) => out.push({ kind: "cards", key: `c:${groupID ?? ""}:${i}`, rows: rs, groupID }));
    } else for (const r of rows) out.push({ kind: "row", key: (groupID === null ? "r:" : `r:${groupID}:`) + r.id, row: r, groupID });
    if (opts.newRow) out.push({ kind: "new", key: `n:${groupID ?? ""}`, groupID });
  };
  if (!result.groups) {
    push(result.rows, null);
    return out;
  }
  for (const g of result.groups) {
    const collapsed = opts.collapsed?.has(g.id) ?? false;
    out.push({ kind: "group", key: "g:" + g.id, group: g, collapsed });
    if (!collapsed) push(g.rows, g.id);
  }
  return out;
}

export const CARD_MIN_WIDTH: Record<string, number> = { small: 180, medium: 240, large: 320 };

/** Karten je Galerie-Zeile für eine Breite (mindestens 1). */
export function galleryColumns(width: number, cardSize: string | undefined, gap = 16): number {
  const min = CARD_MIN_WIDTH[cardSize ?? "medium"] ?? 240;
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
}

export const TITLE_WIDTH = 280;
export const COLUMN_WIDTH = 180;
export const MIN_COLUMN_WIDTH = 72;

/** Breite einer Tabellenspalte (gespeichert oder Standard). */
export function columnWidth(view: DatabaseView, db: Database, propertyID: string): number {
  const w = view.properties?.find((p) => p.id === propertyID)?.width;
  if (w !== undefined && w > 0) return Math.max(MIN_COLUMN_WIDTH, w);
  return db.properties.find((p) => p.id === propertyID)?.type === "title" || propertyID === "title" ? TITLE_WIDTH : COLUMN_WIDTH;
}

/** Index des nächsten Elements der Art `row` in Richtung `dir` (für Pfeiltasten), oder -1. */
export function nextRowIndex(items: FlatItem[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (items[i]!.kind === "row") return i;
  return -1;
}

/**
 * BSD-255: Inline-Tabellen zeigen nur die ersten `limit` Zeilen (über alle Gruppen); Gruppenköpfe ohne gezeigte Zeile
 * und die „New“-Zeilen verborgener Gruppen fallen weg. `hidden` = wie viele Zeilen „Load more“ noch bringt.
 */
export function limitRows(items: readonly FlatItem[], limit: number): { items: FlatItem[]; hidden: number } {
  // Galerie (Teil 2): eine Kartenreihe zählt mit ihren Karten; die letzte gezeigte Reihe wird ggf. gekürzt.
  const total = items.reduce((n, it) => n + (it.kind === "row" ? 1 : it.kind === "cards" ? it.rows.length : 0), 0);
  if (total <= limit) return { items: [...items], hidden: 0 };
  const out: FlatItem[] = [];
  let shown = 0;
  for (const it of items) {
    if (it.kind === "row") {
      if (shown >= limit) continue;
      shown++;
      out.push(it);
    } else if (it.kind === "cards") {
      if (shown >= limit) continue;
      const take = Math.min(it.rows.length, limit - shown);
      shown += take;
      out.push(take === it.rows.length ? it : { ...it, rows: it.rows.slice(0, take) });
    } else if (it.kind === "group") {
      if (shown < limit) out.push(it);
    } else if (shown < limit) out.push(it);
  }
  // Leere Gruppenköpfe am Ende (deren Zeilen alle verborgen sind) weglassen
  while (out.length && out[out.length - 1]!.kind === "group") out.pop();
  // „New“ der letzten gezeigten Gruppe bleibt, damit man auch bei langen Tabellen Zeilen anlegen kann.
  const last = out[out.length - 1];
  if (last && (last.kind === "row" || last.kind === "cards")) {
    const add = items.find((it) => it.kind === "new" && it.groupID === last.groupID);
    if (add) out.push(add);
  }
  return { items: out, hidden: total - shown };
}
