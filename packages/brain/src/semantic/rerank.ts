// BSD-231 Teil 3b: „Suche nach Bedeutung“ mit einem lokalen Embedding-Modell, ohne den ganzen Workspace einzubetten.
// Der TF-IDF-Index (LocalSemanticIndex) liefert Kandidaten, das Modell ordnet sie neu: Anfrage als „query“, jeder
// Abschnitt der Kandidaten als „passage“, Kosinus, bester Abschnitt je Seite. Abschnitte werden zwischengespeichert
// (gleicher Text = gleicher Vektor), damit die zweite Suche kaum noch rechnet.
import type { SemanticHit, TextEmbedder } from "./index.js";

/** Vektoren je Abschnittstext (älteste fliegen zuerst raus). */
export class EmbeddingCache {
  private readonly map = new Map<string, Float32Array>();
  constructor(readonly max = 4000, readonly model = "") {}
  get(text: string) {
    const v = this.map.get(text);
    if (v) { this.map.delete(text); this.map.set(text, v); }
    return v;
  }
  set(text: string, v: Float32Array) {
    this.map.delete(text);
    this.map.set(text, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  get size() { return this.map.size; }
}

export interface RerankCandidate { pageID: string; chunks: readonly string[] }

const cosine = (a: Float32Array, b: Float32Array) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

const snippetOf = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 159) + "…" : flat;
};

/** Kandidaten nach Bedeutung ordnen. Leere Anfrage → []. */
export async function rerankByMeaning(embedder: TextEmbedder, query: string, candidates: readonly RerankCandidate[], opts: { limit?: number; cache?: EmbeddingCache; signal?: AbortSignal } = {}): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q || candidates.length === 0) return [];
  const cache = opts.cache?.model === embedder.id ? opts.cache : undefined;
  const missing = [...new Set(candidates.flatMap((c) => c.chunks).filter((t) => t.trim() && !cache?.get(t)))];
  const fresh = new Map<string, Float32Array>();
  if (missing.length) {
    const vs = await embedder.embed(missing, opts.signal, "passage");
    missing.forEach((t, i) => { fresh.set(t, vs[i]!); cache?.set(t, vs[i]!); });
  }
  const [qv] = await embedder.embed([q], opts.signal, "query");
  const out: SemanticHit[] = [];
  for (const c of candidates) {
    let best: { score: number; text: string } | undefined;
    for (const t of c.chunks) {
      const v = fresh.get(t) ?? cache?.get(t);
      if (!v) continue;
      const s = cosine(qv!, v);
      if (!best || s > best.score) best = { score: s, text: t };
    }
    if (best) out.push({ pageID: c.pageID, score: best.score, snippet: snippetOf(best.text) });
  }
  return out.sort((a, b) => b.score - a.score || (a.pageID < b.pageID ? -1 : 1)).slice(0, opts.limit ?? 10);
}
