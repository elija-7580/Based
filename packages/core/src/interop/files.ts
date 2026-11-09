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

export class ImportFiles {
  private readonly files = new Map<string, Uint8Array>();
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
  read(path: string): Uint8Array | undefined { return this.files.get(normalizePath(path)); }
  size(path: string): number | undefined { return this.read(path)?.length; }

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
    for (const [p, data] of other.files) this.add(joinPath(prefix, p), data);
  }
}
