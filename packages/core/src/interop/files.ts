// Virtueller Dateibaum für Importe: ein entpacktes ZIP, ein hochgeladener Ordner (`webkitdirectory`) oder einzelne
// Dateien. Ersetzt in der Web-Version das Dateisystem, mit dem die Swift-Importer arbeiten (FileManager, URL).
// Pfade sind POSIX-artig ohne führenden Schrägstrich („Export/Seite abc.html“); "" ist die Wurzel.
import { localizedStandardCompare } from "../query/value.js";

const decoder = new TextDecoder("utf-8");
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** Pfadbestandteile ohne leere und „.“; „..“ geht eine Ebene hoch (Swift `standardizedFileURL`). */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

export const joinPath = (dir: string, name: string) => normalizePath(dir === "" ? name : dir + "/" + name);
export const dirname = (path: string) => { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); };
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Endung ohne Punkt wie Swift `pathExtension` („a.tar.gz“ → „gz“, „.hidden“ → „“). */
export function extname(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i <= 0 || i === b.length - 1 ? "" : b.slice(i + 1);
}
/** Ohne Endung (Swift `deletingPathExtension`). */
export function stripExtension(path: string): string {
  const e = extname(path);
  return e === "" ? path : path.slice(0, path.length - e.length - 1);
}

/** Swift `localizedStandardCompare` für Pfade (Finder-Reihenfolge). */
export const comparePaths = (a: string, b: string) => localizedStandardCompare(a, b);

/**
 * BSD-254: Bytes, die nicht im Speicher liegen müssen – eine Datei (`Blob` im Worker, gelesen per FileReaderSync)
 * oder ein Bereich darin. `read` liefert genau `length` Bytes ab `offset` (oder wirft).
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

/** Quelle über einem Puffer (ohne Kopie). */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => {
      if (offset < 0 || offset + length > bytes.length) throw new RangeError("read past end");
      return bytes.subarray(offset, offset + length);
    },
  };
}

/** Bereich einer Quelle als eigene Quelle (gespeicherte ZIPs in ZIPs, ohne sie zu lesen). */
export function subSource(src: ByteSource, start: number, size: number): ByteSource {
  return {
    size,
    read: (offset, length) => {
      if (offset < 0 || offset + length > size) throw new RangeError("read past end");
      return src.read(start + offset, length);
    },
  };
}

/** Eine Datei, die erst beim Lesen geladen wird (BSD-254). `load` darf `undefined` liefern (unlesbar). */
export interface LazyFile {
  size: number;
  load(): Uint8Array | undefined;
  /** Rohe Bytes als Quelle (z. B. für ein ZIP im Baum, ohne es ganz zu laden). */
  source?: ByteSource;
}

/** Bis zu dieser Größe behält der Baum gelesene Dateien (HTML/CSV werden mehrfach gelesen), größere jedes Mal neu. */
const LAZY_CACHE_BYTES = 1 << 20;

export class ImportFiles {
  private readonly files = new Map<string, Uint8Array | LazyFile>();
  private readonly dirs = new Set<string>([""]);

  constructor(entries: Iterable<readonly [string, Uint8Array]> = []) {
    for (const [p, d] of entries) this.add(p, d);
  }

  /** Datei anlegen (Ordner entstehen implizit). */
  add(path: string, data: Uint8Array) {
    const p = normalizePath(path);
    if (p === "") return;
    this.files.set(p, data);
    this.addDirectory(dirname(p));
  }

  /** BSD-254: Datei, die erst beim Lesen geladen wird. */
  addLazy(path: string, file: LazyFile) {
    const p = normalizePath(path);
    if (p === "") return;
    this.files.set(p, file);
    this.addDirectory(dirname(p));
  }

  addDirectory(path: string) {
    let p = normalizePath(path);
    while (!this.dirs.has(p)) {
      this.dirs.add(p);
      p = dirname(p);
    }
  }

  remove(path: string) {
    this.files.delete(normalizePath(path));
  }

  get fileCount() {
    return this.files.size;
  }

  isFile(path: string) { return this.files.has(normalizePath(path)); }
  isDirectory(path: string) { return this.dirs.has(normalizePath(path)); }
  exists(path: string) { const p = normalizePath(path); return this.files.has(p) || this.dirs.has(p); }
  read(path: string): Uint8Array | undefined {
    const p = normalizePath(path);
    const f = this.files.get(p);
    if (f === undefined || f instanceof Uint8Array) return f;
    const data = f.load();
    if (data !== undefined && data.length <= LAZY_CACHE_BYTES) this.files.set(p, data);
    return data;
  }
  size(path: string): number | undefined {
    const f = this.files.get(normalizePath(path));
    return f === undefined ? undefined : f instanceof Uint8Array ? f.length : f.size;
  }
  /** Rohe Bytes als Quelle, ohne sie zu laden (wenn die Datei das kann); sonst über die gelesenen Bytes. */
  source(path: string): ByteSource | undefined {
    const f = this.files.get(normalizePath(path));
    if (f === undefined) return undefined;
    if (f instanceof Uint8Array) return bytesSource(f);
    if (f.source) return f.source;
    const data = this.read(path);
    return data === undefined ? undefined : bytesSource(data);
  }

  /** UTF-8, ungültige Bytes ersetzt (Swift `String(decoding:as:)`). */
  readText(path: string): string | undefined {
    const d = this.read(path);
    return d === undefined ? undefined : decoder.decode(d);
  }

  /** UTF-8 oder nichts (Swift `String(contentsOf:encoding: .utf8)`). */
  readStrictText(path: string): string | undefined {
    const d = this.read(path);
    if (d === undefined) return undefined;
    try {
      return strictDecoder.decode(d);
    } catch {
      return undefined;
    }
  }

  /** Unmittelbare Einträge eines Ordners (volle Pfade, unsortiert). */
  list(dir: string): string[] {
    const d = normalizePath(dir);
    const out = new Set<string>();
    const prefix = d === "" ? "" : d + "/";
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p === d || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest === "") continue;
      out.add(prefix + rest.split("/")[0]);
    }
    return [...out];
  }

  /** Alle Dateien unter `dir` (rekursiv). */
  walk(dir: string): string[] {
    const d = normalizePath(dir);
    const prefix = d === "" ? "" : d + "/";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix));
  }

  /** Teilbaum unter neuem Präfix (z. B. Inhalt eines entpackten ZIPs). */
  mount(prefix: string, other: ImportFiles) {
    this.addDirectory(prefix);
    for (const d of other.dirs) if (d !== "") this.addDirectory(joinPath(prefix, d));
    for (const [p, data] of other.files) {
      if (data instanceof Uint8Array) this.add(joinPath(prefix, p), data);
      else this.addLazy(joinPath(prefix, p), data);
    }
  }
}
