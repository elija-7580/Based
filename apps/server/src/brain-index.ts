// BSD-541: Suche nach Bedeutung auf dem Server (und im lokalen Server der Mac-App) – damit `recall` über MCP auch
// ohne gemeinsames Wort und über Sprachen findet. Das Modell (multilingual-e5-small, Katalog aus BSD-231) wird nur auf
// ausdrücklichen Aufruf geladen (POST /local/brain/model {"action":"download"}), liegt im Ordner `<db>.models` und
// läuft im Server-Prozess. Der Index ist eine abgeleitete Datei `<db>.vectors` (nie synchronisiert, jederzeit neu
// berechenbar). Fehlt Modell oder Laufzeit, bleibt alles wie ohne: `recall` nutzt Wörter und Nachbarn.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { localModels, SemanticIndexer, VectorIndex, type TextEmbedder } from "@based/brain";
import type { WorkspaceStore } from "@based/core";
import type { Logger } from "./log.js";
import { FileModelStore } from "./models.js";
import { error, json, type Router } from "./router.js";
import type { Pages } from "./pages.js";

export const EMBEDDING_DIM = 384;

/** Was von onnxruntime-node bzw. onnxruntime-web gebraucht wird (beide haben dieselbe Schnittstelle). */
export interface OrtLike {
  env?: { wasm?: { numThreads?: number; proxy?: boolean } };
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>> }> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}

export interface OrtRuntime {
  ort: OrtLike;
  /** `native` = onnxruntime-node (schneller, weniger Speicher), `wasm` = onnxruntime-web (läuft überall). */
  kind: "native" | "wasm";
}

/**
 * ONNX-Laufzeit laden: zuerst onnxruntime-node (wenn installiert – der Server im Container), sonst onnxruntime-web
 * (WebAssembly, liegt dem lokalen Server der Desktop-App bei). Fehlen beide: `undefined`, keine Suche nach Bedeutung.
 */
export function loadOrt(): OrtRuntime | undefined {
  const req = createRequire(import.meta.url);
  for (const [name, kind] of [["onnxruntime-node", "native"], ["onnxruntime-web", "wasm"]] as const) {
    try {
      return { ort: req(name) as OrtLike, kind };
    } catch {
      /* nächste */
    }
  }
  return undefined;
}

export interface BrainIndexOptions {
  store: WorkspaceStore;
  pages: Pages;
  log: Logger;
  /** Ordner für Modelldateien (`<db>.models`); ohne: kein Modell. */
  modelsDir?: string | undefined;
  /** Datei des Index (`<db>.vectors`); ohne: nur im Arbeitsspeicher. */
  indexFile?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** Laufzeit (Tests: Doppel). */
  runtime?: (() => OrtRuntime | undefined) | undefined;
  /** Fertiger Embedder statt Modell + Laufzeit (Tests). */
  embedder?: (() => Promise<TextEmbedder | undefined>) | undefined;
  threads?: number | undefined;
  /** Pause zwischen zwei Schritten des Indexers in ms (Standard 20) – lässt dem Server Luft. */
  pauseMs?: number | undefined;
}

export class BrainIndex {
  readonly spec = localModels.catalogFor("embeddings");
  private readonly manager: localModels.LocalModelManager | undefined;
  private installed: boolean | undefined;
  private download: { ctl: AbortController; loaded: number; total: number } | undefined;
  private lastError: string | undefined;
  private embedder: TextEmbedder | undefined;
  private runtimeKind: OrtRuntime["kind"] | undefined;
  private index: VectorIndex | undefined;
  private indexer: SemanticIndexer | undefined;
  private unfollow: (() => void) | undefined;
  private unobserve: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private starting: Promise<void> | undefined;
  private closed = false;
  private lastSave = 0;

  constructor(private readonly o: BrainIndexOptions) {
    if (o.modelsDir && this.spec) {
      this.manager = new localModels.LocalModelManager({
        store: new FileModelStore(o.modelsDir),
        // Der Aufruf „download“ ist die Einwilligung (nur der Besitzer kann ihn machen).
        consent: () => new Set<localModels.LocalModelPurpose>(["embeddings"]),
        fetch: o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      });
    }
    o.pages.vectors = () => (this.index && this.embedder ? { index: this.index, embedder: this.embedder } : undefined);
  }

  private get size() {
    return this.spec?.files.reduce((n, f) => n + f.size, 0) ?? 0;
  }

