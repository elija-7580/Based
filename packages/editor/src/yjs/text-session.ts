// ADR 0016 (E7): Echtzeit-Text für den neuen Block-Editor – ein Y.Text je Textblock in einem Y.Doc je Seite
// (Dokumentname `text:<seite>`, Y.Map „texts“: Block-ID → Y.Text). Struktur (Typ, Eltern, Reihenfolge, Props) bleibt
// in den Records und geht über Sync v2; nur der Text eines Blocks wird über Yjs gemergt.
//
// Abbildung RichText ⇄ Y.Text: gleiche Offsets (UTF-16). Marks sind Attribute (b, i, u, s, c, color, link).
// Erwähnungen und Formeln sind Text mit dem Attribut `mention` bzw. `eq` und einer eigenen `atom`-ID (damit zwei
// gleiche Erwähnungen nebeneinander zwei bleiben); ihre Länge ist ihr Text wie im Kern.
//
// Rollen (wie BSD-220, „nur der Server füllt“):
//  - Server: legt die Y.Texts aus den Records an, schreibt Y-Änderungen der Geräte als Records (Sync v2 → alle
//    Clients, auch Swift) und übernimmt Records von außen (MCP, Swift, Geräte ohne Echtzeit) per Diff ins Y.Doc.
//    Gepushte Records von Geräten, die gerade selbst an diesem Dokument hängen, übernimmt er nicht in ein schon
//    vorhandenes Y.Text: deren Text kommt über Yjs, ein Record kann dagegen schon veraltet sein.
//  - Gerät: Für Blöcke mit Y.Text ist das Y.Doc die Quelle. Eigene Befehle (Records) gehen per Diff ins Y.Text;
//    Records von außen und Y-Änderungen anderer werden aus dem Y.Doc abgeleitet („derived“, nicht gepusht). Ein Block
//    ohne Y.Text (gerade neu angelegt) läuft über Records, bis der Server sein Y.Text anlegt; was man bis dahin
//    tippt, geht beim ersten Binden ins Y.Text.
//
// Migration vom Seiten-Y.Doc (`page:<id>`, y-prosemirror): Das alte Dokument bleibt für den alten Editor; der
// Server materialisiert es in Records, und das neue Dokument wird aus genau diesen Records gefüllt. Beide Brücken
// laufen über die Records nebeneinander, bis E8 den alten Editor entfernt.
import { blockCommands, isPageLike, runsOf, toRichText, type Block, type RichText, type WorkspaceStore } from "@based/core";
import * as Y from "yjs";

/** Y.Map mit den Texten im Dokument. */
export const TEXTS = "texts";
/** Dokumentname auf dem Server. */
export const textDocName = (rootID: string) => `text:${rootID}`;
/** Origin für Änderungen aus dem Store (Server: Records → Y; Gerät: eigene Befehle → Y). */
export const TEXT_STORE_ORIGIN = { source: "based-text-store" } as const;

const MARK_KEYS = ["b", "i", "u", "s", "c", "color", "link"] as const;
type Attrs = Record<string, unknown>;
interface Run { t: string; m: Attrs; mention?: unknown; eq?: string }

// MARK: Abbildung

/** RichText eines Blocks als Läufe (Marks ohne leere Werte). */
function runsFrom(text: RichText | undefined): Run[] {
  return runsOf(text).map((r) => {
    const run: Run = { t: r.t, m: { ...r.m } };
    if (r.mention !== undefined) run.mention = r.mention;
    if (r.eq !== undefined) run.eq = r.eq;
    return run;
  });
}

/** Attribute eines Laufs für Y.Text – alle bekannten Schlüssel, nicht gesetzte als `null` (sonst erbt Yjs von links). */
function attrsOf(r: Run, atom?: string): Attrs {
  const a: Attrs = {};
  for (const k of MARK_KEYS) {
    const v = r.m[k];
    a[k] = v === undefined || v === false ? null : v;
  }
  a.mention = r.mention ?? null;
  a.eq = r.eq ?? null;
  a.atom = r.mention !== undefined || r.eq !== undefined ? atom ?? newAtom() : null;
  return a;
}

