// Abfragen auf Datenbanken: Werte (inkl. Formeln, Relationen, Rollups), Filter, Sortierung, Gruppen,
// Spalten-Berechnungen. Portiert aus BasedCore Query/QueryEngine.swift. Verifiziert über
// fixtures/queries/queries.utc.json und values.utc.json (BSD-173).
import type { Block, Database, DatabaseView, PropertySchema, PropertyValue, RichText } from "../model/records.js";
import type { WorkspaceStore } from "../store/store.js";
import { Formula, FormulaError, type FormulaEnvironment } from "./formula.js";
import {
  addCalendar, asList, bool, compareValues, date, describe, EMPTY, formatICU, fromJSDate, isEmptyValue, list,
  localizedStandardCompare, num, parseDate, parseSwiftDouble, plainNumber, startOfDay, str, toJSDate, truthy,
  type DateValue, type Value,
} from "./value.js";

export const TITLE_PROPERTY_ID = "title";

export interface RowGroup {
  /** Option-ID, Person, "true"/"false", Datums-Schlüssel oder "" für die leere Gruppe. */
  id: string;
  title: string;
  color: string | null;
  rows: Block[];
}

export interface QueryResult {
  rows: Block[];
  groups?: RowGroup[];
}

type FilterItemWire = Record<string, unknown>;
type FilterGroupWire = { combinator: string; items: FilterItemWire[] };
type FilterConditionWire = { id: string; propertyID: string; op: string; value?: unknown };

const KNOWN_FILTER_OPS = new Set(["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "isEmpty", "isNotEmpty",
  "greater", "less", "greaterOrEqual", "lessOrEqual", "before", "after", "onOrBefore", "onOrAfter", "within"]);

/** Ein-Schlüssel-Enum `{"fall":{"_0":wert}}` → [fall, wert]. */
function enumCase(v: unknown): [string, unknown] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  const inner = (v as Record<string, unknown>)[keys[0]!];
  return [keys[0]!, inner && typeof inner === "object" && "_0" in inner ? (inner as { _0: unknown })._0 : undefined];
}

export const richPlain = (t: RichText | undefined) => (t === undefined ? "" : typeof t === "string" ? t : t.map((r) => r.t ?? "").join(""));

// MARK: Store-Helfer (Swift: PageOps, DatabaseOps, RelationIntegrity)

export function isTrashed(store: WorkspaceStore, id: string): boolean {
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (cur.trashedAt !== undefined) return true;
    const p = cur.parent;
    if (p === "w") return false;
    if (p.startsWith("b:")) {
      cur = store.blocks.get(p.slice(2));
      if (!cur) return true;
    } else {
      const owner = store.databases.get(p.slice(2))?.blockID;
      if (!owner) return true;
      cur = store.blocks.get(owner);
      if (!cur) return true;
    }
  }
  return false;
}

export function titleOf(store: WorkspaceStore, id: string): string {
  const b = store.blocks.get(id);
  if (!b) return "Untitled";
  if ((b.type === "databasePage" || b.type === "databaseInline") && b.props?.databaseID) {
    const db = store.databases.get(b.props.databaseID);
    if (db) {
      const t = richPlain(db.title);
      return t ? t : "Untitled";
    }
  }
  const t = richPlain(b.text).replace(/^[ \t]+|[ \t]+$/g, "");
  return t ? t : "Untitled";
}

/** Text mit aktuellen Seitentiteln für Seiten-Erwähnungen. */
export function plainTextResolvingMentions(store: WorkspaceStore, t: RichText | undefined): string {
  if (t === undefined || typeof t === "string") return t ?? "";
  return t.map((r) => {
    const m = enumCase(r.mention);
    if (m && m[0] === "page" && typeof m[1] === "string" && store.blocks.has(m[1])) return titleOf(store, m[1]);
    return r.t ?? "";
  }).join("");
}

export const liveRelationTargets = (store: WorkspaceStore, ids: string[]) => ids.filter((id) => store.blocks.has(id) && !isTrashed(store, id));

/** Sichtbare Zeilen einer Datenbank (ohne Papierkorb). */
export function rowsOf(store: WorkspaceStore, databaseID: string): Block[] {
  return store.children("d:" + databaseID).map((id) => store.blocks.get(id)!).filter((b) => b && b.trashedAt === undefined);
}

