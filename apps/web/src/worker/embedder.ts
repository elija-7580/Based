// BSD-231 Teil 3b: Lokales Embedding-Modell (multilingual-e5-small) im Store-Worker. Nur wenn es per Opt-in geladen
// wurde (Dateien im OPFS, Größe und SHA-256 geprüft); sonst gibt es keins und die Suche bleibt bei TF-IDF. Laufzeit
// onnxruntime-web (MIT), erst beim ersten Gebrauch nachgeladen; die .wasm-Datei liefert die App selbst aus (kein Netz).
import { localModels, type TextEmbedder } from "@based/brain";

/** onnxruntime-web, so weit es hier gebraucht wird (die Typen des Pakets sind für den Worker zu breit). */
export interface OrtLike {
  env: { wasm: { numThreads?: number; proxy?: boolean; wasmPaths?: string | { wasm?: string } } };
  InferenceSession: { create(model: Uint8Array): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>> }> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}

export interface EmbedderLoaderOptions {
  manager: () => Promise<localModels.LocalModelManager>;
  catalog: () => readonly localModels.LocalModelSpec[];
  /** Gilt das Modell als installiert? (Host-Cache; ändert sich bei Laden/Entfernen.) */
  installed: (id: string) => Promise<boolean>;
  /** Laufzeit (Tests: Doppel). */
  runtime?: () => Promise<OrtLike>;
}

const defaultRuntime = async (): Promise<OrtLike> => {
  const ort = (await import("onnxruntime-web")) as unknown as OrtLike;
  ort.env.wasm.numThreads = 1; // ohne SharedArrayBuffer (keine Cross-Origin-Isolation nötig)
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: new URL("../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url).href };
  return ort;
};

/** Liefert den Embedder, sobald das Modell installiert ist (sonst `undefined`); lädt einmal, danach aus dem Speicher. */
export function localEmbedderLoader(o: EmbedderLoaderOptions): () => Promise<TextEmbedder | undefined> {
  let loading: Promise<TextEmbedder | undefined> | undefined;
  let loadedFor: string | undefined;
  return async () => {
    const spec = o.catalog().find((s) => s.purpose === "embeddings");
    if (!spec || !(await o.installed(spec.id))) {
      loading = undefined;
      loadedFor = undefined;
      return undefined;
    }
    if (loading && loadedFor === spec.id) return loading;
    loadedFor = spec.id;
    loading = (async () => {
      const m = await o.manager();
      const tokenizer = await m.file(spec, "tokenizer.json");
      const model = spec.files.find((f) => f.path.endsWith(".onnx"));
      const bytes = model && (await m.file(spec, model.path));
      if (!tokenizer || !bytes) return undefined;
      const ort = await (o.runtime ?? defaultRuntime)();
      const session = await ort.InferenceSession.create(bytes);
      const runner: localModels.OnnxRunner = {
        async run(f) {
          const t = (d: BigInt64Array) => new ort.Tensor("int64", d, [...f.dims]);
          const r = await session.run({ input_ids: t(f.input_ids), attention_mask: t(f.attention_mask), token_type_ids: t(f.token_type_ids) });
          const out = r.last_hidden_state;
          if (!out) throw new Error("embedding model has no last_hidden_state");
          return { data: out.data as Float32Array, dims: out.dims };
        },
      };
      return new localModels.E5Embedder(new localModels.UnigramTokenizer(new TextDecoder().decode(tokenizer)), runner, { id: `${spec.id}@${spec.version}` });
    })().then((e) => {
      if (!e) loading = undefined; // Dateien unvollständig/verändert: beim nächsten Mal neu prüfen
      return e;
    }, (e: unknown) => {
      loading = undefined;
      throw e;
    });
    return loading;
  };
}
