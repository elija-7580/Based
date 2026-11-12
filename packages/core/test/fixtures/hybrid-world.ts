// BSD-317: eine kleine Notion-Welt für Tests – daraus entstehen BEIDE Quellen des Hybrid-Imports: der HTML-Export
// (ZIP, im Layout von Notions Exporter) und die API (Routen der öffentlichen REST-API, Version 2026-03-11). Tests
// verändern die Welt gezielt (Seite nach dem Export bearbeiten, aus dem ZIP nehmen, nicht teilen …).
import { writeZip } from "../../src/index.js";
import type { JSONValue, NotionTransport } from "../../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Lesbare, gültige UUID aus Präfix und Nummer. */
export const uid = (kind: number, n: number) => `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const bare = (id: string) => id.replaceAll("-", "");
const rt = (s: string): JSONValue => (s === "" ? [] : [{ type: "text", plain_text: s, href: null, text: { content: s }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }]);
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type Body =
  | { t: "p"; id: string; text: string }
  | { t: "toggle"; id: string; text: string; children: Body[] }
  | { t: "sub"; id: string }
  | { t: "db"; id: string }
  | { t: "link"; id: string };

export interface WPage {
  id: string;
  title: string;
  /** Elternseite, Datenquelle (Zeile) oder nichts (oberste Ebene). */
  parent?: string | undefined;
  row?: string | undefined;
  /** Liegt in Notion in einem Block (Toggle …): die API nennt dann `block_id`. */
  inBlock?: string | undefined;
  created: string;
  edited: string;
  body: Body[];
  values?: Record<string, JSONValue>;
  /** Im Export enthalten / mit der Integration geteilt. */
  inZip: boolean;
  shared: boolean;
  /** Titel, wie er im Export steht (falls er abweicht). */
  zipTitle?: string;
  zipBody?: Body[];
  fullWidth?: boolean;
}

export interface WDatabase {
  id: string;
  ds: string;
  title: string;
  parent?: string | undefined;
  inline: boolean;
  properties: Record<string, JSONValue>;
  views: JSONValue[];
  rows: string[];
  shared: boolean;
  edited: string;
  /** ID des Blocks im Export, falls sie von der Datenbank-ID abweicht. */
  divID?: string;
}

export class World {
  readonly pages = new Map<string, WPage>();
  readonly databases = new Map<string, WDatabase>();
  exportedAt = new Date("2026-11-01T12:00:00Z");
  /** Anfragen je Art („search“, „children“, „rows“ …). */
  readonly requests = new Map<string, number>();
  /** Nach so vielen Anfragen bricht das Netz ab (Abbruch-Tests). */
  failAfter: number | undefined;
  total = 0;

  page(id: string, title: string, o: Partial<WPage> = {}): WPage {
    const p: WPage = { id, title, created: "2026-01-05T09:30:00.000Z", edited: "2026-10-01T08:00:00.000Z", body: [], inZip: true, shared: true, ...o };
    this.pages.set(id, p);
    return p;
  }

  database(id: string, ds: string, title: string, o: Partial<WDatabase> = {}): WDatabase {
    const d: WDatabase = {
      id, ds, title, inline: false, rows: [], shared: true, edited: "2026-10-01T08:00:00.000Z",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
      views: [{ object: "view", id: uid(0x99, this.databases.size + 1), name: "All", type: "table", data_source_id: ds, parent: { type: "database_id", database_id: id }, filter: null, sorts: [], configuration: { type: "table", properties: [{ property_id: "title", visible: true }] } }],
      ...o,
    };
    this.databases.set(id, d);
    return d;
  }

  row(db: WDatabase, id: string, title: string, o: Partial<WPage> = {}): WPage {
    db.rows.push(id);
    return this.page(id, title, { row: db.ds, ...o });
  }

  // MARK: API

  private pageObject(p: WPage): JSONValue {
    const parent: JSONValue = p.row !== undefined ? { type: "data_source_id", data_source_id: p.row }
      : p.inBlock !== undefined ? { type: "block_id", block_id: p.inBlock }
      : p.parent !== undefined ? { type: "page_id", page_id: p.parent } : { type: "workspace", workspace: true };
    const props: { [k: string]: JSONValue } = { Name: { id: "title", type: "title", title: rt(p.title) } };
    for (const [k, v] of Object.entries(p.values ?? {})) props[k] = v;
    return { object: "page", id: p.id, created_time: p.created, last_edited_time: p.edited, created_by: { object: "user", id: USER }, last_edited_by: { object: "user", id: USER },
      icon: null, cover: null, in_trash: false, parent, properties: props };
  }

  private dbParent(d: WDatabase): JSONValue {
    return d.parent !== undefined ? { type: "page_id", page_id: d.parent } : { type: "workspace", workspace: true };
  }

  private blocksOf(list: Body[]): JSONValue[] {
    const base = (id: string, type: string, has: boolean) => ({ object: "block", id, type, has_children: has, created_time: "2026-01-05T09:30:00.000Z", last_edited_time: "2026-10-01T08:00:00.000Z" });
    return list.map((b): JSONValue => {
      switch (b.t) {
        case "p": return { ...base(b.id, "paragraph", false), paragraph: { rich_text: rt(b.text), color: "default" } };
        case "toggle": return { ...base(b.id, "toggle", b.children.length > 0), toggle: { rich_text: rt(b.text), color: "default" } };
        case "sub": return { ...base(b.id, "child_page", false), child_page: { title: this.pages.get(b.id)?.title ?? "" } };
        case "db": return { ...base(b.id, "child_database", false), child_database: { title: this.databases.get(b.id)?.title ?? "" } };
        case "link": return { ...base(uid(0xee, [...b.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 99991, 7)), "link_to_page", false), link_to_page: { type: "page_id", page_id: b.id } };
      }
    });
  }

  private findBlock(id: string): { body: Body; page: WPage } | undefined {
    for (const p of this.pages.values()) {
      const walk = (list: Body[]): Body | undefined => {
        for (const b of list) {
          if (b.id === id && b.t !== "sub" && b.t !== "db" && b.t !== "link") return b;
          if (b.t === "toggle") { const r = walk(b.children); if (r) return r; }
        }
        return undefined;
      };
      const r = walk(p.body);
      if (r) return { body: r, page: p };
    }
    return undefined;
  }

  private answer(method: string, path: string, query: URLSearchParams, body: JSONValue | undefined): JSONValue | undefined {
    const list = (results: JSONValue[], cursorIn?: string | null): JSONValue => {
      const start = cursorIn ? Number(cursorIn) : 0;
      const slice = results.slice(start, start + 100);
      const more = start + 100 < results.length;
      return { object: "list", results: slice, has_more: more, next_cursor: more ? String(start + 100) : null };
    };
    const b = (body ?? {}) as { [k: string]: JSONValue };
    const cursor = (typeof b.start_cursor === "string" ? b.start_cursor : undefined) ?? query.get("start_cursor");
    const parts = path.split("/");
    if (method === "GET" && path === "users") { this.count("users"); return list([{ object: "user", id: USER, name: "Elija", type: "person" }]); }
    if (method === "POST" && path === "search") {
      this.count("search");
      const all: { edited: string; o: JSONValue }[] = [];
      for (const p of this.pages.values()) if (p.shared) all.push({ edited: p.edited, o: this.pageObject(p) });
      for (const d of this.databases.values()) {
        if (d.shared) all.push({ edited: d.edited, o: { object: "data_source", id: d.ds, last_edited_time: d.edited, parent: { type: "database_id", database_id: d.id }, database_parent: this.dbParent(d), title: rt(d.title) } });
      }
      if (b.sort) all.sort((x, y) => (x.edited < y.edited ? 1 : x.edited > y.edited ? -1 : 0));
      return list(all.map((x) => x.o), cursor);
    }
    if (method === "GET" && parts[0] === "pages" && parts.length === 2) {
      this.count("page");
      const p = this.pages.get(parts[1]!);
      return p && p.shared ? this.pageObject(p) : undefined;
    }
    if (method === "GET" && parts[0] === "blocks" && parts[2] === "children") {
      this.count("children");
      const id = parts[1]!;
      const p = this.pages.get(id);
      if (p) return p.shared ? list(this.blocksOf(p.body), cursor) : undefined;
      const blk = this.findBlock(id);
      if (blk && blk.body.t === "toggle") return list(this.blocksOf(blk.body.children), cursor);
      return undefined;
    }
    if (method === "GET" && parts[0] === "blocks" && parts.length === 2) {
      this.count("block");
      const blk = this.findBlock(parts[1]!);
      return blk ? { object: "block", id: parts[1]!, type: "toggle", parent: { type: "page_id", page_id: blk.page.id } } : undefined;
    }
    if (method === "GET" && parts[0] === "databases" && parts.length === 2) {
      this.count("database");
      const d = this.databases.get(parts[1]!);
      return d && d.shared ? { object: "database", id: d.id, created_time: "2026-01-05T09:30:00.000Z", title: rt(d.title), is_inline: d.inline, icon: null, cover: null, parent: this.dbParent(d), data_sources: [{ id: d.ds, name: d.title }], last_edited_time: d.edited } : undefined;
    }
    if (parts[0] === "data_sources") {
      const d = [...this.databases.values()].find((x) => x.ds === parts[1]);
      if (!d || !d.shared) return undefined;
      if (method === "GET" && parts.length === 2) {
        this.count("dataSource");
        return { object: "data_source", id: d.ds, parent: { type: "database_id", database_id: d.id }, title: rt(d.title), properties: d.properties, last_edited_time: d.edited };
      }
      if (method === "POST" && parts[2] === "query") {
        this.count("rows");
        const since = (((b.filter ?? {}) as { [k: string]: JSONValue }).last_edited_time as { on_or_after?: string } | undefined)?.on_or_after;
        const rows = d.rows.map((id) => this.pages.get(id)!).filter((p) => p.shared && (since === undefined || p.edited >= since));
        return list(rows.map((p) => this.pageObject(p)), cursor);
      }
    }
    if (parts[0] === "views") {
      if (method === "GET" && parts.length === 1) {
        this.count("views");
        const d = this.databases.get(query.get("database_id") ?? "");
        return d ? list(d.views.map((v) => ({ object: "view", id: (v as { id: string }).id }))) : undefined;
      }
      const d = [...this.databases.values()].find((x) => x.views.some((v) => (v as { id: string }).id === parts[1]));
      if (!d) return undefined;
      if (method === "GET" && parts.length === 2) { this.count("view"); return d.views.find((v) => (v as { id: string }).id === parts[1]); }
      if (method === "POST" && parts[2] === "queries") {
        this.count("viewOrder");
        const start = 0;
        const ids = d.rows.filter((id) => this.pages.get(id)?.shared);
        return { object: "view_query", id: "q" + parts[1], results: ids.slice(start, 100).map((id) => ({ object: "page", id })), has_more: ids.length > 100, next_cursor: ids.length > 100 ? "100" : null };
      }
      if (method === "GET" && parts[2] === "queries") {
        this.count("viewOrder");
        const ids = d.rows.filter((id) => this.pages.get(id)?.shared);
        const start = Number(query.get("start_cursor") ?? "0");
        const more = start + 100 < ids.length;
        return { object: "view_query", id: parts[3]!, results: ids.slice(start, start + 100).map((id) => ({ object: "page", id })), has_more: more, next_cursor: more ? String(start + 100) : null };
      }
      if (method === "DELETE") { this.count("viewOrder"); return { object: "view_query", deleted: true }; }
    }
    return undefined;
  }

  private count(kind: string) { this.requests.set(kind, (this.requests.get(kind) ?? 0) + 1); }
  get(kind: string) { return this.requests.get(kind) ?? 0; }

  transport(): NotionTransport {
    return {
      send: async (method, url, _headers, body) => {
        this.total += 1;
        if (this.failAfter !== undefined && this.total > this.failAfter) throw new TypeError("network down");
        const u = new URL(url);
        const path = u.pathname.startsWith("/v1/") ? u.pathname.slice(4) : u.pathname;
        const r = this.answer(method, path, u.searchParams, body === undefined ? undefined : (JSON.parse(body) as JSONValue));
        if (r === undefined) return { status: 404, headers: {}, body: enc.encode(JSON.stringify({ object: "error", code: "object_not_found", message: `Could not find ${method} ${path}` })) };
        return { status: 200, headers: {}, body: enc.encode(JSON.stringify(r)) };
      },
    };
  }

  // MARK: Export

  private fileName(title: string, id: string) { return `${title.replaceAll("/", " ")} ${bare(id)}`; }

  /** Pfad der Datei einer Seite oder Datenbank im Export (ohne Endung). */
  private pathOf(id: string): string {
    const p = this.pages.get(id);
    if (p) {
      const name = this.fileName(p.zipTitle ?? p.title, p.id);
      if (p.row !== undefined) { const d = [...this.databases.values()].find((x) => x.ds === p.row)!; return `${this.pathOf(d.id)}/${name}`; }
      return p.parent !== undefined ? `${this.pathOf(p.parent)}/${name}` : name;
    }
    const d = this.databases.get(id)!;
    const name = this.fileName(d.title, d.id);
    return d.parent !== undefined ? `${this.pathOf(d.parent)}/${name}` : name;
  }

  private href(from: string, to: string) {
    // Notion verlinkt relativ zum Ordner der Datei.
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const rel = dir !== "" && to.startsWith(dir + "/") ? to.slice(dir.length + 1) : "../".repeat(dir === "" ? 0 : dir.split("/").length) + to;
    return rel.split("/").map((s) => (s === ".." ? s : encodeURIComponent(s))).join("/") + ".html";
  }

  private table(d: WDatabase, from: string): string {
    const rows = d.rows.map((id) => this.pages.get(id)!).filter((p) => p.inZip);
    return `<table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th></tr></thead><tbody>${
      rows.map((r) => `<tr id="${r.id}"><td class="cell-title"><a href="${this.href(from, this.pathOf(r.id))}">${esc(r.zipTitle ?? r.title)}</a></td></tr>`).join("")}</tbody></table>`;
  }

  private html(list: Body[], from: string): string {
    return list.map((b): string => {
      switch (b.t) {
        case "p": return `<p id="${b.id}" class="">${esc(b.text)}</p>`;
        case "toggle": return `<ul id="${b.id}" class="toggle"><li><details open=""><summary>${esc(b.text)}</summary>${this.html(b.children, from)}</details></li></ul>`;
        case "sub": case "link": { const p = this.pages.get(b.id); return p && p.inZip ? `<figure class="link-to-page"><a href="${this.href(from, this.pathOf(b.id))}">${esc(p.title)}</a></figure>` : ""; }
        case "db": {
          const d = this.databases.get(b.id)!;
          if (!d.inline) return `<figure class="link-to-page"><a href="${this.href(from, this.pathOf(d.id))}">${esc(d.title)}</a></figure>`;
          return `<div id="${d.divID ?? d.id}" class="collection-content"><h4 class="collection-title">${esc(d.title)}</h4>${this.table(d, from)}</div>`;
        }
      }
    }).join("\n");
  }

  files(): { path: string; data: Uint8Array }[] {
    const out: { path: string; data: Uint8Array }[] = [];
    const doc = (id: string, cls: string, title: string, inner: string) =>
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>${esc(title)}</title><style>body{}</style></head><body><article id="${id}" class="page sans${cls}"><header><h1 class="page-title">${esc(title)}</h1><p class="page-description"></p></header>${inner}</article></body></html>`;
    for (const p of this.pages.values()) {
      if (!p.inZip) continue;
      const path = this.pathOf(p.id);
      out.push({ path: path + ".html", data: enc.encode(doc(p.id, p.fullWidth ? " full-width" : "", p.zipTitle ?? p.title, `<div class="page-body">${this.html(p.zipBody ?? p.body, path)}</div>`)) });
    }
    for (const d of this.databases.values()) {
      if (d.inline) continue;
      const path = this.pathOf(d.id);
      out.push({ path: path + ".html", data: enc.encode(doc(d.id, "", d.title, `<div class="page-body"><div class="collection-content">${this.table(d, path)}</div></div>`)) });
    }
    return out;
  }

  zip(): Uint8Array {
    return writeZip(this.files().map((f) => ({ path: "Export/" + f.path, data: f.data })), this.exportedAt);
  }
}

