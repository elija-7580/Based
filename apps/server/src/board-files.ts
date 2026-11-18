// Dateien für Agenten (Elija 18.11.: Agenten sollen Bilder und Dateien auswählen und aufs Board legen können wie ein
// Mensch). Zwei Teile: (1) aus den Bytes im Dateispeicher erkennen, was eine Datei ist (Art, Größe, Bildmaße,
// PDF-Seiten) – damit reicht dem Agenten die Adresse; (2) Dateien in den Speicher legen (Base64, lokaler Pfad bei
// stdio, http(s)-Adresse), inhaltsadressiert wie jeder Upload. Logs enthalten nie Namen oder Inhalte.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { basename } from "node:path";
import { sniffImageSize, sniffMime, sniffPdfPages, type BoardFileInfo } from "@based/core";
import { ASSET_CHUNK_LIMIT, type AssetStore } from "./assets.js";

const HEAD_BYTES = 256 * 1024;
/** PDFs bis zu dieser Größe werden für die Seitenzahl ganz gelesen; größere werden eine Dateikarte. */
const PDF_SCAN_MAX = 64 << 20;
const CACHE_MAX = 500;

// Inhalt unter einem Hash ändert sich nie: was einmal erkannt ist, bleibt richtig.
const sniffed = new Map<string, Partial<BoardFileInfo>>();
// Namen frisch hochgeladener Dateien, bis sie auf einem Board oder in einer Seite stehen (dort steht der Name dann).
const uploadedNames = new Map<string, { name: string; mime?: string }>();
const remember = <V>(m: Map<string, V>, k: string, v: V) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!); m.set(k, v); };

// Genaue Seitenmaße je PDF (pdf.js: jede Seite mit Drehung und geerbter MediaBox, auch in Objekt-Streams).
const exactPages = new Map<string, { width: number; height: number }[]>();
/** Höchstens so viele Seiten werden Objekte (wie beim Ablegen in der App, editor/whiteboard/pdf.ts). */
export const PDF_MAX_PAGES = 200;

/** Genaue Seitenmaße eines PDFs mit pdf.js; `undefined`, wenn es sich nicht lesen lässt. */
export async function pdfPageSizes(bytes: Uint8Array): Promise<{ width: number; height: number }[] | undefined> {
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
    try {
      const out: { width: number; height: number }[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
        const v = (await doc.getPage(i)).getViewport({ scale: 1 });
        out.push({ width: Math.round(v.width * 100) / 100, height: Math.round(v.height * 100) / 100 });
      }
      return out.length ? out : undefined;
    } finally {
      void doc.destroy();
    }
  } catch {
    return undefined;
  }
}

/**
 * PDFs unter diesen Adressen genau vermessen, bevor ein (synchrones) Werkzeug sie braucht. Schon vermessene und
 * Nicht-PDFs kosten nichts; höchstens `max` Dateien je Aufruf.
 */
export async function prepareFiles(assets: AssetStore, refs: Iterable<string>, max = 50): Promise<void> {
  const todo: string[] = [];
  for (const ref of refs) {
    const hash = hashOf(ref);
    if (!hash || exactPages.has(hash) || todo.includes(hash)) continue;
    if (assetFileInfo(assets, ref)?.mime !== "application/pdf") continue;
    todo.push(hash);
    if (todo.length >= max) break;
  }
  await Promise.all(todo.map(async (hash) => {
    const found = assets.locate(hash);
    if (!found || found.size > PDF_SCAN_MAX) return;
    const pages = await pdfPageSizes(readFileSync(found.path));
    if (!pages) return;
    remember(exactPages, hash, pages);
    const info = sniffed.get(hash);
    if (info) info.pages = pages;
  }));
}

const hashOf = (ref: string) => /^(?:based-asset:)?([0-9a-f]{64})$/.exec(ref)?.[1];

/** Was die Bytes über eine Datei sagen; `undefined`, wenn es sie im Speicher nicht gibt. */
export function assetFileInfo(assets: AssetStore, ref: string): Partial<BoardFileInfo> | undefined {
  const hash = hashOf(ref);
  if (!hash) return undefined;
  const found = assets.locate(hash);
  if (!found) return undefined;
  let info = sniffed.get(hash);
  if (!info) {
    info = { size: found.size };
    const head = readHead(found.path, Math.min(HEAD_BYTES, found.size));
    const mime = sniffMime(head);
    if (mime) info.mime = mime;
    const dims = mime?.startsWith("image/") ? sniffImageSize(head) : undefined;
    if (dims) { info.width = dims.width; info.height = dims.height; }
    // Grobe Erkennung sofort; die genaue (pdf.js, jede Seite) kommt mit `prepareFiles` und ersetzt sie.
    if (mime === "application/pdf" && found.size <= PDF_SCAN_MAX) {
      const pages = exactPages.get(hash) ?? sniffPdfPages(readFileSync(found.path));
      if (pages) info.pages = pages;
    }
    remember(sniffed, hash, info);
  }
  const named = uploadedNames.get(hash);
  return named ? { ...info, name: named.name, ...(info.mime ? {} : named.mime ? { mime: named.mime } : {}) } : info;
}