export function databaseOfRow(store: WorkspaceStore, id: string): Database | undefined {
  const b = store.blocks.get(id);
  return b?.parent.startsWith("d:") ? store.databases.get(b.parent.slice(2)) : undefined;
}

export const propertyById = (db: Database, id: string) => db.properties.find((p) => p.id === id);
export const propertyByName = (db: Database, name: string) => {
  const l = name.toLocaleLowerCase();
  return db.properties.find((p) => p.name.toLocaleLowerCase() === l);
};
export function titleProperty(db: Database): PropertySchema {
  return db.properties.find((p) => p.type === "title") ?? { id: TITLE_PROPERTY_ID, name: "Name", type: "title" };
}
const optionById = (p: PropertySchema, id: string) => p.options?.find((o) => o.id === id);
const optionByName = (p: PropertySchema, name: string) => p.options?.find((o) => o.name.toLocaleLowerCase() === name.toLocaleLowerCase());

/** Swift `PlaceValue.display`. */
export function placeDisplay(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const v = JSON.parse(t) as { name?: string; address?: string; lat?: number; lon?: number };
      const name = v.name?.trim() ? v.name : undefined, address = v.address?.trim() ? v.address : undefined;
      if (name && address) return address.startsWith(name) ? address : `${name}, ${address}`;
      if (name) return name;
      if (address) return address;
      if (v.lat !== undefined && v.lon !== undefined) return `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}`;
      return "";
    } catch { /* kein JSON: wie Text behandeln */ }
  }
  const parts = t.split(",").map((s) => s.trim());
  if (parts.length === 2) {
    const a = parseSwiftDouble(parts[0]!), b = parseSwiftDouble(parts[1]!);
    if (a !== undefined && b !== undefined && Math.abs(a) <= 90 && Math.abs(b) <= 180) return `${a.toFixed(5)}, ${b.toFixed(5)}`;
  }
  return t;
}

/** Anzeige-Text einer Zelle (Swift `CellFormatter.text`). */
export function cellText(store: WorkspaceStore, v: Value): string {
  switch (v.t) {
    case "page": return titleOf(store, v.v);
    case "person": return v.v === "me" ? "Me" : v.v;
    case "list": return v.v.map((x) => cellText(store, x)).filter((s) => s.length > 0).join(", ");
    case "number": return plainNumber(v.v);
    default: return describe(v);
  }
}

// MARK: Engine

export interface QueryEngineOptions {
  /** Jetzt, als Swift-Datum. */
  now?: number;
  /** Erster Wochentag für Wochengruppen (0 = Sonntag, Standard 1 = Montag wie Calendar.current in Wien und unter Linux). */
  weekStart?: number;
}

export class QueryEngine {
  now: number;
  weekStart: number;
  maxDepth = 32;
  private formulas = new Map<string, Formula | FormulaError>();
  private memo = new Map<string, Map<string, Value>>();
  private stack: string[] = [];
  private onStack = new Set<string>();
  private cellErrors = new Map<string, Map<string, FormulaError>>();

  constructor(readonly store: WorkspaceStore, opts: QueryEngineOptions = {}) {
    this.now = opts.now ?? fromJSDate(new Date());
    this.weekStart = opts.weekStart ?? 1;
  }

  reset(now = fromJSDate(new Date())) {
    this.memo.clear();
    this.cellErrors.clear();
    this.now = now;
  }

  error(row: string, prop: string): FormulaError | undefined {
    return this.cellErrors.get(row)?.get(prop);
  }

  private fail(key: string, propID: string, e: FormulaError) {
    const row = key.split("\u0001")[0]!;
    const old = this.cellErrors.get(row)?.get(propID);
    if (old && (old.kind === "cycle" || old.kind === "tooDeep")) return;
    if (!this.cellErrors.has(row)) this.cellErrors.set(row, new Map());
    this.cellErrors.get(row)!.set(propID, e);
  }

  valueById(rowID: string, propertyID: string): Value {
    const row = this.store.blocks.get(rowID), db = databaseOfRow(this.store, rowID);
    if (!row || !db) return EMPTY;
    const p = propertyById(db, propertyID) ?? (propertyID === TITLE_PROPERTY_ID ? titleProperty(db) : undefined);
    return p ? this.value(row, p, db) : EMPTY;
  }

