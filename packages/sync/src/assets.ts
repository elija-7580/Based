// BSD-78: Dateien (Bilder, Anhänge) über den Server-Sync. Bytes liegen pro Gerät in einem Blob-Speicher
// (`AssetBlobStore`: OPFS im Browser-Worker, Speicher in Tests) unter ihrem SHA-256; die `AssetRef` im Record trägt
// den Hash als `id`. `AssetSync` lädt neue Blobs in Stücken hoch (Warteschlange in `meta`, überlebt Neustarts,
// setzt nach Abbruch beim Stand des Servers fort) und holt fehlende erst, wenn sie gebraucht werden.
// Protokoll: docs/sync-protocol.md, Abschnitt „Assets“. Logs nennen nie Dateinamen oder Inhalte.

export const ASSET_HASH = /^[0-9a-f]{64}$/;
/** Ist die `id` einer AssetRef ein Inhalts-Hash (über den Server übertragbar)? Die Swift-App vergibt UUIDs. */
export const isAssetHash = (id: string): boolean => ASSET_HASH.test(id);
export const ASSET_QUEUE_KEY = "assets.uploads";
export const DEFAULT_ASSET_CHUNK = 1 << 20; // 1 MiB

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Blob-Speicher eines Geräts, Schlüssel = SHA-256 (hex). */
export interface AssetBlobStore {
  has(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array | undefined>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  delete(hash: string): Promise<void>;
  list(): Promise<string[]>;
}

export class MemoryAssetBlobStore implements AssetBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async has(hash: string) {
    return this.blobs.has(hash);
  }
  async get(hash: string) {
    return this.blobs.get(hash);
  }
  async put(hash: string, bytes: Uint8Array) {
    this.blobs.set(hash, bytes);
  }
  async delete(hash: string) {
    this.blobs.delete(hash);
  }
  async list() {
    return [...this.blobs.keys()];
  }
}

/** Wie in `AssetRef` (@based/core): `id` ist hier der SHA-256. */
export interface StoredAsset {
  id: string;
  name: string;
  size: number;
  mime?: string;
}

export type AssetErrorCode =
  /** Kein Server eingestellt. */
  | "no-server"
  /** Der Server kennt keine Assets (älterer Server, Swift-Server). */
  | "unsupported"
  /** Netzfehler; wird später erneut versucht. */
  | "offline"
  | "unauthorized"
  /** Größer als die Grenze des Servers. */
  | "too-large"
  /** Der Server hat die Datei (noch) nicht: das Quellgerät hat sie noch nicht hochgeladen. */
  | "missing"
  /** Bytes passen nicht zum Hash. */
  | "corrupt"
  /** Kein Inhalts-Hash (Datei aus der Swift-App, nur dort vorhanden). */
  | "not-addressable"
  | "http";

export class AssetError extends Error {
  constructor(
    readonly code: AssetErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AssetError";
  }
}

export interface QueuedUpload {
  hash: string;
  size: number;
  /** Endgültig gescheitert (wird nicht erneut versucht, bleibt sichtbar). */
  failed?: "too-large" | "rejected";
}

export interface AssetSyncStatus {
  /** Dateien, die noch hochgeladen werden müssen. */
  pending: number;
  /** Bytes davon, die der Server schon hat (laufender Upload) und Gesamtgröße. */
  uploadedBytes: number;
  totalBytes: number;
  downloading: number;
  /** Endgültig abgelehnte Uploads (zu groß …). */
  failed: number;
  lastError?: AssetErrorCode;
}

/** Der Teil von `SqlitePersistence`, den die Warteschlange braucht. */
export interface AssetMetaStore {
  meta(key: string): string | undefined;
  setMeta(key: string, value: string | undefined): void;
}

export interface AssetServer {
  /** z. B. https://based.example.com (ohne /sync). */
  baseURL: string;
  token: string;
}

export interface AssetSyncOptions {
  server?: AssetServer;
  fetch?: typeof fetch;
  /** Bytes pro Stück (Upload und Download). */
  chunkSize?: number;
  onStatus?: (status: AssetSyncStatus) => void;
  log?: (level: "info" | "warning" | "error", message: string) => void;
  /** Wartezeit nach einem gescheiterten Durchlauf: verdoppelt sich von `minMs` bis `maxMs`. */
  backoff?: { minMs: number; maxMs: number };
}

interface ServerLimits {
  maxBytes: number;
  chunkBytes: number;
}