  private async isInstalled(): Promise<boolean> {
    if (this.o.embedder) return true;
    if (!this.manager || !this.spec || this.download) return false;
    return (this.installed ??= await this.manager.installed(this.spec));
  }

  async state() {
    const installed = await this.isInstalled();
    return {
      model: this.spec ? { id: this.spec.id, name: this.spec.name, license: this.spec.license, size: this.size } : null,
      installed,
      downloading: this.download !== undefined,
      ...(this.download ? { loaded: this.download.loaded } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      // „ready“: Anfragen laufen schon nach Bedeutung (der Index darf noch wachsen).
      ready: this.embedder !== undefined && this.index !== undefined,
      ...(this.runtimeKind ? { runtime: this.runtimeKind } : {}),
      sections: this.index?.size ?? 0,
      pages: this.index?.pages ?? 0,
      pending: this.indexer?.pending ?? 0,
      bytes: this.index?.bytes ?? 0,
    };
  }

  /** Modell laden (im Hintergrund), danach den Index aufbauen. */
  startDownload(): void {
    if (this.download || !this.manager || !this.spec) return;
    const ctl = new AbortController();
    const d = { ctl, loaded: 0, total: this.size };
    this.download = d;
    this.lastError = undefined;
    this.installed = undefined;
    const spec = this.spec;
    this.manager.download(spec, { signal: ctl.signal, onProgress: (p) => { d.loaded = p.loaded; } }).then(
      () => {
        this.installed = true;
        this.o.log.info("embedding model ready", { model: spec.id });
      },
      (e: unknown) => {
        this.installed = false;
        this.lastError = ctl.signal.aborted ? "cancelled" : e instanceof Error ? e.message : String(e);
        this.o.log.warning("embedding model download failed", { message: this.lastError });
      },
    ).finally(() => {
      if (this.download === d) this.download = undefined;
      if (this.installed) void this.start();
    });
  }

  cancel(): void {
    this.download?.ctl.abort();
  }

  /** Modell und Index entfernen; `recall` läuft danach wieder über Wörter und Nachbarn. */
  async remove(): Promise<void> {
    this.cancel();
    this.halt();
    this.embedder = undefined;
    this.index = undefined;
    this.indexer = undefined;
    this.starting = undefined;
    if (this.manager && this.spec) await this.manager.remove(this.spec);
    this.installed = false;
    if (this.o.indexFile) rmSync(this.o.indexFile, { force: true });
  }

  private async loadEmbedder(): Promise<TextEmbedder | undefined> {
    if (this.o.embedder) return this.o.embedder();
    if (!this.manager || !this.spec) return undefined;
    const spec = this.spec;
    const tokenizer = await this.manager.file(spec, "tokenizer.json");
    const model = spec.files.find((f) => f.path.endsWith(".onnx"));
    const bytes = model && (await this.manager.file(spec, model.path));
    if (!tokenizer || !bytes) return undefined;
    const rt = (this.o.runtime ?? loadOrt)();
    if (!rt) {
      this.lastError = "no ONNX runtime (onnxruntime-node or onnxruntime-web) next to the server";
      return undefined;
    }
    const threads = Math.max(1, this.o.threads ?? Math.min(4, Math.ceil(availableParallelism() / 2)));
    if (rt.kind === "wasm" && rt.ort.env?.wasm) {
      rt.ort.env.wasm.numThreads = threads;
      rt.ort.env.wasm.proxy = false;
    }
    const session = await rt.ort.InferenceSession.create(bytes, rt.kind === "native" ? { intraOpNumThreads: threads } : {});
    this.runtimeKind = rt.kind;
    // Eine Sitzung rechnet immer nur einen Aufruf (Anfrage und Indexer teilen sie sich).
    let queue: Promise<unknown> = Promise.resolve();
    const runner: localModels.OnnxRunner = {
      run(f) {
        const next = queue.then(async () => {
          const t = (d: BigInt64Array) => new rt.ort.Tensor("int64", d, [...f.dims]);
          const r = await session.run({ input_ids: t(f.input_ids), attention_mask: t(f.attention_mask), token_type_ids: t(f.token_type_ids) });
          const out = r.last_hidden_state;
          if (!out) throw new Error("embedding model has no last_hidden_state");
          return { data: out.data as Float32Array, dims: out.dims };
        });
        queue = next.catch(() => undefined);
        return next;
      },
    };
    return new localModels.E5Embedder(new localModels.UnigramTokenizer(new TextDecoder().decode(tokenizer)), runner, { id: `${spec.id}@${spec.version}` });
  }

  /** Modell in den Speicher holen, Index laden bzw. anlegen, dem Workspace folgen. Ohne Modell passiert nichts. */
  start(): Promise<void> {
    return (this.starting ??= (async () => {
      if (this.closed || !(await this.isInstalled())) {
        this.starting = undefined;
        return;
      }
      try {
        const embedder = await this.loadEmbedder();
        if (!embedder || this.closed) {
          this.starting = undefined;
          return;
        }
        const probe = (await embedder.embed(["ok"], undefined, "query"))[0];
        const dim = probe?.length ?? EMBEDDING_DIM;
        let index: VectorIndex | undefined;
        if (this.o.indexFile && existsSync(this.o.indexFile)) index = VectorIndex.deserialize(new Uint8Array(readFileSync(this.o.indexFile)), { dim, model: embedder.id });
        index ??= new VectorIndex(dim, embedder.id);
        const indexer = new SemanticIndexer(this.o.store, embedder, index);
        this.embedder = embedder;
        this.index = index;
        this.indexer = indexer;
        indexer.enqueueAll(); // Unverändertes kostet nur den Hash
        this.unfollow = indexer.follow();
        this.unobserve = this.o.store.observe(() => this.kick());
        this.o.log.info("brain index started", { model: embedder.id, runtime: this.runtimeKind ?? "custom", sections: index.size, pending: indexer.pending });
        this.kick();
      } catch (e) {
        this.starting = undefined;
        this.lastError = e instanceof Error ? e.message : String(e);
        this.o.log.warning("brain index failed to start", { message: this.lastError });
      }
    })());
  }

  private kick(): void {
    if (this.running || this.closed || !this.indexer || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.work();
    }, this.o.pauseMs ?? 20);
    this.timer.unref?.();
  }

