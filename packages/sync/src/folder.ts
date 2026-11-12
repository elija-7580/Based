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
import { keyOf, parseKey, safeParseRecord, type RecordKeyString, type RecordKind, type Stamp, type WireRecord, type WorkspaceStore } from "@based/core";

/** Dateizugriff (wie BackupTarget in @based/core): Pfade relativ zum Sync-Ordner. */
export interface FolderTarget {
  list(dir: string): Promise<string[]>;
  /** Atomar schreiben. */
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
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
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const KINDS = new Set<RecordKind>(["workspace", "block", "database", "view", "property"]);

export const segmentName = (seq: number) => String(seq).padStart(12, "0") + ".jsonl";

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
    const text = [JSON.stringify({ format: "based-folder-sync", v: 1, device: this.o.device, seq, count: lines.length }), ...lines, JSON.stringify({ end: true, count: lines.length })].join("\n") + "\n";
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
      for (const n of names) {
        const m = SEGMENT.exec(n);
        if (m) seqs.push(Number(m[1]));
        else result.ignored.push(`devices/${device}/${n}`);
      }
      seqs.sort((a, b) => a - b);
      let seen = this.st.seen[device] ?? 0;
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
    return result;
  }

  /** Eine Runde: erst schreiben, dann lesen. */
  async round(): Promise<FolderRoundResult> {
    const pushed = await this.push();
    return { pushed, ...(await this.pull()) };
  }
}

/** Schlüssel für einen Record (Hilfe für Tests/Hüllen). */
export const recordKeyOf = (kind: RecordKind, id: string) => keyOf(kind, id);
