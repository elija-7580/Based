// BSD-264 (Whiteboard 2): die offene Sitzung eines Boards. Quelle sind die Records der Seite (@based/core
// whiteboard/records.ts); das Y.Doc (Schema aus BSD-263, yboard.ts) ist das lebende Modell der offenen Fläche:
// Undo/Redo über den Y.UndoManager, feldgenaues Zusammenführen, später Präsenz und Echtzeit.
//
// Regeln:
// - Das Y.Doc lebt nur im Speicher. Es kommt nie nach ydocs.sqlite und nie an /collab: ein lokal aus Records gefüllter
//   Stand hätte andere Yjs-Items als ein Server-Stand, beim Zusammenführen stünde alles doppelt da (yjs/collab.ts).
// - Ein Undo-Stapel: nur der UndoManager. In den Store schreibt die Sitzung mit `undoable: false`.
// - Eigene Änderungen (Herkunft BOARD_LOCAL) und Undo/Redo gehen in den Store; alles, was der Store meldet und nicht
//   von hier kam (Sync, Wiederherstellen, Undo des Stores, andere Fenster), wird mit BOARD_STORE ins Y.Doc gespielt –
//   der UndoManager verfolgt es nicht, und es wird nicht zurückgeschrieben (kein Echo).
import * as Y from "yjs";
import {
  BOARD_OBJECT_TYPE, boardObjectFromBlock, boardObjectsOf, boardObjectToBlock, danglingConnectors, keyBetween, keyOf, parseKey, sameBoardObject, sortByZ, wbFields,
  type StoreChange, type WBObject, type WorkspaceStore,
} from "@based/core";
import { addObject, boardObjectsMap, readObject } from "./yboard.js";
import type { PresenceChannel } from "../yjs/collab.js";

export type BoardBackground = "dots" | "lines" | "grid" | "plain";
export const BOARD_BACKGROUNDS: readonly { id: BoardBackground; label: string }[] = [{ id: "dots", label: "Dots" }, { id: "lines", label: "Ruled lines" }, { id: "grid", label: "Squared grid" }, { id: "plain", label: "Plain" }];

/** Herkunft eigener Änderungen (vom UndoManager verfolgt). */
export const BOARD_LOCAL = { source: "board-local" } as const;
/** Herkunft von Änderungen aus den Records (nicht verfolgt, nicht zurückgeschrieben). */
export const BOARD_STORE = { source: "board-store" } as const;

/** Präsenz eines anderen Geräts auf dem Board (Awareness-Feld „board“). */
export interface BoardPeer { clientID: number; name?: string; color?: string; x: number; y: number }

export interface BoardSessionOptions {
  /** Präsenz (Awareness) – sobald Boards über /collab laufen. Ohne: keine fremden Cursor. */
  presence?: PresenceChannel | undefined;
}

/** Änderungen eines Schritts (eine Y-Transaktion = ein Undo-Schritt = ein Schreiben in den Store). */
export interface BoardOps {
  add(obj: WBObject): void;
  /** Nur die übergebenen Felder; `undefined` entfernt ein Feld. */
  patch(id: string, fields: Record<string, unknown>): void;
  remove(id: string): void;
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b || JSON.stringify(a) === JSON.stringify(b);
};

export class BoardSession {
  readonly doc = new Y.Doc();
  private readonly map: Y.Map<Y.Map<unknown>>;
  private readonly undoManager: Y.UndoManager;
  private readonly cache = new Map<string, WBObject>();
  private sorted: WBObject[] | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly parent: string;
  private writing = false;
  private locked = false;
  private destroyed = false;
  private readonly stopStore: () => void;
  private readonly presence: PresenceChannel | undefined;
  /** Zählt bei jeder Änderung hoch (für `useSyncExternalStore` und Caches). */
  version = 0;

  constructor(private readonly store: WorkspaceStore, readonly pageID: string, opts: BoardSessionOptions = {}) {
    this.parent = "b:" + pageID;
    this.map = boardObjectsMap(this.doc);
    this.presence = opts.presence;
    this.doc.transact(() => {
      for (const o of boardObjectsOf(store, pageID)) addObject(this.doc, o);
    }, BOARD_STORE);
    for (const [id, m] of this.map) {
      const o = readObject(m);
      if (o) this.cache.set(id, o);
    }
    this.map.observeDeep(this.onDoc);
    // captureTimeout 0: jede Transaktion ist ein eigener Schritt (eine Geste = eine Transaktion).
    this.undoManager = new Y.UndoManager(this.map, { trackedOrigins: new Set<unknown>([BOARD_LOCAL]), captureTimeout: 0 });
    this.stopStore = store.observe(this.onStore);
    this.presence?.on("change", this.notify);
  }

