// BSD-541: Vektor-Ablage für die Suche nach Bedeutung – klein und ohne Zusatzindex.
// Je Abschnitt liegen zwei Formen des Vektors: Vorzeichen-Bits (dim/8 Byte) für die schnelle Vorauswahl über den
// Hamming-Abstand und int8 mit eigener Skala (dim + 4 Byte) für das Nachrechnen der besten Kandidaten.
// Bei 384 Dimensionen sind das 436 Byte je Abschnitt statt 1 536 Byte als Float32. Gesucht wird durch alles
// (kein ANN-Graph): bis in die Hunderttausende Abschnitte ist das schnell genug und braucht keinen Speicher extra.
// Abgeleitet, nie synchronisiert: die Datei darf jederzeit fehlen und wird neu berechnet.

const MAGIC = 0x42565831; // "BVX1"

export interface VectorHit {
  pageID: string;
  /** Laufende Nummer des Abschnitts auf der Seite. */
  chunk: number;
  score: number;
}

/** FNV-1a (32 Bit) über einen Text – erkennt unveränderte Abschnitte, ohne den Text zu speichern. */
export function textHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

export class VectorIndex {
  readonly words: number;
  private bits: Uint32Array;
  private q8: Int8Array;
  private scale: Float32Array;
  private hash: Uint32Array;
  /** Seite je Platz (Index in `pageIDs`), −1 = frei. */
  private owner: Int32Array;
  private ordinal: Uint16Array;
  private capacity: number;
  private used = 0;
  private free: number[] = [];
  private pageIDs: string[] = [];
  private pageIndex = new Map<string, number>();
  private slotsOf = new Map<number, number[]>();
  /** Seit dem letzten `serialize()` geändert. */
  dirty = false;

  constructor(readonly dim: number, readonly model: string, capacity = 256) {
    if (dim <= 0 || dim % 32 !== 0) throw new Error(`vector dimension must be a multiple of 32, got ${dim}`);
    this.words = dim / 32;
    this.capacity = capacity;
    this.bits = new Uint32Array(capacity * this.words);
    this.q8 = new Int8Array(capacity * dim);
    this.scale = new Float32Array(capacity);
    this.hash = new Uint32Array(capacity);
    this.owner = new Int32Array(capacity).fill(-1);
    this.ordinal = new Uint16Array(capacity);
  }

  /** Belegte Plätze (Abschnitte). */
  get size(): number {
    return this.used - this.free.length;
  }

  get pages(): number {
    return this.slotsOf.size;
  }

  /** Bytes der Vektordaten (ohne Seitenliste). */
  get bytes(): number {
    return this.size * (this.words * 4 + this.dim + 4 + 4 + 4 + 2);
  }

  has(pageID: string): boolean {
    const p = this.pageIndex.get(pageID);
    return p !== undefined && this.slotsOf.has(p);
  }

  /** Hashes der Abschnitte einer Seite in ihrer Reihenfolge (zum Vergleich mit dem aktuellen Text). */
  hashesOf(pageID: string): number[] {
    const p = this.pageIndex.get(pageID);
    const slots = p === undefined ? undefined : this.slotsOf.get(p);
    return slots ? slots.map((s) => this.hash[s]!) : [];
  }

  private grow() {
    const cap = this.capacity * 2;
    const copy = <T extends Uint32Array | Int8Array | Float32Array | Int32Array | Uint16Array>(a: T, n: number, fill?: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      if (fill !== undefined) b.fill(fill);
      b.set(a);
      return b;
    };
    this.bits = copy(this.bits, cap * this.words);
    this.q8 = copy(this.q8, cap * this.dim);
    this.scale = copy(this.scale, cap);
    this.hash = copy(this.hash, cap);
    this.owner = copy(this.owner, cap, -1);
    this.ordinal = copy(this.ordinal, cap);
    this.capacity = cap;
  }

  private write(slot: number, v: Float32Array) {
    const { dim, words } = this;
    let max = 0;
    for (let i = 0; i < dim; i++) {
      const a = Math.abs(v[i]!);
      if (a > max) max = a;
    }
    const k = max > 0 ? 127 / max : 0;
    const base = slot * dim;
    for (let i = 0; i < dim; i++) this.q8[base + i] = Math.round(v[i]! * k);
    // Länge des quantisierten Vektors merken: Kosinus = Skalarprodukt / (|q| · |v₈|)
    let n = 0;
    for (let i = 0; i < dim; i++) n += this.q8[base + i]! * this.q8[base + i]!;
    this.scale[slot] = n > 0 ? 1 / Math.sqrt(n) : 0;
    const wb = slot * words;
    for (let w = 0; w < words; w++) {
      let x = 0;
      for (let b = 0; b < 32; b++) if (v[w * 32 + b]! > 0) x |= 1 << b;
      this.bits[wb + w] = x >>> 0;
    }
  }

