// BSD-78: Dateien (Bilder, Anhänge) als inhaltsadressierte Blobs neben der Workspace-Datenbank
// (docs/sync-protocol.md, „Assets“). Schlüssel ist der SHA-256 der Bytes (64 Hex-Zeichen, klein): gleiche Datei =
// gleicher Schlüssel = einmal gespeichert. Upload in Stücken mit Wiederaufnahme; fertig ist ein Blob erst, wenn der
// Hash der ganzen Datei stimmt. Logs und Fehlermeldungen enthalten nie Namen oder Inhalte.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceStore } from "@based/core";

export const ASSET_HASH = /^[0-9a-f]{64}$/;
/** Größte Datei (ADR 0006: jede Route hat eine Grenze). */
export const DEFAULT_MAX_ASSET_BYTES = 100 << 20; // 100 MiB
/** Größtes Stück pro PUT (Body-Grenze der Route). */
export const ASSET_CHUNK_LIMIT = 8 << 20; // 8 MiB
/** Angefangene Uploads ohne Fortschritt werden nach so vielen Tagen verworfen. */
export const PARTIAL_RETENTION_DAYS = 7;

/** Fehler mit HTTP-Status; `extra` kommt mit in die JSON-Antwort (z. B. `received`, `limit`). */
export class AssetError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, number | boolean> = {},
  ) {
    super(message);
    this.name = "AssetError";
  }
}

export interface AssetStatus {
  complete: boolean;
  /** Bytes, die der Server schon hat (bei `complete` die Dateigröße). */
  received: number;
  size?: number;
}

export interface AssetStoreOptions {
  maxBytes?: number;
  nowMillis?: () => number;
}

export class AssetStore {
  readonly maxBytes: number;
  private readonly nowMillis: () => number;
  /** Schreibvorgänge pro Hash nacheinander (zwei Geräte laden dieselbe Datei). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly dir: string,
    opts: AssetStoreOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
    this.nowMillis = opts.nowMillis ?? Date.now;
    mkdirSync(join(dir, "partial"), { recursive: true });
  }

  private final(hash: string) {
    return join(this.dir, hash.slice(0, 2), hash);
  }

  private partial(hash: string) {
    return join(this.dir, "partial", `${hash}.part`);
  }

  private sizeOf(path: string): number | undefined {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }

  status(hash: string): AssetStatus {
    const size = this.sizeOf(this.final(hash));
    if (size !== undefined) return { complete: true, received: size, size };
    return { complete: false, received: this.sizeOf(this.partial(hash)) ?? 0 };
  }

  /** Pfad und Größe eines fertigen Blobs. */
  locate(hash: string): { path: string; size: number } | undefined {
    const path = this.final(hash);
    const size = this.sizeOf(path);
    return size === undefined ? undefined : { path, size };
  }

  /**
   * Ein Stück anhängen. `offset` muss der bisher empfangenen Länge entsprechen (sonst 409 mit `received`);
   * `offset = 0` beginnt neu. Mit dem letzten Stück wird der Hash geprüft (422 bei Abweichung, der Teil-Upload
   * wird verworfen). Schon vorhandene Blobs: sofort `complete` (idempotent, Deduplizierung).
   */
  write(hash: string, offset: number, total: number, chunk: Buffer): Promise<AssetStatus> {
    const run = async (): Promise<AssetStatus> => {
      const done = this.status(hash);
      if (done.complete) return done;
      if (total > this.maxBytes) throw new AssetError(413, "asset too large", { limit: this.maxBytes });
      if (offset + chunk.length > total) throw new AssetError(400, "chunk exceeds total");
      const part = this.partial(hash);
      if (offset === 0) writeFileSync(part, chunk);
      else {
        if (offset !== done.received) throw new AssetError(409, "offset does not match", { received: done.received });
        appendFileSync(part, chunk);
      }
      const received = offset + chunk.length;
      if (received < total) return { complete: false, received };
      const actual = await hashFile(part);
      if (actual !== hash) {
        rmSync(part, { force: true });
        throw new AssetError(422, "content does not match its hash", { received: 0 });
      }
      mkdirSync(join(this.dir, hash.slice(0, 2)), { recursive: true });
      renameSync(part, this.final(hash));
      return { complete: true, received: total, size: total };
    };
    const prev = this.locks.get(hash) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    this.locks.set(hash, tail);
    void tail.then(() => {
      if (this.locks.get(hash) === tail) this.locks.delete(hash);
    });
    return next;
  }

  /** Hashes aller fertigen Blobs. */
  list(): string[] {
    const out: string[] = [];
    for (const d of readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.length !== 2) continue;
      for (const f of readdirSync(join(this.dir, d.name))) if (ASSET_HASH.test(f)) out.push(f);
    }
    return out;
  }

  private unreferencedPath() {
    return join(this.dir, "unreferenced.json");
  }

  private loadUnreferenced(): Record<string, number> {
    try {
      const v = JSON.parse(readFileSync(this.unreferencedPath(), "utf8")) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Aufräumen: ein Blob, den kein Record mehr nennt, wird vorgemerkt und erst gelöscht, wenn er `days` Tage lang
   * ununterbrochen ohne Referenz war (gleiche Frist wie die Tombstones: so lange kann ein Gerät offline gewesen
   * sein und einen Block mit der Datei noch zurückbringen). Wird er wieder referenziert, verfällt die Vormerkung.
   * Angefangene Uploads ohne Fortschritt seit `PARTIAL_RETENTION_DAYS` werden verworfen.
   */
  collect(referenced: ReadonlySet<string>, days: number, now = this.nowMillis()): { removed: number; marked: number; partials: number } {
    const since = this.loadUnreferenced();
    const next: Record<string, number> = {};
    let removed = 0;
    for (const hash of this.list()) {
      if (referenced.has(hash)) continue;
      const t = since[hash] ?? now;
      if (now - t >= days * 86_400_000) {
        rmSync(this.final(hash), { force: true });
        removed += 1;
      } else next[hash] = t;
    }
    writeFileSync(this.unreferencedPath(), JSON.stringify(next));
    let partials = 0;
    const partialDir = join(this.dir, "partial");
    for (const f of readdirSync(partialDir)) {
      const p = join(partialDir, f);
      if (now - statSync(p).mtimeMs >= PARTIAL_RETENTION_DAYS * 86_400_000) {
        rmSync(p, { force: true });
        partials += 1;
      }
    }
    return { removed, marked: Object.keys(next).length, partials };
  }

  /** Ordner entfernen (nur für temporäre Speicher in Tests). */
  destroy() {
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Alle Asset-Hashes, die irgendein Record nennt (Bildblock, Datei-Eigenschaft, Icon, Cover, Tonspur …): jede
 * Zeichenkette aus genau 64 Hex-Zeichen. Lieber eine zu viel behalten als eine Datei zu früh löschen.
 */
export function referencedAssets(store: WorkspaceStore): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length === 64 && ASSET_HASH.test(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) walk(x);
  };
  for (const r of store.allRecords()) walk(r.data);
  return out;
}

/** `Range: bytes=a-b` (ein Bereich). `undefined` = ganzer Blob, `null` = nicht erfüllbar (416). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | null {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}
