// Text-Läufe zum Bearbeiten (Swift `RichText` / `TextRun` / `Marks`): normalisieren, schneiden, Wire-Form.
import type { RichText, TextRun } from "../model/records.js";

export type Marks = NonNullable<TextRun["m"]>;
export interface Run { t: string; m: Marks; mention?: unknown; eq?: string }

export const PLAIN: Marks = {};
const MARK_KEYS = ["b", "i", "u", "s", "c", "color", "link"] as const;

export const isPlain = (m: Marks) => MARK_KEYS.every((k) => m[k] === undefined || m[k] === false);
export const sameMarks = (a: Marks, b: Marks) => MARK_KEYS.every((k) => (a[k] || undefined) === (b[k] || undefined));
export const isAtomic = (r: Run) => r.mention !== undefined || r.eq !== undefined;
export const plain = (runs: Run[]) => runs.map((r) => r.t).join("");
/** Länge in UTF-16-Einheiten wie Swift `RichText.length`. */
export const runsLength = (runs: Run[]) => runs.reduce((n, r) => n + r.t.length, 0);

/** Leere Läufe weg, gleich formatierte Nachbarn zusammen (atomare nie). */
export function normalize(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.t) continue;
    const last = out[out.length - 1];
    if (last && !isAtomic(last) && !isAtomic(run) && sameMarks(last.m, run.m)) out[out.length - 1] = { ...last, t: last.t + run.t };
    else out.push({ ...run });
  }
  return out;
}

export function slice(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const run of runs) {
    const len = run.t.length;
    const lo = Math.max(from, pos), hi = Math.min(to, pos + len);
    if (lo < hi) out.push(isAtomic(run) ? run : { ...run, t: run.t.slice(lo - pos, hi - pos) });
    pos += len;
  }
  return normalize(out);
}

/** Wire-Form → Läufe. */
export function runsOf(t: RichText | undefined): Run[] {
  if (t === undefined) return [];
  if (typeof t === "string") return t ? [{ t, m: PLAIN }] : [];
  return normalize(t.map((r) => {
    const run: Run = { t: r.t ?? "", m: r.m ?? PLAIN };
    if (r.mention !== undefined) run.mention = r.mention;
    if (r.eq !== undefined) run.eq = r.eq;
    return run;
  }));
}

/** Läufe → Wire-Form (Swift `RichText.encode`). */
export function toRichText(runs: Run[]): RichText {
  if (runs.length === 0) return "";
  if (runs.length === 1 && isPlain(runs[0]!.m) && !isAtomic(runs[0]!)) return runs[0]!.t;
  return runs.map((r) => {
    const o: TextRun = { t: r.t };
    if (!isPlain(r.m)) {
      const m: Marks = {};
      for (const k of MARK_KEYS) {
        const v = r.m[k];
        if (v !== undefined && v !== false) (m as Record<string, unknown>)[k] = v;
      }
      o.m = m;
    }
    if (r.mention !== undefined) o.mention = r.mention as TextRun["mention"];
    if (r.eq !== undefined) o.eq = r.eq;
    return o;
  });
}