  private async work(): Promise<void> {
    const indexer = this.indexer;
    if (!indexer || this.running || this.closed) return;
    this.running = true;
    try {
      const left = await indexer.step(4);
      if (this.index?.dirty && (left === 0 || Date.now() - this.lastSave > 30_000)) this.save();
    } catch (e) {
      this.o.log.warning("brain index step failed", { message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
    if (indexer.pending > 0) this.kick();
  }

  /** Warten, bis nichts mehr vorgemerkt ist (Tests, Kommandozeile). */
  async idle(): Promise<void> {
    await this.starting;
    while (this.indexer && !this.closed && (this.indexer.pending > 0 || this.running)) await new Promise((r) => setTimeout(r, 5));
  }

  private save(): void {
    if (!this.index || !this.o.indexFile) return;
    try {
      const tmp = this.o.indexFile + ".tmp";
      writeFileSync(tmp, this.index.serialize());
      renameSync(tmp, this.o.indexFile);
      this.lastSave = Date.now();
    } catch (e) {
      this.o.log.warning("brain index not saved", { message: e instanceof Error ? e.message : String(e) });
    }
  }

  private halt(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unfollow?.();
    this.unobserve?.();
    this.unfollow = this.unobserve = undefined;
  }

  close(): void {
    this.closed = true;
    this.cancel();
    this.halt();
    if (this.index?.dirty) this.save();
  }
}

export const defaultVectorsFile = (db: string | undefined) => (db && db !== ":memory:" ? db.replace(/(\.sqlite)?$/, ".vectors") : undefined);

/** Stand und Modell der Suche nach Bedeutung (nur Besitzer – wie /local/transcribe). */
export function registerBrainRoutes(router: Router, brain: BrainIndex) {
  router.add("GET", "/local/brain", async () => json(await brain.state()));
  router.add("POST", "/local/brain/model", async ({ body }) => {
    let action: unknown;
    try { ({ action } = JSON.parse(new TextDecoder().decode(body)) as { action?: unknown }); } catch { return error("JSON body {action}", 400); }
    if (!brain.spec) return error("no embedding model in the catalog", 409);
    if (action === "download") {
      if (!(await brain.state()).installed) brain.startDownload();
      else void brain.start();
    } else if (action === "cancel") brain.cancel();
    else if (action === "remove") await brain.remove();
    else return error("action must be download, cancel or remove", 400);
    return json(await brain.state(), action === "download" ? 202 : 200);
  }, { bodyLimit: 1024 });
}
