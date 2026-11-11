// BSD-73: Versionsverlauf pro Seite, portiert aus BasedCore Store/VersionHistory.swift – gespeichert wie ein
// git-Repository, inhaltsadressiert und dedupliziert:
//
// * Objekte: jeder Block einmal pro Inhalt, unter dem Hash dieses Inhalts (Tabelle `objects`, ein Flag-Byte
//   0 = roh, 1 = Deflate wie Apples `NSData.compressed(using: .zlib)`). Unveränderte Blöcke teilen sich ein Objekt.
// * Manifest (git: tree): die Blöcke der Seite in Dokumentreihenfolge als `id<TAB>hash`-Zeilen, selbst ein Objekt.
//   Gleiches Manifest = gleicher Inhalt; ein Schnappschuss ohne Änderung wird übersprungen.
// * Version (git: commit): Seite, Zeit, Manifest, Titel und Zählwerte für die Liste.
//
// Gleiches Tabellenformat wie Swift (`history.sqlite`, nie gesynct), damit die Datei austauschbar bleibt; die
// Speicherung selbst steckt hinter `HistoryStorage` (Speicher hier, SQLite in @based/sync).
//
// Abweichend von Swift (BSD-73): Schreibfehler werden nicht geschluckt – `record` wirft, und `known` merkt sich
// einen Hash erst, wenn die Transaktion gespeichert ist; fehlende Objekte meldet `blocksOf` (`missing`).
import { deflateSync, inflateSync } from "fflate";
import { canonicalStringify } from "../json.js";
import type { Block } from "../model/records.js";
import { plainText } from "../richtext.js";

export interface HistoryVersion {
  id: number;
  pageID: string;
  /** Zeitpunkt in Unix-Sekunden (wie Swifts Spalte `at` = `timeIntervalSince1970`). */
  at: number;
  manifest: string;
  title: string;
  blockCount: number;
  wordCount: number;
  /** `edit`, `opened`, `before restore`, `restored`. */
  reason: string;
}

export interface HistoryStats {
  versions: number;
  objects: number;
  bytes: number;
}

/** Ablage unter dem Verlauf (Tabellen `objects` und `versions` wie in Swift). Fehler werfen. */
export interface HistoryStorage {
  /** Gespeicherte Bytes (Flag-Byte + Nutzdaten) oder `undefined`. */
  getObject(hash: string): Uint8Array | undefined;
  /** `INSERT OR IGNORE`. */
  putObject(hash: string, stored: Uint8Array): void;
  insertVersion(v: Omit<HistoryVersion, "id">): number;
  /** Neueste zuerst (`ORDER BY at DESC, id DESC`). */
  versions(pageID: string, limit: number): HistoryVersion[];
  /** Alle Versionen nach Seite, dann neueste zuerst (für `prune`). */
  versionRefs(): { id: number; pageID: string; at: number }[];
  deleteVersions(ids: number[]): void;
  deletePageVersions(pageID: string): void;
  manifests(): string[];
  objectHashes(): string[];
  deleteObjects(hashes: string[]): void;
  stats(): HistoryStats;
  /** Führt `body` atomar aus (bei einem Fehler zurückgerollt). */
  transaction<T>(body: () => T): T;
}

/** Ablage im Speicher (Tests, Fallback ohne Datei). */
export class MemoryHistoryStorage implements HistoryStorage {
  readonly objects = new Map<string, Uint8Array>();
  rows: HistoryVersion[] = [];
  private nextID = 1;
  /** Für Tests: wirft beim nächsten Schreiben eines Objekts. */
  failNextPut: Error | undefined;