export class AssetSync {
  private server: AssetServer | undefined;
  private readonly fetcher: typeof fetch;
  private readonly chunkSize: number;
  private readonly backoff: { minMs: number; maxMs: number };
  private queue: QueuedUpload[];
  private flushing: Promise<void> | undefined;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay: number;
  private stopped = false;
  private limits: ServerLimits | null | undefined; // null = Server kennt keine Assets
  private readonly downloads = new Map<string, Promise<Uint8Array>>();
  /** Angefangene Downloads (Stücke im Speicher): der nächste Versuch setzt dort fort. */
  private readonly partial = new Map<string, { chunks: Uint8Array[]; received: number }>();
  private uploadedBytes = 0;
  private lastError: AssetErrorCode | undefined;

  constructor(
    readonly blobs: AssetBlobStore,
    private readonly metaStore: AssetMetaStore,
    private readonly opts: AssetSyncOptions = {},
  ) {
    this.server = opts.server ? { baseURL: opts.server.baseURL.replace(/\/+$/, ""), token: opts.server.token } : undefined;
    this.fetcher = opts.fetch ?? ((...a) => fetch(...a));
    this.chunkSize = opts.chunkSize ?? DEFAULT_ASSET_CHUNK;
    this.backoff = opts.backoff ?? { minMs: 2_000, maxMs: 300_000 };
    this.retryDelay = this.backoff.minMs;
    this.queue = this.loadQueue();
  }

  // MARK: Zustand

  private loadQueue(): QueuedUpload[] {
    try {
      const v = JSON.parse(this.metaStore.meta(ASSET_QUEUE_KEY) ?? "[]") as unknown;
      if (!Array.isArray(v)) return [];
      return v.filter((x): x is QueuedUpload => typeof x === "object" && x !== null && isAssetHash((x as QueuedUpload).hash) && typeof (x as QueuedUpload).size === "number");
    } catch {
      return [];
    }
  }

  private saveQueue() {
    this.metaStore.setMeta(ASSET_QUEUE_KEY, this.queue.length > 0 ? JSON.stringify(this.queue) : undefined);
  }

  /** Hashes in der Warteschlange (Tests, Diagnose). */
  get queued(): readonly QueuedUpload[] {
    return this.queue;
  }

  status(): AssetSyncStatus {
    const open = this.queue.filter((q) => !q.failed);
    const s: AssetSyncStatus = {
      pending: open.length,
      uploadedBytes: this.uploadedBytes,
      totalBytes: open.reduce((n, q) => n + q.size, 0),
      downloading: this.downloads.size,
      failed: this.queue.length - open.length,
    };
    if (this.lastError) s.lastError = this.lastError;
    return s;
  }

  private emit() {
    this.opts.onStatus?.(this.status());
  }

  /** Server wechseln oder abschalten. Die Warteschlange bleibt; abgelehnte Uploads werden neu versucht. */
  configure(server: AssetServer | undefined) {
    this.server = server ? { baseURL: server.baseURL.replace(/\/+$/, ""), token: server.token } : undefined;
    this.limits = undefined;
    this.lastError = undefined;
    this.partial.clear();
    for (const q of this.queue) delete q.failed;
    this.saveQueue();
    this.retryDelay = this.backoff.minMs;
    this.stopped = false;
    if (this.server) this.flushSoon(0);
    this.emit();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  // MARK: HTTP

  private async http(method: string, path: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const server = this.server;
    if (!server) throw new AssetError("no-server", "No sync server configured");
    const req: RequestInit = { method, headers: { Authorization: `Bearer ${server.token}`, ...(init.headers ?? {}) } };
    if (init.body) {
      req.body = init.body as Uint8Array<ArrayBuffer>;
      (req.headers as Record<string, string>)["Content-Type"] = "application/octet-stream";
    }
    let res: Response;
    try {
      res = await this.fetcher(`${server.baseURL}/${path}`, req);
    } catch {
      throw new AssetError("offline", "The sync server can't be reached");
    }
    if (res.status === 401 || res.status === 403) throw new AssetError("unauthorized", "The sync server rejected the token", res.status);
    return res;
  }

  /** Grenzen aus /sync/v2/info; `null`, wenn der Server keine Assets kennt. */
  private async serverLimits(): Promise<ServerLimits | null> {
    if (this.limits !== undefined) return this.limits;
    const res = await this.http("GET", "sync/v2/info");
    if (!res.ok) throw new AssetError("http", `HTTP ${res.status} on sync/v2/info`, res.status);
    const info = (await res.json()) as { assets?: { maxBytes?: unknown; chunkBytes?: unknown } };
    const a = info.assets;
    this.limits = a && typeof a.maxBytes === "number" && typeof a.chunkBytes === "number" ? { maxBytes: a.maxBytes, chunkBytes: a.chunkBytes } : null;
    return this.limits;
  }

  // MARK: Hochladen

  /**
   * Neue Datei: lokal speichern und zum Hochladen vormerken. Gibt die Referenz für den Record zurück
   * (`id` = SHA-256; dieselben Bytes ergeben dieselbe Referenz).
   */
  async add(bytes: Uint8Array, name: string, mime?: string): Promise<StoredAsset> {
    const hash = await sha256Hex(bytes);
    if (!(await this.blobs.has(hash))) await this.blobs.put(hash, bytes);
    this.enqueue(hash, bytes.length);
    const ref: StoredAsset = { id: hash, name: name || "file", size: bytes.length };
    if (mime) ref.mime = mime;
    return ref;
  }

  /** Einen lokal vorhandenen Blob (erneut) zum Hochladen vormerken. */
  enqueue(hash: string, size: number) {
    const existing = this.queue.find((q) => q.hash === hash);
    if (existing) delete existing.failed;
    else this.queue.push({ hash, size });
    this.saveQueue();
    this.emit();
    this.flushSoon(0);
  }

  private flushSoon(delay: number) {
    if (this.stopped || !this.server) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, delay);
  }

