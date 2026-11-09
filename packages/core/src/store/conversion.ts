// Typwechsel einer Datenbank-Property ohne stillen Datenverlust (BSD-18, BSD-122), portiert aus
// BasedCore Store/DatabaseOps.swift (propertyConversion, conversionLoss, PropertyValue.plainString).
// Verifiziert über fixtures/conversion/conversion.utc.json (BSD-174).
import type { PropertySchema, PropertyValue, RichText } from "../model/records.js";
import { formatICU, parseDate, plainNumber, parseSwiftDouble, type DateValue } from "../query/value.js";
import { placeDisplay, richPlain, titleOf } from "../query/engine.js";
import type { WorkspaceStore } from "./store.js";

const TEXT_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const CHECKBOX_TRUE = new Set(["true", "yes", "1", "checked", "x", "✓"]);
const CHECKBOX_FALSE = new Set(["false", "no", "0", "unchecked", ""]);
const OPTION_TYPES = new Set(["select", "multiSelect", "status"]);

type Case = [string, unknown];
function caseOf(v: PropertyValue | undefined): Case | undefined {
  if (!v || typeof v !== "object") return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  const inner = (v as Record<string, unknown>)[keys[0]!];
  return [keys[0]!, inner && typeof inner === "object" && "_0" in inner ? (inner as { _0: unknown })._0 : undefined];
}
const make = (name: string, value: unknown) => ({ [name]: { _0: value } }) as PropertyValue;

export const newID = () => globalThis.crypto.randomUUID().toLowerCase();

const optionName = (p: PropertySchema | undefined, id: string) => p?.options?.find((o) => o.id === id)?.name;

/** Swift `DateParsing.format`. */
export function formatDateValue(d: DateValue): string {
  const f = d.includeTime ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd";
  let s = formatICU(d.start, f);
  if (d.end !== undefined) s += " → " + formatICU(d.end, f);
  return s;
}

/** Einfache Textform eines Werts (Umwandlung, Suche, CSV). */
export function plainString(v: PropertyValue, p: PropertySchema | undefined): string {
  const c = caseOf(v);
  if (!c) return "";
  const [k, x] = c;
  switch (k) {
    case "text": return richPlain(x as RichText);
    case "number": return plainNumber(x as number);
    case "select": case "status": return optionName(p, x as string) ?? "";
    case "multiSelect": return (x as string[]).flatMap((id) => optionName(p, id) ?? []).join(", ");
    case "date": return formatDateValue(x as DateValue);
    case "person": return (x as string[]).join(", ");
    case "files": return (x as { name: string; url?: string }[]).map((f) => f.url ?? f.name).join(", ");
    case "checkbox": return x ? "Yes" : "No";
    case "url": case "email": case "phone": return x as string;
    case "place": return placeDisplay(x as string);
    case "relation": return (x as string[]).join(", ");
    case "uniqueID": return (p?.idPrefix !== undefined ? p.idPrefix + "-" : "") + String(x);
    default: return "";
  }
}

function optionNames(v: PropertyValue, p: PropertySchema): string[] {
  const c = caseOf(v);
  if (c && (c[0] === "select" || c[0] === "status")) return [optionName(p, c[1] as string) ?? ""];
  if (c && c[0] === "multiSelect") return (c[1] as string[]).flatMap((id) => optionName(p, id) ?? []);
  return plainString(v, p).split(",").map((s) => s.trim());
}

const isBlank = (v: PropertyValue, p: PropertySchema | undefined) => caseOf(v)?.[0] !== "checkbox" && plainString(v, p) === "";

export interface ConversionPlan {
  schema: PropertySchema;
  /** Neue Werte je Zeile (auch im Papierkorb); `null` = Wert entfällt. */
  values: Map<string, PropertyValue | null>;
}

