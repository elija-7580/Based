// BSD-231 Teil 3a: Embeddings mit multilingual-e5-small hinter `TextEmbedder`. Rein: Tokenizer (UnigramTokenizer aus
// tokenizer.json) und Modell-Laufzeit (`OnnxRunner`, im Worker onnxruntime-web) werden hineingereicht; hier passiert
// nur, was das Modell verlangt: Präfix „query: “ bzw. „passage: “, Rahmen <s> … </s>, höchstens 512 Tokens,
// Auffüllen je Stapel, Mittelwert über die echten Tokens (attention_mask) und Länge 1 (Kosinus = Skalarprodukt).
import type { EmbedKind, TextEmbedder } from "../semantic/index.js";
import type { UnigramTokenizer } from "./unigram.js";

/** Eingaben eines Stapels (Zeilen × Spalten, int64 wie das ONNX-Modell). */
export interface OnnxFeeds {
  input_ids: BigInt64Array;
  attention_mask: BigInt64Array;
  token_type_ids: BigInt64Array;
  dims: readonly [number, number];
}

/** Modell-Laufzeit: gibt `last_hidden_state` zurück (Zeilen × Spalten × Breite, zeilenweise). */
export interface OnnxRunner {
  run(feeds: OnnxFeeds, signal?: AbortSignal): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

export interface E5Options {
  /** Modell-Kennung für `TextEmbedder.id` (Vektoren verschiedener Modelle sind nicht vergleichbar). */
  id?: string;
  maxTokens?: number;
  /** Texte je Modell-Aufruf (Standard 1, siehe Konstruktor). */
  batchSize?: number;
  padID?: number;
}

export class E5Embedder implements TextEmbedder {
  readonly id: string;
  private readonly maxTokens: number;
  private readonly batchSize: number;
  private readonly padID: number;

  constructor(private readonly tokenizer: UnigramTokenizer, private readonly runner: OnnxRunner, opts: E5Options = {}) {
    this.id = opts.id ?? "multilingual-e5-small";
    this.maxTokens = opts.maxTokens ?? 512;
    // Standard 1: das Modell ist dynamisch quantisiert (int8, Skala je Stapel) – mit Auffüllen ändern sich die Vektoren
    // leicht (gemessen 1 − cos ≈ 0,003). Einzeln ist derselbe Text immer derselbe Vektor (wichtig für den Cache).
    this.batchSize = Math.max(1, opts.batchSize ?? 1);
    this.padID = opts.padID ?? 1;
  }

  /** Abschnitte (Standard „passage“) oder Suchanfragen („query“) einbetten; Ergebnis hat Länge 1. */
  async embed(texts: readonly string[], signal?: AbortSignal, kind: EmbedKind = "passage"): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    // Ähnlich lange Texte zusammen (weniger Auffüllen), Reihenfolge bleibt im Ergebnis.
    const encoded = texts.map((t, i) => ({ i, ids: this.tokenizer.encode(`${kind}: ${t}`, { maxLength: this.maxTokens }).ids }));
    const order = [...encoded].sort((a, b) => a.ids.length - b.ids.length);
    for (let s = 0; s < order.length; s += this.batchSize) {
      signal?.throwIfAborted();
      const batch = order.slice(s, s + this.batchSize);
      const vectors = await this.runBatch(batch.map((b) => b.ids), signal);
      batch.forEach((b, k) => { out[b.i] = vectors[k]!; });
    }
    return out;
  }

  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    return this.embed([text], signal, "query").then((v) => v[0]!);
  }

  private async runBatch(rows: number[][], signal?: AbortSignal): Promise<Float32Array[]> {
    const n = rows.length;
    const len = Math.max(...rows.map((r) => r.length));
    const ids = new BigInt64Array(n * len).fill(BigInt(this.padID));
    const mask = new BigInt64Array(n * len);
    rows.forEach((r, i) => r.forEach((id, j) => { ids[i * len + j] = BigInt(id); mask[i * len + j] = 1n; }));
    const { data, dims } = await this.runner.run({ input_ids: ids, attention_mask: mask, token_type_ids: new BigInt64Array(n * len), dims: [n, len] }, signal);
    const width = dims[2] ?? data.length / (n * len);
    if (dims[0] !== n || dims[1] !== len || !Number.isInteger(width) || data.length !== n * len * width) throw new Error("Embedding model returned an unexpected shape");
    return rows.map((r, i) => {
      const v = new Float32Array(width);
      for (let j = 0; j < r.length; j++) {
        const at = (i * len + j) * width;
        for (let k = 0; k < width; k++) v[k] = v[k]! + data[at + k]!;
      }
      let norm = 0;
      for (let k = 0; k < width; k++) { const x = v[k]! / r.length; v[k] = x; norm += x * x; }
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < width; k++) v[k] = v[k]! / norm;
      return v;
    });
  }
}

/** Kosinus zweier Vektoren der Länge 1 (Skalarprodukt). */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
