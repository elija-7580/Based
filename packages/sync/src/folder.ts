// BSD-296 (Spike, Standard aus): Sync über einen geteilten Ordner – gedacht für iCloud Drive (ADR 0015). Kein Server:
// jedes Gerät schreibt seine Änderungen als eigene Segment-Dateien, liest die der anderen und mischt sie mit derselben
// Last-Writer-Wins-Logik wie der Server (`WorkspaceStore.applyRemote`, HLC-Stempel).
//
//   devices/<gerät>/<seq, 12 Ziffern>.jsonl
//     {"format":"based-folder-sync","v":1,"device":"…","seq":7,"count":2}
//     {"op":"put","record":{"kind":"block","data":{…}}}
//     {"op":"del","key":"block:…","stamp":{…}}
//     {"end":true,"count":2}
//
// Regeln (Datenverlust, BSD-271):
// - Eine Datei ohne vollständige Endzeile, mit falscher Anzahl oder kaputtem JSON ist „noch nicht da“ (iCloud lädt
//   noch): sie wird übersprungen und später wieder gelesen; spätere Segmente desselben Geräts warten (Reihenfolge).
//   Nichts Undekodierbares wird je als Löschung gedeutet.
// - Konflikt-Kopien von iCloud („000000000007 2.jsonl“) und Platzhalter („.000000000007.jsonl.icloud“) passen nicht
//   zum Namensmuster und werden nur gemeldet.
// - Jedes Gerät schreibt nur in seinen eigenen Ordner; es gibt keine geteilte Datei, die zwei Geräte ändern.
// - Was per Ordner ankam, wird nicht zurückgeschrieben (Herkunft „remote“).
//
// BSD-334 (ADR 0015 Punkt 8): Cursor und Kompaktierung.
// - Nach jedem Lesen schreibt ein Gerät `devices/<gerät>/cursor.json` ({"seen":{"<anderes gerät>":seq}}).
// - Ein Gerät darf seine eigenen Segmente 1…N durch EINEN Schnappschuss `snapshot-<N, 12 Ziffern>.jsonl` ersetzen
//   (gleiches Format, Kopf mit "snapshot":true und seq = N; je Schlüssel die letzte Änderung aus 1…N), sobald
//   jedes andere Gerät im Ordner per cursor.json bestätigt hat, dass es bis N gelesen hat. Ein Gerät ohne cursor.json
//   hält die Kompaktierung auf. Erst wird der Schnappschuss geschrieben, dann werden die alten Dateien entfernt.
// - Ein neues Gerät (oder eines, dem Segment seen+1 fehlt) liest den neuesten Schnappschuss mit N > seen und macht bei
//   N+1 weiter. Ohne `remove` am Ziel wird nie kompaktiert.
import { keyOf, parseKey, safeParseRecord, type RecordKeyString, type RecordKind, type Stamp, type WireRecord, type WorkspaceStore } from "@based/core";

/** Dateizugriff (wie BackupTarget in @based/core): Pfade relativ zum Sync-Ordner. */
export interface FolderTarget {
  list(dir: string): Promise<string[]>;
  /** Atomar schreiben. */
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** BSD-334: Datei entfernen (nur für die Kompaktierung eigener Segmente; fehlt es, wird nie kompaktiert). */
  remove?(path: string): Promise<void>;
}

export interface FolderSyncOptions {
  store: WorkspaceStore;
  target: FolderTarget;
  /** Kennung dieses Geräts (Ordnername; Buchstaben, Ziffern, - und _). */
  device: string;
  /** Schalter (Standard aus): aus = nichts wird beobachtet, gelesen oder geschrieben. */
  enabled?: boolean;
  /** Stand von früher (`state()`), damit nach einem Neustart nicht alles neu gelesen wird. */
  state?: FolderSyncState;
  log?: (message: string) => void;
  /** BSD-334: ab so vielen eigenen Segmenten versucht `round()` zu kompaktieren (Standard 200). */
  compactAfter?: number;
}

export interface FolderSyncState {
  /** Nächste eigene Segment-Nummer. */
  nextSeq: number;
  /** Je fremdem Gerät: zuletzt gelesenes Segment. */
  seen: Record<string, number>;
}

