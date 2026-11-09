// BSD-8: Gemeinsames von Kalender und Timeline: Datums-/Ende-Property der Ansicht, Zeiträume aller Zeilen
// (memoisiert auf das Abfrageergebnis), Bereichsindex, Vorschau beim Ziehen, Titel.
import { useEffect, useMemo, useState } from "react";
import {
  SpanIndex, calendarDateProperty, calendarEndProperty, canWriteSpan, plainText, resizeSpan, rowSpans, shiftSpan, today,
  type Block, type DatabaseView, type PropertySchema, type QueryResult, type RowSpan, type SpanProperties,
} from "@based/core";
import { useDB } from "../context.js";
import type { DateDrag } from "./dateDrag.js";

export interface ViewSpans {
  dateProp: PropertySchema | undefined;
  endProp: PropertySchema | undefined;
  props: SpanProperties | undefined;
  /** Datum lässt sich schreiben (echte Datums-Property, Datenbank nicht gesperrt). */
  writable: boolean;
  dated: RowSpan[];
  undated: Block[];
  index: SpanIndex;
  byID: Map<string, RowSpan>;
}

export function useViewSpans(view: DatabaseView, result: QueryResult): ViewSpans {
  const { store, engine, db, locked, version } = useDB();
  const dateProp = calendarDateProperty(db, view);
  const endProp = calendarEndProperty(db, view);
  return useMemo(() => {
    const props = dateProp ? { dateID: dateProp.id, ...(endProp && endProp.id !== dateProp.id ? { endID: endProp.id } : {}) } : undefined;
    const { dated, undated } = dateProp ? rowSpans(engine, db, result.rows, dateProp, endProp) : { dated: [], undated: result.rows };
    const byID = new Map(dated.map((s) => [s.row.id, s]));
    return {
      dateProp, endProp, props, dated, undated, byID, index: new SpanIndex(dated),
      writable: !locked && props !== undefined && canWriteSpan(store, db.id, props),
    };
  }, [result, dateProp, endProp, engine, db, locked, version, store]);
}

/** Vorschau eines Zeitraums während des Ziehens. */
export function previewSpan(s: RowSpan, drag: DateDrag | null): RowSpan {
  if (!drag || drag.rowID !== s.row.id) return s;
  if (drag.kind === "move") return shiftSpan(s, drag.delta);
  if ((drag.kind === "start" || drag.kind === "end") && drag.day !== undefined) return resizeSpan(s, drag.kind, drag.day);
  return s;
}

/** Zeiträume eines Bereichs, mit dem gezogenen Eintrag an seiner Vorschau-Position. */
export function spansIn(v: ViewSpans, from: number, to: number, drag: DateDrag | null): RowSpan[] {
  const hits = v.index.query(from, to);
  if (!drag) return hits;
  const orig = v.byID.get(drag.rowID);
  if (!orig) return hits;
  const p = previewSpan(orig, drag);
  const out = hits.filter((s) => s.row.id !== drag.rowID);
  if (p.start <= to && p.end >= from) {
    const i = hits.findIndex((s) => s.row.id === drag.rowID);
    out.splice(i < 0 ? out.length : i, 0, p);
  }
  return out;
}

export const rowTitle = (row: Block): string => plainText(row.text) || "Untitled";

/** Heute als Tagesindex; wechselt um Mitternacht. */
export function useToday(): number {
  const [d, setD] = useState(() => today());
  useEffect(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    const t = setTimeout(() => setD(today()), Math.min(next + 1000, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [d]);
  return d;
}
