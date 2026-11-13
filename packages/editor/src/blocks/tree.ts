// BSD-381 (ADR 0016, E0): Der neue Block-Editor arbeitet direkt auf den Block-Records im WorkspaceStore – ein
// Modell, kein zweites Dokument. `blockTree` liest den Baum einer Seite so, wie der Editor ihn zeigt: Kinder nach
// (Sortierschlüssel, ID), ohne Papierkorb, Unterseiten und Datenbankzeilen nicht aufgeklappt.
import type { Block, WorkspaceStore } from "@based/core";

export interface BlockNode {
  id: string;
  type: Block["type"];
  children: BlockNode[];
}

/**
 * Blöcke, deren Kinder nicht im Fluss der Seite stehen: eine Unterseite zeigt nur ihren Link, eine Datenbank ihre
 * Ansicht (Zeilen hängen an `d:<id>`), Tabellenzeilen zeichnet die Tabelle selbst.
 */
export const OPAQUE_TYPES: ReadonlySet<string> = new Set(["page", "databasePage", "databaseInline", "linkToPage", "syncedBlock", "meeting"]);

/** Höchste Tiefe, bis zu der gelesen wird (Schutz gegen kaputte Eltern-Ketten). */
const MAX_DEPTH = 64;

/** Der sichtbare Baum unter `rootID` (Seite oder Block). */
export function blockTree(store: WorkspaceStore, rootID: string): BlockNode[] {
  const seen = new Set<string>([rootID]);
  const walk = (parentID: string, depth: number): BlockNode[] => {
    if (depth > MAX_DEPTH) return [];
    const out: BlockNode[] = [];
    for (const id of store.children("b:" + parentID)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined || seen.has(id)) continue;
      seen.add(id);
      const opaque = OPAQUE_TYPES.has(b.type) || b.type === "table";
      out.push({ id, type: b.type, children: opaque ? [] : walk(id, depth + 1) });
    }
    return out;
  };
  return walk(rootID, 0);
}

/** Der Baum als Zeilen „Tiefe · Typ“ in Lesereihenfolge – für Tests und die Entwickler-Ansicht. */
export function outlineOf(nodes: readonly BlockNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.type}`, ...outlineOf(n.children, depth + 1)]);
}

/** Alle IDs in Lesereihenfolge (Eltern vor Kindern). */
export function flatIDs(nodes: readonly BlockNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...flatIDs(n.children)]);
}
