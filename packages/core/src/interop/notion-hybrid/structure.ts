// BSD-317: Struktur eines Workspaces aus der Notion-API, ohne Seiteninhalt (`blocks/{id}/children` wird hier nie
// gerufen): Hierarchie, Notion-IDs, Datenbank-Schemas mit Eigenschaftstypen, Relationen, Ansichten, Zeilenwerte,
// Nutzer. Der Inhalt jeder Seite kommt danach aus dem ZIP-Export (`content.ts`). Diese Datei rechnet nur – geschrieben
// wird in `commit.ts`, im Store.
//
// Die Hierarchie ergibt sich aus dem `parent` jedes API-Objekts. Der bestehende Mapper platziert Unterseiten über
// `child_page`-Blöcke im Inhalt; die bauen wir hier aus den Eltern-Verweisen nach, statt den Inhalt zu holen.
import type { JSONValue } from "../../json.js";
import { ImportBuilder, type AssetSink } from "../builder.js";
import { derivedID } from "../importids.js";
import { NotionHTMLImporter } from "../notion-html.js";
import { NotionAPIError, type NotionClient } from "../notion-api/client.js";
import { at, jarr, jstr, nid, NotionCrawler, notionTitle, type NotionRoot, type NotionSnapshot } from "../notion-api/crawler.js";
import { mapNotionSnapshot } from "../notion-api/mapper.js";
import type { NotionExportIndex } from "./export-index.js";

/** Zusatzfelder an importierten Seiten (Blöcke lassen unbekannte Felder zu und syncen sie mit). */
export const HYBRID_PENDING_KEY = "importPending";
export const HYBRID_EDITED_KEY = "notionEdited";
export const HYBRID_PARENT_KEY = "notionParent";

export type HybridSource = "zip" | "api";

export type HybridDeviationKind =
  | "missingInZip" | "editedAfterExport" | "onlyInZip" | "titleDiffers" | "conflict" | "unmatchedDatabase" | "danglingRelation"
  | "deletedInNotion" | "unreadable";

/** Eine Abweichung zwischen ZIP, API und Based – steht immer im Bericht, nie still verworfen. */
export interface HybridDeviation { kind: HybridDeviationKind; id: string; title: string; detail?: string }

export interface HybridPageMeta {
  id: string;
  kind: "page" | "database" | "zipOnly";
  /** `last_edited_time` aus der API (ISO). */
  edited?: string;
  /** Elternteil, wie Notion ihn kennt (`w`, `b:<id>`, `d:<id>`). */
  parent: string;
  /** Woher der Inhalt kommt (nur Seiten). */
  source?: HybridSource;
}

export interface HybridStructureStats {
  pages: number; rows: number; databases: number;
  fromZip: number; missingInZip: number; editedAfterExport: number; onlyInZip: number;
}

export interface HybridStructure {
  builder: ImportBuilder;
  /** Seiten, die nur im ZIP stehen (voll gelesen, wie der gewöhnliche ZIP-Import). */
  zipOnly: ImportBuilder | undefined;
  metas: HybridPageMeta[];
  /** Voller Lauf (alle geteilten Seiten gesehen) – nur dann lässt sich in Notion Gelöschtes erkennen. */
  full: boolean;
  deviations: HybridDeviation[];
  stats: HybridStructureStats;
}

export interface HybridStructureOptions {
  downloadFiles?: boolean | undefined;
  /** Delta: nur Änderungen seit diesem Zeitpunkt (ISO). */
  editedSince?: string | undefined;
  /** Exportzeitpunkt (ms seit 1970), falls bekannt; sonst die jüngste Datei im ZIP. */
  exportedAt?: number | undefined;
  /**
   * Sicherheitsabstand vor dem Exportzeitpunkt. ZIP-Zeiten tragen keine Zeitzone; mit 14 h Abstand gilt eine Seite in
   * jeder Zeitzone eher als „nach dem Export geändert“ (dann kommt sie über die API) als fälschlich als aktuell.
   */
  exportSkewHours?: number | undefined;
  assets?: AssetSink | undefined;
  onProgress?: ((done: number, total: number, message: string) => void) | undefined;
  now?: (() => number) | undefined;
}