  value(row: Block, p: PropertySchema, db: Database): Value {
    const cached = this.memo.get(row.id)?.get(p.id);
    if (cached) return cached;
    const key = row.id + "\u0001" + p.id;
    let v: Value;
    switch (p.type) {
      case "title": v = str(richPlain(row.text)); break;
      case "formula": case "rollup": {
        if (this.onStack.has(key)) {
          const i = this.stack.lastIndexOf(key);
          for (const k of this.stack.slice(i)) this.fail(k, k.split("\u0001")[1]!, new FormulaError("Circular reference", "cycle"));
          return EMPTY;
        }
        if (this.stack.length >= this.maxDepth) {
          const deep = new FormulaError("Too many nested formulas or rollups", "tooDeep");
          this.fail(key, p.id, deep);
          for (const k of this.stack) this.fail(k, k.split("\u0001")[1]!, deep);
          return EMPTY;
        }
        this.stack.push(key);
        this.onStack.add(key);
        const computed = p.type === "formula" ? this.formulaValue(row, p, db, key) : this.rollupValue(row, p, db);
        this.stack.pop();
        this.onStack.delete(key);
        const e = this.cellErrors.get(row.id)?.get(p.id);
        v = e && (e.kind === "cycle" || e.kind === "tooDeep") ? EMPTY : computed;
        break;
      }
      case "createdTime": v = date({ start: row.createdAt, includeTime: true }); break;
      case "lastEditedTime": v = date({ start: row.updatedAt, includeTime: true }); break;
      case "createdBy": v = row.createdBy !== undefined ? { t: "person", v: row.createdBy } : EMPTY; break;
      case "lastEditedBy": v = row.updatedBy !== undefined ? { t: "person", v: row.updatedBy } : EMPTY; break;
      case "button": case "verification": v = EMPTY; break;
      case "relation": {
        const c = enumCase(row.values?.[p.id]);
        if (c && c[0] === "relation" && Array.isArray(c[1])) v = list(liveRelationTargets(this.store, c[1] as string[]).map((id) => ({ t: "page", v: id })));
        else v = QueryEngine.valueOf(row.values?.[p.id], p);
        break;
      }
      default: v = QueryEngine.valueOf(row.values?.[p.id], p);
    }
    if (!this.memo.has(row.id)) this.memo.set(row.id, new Map());
    this.memo.get(row.id)!.set(p.id, v);
    return v;
  }

  /** Gespeicherter Wert → berechneter Wert. */
  static valueOf(pv: PropertyValue | undefined, p: PropertySchema): Value {
    if (pv === undefined) return p.type === "checkbox" ? bool(false) : EMPTY;
    const c = enumCase(pv);
    if (!c) return EMPTY;
    const [k, x] = c;
    switch (k) {
      case "text": return str(richPlain(x as RichText));
      case "number": return num(x as number);
      case "select": case "status": { const o = optionById(p, x as string); return o ? str(o.name) : EMPTY; }
      case "multiSelect": return list((x as string[]).flatMap((id) => { const o = optionById(p, id); return o ? [str(o.name)] : []; }));
      case "date": return date(x as DateValue);
      case "person": return list((x as string[]).map((id) => ({ t: "person", v: id }) as Value));
      case "files": return list((x as { name: string }[]).map((f) => str(f.name)));
      case "checkbox": return bool(x as boolean);
      case "url": case "email": case "phone": return str(x as string);
      case "place": return str(placeDisplay(x as string));
      case "relation": return list((x as string[]).map((id) => ({ t: "page", v: id }) as Value));
      case "uniqueID": return num(x as number);
      default: return EMPTY; // BSD-107: Wertart einer neueren Version
    }
  }

  private compiled(src: string): Formula | FormulaError {
    let f = this.formulas.get(src);
    if (!f) {
      try {
        f = new Formula(src);
      } catch (e) {
        f = e instanceof FormulaError ? e : new FormulaError(String(e));
      }
      this.formulas.set(src, f);
    }
    return f;
  }

  private formulaValue(row: Block, p: PropertySchema, db: Database, key: string): Value {
    const src = p.formula;
    if (!src || !src.trim()) return EMPTY;
    const f = this.compiled(src);
    if (f instanceof FormulaError) {
      this.fail(key, p.id, f);
      return EMPTY;
    }
    try {
      const v = f.evaluate(this.environment(row, db));
      if (v.t === "number" && !Number.isFinite(v.v)) {
        this.fail(key, p.id, new FormulaError("Result is not a finite number", "invalidArgument"));
        return EMPTY;
      }
      return v;
    } catch (e) {
      this.fail(key, p.id, e instanceof FormulaError ? e : new FormulaError(String(e)));
      return EMPTY;
    }
  }

