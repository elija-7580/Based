// BSD-231 Teil 3a: Tokenizer (SentencePiece-Unigram aus tokenizer.json) und E5-Embeddings hinter TextEmbedder.
// Immer: kleines Vokabular, selbst gebaute Zeichentabelle, Doppel für die Laufzeit. Mit echtem Modell (opt-in, nicht in
// der CI – 135 MB): BASED_E5_DIR=<Ordner mit tokenizer.json und onnx/model_quantized.onnx aus dem Katalog>,
// BASED_ORT_WEB=<Pfad zu onnxruntime-web/dist/ort.wasm.min.mjs>. Gemessen 16.11.: Tokenizer = `tokenizers` 0.23 auf 4 079
// Texten (Repo-Doku + zufälliges Unicode aus 20 Schriftbereichen), Vektoren 1 − cos ≤ 0,0014 zu onnxruntime (Python).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localModels } from "../src/index.js";

const { E5Embedder, PrecompiledCharsmap, UnigramTokenizer, dot } = localModels;

/** Darts-Doppelarray mit wenigen präfixfreien Schlüsseln (UTF-8) → Ersatztext, im Format von precompiled_charsmap. */
function charsmap(entries: [string, string][]): string {
  const enc = new TextEncoder();
  const units = new Uint32Array(1 << 14);
  let blob: number[] = [];
  let next = 256;
  const fresh = () => { const b = next; next += 256; return b; };
  const unit = (offset: number, labelByte: number, leaf: boolean) => ((offset << 10) | (leaf ? 1 << 8 : 0) | labelByte) >>> 0;
  const rootBase = fresh();
  units[0] = unit(rootBase, 0, false);
  const children = new Map<string, number>(); // Pfad → Knotenposition
  for (const [from, to] of entries) {
    const key = enc.encode(from);
    let base = rootBase;
    let path = "";
    for (let i = 0; i < key.length; i++) {
      const c = key[i]!;
      path += c + ",";
      const pos = base ^ c;
      const last = i === key.length - 1;
      let nodeBase = children.get(path);
      if (nodeBase === undefined) { nodeBase = fresh(); children.set(path, nodeBase); }
      // offset so wählen, dass pos ^ offset = nodeBase
      units[pos] = unit(pos ^ nodeBase, c, last);
      if (last) { units[nodeBase] = blob.length; blob = blob.concat([...enc.encode(to), 0]); }
      base = nodeBase;
    }
  }
  const trie = new Uint8Array(units.buffer);
  const out = new Uint8Array(4 + trie.length + blob.length);
  new DataView(out.buffer).setUint32(0, trie.length, true);
  out.set(trie, 4);
  out.set(blob, 4 + trie.length);
  let bin = "";
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin);
}

const VOCAB: [string, number][] = [
  ["<s>", 0], ["<pad>", 0], ["</s>", 0], ["<unk>", 0],
  ["▁", -2], ["a", -3], ["b", -3], ["c", -3], ["▁a", -2.5], ["ab", -2], ["▁ab", -1.5], ["abc", -4], ["▁abc", -3.9], ["fi", -2.2], ["▁fi", -2.1],
  ["e", -3], ["▁e", -2.8], ["x", -3], ["▁x", -3],
];

function tokenizerJSON(map?: string) {
  return {
    added_tokens: [{ id: 0, content: "<s>", special: true }, { id: 1, content: "<pad>", special: true }, { id: 2, content: "</s>", special: true }, { id: 3, content: "<unk>", special: true }],
    normalizer: { type: "Sequence", normalizers: [...(map ? [{ type: "Precompiled", precompiled_charsmap: map }] : []), { type: "Replace", pattern: { Regex: " {2,}" }, content: " " }] },
    pre_tokenizer: { type: "Metaspace", replacement: "▁", add_prefix_space: true },
    post_processor: { type: "TemplateProcessing", single: [{ SpecialToken: { id: "<s>", type_id: 0 } }, { Sequence: { id: "A", type_id: 0 } }, { SpecialToken: { id: "</s>", type_id: 0 } }] },
    model: { type: "Unigram", unk_id: 3, vocab: VOCAB },
  };
}