  removePage(pageID: string): void {
    const p = this.pageIndex.get(pageID);
    const slots = p === undefined ? undefined : this.slotsOf.get(p);
    if (p === undefined || !slots) return;
    for (const s of slots) {
      this.owner[s] = -1;
      this.free.push(s);
    }
    this.slotsOf.delete(p);
    this.dirty = true;
  }

  /**
   * Abschnitte einer Seite setzen. `vectors[i]` darf fehlen, wenn `hashes[i]` schon an derselben Stelle liegt
   * (unveränderter Abschnitt) – dann bleibt der vorhandene Vektor.
   */
  setPage(pageID: string, hashes: readonly number[], vectors: readonly (Float32Array | undefined)[]): void {
    let p = this.pageIndex.get(pageID);
    if (p === undefined) {
      p = this.pageIDs.length;
      this.pageIDs.push(pageID);
      this.pageIndex.set(pageID, p);
    }
    const old = this.slotsOf.get(p) ?? [];
    const next: number[] = [];
    const reuse = new Map<number, number[]>();
    for (const s of old) {
      const list = reuse.get(this.hash[s]!) ?? [];
      list.push(s);
      reuse.set(this.hash[s]!, list);
    }
    for (let i = 0; i < hashes.length; i++) {
      const h = hashes[i]!;
      const v = vectors[i];
      const kept = reuse.get(h)?.shift();
      if (kept !== undefined && !v) {
        this.ordinal[kept] = i;
        next.push(kept);
        continue;
      }
      if (kept !== undefined) reuse.get(h)!.unshift(kept);
      if (!v) throw new Error(`no vector for a new section of page ${pageID}`);
      if (v.length !== this.dim) throw new Error(`vector has ${v.length} dimensions, index has ${this.dim}`);
      let slot = this.free.pop();
      if (slot === undefined) {
        if (this.used === this.capacity) this.grow();
        slot = this.used++;
      }
      this.write(slot, v);
      this.hash[slot] = h;
      this.owner[slot] = p;
      this.ordinal[slot] = i;
      next.push(slot);
    }
    for (const list of reuse.values()) for (const s of list) {
      this.owner[s] = -1;
      this.free.push(s);
    }
    if (next.length) this.slotsOf.set(p, next);
    else this.slotsOf.delete(p);
    this.dirty = true;
  }

  /**
   * Die ähnlichsten Abschnitte. Zwei Stufen: Hamming-Abstand der Vorzeichen-Bits über alles, dann die besten
   * `preselect` mit int8 nachgerechnet (Kosinus). `filter` schließt Seiten aus.
   */
  search(query: Float32Array, k = 10, opts: { preselect?: number; filter?: (pageID: string) => boolean } = {}): VectorHit[] {
    if (query.length !== this.dim || this.size === 0 || k <= 0) return [];
    const { dim, words } = this;
    const qb = new Uint32Array(words);
    let qn = 0;
    for (let i = 0; i < dim; i++) {
      if (query[i]! > 0) qb[i >>> 5] = (qb[i >>> 5]! | (1 << (i & 31))) >>> 0;
      qn += query[i]! * query[i]!;
    }
    qn = Math.sqrt(qn) || 1;
    const pre = Math.max(k, Math.min(this.size, opts.preselect ?? Math.max(200, k * 20)));
    // Vorauswahl: Zählen nach Abstand (0…dim), dann die Schwelle bestimmen – ein Durchlauf, keine Sortierung über alles.
    const dist = new Uint16Array(this.used);
    const counts = new Uint32Array(dim + 1);
    for (let s = 0; s < this.used; s++) {
      if (this.owner[s]! < 0) {
        dist[s] = 0xffff;
        continue;
      }
      let d = 0;
      const wb = s * words;
      for (let w = 0; w < words; w++) d += popcount(this.bits[wb + w]! ^ qb[w]!);
      dist[s] = d;
      counts[d] = counts[d]! + 1;
    }
    let threshold = 0;
    for (let seen = 0; threshold <= dim; threshold++) {
      seen += counts[threshold]!;
      if (seen >= pre) break;
    }
    const out: VectorHit[] = [];
    for (let s = 0; s < this.used; s++) {
      if (dist[s]! > threshold) continue;
      const pageID = this.pageIDs[this.owner[s]!]!;
      if (opts.filter && !opts.filter(pageID)) continue;
      let dot = 0;
      const base = s * dim;
      for (let i = 0; i < dim; i++) dot += query[i]! * this.q8[base + i]!;
      out.push({ pageID, chunk: this.ordinal[s]!, score: (dot * this.scale[s]!) / qn });
    }
    out.sort((a, b) => b.score - a.score || (a.pageID < b.pageID ? -1 : a.pageID > b.pageID ? 1 : a.chunk - b.chunk));
    return out.slice(0, k);
  }