export const text = (b: Uint8Array) => dec.decode(b);

/** Kleine Welt mit allem, was die Tests brauchen: Baum, Toggle mit Unterseite, Inline- und ganzseitige Datenbank, Relation über Teilbäume. */
export function smallWorld(): World {
  const w = new World();
  const HOME = uid(1, 1), SPEC = uid(1, 2), NOTES = uid(1, 3), DEEP = uid(1, 4), OTHER = uid(1, 5), NESTED = uid(1, 6);
  const TASKS = uid(2, 1), TASKS_DS = uid(3, 1), PEOPLE = uid(2, 2), PEOPLE_DS = uid(3, 2);
  const T1 = uid(4, 1), T2 = uid(4, 2), ADA = uid(5, 1), BOB = uid(5, 2);
  w.page(HOME, "Home", { fullWidth: true, body: [
    { t: "p", id: uid(0xb, 1), text: "Welcome home" },
    { t: "sub", id: SPEC },
    { t: "p", id: uid(0xb, 2), text: "Between spec and tasks" },
    { t: "db", id: TASKS },
    { t: "toggle", id: uid(0xb, 3), text: "More", children: [{ t: "p", id: uid(0xb, 4), text: "Inside toggle" }, { t: "sub", id: NESTED }] },
    { t: "sub", id: NOTES },
    { t: "p", id: uid(0xb, 5), text: "The end" },
  ] });
  w.page(SPEC, "Spec", { parent: HOME, body: [{ t: "p", id: uid(0xb, 10), text: "Spec body" }, { t: "sub", id: DEEP }] });
  w.page(DEEP, "Deep", { parent: SPEC, body: [{ t: "p", id: uid(0xb, 11), text: "Deep body" }] });
  w.page(NOTES, "Notes", { parent: HOME, body: [{ t: "p", id: uid(0xb, 12), text: "Notes body" }] });
  w.page(NESTED, "Nested in toggle", { parent: HOME, inBlock: uid(0xb, 3), body: [{ t: "p", id: uid(0xb, 13), text: "Nested body" }] });
  w.page(OTHER, "Other tree", { body: [{ t: "p", id: uid(0xb, 20), text: "Other body" }, { t: "db", id: PEOPLE }] });
  const tasks = w.database(TASKS, TASKS_DS, "Tasks", { parent: HOME, inline: true });
  tasks.properties.Owner = { id: "ow", name: "Owner", type: "relation", relation: { data_source_id: PEOPLE_DS, type: "single_property", single_property: {} } };
  tasks.properties.Done = { id: "dn", name: "Done", type: "checkbox", checkbox: {} };
  tasks.views.push({ object: "view", id: uid(0x99, 50), name: "Open", type: "board", data_source_id: TASKS_DS, parent: { type: "database_id", database_id: TASKS },
    filter: { property: "Done", checkbox: { equals: false } }, sorts: [{ property: "Name", direction: "ascending" }], configuration: { type: "board", properties: [{ property_id: "title", visible: true }] } });
  const people = w.database(PEOPLE, PEOPLE_DS, "People", { parent: OTHER, inline: true });
  w.row(people, ADA, "Ada", { body: [{ t: "p", id: uid(0xb, 30), text: "Ada body" }] });
  w.row(people, BOB, "Bob", { body: [] });
  w.row(tasks, T1, "Write docs", { body: [{ t: "p", id: uid(0xb, 40), text: "Row body" }],
    values: { Owner: { id: "ow", type: "relation", relation: [{ id: ADA }], has_more: false }, Done: { id: "dn", type: "checkbox", checkbox: true } } });
  w.row(tasks, T2, "Plan", { body: [], values: { Owner: { id: "ow", type: "relation", relation: [{ id: BOB }], has_more: false }, Done: { id: "dn", type: "checkbox", checkbox: false } } });
  return w;
}

