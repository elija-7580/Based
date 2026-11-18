// Dateien für Agenten (Elija 18.11.: Agenten sollen Bilder und Dateien auswählen und aufs Board legen können wie ein
// Mensch). Zwei Teile: (1) aus den Bytes im Dateispeicher erkennen, was eine Datei ist (Art, Größe, Bildmaße,
// PDF-Seiten) – damit reicht dem Agenten die Adresse; (2) Dateien in den Speicher legen (Base64, lokaler Pfad bei
// stdio, https-Adresse), inhaltsadressiert wie jeder Upload. Logs enthalten nie Namen oder Inhalte.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
    if (mime === "application/pdf" && found.size <= PDF_SCAN_MAX) {
      const pages = sniffPdfPages(readFileSync(found.path));
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

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => (isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1|::|fe80:|fc|fd|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip));

/** Eine Datei aus dem Netz holen: nur https, keine Adressen im eigenen Netz, keine Weiterleitungen, Größe begrenzt. */
export async function fetchRemote(url: string, max: number): Promise<{ bytes: Buffer; name: string; mime?: string }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new UploadError("not a valid URL"); }
  if (u.protocol !== "https:") throw new UploadError("only https URLs");
  const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
  if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) throw new UploadError("that address is not reachable from here");
  const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
  if (!res || !res.ok || !res.body) throw new UploadError(`could not download (${res?.status ?? "no answer"})`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += c.length;
    if (total > max) throw new UploadError(`the file is larger than ${Math.round(max / 1048576)} MB`);
    chunks.push(Buffer.from(c));
  }
  const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "") || u.hostname;
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim();
  return { bytes: Buffer.concat(chunks), name, ...(mime ? { mime } : {}) };
}
