// BSD-153: die Seitenleiste als flache Zeilenliste (für die virtualisierte Liste). Nur Struktur und Auf/Zu-Zustand;
// Titel kommen beim Rendern aus der Titel-Tabelle, damit Tippen die Liste nicht neu aufbaut.
import { sectionKey, type Outline } from "@based/core";

export type SidebarRow =
  | { kind: "header"; key: string; label: string; section?: string; collapsed: boolean }
  | { kind: "page"; key: string; id: string; depth: number; hasChildren: boolean; expanded: boolean; database: boolean }
  | { kind: "empty"; key: string; depth: number; parent: string };

export const FAVORITES = "favorites";

/** Zeilen in Anzeigereihenfolge: Favoriten, Teamspaces, Private. Unterseiten nur unter aufgeklappten Seiten. */
export function flattenSidebar(outline: Outline, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string> = new Set()): SidebarRow[] {
  const rows: SidebarRow[] = [];
  const pages = (ids: readonly string[], depth: number, scope: string, path: Set<string>) => {
    for (const id of ids) {
      const node = outline.nodes[id];
      if (!node || path.has(id)) continue;
      const kids = outline.children[id] ?? [];
      const exp = expanded.has(id);
      const key = `${scope}/${id}`;
      rows.push({ kind: "page", key, id, depth, hasChildren: kids.length > 0, expanded: exp, database: node.kind === "database" });
      if (!exp) continue;
      if (kids.length === 0) {
        if (node.kind === "page") rows.push({ kind: "empty", key: key + "/empty", depth: depth + 1, parent: id });
        continue;
      }
      path.add(id);
      pages(kids, depth + 1, key, path);
      path.delete(id);
    }
  };
  if (outline.favorites.length > 0) {
    const c = collapsed.has(FAVORITES);
    rows.push({ kind: "header", key: "h/" + FAVORITES, label: "Favorites", collapsed: c });
    if (!c) pages(outline.favorites, 0, "fav", new Set());
  }
  for (const s of outline.sections) {
    const c = collapsed.has(s.id);
    rows.push({ kind: "header", key: "h/" + s.id, label: s.name, section: s.id, collapsed: c });
    if (!c) pages(outline.children[sectionKey(s.id)] ?? [], 0, "s:" + s.id, new Set());
  }
  return rows;
}

/** Index der ersten Zeile, die die Seite zeigt (für „aktive Seite sichtbar halten“). */
export const rowIndexOf = (rows: readonly SidebarRow[], id: string | undefined) =>
  id === undefined ? -1 : rows.findIndex((r) => r.kind === "page" && r.id === id && !r.key.startsWith("fav/"));

/** Alle Vorfahren einer Seite (zum Aufklappen bis zur aktiven Seite). */
export function ancestorsInOutline(outline: Outline, id: string): string[] {
  const out: string[] = [];
  let p = outline.nodes[id]?.parent;
  for (let n = 0; p && n < 1000; n++) {
    out.unshift(p);
    p = outline.nodes[p]?.parent;
  }
  return out;
}

/** Wo eine gezogene Seite landet: oberes/unteres Viertel = davor/dahinter, Mitte = hinein. */
export function dropZone(offsetY: number, height: number, canNest: boolean): "before" | "inside" | "after" {
  const f = height > 0 ? offsetY / height : 0.5;
  if (!canNest) return f < 0.5 ? "before" : "after";
  return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
}
