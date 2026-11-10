// BSD-154: Ein Y.Doc je Dokument-Wurzel (Seite oder Original eines Synced Blocks) und die Brücke zum Store.
//
//   Records ──(Projektion, Diff)──▶ Y.Doc ◀──(y-prosemirror)──▶ BlockNote
//   Records ◀──(materialisieren, Transaktion)── Y.Doc
//
// - Erstes Öffnen ohne gespeicherten Y-Zustand = Migration: die Records werden ins Y.Doc übernommen.
// - Lokale Änderungen (Editor, Yjs-Undo, künftig andere Geräte über Yjs) werden kurz gesammelt und dann als
//   eine Store-Transaktion geschrieben (`undoable: false` – Undo macht der Yjs-UndoManager im Editor).
// - Änderungen am Store von außen (Sync, Agenten, Shell) kommen mit eigenem Origin ins Y.Doc; der UndoManager
//   verfolgt nur Editor-Änderungen und überschreibt sie deshalb nie.
import type { WorkspaceStore } from "@based/core";
import * as Y from "yjs";
import type { BNBlock } from "../mapping/bn.js";
import { docBlockIDs, projectDoc } from "../mapping/blocks.js";
import { applyDocChanges, isEmptyChange, materializeDoc, type DocChanges } from "../mapping/materialize.js";
import { syncChildren } from "./xmldiff.js";

/** Origin für Änderungen aus dem Store (werden nicht zurückgeschrieben und nicht vom Undo erfasst). */
export const STORE_ORIGIN = { source: "based-store" } as const;
/** Origin beim Laden eines gespeicherten Zustands. */
export const LOAD_ORIGIN = { source: "based-load" } as const;
/** BlockNotes feste ID für den ersten Block eines leeren Dokuments (Kollaborations-Modus). */
const INITIAL_BLOCK_ID = "initialBlockId";
/** Name des XML-Fragments im Y.Doc. */
export const FRAGMENT = "blocks";

/** Wandelt zwischen BlockNote-Blöcken und Y-XML (der Editor-Kern mit dem Schema, siehe schema.tsx). */
export interface BlockConverter {
  toFragment(blocks: readonly BNBlock[], fragment: Y.XmlFragment): void;
  fromFragment(fragment: Y.XmlFragment): BNBlock[];
}

/** Ablage der Y-Zustände (eine Datei/Zeile je Wurzel). */
export interface YDocStore {
  load(rootID: string): Uint8Array | undefined;
  save(rootID: string, state: Uint8Array): void;
}

export class MemoryYDocStore implements YDocStore {
  private readonly states = new Map<string, Uint8Array>();
  load(rootID: string) {
    return this.states.get(rootID);
  }
  save(rootID: string, state: Uint8Array) {
    this.states.set(rootID, state);
  }
}

export interface DocSessionOptions {
  converter: BlockConverter;
  docStore?: YDocStore;
  /** Sammelzeit für Editor-Änderungen in ms (Standard 120). 0 = sofort (Tests). */
  debounceMs?: number;
  /** Speicherverzögerung für den Y-Zustand in ms (Standard 400). */
  saveDelayMs?: number;
}

