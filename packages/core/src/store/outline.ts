// BSD-153: Struktur der Seitenleiste (Abschnitte, verschachtelte Seiten, Favoriten, Papierkorb) als schlanker,
// serialisierbarer Stand – getrennt von den Titeln, damit Tippen im Titel nicht die ganze Struktur neu schickt.
// Eine Seite hängt in der Seitenleiste unter der nächsten Seite über ihr (auch wenn sie in einem Toggle liegt);
// Datenbankzeilen erscheinen nicht. Reihenfolge = Dokumentreihenfolge.
import { richPlain, titleOf } from "../query/engine.js";
import type { Block } from "../model/records.js";
import type { WorkspaceStore } from "./store.js";
import { isPageLike, sectionOf } from "./pages.js";

export const PRIVATE_SECTION = "private";
/** BSD-235: Sektion für geteilte Seiten ohne bekannte Eltern (Gast-Modus). */
export const SHARED_SECTION = "shared";

export interface OutlineSection {
  /** `private` oder die Teamspace-ID. */
  id: string;
  name: string;
  /** Emoji des Teamspaces, falls gesetzt. */
  icon?: string;
}

export interface OutlineNode {
  kind: "page" | "database";
  /** Emoji oder Symbolname, falls gesetzt. */
  icon?: string;
  /** Elternseite in der Seitenleiste; fehlt oben im Abschnitt. */
  parent?: string;
  section: string;
}

export interface TrashEntry {
  id: string;
  /** Swift-Datum. */
  trashedAt: number;
  /** Titel der früheren Elternseite oder Datenbank. */
  from?: string;
}

export interface Outline {
  workspaceName: string;
  /** Teamspaces in ihrer Reihenfolge, dann Private. */
  sections: OutlineSection[];
  /** Kinder je Abschnitt (`section:<id>`) oder Seite (`<id>`), nur Seiten außerhalb des Papierkorbs. */
  children: Record<string, string[]>;
  nodes: Record<string, OutlineNode>;
  favorites: string[];
  trash: TrashEntry[];
}

export const sectionKey = (id: string) => "section:" + id;

export function iconText(b: Block | undefined): string | undefined {
  const icon = b?.props?.icon;
  if (!icon) return undefined;
  if (typeof icon === "string") return icon;
  return icon.emoji ?? icon.symbol;
}