  environment(row: Block, db: Database): FormulaEnvironment {
    return {
      prop: (name) => {
        const q = propertyByName(db, name);
        if (!q) throw new FormulaError(`Property “${name}” not found`);
        return this.value(row, q, db);
      },
      pageProp: (pid, name) => {
        const r = this.store.blocks.get(pid), d = databaseOfRow(this.store, pid);
        if (!r || !d) {
          const l = name.toLowerCase();
          return l === "title" || l === "name" ? str(titleOf(this.store, pid)) : EMPTY;
        }
        const q = propertyByName(d, name);
        if (!q) throw new FormulaError(`Property “${name}” not found`);
        return this.value(r, q, d);
      },
      pageTitle: (id) => titleOf(this.store, id),
      personName: (id) => (id === "me" ? "Me" : id),
      personEmail: () => "",
      currentPage: row.id,
      now: this.now,
    };
  }

  private rollupValue(row: Block, p: PropertySchema, db: Database): Value {
    const cfg = p.rollup;
    const rel = cfg ? propertyById(db, cfg.relationPropertyID) : undefined;
    const target = rel?.relation ? this.store.databases.get(rel.relation.databaseID) : undefined;
    if (!cfg || !rel || !target) return EMPTY;
    const c = enumCase(row.values?.[rel.id]);
    if (!c || c[0] !== "relation") return QueryEngine.aggregate([], cfg.function, undefined);
    const tp = propertyById(target, cfg.targetPropertyID) ?? titleProperty(target);
    const values = (c[1] as string[]).map((id) => this.store.blocks.get(id)).filter((b): b is Block => !!b && !isTrashed(this.store, b.id))
      .map((b) => this.value(b, tp, target));
    return QueryEngine.aggregate(values, cfg.function, tp);
  }

  // MARK: Aggregation

  static aggregate(values: Value[], fn: string, _p: PropertySchema | undefined): Value {
    const flat = values.flatMap((v) => (v.t === "list" ? (v.v.length === 0 ? [EMPTY] : v.v) : [v]));
    const nonEmpty = values.filter((v) => !isEmptyValue(v));
    const total = values.length;
    const pct = (x: number) => num(total === 0 ? 0 : x / total);
    const nums = flat.flatMap((v) => (v.t === "number" ? [v.v] : []));
    const dates = flat.flatMap((v) => (v.t === "date" ? [v.v.start] : []));
    const bools = values.map((v) => v.t === "bool" && v.v);
    switch (fn) {
      case "showOriginal": return list(flat.filter((v) => !isEmptyValue(v)));
      case "countAll": return num(total);
      case "countValues": return num(flat.filter((v) => !isEmptyValue(v)).length);
      case "countUnique": return num(new Set(flat.filter((v) => !isEmptyValue(v)).map((v) => JSON.stringify(v))).size);
      case "countEmpty": return num(values.length - nonEmpty.length);
      case "countNotEmpty": return num(nonEmpty.length);
      case "percentEmpty": return pct(values.length - nonEmpty.length);
      case "percentNotEmpty": return pct(nonEmpty.length);
      case "sum": return num(nums.reduce((a, b) => a + b, 0));
      case "average": return nums.length ? num(nums.reduce((a, b) => a + b, 0) / nums.length) : EMPTY;
      case "median": {
        const s = [...nums].sort((a, b) => a - b);
        if (!s.length) return EMPTY;
        const h = Math.floor(s.length / 2);
        return num(s.length % 2 === 1 ? s[h]! : (s[h - 1]! + s[h]!) / 2);
      }
      case "min": return nums.length ? num(Math.min(...nums)) : EMPTY;
      case "max": return nums.length ? num(Math.max(...nums)) : EMPTY;
      case "range": return nums.length ? num(Math.max(...nums) - Math.min(...nums)) : EMPTY;
      case "earliest": return dates.length ? date({ start: Math.min(...dates), includeTime: false }) : EMPTY;
      case "latest": return dates.length ? date({ start: Math.max(...dates), includeTime: false }) : EMPTY;
      case "dateRange": return dates.length ? str(durationText(Math.max(...dates) - Math.min(...dates))) : EMPTY;
      case "checked": return num(bools.filter((b) => b).length);
      case "unchecked": return num(bools.filter((b) => !b).length);
      case "percentChecked": return pct(bools.filter((b) => b).length);
      case "percentUnchecked": return pct(bools.filter((b) => !b).length);
      default: return EMPTY; // none, unbekannt
    }
  }

