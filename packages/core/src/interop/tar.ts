// tar-Archiv lesen (Joplin-Export .jex). Nur was Exporte brauchen: gewöhnliche Dateien, ustar-Präfix, lange Namen
// (GNU „L“ und pax „path=“). Keine Links, keine Gerätedateien; unsichere Pfade („..“, absolut) fallen weg.
import { ImportFiles, normalizePath } from "./files.js";

const dec = new TextDecoder("utf-8");
const cstr = (b: Uint8Array) => { const end = b.indexOf(0); return dec.decode(end < 0 ? b : b.subarray(0, end)); };
const octal = (b: Uint8Array) => { const s = cstr(b).trim(); return s === "" ? 0 : parseInt(s, 8); };

/** Sieht der Anfang wie tar aus (Prüfsumme des ersten Kopfes stimmt)? */
export function isTar(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  const want = octal(bytes.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : bytes[i]!;
  return want > 0 && sum === want;
}

/** tar → Dateibaum; `undefined`, wenn es kein tar ist. */
export function extractTar(bytes: Uint8Array): ImportFiles | undefined {
  if (!isTar(bytes)) return undefined;
  const files = new ImportFiles();
  let at = 0;
  let longName: string | undefined;
  while (at + 512 <= bytes.length) {
    const head = bytes.subarray(at, at + 512);
    if (head.every((x) => x === 0)) break;
    const size = octal(head.subarray(124, 136));
    const type = String.fromCharCode(head[156] || 48);
    const prefix = cstr(head.subarray(345, 500));
    let name = cstr(head.subarray(0, 100));
    if (cstr(head.subarray(257, 262)) === "ustar" && prefix !== "") name = prefix + "/" + name;
    const start = at + 512;
    if (!Number.isFinite(size) || size < 0 || start + size > bytes.length) break;
    const data = bytes.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = cstr(data); continue; }
    if (type === "x") {
      // pax: „<länge> path=<name>\n“
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    const path = longName ?? name;
    longName = undefined;
    if (type !== "0" && type !== "7") continue; // nur gewöhnliche Dateien (Ordner entstehen von selbst)
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) continue;
    const p = normalizePath(path);
    if (p !== "") files.add(p, data);
  }
  return files;
}
