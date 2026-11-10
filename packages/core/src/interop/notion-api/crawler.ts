// BSD-217: holt alles, was von den Zielen aus erreichbar ist (Port von Swift `NotionCrawler`): Seiten, Blöcke,
// Datenbanken, Datenquellen, Ansichten, Zeilen, abgeschnittene Property-Werte, Dateien, Nutzer. Ergebnis ist ein
// reiner Datenstand (`NotionSnapshot`), den `mapNotionSnapshot` offline in Records übersetzt.
import type { JSONValue } from "../../json.js";
import { notionUUID } from "../importids.js";
import { NotionAPIError, type NotionClient } from "./client.js";

export interface NotionImportOptions {
  /** Inhalt der Datenbankzeilen holen (eine Anfrage je Zeile). */
  rowContent: boolean;
  /** Datenbanken mitnehmen, auf die Relationen zeigen. */
  followRelations: boolean;
  /** Von Notion gehostete Dateien kopieren (ihre URLs laufen nach einer Stunde ab). */
  downloadFiles: boolean;
  subpages: boolean;
  maxConcurrent: number;
}

export const defaultNotionImportOptions = (): NotionImportOptions => ({ rowContent: true, followRelations: true, downloadFiles: true, subpages: true, maxConcurrent: 3 });

export type NotionRoot = { page: string } | { database: string };

export interface NotionSnapshot {
  roots: NotionRoot[];
  pages: Map<string, JSONValue>;
  children: Map<string, JSONValue[]>;
  databases: Map<string, JSONValue>;
  dataSources: Map<string, JSONValue>;
  views: Map<string, JSONValue[]>;
  rows: Map<string, string[]>;
  propertyItems: Map<string, Map<string, JSONValue[]>>;
  /** `notionFileKey(url)` → heruntergeladene Datei. */
  files: Map<string, { name: string; data: Uint8Array }>;
  users: Map<string, string>;
  warnings: string[];
}

export const emptySnapshot = (): NotionSnapshot => ({
  roots: [], pages: new Map(), children: new Map(), databases: new Map(), dataSources: new Map(), views: new Map(), rows: new Map(),
  propertyItems: new Map(), files: new Map(), users: new Map(), warnings: [],
});