export interface FolderRoundResult {
  pushed: number;
  received: number;
  /** Segmente, die (noch) nicht vollständig sind. */
  waiting: number;
  /** Dateien, die nicht ins Muster passen (Konflikt-Kopien, Platzhalter). */
  ignored: string[];
}

const SEGMENT = /^(\d{12})\.jsonl$/;
const SNAPSHOT = /^snapshot-(\d{12})\.jsonl$/;
const CURSOR = "cursor.json";
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const KINDS = new Set<RecordKind>(["workspace", "block", "database", "view", "property"]);

export const segmentName = (seq: number) => String(seq).padStart(12, "0") + ".jsonl";
export const snapshotName = (upTo: number) => "snapshot-" + segmentName(upTo);

/** Inhalt eines Segments/Schnappschusses als Datei (Kopf, Zeilen, Endzeile). */
function segmentText(device: string, seq: number, lines: string[], snapshot = false): string {
  const head: Record<string, unknown> = { format: "based-folder-sync", v: 1, device, seq, count: lines.length };
  if (snapshot) head.snapshot = true;
  return [JSON.stringify(head), ...lines, JSON.stringify({ end: true, count: lines.length })].join("\n") + "\n";
}

/** cursor.json eines Geräts lesen; `undefined` = fehlt oder unlesbar (dann wird nichts kompaktiert). */
function parseCursor(bytes: Uint8Array | undefined): Record<string, number> | undefined {
  if (!bytes) return undefined;
  try {
    const v = JSON.parse(dec.decode(bytes)) as { format?: unknown; seen?: unknown };
    if (v.format !== "based-folder-sync-cursor" || typeof v.seen !== "object" || v.seen === null) return undefined;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v.seen as Record<string, unknown>)) if (typeof n === "number" && Number.isInteger(n) && n >= 0) out[k] = n;
    return out;
  } catch {
    return undefined;
  }
}

type Parsed = { puts: WireRecord[]; dels: RecordKeyString[]; stamps: Map<RecordKeyString, Stamp> };

/** Ein Segment lesen; `undefined` = unvollständig oder kaputt (später noch einmal versuchen). */
export function parseSegment(bytes: Uint8Array, device: string, seq: number): Parsed | undefined {
  let text: string;
  try { text = dec.decode(bytes); } catch { return undefined; }
  if (!text.endsWith("\n")) return undefined;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 2) return undefined;
  let head: { format?: unknown; v?: unknown; device?: unknown; seq?: unknown; count?: unknown };
  let end: { end?: unknown; count?: unknown };
  try { head = JSON.parse(lines[0]!) as typeof head; end = JSON.parse(lines[lines.length - 1]!) as typeof end; } catch { return undefined; }
  if (head.format !== "based-folder-sync" || head.v !== 1 || head.device !== device || head.seq !== seq) return undefined;
  const body = lines.slice(1, -1);
  if (end.end !== true || end.count !== body.length || head.count !== body.length) return undefined;
  const out: Parsed = { puts: [], dels: [], stamps: new Map() };
  for (const line of body) {
    let v: { op?: unknown; record?: unknown; key?: unknown; stamp?: unknown };
    try { v = JSON.parse(line) as typeof v; } catch { return undefined; }
    if (v.op === "put") {
      const r = safeParseRecord(v.record);
      if (!r.ok) return undefined; // nie still verwerfen: das ganze Segment wartet
      out.puts.push(r.record);
    } else if (v.op === "del" && typeof v.key === "string") {
      const { kind } = parseKey(v.key as RecordKeyString);
      if (!KINDS.has(kind as RecordKind)) return undefined;
      out.dels.push(v.key as RecordKeyString);
      const s = v.stamp as Stamp | undefined;
      if (s && typeof s.millis === "number" && typeof s.counter === "number" && typeof s.node === "string") out.stamps.set(v.key as RecordKeyString, s);
    } else return undefined;
  }
  return out;
}

export class FolderSync {
  private readonly pending = new Set<RecordKeyString>();
  private unobserve: (() => void) | undefined;
  private st: FolderSyncState;