describe("UnigramTokenizer (BSD-231 Teil 3a)", () => {
  const tok = new UnigramTokenizer(JSON.stringify(tokenizerJSON(charsmap([["ﬁ", "fi"], ["é", "e"], ["Ａ", "a"]]))));

  it("Viterbi wählt die beste Zerlegung, Rahmen <s> … </s>", () => {
    expect(tok.encode("ab abc").tokens).toEqual(["<s>", "▁ab", "▁abc", "</s>"]);
    expect(tok.encode("abab").tokens).toEqual(["<s>", "▁ab", "ab", "</s>"]);
    expect(tok.encode("ab", { special: false }).ids).toEqual([10]);
  });

  it("Unbekanntes wird zu einem <unk> zusammengefasst; Leerzeichen und Präfix wie Metaspace", () => {
    expect(tok.encode("a zzz b").tokens).toEqual(["<s>", "▁a", "▁", "zzz", "▁", "b", "</s>"]);
    expect(tok.encode("a zzz b").ids).toEqual([0, 8, 4, 3, 4, 6, 2]);
    expect(tok.encode("a    b").tokens).toEqual(tok.encode("a b").tokens);
    expect(tok.encode("").ids).toEqual([0, 2]);
  });

  it("Zeichentabelle: Ligatur, Akzent, Vollbreite (wie precompiled_charsmap)", () => {
    expect(tok.normalize("ﬁx é Ａ")).toBe("fix e a");
    expect(tok.encode("ﬁx").tokens).toEqual(["<s>", "▁fi", "x", "</s>"]);
    const map = new PrecompiledCharsmap(Uint8Array.from(atob(charsmap([["ab", "X"]])), (c) => c.charCodeAt(0)));
    expect(map.transform("ab")).toBe("X");
    expect(map.transform("a")).toBeNull();
    expect(map.normalize("cab")).toBe("cab"); // Zeichen für Zeichen: „ab“ ist kein einzelnes Graphem
  });

  it("Spezial-Tokens im Text und Kürzen auf maxLength (Rahmen zählt mit)", () => {
    expect(tok.encode("a</s>b").tokens).toEqual(["<s>", "▁a", "</s>", "▁", "b", "</s>"]);
    const long = tok.encode("a ".repeat(100), { maxLength: 10 });
    expect(long.ids).toHaveLength(10);
    expect(long.ids[0]).toBe(0);
    expect(long.ids[9]).toBe(2);
  });

  it("Andere Modelle werden abgelehnt", () => {
    expect(() => new UnigramTokenizer({ model: { type: "BPE", vocab: [] } } as never)).toThrow(/Unsupported/);
  });
});

describe("E5Embedder (BSD-231 Teil 3a)", () => {
  const tok = new UnigramTokenizer(JSON.stringify(tokenizerJSON()));
  /** Laufzeit-Doppel: versteckter Zustand je Token = [id, 1, Position], Auffüllen mit 99 (darf nicht zählen). */
  const calls: { dims: readonly [number, number]; ids: number[] }[] = [];
  const runner = {
    async run(f: { input_ids: BigInt64Array; attention_mask: BigInt64Array; dims: readonly [number, number] }) {
      const [n, len] = f.dims;
      calls.push({ dims: f.dims, ids: [...f.input_ids].map(Number) });
      const data = new Float32Array(n * len * 3);
      for (let i = 0; i < n * len; i++) {
        const pad = f.attention_mask[i] === 0n;
        data.set(pad ? [99, 99, 99] : [Number(f.input_ids[i]), 1, i % len], i * 3);
      }
      return { data, dims: [n, len, 3] };
    },
  };

  it("Präfix passage/query, Mittelwert nur über echte Tokens, Länge 1, Reihenfolge bleibt", async () => {
    calls.length = 0;
    const e = new E5Embedder(tok, runner, { batchSize: 4 });
    const [long, short] = await e.embed(["abc abc", "a"]);
    // Stapel nach Länge sortiert; Auffüllen mit <pad> (1)
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ids).toContain(1);
    for (const v of [long!, short!]) expect(dot(v, v)).toBeCloseTo(1, 5);
    // „passage: a“ → Tokens ohne Auffüllen; erwarteter Mittelwert
    const ids = tok.encode("passage: a").ids;
    const mean = [ids.reduce((s, x) => s + x, 0) / ids.length, 1, (ids.length - 1) / 2];
    const norm = Math.hypot(...mean);
    expect([...short!].map((x) => +x.toFixed(5))).toEqual(mean.map((x) => +(x / norm).toFixed(5)));
    const q = await e.embedQuery("a");
    expect(calls.at(-1)!.ids).toEqual(tok.encode("query: a").ids);
    expect(dot(q, q)).toBeCloseTo(1, 5);
  });

  it("Standard: ein Text je Aufruf (derselbe Text = derselbe Vektor), höchstens maxTokens", async () => {
    calls.length = 0;
    const e = new E5Embedder(tok, runner, { maxTokens: 8 });
    await e.embed(["a b c a b c a b c", "x"]);
    expect(calls.map((c) => c.dims[0])).toEqual([1, 1]);
    expect(Math.max(...calls.map((c) => c.dims[1]))).toBe(8);
  });

  it("Abbruch und falsche Form", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new E5Embedder(tok, runner).embed(["a"], ac.signal)).rejects.toThrow();
    const bad = { run: async () => ({ data: new Float32Array(5), dims: [1, 1, 3] as const }) };
    await expect(new E5Embedder(tok, bad).embed(["a"])).rejects.toThrow(/shape/);
  });
});