const ZIP_ONLY_ROOT = derivedID("notion-hybrid", "zip-only");
const isRowParent = (t: string | undefined) => t === "data_source_id" || t === "database_id";
const abortLike = (e: unknown) => !(e instanceof NotionAPIError && (e.kind === "notFound" || e.kind === "restricted"));

/** Holt die Struktur und rechnet sie in Records um. Kein Seiteninhalt, kein Schreiben. */
export async function crawlHybridStructure(client: NotionClient, index: NotionExportIndex | undefined, opts: HybridStructureOptions = {}): Promise<HybridStructure> {
  const crawler = new NotionCrawler(client, {
    rowContent: false, followRelations: opts.editedSince === undefined, downloadFiles: opts.downloadFiles ?? true, subpages: true, maxConcurrent: 3,
    blockContent: false, strict: true, ...(opts.editedSince !== undefined ? { editedSince: opts.editedSince } : {}),
  });
  crawler.onProgress = opts.onProgress;
  const snap = await crawler.crawl([]);
  const blockParents = await resolveBlockParents(client, snap, index);
  return planHybridStructure(snap, index, blockParents, opts);
}

/**
 * Seiten und Datenbanken, die in einem Block liegen (Toggle, Spalte …): die API nennt als Elternteil nur den Block.
 * Die Seite dazu steht im Ordner des Exports; fehlt sie dort, wird der Block über `blocks/{id}` (nicht `children`)
 * hochverfolgt.
 */
async function resolveBlockParents(client: NotionClient, snap: NotionSnapshot, index: NotionExportIndex | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cache = new Map<string, string | null>();
  const walk = async (start: string): Promise<string | null> => {
    const path: string[] = [];
    let cur: string | undefined = start;
    let found: string | null = null;
    for (let hop = 0; hop < 12 && cur !== undefined; hop++) {
      const known = cache.get(cur);
      if (known !== undefined) { found = known; break; }
      path.push(cur);
      let b: JSONValue;
      try { b = await client.get(`blocks/${cur}`); } catch (e) { if (abortLike(e)) throw e; break; }
      const t = jstr(at(b, "parent", "type"));
      if (t === "page_id") { found = nid(at(b, "parent", "page_id")) ?? null; break; }
      cur = t === "block_id" ? nid(at(b, "parent", "block_id")) : undefined;
    }
    for (const p of path) cache.set(p, found);
    return found;
  };
  const objects: [string, JSONValue][] = [...snap.pages, ...snap.databases];
  for (const [id, o] of objects) {
    if (jstr(at(o, "parent", "type")) !== "block_id") continue;
    const owner = index?.ownerOf(id);
    if (owner !== undefined && snap.pages.has(owner)) { out.set(id, owner); continue; }
    const block = nid(at(o, "parent", "block_id"));
    const page = block !== undefined ? await walk(block) : null;
    if (page) out.set(id, page);
    else snap.warnings.push(`Couldn't find the page that contains “${notionTitle(o) || id}”; it was placed at the top level.`);
  }
  return out;
}