  // MARK: Ansicht ausführen

  run(view: DatabaseView, search?: string | null): QueryResult {
    const db = this.store.databases.get(view.databaseID);
    if (!db) return { rows: [] };
    let rows = rowsOf(this.store, db.id).filter((r) => r.props?.isTemplate !== true);
    const filter = view.filter as unknown as FilterGroupWire | undefined;
    if (filter && filter.items.length > 0) rows = rows.filter((r) => this.matchesGroup(r, filter, db));
    const q = search?.replace(/^[ \t]+|[ \t]+$/g, "");
    if (q) rows = rows.filter((r) => this.matchesSearch(r, q, db));
    rows = this.sorted(rows, view.sorts ?? [], db);
    const result: QueryResult = { rows };
    const g = view.groupBy;
    const gp = g ? propertyById(db, g.propertyID) ?? (g.propertyID === titleProperty(db).id ? titleProperty(db) : undefined) : undefined;
    if (g && gp) result.groups = this.group(rows, g, gp, db);
    else if (view.type === "board") {
      const p = db.properties.find((x) => x.type === "status" || x.type === "select");
      if (p) result.groups = this.group(rows, { propertyID: p.id }, p, db);
    }
    return result;
  }

  private matchesSearch(row: Block, q: string, db: Database): boolean {
    if (containsCaseInsensitive(plainTextResolvingMentions(this.store, row.text), q)) return true;
    for (const p of db.properties) {
      if (p.type === "title") continue;
      const v = this.value(row, p, db);
      if (!isEmptyValue(v) && containsCaseInsensitive(cellText(this.store, v), q)) return true;
    }
    return false;
  }

  // MARK: Filter

  matchesGroup(row: Block, g: FilterGroupWire, db: Database): boolean {
    if (g.items.length === 0) return true;
    const results = g.items.map((item) => () => {
      const c = enumCase(item);
      if (c?.[0] === "condition") return this.matchesCondition(row, c[1] as FilterConditionWire, db);
      if (c?.[0] === "group") return this.matchesGroup(row, c[1] as FilterGroupWire, db);
      return true; // BSD-130: Filterart einer neueren Version blendet nichts aus
    });
    if (g.combinator === "and") return results.every((f) => f());
    if (g.combinator === "or") return results.some((f) => f());
    return true;
  }

  matchesCondition(row: Block, c: FilterConditionWire, db: Database): boolean {
    if (!KNOWN_FILTER_OPS.has(c.op)) return true; // BSD-107
    const p = propertyById(db, c.propertyID) ?? (c.propertyID === TITLE_PROPERTY_ID ? titleProperty(db) : undefined);
    if (!p) return true;
    const v = this.value(row, p, db);
    if (c.op === "isEmpty") return isEmptyValue(v);
    if (c.op === "isNotEmpty") return !isEmptyValue(v);
    const fv = enumCase(c.value);
    if (!fv || !["text", "number", "bool", "date", "relative", "options"].includes(fv[0])) return true; // unvollständig
    const stored = enumCase(row.values?.[p.id]);
    switch (p.type) {
      case "select": case "status": {
        const id = stored && (stored[0] === "select" || stored[0] === "status") ? (stored[1] as string) : undefined;
        const wanted = this.optionIDs(fv, p);
        if (wanted.size === 0) return true;
        const hit = id !== undefined && wanted.has(id);
        if (c.op === "equals" || c.op === "contains") return hit;
        if (c.op === "notEquals" || c.op === "notContains") return !hit;
        return true;
      }
      case "multiSelect": case "person": case "relation": case "files": case "createdBy": case "lastEditedBy": {
        let have: string[] = [];
        if (stored?.[0] === "multiSelect" || stored?.[0] === "person") have = stored[1] as string[];
        else if (stored?.[0] === "relation") have = liveRelationTargets(this.store, stored[1] as string[]);
        else if (stored?.[0] === "files") have = (stored[1] as { name: string }[]).map((f) => f.name);
        else if (p.type === "createdBy") have = row.createdBy !== undefined ? [row.createdBy] : [];
        else if (p.type === "lastEditedBy") have = row.updatedBy !== undefined ? [row.updatedBy] : [];
        const wanted = p.type === "multiSelect" ? this.optionIDs(fv, p) : rawStrings(fv);
        if (wanted.size === 0) return true;
        const hit = have.some((h) => wanted.has(h));
        if (c.op === "contains" || c.op === "equals") return hit;
        if (c.op === "notContains" || c.op === "notEquals") return !hit;
        return true;
      }
      case "checkbox": {
        const want = fv[0] === "bool" ? (fv[1] as boolean) : fv[0] === "text" ? fv[1] === "true" : true;
        return c.op === "notEquals" ? truthy(v) !== want : truthy(v) === want;
      }
      default: return this.compare(v, c.op, fv);
    }
  }

