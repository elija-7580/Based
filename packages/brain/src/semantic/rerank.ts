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

/** Vektoren für Texte, aus dem Cache oder neu (ein Aufruf für alle fehlenden). */
async function vectorsOf(embedder: TextEmbedder, texts: readonly string[], cache: EmbeddingCache | undefined, signal?: AbortSignal): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: string[] = [];
  for (const t of new Set(texts)) {
    if (!t.trim()) continue;
    const v = cache?.get(t);
    if (v) out.set(t, v); else missing.push(t);
  }
  if (missing.length) {
    const vs = await embedder.embed(missing, signal, "passage");
    missing.forEach((t, i) => { out.set(t, vs[i]!); cache?.set(t, vs[i]!); });
  }
  return out;
}

/**
 * BSD-231 Teil 3b: verwandte Seiten nach Bedeutung – Mittel der Abschnittsvektoren der Seite gegen den besten Abschnitt
 * jedes Kandidaten (Kandidaten aus TF-IDF). Ohne Text auf der Seite → [].
 */
export async function relatedByMeaning(embedder: TextEmbedder, pageChunks: readonly string[], candidates: readonly RerankCandidate[], opts: { limit?: number; cache?: EmbeddingCache; signal?: AbortSignal; minScore?: number } = {}): Promise<SemanticHit[]> {
  const cache = opts.cache?.model === embedder.id ? opts.cache : undefined;
  const vs = await vectorsOf(embedder, [...pageChunks, ...candidates.flatMap((c) => c.chunks)], cache, opts.signal);
  const own = pageChunks.map((t) => vs.get(t)).filter((v): v is Float32Array => v !== undefined);
  if (own.length === 0) return [];
  const mean = new Float32Array(own[0]!.length);
  for (const v of own) for (let i = 0; i < v.length; i++) mean[i] = mean[i]! + v[i]!;
  const out: SemanticHit[] = [];
  for (const c of candidates) {
    let best: { score: number; text: string } | undefined;
    for (const t of c.chunks) {
      const v = vs.get(t);
      if (!v) continue;
      const s = cosine(mean, v);
      if (!best || s > best.score) best = { score: s, text: t };
    }
    if (best && best.score >= (opts.minScore ?? 0)) out.push({ pageID: c.pageID, score: best.score, snippet: snippetOf(best.text) });
  }
  return out.sort((a, b) => b.score - a.score || (a.pageID < b.pageID ? -1 : 1)).slice(0, opts.limit ?? 5);
}