/** Neues Schema und umgewandelte Werte für einen Typwechsel (schreibt nichts). */
export function propertyConversion(store: WorkspaceStore, databaseID: string, propertyID: string, type: string, id: () => string = newID): ConversionPlan | undefined {
  const db = store.databases.get(databaseID);
  const old = db?.properties.find((p) => p.id === propertyID);
  if (!db || !old || old.type === type || old.type === "title" || type === "title") return undefined;
  const wasOptions = OPTION_TYPES.has(old.type), isOptions = OPTION_TYPES.has(type);
  const schema: PropertySchema = structuredClone(old);
  schema.type = type;
  let options = wasOptions && isOptions ? structuredClone(old.options ?? []) : [];
  let statusGroups: NonNullable<PropertySchema["statusGroups"]> = [];
  if (type === "status" && old.type !== "status") {
    if (options.length === 0) {
      const a = { id: id(), name: "Not started", color: "default" }, b = { id: id(), name: "In progress", color: "blue" }, c = { id: id(), name: "Done", color: "green" };
      options = [a, b, c];
      statusGroups = [
        { id: id(), name: "To-do", color: "gray", optionIDs: [a.id] },
        { id: id(), name: "In progress", color: "blue", optionIDs: [b.id] },
        { id: id(), name: "Complete", color: "green", optionIDs: [c.id] },
      ];
    } else {
      statusGroups = [
        { id: id(), name: "To-do", color: "gray", optionIDs: options.map((o) => o.id) },
        { id: id(), name: "In progress", color: "blue", optionIDs: [] },
        { id: id(), name: "Complete", color: "green", optionIDs: [] },
      ];
    }
  }
  const newOptionIDs: string[] = [];
  const converted = new Map<string, PropertyValue | null>();
  for (const rid of store.children("d:" + databaseID)) {
    const r = store.blocks.get(rid);
    const v = r?.values?.[propertyID];
    if (!r || v === undefined) continue;
    let names = optionNames(v, old);
    let text = plainString(v, old);
    const c = caseOf(v);
    if (c?.[0] === "relation") {
      const titles = (c[1] as string[]).filter((x) => store.blocks.has(x)).map((x) => titleOf(store, x));
      names = titles;
      text = titles.join(", ");
    }
    let nv: PropertyValue | null = null;
    switch (type) {
      case "text": nv = text ? make("text", text) : null; break;
      case "number": { const n = parseSwiftDouble(text.replaceAll(",", "")); nv = n === undefined ? null : make("number", n); break; }
      case "checkbox": nv = make("checkbox", CHECKBOX_TRUE.has(text.toLowerCase())); break;
      case "url": case "email": case "phone": case "place": nv = text ? make(type, text) : null; break;
      case "date": { const d = parseDate(text); nv = d ? make("date", d) : null; break; }
      case "select": case "multiSelect": case "status": {
        const ids: string[] = [];
        for (const name of names) {
          if (!name) continue;
          const o = options.find((x) => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
          if (o) {
            if (!ids.includes(o.id)) ids.push(o.id);
          } else {
            const n = { id: id(), name, color: TEXT_COLORS[(options.length + 1) % TEXT_COLORS.length]! };
            options.push(n);
            ids.push(n.id);
            newOptionIDs.push(n.id);
          }
        }
        if (type === "multiSelect") nv = ids.length ? make("multiSelect", ids) : null;
        else nv = ids.length ? make(type, ids[0]) : null;
        break;
      }
      case "person": case "files": case "relation": nv = c?.[0] === type ? v : null; break;
      default: nv = null;
    }
    converted.set(r.id, nv);
  }
  if (type === "select" || type === "multiSelect") {
    schema.options = options;
    delete schema.statusGroups;
  } else if (type === "status") {
    if (old.type !== "status") {
      if (statusGroups.length) statusGroups[0]!.optionIDs.push(...newOptionIDs);
      schema.options = options;
      schema.statusGroups = statusGroups;
    }
  } else {
    delete schema.options;
    delete schema.statusGroups;
  }
  if (type === "formula" && schema.formula === undefined) schema.formula = "";
  if (type === "relation" && schema.relation === undefined) schema.relation = { databaseID };
  if (type !== "relation") delete schema.relation;
  return { schema, values: converted };
}

function conversionLoses(v: PropertyValue, old: PropertySchema, nv: PropertyValue | null, type: string): boolean {
  if (nv === null) return true;
  const a = caseOf(v), b = caseOf(nv);
  if ((a?.[0] === "multiSelect" || a?.[0] === "relation") && (b?.[0] === "select" || b?.[0] === "status")) return (a[1] as string[]).length > 1;
  if (type === "checkbox") {
    if (a?.[0] === "checkbox") return false;
    const t = plainString(v, old).toLowerCase();
    return !CHECKBOX_TRUE.has(t) && !CHECKBOX_FALSE.has(t);
  }
  return false;
}

/** Wie viele Zellen beim Typwechsel (teilweise) verloren gingen; die UI fragt dann vorher nach. */
export function conversionLoss(store: WorkspaceStore, databaseID: string, propertyID: string, type: string): number {
  const old = store.databases.get(databaseID)?.properties.find((p) => p.id === propertyID);
  const plan = propertyConversion(store, databaseID, propertyID, type);
  if (!old || !plan) return 0;
  let cells = 0;
  for (const rid of store.children("d:" + databaseID)) {
    const r = store.blocks.get(rid);
    if (!r || r.trashedAt !== undefined) continue;
    const v = r.values?.[propertyID];
    if (v === undefined || isBlank(v, old)) continue;
    if (conversionLoses(v, old, plan.values.get(r.id) ?? null, type)) cells += 1;
  }
  return cells;
}