  /** Als eine Datei: Kopf, Seitenliste (JSON), dann die Felder dicht gepackt (freie Plätze entfallen). */
  serialize(): Uint8Array {
    const live: number[] = [];
    for (let s = 0; s < this.used; s++) if (this.owner[s]! >= 0) live.push(s);
    const ids: string[] = [];
    const remap = new Map<number, number>();
    for (const s of live) {
      const p = this.owner[s]!;
      if (!remap.has(p)) {
        remap.set(p, ids.length);
        ids.push(this.pageIDs[p]!);
      }
    }
    const meta = new TextEncoder().encode(JSON.stringify({ model: this.model, pages: ids }));
    const n = live.length;
    const pad = (4 - (meta.length % 4)) % 4;
    const head = 20 + meta.length + pad;
    const per = this.words * 4 + 4 + 4 + 4 + 2 + this.dim;
    const out = new Uint8Array(head + n * per);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, this.dim, true);
    dv.setUint32(12, n, true);
    dv.setUint32(16, meta.length, true);
    out.set(meta, 20);
    let o = head;
    for (const s of live) for (let w = 0; w < this.words; w++, o += 4) dv.setUint32(o, this.bits[s * this.words + w]!, true);
    for (const s of live) { dv.setFloat32(o, this.scale[s]!, true); o += 4; }
    for (const s of live) { dv.setUint32(o, this.hash[s]!, true); o += 4; }
    for (const s of live) { dv.setUint32(o, remap.get(this.owner[s]!)!, true); o += 4; }
    for (const s of live) { dv.setUint16(o, this.ordinal[s]!, true); o += 2; }
    for (const s of live) { out.set(new Uint8Array(this.q8.buffer, this.q8.byteOffset + s * this.dim, this.dim), o); o += this.dim; }
    this.dirty = false;
    return out;
  }

  /** Gegenstück zu `serialize`. `undefined`, wenn die Datei nicht passt (anderes Modell, andere Breite, beschädigt). */
  static deserialize(data: Uint8Array, expect: { dim: number; model: string }): VectorIndex | undefined {
    try {
      if (data.length < 20) return undefined;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 1) return undefined;
      const dim = dv.getUint32(8, true), n = dv.getUint32(12, true), metaLen = dv.getUint32(16, true);
      if (dim !== expect.dim) return undefined;
      const meta = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + metaLen))) as { model?: unknown; pages?: unknown };
      if (meta.model !== expect.model || !Array.isArray(meta.pages)) return undefined;
      const idx = new VectorIndex(dim, expect.model, Math.max(256, n));
      const words = idx.words;
      let o = 20 + metaLen + ((4 - (metaLen % 4)) % 4);
      if (data.length < o + n * (words * 4 + 14 + dim)) return undefined;
      for (let i = 0; i < n * words; i++, o += 4) idx.bits[i] = dv.getUint32(o, true);
      for (let i = 0; i < n; i++, o += 4) idx.scale[i] = dv.getFloat32(o, true);
      for (let i = 0; i < n; i++, o += 4) idx.hash[i] = dv.getUint32(o, true);
      const owners = new Uint32Array(n);
      for (let i = 0; i < n; i++, o += 4) owners[i] = dv.getUint32(o, true);
      for (let i = 0; i < n; i++, o += 2) idx.ordinal[i] = dv.getUint16(o, true);
      idx.q8.set(new Int8Array(data.buffer, data.byteOffset + o, n * dim));
      idx.pageIDs = (meta.pages as unknown[]).map(String);
      idx.pageIDs.forEach((id, p) => idx.pageIndex.set(id, p));
      const byPage = new Map<number, number[]>();
      for (let s = 0; s < n; s++) {
        const p = owners[s]!;
        if (p >= idx.pageIDs.length) return undefined;
        idx.owner[s] = p;
        const list = byPage.get(p) ?? [];
        list.push(s);
        byPage.set(p, list);
      }
      for (const [p, slots] of byPage) idx.slotsOf.set(p, slots.sort((a, b) => idx.ordinal[a]! - idx.ordinal[b]!));
      idx.used = n;
      return idx;
    } catch {
      return undefined;
    }
  }
}
