// BSD-231 Teil 1: Lokale Modelle nur per Opt-in laden (Entscheidung Elija 10.11.). Ohne Einwilligung für einen Zweck
// (Transkription, Embeddings, Redact) geht keine einzige Anfrage hinaus. Quelle ist fest: jede Datei hat URL, Größe und
// SHA-256 im Katalog (gepinnt) oder kommt vom eigenen based-server. Laden mit Fortschritt und Abbruch; gespeichert wird
// eine Datei erst, wenn Größe und Prüfsumme stimmen – danach offline nutzbar. Rein: Netz und Speicher werden
// hineingereicht (Worker: fetch + OPFS, Tests: Doppel). Die Modelle selbst hängen sich später hinter `Transcriber`,
// `TextEmbedder` und `RedactModel` ein.

export type LocalModelPurpose = "transcription" | "embeddings" | "redact";

export interface LocalModelFile {
  /** Pfad im Modell-Speicher (relativ, ohne ..). */
  path: string;
  /** Feste Quelle (https). Leer = vom eigenen based-server (`<server>/models/<modell>/<pfad>`). */
  url?: string;
  size: number;
  sha256: string;
}

export interface LocalModelSpec {
  id: string;
  purpose: LocalModelPurpose;
  name: string;
  version: string;
  license: string;
  files: readonly LocalModelFile[];
}

/** Ablage für Modelldateien (OPFS im Worker, Map in Tests). */
export interface LocalModelStore {
  get(path: string): Promise<Uint8Array | undefined>;
  /** Atomar schreiben. */
  put(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

export class ConsentRequired extends Error {
  constructor(readonly purpose: LocalModelPurpose) {
    super(`Local ${purpose} models are off. Turn them on in Settings first.`);
    this.name = "ConsentRequired";
  }
}

export class ModelIntegrityError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "ModelIntegrityError";
  }
}

export interface DownloadProgress {
  model: string;
  file: string;
  /** Bytes dieses Modells bisher / insgesamt. */
  loaded: number;
  total: number;
}

export interface LocalModelManagerOptions {
  store: LocalModelStore;
  fetch: typeof fetch;
  /** Zwecke, für die der Nutzer zugestimmt hat (Onboarding oder Einstellungen). */
  consent: () => ReadonlySet<LocalModelPurpose>;
  /** Eigener based-server für Dateien ohne feste URL. */
  server?: () => string | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Prüft einen Katalogeintrag (gepinnt, https, sichere Pfade); Fehlerliste leer = gültig. */
export function validateSpec(spec: LocalModelSpec): string[] {
  const errors: string[] = [];
  if (spec.files.length === 0) errors.push("no files");
  for (const f of spec.files) {
    if (!SAFE_PATH.test(f.path)) errors.push(`${f.path}: unsafe path`);
    if (!HEX64.test(f.sha256)) errors.push(`${f.path}: sha256 missing`);
    if (!Number.isInteger(f.size) || f.size <= 0) errors.push(`${f.path}: size missing`);
    if (f.url !== undefined && !f.url.startsWith("https://")) errors.push(`${f.path}: only https sources`);
  }
  return errors;
}

const storePath = (spec: LocalModelSpec, f: LocalModelFile) => `${spec.id}/${spec.version}/${f.path}`;

export class LocalModelManager {
  constructor(private readonly o: LocalModelManagerOptions) {}

  private allowed(purpose: LocalModelPurpose): boolean {
    return this.o.consent().has(purpose);
  }

  /** Liegt das Modell vollständig und unverändert vor? (Kein Netz.) */
  async installed(spec: LocalModelSpec): Promise<boolean> {
    for (const f of spec.files) {
      const b = await this.o.store.get(storePath(spec, f));
      if (!b || b.length !== f.size || (await sha256Hex(b)) !== f.sha256) return false;
    }
    return true;
  }

  /** Datei des Modells lesen (nur wenn installiert und geprüft); für die Laufzeit des Modells. */
  async file(spec: LocalModelSpec, path: string): Promise<Uint8Array | undefined> {
    const f = spec.files.find((x) => x.path === path);
    if (!f) return undefined;
    const b = await this.o.store.get(storePath(spec, f));
    return b && b.length === f.size && (await sha256Hex(b)) === f.sha256 ? b : undefined;
  }

  private sourceOf(spec: LocalModelSpec, f: LocalModelFile): string {
    if (f.url) return f.url;
    const server = this.o.server?.()?.replace(/\/+$/, "");
    if (!server) throw new ModelIntegrityError(f.path, "no source (no fixed URL and no based-server configured)");
    return `${server}/models/${encodeURIComponent(spec.id)}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
  }

  /**
   * Modell laden: ohne Einwilligung für seinen Zweck → `ConsentRequired` (keine Anfrage). Schon vorhandene, geprüfte
   * Dateien werden nicht neu geladen. Jede Datei wird erst nach Größen- und Prüfsummen-Kontrolle gespeichert.
   */
  async download(spec: LocalModelSpec, opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}): Promise<void> {
    if (!this.allowed(spec.purpose)) throw new ConsentRequired(spec.purpose);
    const errors = validateSpec(spec);
    if (errors.length) throw new ModelIntegrityError(spec.id, errors.join("; "));
    const total = spec.files.reduce((n, f) => n + f.size, 0);
    let loaded = 0;
    for (const f of spec.files) {
      opts.signal?.throwIfAborted();
      const path = storePath(spec, f);
      const have = await this.o.store.get(path);
      if (have && have.length === f.size && (await sha256Hex(have)) === f.sha256) {
        loaded += f.size;
        opts.onProgress?.({ model: spec.id, file: f.path, loaded, total });
        continue;
      }
      const init: RequestInit = { credentials: "omit" };
      if (opts.signal) init.signal = opts.signal;
      const res = await this.o.fetch(this.sourceOf(spec, f), init);
      if (!res.ok) throw new ModelIntegrityError(f.path, `HTTP ${res.status}`);
      const parts: Uint8Array[] = [];
      let got = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          opts.signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (got > f.size) { await reader.cancel(); throw new ModelIntegrityError(f.path, "larger than expected"); }
          parts.push(value);
          opts.onProgress?.({ model: spec.id, file: f.path, loaded: loaded + got, total });
        }
      } else {
        const b = new Uint8Array(await res.arrayBuffer());
        parts.push(b);
        got = b.length;
      }
      if (got !== f.size) throw new ModelIntegrityError(f.path, `size ${got}, expected ${f.size}`);
      const bytes = new Uint8Array(got);
      let at = 0;
      for (const p of parts) { bytes.set(p, at); at += p.length; }
      if ((await sha256Hex(bytes)) !== f.sha256) throw new ModelIntegrityError(f.path, "checksum mismatch");
      await this.o.store.put(path, bytes);
      loaded += f.size;
      opts.onProgress?.({ model: spec.id, file: f.path, loaded, total });
    }
  }

  /** Modell wieder entfernen (Einstellungen → „Remove“). */
  async remove(spec: LocalModelSpec): Promise<void> {
    for (const f of spec.files) await this.o.store.delete(storePath(spec, f));
  }
}

/** Speicher im Arbeitsspeicher (Tests, Vorschau). */
export class MemoryLocalModelStore implements LocalModelStore {
  readonly files = new Map<string, Uint8Array>();
  async get(path: string) { return this.files.get(path); }
  async put(path: string, bytes: Uint8Array) { this.files.set(path, bytes.slice()); }
  async delete(path: string) { this.files.delete(path); }
}