/** Signierte Datei-URLs ändern sich bei jeder Anfrage; der Pfad bestimmt die Datei. */
export function notionFileKey(url: string): string {
  const i = url.search(/[?#]/);
  return i >= 0 ? url.slice(0, i) : url;
}

type Obj = { [k: string]: JSONValue };
export const jobj = (v: JSONValue | undefined): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
export const jarr = (v: JSONValue | undefined): JSONValue[] => (Array.isArray(v) ? v : []);
export const jstr = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
export const at = (v: JSONValue | undefined, ...path: string[]): JSONValue | undefined => {
  let cur = v;
  for (const k of path) { cur = jobj(cur)?.[k]; if (cur === undefined) return undefined; }
  return cur;
};
/** Normalisierte ID (Striche, klein). */
export const nid = (v: JSONValue | undefined): string | undefined => { const s = jstr(v); return s === undefined ? undefined : notionUUID(s) ?? s; };

type Job =
  | { k: "resolve"; id: string } | { k: "search" } | { k: "page"; id: string } | { k: "children"; id: string }
  | { k: "database"; id: string } | { k: "dataSource"; id: string } | { k: "rows"; id: string } | { k: "views"; id: string }
  | { k: "propertyItem"; page: string; prop: string } | { k: "download"; url: string; name: string | undefined } | { k: "users" };

const jobKey = (j: Job) => JSON.stringify(j);

interface Outcome {
  pages: JSONValue[]; children: [string, JSONValue[]][]; databases: JSONValue[]; dataSources: JSONValue[]; views: [string, JSONValue[]][];
  rows: [string, string[]][]; viewOrders: [string, string[]][]; propertyItems: [string, string, JSONValue[]][];
  files: [string, { name: string; data: Uint8Array }][]; users: [string, string][]; roots: NotionRoot[]; searchResults: JSONValue[];
  warnings: string[]; next: Job[];
}
const outcome = (): Outcome => ({ pages: [], children: [], databases: [], dataSources: [], views: [], rows: [], viewOrders: [], propertyItems: [], files: [], users: [], roots: [], searchResults: [], warnings: [], next: [] });

const sameRoot = (a: NotionRoot, b: NotionRoot) => ("page" in a && "page" in b && a.page === b.page) || ("database" in a && "database" in b && a.database === b.database);

export class NotionCrawler {
  onProgress: ((done: number, total: number, message: string) => void) | undefined;
  private readonly snap = emptySnapshot();
  private queue: Job[] = [];
  private readonly seen = new Set<string>();
  private done = 0;
  private readonly viewOrders = new Map<string, string[]>();

  constructor(private readonly client: NotionClient, private readonly options: NotionImportOptions = defaultNotionImportOptions()) {}

  /** Holt die Ziele (leer = alles, was mit der Integration geteilt ist). */
  async crawl(targets: readonly string[]): Promise<NotionSnapshot> {
    this.enqueue({ k: "users" });
    if (targets.length === 0) this.enqueue({ k: "search" });
    else for (const id of targets) this.enqueue({ k: "resolve", id });
    while (this.queue.length > 0) {
      if (this.client.signal?.aborted) throw new NotionAPIError("cancelled", "");
      const batch = this.queue.splice(0, Math.max(1, this.options.maxConcurrent));
      const outcomes = await Promise.all(batch.map((j) => this.run(j)));
      for (const o of outcomes) this.merge(o);
      this.done += batch.length;
      this.onProgress?.(this.done, this.done + this.queue.length, this.describe(batch[0]));
    }
    // Zeilenreihenfolge: zuerst die der Hauptansicht, dann der Rest in Abfrage-Reihenfolge.
    for (const [ds, ids] of this.snap.rows) {
      const order = this.viewOrders.get(ds);
      if (!order || order.length === 0) continue;
      const set = new Set(ids);
      const out = order.filter((x) => set.has(x));
      const placed = new Set(out);
      this.snap.rows.set(ds, [...out, ...ids.filter((x) => !placed.has(x))]);
    }
    return this.snap;
  }

  private describe(job: Job | undefined): string {
    switch (job?.k) {
      case "page": return "Page " + notionTitle(this.snap.pages.get(job.id) ?? null);
      case "children": return "Reading page content…";
      case "database": case "dataSource": return "Reading databases…";
      case "rows": return "Reading database rows…";
      case "views": return "Reading views…";
      case "download": return "Downloading files…";
      case "search": return "Searching pages shared with the integration…";
      default: return "Reading Notion…";
    }
  }

  private enqueue(job: Job) {
    const k = jobKey(job);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.queue.push(job);
  }

  private merge(o: Outcome) {
    for (const p of o.pages) { const id = nid(at(p, "id")); if (id) this.snap.pages.set(id, p); }
    for (const [id, c] of o.children) this.snap.children.set(id, c);
    for (const d of o.databases) { const id = nid(at(d, "id")); if (id) this.snap.databases.set(id, d); }
    for (const d of o.dataSources) { const id = nid(at(d, "id")); if (id) this.snap.dataSources.set(id, d); }
    for (const [id, v] of o.views) this.snap.views.set(id, v);
    for (const [id, r] of o.rows) this.snap.rows.set(id, r);
    for (const [id, r] of o.viewOrders) this.viewOrders.set(id, r);
    for (const [p, prop, items] of o.propertyItems) {
      const m = this.snap.propertyItems.get(p) ?? new Map<string, JSONValue[]>();
      m.set(prop, items);
      this.snap.propertyItems.set(p, m);
    }
    for (const [k, f] of o.files) this.snap.files.set(k, f);
    for (const [id, n] of o.users) this.snap.users.set(id, n);
    for (const r of o.roots) if (!this.snap.roots.some((x) => sameRoot(x, r))) this.snap.roots.push(r);
    this.snap.warnings.push(...o.warnings);
    if (o.searchResults.length > 0) this.planSearch(o.searchResults);
    for (const j of o.next) this.enqueue(j);
  }

  private async run(job: Job): Promise<Outcome> {
    const o = outcome();
    const c = this.client;
    try {
      switch (job.k) {
        case "users":
          for (const u of await c.paginateGet("users").catch(() => [] as JSONValue[])) {
            const id = nid(at(u, "id")), n = jstr(at(u, "name")) ?? jstr(at(u, "person", "email"));
            if (id && n !== undefined) o.users.push([id, n]);
          }
          break;
        case "search":
          o.searchResults = await c.paginatePost("search");
          if (o.searchResults.length === 0) o.warnings.push("Nothing is shared with the integration yet. In Notion, open a page → ••• → Connections → add the integration.");
          break;
        case "resolve": await this.resolve(job.id, o); break;
        case "page": {
          const p = await c.get(`pages/${job.id}`);
          o.pages.push(p);
          this.filesOfPage(p, o);
          o.next.push({ k: "children", id: job.id });
          break;
        }
        case "children": {
          const blocks = await c.paginateGet(`blocks/${job.id}/children`);
          o.children.push([job.id, blocks]);
          for (const b of blocks) this.follow(b, o);
          break;
        }
        case "database": {
          const d = await c.get(`databases/${job.id}`);
          o.databases.push(d);
          this.filesOfPage(d, o);
          for (const ds of jarr(at(d, "data_sources"))) { const id = nid(at(ds, "id")); if (id) o.next.push({ k: "dataSource", id }); }
          o.next.push({ k: "views", id: job.id });
          break;
        }
        case "dataSource": {
          const ds = await c.get(`data_sources/${job.id}`);
          o.dataSources.push(ds);
          o.next.push({ k: "rows", id: job.id });
          const owner = nid(at(ds, "parent", "database_id"));
          if (owner) o.next.push({ k: "database", id: owner });
          if (this.options.followRelations) {
            for (const prop of Object.values(jobj(at(ds, "properties")) ?? {})) {
              if (at(prop, "type") !== "relation") continue;
              const target = nid(at(prop, "relation", "data_source_id"));
              const db = nid(at(prop, "relation", "database_id"));
              if (target) o.next.push({ k: "dataSource", id: target });
              else if (db) o.next.push({ k: "database", id: db });
            }
          }
          break;
        }
        case "rows": {
          const pages = await c.paginatePost(`data_sources/${job.id}/query`);
          o.rows.push([job.id, pages.flatMap((p) => { const id = nid(at(p, "id")); return id ? [id] : []; })]);
          for (const p of pages) {
            o.pages.push(p);
            this.filesOfPage(p, o);
            const pid = nid(at(p, "id"));
            if (!pid) continue;
            if (this.options.rowContent) o.next.push({ k: "children", id: pid });
            for (const v of Object.values(jobj(at(p, "properties")) ?? {})) {
              const prop = jstr(at(v, "id"));
              if (at(v, "has_more") === true && prop) o.next.push({ k: "propertyItem", page: pid, prop });
            }
          }
          break;
        }
        case "views": await this.views(job.id, o); break;
        case "propertyItem": {
          // Property-IDs kommen URL-kodiert („%3AeAg“); alles andere, was nicht pfadsicher ist, kodieren.
          const enc = [...job.prop].map((ch) => (/[A-Za-z0-9%\-._~]/.test(ch) ? ch : encodeURIComponent(ch))).join("");
          const items = await c.paginateGet(`pages/${job.page}/properties/${enc}`);
          o.propertyItems.push([job.page, job.prop, items]);
          break;
        }
        case "download": {
          const f = await c.download(job.url, job.name);
          o.files.push([notionFileKey(job.url), f]);
          break;
        }
      }
    } catch (e) {
      if (e instanceof NotionAPIError && (e.kind === "unauthorized" || e.kind === "cancelled")) throw e;
      o.warnings.push(`${describeJob(job)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return o;
  }

  /** Ein Link kann auf eine Seite, eine Datenbank oder eine Datenquelle zeigen. */
  private async resolve(id: string, o: Outcome): Promise<void> {
    let last: unknown;
    const rethrow = (e: unknown) => { if (e instanceof NotionAPIError && (e.kind === "unauthorized" || e.kind === "cancelled")) throw e; last = e; };
    try {
      const p = await this.client.get(`pages/${id}`);
      o.pages.push(p); this.filesOfPage(p, o);
      o.roots.push({ page: id }); o.next.push({ k: "children", id });
      return;
    } catch (e) { rethrow(e); }
    try {
      const d = await this.client.get(`databases/${id}`);
      o.databases.push(d); this.filesOfPage(d, o);
      o.roots.push({ database: id });
      for (const ds of jarr(at(d, "data_sources"))) { const x = nid(at(ds, "id")); if (x) o.next.push({ k: "dataSource", id: x }); }
      o.next.push({ k: "views", id });
      return;
    } catch (e) { rethrow(e); }
    try {
      const ds = await this.client.get(`data_sources/${id}`);
      o.dataSources.push(ds);
      const db = nid(at(ds, "parent", "database_id"));
      if (db) { o.roots.push({ database: db }); o.next.push({ k: "database", id: db }); }
      o.next.push({ k: "rows", id });
      return;
    } catch (e) { rethrow(e); }
    o.warnings.push(`Couldn't open ${id} — is it shared with the integration (••• → Connections)? ${last instanceof Error ? last.message : ""}`);
  }

  private async views(dbID: string, o: Outcome): Promise<void> {
    let refs: JSONValue[];
    try { refs = await this.client.paginateGet("views", { database_id: dbID }); }
    catch (e) {
      if (e instanceof NotionAPIError && (e.kind === "unauthorized" || e.kind === "cancelled")) throw e;
      o.warnings.push(`Views of database ${dbID} unavailable (${e instanceof Error ? e.message : String(e)}); a default table view is used.`);
      return;
    }
    const full: JSONValue[] = [];
    for (const r of refs) {
      const vid = jstr(at(r, "id"));
      if (!vid) continue;
      try { full.push(await this.client.get(`views/${vid}`)); }
      catch (e) {
        if (e instanceof NotionAPIError && (e.kind === "unauthorized" || e.kind === "cancelled")) throw e;
        o.warnings.push(`View ${jstr(at(r, "name")) ?? vid} of database ${dbID} couldn't be read (${e instanceof Error ? e.message : String(e)}).`);
      }
    }
    // Dashboards: jede Widget-Ansicht laden, und die Datenbanken mitnehmen, die Widgets zeigen.
    const have = new Set(full.flatMap((v) => { const id = nid(at(v, "id")); return id ? [id] : []; }));
    for (const v of [...full]) {
      if (at(v, "type") !== "dashboard") continue;
      for (const row of jarr(at(v, "configuration", "rows"))) {
        for (const w of jarr(at(row, "widgets"))) {
          const wid = nid(at(w, "view_id"));
          if (!wid || have.has(wid)) continue;
          have.add(wid);
          try { full.push(await this.client.get(`views/${wid}`)); }
          catch (e) {
            if (e instanceof NotionAPIError && (e.kind === "unauthorized" || e.kind === "cancelled")) throw e;
            o.warnings.push(`Dashboard widget ${wid} couldn't be read (${e instanceof Error ? e.message : String(e)}).`);
          }
        }
      }
    }
    for (const v of full) {
      if (nid(at(v, "dashboard_view_id")) === undefined) continue;
      const other = nid(at(v, "parent", "database_id"));
      if (other && other !== nid(dbID)) o.next.push({ k: "database", id: other });
    }
    o.views.push([dbID, full]);
    // Handsortierte Reihenfolge aus einer ungefilterten, unsortierten Ansicht (am liebsten einer Tabelle).
    const bySource = new Map<string, JSONValue[]>();
    for (const v of full) { const ds = nid(at(v, "data_source_id")); if (ds) bySource.set(ds, [...(bySource.get(ds) ?? []), v]); }
    const plainView = (v: JSONValue) => {
      const f = at(v, "filter");
      const s = jarr(at(v, "sorts"));
      return (f === undefined || f === null || (jobj(f) !== undefined && Object.keys(jobj(f)!).length === 0)) && s.length === 0;
    };
    for (const [ds, vs] of bySource) {
      const pick = vs.find((v) => plainView(v) && at(v, "type") === "table") ?? vs.find(plainView) ?? vs.find((v) => at(v, "filter") === undefined || at(v, "filter") === null);
      const vid = jstr(at(pick, "id"));
      if (!vid) continue;
      try {
        const order = await this.client.viewOrder(vid);
        o.viewOrders.push([ds, order.map((x) => notionUUID(x) ?? x)]);
      } catch { /* ohne Reihenfolge */ }
    }
  }

  private follow(b: JSONValue, o: Outcome) {
    const id = nid(at(b, "id")), type = jstr(at(b, "type"));
    if (!id || !type) return;
    if (type === "child_page") { if (this.options.subpages) o.next.push({ k: "page", id }); }
    else if (type === "child_database") o.next.push({ k: "database", id });
    else if (at(b, "has_children") === true) o.next.push({ k: "children", id });
    const body = at(b, type);
    const url = jstr(at(body, "file", "url"));
    if (["image", "video", "audio", "file", "pdf"].includes(type) && at(body, "type") === "file" && url) this.download(url, jstr(at(body, "name")), o);
    if (type === "callout") { const icon = at(body, "icon"); if (icon !== undefined) this.fileOfIcon(icon, o); }
  }

  private filesOfPage(p: JSONValue, o: Outcome) {
    const icon = at(p, "icon");
    if (icon !== undefined) this.fileOfIcon(icon, o);
    const cover = at(p, "cover");
    const cu = jstr(at(cover, "file", "url"));
    if (at(cover, "type") === "file" && cu) this.download(cu, undefined, o);
    for (const v of Object.values(jobj(at(p, "properties")) ?? {})) {
      if (at(v, "type") !== "files") continue;
      for (const f of jarr(at(v, "files"))) {
        const u = jstr(at(f, "file", "url"));
        if (at(f, "type") === "file" && u) this.download(u, jstr(at(f, "name")), o);
      }
    }
  }

  private fileOfIcon(icon: JSONValue, o: Outcome) {
    const fu = jstr(at(icon, "file", "url"));
    if (at(icon, "type") === "file" && fu) this.download(fu, undefined, o);
    const cu = jstr(at(icon, "custom_emoji", "url"));
    if (at(icon, "type") === "custom_emoji" && cu) this.download(cu, undefined, o);
  }

  private download(url: string, name: string | undefined, o: Outcome) {
    if (this.options.downloadFiles) o.next.push({ k: "download", url, name });
  }

  /** Suche: Wurzeln sind Objekte, deren Elternteil nicht zum geteilten Bestand gehört. */
  private planSearch(results: JSONValue[]) {
    const ids = new Set<string>();
    for (const r of results) { const id = nid(at(r, "id")); if (id) ids.add(id); }
    const dbOfSource = new Map<string, string>();
    for (const r of results) {
      if (at(r, "object") !== "data_source") continue;
      const id = nid(at(r, "id")), db = nid(at(r, "parent", "database_id"));
      if (id && db) { dbOfSource.set(id, db); ids.add(db); }
    }
    for (const r of results) {
      const id = nid(at(r, "id"));
      if (!id) continue;
      const kind = jstr(at(r, "object"));
      if (kind === "page") {
        this.snap.pages.set(id, r);
        this.seen.add(jobKey({ k: "page", id }));
        const ptype = jstr(at(r, "parent", "type")) ?? "workspace";
        const pid = nid(at(r, "parent", ptype));
        if ((ptype === "database_id" || ptype === "data_source_id") && pid && (ids.has(pid) || dbOfSource.has(pid))) continue;
        if (ptype === "workspace" || pid === undefined || !ids.has(pid)) {
          if (!this.snap.roots.some((x) => "page" in x && x.page === id)) this.snap.roots.push({ page: id });
        }
        this.enqueue({ k: "children", id });
        const o = outcome();
        this.filesOfPage(r, o);
        for (const j of o.next) this.enqueue(j);
      } else if (kind === "data_source" || kind === "database") {
        const db = dbOfSource.get(id) ?? id;
        const parent = at(r, "database_parent") ?? at(r, "parent");
        const ptype = jstr(at(parent, "type")) ?? "workspace";
        const pid = nid(at(parent, ptype));
        if (ptype === "workspace" || pid === undefined || !ids.has(pid)) {
          if (!this.snap.roots.some((x) => "database" in x && x.database === db)) this.snap.roots.push({ database: db });
        }
        this.enqueue({ k: "database", id: db });
      }
    }
  }
}

function describeJob(j: Job): string {
  switch (j.k) {
    case "page": return `Page ${j.id}`;
    case "children": return `Content of ${j.id}`;
    case "database": return `Database ${j.id}`;
    case "dataSource": return `Data source ${j.id}`;
    case "rows": return `Rows of ${j.id}`;
    case "views": return `Views of ${j.id}`;
    case "propertyItem": return `Property ${j.prop} of ${j.page}`;
    case "download": return `File ${(j.url.split(/[?#]/)[0] ?? "").split("/").pop() ?? j.url}`;
    case "resolve": return `Link ${j.id}`;
    case "search": return "Search";
    case "users": return "Users";
  }
}

/** Reiner Titel einer Seite oder Datenbank. */
export function notionTitle(page: JSONValue): string {
  for (const v of Object.values(jobj(at(page, "properties")) ?? {})) {
    if (at(v, "type") === "title") return jarr(at(v, "title")).map((x) => jstr(at(x, "plain_text")) ?? "").join("");
  }
  const t = at(page, "title");
  if (Array.isArray(t)) return t.map((x) => jstr(at(x, "plain_text")) ?? "").join("");
  return jstr(at(page, "child_page", "title")) ?? "";
}
