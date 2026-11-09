// Stabile IDs für importierte Inhalte und der Inhalts-Fingerabdruck des Reimport-Schutzes.
// Port von Swift BasedCore Interop/ImportBuilder.swift (`ImportIDs`, `Block.contentFingerprint`, BSD-32) und
// Store/VersionHistory.swift (`encode`, `hash`). Beide Hashes rechnen mit 64-Bit-Arithmetik wie Swift (`&*`, `&+`).
import { canonicalStringify } from "../json.js";
import type { Block } from "../model/records.js";
import { ENUMS } from "../model/schema.js";

const HEX = "0123456789abcdef";
const DASHED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TWO32 = 4294967296;
const utf8 = new TextEncoder();

/** 64-Bit-Zahl als [hi, lo] (je 32 Bit, vorzeichenlos). */
type U64 = [number, number];

/** x · 0x100000001b3 mod 2^64 (FNV-Primzahl = 2^40 + 0x1b3). */
function mulFNV(hi: number, lo: number): U64 {
  const l = lo * 0x1b3;
  const carry = Math.floor(l / TWO32);
  const nlo = l >>> 0;
  let nhi = (hi * 0x1b3 + carry) % TWO32;
  nhi = (nhi + ((lo * 256) % TWO32)) % TWO32;
  return [nhi >>> 0, nlo];
}

function add64(a: U64, b: U64): U64 {
  const lo = a[1] + b[1];
  return [((a[0] + b[0] + (lo >= TWO32 ? 1 : 0)) % TWO32) >>> 0, lo >>> 0];
}

const big = (x: U64) => (BigInt(x[0]) << 32n) | BigInt(x[1]);
const fromBig = (x: bigint): U64 => [Number((x >> 32n) & 0xffffffffn), Number(x & 0xffffffffn)];
const GOLDEN: U64 = [0x9e3779b9, 0x7f4a7c15];

