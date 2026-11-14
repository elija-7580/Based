// BSD-382 (ADR 0016, E1): reine Text-Operationen auf Läufen (Text + Marks) für die Editor-Befehle. Kein Store, kein DOM.
// Offsets zählen UTF-16-Einheiten wie `RichText.length` (runs.ts). Erwähnungen und Formeln sind atomar: ein Schnitt
// mitten hinein wird auf ihren Rand geschoben, sie werden nie zerteilt.
import type { RichText } from "../../model/records.js";
import { isAtomic, normalize, PLAIN, runsLength, runsOf, slice, toRichText, type Marks, type Run } from "../../interop/runs.js";

export type { Marks, Run };
export { runsLength, runsOf, toRichText };

/** Ein Mark-Schlüssel, den die Formatleiste umschaltet. `color`/`link` tragen einen Wert. */
export type MarkKey = "b" | "i" | "u" | "s" | "c" | "color" | "link";

/** Bereich `[from, to)` auf 0…Länge begrenzt und sortiert. */
export function clampRange(len: number, from: number, to: number = from): [number, number] {
  const a = Math.max(0, Math.min(len, Math.floor(from)));
  const b = Math.max(0, Math.min(len, Math.floor(to)));
  return a <= b ? [a, b] : [b, a];
}

/** Grenze, die nicht in einem atomaren Lauf liegt (nach vorn oder hinten geschoben). */
export function snapOffset(runs: readonly Run[], offset: number, toward: "start" | "end" = "end"): number {
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.t.length;
    if (offset > pos && offset < end && isAtomic(r)) return toward === "start" ? pos : end;
    if (end >= offset) break;
    pos = end;
  }
  return offset;
}

/** Text links und rechts von `offset` (Marks bleiben auf beiden Seiten). */
export function splitRuns(runs: readonly Run[], offset: number): [Run[], Run[]] {
  const len = runsLength(runs as Run[]);
  const at = snapOffset(runs, Math.max(0, Math.min(len, offset)));
  return [slice(runs as Run[], 0, at), slice(runs as Run[], at, len)];
}

/** Zwei Texte hintereinander (Zusammenführen). */
export function concatRuns(a: readonly Run[], b: readonly Run[]): Run[] {
  return normalize([...a, ...b]);
}

/** Marks des Zeichens vor `offset` (beim Tippen übernommen); am Anfang die des ersten Zeichens. Links und Code-Marks
 * werden am Ende eines Laufs nicht fortgesetzt (wie in Notion: hinter einem Link tippt man normalen Text). */
export function marksAt(runs: readonly Run[], offset: number): Marks {
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.t.length;
    if (offset > pos && offset < end) return isAtomic(r) ? PLAIN : r.m;
    if (offset === end && offset > 0) return isAtomic(r) ? PLAIN : withoutSticky(r.m);
    pos = end;
  }
  const first = runs[0];
  return offset === 0 && first && !isAtomic(first) ? withoutSticky(first.m) : PLAIN;
}

function withoutSticky(m: Marks): Marks {
  if (m.link === undefined && !m.c) return m;
  const out: Marks = { ...m };
  delete out.link;
  delete out.c;
  return out;
}

/** Bereich begrenzt und an atomaren Läufen ausgerichtet (eine Schreibmarke in einer Erwähnung steht dahinter). */
export function snapRange(runs: readonly Run[], from: number, to: number = from): [number, number] {
  const [a, b] = clampRange(runsLength(runs as Run[]), from, to);
  if (a === b) {
    const x = snapOffset(runs, a, "end");
    return [x, x];
  }
  return [snapOffset(runs, a, "start"), snapOffset(runs, b, "end")];
}

/** `[from, to)` durch `insert` ersetzen. Ein String bekommt `marks` oder die Marks an der Einfügestelle. */
export function replaceRuns(runs: readonly Run[], from: number, to: number, insert: string | readonly Run[], marks?: Marks): Run[] {
  const len = runsLength(runs as Run[]);
  const [a, b] = snapRange(runs, from, to);
  const ins: Run[] = typeof insert === "string" ? (insert ? [{ t: insert, m: marks ?? marksAt(runs, a) }] : []) : insert.map((r) => ({ ...r }));
  return normalize([...slice(runs as Run[], 0, a), ...ins, ...slice(runs as Run[], b, len)]);
}

