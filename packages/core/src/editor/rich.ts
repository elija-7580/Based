// ADR 0016 (Block-Editor, E1): Textoperationen auf RichText (Läufe mit Marks). Offsets in UTF-16 wie überall im Kern;
// Erwähnungen und Gleichungen sind atomare Läufe der Länge 1. Rein und ohne Store – die Befehle in commands.ts bauen
// darauf auf, der Editor rendert damit.
import type { RichText, TextRun } from "../model/records.js";

export type Marks = NonNullable<TextRun["m"]>;
export type MarkKey = "b" | "i" | "u" | "s" | "c" | "color" | "link";

export const isAtom = (r: TextRun): boolean => r.mention !== undefined || r.eq !== undefined;
export const runLength = (r: TextRun): number => (isAtom(r) ? 1 : (r.t ?? "").length);

/** Läufe als Kopie (String → ein Lauf ohne Marks, leer → keine Läufe). */
export function runsOf(rt: RichText | undefined): TextRun[] {
  if (rt === undefined) return [];
  if (typeof rt === "string") return rt ? [{ t: rt }] : [];
  return rt.map((r) => structuredClone(r));
}

export function richLength(rt: RichText | undefined): number {
  if (rt === undefined) return 0;
  if (typeof rt === "string") return rt.length;
  let n = 0;
  for (const r of rt) n += runLength(r);
  return n;
}

/** Marks ohne leere/falsche Einträge – für Vergleiche und zum Speichern. */
export function cleanMarks(m: Marks | undefined): Marks | undefined {
  if (!m) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === false || v === null || v === "" || (k === "color" && v === "default")) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? (out as Marks) : undefined;
}

export function sameMarks(a: Marks | undefined, b: Marks | undefined): boolean {
  const x = cleanMarks(a), y = cleanMarks(b);
  if (!x || !y) return !x && !y;
  const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
  if (kx.length !== ky.length) return false;
  return kx.every((k, i) => k === ky[i] && (x as Record<string, unknown>)[k] === (y as Record<string, unknown>)[k]);
}

/** Zusammenfassen: leere Läufe weg, benachbarte Textläufe mit gleichen Marks verbinden; ohne Marks → String. */
export function normalizeRich(runs: readonly TextRun[]): RichText {
  const out: TextRun[] = [];
  for (const r0 of runs) {
    const r = { ...r0 };
    const m = cleanMarks(r.m);
    if (m) r.m = m;
    else delete r.m;
    if (!isAtom(r) && !r.t) continue;
    const last = out[out.length - 1];
    if (last && !isAtom(last) && !isAtom(r) && sameMarks(last.m, r.m) && Object.keys(last).every((k) => k === "t" || k === "m") && Object.keys(r).every((k) => k === "t" || k === "m")) {
      last.t = (last.t ?? "") + (r.t ?? "");
      continue;
    }
    out.push(r);
  }
  if (out.length === 0) return "";
  if (out.length === 1 && !isAtom(out[0]!) && !out[0]!.m && Object.keys(out[0]!).every((k) => k === "t")) return out[0]!.t ?? "";
  return out;
}

/** Ausschnitt [from, to) als Läufe. */
export function richSlice(rt: RichText | undefined, from: number, to: number = Number.MAX_SAFE_INTEGER): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0;
  for (const r of runsOf(rt)) {
    const len = runLength(r);
    const a = Math.max(from, pos), b = Math.min(to, pos + len);
    if (b > a) {
      if (isAtom(r)) out.push(r);
      else out.push({ ...r, t: (r.t ?? "").slice(a - pos, b - pos) });
    }
    pos += len;
    if (pos >= to) break;
  }
  return out;
}

/** Bereich [from, to) durch `insert` ersetzen. */
export function richReplace(rt: RichText | undefined, from: number, to: number, insert: RichText | readonly TextRun[]): RichText {
  const len = richLength(rt);
  const a = Math.max(0, Math.min(from, len)), b = Math.max(a, Math.min(to, len));
  const mid = typeof insert === "string" ? (insert ? [{ t: insert }] : []) : runsOf(insert as RichText);
  return normalizeRich([...richSlice(rt, 0, a), ...mid, ...richSlice(rt, b)]);
}