  getObject(hash: string) {
    return this.objects.get(hash);
  }
  putObject(hash: string, stored: Uint8Array) {
    if (this.failNextPut) {
      const e = this.failNextPut;
      this.failNextPut = undefined;
      throw e;
    }
    if (!this.objects.has(hash)) this.objects.set(hash, stored);
  }
  insertVersion(v: Omit<HistoryVersion, "id">) {
    const id = this.nextID++;
    this.rows.push({ id, ...v });
    return id;
  }
  versions(pageID: string, limit: number) {
    return this.rows.filter((r) => r.pageID === pageID).sort(newestFirst).slice(0, limit).map((r) => ({ ...r }));
  }
  versionRefs() {
    return [...this.rows].sort((a, b) => (a.pageID < b.pageID ? -1 : a.pageID > b.pageID ? 1 : newestFirst(a, b))).map(({ id, pageID, at }) => ({ id, pageID, at }));
  }
  deleteVersions(ids: number[]) {
    const drop = new Set(ids);
    this.rows = this.rows.filter((r) => !drop.has(r.id));
  }
  deletePageVersions(pageID: string) {
    this.rows = this.rows.filter((r) => r.pageID !== pageID);
  }
  manifests() {
    return [...new Set(this.rows.map((r) => r.manifest))];
  }
  objectHashes() {
    return [...this.objects.keys()];
  }
  deleteObjects(hashes: string[]) {
    for (const h of hashes) this.objects.delete(h);
  }
  stats() {
    let bytes = 0;
    for (const o of this.objects.values()) bytes += o.length;
    return { versions: this.rows.length, objects: this.objects.size, bytes };
  }
  transaction<T>(body: () => T): T {
    const objects = new Map(this.objects), rows = [...this.rows], next = this.nextID;
    try {
      return body();
    } catch (e) {
      this.objects.clear();
      for (const [k, v] of objects) this.objects.set(k, v);
      this.rows = rows;
      this.nextID = next;
      throw e;
    }
  }
}

const newestFirst = (a: { at: number; id: number }, b: { at: number; id: number }) => (b.at - a.at) || (b.id - a.id);

// MARK: Kodierung (byte-gleich zu Swift)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Ein Block so, wie Swift ihn für den Verlauf kodiert: `JSONEncoder` mit nur `.sortedKeys` – anders als bei den
 * Records also mit maskiertem `/` (`\/`). `/` kommt in JSON nur in Zeichenketten vor, das Ersetzen ist daher sicher.
 */
export function encodeVersionBlock(b: Block): string {
  return canonicalStringify(swiftShape(b)).replaceAll("/", "\\/");
}

/** Felder so, wie Swift `Block.encode` sie schreibt: leerer Text/leere Props/Werte entfallen, Stempel immer. */
function swiftShape(b: Block): Block {
  const out: Record<string, unknown> = { ...b };
  if (plainText(b.text) === "") delete out.text; // Swift: `if !text.isEmpty` (Länge der Läufe)
  if (b.props && Object.keys(b.props).length === 0) delete out.props;
  if (b.values && Object.keys(b.values).length === 0) delete out.values;
  if (!b.stamp) out.stamp = { counter: 0, millis: 0, node: "" };
  return out as Block;
}

const M32 = 0x1_0000_0000;
const MASK64 = (1n << 64n) - 1n;

/** 64-Bit-Wert als (hi, lo) mal FNV-Primzahl 0x100000001b3 = 2^40 + 0x1b3, modulo 2^64. */
function mulPrime(hi: number, lo: number): [number, number] {
  const pl = lo * 0x1b3;
  const carry = Math.floor(pl / M32);
  const nlo = pl - carry * M32;
  const nhi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) % M32;
  return [nhi >>> 0, nlo >>> 0];
}

