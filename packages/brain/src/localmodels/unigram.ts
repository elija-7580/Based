// BSD-231 Teil 3a: Tokenizer für lokale Embedding-Modelle (SentencePiece-Unigram im Format `tokenizer.json` von
// Hugging Face, z. B. multilingual-e5-small / XLM-R). Nachgebaut nach dem öffentlichen Format und dem Verhalten der
// Bibliothek `tokenizers` (Apache-2.0): Normalisierung über die vorkompilierte Zeichentabelle (Darts-Doppelarray),
// danach mehrfache Leerzeichen zu einem, Metaspace („▁“) mit Präfix, Viterbi über die Vokabel-Bewertungen,
// aufeinanderfolgende Unbekannte zusammengefasst, Rahmen <s> … </s>. Geprüft gegen `tokenizers` 0.23 (Test mit
// Referenz-IDs). Rein: bekommt den JSON-Text, kein Netz, kein Dateisystem.
import { graphemes } from "@based/core";

interface TokenizerJSON {
  added_tokens?: { id: number; content: string; special?: boolean }[];
  normalizer?: NormalizerJSON | null;
  pre_tokenizer?: { type: string; replacement?: string; add_prefix_space?: boolean; prepend_scheme?: string } | null;
  post_processor?: { type: string; single?: unknown[] } | null;
  model: { type: string; unk_id?: number | null; vocab: [string, number][]; byte_fallback?: boolean };
}

type NormalizerJSON =
  | { type: "Sequence"; normalizers: NormalizerJSON[] }
  | { type: "Precompiled"; precompiled_charsmap: string }
  | { type: "Replace"; pattern: { Regex?: string; String?: string }; content: string }
  | { type: "NFKC" | "NFC" | "NFD" | "NFKD" | "Lowercase" | "Strip" };

const UNK_PENALTY = 10;

function base64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** SentencePiece-Zeichentabelle (`precompiled_charsmap`): Doppelarray-Trie über UTF-8 plus Ersatztexte. */
export class PrecompiledCharsmap {
  private readonly units: Uint32Array;
  private readonly normalized: Uint8Array;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly cache = new Map<string, string | null>();

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trieSize = view.getUint32(0, true);
    this.units = new Uint32Array(trieSize / 4);
    for (let i = 0; i < this.units.length; i++) this.units[i] = view.getUint32(4 + i * 4, true);
    this.normalized = bytes.subarray(4 + trieSize);
  }

  /** Erster (kürzester) Präfix-Treffer wie `spm_precompiled` – Ersatztext oder `null`. */
  transform(chunk: string): string | null {
    const hit = this.cache.get(chunk);
    if (hit !== undefined) return hit;
    const key = this.encoder.encode(chunk);
    const u = this.units;
    let pos = 0;
    let unit = u[0]!;
    pos ^= offset(unit);
    let result: number | undefined;
    for (let i = 0; i < key.length; i++) {
      const c = key[i]!;
      pos ^= c;
      unit = u[pos]!;
      if (label(unit) !== c) break;
      pos ^= offset(unit);
      if (hasLeaf(unit)) { result = u[pos]! & 0x7fffffff; break; }
    }
    let out: string | null = null;
    if (result !== undefined) {
      let end = result;
      while (end < this.normalized.length && this.normalized[end] !== 0) end++;
      out = this.decoder.decode(this.normalized.subarray(result, end));
    }
    this.cache.set(chunk, out);
    return out;
  }

  normalize(text: string): string {
    let out = "";
    for (const g of graphemes(text)) {
      if (this.encoder.encode(g).length < 6) {
        const n = this.transform(g);
        if (n !== null) { out += n; continue; }
      }
      for (const c of g) out += this.transform(c) ?? c;
    }
    return out;
  }
}

const hasLeaf = (unit: number) => ((unit >>> 8) & 1) === 1;
const label = (unit: number) => (unit & 0x800000ff) >>> 0;
const offset = (unit: number) => (unit >>> 10) << ((unit & (1 << 9)) >>> 6);

export interface Encoding {
  ids: number[];
  tokens: string[];
}

