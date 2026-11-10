// BSD-155: Werte zwischen Zellen-Editoren und dem Speicherformat umwandeln (rein, ohne React).
import { plainText, pv, valueCase, values, type Block, type DateValue, type PropertySchema, type PropertyValue } from "@based/core";

const { fromJSDate, toJSDate } = values;

const pad = (n: number) => String(n).padStart(2, "0");

/** Swift-Datum → Wert für `<input type="date|datetime-local">` (lokale Zeit). */
export function toInputValue(seconds: number, includeTime: boolean): string {
  const d = toJSDate(seconds);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return includeTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** Wert eines Datums-Inputs → Swift-Datum (lokale Zeit); `undefined` bei leer/ungültig. */
export function fromInputValue(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) ? undefined : fromJSDate(d);
}

/** Zahl aus einer Eingabe („1,234.5“, „12 %“, „€ 3“); `undefined` wenn keine Zahl. */
export function parseNumberInput(s: string): number | undefined {
  const t = s.replace(/[\s,€$£¥₹₩₽₺%]|CHF|CN|R\$/g, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export const TEXT_LIKE = new Set(["title", "text", "url", "email", "phone", "place", "number"]);

/** Inhalt, mit dem ein Text-Editor startet. */
export function editText(row: Block, p: PropertySchema): string {
  if (p.type === "title") return plainText(row.text);
  const c = valueCase(row.values?.[p.id]);
  if (!c) return "";
  if (c[0] === "text") return plainText(c[1] as Block["text"]);
  if (c[0] === "number") return String(c[1]);
  if (c[0] === "place") {
    const raw = String(c[1]);
    try {
      const j = JSON.parse(raw) as { name?: string; address?: string };
      if (raw.trim().startsWith("{")) return j.address ?? j.name ?? raw;
    } catch { /* kein JSON */ }
    return raw;
  }
  return typeof c[1] === "string" ? c[1] : "";
}

/** Eingabe eines Text-Editors → gespeicherter Wert (`null` = leeren, `undefined` = ungültig, nichts tun). */
export function parseTextInput(type: string, s: string): PropertyValue | null | undefined {
  const t = type === "text" || type === "title" ? s : s.trim();
  if (t === "") return null;
  if (type === "number") {
    const n = parseNumberInput(t);
    return n === undefined ? undefined : pv("number", n);
  }
  return pv(type === "title" ? "text" : type, t);
}

/** Datum mit geänderter Start-/Endzeit, Zeit an/aus. */
export function withDate(d: DateValue | undefined, patch: { start?: number; end?: number | undefined; includeTime?: boolean }): DateValue {
  const base: DateValue = d ? { ...d } : { start: fromJSDate(new Date(new Date().setHours(0, 0, 0, 0))), includeTime: false };
  const next: DateValue = { ...base };
  if (patch.start !== undefined) next.start = patch.start;
  if (patch.includeTime !== undefined) next.includeTime = patch.includeTime;
  if ("end" in patch) {
    if (patch.end === undefined) delete next.end;
    else next.end = patch.end;
  }
  return next;
}

export const storedDate = (row: Block, p: PropertySchema): DateValue | undefined => {
  const c = valueCase(row.values?.[p.id]);
  return c?.[0] === "date" ? (c[1] as DateValue) : undefined;
};
export const storedIDs = (row: Block, p: PropertySchema, kind: string): string[] => {
  const c = valueCase(row.values?.[p.id]);
  return c?.[0] === kind && Array.isArray(c[1]) ? (c[1] as string[]) : [];
};
export const storedString = (row: Block, p: PropertySchema, kind: string): string | undefined => {
  const c = valueCase(row.values?.[p.id]);
  return c?.[0] === kind && typeof c[1] === "string" ? c[1] : undefined;
};
/** Eine Datei der Files-&-Media-Property: Link (`url`) oder hochgeladen (`asset`, wie Swift). */
export interface StoredFile { name: string; url?: string; asset?: { id: string; name: string; size?: number; mime?: string } }

export const storedFiles = (row: Block, p: PropertySchema): StoredFile[] => {
  const c = valueCase(row.values?.[p.id]);
  return c?.[0] === "files" && Array.isArray(c[1]) ? (c[1] as StoredFile[]) : [];
};

/** Ton (CSS-Klasse) für eine Options-Farbe; nur Token-Flächen, kein Marker (der bedeutet „Agent“). */
export function optionTone(color: string | null | undefined): string {
  switch ((color ?? "default").replace(/Background$/, "")) {
    case "blue": return "blue";
    case "green": return "green";
    case "red": return "red";
    case "orange": case "brown": case "yellow": return "orange";
    case "pink": case "purple": return "pink";
    default: return "gray";
  }
}

/**
 * Standard für den Agent-Strich: zuletzt von einem Agenten bearbeitet (`updatedBy` „agent…“ oder „based“).
 * Die Shell kann das mit `isAgentEdit` ersetzen (z. B. „seit dem letzten Blick geändert“).
 */
export function defaultIsAgentEdit(row: Block): boolean {
  const by = row.updatedBy?.toLowerCase();
  return by !== undefined && (by.startsWith("agent") || by === "based");
}

/** URL mit Schema (Links in Zellen). */
export const hrefOf = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : "https://" + u);