export const IDS = {
  HOME: uid(1, 1), SPEC: uid(1, 2), NOTES: uid(1, 3), DEEP: uid(1, 4), OTHER: uid(1, 5), NESTED: uid(1, 6),
  TASKS: uid(2, 1), TASKS_DS: uid(3, 1), PEOPLE: uid(2, 2), PEOPLE_DS: uid(3, 2), T1: uid(4, 1), T2: uid(4, 2), ADA: uid(5, 1), BOB: uid(5, 2),
};

/** Große Welt für den Laufzeit-Benchmark: `pages` Seiten, davon ~80 % Datenbankzeilen. */
export function bigWorld(pages: number): World {
  const w = new World();
  const dbCount = Math.max(1, Math.round(pages / 500));
  const rowsPer = Math.floor((pages * 0.8) / dbCount);
  const treePages = pages - dbCount * rowsPer;
  let n = 0;
  const body = (k: number): Body[] => Array.from({ length: 8 }, (_, i) => ({ t: "p" as const, id: uid(0xb0 + (i % 8), k), text: `Paragraph ${i + 1} of page ${k} — lorem ipsum dolor sit amet, consectetur adipiscing elit.` }));
  const stamp = (k: number) => new Date(Date.UTC(2026, 0, 1) + (k % 280) * 86_400_000).toISOString();
  // Baum: Wurzeln mit je 20 Kindern mit je einigen Enkeln.
  const tree: string[] = [];
  while (tree.length < treePages) {
    const root = uid(1, ++n);
    const rootPage = w.page(root, `Area ${n}`, { edited: stamp(n) });
    tree.push(root);
    for (let c = 0; c < 20 && tree.length < treePages; c++) {
      const child = uid(1, ++n);
      const cp = w.page(child, `Topic ${n}`, { parent: root, edited: stamp(n), body: body(n) });
      rootPage.body.push({ t: "sub", id: child });
      tree.push(child);
      for (let g = 0; g < 4 && tree.length < treePages; g++) {
        const grand = uid(1, ++n);
        w.page(grand, `Note ${n}`, { parent: child, edited: stamp(n), body: body(n) });
        cp.body.push({ t: "sub", id: grand });
        tree.push(grand);
      }
    }
  }
  for (let d = 0; d < dbCount; d++) {
    const host = tree[(d * 37) % tree.length]!;
    const db = w.database(uid(2, d + 1), uid(3, d + 1), `Database ${d + 1}`, { parent: host, inline: d % 2 === 0 });
    db.properties.Done = { id: "dn", name: "Done", type: "checkbox", checkbox: {} };
    if (db.inline) w.pages.get(host)!.body.push({ t: "db", id: db.id });
    for (let r = 0; r < rowsPer; r++) {
      const id = uid(4, d * 100_000 + r + 1);
      w.row(db, id, `Row ${d + 1}.${r + 1}`, { edited: stamp(d * 7 + r), body: r % 3 === 0 ? [] : body(d * 100_000 + r + 1).slice(0, 4), values: { Done: { id: "dn", type: "checkbox", checkbox: r % 2 === 0 } } });
    }
  }
  return w;
}
