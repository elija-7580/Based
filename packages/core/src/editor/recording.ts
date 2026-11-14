// „Problem melden“ (BSD-319) im Block-Editor (ADR 0016): Seite als Blockbaum für Zwischenstände und Endzustand,
// Transaktionen als Block-Records, und das Gegenstück für die Wiedergabe (Baum laden, Records anwenden). Ohne DOM –
// die Web-Shell (apps/web/src/shell/bugReport.ts) hängt es an den Store des offenen Editors.
import type { BlockChangeRecord } from "../bugReport.js";
import type { Block } from "../model/records.js";
import type { StoreChange, WorkspaceStore } from "../store/store.js";
import { newBlockID } from "./commands/blocks.js";

/** Ein Block im Baum: Typ, Sortierschlüssel, Text und Attribute; Kinder in Reihenfolge. */
export interface BlockNode {
  id: string;
  type: string;
  sk: string;
  text?: unknown;
  props?: unknown;
  children: BlockNode[];
}

/** Dokument des Block-Editors in Bündel und Aufzeichnung (ohne die Seite selbst). */
export interface BlockDoc {
  editor: "blocks";
  blocks: BlockNode[];
}

export const isBlockDoc = (d: unknown): d is BlockDoc =>
  !!d && typeof d === "object" && (d as { editor?: unknown }).editor === "blocks" && Array.isArray((d as { blocks?: unknown }).blocks);

const live = (b: Block | undefined): b is Block => b !== undefined && b.trashedAt === undefined;

/**
 * Alle Blöcke unter der Seite (ohne Papierkorb und ohne, was unter einem Block im Papierkorb hängt) – nur Verweise,
 * Records im Store sind unveränderlich. Billig genug für einen Zwischenstand alle paar Dutzend Ereignisse.
 */
