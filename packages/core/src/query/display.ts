// BSD-155: Anzeige-Helfer für Datenbank-Ansichten, portiert aus BasedCore (CellFormatter.number,
// QueryEngine.calculation, CalculationType.options, Cells.format) und den Beschriftungen der Swift-App.
import type { Block, Database, PropertySchema } from "../model/records.js";
import { cellText, QueryEngine } from "./engine.js";
import { formatMoment, longDate, plainNumber, type DateValue, type Value } from "./value.js";

const CURRENCY: Record<string, string> = {
  dollar: "$", euro: "€", pound: "£", yen: "¥", franc: "CHF ", rupee: "₹", won: "₩", yuan: "CN¥", real: "R$", ruble: "₽", lira: "₺",
};

const en = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const decimal2 = en(0, 2), currency2 = en(2, 2), currency0 = en(0, 0);

/** Zahl im Format der Property (Swift `CellFormatter.number`, Locale en_US). */
export function formatNumber(n: number, format?: string): string {
  switch (format ?? "number") {
    case "number": return plainNumber(n);
    case "numberWithCommas": return decimal2.format(n);
    case "percent": return decimal2.format(n) + "%";
    default: {
      const sym = CURRENCY[format ?? ""] ?? "";
      const f = format === "yen" || format === "won" ? currency0 : currency2;
      return (n < 0 ? "-" : "") + sym + f.format(Math.abs(n));
    }
  }
}

/** Datum einer Zelle: eigenes Format der Property (Moment-Syntax) oder Notions lange Form. */
export function formatDateCell(d: DateValue, p: PropertySchema | undefined): string {
  const fmt = p?.dateFormat;
  if (!fmt) return longDate(d);
  let s = formatMoment(d.start, fmt);
  if (d.end !== undefined) s += " → " + formatMoment(d.end, fmt);
  return s;
}

/** Text einer berechneten Zelle (Formel, Rollup): Zahl im Format, Datum lang, sonst wie `cellText`. */
export function formatValue(engine: QueryEngine, v: Value, p: PropertySchema | undefined): string {
  switch (v.t) {
    case "number": return formatNumber(v.v, p?.numberFormat);
    case "date": return formatDateCell(v.v, p);
    case "bool": return v.v ? "✓" : "";
    default: return cellText(engine.store, v);
  }
}

const COUNTS = ["none", "countAll", "countValues", "countUnique", "countEmpty", "countNotEmpty", "percentEmpty", "percentNotEmpty"];

/** Berechnungen, die die Fußzeile für einen Property-Typ anbietet (Swift `CalculationType.options`). */
export function calculationOptions(type: string): string[] {
  switch (type) {
    case "number": case "formula": case "rollup": return [...COUNTS, "sum", "average", "median", "min", "max", "range"];
    case "date": case "createdTime": case "lastEditedTime": return [...COUNTS, "earliest", "latest", "dateRange"];
    case "checkbox": return ["none", "countAll", "checked", "unchecked", "percentChecked", "percentUnchecked"];
    default: return COUNTS;
  }
}

export const CALCULATION_LABELS: Record<string, string> = {
  none: "None", countAll: "Count all", countValues: "Count values", countUnique: "Count unique values", countEmpty: "Count empty",
  countNotEmpty: "Count not empty", percentEmpty: "Percent empty", percentNotEmpty: "Percent not empty", sum: "Sum", average: "Average",
  median: "Median", min: "Min", max: "Max", range: "Range", earliest: "Earliest date", latest: "Latest date", dateRange: "Date range",
  checked: "Checked", unchecked: "Unchecked", percentChecked: "Percent checked", percentUnchecked: "Percent unchecked", showOriginal: "Show original",
};

/** Ergebnis einer Spalten-Berechnung als Text (Swift `QueryEngine.calculation`); `undefined` bei „none“. */
export function calculationText(engine: QueryEngine, fn: string, p: PropertySchema, rows: Block[], db: Database): string | undefined {
  if (fn === "none" || !CALCULATION_LABELS[fn]) return undefined;
  const v = QueryEngine.aggregate(rows.map((r) => engine.value(r, p, db)), fn, p);
  if (v.t === "number") {
    if (fn.startsWith("percent")) return `${Math.round(v.v * 100)}%`;
    if (["sum", "average", "median", "min", "max", "range"].includes(fn)) return formatNumber(v.v, p.numberFormat);
  }
  if (v.t === "date") return longDate(v.v);
  return cellText(engine.store, v);
}

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  title: "Title", text: "Text", number: "Number", select: "Select", multiSelect: "Multi-select", status: "Status", date: "Date",
  person: "Person", files: "Files & media", checkbox: "Checkbox", url: "URL", email: "Email", phone: "Phone", formula: "Formula",
  relation: "Relation", rollup: "Rollup", createdTime: "Created time", createdBy: "Created by", lastEditedTime: "Last edited time",
  lastEditedBy: "Last edited by", button: "Button", uniqueID: "ID", place: "Place", verification: "Verification",
};
/** Typen, die man im Menü „Property hinzufügen“ / „Typ ändern“ anbietet (Reihenfolge wie Notion). */
export const ADDABLE_PROPERTY_TYPES = ["text", "number", "select", "multiSelect", "status", "date", "person", "files", "checkbox", "url", "email",
  "phone", "formula", "relation", "rollup", "createdTime", "createdBy", "lastEditedTime", "lastEditedBy", "button", "uniqueID", "place"];
/** Vom System berechnet oder gesetzt: nicht in der Zelle bearbeitbar. */
export const READ_ONLY_TYPES = new Set(["formula", "rollup", "createdTime", "createdBy", "lastEditedTime", "lastEditedBy", "uniqueID", "button", "verification"]);

export const NUMBER_FORMATS = ["number", "numberWithCommas", "percent", "dollar", "euro", "pound", "yen", "franc", "rupee", "won", "yuan", "real", "ruble", "lira"];
export const NUMBER_FORMAT_LABELS: Record<string, string> = {
  number: "Number", numberWithCommas: "Number with commas", percent: "Percent", dollar: "US dollar", euro: "Euro", pound: "Pound",
  yen: "Yen", franc: "Swiss franc", rupee: "Rupee", won: "Won", yuan: "Yuan", real: "Real", ruble: "Ruble", lira: "Lira",
};

export const FILTER_OP_LABELS: Record<string, string> = {
  equals: "is", notEquals: "is not", contains: "contains", notContains: "does not contain", startsWith: "starts with", endsWith: "ends with",
  isEmpty: "is empty", isNotEmpty: "is not empty", greater: ">", less: "<", greaterOrEqual: "≥", lessOrEqual: "≤", before: "is before",
  after: "is after", onOrBefore: "is on or before", onOrAfter: "is on or after", within: "is within",
};
export const RELATIVE_DATE_LABELS: Record<string, string> = {
  today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday", pastWeek: "Past week", nextWeek: "Next week", pastMonth: "Past month",
  nextMonth: "Next month", pastYear: "Past year", nextYear: "Next year",
};