function readHead(path: string, n: number): Uint8Array {
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, n, 0); } finally { closeSync(fd); }
  return buf;
}

export class UploadError extends Error {}

/** Bytes in den Dateispeicher legen (vorhandene Datei: sofort fertig). Gibt die Adresse zurück. */
export async function storeBytes(assets: AssetStore, bytes: Buffer, name: string, mime?: string): Promise<string> {
  if (bytes.length === 0) throw new UploadError("the file is empty");
  if (bytes.length > assets.maxBytes) throw new UploadError(`the file is larger than ${Math.round(assets.maxBytes / 1048576)} MB`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  for (let off = 0; off < bytes.length; off += ASSET_CHUNK_LIMIT) {
    const status = await assets.write(hash, off, bytes.length, bytes.subarray(off, off + ASSET_CHUNK_LIMIT));
    if (status.complete) break;
  }
  remember(uploadedNames, hash, { name: name.slice(0, 200) || "file", ...(mime ? { mime } : {}) });
  return `based-asset:${hash}`;
}

/** Eine lokale Datei lesen (nur bei stdio: der Client läuft auf demselben Rechner wie der Server). */
export function readLocalFile(path: string, max: number): { bytes: Buffer; name: string } {
  let size: number;
  try { size = statSync(path).size; } catch { throw new UploadError("no such file"); }
  if (size > max) throw new UploadError(`the file is larger than ${Math.round(max / 1048576)} MB`);
  return { bytes: readFileSync(path), name: basename(path) };
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^(22[4-9]|2[3-5]\d)\./];
/** Adressen im eigenen Netz (und Sonderadressen) – dorthin holt der Server nie etwas. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip));
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return v6 === "::" || v6 === "::1" || /^(fe[89ab]|fc|fd|ff)/.test(v6);
}

/** DNS-Auflösung, die nur öffentliche Adressen durchlässt – die Verbindung geht genau an die geprüfte Adresse. */
const publicLookup: LookupFunction = (host, options, cb) => {
  dnsLookup(host, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 4);
    const list = (addrs as unknown as { address: string; family: number }[]);
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (list.length === 0 || bad) return cb(Object.assign(new Error("private address"), { code: "EPRIVATE" }), "", 4);
    if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
};

const MAX_REDIRECTS = 5;

/**
 * Eine Datei aus dem Netz holen: http und https, Weiterleitungen (höchstens fünf) werden einzeln geprüft, nie ins
 * eigene Netz (auch nicht über DNS-Tricks: verbunden wird mit der geprüften Adresse), Größe und Zeit begrenzt.
 */
export async function fetchRemote(url: string, max: number, timeoutMs = 30_000, lookup: LookupFunction = publicLookup): Promise<{ bytes: Buffer; name: string; mime?: string }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new UploadError("not a valid URL"); }
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new UploadError("only http and https URLs");
    if (u.username || u.password) throw new UploadError("URLs with a user name or password are not loaded");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host)) throw new UploadError("that address is not reachable from here");
    const res = await get(u, Math.max(1000, deadline - Date.now()), lookup);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new UploadError("too many redirects");
      try { u = new URL(res.headers.location, u); } catch { throw new UploadError("bad redirect"); }
      continue;
    }
    if (status < 200 || status >= 300) { res.resume(); throw new UploadError(`could not download (${status})`); }
    const declared = Number(res.headers["content-length"] ?? 0);
    if (declared > max) { res.destroy(); throw new UploadError(`the file is larger than ${Math.round(max / 1048576)} MB`); }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res as AsyncIterable<Buffer>) {
      total += c.length;
      if (total > max) { res.destroy(); throw new UploadError(`the file is larger than ${Math.round(max / 1048576)} MB`); }
      chunks.push(c);
    }
    const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(res.headers["content-disposition"] ?? ""))?.[1];
    let name = disposition ?? "";
    try { name = decodeURIComponent(name || u.pathname.split("/").filter(Boolean).pop() || ""); } catch { /* bleibt roh */ }
    const mime = String(res.headers["content-type"] ?? "").split(";")[0]?.trim();
    return { bytes: Buffer.concat(chunks), name: basename(name) || u.hostname, ...(mime ? { mime } : {}) };
  }
}

function get(u: URL, timeoutMs: number, lookup: LookupFunction): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method: "GET", lookup, headers: { "user-agent": "Based/1 (file import)", accept: "*/*" }, timeout: timeoutMs }, resolve);
    req.on("timeout", () => req.destroy(new UploadError("the download took too long")));
    req.on("error", (e: Error & { code?: string }) => reject(e instanceof UploadError ? e : new UploadError(e.code === "EPRIVATE" ? "that address is not reachable from here" : "could not download (no answer)")));
    req.end();
  });
}
