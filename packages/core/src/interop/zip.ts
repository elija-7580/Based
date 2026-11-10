// ZIP lesen und schreiben für Import und Export (Port von Swift Interop/Zip.swift und ZipWriter.swift, BSD-82).
// Das Inhaltsverzeichnis wird selbst gelesen (PKZIP 2.0 + ZIP64, UTF-8- und Info-ZIP-Unicode-Namen); entpackt wird mit
// fflate (MIT). Robust gegen feindliche Archive: Grenzen für Anzahl, Einzel- und Gesamtgröße und Kompressionsrate,
// Pfade ohne „..“, verschlüsselte oder unbekannte Einträge werden übersprungen und gemeldet, Abbruch zwischen Einträgen.
import { inflateSync, zipSync, type Zippable } from "fflate";
import { ImportFiles, bytesSource, extname, joinPath, stripExtension, subSource, type ByteSource } from "./files.js";

export type ZipErrorKind = "notAZip" | "corrupt" | "unsupported" | "checksum" | "limit" | "cancelled";

export class ZipError extends Error {
  constructor(readonly kind: ZipErrorKind, detail = "") {
    super(ZipError.describe(kind, detail));
    this.name = "ZipError";
  }
  static describe(kind: ZipErrorKind, s: string): string {
    switch (kind) {
      case "notAZip": return "The file is not a ZIP archive.";
      case "corrupt": return `The ZIP archive is damaged (${s}).`;
      case "unsupported": return `Unsupported ZIP feature: ${s}.`;
      case "checksum": return `Checksum mismatch in ${s}.`;
      case "limit": return `The ZIP archive is too large (${s}).`;
      case "cancelled": return "Cancelled.";
    }
  }
}

/** Abbruch eines Imports (von `isCancelled`). */
export class ImportCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "ImportCancelled";
  }
}

