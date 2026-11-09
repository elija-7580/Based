// BSD-155: Daten für Diagramm-Ansichten, portiert aus BasedCore Model/Chart.swift (`ChartData`).
// Rein (liest nur Store und Engine), damit es ohne UI getestet wird.
import type { Block, Database, DatabaseView, PropertySchema } from "../model/records.js";
import { cellText, type QueryEngine } from "./engine.js";
import { formatNumber } from "./display.js";
import { addCalendar, formatICU, fromJSDate, localizedStandardCompare, startOfDay, toJSDate } from "./value.js";

type ChartConfig = NonNullable<DatabaseView["chart"]>;

export interface ChartPoint {
  /** Stabile ID (Options-ID, Bucket-Schlüssel). */
  key: string;
  label: string;
  value: number;
  color: string | null;
  sortDate?: number;
}

interface Bucket { key: string; label: string; color: string | null; date?: number }

function caseOf(v: unknown): [string, unknown] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  const inner = (v as Record<string, unknown>)[keys[0]!];
  return [keys[0]!, inner && typeof inner === "object" && "_0" in inner ? (inner as { _0: unknown })._0 : undefined];
}

/** Datums-Bucket: Anfang (Swift-Datum) und Beschriftung. */
export function chartDateBucket(d: number, bucket: string, weekStart = 1): [number, string] {
  const day = startOfDay(d);
  const j = toJSDate(day);
  switch (bucket) {
    case "day": return [day, formatICU(day, "MMM d, yyyy")];
    case "week": {
      const s = addCalendar(day, "day", -((j.getDay() - weekStart + 7) % 7));
      return [s, "Wk " + formatICU(s, "d MMM")];
    }
    case "quarter": {
      const s = fromJSDate(new Date(j.getFullYear(), Math.floor(j.getMonth() / 3) * 3, 1));
      return [s, `Q${Math.floor(j.getMonth() / 3) + 1} ${j.getFullYear()}`];
    }
    case "year": { const s = fromJSDate(new Date(j.getFullYear(), 0, 1)); return [s, String(j.getFullYear())]; }
    default: { const s = fromJSDate(new Date(j.getFullYear(), j.getMonth(), 1)); return [s, formatICU(s, "MMM yyyy")]; }
  }
}

function reduce(xs: number[], aggregate: string, countRows: boolean): number {
  const known = ["count", "sum", "average", "min", "max", "median"];
  if (countRows || aggregate === "count" || !known.includes(aggregate)) return xs.length;
  if (xs.length === 0) return 0;
  switch (aggregate) {
    case "sum": return xs.reduce((a, b) => a + b, 0);
    case "average": return xs.reduce((a, b) => a + b, 0) / xs.length;
    case "min": return Math.min(...xs);
    case "max": return Math.max(...xs);
    default: {
      const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
      return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
    }
  }
}

function bucketKeys(engine: QueryEngine, row: Block, p: PropertySchema | undefined, db: Database, c: ChartConfig): Bucket[] {
  if (!p) return [{ key: "all", label: "All", color: null }];
  const empty = (label = "Empty"): Bucket[] => [{ key: "__empty", label, color: "gray" }];
  const options = (ids: string[]): Bucket[] => ids.length === 0 ? empty() : ids.map((id) => {
    const o = p.options?.find((x) => x.id === id);
    return { key: id, label: o?.name ?? id, color: o?.color ?? null };
  });
  const stored = caseOf(row.values?.[p.id]);
  switch (p.type) {
    case "select": case "status": case "multiSelect":
      if (stored?.[0] === "select" || stored?.[0] === "status") return options([stored[1] as string]);
      if (stored?.[0] === "multiSelect") return options(stored[1] as string[]);
      return empty();
    case "checkbox":
      return stored?.[0] === "checkbox" && stored[1] === true ? [{ key: "yes", label: "Checked", color: "green" }] : [{ key: "no", label: "Unchecked", color: "gray" }];
  }
  const v = engine.value(row, p, db);
  switch (v.t) {
    case "date": {
      const [start, label] = chartDateBucket(v.v.start, c.dateBucket, engine.weekStart);
      return [{ key: "d:" + start, label, color: null, date: start }];
    }
    case "bool": return [{ key: v.v ? "yes" : "no", label: v.v ? "Checked" : "Unchecked", color: v.v ? "green" : "gray" }];
    case "number": return [{ key: "n:" + v.v, label: formatNumber(v.v, p.numberFormat), color: null }];
    case "empty": return empty(p.type === "date" ? "No date" : "Empty");
    default: {
      const t = cellText(engine.store, v);
      return t ? [{ key: "t:" + t, label: t, color: null }] : empty();
    }
  }
}

