// BSD-153: die Seitenleiste als flache Zeilenliste (für die virtualisierte Liste). Nur Struktur und Auf/Zu-Zustand;
// Titel kommen beim Rendern aus der Titel-Tabelle, damit Tippen die Liste nicht neu aufbaut.
import { PRIVATE_SECTION, sectionKey, type Outline } from "@based/core";

export type SidebarRow =
  /** Abschnittskopf: Favorites, Teamspaces (mit „+“ für einen neuen Teamspace) oder Private (mit „+“ für eine Seite). */
  | { kind: "header"; key: string; label: string; group: string; section?: string; collapsed: boolean }
  /** Ein Teamspace unter „Teamspaces“: auf-/zuklappbar, seine Seiten darunter (Tiefe 1). */
  | { kind: "teamspace"; key: string; id: string; name: string; icon?: string; collapsed: boolean; count: number }
  | { kind: "page"; key: string; id: string; depth: number; hasChildren: boolean; expanded: boolean; database: boolean }
  | { kind: "empty"; key: string; depth: number; parent: string }
  /** „Create a teamspace“, solange es keinen gibt. */
  | { kind: "action"; key: string; action: "createTeamspace"; label: string };

export const FAVORITES = "favorites";
export const TEAMSPACES = "teamspaces";

/**
 * Zeilen in Anzeigereihenfolge: Favorites, Teamspaces (je Teamspace eine Zeile mit seinen Seiten), Private.
 * Unterseiten nur unter aufgeklappten Seiten. `collapsed` enthält zugeklappte Abschnitte (`favorites`, `teamspaces`,
 * `private`) und zugeklappte Teamspaces (ihre ID).
 */
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
    rows.push({ kind: "header", key: "h/" + FAVORITES, label: "Favorites", group: FAVORITES, collapsed: c });
    if (!c) pages(outline.favorites, 0, "fav", new Set());
  }
  const teamspaces = outline.sections.filter((s) => s.id !== PRIVATE_SECTION);
  const tc = collapsed.has(TEAMSPACES);
  rows.push({ kind: "header", key: "h/" + TEAMSPACES, label: "Teamspaces", group: TEAMSPACES, collapsed: tc });
  if (!tc) {
    if (teamspaces.length === 0) rows.push({ kind: "action", key: "a/createTeamspace", action: "createTeamspace", label: "Create a teamspace" });
    for (const s of teamspaces) {
      const c = collapsed.has(s.id);
      const kids = outline.children[sectionKey(s.id)] ?? [];
      const row: SidebarRow = { kind: "teamspace", key: "ts/" + s.id, id: s.id, name: s.name, collapsed: c, count: kids.length };
      if (s.icon) row.icon = s.icon;
      rows.push(row);
      if (!c) pages(kids, 1, "s:" + s.id, new Set());
    }
  }
  const pc = collapsed.has(PRIVATE_SECTION);
  rows.push({ kind: "header", key: "h/" + PRIVATE_SECTION, label: "Private", group: PRIVATE_SECTION, section: PRIVATE_SECTION, collapsed: pc });
  if (!pc) pages(outline.children[sectionKey(PRIVATE_SECTION)] ?? [], 0, "s:" + PRIVATE_SECTION, new Set());
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

/** BSD-203: Seiten zwischen `from` und `to` (beide eingeschlossen) in Anzeige-Reihenfolge; leer, wenn eine fehlt. */
export function pickRange(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