  private optionIDs(fv: [string, unknown], p: PropertySchema): Set<string> {
    if (fv[0] === "options") return new Set(fv[1] as string[]);
    if (fv[0] === "text") return new Set([optionByName(p, fv[1] as string)?.id ?? (fv[1] as string)]);
    return new Set();
  }

  private compare(v: Value, op: string, fv: [string, unknown]): boolean {
    switch (v.t) {
      case "date": {
        const bounds = this.dateBounds(fv);
        if (!bounds) return true;
        const [lo, hi] = bounds;
        const start = v.v.start, dayStart = startOfDay(start);
        switch (op) {
          case "equals": return dayStart >= lo && dayStart < hi;
          case "notEquals": return !(dayStart >= lo && dayStart < hi);
          case "before": case "less": return dayStart < lo;
          case "after": case "greater": return dayStart >= hi;
          case "onOrBefore": case "lessOrEqual": return dayStart < hi;
          case "onOrAfter": case "greaterOrEqual": return dayStart >= lo;
          case "within": return start >= lo && start < hi;
          default: return true;
        }
      }
      case "empty": return op === "notEquals" || op === "notContains";
      case "number": {
        const n = v.v;
        const t = fv[0] === "number" ? (fv[1] as number) : fv[0] === "text" ? parseSwiftDouble(fv[1] as string) : undefined;
        if (t === undefined) return true;
        switch (op) {
          case "equals": return n === t;
          case "notEquals": return n !== t;
          case "greater": return n > t;
          case "less": return n < t;
          case "greaterOrEqual": return n >= t;
          case "lessOrEqual": return n <= t;
          case "contains": return plainNumber(n).includes(plainNumber(t));
          default: return true;
        }
      }
      case "bool": {
        const want = fv[0] === "bool" ? (fv[1] as boolean) : fv[0] === "text" ? fv[1] === "true" : true;
        return op === "notEquals" ? v.v !== want : v.v === want;
      }
      default: {
        const s = cellText(this.store, v).toLowerCase();
        const t = fv[0] === "text" ? (fv[1] as string).toLowerCase() : fv[0] === "number" ? plainNumber(fv[1] as number) : "";
        if (!t) return true;
        switch (op) {
          case "equals": return s === t;
          case "notEquals": return s !== t;
          case "contains": return s.includes(t);
          case "notContains": return !s.includes(t);
          case "startsWith": return s.startsWith(t);
          case "endsWith": return s.endsWith(t);
          default: return true;
        }
      }
    }
  }

  /** [von, bis) für einen Datumsfilter. */
  private dateBounds(fv: [string, unknown]): [number, number] | undefined {
    const today = startOfDay(this.now);
    const day = (o: number) => addCalendar(today, "day", o);
    switch (fv[0]) {
      case "date": { const s = startOfDay(fv[1] as number); return [s, addCalendar(s, "day", 1)]; }
      case "relative":
        switch (fv[1]) {
          case "today": return [today, day(1)];
          case "tomorrow": return [day(1), day(2)];
          case "yesterday": return [day(-1), today];
          case "pastWeek": return [day(-7), day(1)];
          case "nextWeek": return [today, day(8)];
          case "pastMonth": return [addCalendar(today, "month", -1), day(1)];
          case "nextMonth": return [today, addCalendar(day(1), "month", 1)];
          case "pastYear": return [addCalendar(today, "year", -1), day(1)];
          case "nextYear": return [today, addCalendar(day(1), "year", 1)];
          default: return undefined; // BSD-130
        }
      case "text": {
        const d = parseDate(fv[1] as string);
        if (!d) return undefined;
        const s = startOfDay(d.start);
        return [s, addCalendar(s, "day", 1)];
      }
      default: return undefined;
    }
  }