const DIR = process.env.BASED_E5_DIR;
const ORT = process.env.BASED_ORT_WEB;
// Referenz aus Python (tokenizers 0.23, onnxruntime 1.32, ein Text je Aufruf), Modell aus LOCAL_MODEL_CATALOG.
const REF_IDS: [string, number[]][] = [
  ["query: Wie viel kostet die Reise nach Wien?", [0, 41, 1294, 12, 4887, 6179, 129203, 68, 26676, 1561, 62357, 32, 2]],
];
const REF_TEXTS = [["query", "Wie viel kostet die Reise nach Wien?"], ["passage", "Die Zugfahrt nach Wien kostet 39 Euro."], ["passage", "Das Meeting am Montag beginnt um 9:30 Uhr."], ["query", "how much is the train to Vienna"]] as const;
const REF_SIMS = [[1, 0.88793, 0.73108, 0.88894], [0.88793, 1, 0.83643, 0.85082], [0.73108, 0.83643, 1, 0.72187], [0.88894, 0.85082, 0.72187, 1]];

describe.skipIf(!DIR || !ORT || !existsSync(`${DIR}/tokenizer.json`))("E5 mit echtem Modell (opt-in)", () => {
  it("Tokenizer-IDs und Ähnlichkeiten wie die Referenz", async () => {
    const tok = new UnigramTokenizer(readFileSync(`${DIR}/tokenizer.json`, "utf8"));
    for (const [text, ids] of REF_IDS) expect(tok.encode(text).ids).toEqual(ids);
    const ort = (await import(ORT!)) as {
      env: { wasm: { numThreads: number; wasmPaths: string } };
      InferenceSession: { create(b: Uint8Array): Promise<{ run(f: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>> }> };
      Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
    };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ORT!.slice(0, ORT!.lastIndexOf("/") + 1);
    const session = await ort.InferenceSession.create(readFileSync(`${DIR}/onnx/model_quantized.onnx`));
    const runner = {
      async run(f: { input_ids: BigInt64Array; attention_mask: BigInt64Array; token_type_ids: BigInt64Array; dims: readonly [number, number] }) {
        const t = (d: BigInt64Array) => new ort.Tensor("int64", d, [...f.dims]);
        const r = await session.run({ input_ids: t(f.input_ids), attention_mask: t(f.attention_mask), token_type_ids: t(f.token_type_ids) });
        const o = r.last_hidden_state!;
        return { data: o.data as Float32Array, dims: o.dims };
      },
    };
    const e = new E5Embedder(tok, runner);
    const v = await Promise.all(REF_TEXTS.map(async ([kind, t]) => (await e.embed([t], undefined, kind))[0]!));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) expect(Math.abs(dot(v[i]!, v[j]!) - REF_SIMS[i]![j]!)).toBeLessThan(0.005);
  }, 120_000);
});
