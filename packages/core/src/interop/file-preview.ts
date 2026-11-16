// BSD-260 Teil 12 (Kern): Dateien in Seiten ansehen – was eine Vorschau zeigen kann, ohne die Datei zu verändern.
// Text- und Code-Dateien werden als Text gelesen (UTF-8, UTF-16 mit BOM, sonst Windows-1252), CSV/TSV als Tabelle
// (Trennzeichen erkannt: Komma, Semikolon wie in deutschem Excel, Tab, senkrechter Strich). Große Dateien werden nur
// angelesen (Grenzen in PreviewLimits); Binärdateien bekommen keine Textvorschau. Die Oberfläche (Editor) zeigt das an.
import { codeLanguageID } from "../editor/syntax.js";

export type PreviewKind = "image" | "pdf" | "audio" | "video" | "csv" | "text" | "none";

export interface PreviewLimits {
  /** Höchstens so viele Bytes lesen (Standard 256 KiB). */
  maxBytes?: number;
  /** Tabellen: höchstens so viele Zeilen (ohne Kopfzeile, Standard 200). */
  maxRows?: number;
  /** Tabellen: höchstens so viele Spalten (Standard 50). */
  maxColumns?: number;
}

export type FilePreview =
  | { kind: "image" | "pdf" | "audio" | "video" | "none" }
  | { kind: "text"; text: string; language: string; encoding: TextEncoding; truncated: boolean }
  | { kind: "csv"; header: string[]; rows: string[][]; delimiter: string; encoding: TextEncoding; truncated: boolean };

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

const ext = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
};

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "heif", "bmp", "ico"]);
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus", "weba"]);
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);
const TABLE = new Set(["csv", "tsv", "tab"]);

/** Dateiendung → Sprache des Codeblocks (Schlüssel aus CODE_LANGUAGES); „text“ für reinen Text. */
const TEXT_LANGUAGE: Record<string, string> = {
  txt: "text", text: "text", log: "text", ini: "text", cfg: "text", conf: "text", env: "text", rst: "text", tex: "text",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonl: "json", ndjson: "json", geojson: "json",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  css: "css", scss: "css", less: "css", html: "html", htm: "html", xml: "xml", plist: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", graphql: "graphql", gql: "graphql",
  diff: "diff", patch: "diff", mmd: "mermaid", mermaid: "mermaid",
};
const TEXT_NAMES: Record<string, string> = { dockerfile: "dockerfile", makefile: "text", readme: "text", license: "text" };

/** Welche Vorschau passt (nach Endung, dann MIME-Typ)? */
export function previewKind(name: string, mime?: string): PreviewKind {
  const e = ext(name);
  const m = (mime ?? "").toLowerCase().split(";")[0]!.trim();
  if (TABLE.has(e) || m === "text/csv" || m === "text/tab-separated-values") return "csv";
  if (e === "pdf" || m === "application/pdf") return "pdf";
  if (IMAGE.has(e) || m.startsWith("image/")) return "image";
  if (AUDIO.has(e) || m.startsWith("audio/")) return "audio";
  if (VIDEO.has(e) || m.startsWith("video/")) return "video";
  if (e in TEXT_LANGUAGE || e in TEXT_NAMES || m.startsWith("text/") || m === "application/json" || m === "application/xml") return "text";
  return "none";
}

/** Sprache für die Hervorhebung (Schlüssel aus CODE_LANGUAGES), „text“ wenn unbekannt. */
export function previewLanguage(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  const e = ext(name);
  return codeLanguageID(TEXT_LANGUAGE[e] ?? TEXT_NAMES[base] ?? "text") ?? "text";
}

/**
 * Bytes als Text lesen: BOM (UTF-8/UTF-16) entscheidet, sonst strenges UTF-8, sonst Windows-1252 (alte Windows-/Excel-
 * Dateien). `undefined` bei Binärdaten (NUL-Bytes ohne UTF-16-BOM). Ein am Ende abgeschnittenes UTF-8-Zeichen (Anlesen)
 * zählt nicht als Fehler.
 */