/**
 * BSD-407 Teil 3: Klartext-Bearbeitung auf formatierten Text übertragen (Tabellenzellen des Block-Editors bearbeiten
 * nur Klartext). Nur der geänderte Mittelteil wird ersetzt; Marks, Erwähnungen und Formeln davor und dahinter bleiben,
 * neu getippter Text übernimmt die Marks an der Stelle. Liegt die Änderung in einem atomaren Lauf, wird dieser ersetzt.
 */
export function editPlainText(runs: readonly Run[], next: string): Run[] {
  const old = runs.map((r) => r.t).join("");
  if (old === next) return runs.map((r) => ({ ...r }));
  let p = 0;
  while (p < old.length && p < next.length && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old.charCodeAt(old.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  const a = snapOffset(runs, p, "start");
  const b = snapOffset(runs, old.length - s, "end");
  const insert = next.slice(a, next.length - (old.length - b));
  return replaceRuns(runs, a, b, insert);
}

/** Hat jedes Zeichen in `[from, to)` den Mark? (Formatleiste: Knopf aktiv; Umschalten nimmt ihn dann weg.) */
export function hasMark(runs: readonly Run[], from: number, to: number, key: MarkKey, value?: string | boolean): boolean {
  if (from >= to) return false;
  let pos = 0, any = false;
  for (const r of runs) {
    const end = pos + r.t.length;
    if (end > from && pos < to) {
      if (isAtomic(r)) { pos = end; continue; }
      const v = r.m[key];
      if (v === undefined || v === false || (value !== undefined && value !== true && v !== value)) return false;
      any = true;
    }
    pos = end;
  }
  return any;
}

/**
 * Mark in `[from, to)` setzen (`value` = true/Farbe/URL) oder entfernen (`value` = undefined/false). Atomare Läufe
 * (Erwähnung, Formel) bekommen Farbe und Fett/Kursiv mit, aber nie einen Link oder Code.
 */
export function setMark(runs: readonly Run[], from: number, to: number, key: MarkKey, value: string | boolean | undefined): Run[] {
  const len = runsLength(runs as Run[]);
  const [a, b] = clampRange(len, from, to);
  if (a === b) return runs.map((r) => ({ ...r }));
  const apply = (r: Run): Run => {
    if (isAtomic(r) && (key === "link" || key === "c")) return r;
    const m: Marks = { ...r.m };
    if (value === undefined || value === false || (key === "color" && value === "default")) delete (m as Record<string, unknown>)[key];
    else (m as Record<string, unknown>)[key] = value;
    return { ...r, m };
  };
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.t.length;
    if (end <= a || pos >= b || isAtomic(r)) {
      out.push(end <= a || pos >= b ? { ...r } : apply(r));
    } else {
      const lo = Math.max(a, pos) - pos, hi = Math.min(b, end) - pos;
      if (lo > 0) out.push({ ...r, t: r.t.slice(0, lo) });
      out.push(apply({ ...r, t: r.t.slice(lo, hi) }));
      if (hi < r.t.length) out.push({ ...r, t: r.t.slice(hi) });
    }
    pos = end;
  }
  return normalize(out);
}

/** Mark umschalten wie ⌘B: ist er überall gesetzt, weg; sonst überall an. */
export function toggleMark(runs: readonly Run[], from: number, to: number, key: Exclude<MarkKey, "color" | "link">): Run[] {
  return setMark(runs, from, to, key, hasMark(runs, from, to, key) ? undefined : true);
}

/** Wire-Text eines Blocks aus Läufen; leer = `undefined` (das Feld fällt weg, wie Swift es schreibt). */
export function blockText(runs: readonly Run[]): RichText | undefined {
  const t = toRichText(normalize(runs as Run[]));
  return t === "" ? undefined : t;
}

/** Nur der Text, ohne Marks (Code-Blöcke tragen keine Formatierung). */
export function plainRuns(runs: readonly Run[]): Run[] {
  const t = runs.map((r) => r.t).join("");
  return t ? [{ t, m: PLAIN }] : [];
}