const numberOf = (engine: QueryEngine, row: Block, p: PropertySchema, db: Database): number | undefined => {
  const v = engine.value(row, p, db);
  return v.t === "number" ? v.v : undefined;
};

/** Punkte eines Diagramms: Zeilen nach der x-Property gruppiert, y aggregiert (ohne y: Anzahl). */
export function chartPoints(engine: QueryEngine, rows: Block[], db: Database, config: ChartConfig): ChartPoint[] {
  const buckets = new Map<string, { label: string; values: number[]; color: string | null; date?: number }>();
  const order: string[] = [];
  const xProp = config.xPropertyID ? db.properties.find((p) => p.id === config.xPropertyID) : undefined;
  const yProp = config.yPropertyID ? db.properties.find((p) => p.id === config.yPropertyID) : undefined;
  for (const row of rows) {
    let y = 1;
    if (yProp) {
      const n = numberOf(engine, row, yProp, db);
      if (n === undefined) continue;
      y = n;
    }
    for (const k of bucketKeys(engine, row, xProp, db, config)) {
      let b = buckets.get(k.key);
      if (!b) {
        b = { label: k.label, values: [], color: k.color, ...(k.date !== undefined ? { date: k.date } : {}) };
        buckets.set(k.key, b);
        order.push(k.key);
      }
      b.values.push(y);
    }
  }
  let pts: ChartPoint[] = order.map((key) => {
    const b = buckets.get(key)!;
    const p: ChartPoint = { key, label: b.label, value: reduce(b.values, config.aggregate, config.yPropertyID === undefined), color: b.color };
    if (b.date !== undefined) p.sortDate = b.date;
    return p;
  });
  if (xProp && (xProp.type === "select" || xProp.type === "status" || xProp.type === "multiSelect")) {
    const idx = (k: string) => { const i = (xProp.options ?? []).findIndex((o) => o.id === k); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    pts = pts.map((p, i) => [p, i] as const).sort((a, b) => idx(a[0].key) - idx(b[0].key) || a[1] - b[1]).map(([p]) => p);
  } else if (pts.every((p) => p.sortDate !== undefined)) {
    pts.sort((a, b) => a.sortDate! - b.sortDate!);
  } else pts.sort((a, b) => localizedStandardCompare(a.label, b.label));
  if (config.sortByValue) pts = pts.map((p, i) => [p, i] as const).sort((a, b) => b[0].value - a[0].value || a[1] - b[1]).map(([p]) => p);
  const limit = config.limit;
  if (limit !== undefined && limit > 0 && pts.length > limit) {
    const rest = pts.slice(limit).reduce((a, p) => a + p.value, 0);
    pts = [...pts.slice(0, limit), { key: "__other", label: "Other", value: rest, color: "gray" }];
  }
  return pts;
}

/** Einzelwert für „Number“-Diagramme: Aggregat über alle Zeilen (ohne y: Anzahl). */
export function chartNumber(engine: QueryEngine, rows: Block[], db: Database, config: ChartConfig): number {
  const yProp = config.yPropertyID ? db.properties.find((p) => p.id === config.yPropertyID) : undefined;
  if (!yProp) return rows.length;
  const xs = rows.flatMap((r) => { const n = numberOf(engine, r, yProp, db); return n === undefined ? [] : [n]; });
  return reduce(xs, config.aggregate, false);
}