/** Reine Rechnung: Snapshot (ohne Inhalt) + Export-Verzeichnis → Records, Herkunft je Seite, Abweichungen. */
export function planHybridStructure(snap: NotionSnapshot, index: NotionExportIndex | undefined, blockParents: ReadonlyMap<string, string>, opts: HybridStructureOptions = {}): HybridStructure {
  const delta = opts.editedSince !== undefined;
  const deviations: HybridDeviation[] = [];
  const parentPage = (id: string, o: JSONValue): string | undefined => {
    const t = jstr(at(o, "parent", "type"));
    if (t === "page_id") return nid(at(o, "parent", "page_id"));
    if (t === "block_id") return blockParents.get(id);
    return undefined;
  };
  const created = (o: JSONValue) => jstr(at(o, "created_time")) ?? "";

  // Unterseiten und Datenbanken als `child_page`/`child_database` unter ihre Elternseite hängen.
  const kids = new Map<string, { id: string; created: string; block: JSONValue }[]>();
  const roots: NotionRoot[] = [];
  const desired = new Map<string, string>();
  for (const [id, p] of snap.pages) {
    const pt = jstr(at(p, "parent", "type"));
    if (isRowParent(pt)) continue;
    const x = parentPage(id, p);
    if (x !== undefined) desired.set(id, "b:" + x);
    if (x !== undefined && snap.pages.has(x)) {
      const list = kids.get(x) ?? [];
      list.push({ id, created: created(p), block: { object: "block", id, type: "child_page", child_page: { title: notionTitle(p) } } });
      kids.set(x, list);
    } else roots.push({ page: id });
  }
  for (const [id, d] of snap.databases) {
    const x = parentPage(id, d);
    if (x !== undefined) desired.set(id, "b:" + x);
    if (x !== undefined && snap.pages.has(x)) {
      const list = kids.get(x) ?? [];
      list.push({ id, created: created(d), block: { object: "block", id, type: "child_database", child_database: { title: notionTitle(d) } } });
      kids.set(x, list);
    } else roots.push({ database: id });
  }
  snap.children.clear();
  for (const [x, list] of kids) {
    list.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
    snap.children.set(x, list.map((k) => k.block));
  }
  snap.roots = roots;

  const builder = new ImportBuilder({ createdBy: null, now: opts.now });
  mapNotionSnapshot(snap, builder);
  // Die Struktur kennt den Inhalt nicht: nichts gilt als „vollständig“, also räumt `commitImport` nichts weg.
  builder.complete.clear();

  const cutoff = (() => {
    const at0 = opts.exportedAt ?? index?.exportedAt;
    return at0 === undefined ? undefined : at0 - (opts.exportSkewHours ?? 14) * 3_600_000;
  })();
  const rootSet = new Set(builder.roots);
  const metas: HybridPageMeta[] = [];
  const stats: HybridStructureStats = { pages: 0, rows: 0, databases: 0, fromZip: 0, missingInZip: 0, editedAfterExport: 0, onlyInZip: 0 };
  for (const b of builder.blocks) {
    if (b.type === "databasePage" || b.type === "databaseInline") {
      const d = snap.databases.get(b.id);
      const meta: HybridPageMeta = { id: b.id, kind: "database", parent: rootSet.has(b.id) ? desired.get(b.id) ?? "w" : b.parent };
      const e = jstr(at(d, "last_edited_time")); if (e !== undefined) meta.edited = e;
      metas.push(meta);
      stats.databases += 1;
      continue;
    }
    if (b.type !== "page") continue;
    const p = snap.pages.get(b.id);
    if (p === undefined) continue;
    if (b.parent.startsWith("d:")) stats.rows += 1; else stats.pages += 1;
    const edited = jstr(at(p, "last_edited_time"));
    const meta: HybridPageMeta = { id: b.id, kind: "page", parent: rootSet.has(b.id) ? desired.get(b.id) ?? "w" : b.parent };
    if (edited !== undefined) meta.edited = edited;
    const title = notionTitle(p) || "Untitled";
    if (delta || index === undefined) meta.source = "api";
    else if (!index.has(b.id)) {
      meta.source = "api";
      stats.missingInZip += 1;
      deviations.push({ kind: "missingInZip", id: b.id, title });
    } else if (cutoff !== undefined && edited !== undefined && Date.parse(edited) > cutoff) {
      meta.source = "api";
      stats.editedAfterExport += 1;
      deviations.push({ kind: "editedAfterExport", id: b.id, title });
    } else {
      meta.source = "zip";
      stats.fromZip += 1;
    }
    metas.push(meta);
  }

  // Relationen, die auf Seiten außerhalb des Imports zeigen (nicht mit der Integration geteilt).
  if (!delta) {
    const dangling = new Map<string, number>();
    for (const b of builder.blocks) {
      for (const v of Object.values(b.values ?? {})) {
        const rel = (v as { relation?: { _0?: string[] } }).relation?._0;
        if (!rel) continue;
        const n = rel.filter((id) => !snap.pages.has(id)).length;
        if (n > 0) dangling.set(b.id, (dangling.get(b.id) ?? 0) + n);
      }
    }
    for (const [id, n] of dangling) deviations.push({ kind: "danglingRelation", id, title: notionTitle(snap.pages.get(id) ?? null) || "Untitled", detail: String(n) });
  }

  let zipOnly: ImportBuilder | undefined;
  if (!delta && index !== undefined) {
    zipOnly = planZipOnly(snap, index, metas, deviations, opts);
    stats.onlyInZip = deviations.filter((d) => d.kind === "onlyInZip").length;
  }
  if (opts.assets) {
    builder.resolveAssets(opts.assets);
    zipOnly?.resolveAssets(opts.assets);
  }
  return { builder, zipOnly, metas, full: !delta, deviations, stats };
}

