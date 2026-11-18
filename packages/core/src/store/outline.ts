// BSD-153: Struktur der Seitenleiste (Abschnitte, verschachtelte Seiten, Favoriten, Papierkorb) als schlanker,
// serialisierbarer Stand – getrennt von den Titeln, damit Tippen im Titel nicht die ganze Struktur neu schickt.
// Eine Seite hängt in der Seitenleiste unter der nächsten Seite über ihr (auch wenn sie in einem Toggle liegt);
// Datenbankzeilen erscheinen nicht. Reihenfolge = Dokumentreihenfolge.
import { richPlain, titleOf } from "../query/engine.js";
import type { Block } from "../model/records.js";
import type { WorkspaceStore } from "./store.js";
import { hasPageTitle, isPageLike, sectionOf } from "./pages.js";

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
  /** BSD-205: Emoji des Workspaces, falls gesetzt. */
  workspaceIcon?: string;
  /** Teamspaces in ihrer Reihenfolge, dann Private. */
  sections: OutlineSection[];
  /** Kinder je Abschnitt (`section:<id>`) oder Seite (`<id>`), nur Seiten außerhalb des Papierkorbs. */
  children: Record<string, string[]>;
  nodes: Record<string, OutlineNode>;
  favorites: string[];
  trash: TrashEntry[];
}

export const sectionKey = (id: string) => "section:" + id;

/** Gehört die Datenbank diesem Block (nicht nur eine verknüpfte Ansicht)? */
function ownsDatabase(store: WorkspaceStore, b: Block): boolean {
  const db = b.props?.databaseID;
  return db !== undefined && store.databases.get(db)?.blockID === b.id;
}

export function iconText(b: Block | undefined): string | undefined {
  const icon = b?.props?.icon;
  if (!icon) return undefined;
  if (typeof icon === "string") return icon;
  return icon.emoji ?? icon.symbol;
}

type OutlinePath = (readonly [string, string])[];
const comparePaths = (a: OutlinePath, b: OutlinePath) => {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const [ask, aid] = a[i]!, [bsk, bid] = b[i]!;
    if (ask !== bsk) return ask < bsk ? -1 : 1;
    if (aid !== bid) return aid < bid ? -1 : 1;
  }
  return a.length - b.length;
};
const ROOT = Symbol("root"), MISSING = Symbol("missing");

/**
 * Seitenleisten-Struktur eines Stands. Gerechnet wird nur über das Gerüst (Seiten, Datenbanken): jede Seite sucht
 * nach oben ihre nächste Seite, die Reihenfolge ist die Dokumentreihenfolge (Pfad aus Sortierschlüsseln). Das braucht
 * keinen Seiteninhalt und lädt deshalb nichts nach (ADR 0017 Stufe B) – das Ergebnis ist dasselbe wie bei der
 * Tiefensuche über alle Blöcke (`buildOutlineByWalk`, ein Test vergleicht beide).
 */
export function buildOutline(store: WorkspaceStore): Outline {
  const { sections, children, nodes, push } = outlineFrame(store);

  // 1) Jede Seite (und eigene Inline-Datenbank) ihrem Behälter zuordnen: Wurzel, nächste Seite darüber, oder keiner.
  const under = new Map<string | typeof ROOT, { id: string; path: OutlinePath }[]>();
  const orphans: string[] = [];
  for (const b of store.skeletonBlocks()) {
    if (b.trashedAt !== undefined) continue;
    const page = isPageLike(b);
    if (!page && !(b.type === "databaseInline" && ownsDatabase(store, b))) continue;
    const path: OutlinePath = [[b.sk, b.id]];
    let container: string | typeof ROOT | typeof MISSING | undefined;
    let throughInline = false;
    let cur = b;
    for (let n = 0; n < 1000; n++) {
      const p = cur.parent;
      if (p === "w") { container = ROOT; break; }
      if (!p.startsWith("b:")) break; // Datenbankzeilen erscheinen nicht
      const pb = store.blocks.get(p.slice(2));
      if (!pb) { if (cur === b) container = MISSING; break; }
      if (pb.trashedAt !== undefined) break;
      if (isPageLike(pb)) { container = pb.id; break; }
      // Unter einer eigenen Inline-Datenbank, die selbst unter einer Seite steht, wird nicht weitergesucht.
      if (pb.type === "databaseInline" && ownsDatabase(store, pb)) throughInline = true;
      path.unshift([pb.sk, pb.id]);
      cur = pb;
    }
    if (container === undefined) continue;
    if (container === MISSING) { if (page) orphans.push(b.id); continue; }
    if (container !== ROOT && throughInline) continue;
    if (!page && container === ROOT) continue; // Inline-Datenbank ohne Seite darüber ist kein Eintrag
    let list = under.get(container);
    if (!list) under.set(container, (list = []));
    list.push({ id: b.id, path });
  }
  for (const list of under.values()) list.sort((a, b) => comparePaths(a.path, b.path));

  // 2) Von oben nach unten ausgeben; nur was von der Wurzel (oder einer verwaisten Seite) erreichbar ist.
  const emit = (container: string | typeof ROOT, page: string | undefined, section: string) => {
    for (const { id } of under.get(container) ?? []) {
      const b = store.blocks.get(id)!;
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
        emit(id, id, sec);
      } else if (page) {
        // BSD-377: Inline-Datenbanken stehen wie in Notion unter ihrer Seite (verknüpfte Ansichten nicht).
        const node: OutlineNode = { kind: "database", section, parent: page };
        const icon = iconText(b);
        if (icon) node.icon = icon;
        nodes[id] = node;
        push(page, id);
      }
    }
  };
  emit(ROOT, undefined, PRIVATE_SECTION);

  // BSD-235: Seiten, deren Eltern dieses Gerät nicht kennt – im Gast-Modus die geteilten Seiten (der Server schickt
  // nur den geteilten Bereich, ohne Workspace und ohne die Seiten darüber). Eigene Sektion „Shared with you“.
  const shared = orphans.filter((id) => !nodes[id]);
  if (shared.length) {
    shared.sort((a, b) => titleOf(store, a).localeCompare(titleOf(store, b)) || (a < b ? -1 : 1));
    sections.push({ id: SHARED_SECTION, name: "Shared with you" });
    children[sectionKey(SHARED_SECTION)] = [];
    for (const id of shared) {
      const b = store.blocks.get(id)!;
      const node: OutlineNode = { kind: b.type === "databasePage" ? "database" : "page", section: SHARED_SECTION };
      const icon = iconText(b);
      if (icon) node.icon = icon;
      nodes[id] = node;
      push(sectionKey(SHARED_SECTION), id);
      emit(id, id, SHARED_SECTION);
    }
  }
  return finishOutline(store, sections, children, nodes);
}