  // MARK: Lesen

  /** Alle Objekte von hinten nach vorn. Dasselbe Array, solange sich nichts ändert. */
  get objects(): readonly WBObject[] {
    return (this.sorted ??= sortByZ([...this.cache.values()]));
  }
  get byID(): ReadonlyMap<string, WBObject> {
    return this.cache;
  }
  get(id: string): WBObject | undefined {
    return this.cache.get(id);
  }
  /** Schreibgeschützt: der Store (Speichern gescheitert) oder die Seite (Papierkorb, gesperrt, Gast mit Leserecht). */
  get readOnly(): boolean {
    return this.locked || this.store.isReadOnly;
  }
  /** Die Seite ist nur lesbar (setzt die Ansicht). */
  setLocked(locked: boolean) {
    if (this.locked === locked) return;
    this.locked = locked;
    this.version += 1;
    this.notify();
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private notify = () => {
    for (const fn of [...this.listeners]) fn();
  };

  /** Untergrund der Fläche: Punkte (Standard), Linien oder Karo – gespeichert an der Seite (`props.board.bg`). */
  get background(): BoardBackground {
    const board = (this.store.blocks.get(this.pageID)?.props as { board?: { bg?: unknown } } | undefined)?.board;
    return board?.bg === "lines" || board?.bg === "grid" || board?.bg === "plain" ? board.bg : "dots";
  }
  setBackground(bg: BoardBackground): boolean {
    if (this.readOnly || bg === this.background) return false;
    this.writing = true;
    try {
      this.store.transact("Board background", (tx) => tx.update(this.pageID, (b) => {
        const props = (b.props ?? {}) as Record<string, unknown>;
        b.props = { ...props, board: { ...((props.board as Record<string, unknown> | undefined) ?? {}), bg } } as typeof b.props;
      }));
    } finally {
      this.writing = false;
    }
    this.version += 1;
    this.notify();
    return true;
  }

  // MARK: Ändern

  /** Ein Schritt. `false`: nichts geändert (schreibgeschützt). */
  apply(body: (ops: BoardOps) => void): boolean {
    if (this.destroyed || this.readOnly) return false;
    this.doc.transact(() => {
      body({
        add: (obj) => addObject(this.doc, obj),
        patch: (id, fields) => {
          const m = this.map.get(id);
          if (!(m instanceof Y.Map)) return;
          for (const [k, v] of Object.entries(fields)) {
            if (k === "id") continue;
            if (v === undefined) { if (m.has(k)) m.delete(k); }
            else if (!sameValue(m.get(k), v)) m.set(k, v);
          }
        },
        remove: (id) => { if (this.map.has(id)) this.map.delete(id); },
      });
    }, BOARD_LOCAL);
    return true;
  }

  add(objs: readonly WBObject[]): boolean {
    return this.apply((ops) => { for (const o of objs) ops.add(o); });
  }

  patch(patches: ReadonlyMap<string, Record<string, unknown>>): boolean {
    return this.apply((ops) => { for (const [id, f] of patches) ops.patch(id, f); });
  }

  /** Löschen; Verbindungen, die danach ins Leere zeigen, gehen mit. Gibt alle gelöschten IDs zurück. */
  remove(ids: readonly string[]): string[] {
    const set = new Set(ids.filter((id) => this.cache.has(id)));
    for (const c of danglingConnectors(this.objects, set)) set.add(c);
    if (set.size === 0) return [];
    return this.apply((ops) => { for (const id of set) ops.remove(id); }) ? [...set] : [];
  }

  /** Ganz nach vorn bzw. hinten; die Reihenfolge der gewählten Objekte untereinander bleibt. */
  reorder(ids: readonly string[], where: "front" | "back"): boolean {
    const set = new Set(ids);
    const picked = this.objects.filter((o) => set.has(o.id));
    const rest = this.objects.filter((o) => !set.has(o.id));
    if (picked.length === 0) return false;
    return this.apply((ops) => {
      if (where === "front") {
        let z = rest.at(-1)?.z;
        for (const o of picked) { z = keyBetween(z, undefined); ops.patch(o.id, { z }); }
      } else {
        let z = rest[0]?.z;
        for (const o of [...picked].reverse()) { z = keyBetween(undefined, z); ops.patch(o.id, { z }); }
      }
    });
  }

  // MARK: Undo

  get canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }
  undo(): boolean {
    if (this.readOnly) return false;
    return this.undoManager.undo() !== null;
  }
  redo(): boolean {
    if (this.readOnly) return false;
    return this.undoManager.redo() !== null;
  }

  // MARK: Präsenz