/** Unigram-Tokenizer aus `tokenizer.json`. */
export class UnigramTokenizer {
  private readonly pieces = new Map<string, number>();
  private readonly scores: Float64Array;
  private readonly unkID: number;
  private readonly unkScore: number;
  private readonly maxPieceChars: number;
  private readonly normalizers: ((s: string) => string)[] = [];
  private readonly replacement: string;
  private readonly addPrefixSpace: boolean;
  private readonly special: { content: string; id: number }[];
  private readonly bos: number | undefined;
  private readonly eos: number | undefined;
  readonly vocabSize: number;

  constructor(json: string | TokenizerJSON) {
    const t: TokenizerJSON = typeof json === "string" ? (JSON.parse(json) as TokenizerJSON) : json;
    if (t.model.type !== "Unigram") throw new Error(`Unsupported tokenizer model ${t.model.type}`);
    if (t.model.byte_fallback) throw new Error("Unigram byte fallback is not supported");
    const vocab = t.model.vocab;
    this.vocabSize = vocab.length;
    this.scores = new Float64Array(vocab.length);
    let min = Infinity, maxChars = 1;
    vocab.forEach(([piece, score], id) => {
      if (!this.pieces.has(piece)) this.pieces.set(piece, id);
      this.scores[id] = score;
      if (score < min) min = score;
      const n = [...piece].length;
      if (n > maxChars) maxChars = n;
    });
    this.maxPieceChars = maxChars;
    this.unkID = t.model.unk_id ?? 0;
    this.unkScore = min - UNK_PENALTY;
    if (t.normalizer) this.addNormalizer(t.normalizer);
    const pre = t.pre_tokenizer;
    if (pre && pre.type !== "Metaspace") throw new Error(`Unsupported pre-tokenizer ${pre.type}`);
    this.replacement = pre?.replacement ?? "▁";
    this.addPrefixSpace = pre ? (pre.add_prefix_space ?? (pre.prepend_scheme ?? "always") !== "never") : false;
    this.special = (t.added_tokens ?? []).filter((a) => a.special !== false).map((a) => ({ content: a.content, id: a.id }))
      .sort((a, b) => b.content.length - a.content.length);
    const single = t.post_processor?.type === "TemplateProcessing" ? (t.post_processor.single ?? []) : [];
    const specials = single.map((s) => (s as { SpecialToken?: { id: string } }).SpecialToken?.id).filter((s): s is string => !!s);
    const idOf = (c: string | undefined) => (c === undefined ? undefined : this.special.find((s) => s.content === c)?.id ?? this.pieces.get(c));
    const seqAt = single.findIndex((s) => (s as { Sequence?: unknown }).Sequence !== undefined);
    this.bos = seqAt > 0 ? idOf(specials[0]) : undefined;
    this.eos = seqAt >= 0 && specials.length > (seqAt > 0 ? 1 : 0) ? idOf(specials[specials.length - 1]) : undefined;
  }

  private addNormalizer(n: NormalizerJSON) {
    switch (n.type) {
      case "Sequence": n.normalizers.forEach((x) => this.addNormalizer(x)); break;
      case "Precompiled": {
        if (!n.precompiled_charsmap) break;
        const map = new PrecompiledCharsmap(base64Bytes(n.precompiled_charsmap));
        this.normalizers.push((s) => map.normalize(s));
        break;
      }
      case "Replace": {
        const re = n.pattern.Regex !== undefined ? new RegExp(n.pattern.Regex, "gu") : undefined;
        const lit = n.pattern.String;
        this.normalizers.push((s) => (re ? s.replace(re, n.content) : lit !== undefined ? s.split(lit).join(n.content) : s));
        break;
      }
      case "NFKC": case "NFC": case "NFD": case "NFKD": { const f = n.type; this.normalizers.push((s) => s.normalize(f)); break; }
      case "Lowercase": this.normalizers.push((s) => s.toLowerCase()); break;
      case "Strip": this.normalizers.push((s) => s.trim()); break;
      default: throw new Error(`Unsupported normalizer ${(n as { type: string }).type}`);
    }
  }

  normalize(text: string): string {
    let s = text;
    for (const f of this.normalizers) s = f(s);
    return s;
  }

