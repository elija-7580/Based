// Zeile als Seite öffnen (Notion „Open pages in“): Side Peek, Center Peek oder ganze Seite – pro Ansicht
// (`view.openIn`, Standard Side Peek wie in der Swift-App). Rein, ohne React: welche Zeile offen ist, die
// Reihenfolge laut Ansicht (Filter, Sortierung, Gruppen) für Vor/Zurück, Tastenkürzel, Speichern übers Neuladen.
import type { DatabaseView, QueryResult } from "@based/core";

export type OpenMode = "sidePeek" | "centerPeek" | "fullPage";
export const OPEN_MODES: readonly OpenMode[] = ["sidePeek", "centerPeek", "fullPage"];
export const OPEN_MODE_LABELS: Record<OpenMode, string> = { sidePeek: "Side peek", centerPeek: "Center peek", fullPage: "Full page" };

/** Modus einer Ansicht; fehlend oder unbekannt (neuere Version) = Side Peek. */
export function openModeOf(view: Pick<DatabaseView, "openIn"> | undefined): OpenMode {
  const m = view?.openIn;
  return m === "centerPeek" ? "centerPeek" : m === "fullPage" ? "fullPage" : "sidePeek";
}

/**
 * Zeilen in der Reihenfolge, in der die Ansicht sie zeigt: gruppiert nach Gruppen (ausgeblendete fehlen schon im
 * Ergebnis), sonst die sortierte Liste. Eine Zeile in mehreren Gruppen (Multi-Select) zählt einmal, an erster Stelle.
 */
export function rowOrder(result: QueryResult): string[] {
  if (!result.groups) return result.rows.map((r) => r.id);
  const seen = new Set<string>(), out: string[] = [];
  for (const g of result.groups) for (const r of g.rows) if (!seen.has(r.id)) { seen.add(r.id); out.push(r.id); }
  return out;
}

export interface PeekPosition {
  /** Stelle der Zeile in der Ansicht, -1 wenn sie (z. B. nach einer Änderung durch den Filter) nicht mehr darin ist. */
  index: number;
  total: number;
  prev: string | undefined;
  next: string | undefined;
}

/**
 * Nachbarn der offenen Zeile. Fällt die Zeile aus der Ansicht, geht es von ihrer letzten Stelle (`lastIndex`)
 * weiter: „weiter“ ist dann die Zeile, die nachgerückt ist.
 */
export function peekPosition(order: readonly string[], rowID: string, lastIndex?: number): PeekPosition {
  const index = order.indexOf(rowID), total = order.length;
  if (index >= 0) return { index, total, prev: order[index - 1], next: order[index + 1] };
  if (lastIndex === undefined || lastIndex < 0) return { index: -1, total, prev: undefined, next: undefined };
  const at = Math.min(lastIndex, total);
  return { index: -1, total, prev: order[at - 1], next: order[at] };
}

export interface PeekState {
  rowID: string;
  /** Ansicht, aus der geöffnet wurde (bestimmt Modus und Reihenfolge). */
  viewID: string;
}

export const serializePeek = (s: PeekState | undefined): string | null => (s ? JSON.stringify({ v: 1, row: s.rowID, view: s.viewID }) : null);

/** Gespeicherten Zustand lesen; alles Unlesbare ist „nichts offen“. */
export function parsePeek(raw: string | null | undefined): PeekState | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as { v?: unknown; row?: unknown; view?: unknown };
    return j && j.v === 1 && typeof j.row === "string" && j.row && typeof j.view === "string" ? { rowID: j.row, viewID: j.view } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Nach dem Neuladen: nur wieder öffnen, wenn es die Zeile noch gibt (nicht gelöscht, nicht im Papierkorb, in dieser
 * Datenbank). Gibt es die Ansicht nicht mehr, gilt die aktive.
 */
export function restorePeek(s: PeekState | undefined, ctx: { rowIDs: ReadonlySet<string> | ((id: string) => boolean); viewIDs: readonly string[]; activeViewID: string }): PeekState | undefined {
  if (!s) return undefined;
  const has = typeof ctx.rowIDs === "function" ? ctx.rowIDs(s.rowID) : ctx.rowIDs.has(s.rowID);
  if (!has) return undefined;
  return ctx.viewIDs.includes(s.viewID) ? s : { rowID: s.rowID, viewID: ctx.activeViewID };
}

/** ⌃⇧↑ / ⌃⇧↓ (auch ⌃⇧K / ⌃⇧J): vorige/nächste Zeile. */
export function peekShortcut(e: { key: string; ctrlKey: boolean; shiftKey: boolean; metaKey?: boolean; altKey?: boolean }): "prev" | "next" | undefined {
  if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return undefined;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "ArrowUp" || k === "k") return "prev";
  if (k === "ArrowDown" || k === "j") return "next";
  return undefined;
}
