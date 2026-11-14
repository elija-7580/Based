// Feedback 14. 11.: Suche für kurze Listen (Slash-Menü, Seitenwahl) – einmal indexiert, tolerant. Treffer über Name,
// Suchwörter/Aliase und Synonyme, Wortanfänge, Abkürzungen („h2“, „tdo“ → To-do) und einen Tippfehler („haeding“).
// Rein, ohne DOM. Reihenfolge: bester Treffer zuerst, bei Gleichstand die Reihenfolge der Liste.

export interface FuzzyFields {
  /** Angezeigter Name (zählt am meisten). */
  label: string;
  /** Weitere Suchwörter: Aliase, Synonyme, Typ, Pfad … */
  terms?: readonly string[];
}

interface Entry<T> {
  item: T;
  order: number;
  label: string;
  labelWords: string[];
  /** Name ohne Leer- und Satzzeichen („todolist“) für Abkürzungen. */
  compact: string;
  terms: string[];
}

export interface FuzzyIndex<T> {
  readonly size: number;
  search(query: string, limit?: number): T[];
}

/** Kleinbuchstaben, ohne Akzente; Bindestriche und Satzzeichen trennen Wörter („To-do“ → „to do“). */
export function normalizeSearch(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const words = (s: string) => normalizeSearch(s).split(" ").filter(Boolean);

/** Höchstens ein Tippfehler (vertauscht, fehlend, zu viel, falsch) – nur für Wörter ab 4 Zeichen. */
function oneTypo(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Buchstaben von `q` der Reihe nach in `s`, der erste am Anfang („hd1“ in „heading1“). */
function subsequence(q: string, s: string): boolean {
  if (!q || q[0] !== s[0]) return false;
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++;
  return j === q.length;
}

/** Punkte eines Suchworts gegen einen Eintrag (0 = kein Treffer). */
function tokenScore(t: string, e: Entry<unknown>): number {
  if (e.labelWords.some((w) => w === t)) return 80;
  if (e.labelWords.some((w) => w.startsWith(t))) return 70;
  if (e.terms.some((w) => w === t)) return 60;
  if (e.terms.some((w) => w.startsWith(t))) return 50;
  if (t.length >= 2 && e.compact.startsWith(t)) return 45;
  if (t.length >= 4) {
    const near = (w: string) => oneTypo(t, w) || (w.length > t.length && oneTypo(t, w.slice(0, t.length)));
    if (e.labelWords.some(near)) return 35;
    if (e.terms.some(near)) return 25;
  }
  if (t.length >= 2 && subsequence(t, e.compact)) return 20;
  return 0;
}

export function createFuzzyIndex<T>(items: readonly T[], fields: (item: T) => FuzzyFields): FuzzyIndex<T> {
  const entries: Entry<T>[] = items.map((item, order) => {
    const f = fields(item);
    const label = normalizeSearch(f.label);
    const labelWords = label.split(" ").filter(Boolean);
    return { item, order, label, labelWords, compact: labelWords.join(""), terms: (f.terms ?? []).flatMap(words) };
  });
  return {
    size: entries.length,
    search(query: string, limit = Infinity): T[] {
      const q = normalizeSearch(query);
      if (!q) return entries.slice(0, limit).map((e) => e.item);
      const tokens = q.split(" ");
      const hits: { e: Entry<T>; score: number }[] = [];
      for (const e of entries) {
        let score = 0;
        for (const t of tokens) {
          const s = tokenScore(t, e);
          if (!s) { score = 0; break; }
          score += s;
        }
        if (!score) continue;
        if (e.label === q) score += 100;
        else if (e.label.startsWith(q)) score += 40;
        else if (e.compact.startsWith(q.replace(/ /g, ""))) score += 20;
        hits.push({ e, score });
      }
      hits.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
      return hits.slice(0, limit).map((h) => h.e.item);
    },
  };
}
