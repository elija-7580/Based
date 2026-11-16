// BSD-231 Teil 3b: Embedder im Worker – nur mit installiertem (geprüftem) Modell, einmal geladen, Laufzeit als Doppel.
import { describe, expect, it } from "vitest";
import { localModels } from "@based/brain";
import { localEmbedderLoader, type OrtLike } from "./embedder.js";

const enc = new TextEncoder();
const TOKENIZER = JSON.stringify({
  added_tokens: [{ id: 0, content: "<s>", special: true }, { id: 1, content: "<pad>", special: true }, { id: 2, content: "</s>", special: true }, { id: 3, content: "<unk>", special: true }],
  normalizer: null,
  pre_tokenizer: { type: "Metaspace", replacement: "▁", add_prefix_space: true },
  post_processor: { type: "TemplateProcessing", single: [{ SpecialToken: { id: "<s>" } }, { Sequence: { id: "A" } }, { SpecialToken: { id: "</s>" } }] },
  model: { type: "Unigram", unk_id: 3, vocab: [["<s>", 0], ["<pad>", 0], ["</s>", 0], ["<unk>", 0], ["▁", -2], ["a", -3], ["▁a", -1], [":", -2], ["▁query", -1], ["▁passage", -1]] },
});

async function setup() {
  const files = { "tokenizer.json": enc.encode(TOKENIZER), "onnx/model_quantized.onnx": enc.encode("fake onnx model") };
  const spec: localModels.LocalModelSpec = {
    id: "e5-test", purpose: "embeddings", name: "test", version: "v1", license: "MIT",
    files: await Promise.all(Object.entries(files).map(async ([path, b]) => ({ path, url: `https://example.invalid/${path}`, size: b.length, sha256: await localModels.sha256Hex(b) }))),
  };
  const store = new localModels.MemoryLocalModelStore();
  const manager = new localModels.LocalModelManager({ store, fetch: (async () => { throw new Error("no network in this test"); }) as typeof fetch, consent: () => new Set(["embeddings"]), server: () => undefined });
  let installed = false;
  let creates = 0;
  const runtime = async (): Promise<OrtLike> => ({
    env: { wasm: {} },
    InferenceSession: {
      async create(model) {
        creates++;
        expect(new TextDecoder().decode(model)).toBe("fake onnx model");
        return {
          async run(feeds) {
            const ids = (feeds.input_ids as { data: BigInt64Array; dims: number[] });
            const [n, len] = ids.dims as [number, number];
            const data = new Float32Array(n * len * 2).map((_, i) => (i % 2 === 0 ? 1 : Number(ids.data[Math.floor(i / 2)])));
            return { last_hidden_state: { data, dims: [n, len, 2] } };
          },
        };
      },
    },
    Tensor: class { constructor(readonly type: string, readonly data: BigInt64Array, readonly dims: number[]) {} } as unknown as OrtLike["Tensor"],
  });
  const load = localEmbedderLoader({ manager: async () => manager, catalog: () => [spec], installed: async () => installed, runtime });
  return { spec, store, files, load, setInstalled: (v: boolean) => { installed = v; }, creates: () => creates };
}

describe("Lokaler Embedder im Worker (BSD-231 Teil 3b)", () => {
  it("ohne installiertes Modell: keiner (Suche bleibt TF-IDF)", async () => {
    const s = await setup();
    expect(await s.load()).toBeUndefined();
    expect(s.creates()).toBe(0);
  });

  it("installiert: einmal laden, Vektoren der Länge 1; entfernt: wieder keiner", async () => {
    const s = await setup();
    for (const f of s.spec.files) await s.store.put(`${s.spec.id}/${s.spec.version}/${f.path}`, s.files[f.path as keyof typeof s.files]);
    s.setInstalled(true);
    const e = (await s.load())!;
    expect(e.id).toBe("e5-test@v1");
    const [v] = await e.embed(["a"], undefined, "query");
    expect(v).toHaveLength(2);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 5);
    expect(await s.load()).toBe(e);
    expect(s.creates()).toBe(1);
    s.setInstalled(false);
    expect(await s.load()).toBeUndefined();
  });

  it("Datei verändert (Prüfsumme falsch): keiner", async () => {
    const s = await setup();
    for (const f of s.spec.files) await s.store.put(`${s.spec.id}/${s.spec.version}/${f.path}`, enc.encode("manipuliert"));
    s.setInstalled(true);
    expect(await s.load()).toBeUndefined();
    expect(s.creates()).toBe(0);
  });
});