const newAtom = () => globalThis.crypto.randomUUID().slice(0, 8);

/** Y.Text → RichText (wie im Record gespeichert: zusammengefasst, reiner Text als String, leer = undefined). */
export function richTextOf(ytext: Y.Text): RichText | undefined {
  const raw: Record<string, unknown>[] = [];
  for (const op of ytext.toDelta() as { insert?: unknown; attributes?: Attrs }[]) {
    if (typeof op.insert !== "string" || op.insert === "") continue;
    const at = op.attributes ?? {};
    const run: Record<string, unknown> = { t: op.insert };
    const m: Attrs = {};
    for (const k of MARK_KEYS) if (at[k] !== undefined && at[k] !== null && at[k] !== false) m[k] = at[k];
    if (Object.keys(m).length) run.m = m;
    if (at.mention !== undefined && at.mention !== null) run.mention = at.mention;
    if (typeof at.eq === "string") run.eq = at.eq;
    raw.push(run);
  }
  const t = toRichText(runsOf(raw as never));
  return t === "" ? undefined : t;
}

/** Ein Zeichen mit seinen Attributen, zum Vergleichen (Atome als Ganzes). */
interface Piece { t: string; key: string; run: Run; atom?: string }

function piecesOfRuns(runs: readonly Run[]): Piece[] {
  const out: Piece[] = [];
  for (const r of runs) {
    const key = JSON.stringify(attrsOf(r, ""));
    if (r.mention !== undefined || r.eq !== undefined) out.push({ t: r.t, key, run: r });
    else for (const ch of r.t) for (let i = 0; i < ch.length; i++) out.push({ t: ch[i]!, key, run: r });
  }
  return out;
}

function piecesOfY(ytext: Y.Text): Piece[] {
  const runs: (Run & { atom?: string })[] = [];
  for (const op of ytext.toDelta() as { insert?: unknown; attributes?: Attrs }[]) {
    if (typeof op.insert !== "string") continue;
    const at = op.attributes ?? {};
    const m: Attrs = {};
    for (const k of MARK_KEYS) if (at[k] !== undefined && at[k] !== null && at[k] !== false) m[k] = at[k];
    const run: Run & { atom?: string } = { t: op.insert, m };
    if (at.mention !== undefined && at.mention !== null) run.mention = at.mention;
    if (typeof at.eq === "string") run.eq = at.eq;
    if (typeof at.atom === "string") run.atom = at.atom;
    runs.push(run);
  }
  const out: Piece[] = [];
  for (const r of runs) {
    const key = JSON.stringify(attrsOf(r, ""));
    if (r.mention !== undefined || r.eq !== undefined) out.push({ t: r.t, key, run: r, ...(r.atom ? { atom: r.atom } : {}) });
    else for (let i = 0; i < r.t.length; i++) out.push({ t: r.t[i]!, key, run: r });
  }
  return out;
}

const samePiece = (a: Piece, b: Piece) => a.t === b.t && a.key === b.key;

/**
 * Y.Text auf den Stand der Läufe bringen, mit möglichst kleiner Änderung: gleicher Anfang und gleiches Ende bleiben,
 * dazwischen wird gelöscht und eingefügt; ist nur die Formatierung anders, wird umformatiert (gleichzeitiges Tippen
 * eines anderen in diesem Bereich bleibt erhalten).
 */