function mix(x: bigint): bigint {
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

const big = (hi: number, lo: number) => (BigInt(hi) << 32n) | BigInt(lo);

/**
 * 128-Bit-Inhaltshash wie Swift `VersionHistory.hash`: zwei unabhängige FNV-1a-Spuren mit Avalanche am Ende, hex.
 * Nicht kryptographisch. Die Schleife rechnet in 32-Bit-Hälften (BigInt pro Byte wäre zu langsam).
 */
export function versionHash(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let ahi = 0xcbf29ce4, alo = 0x84222325;
  // b = 0x84222325cbf29ce4 ^ count
  const n = bytes.length;
  let bhi = (0x84222325 ^ Math.floor(n / M32)) >>> 0, blo = (0xcbf29ce4 ^ n) >>> 0;
  for (let i = 0; i < n; i++) {
    const byte = bytes[i]!;
    [ahi, alo] = mulPrime(ahi, (alo ^ byte) >>> 0);
    [bhi, blo] = mulPrime(bhi, (blo ^ byte) >>> 0);
    // + 0x9E3779B97F4A7C15
    const lsum = blo + 0x7f4a7c15;
    const c = lsum >= M32 ? 1 : 0;
    blo = (lsum - c * M32) >>> 0;
    bhi = (bhi + 0x9e3779b9 + c) % M32 >>> 0;
  }
  const a = big(ahi, alo), b = big(bhi, blo);
  return mix(a).toString(16).padStart(16, "0") + mix(b ^ a).toString(16).padStart(16, "0");
}

/** Ein Flag-Byte (0 = roh, 1 = Deflate) + Nutzdaten; komprimiert ab 97 Bytes, wenn es kleiner wird (wie Swift auf Apple). */
export function compressObject(data: Uint8Array, allowCompression = true): Uint8Array {
  if (allowCompression && data.length > 96) {
    const z = deflateSync(data);
    if (z.length < data.length) {
      const out = new Uint8Array(z.length + 1);
      out[0] = 1;
      out.set(z, 1);
      return out;
    }
  }
  const out = new Uint8Array(data.length + 1);
  out.set(data, 1);
  return out;
}

export function decompressObject(stored: Uint8Array): Uint8Array | undefined {
  if (stored.length === 0) return undefined;
  const body = stored.subarray(1);
  switch (stored[0]) {
    case 0: return body;
    case 1:
      try {
        return inflateSync(body);
      } catch {
        return undefined;
      }
    default: return undefined;
  }
}

/** Wörter wie Swift (`split` an Leerraum und Zeilenumbrüchen). */
export const wordCount = (b: Block): number => plainText(b.text).split(/\s+/u).filter((w) => w !== "").length;

export interface VersionContent {
  /** Seitenblock zuerst, dann der Inhalt in Dokumentreihenfolge. */
  blocks: Block[];
  /** Hashes, deren Objekt fehlt oder unlesbar ist (die Version ist dann unvollständig). */
  missing: string[];
}

export interface VersionHistoryOptions {
  /** Objekte komprimieren (Standard: ja). Swift unter Linux speichert roh; lesen kann jede Seite beides. */
  compress?: boolean;
}

/** Der Verlauf aller Seiten. Synchron (läuft im Store-Worker neben dem WorkspaceStore). */
export class VersionHistory {
  /** Hashes, die sicher gespeichert sind (spart ein INSERT pro unverändertem Block). */
  private known = new Set<string>();
  private readonly compress: boolean;

  constructor(readonly storage: HistoryStorage, opts: VersionHistoryOptions = {}) {
    this.compress = opts.compress ?? true;
  }

  /**
   * Speichert eine Version der Seite aus ihren Blöcken (Seitenblock zuerst, siehe `versionBlocks`). `null`, wenn sich
   * seit der letzten Version nichts geändert hat. Wirft, wenn das Speichern scheitert (nichts halb Gespeichertes).
   */
  record(pageID: string, blocks: Block[], title: string, reason = "edit", at = Date.now() / 1000): HistoryVersion | null {
    if (blocks.length === 0) return null;
    const stored: string[] = [];
    const result = this.storage.transaction(() => {
      const lines: string[] = [];
      let words = 0;
      for (const b of blocks) {
        // Jeder Block wird kodiert und gehasht (Swift cachte pro `updatedAt`; das verfehlt Änderungen mit
        // übernommenem Zeitstempel). Gespeichert wird nur, was noch nicht als Objekt da ist.
        const data = encoder.encode(encodeVersionBlock(b));
        const hash = versionHash(data);
        if (!this.known.has(hash)) {
          this.storage.putObject(hash, compressObject(data, this.compress));
          stored.push(hash);
        }
        lines.push(b.id + "\t" + hash);
        if (b.id !== pageID) words += wordCount(b);
      }
      const manifestData = encoder.encode(lines.join("\n"));
      const manifest = versionHash(manifestData);
      if (this.storage.versions(pageID, 1)[0]?.manifest === manifest) return null;
      if (!this.known.has(manifest)) {
        this.storage.putObject(manifest, compressObject(manifestData, this.compress));
        stored.push(manifest);
      }
      const v: Omit<HistoryVersion, "id"> = { pageID, at, manifest, title, blockCount: blocks.length - 1, wordCount: words, reason };
      return { id: this.storage.insertVersion(v), ...v };
    });
    // Erst nach dem Speichern merken (Swift merkte sich Hashes auch bei gescheitertem INSERT, BSD-73).
    for (const h of stored) this.known.add(h);
    return result;
  }

  /** Versionen einer Seite, neueste zuerst. */
  versions(pageID: string, limit = 500): HistoryVersion[] {
    return this.storage.versions(pageID, limit);
  }

  latest(pageID: string): HistoryVersion | undefined {
    return this.storage.versions(pageID, 1)[0];
  }

  private object(hash: string): Uint8Array | undefined {
    const s = this.storage.getObject(hash);
    return s && decompressObject(s);
  }

  /** Inhalt einer Version. Fehlende oder unlesbare Objekte stehen in `missing` statt still zu fehlen. */
  blocksOf(version: Pick<HistoryVersion, "manifest">): VersionContent {
    const m = this.object(version.manifest);
    if (!m) return { blocks: [], missing: [version.manifest] };
    const blocks: Block[] = [];
    const missing: string[] = [];
    for (const line of decoder.decode(m).split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const hash = line.slice(tab + 1);
      const data = this.object(hash);
      try {
        if (!data) throw new Error("missing");
        blocks.push(JSON.parse(decoder.decode(data)) as Block);
      } catch {
        missing.push(hash);
      }
    }
    return { blocks, missing };
  }

  stats(): HistoryStats {
    return this.storage.stats();
  }

  /**
   * Dünnt alte Versionen aus: alle der letzten 24 h, die neueste pro Stunde für 7 Tage, pro Tag für 90 Tage, pro
   * Woche danach. Gibt die Zahl entfernter Versionen zurück; danach `collectGarbage()`.
   */
  prune(now = Date.now() / 1000): number {
    const seen = new Set<string>();
    const drop: number[] = [];
    for (const { id, pageID, at } of this.storage.versionRefs()) {
      const age = now - at;
      let bucket: string;
      if (age < 86_400) continue;
      else if (age < 7 * 86_400) bucket = "h" + Math.trunc(at / 3600);
      else if (age < 90 * 86_400) bucket = "d" + Math.trunc(at / 86_400);
      else bucket = "w" + Math.trunc(at / (7 * 86_400));
      const key = pageID + bucket;
      if (seen.has(key)) drop.push(id);
      else seen.add(key);
    }
    if (drop.length) this.storage.transaction(() => this.storage.deleteVersions(drop));
    return drop.length;
  }

  /** Löscht Objekte, auf die keine Version mehr verweist (markieren über alle Manifeste, Rest wegräumen). */
  collectGarbage(): number {
    const live = new Set<string>();
    for (const m of this.storage.manifests()) {
      live.add(m);
      const d = this.object(m);
      if (!d) continue;
      for (const line of decoder.decode(d).split("\n")) {
        const tab = line.indexOf("\t");
        if (tab >= 0) live.add(line.slice(tab + 1));
      }
    }
    const dead = this.storage.objectHashes().filter((h) => !live.has(h));
    if (!dead.length) return 0;
    this.storage.transaction(() => this.storage.deleteObjects(dead));
    for (const h of dead) this.known.delete(h);
    return dead.length;
  }

  /** Entfernt alle Versionen einer Seite (endgültig gelöscht); Objekte räumt `collectGarbage` weg. */
  forget(pageID: string) {
    this.forgetAll([pageID]);
  }

  /**
   * Wie `forget`, für viele Seiten in einer Transaktion. Eine Transaktion je Seite hieß auf SQLite/OPFS ein
   * Schreibvorgang je Seite: „Papierkorb leeren“ mit 3.000 Seiten dauerte so rund 14 s (Feedback 11. 11.).
   */
  forgetAll(pageIDs: Iterable<string>) {
    const ids = [...pageIDs];
    if (!ids.length) return;
    this.storage.transaction(() => { for (const id of ids) this.storage.deletePageVersions(id); });
  }
}