  /** Text → IDs (ohne Rahmen, wenn `special` false). `maxLength` kürzt wie `truncation` (Rahmen zählt mit). */
  encode(text: string, opts: { special?: boolean; maxLength?: number } = {}): Encoding {
    const ids: number[] = [];
    const tokens: string[] = [];
    for (const part of this.splitSpecial(text)) {
      if (typeof part === "number") { ids.push(part); tokens.push(this.special.find((s) => s.id === part)!.content); continue; }
      const normalized = this.normalize(part);
      if (normalized === "") continue;
      for (const word of this.preTokenize(normalized)) this.viterbi(word, ids, tokens);
    }
    const special = opts.special ?? true;
    const frame = special ? (this.bos !== undefined ? 1 : 0) + (this.eos !== undefined ? 1 : 0) : 0;
    if (opts.maxLength !== undefined && ids.length + frame > opts.maxLength) {
      const keep = Math.max(0, opts.maxLength - frame);
      ids.length = keep;
      tokens.length = keep;
    }
    if (special) {
      if (this.bos !== undefined) { ids.unshift(this.bos); tokens.unshift(this.special.find((s) => s.id === this.bos)?.content ?? ""); }
      if (this.eos !== undefined) { ids.push(this.eos); tokens.push(this.special.find((s) => s.id === this.eos)?.content ?? ""); }
    }
    return { ids, tokens };
  }

  private splitSpecial(text: string): (string | number)[] {
    if (this.special.length === 0) return [text];
    const out: (string | number)[] = [];
    let rest = text;
    while (rest.length > 0) {
      let at = -1, which: { content: string; id: number } | undefined;
      for (const s of this.special) {
        const i = rest.indexOf(s.content);
        if (i >= 0 && (at < 0 || i < at)) { at = i; which = s; }
      }
      if (!which) { out.push(rest); break; }
      if (at > 0) out.push(rest.slice(0, at));
      out.push(which.id);
      rest = rest.slice(at + which.content.length);
    }
    return out;
  }

  private preTokenize(s: string): string[] {
    let t = s.replaceAll(" ", this.replacement);
    if (this.addPrefixSpace && !t.startsWith(this.replacement)) t = this.replacement + t;
    // Getrennt vor jedem „▁“ (MergedWithNext).
    const out: string[] = [];
    let cur = "";
    for (const c of t) {
      if (c === this.replacement && cur !== "") { out.push(cur); cur = ""; }
      cur += c;
    }
    if (cur !== "") out.push(cur);
    return out;
  }

  private viterbi(word: string, ids: number[], tokens: string[]) {
    const chars = [...word];
    const n = chars.length;
    const bestScore = new Float64Array(n + 1).fill(-Infinity);
    const bestID = new Int32Array(n + 1).fill(-1);
    const bestStart = new Int32Array(n + 1).fill(-1);
    bestScore[0] = 0;
    for (let i = 0; i < n; i++) {
      if (bestScore[i] === -Infinity) continue;
      const base = bestScore[i]!;
      let piece = "";
      let single = false;
      const limit = Math.min(n, i + this.maxPieceChars);
      for (let j = i; j < limit; j++) {
        piece += chars[j];
        const id = this.pieces.get(piece);
        if (id === undefined) continue;
        if (j === i) single = true;
        const score = base + this.scores[id]!;
        if (bestID[j + 1] === -1 || bestScore[j + 1]! < score) { bestScore[j + 1] = score; bestID[j + 1] = id; bestStart[j + 1] = i; }
      }
      if (!single) {
        const score = base + this.unkScore;
        if (bestID[i + 1] === -1 || bestScore[i + 1]! < score) { bestScore[i + 1] = score; bestID[i + 1] = this.unkID; bestStart[i + 1] = i; }
      }
    }
    const path: { id: number; text: string }[] = [];
    for (let end = n; end > 0; end = bestStart[end]!) path.push({ id: bestID[end]!, text: chars.slice(bestStart[end]!, end).join("") });
    path.reverse();
    // Aufeinanderfolgende Unbekannte zu einem Token (fuse_unk).
    let lastUnk = false;
    for (const p of path) {
      if (p.id === this.unkID && lastUnk) { tokens[tokens.length - 1] += p.text; continue; }
      ids.push(p.id);
      tokens.push(p.text);
      lastUnk = p.id === this.unkID;
    }
  }
}