export function decodeTextBytes(bytes: Uint8Array, cut = false): { text: string; encoding: TextEncoding } | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1))), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1))), encoding: "utf-16be" };
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) return undefined;
  let body = bytes;
  if (cut) {
    // Bis zu 3 Folgebytes eines angefangenen Zeichens am Ende weglassen.
    let i = bytes.length - 1, back = 0;
    while (i >= 0 && back < 3 && (bytes[i]! & 0xc0) === 0x80) { i--; back++; }
    if (i >= 0 && bytes[i]! >= 0xc0) {
      const need = bytes[i]! >= 0xf0 ? 3 : bytes[i]! >= 0xe0 ? 2 : 1;
      if (need > back) body = bytes.subarray(0, i);
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

const DELIMITERS = [",", ";", "\t", "|"] as const;

/** Felder je Zeile für ein Trennzeichen (Anführungszeichen beachtet), für die ersten Zeilen. */
function fieldCounts(text: string, d: string, lines: number): number[] {
  const counts: number[] = [];
  let n = 1, q = false;
  for (let i = 0; i < text.length && counts.length < lines; i++) {
    const c = text[i];
    if (c === "\"") q = !q;
    else if (!q && c === d) n++;
    else if (!q && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      counts.push(n); n = 1;
    }
  }
  if (counts.length < lines && n > 1) counts.push(n);
  return counts;
}

/** Trennzeichen einer CSV-Datei erraten: das mit den meisten Spalten, die in allen ersten Zeilen gleich bleiben. */
export function sniffDelimiter(text: string, fileName = ""): string {
  if (/\.(tsv|tab)$/i.test(fileName)) return "\t";
  let best = ",", bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = fieldCounts(text, d, 20).filter((c, i, a) => i < a.length - 1 || c > 1);
    if (counts.length === 0) continue;
    const first = counts[0]!;
    if (first < 2) continue;
    const same = counts.filter((c) => c === first).length / counts.length;
    const score = same * first;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** CSV-Text in Zeilen zerlegen (RFC 4180, beliebiges Trennzeichen), höchstens `maxRows` Zeilen. */
export function parseDelimited(text: string, delimiter: string, maxRows = Infinity): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === "\"") { if (text[i + 1] === "\"") { field += "\""; i++; } else q = false; } else field += c;
    } else if (c === "\"" && field === "") q = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "")) {
        if (rows.length >= maxRows) return { rows, more: true };
        rows.push(row);
      }
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) {
      if (rows.length >= maxRows) return { rows, more: true };
      rows.push(row);
    }
  }
  return { rows, more: false };
}

/**
 * Vorschau einer Datei. Bilder, PDF, Audio, Video zeigt die Oberfläche selbst (nur die Art); Text und CSV werden hier
 * gelesen. Binärdaten mit Text-Endung → „none“.
 */
export function previewFile(file: { name: string; mime?: string; bytes: Uint8Array }, limits: PreviewLimits = {}): FilePreview {
  const kind = previewKind(file.name, file.mime);
  if (kind !== "text" && kind !== "csv") return { kind };
  const maxBytes = limits.maxBytes ?? 256 * 1024;
  const cut = file.bytes.length > maxBytes;
  const decoded = decodeTextBytes(cut ? file.bytes.subarray(0, maxBytes) : file.bytes, cut);
  if (!decoded) return { kind: "none" };
  if (kind === "text") return { kind, text: decoded.text, language: previewLanguage(file.name), encoding: decoded.encoding, truncated: cut };
  let text = decoded.text;
  // Angelesen: die letzte (vermutlich unvollständige) Zeile weglassen.
  if (cut) { const nl = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")); if (nl > 0) text = text.slice(0, nl); }
  const delimiter = sniffDelimiter(text, file.name);
  const maxRows = limits.maxRows ?? 200, maxColumns = limits.maxColumns ?? 50;
  const { rows, more } = parseDelimited(text, delimiter, maxRows + 1);
  const [header = [], ...body] = rows;
  const wide = rows.some((r) => r.length > maxColumns);
  const clip = (r: string[]) => (r.length > maxColumns ? r.slice(0, maxColumns) : r);
  return { kind, header: clip(header), rows: body.map(clip), delimiter, encoding: decoded.encoding, truncated: cut || more || wide };
}