export function pageBlocks(store: WorkspaceStore, root: string): Block[] {
  const out: Block[] = [];
  const stack = [...store.children("b:" + root)].reverse();
  while (stack.length) {
    const b = store.blocks.get(stack.pop()!);
    if (!live(b)) continue;
    out.push(b);
    const kids = store.children("b:" + b.id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

const bySk = (a: Block, b: Block) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Baum aus einer flachen Liste (z. B. `pageBlocks`), Reihenfolge wie im Store (sk, dann ID). */
export function blockDoc(blocks: readonly Block[], root: string): BlockDoc {
  const byParent = new Map<string, Block[]>();
  for (const b of blocks) {
    const list = byParent.get(b.parent);
    if (list) list.push(b);
    else byParent.set(b.parent, [b]);
  }
  const seen = new Set<string>();
  const nodes = (parent: string): BlockNode[] => (byParent.get(parent) ?? []).sort(bySk).flatMap((b) => {
    if (seen.has(b.id)) return [];
    seen.add(b.id);
    const n: BlockNode = { id: b.id, type: b.type, sk: b.sk, children: [] };
    if (b.text !== undefined) n.text = b.text;
    if (b.props !== undefined && Object.keys(b.props).length) n.props = b.props;
    n.children = nodes("b:" + b.id);
    return [n];
  });
  return { editor: "blocks", blocks: nodes("b:" + root) };
}

export const blockDocOf = (store: WorkspaceStore, root: string): BlockDoc => blockDoc(pageBlocks(store, root), root);

/** Liegt der Block (über seine Eltern) unter der Seite? */
export function underRoot(store: WorkspaceStore, b: Block | undefined, root: string): boolean {
  for (let n = 0; b && n < 200; n++) {
    if (b.parent === "b:" + root) return true;
    if (!b.parent.startsWith("b:")) return false;
    b = store.blocks.get(b.parent.slice(2));
  }
  return false;
}

/**
 * Hört auf die Transaktionen des Stores und meldet die, die Blöcke der Seite betreffen (auch gelöschte, die vorher
 * dazugehörten). Kostet je Transaktion einen Gang die Eltern hinauf je geändertem Block.
 */
export function observePageChanges(store: WorkspaceStore, root: string, emit: (e: { name?: string; origin: string; changes: BlockChangeRecord[] }) => void): () => void {
  const known = new Set(pageBlocks(store, root).map((b) => b.id));
  return store.observe((c: StoreChange) => {
    const changes: BlockChangeRecord[] = [];
    for (const key of c.keys) {
      if (!key.startsWith("block:")) continue;
      const id = key.slice(6);
      if (id === root) continue;
      const b = store.blocks.get(id);
      if (b && underRoot(store, b, root)) {
        known.add(id);
        changes.push({ id, block: b });
      } else if (known.has(id)) {
        // gelöscht oder aus der Seite heraus verschoben – für die Seite ist er weg
        known.delete(id);
        changes.push(b ? { id, block: b } : { id });
      }
    }
    if (changes.length) emit({ ...(c.name !== undefined ? { name: c.name } : {}), origin: c.origin, changes });
  });
}

// MARK: Wiedergabe

/** Zuordnung aufgezeichneter Block-IDs zu denen der Wiedergabe-Seite. */
export interface ReplayIDs {
  /** Seite beim Aufzeichnen. */
  recordedRoot: string;
  /** Seite der Wiedergabe. */
  root: string;
  ids: Map<string, string>;
}

const mapID = (m: ReplayIDs, id: string, newID: () => string) => {
  if (id === m.recordedRoot) return m.root;
  let n = m.ids.get(id);
  if (!n) {
    n = newID();
    m.ids.set(id, n);
  }
  return n;
};
const mapParent = (m: ReplayIDs, parent: string, newID: () => string) => (parent.startsWith("b:") ? "b:" + mapID(m, parent.slice(2), newID) : parent);

/**
 * Inhalt der Seite durch den Baum ersetzen (Wiedergabe). Blöcke bekommen neue IDs, Sortierschlüssel bleiben (die
 * aufgezeichneten Records danach setzen darauf auf). Ein Undo-Schritt.
 */
export function loadBlockDoc(store: WorkspaceStore, root: string, recordedRoot: string, doc: BlockDoc, newID: () => string = newBlockID): ReplayIDs {
  const m: ReplayIDs = { recordedRoot, root, ids: new Map() };
  const now = store.now();
  store.transact("Replay: load", (tx) => {
    for (const id of store.descendants(root)) tx.remove(`block:${id}`);
    const put = (n: BlockNode, parent: string) => {
      const id = mapID(m, n.id, newID);
      const data = { id, type: n.type, parent, sk: n.sk, createdAt: now, updatedAt: now } as Block;
      if (n.text !== undefined) data.text = n.text as Block["text"];
      if (n.props !== undefined) data.props = n.props as Block["props"];
      tx.put({ kind: "block", data });
      for (const c of n.children) put(c, "b:" + id);
    };
    for (const n of doc.blocks) put(n, "b:" + root);
  });
  return m;
}

/** Aufgezeichnete Records einer Transaktion auf der Wiedergabe-Seite anwenden (IDs umgeschrieben). */
export function applyBlockChanges(store: WorkspaceStore, m: ReplayIDs, changes: readonly BlockChangeRecord[], newID: () => string = newBlockID): void {
  store.transact("Replay: change", (tx) => {
    for (const c of changes) {
      const id = mapID(m, c.id, newID);
      const rec = c.block as Block | undefined;
      if (!rec) {
        if (store.blocks.has(id)) tx.remove(`block:${id}`);
        continue;
      }
      const { stamp: _stamp, ...rest } = rec;
      tx.put({ kind: "block", data: { ...rest, id, parent: mapParent(m, rec.parent, newID) } as Block });
    }
  });
}

/** Block-IDs einer Auswahl aus der Aufzeichnung auf die Wiedergabe-Seite umschreiben. */
export function mapReplaySelection<S extends { block?: string; blocks?: string[] }>(m: ReplayIDs, sel: S): S {
  const out = { ...sel };
  if (sel.block !== undefined) out.block = m.ids.get(sel.block) ?? sel.block;
  if (sel.blocks) out.blocks = sel.blocks.map((b) => m.ids.get(b) ?? b);
  return out;
}

const liveKids = (store: WorkspaceStore, parent: string) => store.children(parent).filter((id) => live(store.blocks.get(id)));

/** Stelle eines Blocks im Baum der Seite (Index je Ebene), z. B. `[2, 0]` = erstes Kind des dritten Blocks. */
export function blockPath(store: WorkspaceStore, root: string, id: string): number[] | undefined {
  const path: number[] = [];
  let b = store.blocks.get(id);
  for (let n = 0; b && n < 200; n++) {
    const i = liveKids(store, b.parent).indexOf(b.id);
    if (i < 0) return undefined;
    path.unshift(i);
    if (b.parent === "b:" + root) return path;
    if (!b.parent.startsWith("b:")) return undefined;
    b = store.blocks.get(b.parent.slice(2));
  }
  return undefined;
}

export function blockAtPath(store: WorkspaceStore, root: string, path: readonly number[]): string | undefined {
  let cur = root;
  for (const i of path) {
    const next = liveKids(store, "b:" + cur)[i];
    if (!next) return undefined;
    cur = next;
  }
  return path.length ? cur : undefined;
}

/**
 * Auswahl für die Wiedergabe: Block über die Zuordnung, sonst über seine Stelle im Baum (`path`). Blöcke, die die
 * Wiedergabe selbst anlegt (Enter beim Tippen), haben neue IDs, die die Aufzeichnung nicht kennt.
 */
export function resolveReplaySelection<S extends { block?: string; blocks?: string[]; path?: number[] }>(store: WorkspaceStore, m: ReplayIDs, sel: S): S {
  const out = mapReplaySelection(m, sel);
  if (out.block !== undefined && !store.blocks.has(out.block) && sel.path) {
    const id = blockAtPath(store, m.root, sel.path);
    if (id) out.block = id;
  }
  return out;
}