export function writeRuns(ytext: Y.Text, text: RichText | undefined): boolean {
  const target = piecesOfRuns(runsFrom(text));
  const cur = piecesOfY(ytext);
  let p = 0;
  while (p < cur.length && p < target.length && samePiece(cur[p]!, target[p]!)) p++;
  let s = 0;
  while (s < cur.length - p && s < target.length - p && samePiece(cur[cur.length - 1 - s]!, target[target.length - 1 - s]!)) s++;
  const oldMid = cur.slice(p, cur.length - s);
  const newMid = target.slice(p, target.length - s);
  if (oldMid.length === 0 && newMid.length === 0) return false;
  const offset = (pieces: Piece[], n: number) => pieces.slice(0, n).reduce((x, q) => x + q.t.length, 0);
  const from = offset(cur, p);
  const sameText = oldMid.length === newMid.length && oldMid.every((q, i) => q.t === newMid[i]!.t && !q.run.mention && !newMid[i]!.run.mention && !q.run.eq && !newMid[i]!.run.eq);
  if (sameText) {
    // Nur Formatierung: abschnittsweise umformatieren.
    let pos = from;
    for (let i = 0; i < newMid.length;) {
      let j = i;
      let len = 0;
      while (j < newMid.length && newMid[j]!.key === newMid[i]!.key) { len += newMid[j]!.t.length; j++; }
      ytext.format(pos, len, attrsOf(newMid[i]!.run));
      pos += len;
      i = j;
    }
    return true;
  }
  const delLen = oldMid.reduce((x, q) => x + q.t.length, 0);
  if (delLen > 0) ytext.delete(from, delLen);
  let pos = from;
  for (let i = 0; i < newMid.length;) {
    const q = newMid[i]!;
    if (q.run.mention !== undefined || q.run.eq !== undefined) {
      ytext.insert(pos, q.t, attrsOf(q.run));
      pos += q.t.length;
      i++;
      continue;
    }
    let j = i;
    let str = "";
    while (j < newMid.length && newMid[j]!.key === q.key && newMid[j]!.run.mention === undefined && newMid[j]!.run.eq === undefined) { str += newMid[j]!.t; j++; }
    ytext.insert(pos, str, attrsOf(q.run));
    pos += str.length;
    i = j;
  }
  return true;
}

// MARK: Welche Blöcke

/** Textblöcke einer Seite (auch in Spalten, Toggles, Listen) – nicht in Unterseiten, Datenbanken oder Synced Blocks. */
export function textBlocksOf(store: WorkspaceStore, rootID: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (depth > 200) return;
    for (const c of store.children("b:" + id)) {
      const b = store.blocks.get(c);
      if (!b || b.trashedAt !== undefined) continue;
      if (isPageLike(b) || b.type === "databaseInline" || b.type === "syncedBlock" || b.type === "table") continue;
      if (blockCommands.TEXT_TYPES.has(b.type)) out.add(c);
      walk(c, depth + 1);
    }
  };
  walk(rootID, 0);
  return out;
}

/** Liegt der Block (noch) in dieser Seite? */
function inRoot(store: WorkspaceStore, rootID: string, b: Block | undefined): boolean {
  for (let cur = b, n = 0; cur && n < 400; n++) {
    if (cur.trashedAt !== undefined) return false;
    if (!cur.parent.startsWith("b:")) return false;
    const pid = cur.parent.slice(2);
    if (pid === rootID) return true;
    const p = store.blocks.get(pid);
    if (!p || isPageLike(p) || p.type === "databaseInline" || p.type === "syncedBlock" || p.type === "table") return false;
    cur = p;
  }
  return false;
}

// MARK: Sitzung

export interface TextSessionOptions {
  doc: Y.Doc;
  role: "server" | "device";
  /** Server: Sammelzeit für Y-Änderungen der Geräte, bevor sie als Records geschrieben werden (Standard 120 ms). */
  debounceMs?: number;
  /** Server: Knoten der Geräte, die gerade an diesem Dokument hängen (Awareness). */
  participants?: () => ReadonlySet<string>;
  /** Gerät: ein anderer hat den Text eines Blocks geändert (für die Schreibmarke: `delta` wie Y.Text). */
  onRemoteEdit?: (blockID: string, delta: readonly { insert?: unknown; delete?: number | undefined; retain?: number | undefined }[]) => void;
  onError?: (error: unknown) => void;
}

