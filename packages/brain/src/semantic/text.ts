// Gemeinsame Textzerlegung für den lokalen Skill-Router und den semantischen Index (BSD-198, BSD-163): klein,
// Akzente/Umlaute gefaltet, Stoppwörter DE/EN weg, leichte Stammform. Deterministisch, ohne Modell, ohne Netz.

const STOP = new Set(
  (
    "a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our please so " +
    "that the their them then there these they this to us was we were what when where which who why will with would you your " +
    "about all also any just like make need some than want get let new " +
    "aber alle als also am an auch auf aus bei bin bis bitte da das dass dem den der des die doch du ein eine einen einem einer " +
    "es fur hat habe haben ich ihr im in ist ja kann konnen mal man mein meine mich mir mit nach nicht noch nur oder sein sich sie " +
    "sind so uber um und uns von vor war was weil wenn wer wie wir wird zu zum zur"
  ).split(" "),
);

/** Kleinschreibung und Akzente weg (ä→a, ß→ss), damit „Übersicht“ und „ubersicht“ gleich sind. */
export function foldText(s: string): string {
  return s.toLowerCase().replaceAll("ß", "ss").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

const SUFFIXES = ["ungen", "ung", "ings", "ing", "heit", "keit", "lich", "ies", "ers", "ern", "en", "er", "es", "ed", "ly", "e", "s"];

/** Sehr leichte Stammform (reicht für Wortvarianten wie review/reviews, Notiz/Notizen). */
export function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  for (const s of SUFFIXES) if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length);
  return w;
}

/** Wörter eines Texts als Terme (ohne Stoppwörter, gestemmt). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of foldText(s).matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function termCounts(terms: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Abschnitte eines Markdown-Texts entlang der Überschriften (je höchstens `max` Zeichen). */
export function markdownSections(md: string, max = 800): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const line of md.split("\n")) {
    if (/^#{1,6}\s/.test(line)) flush();
    if (cur.length + line.length > max) flush();
    cur += line + "\n";
  }
  flush();
  return out;
}

/** BM25 über eine feste Menge von Dokumenten (Terme je Dokument). */
export class BM25 {
  readonly k1 = 1.2;
  readonly b = 0.75;
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(private readonly docs: readonly (readonly string[])[]) {
    let total = 0;
    for (const d of docs) {
      total += d.length;
      for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = docs.length > 0 ? Math.max(1, total / docs.length) : 1;
  }

  idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Wert eines Textes (Terme) für die Anfrage, mit der IDF dieses Korpus. */
  score(query: readonly string[], doc: readonly string[]): number {
    if (doc.length === 0) return 0;
    const tf = termCounts(doc);
    let s = 0;
    for (const q of new Set(query)) {
      const f = tf.get(q);
      if (!f) continue;
      s += this.idf(q) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / this.avgLen));
    }
    return s;
  }
}