  // MARK: Sortierung

  sorted(rows: Block[], sorts: { propertyID: string; ascending: boolean }[], db: Database): Block[] {
    if (sorts.length === 0) return rows;
    const props = sorts.flatMap((s) => {
      const p = propertyById(db, s.propertyID) ?? (s.propertyID === TITLE_PROPERTY_ID ? titleProperty(db) : undefined);
      return p ? [[s, p] as const] : [];
    });
    const keyed = rows.map((r, i) => ({ i, r, keys: props.map(([, p]) => this.sortKey(r, p, db)) }));
    keyed.sort((a, b) => {
      for (let k = 0; k < props.length; k++) {
        const x = a.keys[k]!, y = b.keys[k]!;
        const ex = isEmptyValue(x), ey = isEmptyValue(y);
        if (ex !== ey) return ex ? 1 : -1; // leere zuletzt
        if (ex) continue;
        const c = compareValues(x, y);
        if (c !== 0) return props[k]![0].ascending ? c : -c;
      }
      return a.i - b.i;
    });
    return keyed.map((k) => k.r);
  }

  /** Selects nach Options-Reihenfolge, wie in Notion. */
  private sortKey(row: Block, p: PropertySchema, db: Database): Value {
    const c = enumCase(row.values?.[p.id]);
    if ((p.type === "select" && c?.[0] === "select") || (p.type === "status" && c?.[0] === "status")) {
      const i = p.options?.findIndex((o) => o.id === c[1]) ?? -1;
      return i >= 0 ? num(i) : EMPTY;
    }
    if (p.type === "multiSelect" && c?.[0] === "multiSelect") {
      const idx = (c[1] as string[]).map((id) => p.options?.findIndex((o) => o.id === id) ?? -1).filter((i) => i >= 0).sort((a, b) => a - b);
      return list(idx.map(num));
    }
    if (p.type === "relation" && c?.[0] === "relation") return list((c[1] as string[]).map((id) => str(titleOf(this.store, id))));
    return this.value(row, p, db);
  }

  // MARK: Gruppen