export interface ZipEntry {
  path: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export const isDirectoryEntry = (e: ZipEntry) => e.path.endsWith("/");
export const isEncryptedEntry = (e: ZipEntry) => (e.flags & 1) !== 0;

export interface ZipLimits {
  /** Höchstzahl der Einträge (über alle verschachtelten Archive). */
  maxEntries: number;
  /** Größte entpackte Datei in Bytes. */
  maxEntryBytes: number;
  /** Alles zusammen entpackt in Bytes. */
  maxTotalBytes: number;
  /** Größtes Verhältnis entpackt : gepackt einer Datei über 1 MB (Zip-Bombe). */
  maxRatio: number;
  /** Tiefe verschachtelter ZIPs, die ausgepackt werden (Notion: „Export-…-Part-1.zip“). */
  maxDepth: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 100_000,
  maxEntryBytes: 1 << 30,
  maxTotalBytes: 4 * (1 << 30),
  maxRatio: 1_000,
  maxDepth: 3,
};

// MARK: CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MARK: Lesen

/** Lokaler Dateikopf „PK\3\4“ oder leeres Archiv „PK\5\6“ (Swift `ZipArchive.isZip`). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

class Reader {
  constructor(private readonly b: Uint8Array, public pos = 0) {}
  get remaining() { return this.b.length - this.pos; }
  u8() { return this.pos < this.b.length ? this.b[this.pos++]! : (this.pos++, 0); }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  u64() { const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; }
  bytes(n: number) { const out = this.b.subarray(this.pos, this.pos + n); this.pos += n; return out; }
  skip(n: number) { this.pos = Math.min(this.b.length, this.pos + Math.max(0, n)); }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return String.fromCharCode(...bytes); // CP437 ≈ Latin-1 für Dateinamen (wie Swift)
  }
}

const asSource = (input: Uint8Array | ByteSource): ByteSource => (input instanceof Uint8Array ? bytesSource(input) : input);
const sig = (b: Uint8Array, i: number, c: number, d: number) => b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === c && b[i + 3] === d;

/**
 * Einträge aus dem zentralen Verzeichnis. BSD-254: auch aus einer Quelle (Datei im Worker) – gelesen werden nur das
 * Ende (EOCD, ZIP64) und das Verzeichnis selbst.
 */
export function readZipEntries(input: Uint8Array | ByteSource): ZipEntry[] {
  const src = asSource(input);
  const size = src.size;
  if (size < 22) throw new ZipError("notAZip");
  const tailStart = Math.max(0, size - (22 + 65_535 + 20));
  const tail = src.read(tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (sig(tail, i, 5, 6)) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("notAZip");
  const r = new Reader(tail, eocd + 4);
  r.u16(); r.u16(); r.u16();
  let total = r.u16();
  let cdSize = r.u32();
  let cdOffset = r.u32();
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || !sig(tail, loc, 6, 7)) throw new ZipError("corrupt", "missing ZIP64 locator");
    const off = new Reader(tail, loc + 8).u64();
    if (off + 56 > size) throw new ZipError("corrupt", "read past end");
    const rec = src.read(off, 56);
    if (!sig(rec, 0, 6, 6)) throw new ZipError("corrupt", "bad ZIP64 record");
    const z = new Reader(rec, 24);
    z.u64();
    total = z.u64();
    cdSize = z.u64();
    cdOffset = z.u64();
  }
  if (cdOffset > size || cdSize > size - cdOffset) throw new ZipError("corrupt", "central directory out of range");
  const p = new Reader(src.read(cdOffset, cdSize));
  const out: ZipEntry[] = [];
  while (p.remaining >= 46) {
    if (p.u32() !== 0x02014b50) break;
    p.u16(); p.u16();
    const flags = p.u16();
    const method = p.u16();
    p.u16(); p.u16();
    const crc = p.u32();
    let csize = p.u32();
    let usize = p.u32();
    const nameLen = p.u16(), extraLen = p.u16(), commentLen = p.u16();
    p.u16(); p.u16(); p.u32();
    let offset = p.u32();
    if (p.remaining < nameLen + extraLen + commentLen) throw new ZipError("corrupt", "truncated entry");
    let name = decodeName(p.bytes(nameLen));
    const extra = p.bytes(extraLen);
    p.skip(commentLen);
    const e = new Reader(extra);
    while (e.remaining >= 4) {
      const id = e.u16(), len = e.u16();
      if (e.remaining < len) break;
      const body = e.bytes(len);
      const b = new Reader(body);
      if (id === 0x0001) {
        if (usize === 0xffffffff && b.remaining >= 8) usize = b.u64();
        if (csize === 0xffffffff && b.remaining >= 8) csize = b.u64();
        if (offset === 0xffffffff && b.remaining >= 8) offset = b.u64();
      } else if (id === 0x7075 && body.length > 5) {
        try { name = utf8.decode(body.subarray(5)); } catch { /* Name aus dem Kopf behalten */ }
      }
    }
    out.push({ path: name.replaceAll("\\", "/"), method, flags, crc32: crc, compressedSize: csize, uncompressedSize: usize, localHeaderOffset: offset });
  }
  void total;
  return out;
}

/** Wo die gepackten Bytes eines Eintrags beginnen (nach dem lokalen Kopf). */
export function zipEntryStart(input: Uint8Array | ByteSource, entry: ZipEntry): number {
  const src = asSource(input);
  const h = entry.localHeaderOffset;
  if (h + 30 > src.size) throw new ZipError("corrupt", "read past end");
  const head = src.read(h, 30);
  if (!sig(head, 0, 3, 4)) throw new ZipError("corrupt", `bad local header for ${entry.path}`);
  const r = new Reader(head, 26);
  const start = h + 30 + r.u16() + r.u16();
  if (start + entry.compressedSize > src.size) throw new ZipError("corrupt", "read past end");
  return start;
}