/** Seitenleisten-Struktur eines Stands (eine Tiefensuche über alle Blöcke). */
export function buildOutline(store: WorkspaceStore): Outline {
  const teamspaces = store.workspace.teamspaces ?? [];
  const sections: OutlineSection[] = [
    ...teamspaces.map((t) => {
      const s: OutlineSection = { id: t.id, name: t.name };
      const icon = typeof t.icon === "string" ? t.icon : (t.icon?.emoji ?? t.icon?.symbol);
      if (icon) s.icon = icon;
      return s;
    }),
    { id: PRIVATE_SECTION, name: "Private" },
  ];
  const children: Record<string, string[]> = {};
  const nodes: Record<string, OutlineNode> = {};
  for (const s of sections) children[sectionKey(s.id)] = [];
  const push = (key: string, id: string) => (children[key] ??= []).push(id);

  const visit = (parent: string, page: string | undefined, section: string) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined) continue;
      if (isPageLike(b)) {
        let sec = section;
        if (!page) {
          const s = sectionOf(store, b);
          sec = s.kind === "private" ? PRIVATE_SECTION : s.id;
        }
        const node: OutlineNode = { kind: b.type === "databasePage" ? "database" : "page", section: sec };
        const icon = iconText(b);
        if (icon) node.icon = icon;
        if (page) node.parent = page;
        nodes[id] = node;
        push(page ?? sectionKey(sec), id);
        visit("b:" + id, id, sec);
      } else {
        visit("b:" + id, page, section);
      }
    }
  };
  visit("w", undefined, PRIVATE_SECTION);

  // BSD-235: Seiten, deren Eltern dieses Gerät nicht kennt – im Gast-Modus die geteilten Seiten (der Server schickt
  // nur den geteilten Bereich, ohne Workspace und ohne die Seiten darüber). Eigene Sektion „Shared with you“.
  const orphans: string[] = [];
  for (const b of store.blocks.values()) {
    if (!isPageLike(b) || b.trashedAt !== undefined || nodes[b.id] || !b.parent.startsWith("b:")) continue;
    if (store.blocks.has(b.parent.slice(2))) continue;
    orphans.push(b.id);
  }
  if (orphans.length) {
    orphans.sort((a, b) => titleOf(store, a).localeCompare(titleOf(store, b)) || (a < b ? -1 : 1));
    sections.push({ id: SHARED_SECTION, name: "Shared with you" });
    children[sectionKey(SHARED_SECTION)] = [];
    for (const id of orphans) {
      const b = store.blocks.get(id)!;
      const node: OutlineNode = { kind: b.type === "databasePage" ? "database" : "page", section: SHARED_SECTION };
      const icon = iconText(b);
      if (icon) node.icon = icon;
      nodes[id] = node;
      push(sectionKey(SHARED_SECTION), id);
      visit("b:" + id, id, SHARED_SECTION);
    }
  }

  const trash: TrashEntry[] = [];
  for (const b of store.blocks.values()) {
    if (b.trashedAt === undefined) continue;
    const e: TrashEntry = { id: b.id, trashedAt: b.trashedAt };
    const from = parentTitle(store, b);
    if (from) e.from = from;
    trash.push(e);
  }
  trash.sort((a, b) => b.trashedAt - a.trashedAt || (a.id < b.id ? -1 : 1));
  return { workspaceName: store.workspace.name, sections, children, nodes, favorites: store.workspace.favorites.filter((f) => nodes[f]), trash };
}

function parentTitle(store: WorkspaceStore, b: Block): string | undefined {
  if (b.parent.startsWith("d:")) {
    const db = store.databases.get(b.parent.slice(2));
    return db ? richPlain(db.title) || "Untitled" : undefined;
  }
  let p = b.parent;
  for (let n = 0; p.startsWith("b:") && n < 1000; n++) {
    const pb = store.blocks.get(p.slice(2));
    if (!pb) return undefined;
    if (isPageLike(pb)) return titleOf(store, pb.id);
    p = pb.parent;
  }
  return undefined;
}

/** Titel aller Seiten (auch Zeilen und Papierkorb), für Seitenleiste, Breadcrumb und Papierkorb. */
export function pageTitles(store: WorkspaceStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of store.blocks.values()) if (isPageLike(b)) out[b.id] = titleOf(store, b.id);
  return out;
}

/** Was eine Seite in der Seitenleiste ausmacht (ohne Titel): ändert sich das, ist die Struktur neu. */
export function structureSignature(b: Block | undefined): string {
  if (!b) return "";
  return [b.type, b.parent, b.sk, b.trashedAt ?? "", b.props?.teamspace ?? "", iconText(b) ?? ""].join("\u0001");
}

/** Kette der Seiten über `id` (ohne `id`), oberste zuerst; Datenbankzeilen gehen über ihre Datenbank. */
export function pageAncestors(store: WorkspaceStore, id: string): string[] {
  const out: string[] = [];
  let p = store.blocks.get(id)?.parent;
  for (let n = 0; p && p !== "w" && n < 1000; n++) {
    let next: string | undefined;
    if (p.startsWith("b:")) next = p.slice(2);
    else next = store.databases.get(p.slice(2))?.blockID;
    const nb = next ? store.blocks.get(next) : undefined;
    if (!nb) break;
    if (nb.type === "page" || nb.type === "databasePage") out.unshift(nb.id);
    p = nb.parent;
  }
  return out;
}