  group(rows: Block[], rule: { propertyID: string; hiddenGroups?: string[] | undefined; hideEmptyGroups?: boolean | undefined; groupOrder?: string[] | undefined; dateGrouping?: string | undefined },
        p: PropertySchema, db: Database): RowGroup[] {
    const buckets = new Map<string, Block[]>();
    let order: [string, string, string | null][] = [];
    const seen = new Set<string>();
    const add = (k: string, r: Block) => { const l = buckets.get(k) ?? []; l.push(r); buckets.set(k, l); };
    switch (p.type) {
      case "select": case "status": case "multiSelect":
        for (const o of p.options ?? []) order.push([o.id, o.name, o.color]);
        for (const r of rows) {
          const c = enumCase(r.values?.[p.id]);
          if (c && (c[0] === "select" || c[0] === "status")) add(optionById(p, c[1] as string) ? (c[1] as string) : "", r);
          else if (c?.[0] === "multiSelect") {
            const valid = (c[1] as string[]).filter((id) => optionById(p, id));
            if (valid.length === 0) add("", r);
            else valid.forEach((id) => add(id, r));
          } else add("", r);
        }
        break;
      case "checkbox":
        order = [["true", "Checked", null], ["false", "Unchecked", null]];
        for (const r of rows) add(truthy(this.value(r, p, db)) ? "true" : "false", r);
        break;
      case "person": case "createdBy": case "lastEditedBy":
        for (const r of rows) {
          const people = asList(this.value(r, p, db)).flatMap((v) => (v.t === "person" ? [v.v] : []));
          if (people.length === 0) add("", r);
          for (const x of people) {
            if (!seen.has(x)) { seen.add(x); order.push([x, x === "me" ? "Me" : x, null]); }
            add(x, r);
          }
        }
        break;
      case "date": case "createdTime": case "lastEditedTime": {
        const keys: [string, string, number][] = [];
        for (const r of rows) {
          const v = this.value(r, p, db);
          if (v.t !== "date") { add("", r); continue; }
          const [k, title, sortDate] = this.dateBucket(v.v.start, rule.dateGrouping ?? "relative");
          if (!seen.has(k)) { seen.add(k); keys.push([k, title, sortDate]); }
          add(k, r);
        }
        order = keys.map((k, i) => [k, i] as const).sort((a, b) => a[0][2] - b[0][2] || a[1] - b[1]).map(([k]) => [k[0], k[1], null]);
        break;
      }
      default: {
        for (const r of rows) {
          const v = this.value(r, p, db);
          const text = cellText(this.store, v);
          if (isEmptyValue(v) || !text) { add("", r); continue; }
          if (!seen.has(text)) { seen.add(text); order.push([text, text, null]); }
          add(text, r);
        }
        order.sort((a, b) => localizedStandardCompare(a[1], b[1]));
      }
    }
    if (p.type !== "checkbox") order.unshift(["", `No ${p.name}`, null]);
    const custom = rule.groupOrder;
    if (custom && custom.length) {
      const idx = (k: string) => { const i = custom.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
      order = order.map((o, i) => [o, i] as const).sort((a, b) => idx(a[0][0]) - idx(b[0][0]) || a[1] - b[1]).map(([o]) => o);
    }
    const hidden = new Set(rule.hiddenGroups ?? []);
    const out: RowGroup[] = [];
    for (const [k, title, color] of order) {
      if (hidden.has(k)) continue;
      const rs = buckets.get(k) ?? [];
      if (rs.length === 0 && rule.hideEmptyGroups === true) continue;
      if (rs.length === 0 && k === "" && p.type !== "select" && p.type !== "status" && p.type !== "multiSelect") continue;
      out.push({ id: k, title, color, rows: rs });
    }
    return out;
  }

  private dateBucket(d: number, g: string): [string, string, number] {
    const day = startOfDay(d);
    const today = startOfDay(this.now);
    const isoDay = (x: number) => formatICU(x, "yyyy-MM-dd");
    const monthStart = (x: number) => { const j = toJSDate(x); return fromJSDate(new Date(j.getFullYear(), j.getMonth(), 1)); };
    switch (g) {
      case "day": return [isoDay(day), formatICU(day, "MMMM d, yyyy"), day];
      case "week": {
        const j = toJSDate(day);
        const back = (j.getDay() - this.weekStart + 7) % 7;
        const start = addCalendar(day, "day", -back);
        return ["w" + isoDay(start), "Week of " + formatICU(start, "MMMM d, yyyy"), start];
      }
      case "month": { const s = monthStart(d); return ["m" + isoDay(s), formatICU(s, "MMMM yyyy"), s]; }
      case "year": { const y = toJSDate(d).getFullYear(); return ["y" + y, String(y), fromJSDate(new Date(y, 0, 1))]; }
      default: {
        const diff = Math.round((toJSDate(day).getTime() - toJSDate(today).getTime()) / 86_400_000);
        if (diff === 0) return ["r0", "Today", today];
        if (diff === 1) return ["r1", "Tomorrow", day];
        if (diff === -1) return ["r-1", "Yesterday", day];
        if (diff >= 2 && diff <= 7) return ["r7", "Next 7 days", addCalendar(today, "day", 2)];
        if (diff >= -7 && diff <= -2) return ["r-7", "Last 7 days", addCalendar(today, "day", -7)];
        if (diff >= 8 && diff <= 30) return ["r30", "Next 30 days", addCalendar(today, "day", 8)];
        if (diff >= -30 && diff <= -8) return ["r-30", "Last 30 days", addCalendar(today, "day", -30)];
        const s = monthStart(d);
        return ["m" + isoDay(s), formatICU(s, "MMMM yyyy"), s];
      }
    }
  }
}

function rawStrings(fv: [string, unknown]): Set<string> {
  if (fv[0] === "options") return new Set(fv[1] as string[]);
  if (fv[0] === "text") return new Set([fv[1] as string]);
  return new Set();
}

/** Swift `localizedCaseInsensitiveContains` (Groß/klein egal, Akzente zählen). */
function containsCaseInsensitive(hay: string, needle: string): boolean {
  return hay.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/** Dauer für „Date range“ (Swift `durationText`). */
export function durationText(seconds: number): string {
  const days = Math.trunc(seconds / 86_400);
  if (days >= 365) { const n = Math.trunc(days / 365); return `${n} year${n === 1 ? "" : "s"}`; }
  if (days >= 30) { const n = Math.trunc(days / 30); return `${n} month${n === 1 ? "" : "s"}`; }
  if (days >= 7) { const n = Math.trunc(days / 7); return `${n} week${n === 1 ? "" : "s"}`; }
  return `${days} day${days === 1 ? "" : "s"}`;
}