/** Entpackte Bytes eines Eintrags (CRC geprüft). BSD-254: auch aus einer Quelle – gelesen wird nur dieser Eintrag. */
export function zipEntryData(input: Uint8Array | ByteSource, entry: ZipEntry): Uint8Array {
  if (isEncryptedEntry(entry)) throw new ZipError("unsupported", `encrypted entry ${entry.path}`);
  const src = asSource(input);
  const start = zipEntryStart(src, entry);
  const raw = src.read(start, entry.compressedSize);
  let out: Uint8Array;
  switch (entry.method) {
    case 0: out = raw; break;
    case 8:
      try {
        // Ausgabepuffer genau so groß wie angegeben: ein Eintrag, der mehr entpackt, scheitert statt den Speicher zu füllen.
        out = entry.uncompressedSize === 0 ? new Uint8Array(0) : inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) });
      } catch (e) {
        throw new ZipError("corrupt", `${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    default: throw new ZipError("unsupported", `compression method ${entry.method} (${entry.path})`);
  }
  if (out.length !== entry.uncompressedSize) throw new ZipError("corrupt", `size mismatch in ${entry.path}`);
  if (crc32(out) !== entry.crc32) throw new ZipError("checksum", entry.path);
  return out;
}

/** Sicherer relativer Pfad (kein absoluter Pfad, kein „..“, keine leeren Bestandteile). */
export function sanitizedZipPath(path: string): string | undefined {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  return parts.join("/");
}

export interface ExtractOptions {
  limits?: Partial<ZipLimits> | undefined;
  /** Verschachtelte .zip (Notion „Part-1.zip“) als gleichnamigen Ordner auspacken. */
  expandNested?: boolean | undefined;
  /** Fortschritt 0…1 nach entpackten Bytes. */
  progress?: ((fraction: number) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
}

export interface ExtractResult {
  files: ImportFiles;
  /** Geschriebene Dateien (verschachtelte Archive mitgezählt). */
  count: number;
  /** Übersprungene Einträge: „Pfad — Grund“. */
  skipped: string[];
}

/**
 * Packt ein Archiv in einen virtuellen Dateibaum aus (Swift `ZipArchive.extractAll`). Unsichere Pfade, `__MACOSX/`,
 * `.DS_Store`, verschlüsselte und unbekannt komprimierte Einträge werden übersprungen und in `skipped` gemeldet;
 * Grenzüberschreitungen (`ZipError` „limit“), kaputte Archive und Abbruch (`ImportCancelled`) brechen ab.
 */
export function extractZip(input: Uint8Array | ByteSource, opts: ExtractOptions = {}): ExtractResult {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...opts.limits };
  const state = { entries: 0, total: 0 };
  const files = new ImportFiles();
  const skipped: string[] = [];
  const count = extractInto(asSource(input), files, "", 0, limits, state, skipped, opts);
  return { files, count, skipped };
}

/**
 * BSD-254: Einträge bis zu dieser Größe behält der Baum entpackt; größere (Bilder, PDFs, Videos) werden geprüft und
 * wieder verworfen und erst beim Lesen erneut aus der Quelle entpackt. So liegt ein großer Export nie ganz im Speicher.
 */
export const ZIP_EAGER_BYTES = 256 << 10;

function extractInto(bytes: ByteSource, files: ImportFiles, prefix: string, depth: number, limits: ZipLimits,
                     state: { entries: number; total: number }, skipped: string[], opts: ExtractOptions): number {
  const entries = readZipEntries(bytes);
  state.entries += entries.length;
  if (state.entries > limits.maxEntries) throw new ZipError("limit", `more than ${limits.maxEntries} entries`);
  const totalBytes = Math.max(1, entries.reduce((n, e) => n + e.uncompressedSize, 0));
  let done = 0, count = 0;
  for (const entry of entries) {
    if (opts.isCancelled?.()) throw new ImportCancelled();
    const rel = sanitizedZipPath(entry.path);
    if (rel === undefined) { if (entry.path !== "" && entry.path !== "/") skipped.push(`${entry.path} — unsafe path`); continue; }
    if (rel.startsWith("__MACOSX/") || rel === "__MACOSX" || rel.endsWith(".DS_Store")) continue;
    const dest = joinPath(prefix, rel);
    if (isDirectoryEntry(entry)) { files.addDirectory(dest); continue; }
    if (isEncryptedEntry(entry)) { skipped.push(`${rel} — encrypted`); continue; }
    if (entry.method !== 0 && entry.method !== 8) { skipped.push(`${rel} — compression method ${entry.method}`); continue; }
    if (entry.uncompressedSize > limits.maxEntryBytes) throw new ZipError("limit", `${rel} is larger than ${limits.maxEntryBytes} bytes`);
    if (entry.uncompressedSize > 1_000_000 && entry.uncompressedSize > entry.compressedSize * limits.maxRatio) {
      throw new ZipError("limit", `${rel} expands more than ${limits.maxRatio}×`);
    }
    state.total += entry.uncompressedSize;
    if (state.total > limits.maxTotalBytes) throw new ZipError("limit", `more than ${limits.maxTotalBytes} bytes in total`);
    // BSD-254: ungepackt gespeicherte innere ZIPs (Notion-Teile, oft Hunderte MB) nicht erst ganz lesen: als Bereich
    // der äußeren Quelle auspacken (ihre Einträge haben eigene Prüfsummen).
    const nested = (opts.expandNested ?? true) && depth < limits.maxDepth && extname(rel).toLowerCase() === "zip";
    if (nested && entry.method === 0 && entry.compressedSize >= 4) {
      let start = -1;
      try {
        start = zipEntryStart(bytes, entry);
      } catch {
        // unten als beschädigt gemeldet
      }
      if (start >= 0 && isZip(bytes.read(start, 4))) {
        done += entry.uncompressedSize;
        if (depth === 0) opts.progress?.(done / totalBytes);
        try {
          count += 1 + extractInto(subSource(bytes, start, entry.compressedSize), files, stripExtension(dest), depth + 1, limits, state, skipped, { ...opts, progress: () => {} });
        } catch (e) {
          if (!(e instanceof ZipError) || (e.kind !== "corrupt" && e.kind !== "notAZip")) throw e;
          skipped.push(`${rel} — damaged (unreadable)`);
        }
        continue;
      }
    }
    let data: Uint8Array;
    try {
      data = zipEntryData(bytes, entry);
    } catch (e) {
      // BSD-82: ein beschädigter Eintrag kostet nur diese Datei, nicht den ganzen Import.
      if (e instanceof ZipError && (e.kind === "corrupt" || e.kind === "checksum" || e.kind === "unsupported")) {
        skipped.push(`${rel} — damaged (${e.kind === "checksum" ? "checksum mismatch" : e.kind === "unsupported" ? "unsupported" : "unreadable"})`);
        continue;
      }
      throw e;
    }
    done += entry.uncompressedSize;
    if (depth === 0) opts.progress?.(done / totalBytes);
    count += 1;
    if (nested && isZip(data)) {
      // Wie Swift: die innere .zip zählt mit und wird durch ihren Ordner ersetzt.
      count += extractInto(bytesSource(data), files, stripExtension(dest), depth + 1, limits, state, skipped, { ...opts, progress: () => {} });
      continue;
    }
    if (data.length <= ZIP_EAGER_BYTES) files.add(dest, data);
    else {
      const src = bytes, e = entry;
      files.addLazy(dest, {
        size: data.length,
        load: () => {
          try {
            return zipEntryData(src, e);
          } catch {
            return undefined;
          }
        },
        ...(entry.method === 0 ? { source: subSource(src, zipEntryStart(src, entry), entry.compressedSize) } : {}),
      });
    }
  }
  return count;
}

// MARK: Schreiben

export interface ZipWriteEntry {
  path: string;
  data: Uint8Array;
  /** Komprimieren (Text); Medien sind schon komprimiert und werden gespeichert (Standard: nach Endung). */
  compress?: boolean;
}

const STORED_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "m4v", "mp3", "m4a", "aac", "zip", "pdf", "webm"]);

/** ZIP schreiben (UTF-8-Namen; Medien gespeichert, Text komprimiert). `date` fest für reproduzierbare Archive. */
export function writeZip(entries: ZipWriteEntry[], when: Date = new Date()): Uint8Array {
  // DOS-Zeit kennt nur 1980…2099 (Swift ZipWriter begrenzt ebenso).
  const min = Date.UTC(1980, 0, 1, 12), max = Date.UTC(2099, 11, 31);
  const date = new Date(Math.min(max, Math.max(min, when.getTime())));
  const z: Zippable = {};
  for (const e of entries) {
    const compress = e.compress ?? !STORED_EXT.has(extname(e.path).toLowerCase());
    z[e.path] = [e.data, { level: compress ? 6 : 0, mtime: date }];
  }
  return zipSync(z, { mtime: date });
}