/**
 * Seiten, die im ZIP stehen, aber nicht über die API kamen (nicht mit der Integration geteilt, oder seit dem Export
 * gelöscht). Sie gehen nicht verloren: der oberste solche Knoten wird mit allem darunter wie beim gewöhnlichen
 * ZIP-Import gelesen – unter seiner Elternseite, wenn die API die kennt, sonst unter einer Sammelseite.
 */
function planZipOnly(snap: NotionSnapshot, index: NotionExportIndex, metas: HybridPageMeta[], deviations: HybridDeviation[], opts: HybridStructureOptions): ImportBuilder | undefined {
  const known = new Set<string>([...snap.pages.keys(), ...snap.databases.keys(), ...snap.dataSources.keys()]);
  // Zusätzliche Datenquellen einer Datenbank tragen im Export die ID ihres Containers.
  for (const d of snap.databases.values()) for (const s of jarr(at(d, "data_sources"))) { const id = nid(at(s, "id")); if (id) known.add(id); }
  const candidates = new Set<string>();
  for (const id of index.ids) if (!known.has(id)) candidates.add(id);
  if (candidates.size === 0) return undefined;
  const tops = [...candidates].filter((id) => { const o = index.ownerOf(id); return o === undefined || !candidates.has(o); });
  const out = new ImportBuilder({ createdBy: null, now: opts.now });
  const imp = new NotionHTMLImporter(out, index.files, {});
  let collector = false;
  for (const id of tops) {
    const file = index.pageFile(id)!;
    const owner = index.ownerOf(id);
    const underPage = owner !== undefined && snap.pages.has(owner);
    if (!underPage && !collector) {
      collector = true;
      const now = out.now();
      out.add({ id: ZIP_ONLY_ROOT, type: "page", parent: "w", sk: "", text: "Only in the Notion export", props: { icon: "🗂️" }, createdAt: now, updatedAt: now }, true);
    }
    const parent = underPage ? "b:" + owner : "b:" + ZIP_ONLY_ROOT;
    try {
      const got = imp.importSubtree(file, parent);
      if (got !== undefined) metas.push({ id: got, kind: "zipOnly", parent });
    } catch (e) {
      deviations.push({ kind: "unreadable", id, title: file.split("/").pop() ?? id, detail: e instanceof Error ? e.message : String(e) });
    }
    index.release();
  }
  // Was die API doch kennt (geteilte Seite unter einer ungeteilten), gehört der Struktur – hier wieder heraus.
  const dropped = new Set<string>();
  const kept = new ImportBuilder({ createdBy: null, now: opts.now });
  const topSet = new Set(metas.filter((m) => m.kind === "zipOnly").map((m) => m.id));
  for (const b of out.blocks) {
    const parentID = b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
    const dbOwner = b.parent.startsWith("d:") ? out.database(b.parent.slice(2))?.blockID : undefined;
    if (known.has(b.id) || (parentID !== undefined && dropped.has(parentID)) || (dbOwner !== undefined && dropped.has(dbOwner))) { dropped.add(b.id); continue; }
    kept.add(b, out.roots.includes(b.id));
    if (b.type === "page" && b.id !== ZIP_ONLY_ROOT) {
      const title = typeof b.text === "string" ? b.text : (b.text ?? []).map((r) => r.t ?? "").join("");
      if (candidates.has(b.id) || topSet.has(b.id)) deviations.push({ kind: "onlyInZip", id: b.id, title: title || "Untitled" });
    }
  }
  for (const d of out.databases) if (!dropped.has(d.blockID)) kept.addDatabase(d);
  for (const v of out.views) if (!dropped.has(v.blockID)) kept.addView(v);
  for (const [id, f] of out.pendingAssets) kept.pendingAssets.set(id, f);
  kept.warnings.push(...out.warnings);
  kept.notes.push(...out.notes);
  return kept.isEmpty ? undefined : kept;
}

export { ZIP_ONLY_ROOT };