  constructor(private readonly o: FolderSyncOptions) {
    if (!DEVICE.test(o.device)) throw new Error("device id: letters, digits, - and _ only");
    this.st = o.state ? { nextSeq: o.state.nextSeq, seen: { ...o.state.seen } } : { nextSeq: 1, seen: {} };
    if (o.enabled) {
      this.unobserve = o.store.observe((c) => {
        // nur eigene Änderungen; was per Sync/Ordner kam, nicht zurückschreiben
        if (c.origin === "remote" || c.origin === "load" || c.origin === "derived") return;
        const notified = new Set(c.notified ?? []);
        for (const k of c.keys) if (!notified.has(k)) this.pending.add(k);
      });
    }
  }

  get enabled(): boolean { return this.o.enabled === true; }
  state(): FolderSyncState { return { nextSeq: this.st.nextSeq, seen: { ...this.st.seen } }; }
  stop() { this.unobserve?.(); this.unobserve = undefined; }

  /** Eigene Änderungen als ein Segment schreiben. */
  async push(): Promise<number> {
    if (!this.enabled || this.pending.size === 0) return 0;
    const keys = [...this.pending];
    const lines: string[] = [];
    for (const key of keys) {
      const r = this.o.store.record(key);
      if (r) lines.push(JSON.stringify({ op: "put", record: r }));
      else {
        const stamp = this.o.store.persistence?.tombstone(key);
        lines.push(JSON.stringify(stamp ? { op: "del", key, stamp } : { op: "del", key }));
      }
    }
    const seq = this.st.nextSeq;
    const text = segmentText(this.o.device, seq, lines);
    await this.o.target.write(`devices/${this.o.device}/${segmentName(seq)}`, enc.encode(text));
    this.st.nextSeq = seq + 1;
    for (const k of keys) this.pending.delete(k);
    return lines.length;
  }

  /** Segmente der anderen Geräte lesen und einmischen. */
  async pull(): Promise<Omit<FolderRoundResult, "pushed">> {
    const result = { received: 0, waiting: 0, ignored: [] as string[] };
    if (!this.enabled) return result;
    const devices = (await this.o.target.list("devices").catch(() => [])).filter((d) => d !== this.o.device);
    for (const device of devices) {
      if (!DEVICE.test(device)) { result.ignored.push(`devices/${device}`); continue; }
      const names = await this.o.target.list(`devices/${device}`).catch(() => []);
      const seqs: number[] = [];
      const snapshots: number[] = [];
      for (const n of names) {
        const m = SEGMENT.exec(n);
        const sm = SNAPSHOT.exec(n);
        if (m) seqs.push(Number(m[1]));
        else if (sm) snapshots.push(Number(sm[1]));
        else if (n !== CURSOR) result.ignored.push(`devices/${device}/${n}`);
      }
      seqs.sort((a, b) => a - b);
      let seen = this.st.seen[device] ?? 0;
      // BSD-334: Fehlt das nächste Segment (kompaktiert), den neuesten Schnappschuss dahinter lesen.
      const upTo = Math.max(0, ...snapshots);
      if (upTo > seen && !seqs.includes(seen + 1)) {
        const bytes = await this.o.target.read(`devices/${device}/${snapshotName(upTo)}`).catch(() => undefined);
        const parsed = bytes ? parseSegment(bytes, device, upTo) : undefined;
        if (!parsed) { result.waiting++; this.o.log?.(`folder sync: ${device}/${snapshotName(upTo)} is not complete yet`); continue; }
        this.o.store.applyRemote(parsed.puts, parsed.dels, parsed.stamps);
        result.received += parsed.puts.length + parsed.dels.length;
        seen = upTo;
        this.st.seen[device] = upTo;
      }
      for (const seq of seqs) {
        if (seq <= seen) continue;
        if (seq !== seen + 1) { result.waiting++; break; } // Lücke: früheres Segment noch nicht da
        const bytes = await this.o.target.read(`devices/${device}/${segmentName(seq)}`).catch(() => undefined);
        const parsed = bytes ? parseSegment(bytes, device, seq) : undefined;
        if (!parsed) { result.waiting++; this.o.log?.(`folder sync: ${device}/${segmentName(seq)} is not complete yet`); break; }
        this.o.store.applyRemote(parsed.puts, parsed.dels, parsed.stamps);
        result.received += parsed.puts.length + parsed.dels.length;
        seen = seq;
        this.st.seen[device] = seq;
      }
    }
    await this.writeCursor();
    return result;
  }