export class DocSession {
  readonly doc = new Y.Doc();
  readonly fragment: Y.XmlFragment;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;
  private known = new Set<string>();
  private readonly unobserve: () => void;
  private readonly onY: (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void;
  private readonly onUpdate: () => void;
  private closed = false;

  constructor(readonly store: WorkspaceStore, readonly rootID: string, private readonly opts: DocSessionOptions) {
    this.fragment = this.doc.getXmlFragment(FRAGMENT);
    const saved = opts.docStore?.load(rootID);
    if (saved) Y.applyUpdate(this.doc, saved, LOAD_ORIGIN);
    // Migration (erstes Öffnen) und Nachziehen von Änderungen, die ohne offenen Editor passiert sind.
    this.reconcile();
    this.onY = (_events, tx) => {
      if (tx.origin === STORE_ORIGIN || tx.origin === LOAD_ORIGIN) return;
      this.markDirty();
    };
    this.fragment.observeDeep(this.onY);
    this.onUpdate = () => this.scheduleSave();
    this.doc.on("update", this.onUpdate);
    this.unobserve = store.observe((change) => {
      if (this.writing || this.closed) return;
      const ids = change.keys.filter((k) => k.startsWith("block:")).map((k) => k.slice(6));
      if (!ids.some((id) => this.isRelevant(id))) return;
      // Erst eigene, noch nicht geschriebene Änderungen sichern (ohne die gerade geänderten Records anzufassen),
      // dann den Store ins Y.Doc übernehmen.
      this.flush(new Set(ids));
      this.reconcile();
    });
    if (!saved) this.save();
  }

  private isRelevant(id: string): boolean {
    if (id === this.rootID || this.known.has(id)) return true;
    const b = this.store.blocks.get(id);
    if (!b || !b.parent.startsWith("b:")) return false;
    const p = b.parent.slice(2);
    return p === this.rootID || this.known.has(p);
  }

  /** Aktuelle Blöcke des Dokuments – immer aus dem Y.Doc (der Editor zieht bei Undo/Remote erst danach nach). */
  blocks(): BNBlock[] {
    return this.opts.converter.fromFragment(this.fragment);
  }

  private markDirty() {
    this.dirty = true;
    const ms = this.opts.debounceMs ?? 120;
    if (ms <= 0) {
      this.flush();
      return;
    }
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), ms);
  }

  /** Ausstehende Editor-Änderungen jetzt in den Store schreiben. `exclude`: Records, die gerade von außen kamen. */
  flush(exclude?: ReadonlySet<string>): DocChanges | undefined {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return undefined;
    this.dirty = false;
    const blocks = skipTrailingDraft(this.blocks(), this.store);
    let changes = materializeDoc(this.store, this.rootID, blocks, { now: this.store.now(), userID: this.store.userID });
    if (exclude && exclude.size) {
      changes = {
        puts: changes.puts.filter((b) => !exclude.has(b.id)),
        removeBlocks: changes.removeBlocks.filter((id) => !exclude.has(id)),
        removeViews: changes.removeViews,
        removeDatabases: changes.removeDatabases,
      };
    }
    if (!isEmptyChange(changes)) {
      this.writing = true;
      try {
        applyDocChanges(this.store, changes);
      } finally {
        this.writing = false;
      }
    }
    this.known = docBlockIDs(this.store, this.rootID);
    return changes;
  }

  /** Eine Store-Änderung, die das Y.Doc gleich selbst nachzieht (z. B. „Copy and sync“): nicht zurückspiegeln. */
  quietly<T>(fn: () => T): T {
    this.writing = true;
    try {
      return fn();
    } finally {
      this.writing = false;
      this.known = docBlockIDs(this.store, this.rootID);
    }
  }

  /** Store → Y.Doc (kleinster Diff, Origin STORE_ORIGIN). */
  reconcile(): void {
    const target = projectDoc(this.store, this.rootID);
    // Den leeren Absatz am Ende (BlockNote hält immer einen bereit) nicht wegnehmen, solange er nur im Editor existiert.
    const live = this.fragment.length ? this.opts.converter.fromFragment(this.fragment) : [];
    const last = live[live.length - 1];
    if (last && last.id !== INITIAL_BLOCK_ID && isDraft(last, this.store) && !target.some((b) => b.id === last.id)) target.push(last);
    // Ein leeres Dokument bekommt seinen ersten (leeren) Absatz mit eigener ID. Sonst legt BlockNote ihn an – im
    // Kollaborations-Modus mit der festen ID `initialBlockId`, und zwei leere Seiten teilten sich denselben Record
    // (der erste Absatz der einen Seite wanderte beim Schreiben auf die andere).
    if (target.length === 0) target.push({ id: globalThis.crypto.randomUUID(), type: "paragraph", props: {}, content: [], children: [] });
    const tmp = new Y.Doc();
    const tmpFragment = tmp.getXmlFragment(FRAGMENT);
    this.opts.converter.toFragment(target, tmpFragment);
    this.doc.transact(() => syncChildren(this.fragment, tmpFragment), STORE_ORIGIN);
    tmp.destroy();
    this.known = docBlockIDs(this.store, this.rootID);
  }

  private scheduleSave() {
    if (!this.opts.docStore || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => this.save(), this.opts.saveDelayMs ?? 400);
  }

  save() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.opts.docStore?.save(this.rootID, Y.encodeStateAsUpdate(this.doc));
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.save();
    this.closed = true;
    this.unobserve();
    this.fragment.unobserveDeep(this.onY);
    this.doc.off("update", this.onUpdate);
  }
}

/** Ein neuer, leerer Absatz ohne Kinder, den es im Store (noch) nicht gibt. */
function isDraft(b: BNBlock, store: WorkspaceStore): boolean {
  return b.type === "paragraph" && !store.blocks.has(b.id) && b.children.length === 0
    && (!Array.isArray(b.content) || b.content.length === 0);
}

/** Der leere Absatz am Ende entsteht beim Öffnen von selbst; er wird erst ein Record, wenn man hineinschreibt. */
function skipTrailingDraft(blocks: BNBlock[], store: WorkspaceStore): BNBlock[] {
  const last = blocks[blocks.length - 1];
  return last && isDraft(last, store) ? blocks.slice(0, -1) : blocks;
}

// MARK: Sitzungen teilen (mehrere Editoren auf derselben Wurzel, z. B. Synced Blocks)

const registry = new WeakMap<WorkspaceStore, Map<string, { session: DocSession; refs: number }>>();

export function acquireSession(store: WorkspaceStore, rootID: string, opts: DocSessionOptions): DocSession {
  let map = registry.get(store);
  if (!map) registry.set(store, (map = new Map()));
  const entry = map.get(rootID);
  if (entry) {
    entry.refs++;
    return entry.session;
  }
  const session = new DocSession(store, rootID, opts);
  map.set(rootID, { session, refs: 1 });
  return session;
}

export function releaseSession(session: DocSession): void {
  const map = registry.get(session.store);
  const entry = map?.get(session.rootID);
  if (!entry || entry.session !== session) {
    session.close();
    return;
  }
  if (--entry.refs > 0) return;
  map!.delete(session.rootID);
  session.close();
}