/** Notion-ID (32 Hexziffern, mit oder ohne Striche) → kleingeschriebene UUID mit Strichen. */
export function notionUUID(raw: string): string | undefined {
  const h = raw.toLowerCase().replaceAll("-", "");
  if (h.length !== 32 || ![...h].every((c) => HEX.includes(c))) return undefined;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Swift `removingPercentEncoding` (nil bei ungültiger Kodierung). */
export function removingPercentEncoding(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

/** Die letzte Notion-ID in einem Datei-, URL- oder Pfadnamen („Project Plan 1a2b….html“, „…/Title-1a2b…?v=…“). */
export function notionIDInName(name: string): string | undefined {
  let s = name;
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = removingPercentEncoding(s) ?? s;
  // Swift sucht rückwärts: der am weitesten rechts beginnende Treffer.
  for (let i = s.length - 36; i >= 0; i--) {
    const m = DASHED.exec(s.slice(i, i + 36));
    if (m) return notionUUID(m[0]);
  }
  const chars = [...s.toLowerCase()];
  let found: string | undefined;
  let i = 0;
  while (i < chars.length) {
    if (HEX.includes(chars[i]!)) {
      let j = i;
      while (j < chars.length && HEX.includes(chars[j]!)) j++;
      if (j - i === 32) found = notionUUID(chars.slice(i, j).join(""));
      i = j;
    } else i++;
  }
  return found;
}

/** Deterministische UUID aus Texten (FNV-1a, 128 Bit) für Records ohne ID in der Quelle. */
export function derivedID(...parts: string[]): string {
  let a: U64 = [0xcbf29ce4, 0x84222325], b: U64 = [0x84222325, 0xcbf29ce4];
  parts.forEach((p, n) => {
    const bytes = utf8.encode(p + (n < parts.length - 1 ? "\u001f" : ""));
    for (const byte of bytes) {
      a = mulFNV(a[0], (a[1] ^ byte) >>> 0);
      b = add64(mulFNV(b[0], (b[1] ^ byte) >>> 0), GOLDEN);
    }
  });
  const out = new Uint8Array(16);
  for (let k = 0; k < 8; k++) {
    out[k] = k < 4 ? (a[1] >>> (k * 8)) & 0xff : (a[0] >>> ((k - 4) * 8)) & 0xff;
    out[8 + k] = k < 4 ? (b[1] >>> (k * 8)) & 0xff : (b[0] >>> ((k - 4) * 8)) & 0xff;
  }
  out[6] = (out[6]! & 0x0f) | 0x50;
  out[8] = (out[8]! & 0x3f) | 0x80;
  return notionUUID([...out].map((x) => HEX[x >> 4]! + HEX[x & 15]!).join(""))!;
}

export const ImportIDs = { notion: notionUUID, notionID: notionIDInName, derived: derivedID };

// MARK: Fingerabdruck (BSD-32)

/** Schlüssel in den Zusatzfeldern eines Blocks mit dem Fingerabdruck des letzten Imports. */
export const IMPORT_FINGERPRINT_KEY = "importFingerprint";

const KNOWN_BLOCK_KEYS = new Set(["id", "type", "parent", "sk", "text", "props", "values", "createdAt", "updatedAt", "createdBy", "updatedBy", "trashedAt", "stamp"]);
const BLOCK_TYPES = new Set<string>(ENUMS.BlockType);

/** Swift `VersionHistory.hash`: zwei 64-Bit-FNV-1a-Bahnen mit abschließender Durchmischung, hex. */
export function versionHash(bytes: Uint8Array): string {
  let a: U64 = [0xcbf29ce4, 0x84222325];
  const n = fromBig(BigInt(bytes.length));
  let b: U64 = [(0x84222325 ^ n[0]) >>> 0, (0xcbf29ce4 ^ n[1]) >>> 0];
  for (const byte of bytes) {
    a = mulFNV(a[0], (a[1] ^ byte) >>> 0);
    b = add64(mulFNV(b[0], (b[1] ^ byte) >>> 0), GOLDEN);
  }
  const M = 0xffffffffffffffffn;
  const mix = (x: bigint) => {
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return z ^ (z >> 31n);
  };
  const ab = big(a), bb = big(b);
  return mix(ab).toString(16).padStart(16, "0") + mix(bb ^ ab).toString(16).padStart(16, "0");
}

const isEmptyText = (t: Block["text"]) => t === undefined || (typeof t === "string" ? t.length === 0 : t.every((r) => !r.t));

/**
 * Hash dessen, was jemand ändern kann: Typ, Text, Eigenschaften, Zeilenwerte. Position, Zeiten, Autoren, Papierkorb,
 * Stempel und Zusatzfelder bleiben außen vor (Swift `Block.contentFingerprint`; JSON wie Swifts `JSONEncoder`
 * mit sortierten Schlüsseln, `/` maskiert).
 */
export function contentFingerprint(b: Block): string {
  const c: Record<string, unknown> = { id: b.id };
  if (BLOCK_TYPES.has(b.type)) c.type = b.type;
  c.parent = "w";
  c.sk = "";
  if (!isEmptyText(b.text)) c.text = b.text;
  if (b.props && Object.keys(b.props).some((k) => (b.props as Record<string, unknown>)[k] !== undefined)) c.props = b.props;
  if (b.values && Object.keys(b.values).length > 0) c.values = b.values;
  c.createdAt = -978_307_200;
  c.updatedAt = -978_307_200;
  c.stamp = { counter: 0, millis: 0, node: "" };
  return versionHash(utf8.encode(canonicalStringify(c).replaceAll("/", "\\/")));
}

/** Der Fingerabdruck, den der letzte Import gespeichert hat. */
export function importFingerprint(b: Block): string | undefined {
  const v = (b as Record<string, unknown>)[IMPORT_FINGERPRINT_KEY];
  return typeof v === "string" ? v : undefined;
}

/** Früher importiert und seitdem in Based geändert (false ohne Fingerabdruck). */
export function changedSinceImport(b: Block): boolean {
  const f = importFingerprint(b);
  return f !== undefined && f !== contentFingerprint(b);
}

/** Unbekannte Zusatzfelder eines Blocks (Swift `extra`). */
export function blockExtraKeys(b: Block): string[] {
  return Object.keys(b).filter((k) => !KNOWN_BLOCK_KEYS.has(k));
}