  /**
   * Die Warteschlange einmal abarbeiten. Wirft nicht: bei Netzfehlern bleibt der Rest stehen und wird mit
   * wachsendem Abstand erneut versucht; zu große oder abgelehnte Dateien werden als gescheitert markiert.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          await this.flushOnce();
        } while (this.again && !this.stopped);
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async flushOnce() {
    if (!this.server || this.queue.every((q) => q.failed)) return;
    try {
      const limits = await this.serverLimits();
      if (limits === null) throw new AssetError("unsupported", "This sync server doesn't store files");
      for (const item of [...this.queue]) {
        if (item.failed) continue;
        const outcome = await this.upload(item, limits);
        if (outcome === "done") this.queue = this.queue.filter((q) => q.hash !== item.hash);
        else item.failed = outcome;
        this.uploadedBytes = 0;
        this.saveQueue();
        this.emit();
      }
      this.lastError = undefined;
      this.retryDelay = this.backoff.minMs;
    } catch (e) {
      const code = e instanceof AssetError ? e.code : "http";
      this.lastError = code;
      this.opts.log?.(code === "offline" ? "info" : "warning", `Assets: upload paused (${code})`);
      // Ein Server ohne Assets ändert sich nicht von selbst: erst bei neuer Einstellung wieder versuchen.
      if (code !== "unsupported") {
        this.flushSoon(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, this.backoff.maxMs);
      }
    }
    this.emit();
  }

  private async upload(item: QueuedUpload, limits: ServerLimits): Promise<"done" | "too-large" | "rejected"> {
    const bytes = await this.blobs.get(item.hash);
    if (!bytes) {
      this.opts.log?.("warning", "Assets: a queued file is no longer on this device; skipped");
      return "done";
    }
    if (bytes.length > limits.maxBytes) return "too-large";
    const path = `sync/v2/asset/${item.hash}`;
    const statusRes = await this.http("GET", `${path}/status`);
    if (!statusRes.ok) throw new AssetError("http", `HTTP ${statusRes.status} on asset status`, statusRes.status);
    const status = (await statusRes.json()) as { complete?: boolean; received?: number };
    if (status.complete) return "done"; // der Server hat die Datei schon (anderes Gerät, früherer Versuch)
    let offset = typeof status.received === "number" && status.received <= bytes.length ? status.received : 0;
    const step = Math.max(1, Math.min(this.chunkSize, limits.chunkBytes));
    let restarts = 0;
    for (;;) {
      this.uploadedBytes = offset;
      this.emit();
      const chunk = bytes.subarray(offset, Math.min(offset + step, bytes.length));
      const res = await this.http("PUT", `${path}?offset=${offset}&total=${bytes.length}`, { body: chunk });
      const reply = (await res.json().catch(() => ({}))) as { complete?: boolean; received?: number };
      if (res.ok) {
        if (reply.complete) return "done";
        offset = typeof reply.received === "number" ? reply.received : offset + chunk.length;
        if (offset >= bytes.length) throw new AssetError("http", "asset upload did not complete");
        continue;
      }
      if (res.status === 413) return "too-large";
      if ((res.status === 409 || res.status === 422) && restarts < 2) {
        // 409: der Server steht woanders (anderer Upload derselben Datei) → dort weiter. 422: Teil-Upload passte nicht → von vorn.
        restarts += 1;
        offset = res.status === 409 && typeof reply.received === "number" && reply.received <= bytes.length ? reply.received : 0;
        continue;
      }
      if (res.status === 422 || res.status === 400) return "rejected";
      throw new AssetError("http", `HTTP ${res.status} on asset upload`, res.status);
    }
  }

  // MARK: Herunterladen

  /** Liegt die Datei auf diesem Gerät? */
  hasLocal(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  /**
   * Bytes einer Datei: lokal, sonst vom Server (in Stücken, geprüft gegen den Hash, danach lokal gespeichert).
   * Wirft `AssetError` (`missing`, `offline`, `no-server`, …). Gleichzeitige Aufrufe teilen sich einen Download.
   */
  async get(hash: string, onProgress?: (received: number, total: number) => void): Promise<Uint8Array> {
    if (!isAssetHash(hash)) throw new AssetError("not-addressable", "This file is only stored on the device it was added on");
    const local = await this.blobs.get(hash);
    if (local) return local;
    const running = this.downloads.get(hash);
    if (running) return running;
    const p = this.download(hash, onProgress).finally(() => {
      this.downloads.delete(hash);
      this.emit();
    });
    this.downloads.set(hash, p);
    this.emit();
    return p;
  }

  private async download(hash: string, onProgress?: (received: number, total: number) => void): Promise<Uint8Array> {
    const path = `sync/v2/asset/${hash}`;
    const statusRes = await this.http("GET", `${path}/status`);
    if (statusRes.status === 404) throw new AssetError("unsupported", "This sync server doesn't store files", 404);
    if (!statusRes.ok) throw new AssetError("http", `HTTP ${statusRes.status} on asset status`, statusRes.status);
    const status = (await statusRes.json()) as { complete?: boolean; size?: number };
    if (!status.complete || typeof status.size !== "number") throw new AssetError("missing", "This file hasn't been uploaded yet by the device it was added on");
    const total = status.size;
    const state = this.partial.get(hash) ?? { chunks: [], received: 0 };
    this.partial.set(hash, state);
    while (state.received < total) {
      const end = Math.min(state.received + this.chunkSize, total) - 1;
      const res = await this.http("GET", path, { headers: { Range: `bytes=${state.received}-${end}` } });
      if (res.status === 404) throw new AssetError("missing", "This file is no longer on the sync server", 404);
      if (res.status !== 206 && res.status !== 200) throw new AssetError("http", `HTTP ${res.status} on asset download`, res.status);
      let chunk: Uint8Array;
      try {
        chunk = new Uint8Array(await res.arrayBuffer());
      } catch {
        throw new AssetError("offline", "The download was interrupted");
      }
      if (res.status === 200) {
        // Server ohne Range: die ganze Datei auf einmal.
        state.chunks = [chunk];
        state.received = chunk.length;
        if (chunk.length !== total) break;
      } else {
        if (chunk.length === 0) throw new AssetError("http", "empty range from server");
        state.chunks.push(chunk);
        state.received += chunk.length;
      }
      onProgress?.(Math.min(state.received, total), total);
    }
    const bytes = new Uint8Array(state.received);
    let at = 0;
    for (const c of state.chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    this.partial.delete(hash);
    if ((await sha256Hex(bytes)) !== hash) throw new AssetError("corrupt", "The downloaded file doesn't match its checksum");
    await this.blobs.put(hash, bytes);
    return bytes;
  }
}

/**
 * MIME-Typ für eine Blob-URL, aus den ersten Bytes erkannt. Nur Typen, die ein Browser gefahrlos anzeigen kann
 * (Rasterbilder, PDF, Audio, Video); alles andere – auch HTML und SVG, die in einer Blob-URL Skripte im Namen der
 * App ausführen könnten – ist `application/octet-stream` und wird damit heruntergeladen statt angezeigt.
 */
export function safeBlobType(bytes: Uint8Array): string {
  const at = (offset: number, ...sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (ascii(0, "ID3") || at(0, 0xff, 0xfb)) return "audio/mpeg";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  if (ascii(4, "ftyp")) {
    if (ascii(8, "avif")) return "image/avif";
    if (ascii(8, "heic") || ascii(8, "heix") || ascii(8, "mif1")) return "image/heic";
    if (ascii(8, "M4A ")) return "audio/mp4";
    if (ascii(8, "qt  ")) return "video/quicktime";
    return "video/mp4";
  }
  return "application/octet-stream";
}