export function richConcat(...parts: (RichText | undefined)[]): RichText {
  return normalizeRich(parts.flatMap((p) => runsOf(p)));
}

/** Marks an einer Cursorposition: vom Zeichen links davon (wie Notion), am Anfang vom ersten Zeichen. */
export function marksAt(rt: RichText | undefined, at: number): Marks | undefined {
  const runs = runsOf(rt);
  let pos = 0;
  let prev: TextRun | undefined;
  for (const r of runs) {
    const len = runLength(r);
    if (at > pos && at <= pos + len) return isAtom(r) ? undefined : cleanMarks(r.m);
    if (at === 0 && pos === 0) return isAtom(r) ? undefined : cleanMarks(r.m);
    prev = r;
    pos += len;
  }
  return prev && !isAtom(prev) ? cleanMarks(prev.m) : undefined;
}

/** Marks für neu getippten Text: wie links davon, aber Links und Code wachsen nicht am Ende weiter (wie Notion). */
export function typingMarks(rt: RichText | undefined, at: number): Marks | undefined {
  const m = marksAt(rt, at);
  if (!m) return undefined;
  const runs = runsOf(rt);
  // Am Ende eines Laufs mit Link: Link nicht übernehmen
  let pos = 0;
  for (const r of runs) {
    pos += runLength(r);
    if (pos === at) {
      const out: Record<string, unknown> = { ...m };
      delete out.link;
      return cleanMarks(out as Marks);
    }
    if (pos > at) break;
  }
  return m;
}

/** Text einfügen (ersetzt [from, to)); Marks wie beim Tippen, wenn keine angegeben. */
export function richInsertText(rt: RichText | undefined, from: number, to: number, text: string, marks?: Marks | null): RichText {
  const m = marks === null ? undefined : marks ?? typingMarks(rt, from);
  const run: TextRun = { t: text };
  if (cleanMarks(m)) run.m = cleanMarks(m)!;
  return richReplace(rt, from, to, text ? [run] : []);
}

/** Hat jedes Zeichen in [from, to) die Mark? (leerer Bereich: Mark am Cursor) */
export function markActive(rt: RichText | undefined, from: number, to: number, key: MarkKey): boolean {
  if (from >= to) return Boolean((marksAt(rt, from) as Record<string, unknown> | undefined)?.[key]);
  const runs = richSlice(rt, from, to);
  return runs.length > 0 && runs.every((r) => isAtom(r) || Boolean((r.m as Record<string, unknown> | undefined)?.[key]));
}

/** Mark in [from, to) setzen (`value`) oder entfernen (`undefined`/`false`). */
export function richSetMark(rt: RichText | undefined, from: number, to: number, key: MarkKey, value: unknown): RichText {
  if (from >= to) return typeof rt === "string" || rt === undefined ? (rt ?? "") : normalizeRich(rt);
  const mid = richSlice(rt, from, to).map((r) => {
    if (isAtom(r)) return r;
    const m: Record<string, unknown> = { ...(r.m ?? {}) };
    if (value === undefined || value === false) delete m[key];
    else m[key] = value;
    const out: TextRun = { ...r };
    const cm = cleanMarks(m as Marks);
    if (cm) out.m = cm;
    else delete out.m;
    return out;
  });
  return richReplace(rt, from, to, mid);
}

/** Mark umschalten wie ⌘B: alle haben sie → entfernen, sonst setzen. */
export function richToggleMark(rt: RichText | undefined, from: number, to: number, key: MarkKey, value: unknown = true): RichText {
  return richSetMark(rt, from, to, key, markActive(rt, from, to, key) ? undefined : value);
}

/** Reiner Text mit U+FFFC für atomare Läufe (Offsets passen zum RichText). */
export function richPlain(rt: RichText | undefined): string {
  if (rt === undefined) return "";
  if (typeof rt === "string") return rt;
  return rt.map((r) => (isAtom(r) ? "￼" : r.t ?? "")).join("");
}