export class TextSession {
  readonly texts: Y.Map<Y.Text>;
  private writing = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<string>();
  /** Gerät: lokal geänderte Blöcke ohne Y.Text (ihr Text geht beim ersten Binden ins Y.Text). */
  private readonly unbound = new Set<string>();
  private readonly unobserve: () => void;
  private readonly onY: (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void;

  constructor(readonly store: WorkspaceStore, readonly rootID: string, private readonly opts: TextSessionOptions) {
    this.texts = opts.doc.getMap<Y.Text>(TEXTS);
    if (opts.role === "server") this.guarded(() => this.fill());
    else this.guarded(() => this.materialize([...this.texts.keys()]));

    this.onY = (events, tx) => {
      if (this.closed || tx.origin === TEXT_STORE_ORIGIN) return;
      const changed = new Set<string>();
      for (const ev of events) {
        if (ev.target === this.texts) {
          for (const [key, change] of (ev as Y.YMapEvent<Y.Text>).changes.keys) {
            if (change.action === "delete") continue;
            changed.add(key);
            // Gerät: ein neues Y.Text für einen Block, in den hier schon getippt wurde → lokaler Stand geht hinein.
            if (opts.role === "device" && this.unbound.has(key)) this.bindLocal(key);
          }
        } else if (ev.target instanceof Y.Text) {
          const id = ev.path[0];
          if (typeof id !== "string") continue;
          changed.add(id);
          if (opts.role === "device") opts.onRemoteEdit?.(id, (ev as Y.YTextEvent).delta);
        }
      }
      if (changed.size === 0) return;
      if (opts.role === "device") this.guarded(() => this.materialize([...changed]));
      else this.schedule(changed);
    };
    this.texts.observeDeep(this.onY);

    this.unobserve = store.observe((change) => {
      if (this.writing || this.closed) return;
      const ids = change.keys.filter((k) => k.startsWith("block:")).map((k) => k.slice(6));
      if (ids.length === 0) return;
      this.guarded(() => {
        if (opts.role === "server") this.fromStoreServer(ids, change.origin);
        else this.fromStoreDevice(ids, change.origin);
      });
    });
  }

  private guarded(fn: () => void) {
    if (!this.opts.onError) return fn();
    try {
      fn();
    } catch (e) {
      this.opts.onError(e);
    }
  }

  /** Server: alle Textblöcke der Seite ins Y.Doc (neue anlegen, abweichende per Diff, gelöschte weg). */
  fill() {
    const want = textBlocksOf(this.store, this.rootID);
    this.opts.doc.transact(() => {
      for (const id of want) this.toY(id);
      for (const key of [...this.texts.keys()]) if (!want.has(key)) this.texts.delete(key);
    }, TEXT_STORE_ORIGIN);
  }

  /** Record → Y.Text (legt es an, wenn es fehlt). */
  private toY(id: string): void {
    const b = this.store.blocks.get(id);
    if (!b) return;
    let yt = this.texts.get(id);
    if (!yt) {
      yt = new Y.Text();
      this.texts.set(id, yt);
    }
    writeRuns(yt, b.text);
  }

  private fromStoreServer(ids: string[], origin: string) {
    const parts = origin === "remote" ? this.opts.participants?.() : undefined;
    const doc = this.opts.doc;
    const stale: string[] = [];
    doc.transact(() => {
      for (const id of ids) {
        const b = this.store.blocks.get(id);
        const has = this.texts.has(id);
        const want = b !== undefined && blockCommands.TEXT_TYPES.has(b.type) && inRoot(this.store, this.rootID, b);
        if (!want) {
          if (has) this.texts.delete(id);
          continue;
        }
        // Text eines Geräts, das selbst über Yjs schreibt: kommt über das Y.Doc. Der Record kann älter sein und trotzdem
        // den neueren Stempel haben (er gewinnt dann LWW) – deshalb die Records wieder aus dem Y.Doc ableiten.
        if (has && parts && b.stamp && parts.has(b.stamp.node)) {
          stale.push(id);
          continue;
        }
        this.toY(id);
      }
    }, TEXT_STORE_ORIGIN);
    if (stale.length) this.schedule(stale);
  }

  private fromStoreDevice(ids: string[], origin: string) {
    const remote = origin === "remote" || origin === "load" || origin === "import";
    const toWrite: string[] = [];
    this.opts.doc.transact(() => {
      for (const id of ids) {
        const yt = this.texts.get(id);
        const b = this.store.blocks.get(id);
        if (!b || !blockCommands.TEXT_TYPES.has(b.type)) continue;
        if (!yt) {
          if (!remote && inRoot(this.store, this.rootID, b)) this.unbound.add(id);
          continue;
        }
        if (remote) toWrite.push(id);
        else writeRuns(yt, b.text);
      }
    }, TEXT_STORE_ORIGIN);
    // Records von außen: Y ist die Quelle (der Record vom Server kann älter sein als das Y.Doc).
    if (toWrite.length) this.materialize(toWrite);
  }

  /** Gerät: erstes Y.Text für einen hier schon bearbeiteten Block – der lokale Text gewinnt. */
  private bindLocal(id: string) {
    // Der lokale Text von jetzt (ein Record vom Server, der gleich noch kommen kann, ist älter); geschrieben wird nach
    // dem laufenden Y-Ereignis. Bis dahin bleibt der Block „ungebunden“ (nicht aus dem Y.Doc abgeleitet).
    const local = this.store.blocks.get(id)?.text;
    queueMicrotask(() => {
      if (this.closed || !this.unbound.delete(id)) return;
      const yt = this.texts.get(id);
      if (!yt || !this.store.blocks.has(id)) return;
      this.guarded(() => {
        this.opts.doc.transact(() => writeRuns(yt, local), TEXT_STORE_ORIGIN);
        this.materialize([id]);
      });
    });
  }

  private schedule(ids: Iterable<string>) {
    for (const id of ids) this.pending.add(id);
    const ms = this.opts.debounceMs ?? 120;
    if (ms <= 0) return this.guarded(() => this.flush());
    if (this.timer === undefined) this.timer = setTimeout(() => this.guarded(() => this.flush()), ms);
  }

  /** Server: gesammelte Y-Änderungen jetzt als Records schreiben. */
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const ids = [...this.pending];
    this.pending.clear();
    if (ids.length) this.materialize(ids);
  }

  /** Y.Text → Records (Server: normale Transaktion, wird gepusht; Gerät: „derived“, wird nicht gepusht). */
  private materialize(ids: readonly string[]) {
    const changes: [string, RichText | undefined][] = [];
    for (const id of ids) {
      const yt = this.texts.get(id);
      const b = this.store.blocks.get(id);
      if (!yt || !b || b.trashedAt !== undefined || !blockCommands.TEXT_TYPES.has(b.type)) continue;
      if (this.opts.role === "device" && this.unbound.has(id)) continue;
      const text = richTextOf(yt);
      if (JSON.stringify(text ?? "") !== JSON.stringify(b.text ?? "")) changes.push([id, text]);
    }
    if (changes.length === 0) return;
    this.writing = true;
    try {
      this.store.transact("Edit", (tx) => {
        for (const [id, text] of changes) tx.update(id, (x) => {
          if (text === undefined) delete x.text;
          else x.text = text;
        });
      }, this.opts.role === "device" ? { derived: true } : { undoable: false });
    } finally {
      this.writing = false;
    }
  }

  close() {
    if (this.closed) return;
    if (this.opts.role === "server") this.flush();
    this.closed = true;
    this.unobserve();
    this.texts.unobserveDeep(this.onY);
  }
}