  private lastCursor = "";

  /** Eigenen Lesestand veröffentlichen (nur wenn er sich geändert hat). */
  private async writeCursor() {
    const text = JSON.stringify({ format: "based-folder-sync-cursor", v: 1, device: this.o.device, seen: this.st.seen });
    if (text === this.lastCursor) return;
    await this.o.target.write(`devices/${this.o.device}/${CURSOR}`, enc.encode(text + "\n"));
    this.lastCursor = text;
  }

  /**
   * BSD-334: Eigene Segmente, die alle anderen Geräte gelesen haben, durch einen Schnappschuss ersetzen. Gibt die Zahl
   * der entfernten Dateien zurück (0 = nichts zu tun oder noch nicht erlaubt).
   */
  async compact(): Promise<number> {
    const target = this.o.target;
    if (!this.enabled || !target.remove) return 0;
    const me = this.o.device;
    const others = (await target.list("devices").catch(() => [])).filter((d) => d !== me && DEVICE.test(d));
    // Wie weit haben alle anderen gelesen? Ein Gerät ohne lesbaren Cursor hält alles auf.
    let safe = this.st.nextSeq - 1;
    for (const d of others) {
      const cursor = parseCursor(await target.read(`devices/${d}/${CURSOR}`).catch(() => undefined));
      safe = Math.min(safe, cursor?.[me] ?? 0);
    }
    const names = await target.list(`devices/${me}`).catch(() => []);
    const mine = names.map((n) => SEGMENT.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).filter((n) => n <= safe).sort((a, b) => a - b);
    const oldSnapshots = names.map((n) => SNAPSHOT.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => a - b);
    if (mine.length < 2 && !(mine.length === 1 && oldSnapshots.length > 0)) return 0;
    // Letzte Änderung je Schlüssel aus altem Schnappschuss + Segmenten (in Reihenfolge).
    const last = new Map<string, string>();
    const prev = oldSnapshots[oldSnapshots.length - 1];
    const sources: { name: string; seq: number }[] = [...(prev !== undefined ? [{ name: snapshotName(prev), seq: prev }] : []), ...mine.map((n) => ({ name: segmentName(n), seq: n }))];
    for (const src of sources) {
      const bytes = await target.read(`devices/${me}/${src.name}`).catch(() => undefined);
      const parsed = bytes ? parseSegment(bytes, me, src.seq) : undefined;
      if (!parsed) { this.o.log?.(`folder sync: not compacting, ${src.name} is unreadable`); return 0; }
      for (const r of parsed.puts) last.set(keyOf(r.kind, r.data.id), JSON.stringify({ op: "put", record: r }));
      for (const k of parsed.dels) {
        const stamp = parsed.stamps.get(k);
        last.set(k, JSON.stringify(stamp ? { op: "del", key: k, stamp } : { op: "del", key: k }));
      }
    }
    const upTo = mine[mine.length - 1]!;
    await target.write(`devices/${me}/${snapshotName(upTo)}`, enc.encode(segmentText(me, upTo, [...last.values()], true)));
    let removed = 0;
    for (const n of mine) { await target.remove(`devices/${me}/${segmentName(n)}`); removed++; }
    for (const n of oldSnapshots) if (n < upTo) { await target.remove(`devices/${me}/${snapshotName(n)}`); removed++; }
    return removed;
  }

  /** Eine Runde: erst schreiben, dann lesen, ab `compactAfter` eigenen Segmenten kompaktieren. */
  async round(): Promise<FolderRoundResult> {
    const pushed = await this.push();
    const pulled = await this.pull();
    if (this.enabled && this.o.target.remove) {
      const own = (await this.o.target.list(`devices/${this.o.device}`).catch(() => [])).filter((n) => SEGMENT.test(n)).length;
      if (own >= (this.o.compactAfter ?? 200)) await this.compact();
    }
    return { pushed, ...pulled };
  }
}

/** Schlüssel für einen Record (Hilfe für Tests/Hüllen). */
export const recordKeyOf = (kind: RecordKind, id: string) => keyOf(kind, id);