  /** Eigenen Zeiger melden (Weltkoordinaten) bzw. mit `undefined` zurückziehen. */
  setCursor(p: { x: number; y: number } | undefined) {
    this.presence?.setLocalStateField("board", p ? { page: this.pageID, x: p.x, y: p.y } : null);
  }

  /** Zeiger der anderen auf diesem Board. */
  peers(): BoardPeer[] {
    const p = this.presence;
    if (!p) return [];
    const out: BoardPeer[] = [];
    for (const [clientID, state] of p.getStates()) {
      if (clientID === p.clientID) continue;
      const b = state.board as { page?: unknown; x?: unknown; y?: unknown } | null | undefined;
      if (!b || b.page !== this.pageID || typeof b.x !== "number" || typeof b.y !== "number") continue;
      const user = state.user as { name?: unknown; color?: unknown } | undefined;
      out.push({ clientID, x: b.x, y: b.y, ...(typeof user?.name === "string" ? { name: user.name } : {}), ...(typeof user?.color === "string" ? { color: user.color } : {}) });
    }
    return out.sort((a, b) => a.clientID - b.clientID);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopStore();
    this.presence?.off("change", this.notify);
    this.setCursor(undefined);
    this.map.unobserveDeep(this.onDoc);
    this.undoManager.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }

  // MARK: Y.Doc → Store

  private onDoc = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
    const changed = new Set<string>();
    for (const e of events) {
      if (e.target === this.map) for (const k of (e as Y.YMapEvent<unknown>).keysChanged) changed.add(k);
      else if (typeof e.path[0] === "string") changed.add(e.path[0]);
    }
    if (changed.size === 0) return;
    for (const id of changed) {
      const o = readObject(this.map.get(id));
      if (o) this.cache.set(id, o);
      else this.cache.delete(id);
    }
    this.sorted = undefined;
    this.version += 1;
    if (tr.origin !== BOARD_STORE) this.writeToStore(changed);
    this.notify();
  };

  private writeToStore(ids: ReadonlySet<string>) {
    const store = this.store;
    this.writing = true;
    try {
      store.transact("Edit board", (tx) => {
        const now = store.now();
        for (const id of ids) {
          const existing = store.blocks.get(id);
          const mine = existing === undefined || (existing.type === BOARD_OBJECT_TYPE && existing.parent === this.parent);
          if (!mine) continue; // fremder Block mit derselben ID: nie anfassen
          if (!this.map.has(id)) {
            if (existing) tx.remove(keyOf("block", id));
            continue;
          }
          const o = this.cache.get(id);
          if (!o) continue; // im Y.Doc, aber nicht lesbar (neuere Version): Record bleibt, wie er ist
          if (existing && sameBoardObject(boardObjectFromBlock(existing), o)) continue;
          tx.put({ kind: "block", data: boardObjectToBlock(o, this.pageID, now, existing) });
        }
      }, { undoable: false });
    } finally {
      this.writing = false;
    }
  }

  // MARK: Store → Y.Doc

  private onStore = (change: StoreChange) => {
    if (this.writing || this.destroyed) return;
    // Die Seite selbst hat sich geändert (Untergrund von einem anderen Gerät): neu zeichnen.
    if (change.keys.some((k) => parseKey(k).id === this.pageID)) { this.version += 1; this.notify(); }
    const ids: string[] = [];
    for (const key of change.keys) {
      const { kind, id } = parseKey(key);
      if (kind !== "block") continue;
      const b = this.store.blocks.get(id);
      if ((b && b.type === BOARD_OBJECT_TYPE && b.parent === this.parent) || this.map.has(id)) ids.push(id);
    }
    if (ids.length === 0) return;
    this.doc.transact(() => {
      for (const id of ids) {
        const b = this.store.blocks.get(id);
        const here = b !== undefined && b.type === BOARD_OBJECT_TYPE && b.parent === this.parent && !b.trashedAt;
        const o = here ? boardObjectFromBlock(b) : undefined;
        if (!o) {
          // Weg (gelöscht, verschoben) → aus dem Modell. Da, aber nicht lesbar → Modell nicht anfassen.
          if (!here && this.map.has(id)) this.map.delete(id);
          continue;
        }
        const m = this.map.get(id);
        if (!(m instanceof Y.Map)) { addObject(this.doc, o); continue; }
        const fields = wbFields(o);
        for (const [k, v] of Object.entries(fields)) {
          if (k === "id" || v === undefined) continue;
          if (!sameValue(m.get(k), v)) m.set(k, v);
        }
        for (const k of [...m.keys()]) if (k !== "id" && fields[k] === undefined) m.delete(k);
      }
    }, BOARD_STORE);
  };
}
