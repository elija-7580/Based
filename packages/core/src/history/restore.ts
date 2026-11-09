// BSD-73: Store-Seite des Versionsverlaufs (Swift: `WorkspaceStore.versionBlocks(of:)` / `restoreVersion`).
//
// Wiederherstellen verschiebt statt zu löschen: Die Shell speichert die aktuelle Fassung vorher als Version
// („before restore“), das Wiederherstellen ist ein Undo-Schritt, und anders als in Swift (VersionHistory.swift:376)
// werden Blöcke, die inzwischen auf einer anderen Seite stehen, dort nicht weggezogen – die Version bekommt eine
// Kopie mit neuer ID, und das Ergebnis meldet es. Eigene Inline-Datenbanken, die seit der Version dazukamen, kommen
// in den Papierkorb statt hart gelöscht zu werden (ihre Zeilen bleiben erhalten).
import type { Block } from "../model/records.js";
import { isPageLike } from "../store/pages.js";
import { keyOf, type WorkspaceStore } from "../store/store.js";

/**
 * Was eine Version enthält: den Seitenblock, dann jeden Block der Seite in Dokumentreihenfolge – verschachtelte
 * eingeschlossen, aber nicht den Inhalt von Unterseiten (die haben eigene Versionen); eine Unterseite erscheint als
 * eigener Block (Titel, Icon) wie ein Link. Blöcke im Papierkorb fehlen.
 */
export function versionBlocks(store: WorkspaceStore, pageID: string): Block[] {
  const p = store.blocks.get(pageID);
  if (!p) return [];
  const out: Block[] = [p];
  const walk = (id: string) => {
    for (const c of store.children("b:" + id)) {
      const b = store.blocks.get(c);
      if (!b || b.trashedAt !== undefined) continue;
      out.push(b);
      if (!isPageLike(b)) walk(c);
    }
  };
  walk(pageID);
  return out;
}

export interface RestoreResult {
  /** Blöcke der Version, die wieder auf der Seite stehen. */
  restored: number;
  /** Blöcke, die seit der Version dazukamen und die Seite verlassen haben (in der Version „before restore“ erhalten). */
  removed: number;
  /** Blöcke, die inzwischen auf einer anderen Seite stehen: dort gelassen, hier als Kopie (alte ID → neue ID). */
  copied: Record<string, string>;
  /** Eigene Inline-Datenbanken, die in den Papierkorb kamen. */
  trashed: string[];
}

export interface RestoreOptions {
  /** Neue IDs für Kopien (Tests: deterministisch). */
  newID?: () => string;
}

const setOrDelete = <K extends keyof Block>(b: Block, key: K, value: Block[K] | undefined) => {
  if (value === undefined) delete b[key];
  else b[key] = value;
};

/**
 * Setzt eine Seite auf eine gespeicherte Version zurück, als ein Undo-Schritt: Die Blöcke der Version kommen so
 * zurück, wie sie waren (Text, Eigenschaften, Verschachtelung, Reihenfolge); seitdem hinzugekommene Blöcke verlassen
 * die Seite. Unterseiten werden nie angefasst (eigener Verlauf); eine seitdem in einem wegfallenden Block angelegte
 * Unterseite rückt auf die oberste Ebene der Seite.
 */
export function restoreVersion(store: WorkspaceStore, pageID: string, version: Block[], opts: RestoreOptions = {}): RestoreResult | undefined {
  const first = version[0];
  if (!first || first.id !== pageID || !store.blocks.has(pageID)) return undefined;
  const newID = opts.newID ?? (() => globalThis.crypto.randomUUID().toUpperCase());
  const current = versionBlocks(store, pageID);
  const onPage = new Set(current.map((b) => b.id));
  const keep = new Set(version.map((b) => b.id));
  const result: RestoreResult = { restored: 0, removed: 0, copied: {}, trashed: [] };

  // Blöcke der Version, die jetzt woanders leben (nicht im Papierkorb, nicht auf dieser Seite): Kopie statt Wegziehen.
  for (const b of version.slice(1)) {
    if (isPageLike(b)) continue;
    const now = store.blocks.get(b.id);
    if (now && now.trashedAt === undefined && !onPage.has(b.id)) result.copied[b.id] = newID();
  }
  const mapID = (id: string) => result.copied[id] ?? id;
  const mapParent = (parent: string) => (parent.startsWith("b:") ? "b:" + mapID(parent.slice(2)) : parent);

  store.transact("Restore version", (tx) => {
    tx.update(pageID, (p) => {
      setOrDelete(p, "text", first.text);
      setOrDelete(p, "props", first.props);
      setOrDelete(p, "values", first.values);
    });
    // Unterseiten haben ihren eigenen Verlauf: sie bleiben, wo sie jetzt sind.
    for (const b of version.slice(1)) {
      if (isPageLike(b)) continue;
      const restored = structuredClone(b);
      delete restored.trashedAt;
      restored.id = mapID(b.id);
      restored.parent = mapParent(b.parent);
      if (restored.id !== b.id) delete restored.stamp;
      tx.put({ kind: "block", data: restored });
      result.restored += 1;
    }
    const now = store.now();
    for (const b of current.slice(1)) {
      if (keep.has(b.id)) continue;
      if (isPageLike(b)) {
        const parent = b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
        if (parent !== undefined && parent !== pageID && !keep.has(parent)) tx.update(b.id, (x) => { x.parent = "b:" + pageID; });
      } else if (store.isTrashable(b)) {
        // eigene Inline-Datenbank: Papierkorb statt löschen (Zeilen und Ansichten bleiben)
        tx.update(b.id, (x) => {
          x.trashedAt = now;
          if (x.parent.startsWith("b:") && !keep.has(x.parent.slice(2))) x.parent = "b:" + pageID;
        });
        result.trashed.push(b.id);
      } else {
        tx.remove(keyOf("block", b.id));
        result.removed += 1;
      }
    }
  });
  return result;
}