function outlineFrame(store: WorkspaceStore) {
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
  return { sections, children, nodes, push };
}

/**
 * Dieselbe Struktur als Tiefensuche über alle Blöcke – die ursprüngliche Fassung. Sie lädt den ganzen Inhalt und
 * bleibt nur als Vergleich für Tests (`buildOutline` muss dasselbe liefern).
 */
export function buildOutlineByWalk(store: WorkspaceStore): Outline {
  const { sections, children, nodes, push } = outlineFrame(store);

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
      } else if (page && b.type === "databaseInline" && ownsDatabase(store, b)) {
        // BSD-377: Inline-Datenbanken stehen wie in Notion unter ihrer Seite (verknüpfte Ansichten nicht).
        const node: OutlineNode = { kind: "database", section, parent: page };
        const icon = iconText(b);
        if (icon) node.icon = icon;
        nodes[id] = node;
        push(page, id);
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

  return finishOutline(store, sections, children, nodes);
}

function finishOutline(store: WorkspaceStore, sections: OutlineSection[], children: Record<string, string[]>, nodes: Record<string, OutlineNode>): Outline {
  const trash: TrashEntry[] = [];
  for (const b of store.skeletonBlocks()) {
    if (b.trashedAt === undefined) continue;
    const e: TrashEntry = { id: b.id, trashedAt: b.trashedAt };
    const from = parentTitle(store, b);
    if (from) e.from = from;
    trash.push(e);
  }
  trash.sort((a, b) => b.trashedAt - a.trashedAt || (a.id < b.id ? -1 : 1));
  const wsIcon = store.workspace.icon;
  return { workspaceName: store.workspace.name, ...(typeof wsIcon === "string" && wsIcon ? { workspaceIcon: wsIcon } : typeof wsIcon === "object" && wsIcon?.emoji ? { workspaceIcon: wsIcon.emoji } : {}), sections, children, nodes, favorites: store.workspace.favorites.filter((f) => nodes[f]), trash };
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
  for (const b of store.skeletonBlocks()) if (hasPageTitle(b)) out[b.id] = titleOf(store, b.id);
  return out;
}

/** Was eine Seite in der Seitenleiste ausmacht (ohne Titel): ändert sich das, ist die Struktur neu. */
export function structureSignature(b: Block | undefined): string {
  if (!b) return "";
  return [b.type, b.parent, b.sk, b.trashedAt ?? "", b.props?.teamspace ?? "", iconText(b) ?? ""].join("\u0001");
}

/** Kette der Seiten über `id` (ohne `id`), oberste zuerst; Datenbankzeilen gehen über ihre Datenbank. */
/**
 * Wo eine Seite liegt, als eine Zeile für Suchergebnisse: „Eltern / Großeltern“ von oben nach unten; bei einer
 * Datenbankzeile endet der Weg bei der Datenbank. Leer, wenn die Seite ganz oben liegt.
 */
export function pageLocation(store: WorkspaceStore, id: string): string {
  return pageAncestors(store, id).map((a) => titleOf(store, a) || "Untitled").join(" / ");
}

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
