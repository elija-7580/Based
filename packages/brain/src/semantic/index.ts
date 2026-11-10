// BSD-163 / BSD-62: lokaler Index für „Suche nach Bedeutung“ und „Verwandte Seiten“. Seiten werden in Abschnitte
// (~800 Zeichen entlang der Blöcke) geteilt. Standard-Backend: TF-IDF-Vektoren (gestemmt, Stoppwörter weg,
// Kosinus) – deterministisch, ohne Modell, ohne Netz. Ein lokales Embedding-Modell (`TextEmbedder`) kann die
// Vektoren ersetzen, sobald es eines gibt, das ohne Laufzeit-Download auskommt (Produktfrage, siehe Bericht).
import { termCounts, tokenize } from "./text.js";

/** Austauschbares lokales Embedding-Modell (gleiche Schnittstelle für Router und Suche). */
export interface TextEmbedder {
  /** Name des Modells: Vektoren verschiedener Modelle sind nicht vergleichbar. */
  readonly id: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface SemanticHit {
  pageID: string;
  score: number;
  snippet: string;
}

interface Chunk {
  pageID: string;
  text: string;
  tf: Map<string, number>;
}

export const SECTION_CHARS = 800;

/** Texte (je Block) zu Abschnitten von etwa `max` Zeichen zusammenfassen. */
export function chunkTexts(texts: readonly string[], max = SECTION_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const t of texts) {
    const s = t.trim();
    if (!s) continue;
    if (cur && cur.length + s.length > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n" + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

export class LocalSemanticIndex {
  private pages = new Map<string, Chunk[]>();
  private titles = new Map<string, string>();
  private df = new Map<string, number>();
  private chunkCount = 0;

  get size() {
    return this.pages.size;
  }

  has(pageID: string) {
    return this.pages.has(pageID);
  }

  /** Eine Seite (neu) aufnehmen: Titel zählt im ersten Abschnitt mit. */
  setPage(pageID: string, title: string, sections: readonly string[]) {
    this.removePage(pageID);
    const texts = sections.length > 0 ? sections : [""];
    const chunks = texts.map((text, i) => {
      const tf = termCounts(tokenize((i === 0 ? title + " " + title + "\n" : "") + text));
      return { pageID, text, tf };
    }).filter((c) => c.tf.size > 0);
    if (chunks.length === 0) return;
    this.pages.set(pageID, chunks);
    this.titles.set(pageID, title);
    for (const c of chunks) for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.chunkCount += chunks.length;
  }

  removePage(pageID: string) {
    const old = this.pages.get(pageID);
    if (!old) return;
    for (const c of old) {
      for (const t of c.tf.keys()) {
        const n = (this.df.get(t) ?? 1) - 1;
        if (n <= 0) this.df.delete(t);
        else this.df.set(t, n);
      }
    }
    this.chunkCount -= old.length;
    this.pages.delete(pageID);
    this.titles.delete(pageID);
  }

  private idf(t: string) {
    return Math.log(1 + this.chunkCount / (1 + (this.df.get(t) ?? 0)));
  }

  /** Gewichteter, normierter Vektor (sublineare TF × IDF). */
  private vector(tf: ReadonlyMap<string, number>): Map<string, number> {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, f] of tf) {
      const w = (1 + Math.log(f)) * this.idf(t);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  }

  private static dot(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
    const [s, l] = a.size < b.size ? [a, b] : [b, a];
    let d = 0;
    for (const [t, w] of s) {
      const x = l.get(t);
      if (x) d += w * x;
    }
    return d;
  }

  /** Seiten nach Bedeutung (bester Abschnitt je Seite). */
  search(query: string, limit = 10, exclude?: ReadonlySet<string>): SemanticHit[] {
    const q = tokenize(query);
    if (q.length === 0) return [];
    const qv = this.vector(termCounts(q));
    const best = new Map<string, SemanticHit>();
    for (const [pageID, chunks] of this.pages) {
      if (exclude?.has(pageID)) continue;
      for (const c of chunks) {
        const s = LocalSemanticIndex.dot(qv, this.vector(c.tf));
        if (s <= 0) continue;
        const cur = best.get(pageID);
        if (!cur || s > cur.score) best.set(pageID, { pageID, score: s, snippet: snippetOf(c.text) });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.pageID < b.pageID ? -1 : 1)).slice(0, limit);
  }

  /** Verwandte Seiten: Ähnlichkeit des ganzen Seitenvektors (ohne die Seite selbst). */
  related(pageID: string, limit = 5, minScore = 0.05): SemanticHit[] {
    const chunks = this.pages.get(pageID);
    if (!chunks) return [];
    const merged = new Map<string, number>();
    for (const c of chunks) for (const [t, f] of c.tf) merged.set(t, (merged.get(t) ?? 0) + f);
    const pv = this.vector(merged);
    const out: SemanticHit[] = [];
    for (const [other, cs] of this.pages) {
      if (other === pageID) continue;
      const m = new Map<string, number>();
      for (const c of cs) for (const [t, f] of c.tf) m.set(t, (m.get(t) ?? 0) + f);
      const s = LocalSemanticIndex.dot(pv, this.vector(m));
      if (s >= minScore) out.push({ pageID: other, score: s, snippet: snippetOf(cs[0]!.text) });
    }
    return out.sort((a, b) => b.score - a.score || (a.pageID < b.pageID ? -1 : 1)).slice(0, limit);
  }
}

const snippetOf = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 159) + "…" : flat;
};
